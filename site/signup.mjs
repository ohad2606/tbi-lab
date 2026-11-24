/**
 * Client script of the sign-up page (BETA-G1 s9). One small module, no dependencies, no third-party code, no inline
 * script (CSP: script-src 'self'; connect-src 'self'). All visible text is rendered by the generator into the page;
 * this script only toggles it, so there are no strings here.
 *
 * Server contract (docs/plans/BETA-G1-WEB-INTAKE.md): GET <base>/form-token -> {token, ttl, minFill};
 * POST <base>/web JSON {name,email,role,lang,consent:true,heardFrom,website:'',token}. A token is posted only after
 * `minFill` seconds have passed since it ARRIVED here (the server refuses younger tokens as `too_fast`).
 * The logic (token store, outcome mapping, double-submit guard, validation) is exported and unit tested with a fake
 * fetch; the DOM wiring at the bottom runs only in a browser.
 */

/** Refresh a token this long before it expires so a slow typist never hits an expired token (no timing trap). */
export const TOKEN_MARGIN_MS = 120_000;
const DEFAULT_TTL_S = 1800;
/** Without a usable `minFill` from the server, wait as long as the server's own constant (WEB_MIN_FILL_MS, 3 s). */
export const DEFAULT_MIN_FILL_S = 3;
/** The page never waits longer than this, whatever the server says (a wrong answer must not freeze the form). */
export const MAX_MIN_FILL_S = 10;
export const NAME_MAX = 80;
export const HEARD_MAX = 80;

/**
 * EXACT copy of the server's address check (runtime/admin/accounts.ts `ADD_EMAIL_RE` / `normalizeAddEmail`), so the
 * page never accepts an address the server refuses (review finding 9). site/tests/signup-review-fixes.test.mjs runs
 * the same table through both; change them together.
 */
const ADD_EMAIL_RE =
  /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;
export function normalizeEmail(v) {
  if (typeof v !== 'string' || v.length > 320) return null;
  // ASCII only, checked before lower-casing (case folding maps e.g. U+212A KELVIN SIGN to `k`).
  const t = v.trim();
  if (!/^[\x21-\x7e]+$/.test(t)) return null;
  const e = t.toLowerCase();
  if (e.length > 254 || e.split('@')[0].length > 64 || !ADD_EMAIL_RE.test(e)) return null;
  return e;
}

/** @returns {string[]} error keys (name, email, role, heard, age, consent) for a values object. */
export function validate(v) {
  const bad = [];
  const name = String(v.name ?? '').trim();
  if (!name || [...name].length > NAME_MAX) bad.push('name');
  if (normalizeEmail(String(v.email ?? '')) === null) bad.push('email');
  if (!String(v.role ?? '')) bad.push('role');
  // Optional; the server (validate.ts) is the authority. Only its length limit (code points) is mirrored here.
  if ([...String(v.heard ?? '').trim()].length > HEARD_MAX) bad.push('heard');
  if (!v.age) bad.push('age');
  if (!v.consent) bad.push('consent');
  return bad;
}

/** Message keys (the page carries the text under data-msg="<key>"). */
export const MSG = {
  invalid: 'msgInvalid',
  tooFast: 'msgTooFast',
  rate: 'msgRate',
  unavailable: 'msgUnavailable',
  network: 'msgNetwork',
  forbidden: 'msgForbidden',
  generic: 'msgGeneric',
  session: 'msgSession',
};

function msgForStatus(status) {
  if (status === 429) return MSG.rate;
  if (status === 503) return MSG.unavailable;
  if (status === 403) return MSG.forbidden;
  return MSG.generic;
}

async function readJson(res) {
  try {
    const j = await res.json();
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** The server's minimum fill time in ms, clamped to 0..MAX_MIN_FILL_S seconds; a missing or odd value = the default. */
export function minFillMs(v) {
  const s = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_MIN_FILL_S;
  return Math.min(MAX_MIN_FILL_S, Math.max(0, s)) * 1000;
}

/** Holds the form token. Fetching never blocks typing; submit awaits it only when it is missing or about to expire. */
export function createTokenStore({ fetchFn, base, now = () => Date.now() }) {
  let tok = null;
  let inflight = null;
  const fresh = () => tok && now() < tok.expiresAt - TOKEN_MARGIN_MS;
  async function load() {
    let res;
    try {
      res = await fetchFn(`${base}/form-token`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
    } catch {
      throw { msg: MSG.network };
    }
    if (!res.ok) throw { msg: msgForStatus(res.status) };
    const j = await readJson(res);
    if (typeof j.token !== 'string' || !j.token) throw { msg: MSG.generic };
    const ttl = Number.isFinite(j.ttl) && j.ttl > 0 ? j.ttl : DEFAULT_TTL_S;
    const at = now();
    tok = {
      token: j.token,
      expiresAt: at + ttl * 1000,
      readyAt: at + minFillMs(j.minFill),
      fillMs: minFillMs(j.minFill),
    };
    return tok.token;
  }
  return {
    has: () => !!fresh(),
    /** ms still to wait before the current token may be posted (counted from its arrival on this page). */
    waitMs: () => (tok ? Math.max(0, tok.readyAt - now()) : 0),
    /** The current token's (clamped) minimum fill time in ms. */
    fillMs: () => (tok ? tok.fillMs : minFillMs(undefined)),
    invalidate() {
      tok = null;
    },
    /** @param {boolean} [force] fetch a new token even if the current one looks fresh (after a 401). */
    get(force = false) {
      if (!force && fresh()) return Promise.resolve(tok.token);
      if (!inflight)
        inflight = load().finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

/**
 * The submit flow. `submit(payload)` resolves to {ok:true} or {ok:false, msg:<MSG key>}; a call made while another is
 * running resolves to {ignored:true} (double-submit guard). Bounded, never a loop:
 * - every post waits until its token's minimum fill time has passed since the token arrived here;
 * - a 401 fetches a new token (the only case that does), waits for it and posts once more;
 * - a `too_fast` answer waits the fill time once more and posts once more with the same token, then stops.
 * So one submit makes at most three posts. `sleep` is injectable for tests.
 */
export function createSubmitter({
  fetchFn,
  base,
  tokens,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let busy = false;
  async function post(payload, token) {
    let res;
    try {
      res = await fetchFn(`${base}/web`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...payload, token }),
      });
    } catch {
      return { network: true };
    }
    return { status: res.status, body: await readJson(res) };
  }
  const isTooFast = (r) =>
    r.status === 400 && (r.body.error === 'too_fast' || r.body.code === 'too_fast');
  async function postWhenReady(payload, token) {
    const w = tokens.waitMs();
    if (w > 0) await sleep(w);
    return post(payload, token);
  }
  async function run(payload) {
    let token;
    try {
      token = await tokens.get();
    } catch (e) {
      return { ok: false, msg: e.msg ?? MSG.generic };
    }
    let r = await postWhenReady(payload, token);
    let waitedAgain = false;
    if (isTooFast(r)) {
      // Clocks disagree a little: wait the fill time once more, then post once more (no loop).
      waitedAgain = true;
      await sleep(tokens.fillMs());
      r = await post(payload, token);
    }
    if (r.status === 401) {
      // expired / used / unknown token: transparently get a new one, wait for it and try once more
      tokens.invalidate();
      try {
        token = await tokens.get(true);
      } catch (e) {
        return { ok: false, msg: e.msg ?? MSG.generic };
      }
      r = await postWhenReady(payload, token);
      if (isTooFast(r) && !waitedAgain) {
        await sleep(tokens.fillMs());
        r = await post(payload, token);
      }
      if (r.status === 401) {
        tokens.invalidate();
        return { ok: false, msg: MSG.session };
      }
    }
    if (r.network) return { ok: false, msg: MSG.network };
    if (r.status === 200 && r.body.ok === true) {
      tokens.invalidate();
      return { ok: true };
    }
    if (r.status === 400) {
      // too_fast keeps the token (the minimum fill time passes by itself); anything else may have consumed it
      if (isTooFast(r)) return { ok: false, msg: MSG.tooFast };
      tokens.invalidate();
      return { ok: false, msg: MSG.invalid };
    }
    if (r.status === 503 || r.status === 429) return { ok: false, msg: msgForStatus(r.status) };
    tokens.invalidate();
    return { ok: false, msg: msgForStatus(r.status) };
  }
  return {
    get busy() {
      return busy;
    },
    async submit(payload) {
      if (busy) return { ignored: true };
      busy = true;
      try {
        return await run(payload);
      } finally {
        busy = false;
      }
    },
  };
}

/* ---------------------------------------------------------------- DOM wiring (browser only) */

const FIELD_IDS = {
  name: 'su-name',
  email: 'su-email',
  role: 'su-role',
  heard: 'su-heard',
  age: 'su-age',
  consent: 'su-consent',
};

export function initSignup(doc = document, fetchFn = (...a) => fetch(...a)) {
  const form = doc.getElementById('signup-form');
  if (!form) return null;
  const $ = (id) => doc.getElementById(id);
  const base = form.dataset.api ?? '/signup';
  const tokens = createTokenStore({ fetchFn, base });
  const sub = createSubmitter({ fetchFn, base, tokens });
  const summary = $('su-summary');
  const summaryH = $('su-summary-h');
  const summaryList = $('su-summary-list');
  const summaryMsg = $('su-summary-msg');
  const status = $('su-status');
  const btn = $('su-submit');
  const text = (sel) => doc.querySelector(sel)?.textContent ?? '';
  const msg = (key) => text(`[data-msg="${key}"]`);

  /** Polite live region; clear first so an identical repeated message is announced again. */
  let announceSeq = 0;
  function announce(t) {
    const seq = ++announceSeq;
    status.textContent = '';
    setTimeout(() => {
      if (seq === announceSeq) status.textContent = t;
    }, 60);
  }

  const values = () => ({
    name: $(FIELD_IDS.name).value,
    email: $(FIELD_IDS.email).value,
    role: $(FIELD_IDS.role).value,
    heard: $(FIELD_IDS.heard).value,
    age: $(FIELD_IDS.age).checked,
    consent: $(FIELD_IDS.consent).checked,
  });

  /** A fixed field leaves the summary list; an empty summary (no failure message) disappears. */
  function dropSummaryItem(key) {
    for (const li of summaryList.children) if (li.dataset.key === key) li.remove();
    if (summaryList.children.length === 0) summaryList.hidden = true;
    if (summaryList.children.length === 0 && summaryMsg.hidden) summary.hidden = true;
  }

  function setFieldError(key, on) {
    const el = $(FIELD_IDS[key]);
    const err = $(`su-err-${key}`);
    const hint = $(`su-hint-${key}`);
    err.hidden = !on;
    if (on) el.setAttribute('aria-invalid', 'true');
    else {
      el.removeAttribute('aria-invalid');
      dropSummaryItem(key);
    }
    el.setAttribute('aria-describedby', [hint && hint.id, on && err.id].filter(Boolean).join(' '));
    if (!el.getAttribute('aria-describedby')) el.removeAttribute('aria-describedby');
  }

  function showSummary({ fieldKeys = [], failMsg = '' }) {
    summaryList.replaceChildren();
    summaryMsg.textContent = failMsg;
    summaryMsg.hidden = !failMsg;
    summaryList.hidden = fieldKeys.length === 0;
    summaryH.textContent = failMsg
      ? text('[data-msg="summaryFailH"]')
      : text('[data-msg="summaryFieldsH"]');
    for (const k of fieldKeys) {
      const li = doc.createElement('li');
      li.dataset.key = k;
      const a = doc.createElement('a');
      a.href = `#${FIELD_IDS[k]}`;
      a.textContent = $(`su-err-${k}`).textContent;
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        $(FIELD_IDS[k]).focus();
      });
      li.append(a);
      summaryList.append(li);
    }
    summary.hidden = false;
    if (doc.activeElement === summary) announce(failMsg || text('[data-msg="statusErrors"]'));
    summary.focus();
  }
  const hideSummary = () => {
    summary.hidden = true;
  };

  function setBusy(on) {
    // aria-disabled (not disabled) so keyboard focus stays on the button while sending. The label stays the same:
    // the polite status region is the single announcement channel for "sending".
    btn.setAttribute('aria-disabled', on ? 'true' : 'false');
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    form.classList.toggle('is-sending', on);
  }

  function success() {
    form.hidden = true;
    $('su-intro-extra')?.setAttribute('hidden', '');
    const ok = $('su-success');
    ok.hidden = false;
    // The focused heading is the announcement; clear the stale "sending" text so nothing is read twice.
    announceSeq++;
    status.textContent = '';
    $('su-success-h').focus();
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (sub.busy) return;
    const v = values();
    const bad = validate(v);
    for (const k of Object.keys(FIELD_IDS)) setFieldError(k, bad.includes(k));
    if (bad.length) {
      showSummary({ fieldKeys: bad });
      return;
    }
    hideSummary();
    setBusy(true);
    announce(text('[data-msg="statusSending"]'));
    const r = await sub.submit({
      name: v.name.trim(),
      email: v.email.trim(),
      role: v.role,
      lang: form.dataset.lang,
      consent: true,
      heardFrom: v.heard.trim(),
      website: form.elements.website.value,
    });
    setBusy(false);
    if (r.ignored) return;
    if (r.ok) return success();
    showSummary({ failMsg: msg(r.msg) });
  });

  // Clear a field's error as soon as its value becomes valid (no timing, no re-submit needed).
  form.addEventListener('input', (ev) => {
    const key = Object.keys(FIELD_IDS).find((k) => FIELD_IDS[k] === ev.target.id);
    if (!key || $(`su-err-${key}`).hidden) return;
    if (!validate(values()).includes(key)) setFieldError(key, false);
  });
  form.addEventListener('change', (ev) => {
    const key = Object.keys(FIELD_IDS).find((k) => FIELD_IDS[k] === ev.target.id);
    if (!key || $(`su-err-${key}`).hidden) return;
    if (!validate(values()).includes(key)) setFieldError(key, false);
  });

  // Token: fetched when the page loads, retried silently on first focus if that failed. Never blocks typing.
  const warm = () => tokens.get().catch(() => {});
  form.addEventListener('focusin', () => !tokens.has() && warm());
  form.hidden = false;
  doc.getElementById('su-nojs')?.setAttribute('hidden', '');
  warm();
  return { tokens, sub };
}

if (typeof document !== 'undefined') initSignup(document);
