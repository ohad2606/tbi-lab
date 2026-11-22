/**
 * TBI Lab sign-up forwarder (Google Apps Script, bound to the sign-up form's RESPONSE SPREADSHEET).
 *
 * On every form submission it builds the JSON body expected by the intake endpoint
 * (fields: name, email, role, lang, consent; nothing else is allowed), signs it with
 * HMAC-SHA256 and POSTs it. Signing format (must match runtime/admin/signup/hmac.ts):
 *   signature = hex( HMAC_SHA256( secret, "v1\n" + timestampSeconds + "\n" + nonce + "\n" + body ) )
 * Headers: x-tbi-timestamp, x-tbi-nonce, x-tbi-signature. Content-Type: application/json.
 * Every attempt is signed afresh (new timestamp and nonce), so a retry is never a replay.
 *
 * Send status and retry (design §3): each response gets one row in the sheet tab "TBI send status"
 * (response row, sheet id, submitted time, status, attempts, last result, next attempt, updated,
 * alerted). The tab holds NO personal data: a retry rebuilds the body from the response row.
 *   status new      just recorded, first attempt running
 *          sent     the endpoint answered 2xx (a duplicate is also 2xx: the server stores it once)
 *          retry    a transient failure (transport error, 401, 408, 429, 5xx, configuration); the
 *                   time-driven trigger `retryUnsent` tries again at "next attempt"
 *          failed   given up: a permanent refusal (400, 413, 415), MAX_ATTEMPTS transient failures,
 *                   or the response row no longer matches (rows sorted or deleted)
 *          skipped  the answers could not be mapped (question titles do not match QUESTION_TITLES)
 * Backoff: 5, 10, 20, 40, 80, 160, 320 minutes (doubling, capped at 6 h; a server Retry-After is
 * honoured when longer); at most 8 attempts, about 10.5 hours in total.
 * The script owner gets an email (MailApp, to the account that runs the triggers) when a row
 * fails for the third time, when it is given up or skipped, and when the configuration is wrong.
 * Lost-submission safety: if the script lock cannot be taken in onFormSubmit (it is held by retry
 * fetches), the owner gets one "lock" email per hour and no status row exists yet. `retryUnsent`
 * then reconciles: every response row of the last 48 hours with a timestamp but no status row is
 * added as `new` and sent. In one retry run all rows reaching the 3rd failure share ONE "repeated"
 * email that names their count and response rows.
 * The email names only the response row, status and result code; never an answer.
 *
 * Script Properties (Project settings > Script properties); nothing secret lives in this file:
 *   ENDPOINT_URL  full https:// URL of the intake endpoint (POST /signup); anything else is refused
 *   HMAC_SECRET   the shared secret (at least 32 characters), same value as the server's secret file
 *
 * Logging: only the response row, the status class and the HTTP status. Never the body, the
 * answers, the signature or the secret.
 *
 * Setup (once, by the owner): bind the script to the response spreadsheet; Triggers > Add trigger >
 * function onFormSubmit > event source "From spreadsheet" > event type "On form submit"; then run
 * `installRetryTrigger` once from the editor (adds the 5-minute time-driven `retryUnsent`; running it
 * again replaces it). Do not sort or delete response rows while the status tab shows `retry`.
 */

// Form question titles (exact text of each question in the form). Adjust to the real form.
var QUESTION_TITLES = {
  name: 'Name',
  email: 'Email',
  role: 'Role',
  lang: 'Language',
  consent: 'Consent'
};

var STATUS_SHEET = 'TBI send status';
var STATUS_HEADERS = [
  'Response row',
  'Sheet id',
  'Submitted',
  'Status',
  'Attempts',
  'Last result',
  'Next attempt',
  'Updated',
  'Alerted'
];
var COL = {
  row: 0,
  sheetId: 1,
  submitted: 2,
  status: 3,
  attempts: 4,
  last: 5,
  next: 6,
  updated: 7,
  alerted: 8
};
var MAX_ATTEMPTS = 8;
var ALERT_AFTER_ATTEMPTS = 3;
var BASE_DELAY_MIN = 5;
var MAX_DELAY_MIN = 360;
var RETRY_EVERY_MIN = 5;
var LOCK_WAIT_MS = 30000;
var LOCK_ALERT_EVERY_MS = 3600000; // at most one "lock" alert per hour
var RECONCILE_WINDOW_MS = 48 * 3600000; // older unrecorded rows pre-date the script and are not sent

/** Entry point for the installable "On form submit" trigger of the response spreadsheet. */
function onFormSubmit(e) {
  if (!e || !e.range) {
    // A form-bound trigger has no response row to record a status against: refuse explicitly.
    console.log('unsupported: bind the script to the response spreadsheet');
    alertOwner_('setup', 'The sign-up script must be bound to the response spreadsheet (see Code.gs).');
    return;
  }
  var sheet = e.range.getSheet();
  var row = e.range.getRow();
  var submitted = timeKey_(sheet.getRange(row, 1).getValue());
  try {
    withLock_(function () {
      var st = statusSheet_();
      if (findStatus_(st, sheet.getSheetId(), row) < 0)
        st.appendRow([row, sheet.getSheetId(), submitted, 'new', 0, '', '', new Date(), '']);
    });
  } catch (err) {
    // No status row could be written. The row stays in the response sheet; retryUnsent adds it.
    console.log('lock timeout recording row ' + row);
    alertOwner_(
      'lock',
      'The sign-up script could not take its lock for response row ' + row + '. The row is not lost: ' +
        'the retry trigger adds it to the tab "' + STATUS_SHEET + '" and sends it.',
      LOCK_ALERT_EVERY_MS
    );
    return;
  }
  var out = attempt_(sheet.getSheetId(), row, Date.now());
  if (out && out.alert) alertOwner_(out.alert, alertText_(row, out.rec));
}

/**
 * Time-driven trigger: retries every `new` / `retry` row whose next attempt is due. (A trigger
 * passes an event object; a number is a test clock.) Returns the number of rows attempted.
 */
function retryUnsent(nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var due = withLock_(function () {
    reconcile_(now);
    var values = statusSheet_().getDataRange().getValues();
    var out = [];
    for (var i = 1; i < values.length; i++) {
      var v = values[i];
      var status = v[COL.status];
      if (status !== 'new' && status !== 'retry') continue;
      if (v[COL.next] && timeKey_(v[COL.next]) > now) continue;
      out.push([v[COL.sheetId], v[COL.row]]);
    }
    return out;
  });
  var repeated = [];
  for (var j = 0; j < due.length; j++) {
    var out = attempt_(due[j][0], due[j][1], now);
    if (!out || !out.alert) continue;
    if (out.alert === 'repeated') repeated.push({ row: due[j][1], rec: out.rec });
    else alertOwner_(out.alert, alertText_(due[j][1], out.rec));
  }
  if (repeated.length === 1) {
    alertOwner_('repeated', alertText_(repeated[0].row, repeated[0].rec));
  } else if (repeated.length > 1) {
    alertOwner_('repeated', repeatedText_(repeated.map(function (x) { return x.row; })));
  }
  return due.length;
}

/**
 * Under the lock: every response row of the last RECONCILE_WINDOW_MS that has a timestamp but no
 * status row (its onFormSubmit could not take the lock) gets a `new` status row.
 */
function reconcile_(now) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var st = statusSheet_();
  var known = {};
  var sv = st.getDataRange().getValues();
  for (var i = 1; i < sv.length; i++) known[Number(sv[i][COL.sheetId]) + ':' + Number(sv[i][COL.row])] = true;
  ss.getSheets().forEach(function (sheet) {
    if (sheet.getName() === STATUS_SHEET || sheet.getLastRow() < 2) return;
    var width = sheet.getLastColumn();
    var titles = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
    if (titles.indexOf(QUESTION_TITLES.email) < 0 || titles.indexOf(QUESTION_TITLES.consent) < 0) return;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var r = 0; r < data.length; r++) {
      var t = timeKey_(data[r][0]);
      if (!isFinite(t) || t < now - RECONCILE_WINDOW_MS) continue;
      var row = r + 2;
      if (known[sheet.getSheetId() + ':' + row]) continue;
      st.appendRow([row, sheet.getSheetId(), t, 'new', 0, '', '', new Date(now), '']);
      console.log('row ' + row + ': reconciled');
    }
  });
}

/** Installs (or replaces) the time-driven retry trigger. Run once from the editor. */
function installRetryTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'retryUnsent') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('retryUnsent').timeBased().everyMinutes(RETRY_EVERY_MIN).create();
}

/**
 * One attempt for one response row, under the script lock (a submit and the retry trigger never
 * send the same row at the same time). Re-reads the status row and does nothing unless it is
 * still `new` / `retry` and due.
 */
function attempt_(sheetId, row, now) {
  return withLock_(function () {
    var st = statusSheet_();
    var i = findStatus_(st, sheetId, row);
    if (i < 0) return null;
    var rec = st.getRange(i + 1, 1, 1, STATUS_HEADERS.length).getValues()[0];
    if (rec[COL.status] !== 'new' && rec[COL.status] !== 'retry') return null;
    if (rec[COL.next] && timeKey_(rec[COL.next]) > now) return null;
    var answers = answersForRow_(sheetId, row, rec[COL.submitted]);
    var result;
    if (answers === null) result = { kind: 'lost', code: 'row_moved' };
    else {
      var payload = buildPayload_(answers);
      if (!payload) result = { kind: 'skipped', code: 'incomplete' };
      else result = classify_(postSigned_(JSON.stringify(payload)));
    }
    var next = applyResult_(rec, result, now);
    st.getRange(i + 1, 1, 1, STATUS_HEADERS.length).setValues([next.rec]);
    console.log('row ' + row + ': ' + next.rec[COL.status] + ' (' + result.code + ')');
    return next; // { rec, alert }: the caller sends the alert, outside the lock
  });
}

/**
 * Pure: the status row after one attempt, and which alert (if any) to send. `rec` is the current
 * status row (array in STATUS_HEADERS order); `result` is { kind, code, retryAfterSec? }.
 */
function applyResult_(rec, result, now) {
  var r = rec.slice();
  var attempts = Number(r[COL.attempts] || 0) + 1;
  var alerted = String(r[COL.alerted] || '');
  r[COL.attempts] = attempts;
  r[COL.last] = String(result.code);
  r[COL.updated] = new Date(now);
  var alert = null;
  var once = function (kind) {
    if (alerted.split(',').indexOf(kind) >= 0) return;
    alerted = alerted ? alerted + ',' + kind : kind;
    alert = kind;
  };
  if (result.kind === 'sent') {
    r[COL.status] = 'sent';
    r[COL.next] = '';
  } else if (result.kind === 'skipped') {
    r[COL.status] = 'skipped';
    r[COL.next] = '';
    once('skipped');
  } else if (result.kind === 'permanent' || result.kind === 'lost') {
    r[COL.status] = 'failed';
    r[COL.next] = '';
    once('failed');
  } else if (attempts >= MAX_ATTEMPTS) {
    r[COL.status] = 'failed';
    r[COL.next] = '';
    once('failed');
  } else {
    r[COL.status] = 'retry';
    var waitMs = backoffMinutes_(attempts) * 60000;
    if (result.retryAfterSec && result.retryAfterSec * 1000 > waitMs)
      waitMs = result.retryAfterSec * 1000;
    r[COL.next] = new Date(now + waitMs);
    if (result.kind === 'config') once('config');
    else if (attempts >= ALERT_AFTER_ATTEMPTS) once('repeated');
  }
  r[COL.alerted] = alerted;
  return { rec: r, alert: alert };
}

/** Minutes to wait after the n-th failed attempt (n >= 1): 5, 10, 20, ... capped at 6 h. */
function backoffMinutes_(n) {
  return Math.min(BASE_DELAY_MIN * Math.pow(2, n - 1), MAX_DELAY_MIN);
}

/** Pure: the class of one POST outcome { code, retryAfterSec?, config? }. */
function classify_(res) {
  if (res.config) return { kind: 'config', code: res.config };
  var c = res.code;
  if (c >= 200 && c < 300) return { kind: 'sent', code: c };
  if (c === 400 || c === 413 || c === 415) return { kind: 'permanent', code: c };
  return { kind: 'retry', code: c === 0 ? 'network' : c, retryAfterSec: res.retryAfterSec || 0 };
}

/** The answers of one response row by question title, or null when the row is not that response. */
function answersForRow_(sheetId, row, submitted) {
  var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  var sheet = null;
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === sheetId) sheet = sheets[i];
  if (!sheet || row < 2 || row > sheet.getLastRow()) return null;
  var width = sheet.getLastColumn();
  var titles = sheet.getRange(1, 1, 1, width).getValues()[0];
  var values = sheet.getRange(row, 1, 1, width).getValues()[0];
  if (timeKey_(values[0]) !== Number(submitted)) return null;
  var out = {};
  for (var j = 0; j < titles.length; j++) out[String(titles[j])] = values[j];
  return out;
}

/** Maps answers to the endpoint's fields. Returns null when something required is missing. */
function buildPayload_(answers) {
  var name = String(answers[QUESTION_TITLES.name] || '').trim();
  var email = String(answers[QUESTION_TITLES.email] || '').trim();
  var role = String(answers[QUESTION_TITLES.role] || '').trim();
  var lang = normalizeLang_(answers[QUESTION_TITLES.lang]);
  var consent = isConsent_(answers[QUESTION_TITLES.consent]);
  if (!name || !email || !role || !lang || !consent) return null;
  return { name: name, email: email, role: role, lang: lang, consent: true };
}

/** "he"/"en" (case-insensitive); also accepts the Hebrew word and the English word. */
function normalizeLang_(v) {
  var s = String(v || '').trim().toLowerCase();
  if (s === 'he' || s === 'עברית' || s === 'hebrew') return 'he';
  if (s === 'en' || s === 'english') return 'en';
  return null;
}

/** A ticked consent checkbox yields a non-empty answer. */
function isConsent_(v) {
  if (Array.isArray(v)) return v.length > 0;
  return String(v || '').trim() !== '';
}

/** Hex HMAC-SHA256 over the exact bytes the server verifies. Pure given its inputs. */
function signRequest_(secret, timestampSec, nonce, body) {
  var message = 'v1\n' + timestampSec + '\n' + nonce + '\n' + body;
  var bytes = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(message).getBytes(),
    Utilities.newBlob(secret).getBytes()
  );
  return bytes
    .map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');
}

/** Only an https:// URL with a host is a usable endpoint (the body carries personal data). */
function isHttpsUrl_(url) {
  return /^https:\/\/[^\s/?#@]+(\/[^\s]*)?$/i.test(String(url || ''));
}

/**
 * Sends one signed POST; returns { code, retryAfterSec? } (code 0 on a transport error), or
 * { code: 0, config: <reason> } when the script properties are missing or the URL is not https.
 */
function postSigned_(body) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('ENDPOINT_URL');
  var secret = props.getProperty('HMAC_SECRET');
  if (!url || !secret) return { code: 0, config: 'not_configured' };
  if (!isHttpsUrl_(url)) return { code: 0, config: 'endpoint_not_https' };
  var ts = Math.floor(Date.now() / 1000);
  var nonce = Utilities.getUuid().replace(/-/g, ''); // 32 chars of [0-9a-f]
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      muteHttpExceptions: true,
      followRedirects: false,
      headers: {
        'x-tbi-timestamp': String(ts),
        'x-tbi-nonce': nonce,
        'x-tbi-signature': signRequest_(secret, ts, nonce, body)
      }
    });
    var headers = res.getHeaders ? res.getHeaders() : {};
    var ra = Number(headers['Retry-After'] || headers['retry-after'] || 0);
    return { code: res.getResponseCode(), retryAfterSec: ra > 0 && ra < 86400 ? ra : 0 };
  } catch (err) {
    return { code: 0 };
  }
}

/** The owner alert: response row, status, attempts and result code only (no answers). */
function alertText_(row, rec) {
  return [
    'A TBI Lab sign-up could not be forwarded to the lab yet.',
    '',
    'Response row: ' + row,
    'Status: ' + rec[COL.status],
    'Attempts: ' + rec[COL.attempts],
    'Last result: ' + rec[COL.last],
    '',
    'The tab "' + STATUS_SHEET + '" of the response spreadsheet shows every row. Rows marked "retry"',
    'are tried again automatically; "failed" or "skipped" rows need a look (configuration, the',
    'endpoint, or the question titles in Code.gs).'
  ].join('\n');
}

/** One summary alert for several rows that reached the repeated-failure stage in one run. */
function repeatedText_(rows) {
  return [
    rows.length + ' sign-ups for TBI Lab could not be forwarded to the lab yet (repeated failures).',
    '',
    'Response rows: ' + rows.join(', '),
    '',
    'The tab "' + STATUS_SHEET + '" shows every row. Rows marked "retry" are tried again',
    'automatically; "failed" or "skipped" rows need a look.'
  ].join('\n');
}

/**
 * Emails the account the triggers run as. A failing alert is logged, never thrown. With
 * `minGapMs`, the same kind is sent at most once per that interval (kept in a script property).
 */
function alertOwner_(kind, text, minGapMs) {
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'LAST_ALERT_' + kind;
    if (minGapMs) {
      var last = Number(props.getProperty(key) || 0);
      if (last && Date.now() - last < minGapMs) return;
      props.setProperty(key, String(Date.now()));
    }
    var to = Session.getEffectiveUser().getEmail();
    if (!to) throw new Error('no address');
    MailApp.sendEmail(to, 'TBI Lab sign-up forwarding: ' + kind, text);
  } catch (err) {
    console.log('alert failed (' + kind + ')');
  }
}

/** The status tab, created with its header row when missing. */
function statusSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var st = ss.getSheetByName(STATUS_SHEET);
  if (!st) {
    st = ss.insertSheet(STATUS_SHEET);
    st.appendRow(STATUS_HEADERS);
  }
  return st;
}

/** Zero-based index of the status row for a response row, or -1. */
function findStatus_(st, sheetId, row) {
  var values = st.getDataRange().getValues();
  for (var i = 1; i < values.length; i++)
    if (Number(values[i][COL.row]) === row && Number(values[i][COL.sheetId]) === Number(sheetId))
      return i;
  return -1;
}

/** A sheet time (Date or text) as epoch milliseconds, for comparisons; NaN when not a time. */
function timeKey_(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return new Date(String(v)).getTime();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
