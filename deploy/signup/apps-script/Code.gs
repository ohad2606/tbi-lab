/**
 * TBI Lab sign-up forwarder (Google Apps Script, bound to the sign-up form's response sheet or form).
 *
 * On every form submission it builds the JSON body expected by the intake endpoint
 * (fields: name, email, role, lang, consent; nothing else is allowed), signs it with
 * HMAC-SHA256 and POSTs it. Signing format (must match runtime/admin/signup/hmac.ts):
 *   signature = hex( HMAC_SHA256( secret, "v1\n" + timestampSeconds + "\n" + nonce + "\n" + body ) )
 * Headers: x-tbi-timestamp, x-tbi-nonce, x-tbi-signature. Content-Type: application/json.
 *
 * Script Properties (Project settings > Script properties); nothing secret lives in this file:
 *   ENDPOINT_URL  full URL of the intake endpoint (POST /signup)
 *   HMAC_SECRET   the shared secret (at least 32 characters), same value as the server's secret file
 *
 * Logging: only the HTTP status. Never log the body, the answers, the signature or the secret.
 *
 * Trigger: Triggers > Add trigger > function onFormSubmit > event source "From form" (form-bound
 * script) or "From spreadsheet" (sheet-bound script), event type "On form submit".
 */

// Form question titles (exact text of each question in the form). Adjust to the real form.
var QUESTION_TITLES = {
  name: 'Name',
  email: 'Email',
  role: 'Role',
  lang: 'Language',
  consent: 'Consent'
};

/** Entry point for the installable trigger. */
function onFormSubmit(e) {
  var answers = readAnswers_(e);
  var payload = buildPayload_(answers);
  if (!payload) {
    console.log('skipped: incomplete answers');
    return;
  }
  var status = postSigned_(JSON.stringify(payload));
  console.log('status ' + status);
}

/** Collects answers by question title from either a form event or a spreadsheet event. */
function readAnswers_(e) {
  var out = {};
  if (e && e.response) {
    e.response.getItemResponses().forEach(function (r) {
      out[r.getItem().getTitle()] = r.getResponse();
    });
  } else if (e && e.namedValues) {
    Object.keys(e.namedValues).forEach(function (k) {
      out[k] = e.namedValues[k][0];
    });
  }
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

/** Sends one signed POST; returns the HTTP status (or 0 on a transport error). */
function postSigned_(body) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('ENDPOINT_URL');
  var secret = props.getProperty('HMAC_SECRET');
  if (!url || !secret) {
    console.log('not configured');
    return 0;
  }
  var ts = Math.floor(Date.now() / 1000);
  var nonce = Utilities.getUuid().replace(/-/g, ''); // 32 chars of [0-9a-f]
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      muteHttpExceptions: true,
      headers: {
        'x-tbi-timestamp': String(ts),
        'x-tbi-nonce': nonce,
        'x-tbi-signature': signRequest_(secret, ts, nonce, body)
      }
    });
    return res.getResponseCode();
  } catch (err) {
    return 0;
  }
}
