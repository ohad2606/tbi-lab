/* global createTokenStore, createSubmitter, normalizeEmail, MSG */
/**
 * BETA-G1 G1-AUTO-VERIFY slice 3: confirm view and resend form of the sign-up page.
 *
 * NOT a standalone module: `buildSite(..., { signupVerify: true })` appends this file to signup.mjs, which provides
 * createTokenStore, createSubmitter, normalizeEmail and MSG, so the page still loads one script (publish gate, DEC-15).
 * With the option off (the default) none of this is in any built file.
 *
 * Rules (design sections 3, 4, 7, 11):
 * - the token comes from location.hash only, is removed from the address bar at once, lives in one closure variable and
 *   goes nowhere but the body of POST <base>/verify, on a button click (never on load);
 * - POST <base>/verify {token}: 202 received, 410 expired, 400 invalid, 429 rate limited, anything else "not now";
 * - POST <base>/resend {email, website, token = form token}: one neutral answer for every address;
 * - all text is rendered by the generator; this script only copies textContent and toggles.
 */

export const VERIFY_HASH = '#verify=';
/** The server's own bound and alphabet (verify token `v1.<id>.<gen>.<exp>.<nonce>.<mac>`); it checks the rest. */
const VERIFY_TOKEN_SHAPE = /^[A-Za-z0-9_.-]{1,160}$/;
/** A request with no answer after this long counts as a network failure (the button must not stay busy for ever). */
export const VERIFY_TIMEOUT_MS = 20_000;

/** @returns {string|null} the text after `#verify=` (may be empty), or null when this is not a confirm link. */
export function readVerifyToken(hash) {
  return hash.startsWith(VERIFY_HASH) ? hash.slice(VERIFY_HASH.length) : null;
}

/** @returns {Promise<'received'|'expired'|'invalid'|'rate'|'network'|'unavailable'>} */
export async function postVerify(fetchFn, base, token) {
  if (!VERIFY_TOKEN_SHAPE.test(token)) return 'invalid';
  let res;
  try {
    res = await fetchFn(`${base}/verify`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token }),
      signal: globalThis.AbortSignal?.timeout?.(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return 'network';
  }
  if (res.status === 410) return 'expired';
  if (res.status === 400 || res.status === 413) return 'invalid';
  if (res.status === 429) return 'rate';
  if (res.status !== 202) return 'unavailable';
  try {
    return (await res.json())?.ok === true ? 'received' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * The resend submit has the sign-up form's contract (form token, minimum fill wait, one retry after 401 / too_fast,
 * double-submit guard, same outcome keys), so it is the same submitter pointed at <base>/resend.
 */
export function createResender({ fetchFn, base, tokens, sleep }) {
  return createSubmitter({
    fetchFn: (url, init) => fetchFn(url === `${base}/web` ? `${base}/resend` : url, init),
    base,
    tokens,
    sleep,
  });
}

export function initVerify(win = window, fetchFn = (...a) => fetch(...a)) {
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const view = $('vf');
  if (!view) return null;
  const base = $('signup-form').dataset.api ?? '/signup';
  const text = (key) => doc.querySelector(`[data-vf="${key}"]`);
  const button = $('vf-button');
  const form = $('vf-resend');
  const input = $('vf-email');
  const error = $('vf-err-email');
  const heading = $('vf-result-h');
  const body = $('vf-result-p');
  let token = '';
  let busy = false;
  let resender = null;
  /** A newer confirm link or action makes older pending answers and announcements stale. */
  let run = 0;
  let shown = 0;
  let progressSeq = 0;

  function progress(key) {
    const seq = ++progressSeq;
    const line = $('vf-sending');
    const live = $('vf-progress');
    live.textContent = '';
    line.hidden = !key;
    line.textContent = key ? text(key).textContent : '';
    if (key) win.setTimeout(() => seq === progressSeq && (live.textContent = line.textContent), 60);
  }

  function clearResult() {
    shown++;
    heading.hidden = true;
    body.hidden = true;
    heading.textContent = '';
    body.replaceChildren();
  }

  /**
   * Cleared first and filled a moment later, so the same result twice in a row is announced again. Focus moves to the
   * result heading. `source` is a generator-rendered element; its nodes are cloned (the support link, LTR spans).
   */
  function result(headingKey, source) {
    clearResult();
    const seq = shown;
    win.setTimeout(() => {
      if (seq !== shown) return;
      heading.textContent = text(headingKey).textContent;
      body.replaceChildren(...[...source.childNodes].map((n) => n.cloneNode(true)));
      heading.hidden = false;
      body.hidden = false;
      heading.focus();
    }, 60);
  }
  const outcome = (name) => result(`result${name}H`, text(`result${name}P`));

  function setBusy(el, on) {
    // aria-disabled (not disabled): keyboard focus stays on the button while sending.
    el.setAttribute('aria-disabled', on ? 'true' : 'false');
    el.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function setEmailError(on) {
    error.hidden = !on;
    if (on) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', on ? 'vf-hint-email vf-err-email' : 'vf-hint-email');
  }

  function showResend() {
    form.hidden = false;
    if (!resender) {
      const tokens = createTokenStore({ fetchFn, base });
      resender = { tokens, sub: createResender({ fetchFn, base, tokens }) };
    }
    resender.tokens.get().catch(() => {}); // warm: the minimum fill time starts now; never blocks typing
  }

  /** Reads the token and removes it from the address bar and this history entry. */
  function open() {
    const found = readVerifyToken(win.location.hash);
    if (found === null) return false;
    win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search);
    token = found;
    run++;
    busy = false;
    setBusy(button, false);
    setBusy($('vf-resend-button'), false);
    progress('');
    clearResult();
    $('su-flow').hidden = true;
    $('su-intro-extra').hidden = true;
    $('su-nojs').hidden = true;
    doc.title = text('confirmTitle').textContent;
    $('su-h1').textContent = text('confirmH').textContent;
    $('vf-intro').hidden = false;
    $('vf-confirm').hidden = false;
    form.hidden = true;
    form.reset();
    setEmailError(false);
    view.hidden = false;
    return true;
  }

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const mine = run;
    setBusy(button, true);
    clearResult();
    progress('confirmSending');
    const r = await postVerify(fetchFn, base, token);
    if (mine !== run) return;
    busy = false;
    setBusy(button, false);
    progress('');
    // A final answer: drop the token and the button. The others can be tried again.
    if (r === 'received' || r === 'expired' || r === 'invalid') {
      token = '';
      $('vf-intro').hidden = true;
      $('vf-confirm').hidden = true;
      if (r !== 'received') showResend();
    }
    outcome(r[0].toUpperCase() + r.slice(1));
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (resender.sub.busy) return;
    const bad = normalizeEmail(input.value) === null;
    setEmailError(bad);
    if (bad) return input.focus(); // the focused field reads its label, hint and error
    const mine = run;
    const send = $('vf-resend-button');
    setBusy(send, true);
    clearResult();
    progress('resendSending');
    const r = await resender.sub.submit({
      email: input.value.trim(),
      website: form.elements.website.value,
    });
    if (mine !== run || r.ignored) return;
    setBusy(send, false);
    progress('');
    if (r.ok) {
      form.hidden = true;
      return outcome('Sent');
    }
    result('resultFailH', doc.querySelector(`[data-msg="${r.msg ?? MSG.generic}"]`));
  });

  input.addEventListener('input', () => {
    if (!error.hidden && normalizeEmail(input.value) !== null) setEmailError(false);
  });

  // The link opened in a tab that already shows the page changes only the fragment: no reload, so listen.
  win.addEventListener('hashchange', () => {
    if (!open()) return;
    $('su-h1').setAttribute('tabindex', '-1');
    $('su-h1').focus();
  });
  open();
  return { open };
}

if (typeof document !== 'undefined') initVerify();
