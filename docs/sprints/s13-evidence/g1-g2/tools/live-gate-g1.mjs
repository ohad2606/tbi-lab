// Anonymous checks of the PUBLIC gate (no account, no real credential). Prints statuses, cookie
// NAMES and attributes only; never a cookie value, state or code. Callback checks use obviously
// fake values. Usage: node live-gate-g1.mjs <expect: g1|pre>
const BASE = 'https://dev-lab.tbi-tech.net';
const mode = process.argv[2];
let fails = 0;
const check = (name, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`); };
const csrfName = mode === 'g1' ? /^__Host-tbi_dev_lab_[A-Za-z0-9_-]+_csrf$/ : /^__Host-tbi_dev_lab_csrf$/;
const parse = (sc) => { const [nv, ...a] = sc.split(';'); return { name: nv.slice(0, nv.indexOf('=')).trim(), attrs: a.map((x) => x.trim().replace(/=.*/, (m) => (/^=(\d+|Lax|Strict|None|\/)$/i.test(m) ? m : '=…'))) }; };
const get = (path, accept, cookie = '') => fetch(BASE + path, { redirect: 'manual', headers: { accept, ...(cookie ? { cookie } : {}), 'user-agent': 'tbi-g1-live-check' } });

// 1. A page load (not signed in): one login starts, with a CSRF cookie of the expected name.
const r1 = await get('/', 'text/html');
const c1 = r1.headers.getSetCookie().map(parse);
const loc1 = new URL(r1.headers.get('location') ?? 'x:/');
check('page load -> 302 to Google', r1.status === 302 && loc1.host === 'accounts.google.com', `${r1.status} ${loc1.host}`);
check('exactly one Set-Cookie, the CSRF cookie with the expected name', c1.length === 1 && csrfName.test(c1[0].name), c1.map((c) => c.name.replace(/_[A-Za-z0-9-]{6,}_csrf$/, '_<hash>_csrf')).join(','));
const a = (c1[0]?.attrs ?? []).map((x) => x.toLowerCase());
check('CSRF cookie: Path=/, Secure, HttpOnly, SameSite=Lax, Max-Age=900, no Domain', a.includes('path=/') && a.includes('secure') && a.includes('httponly') && a.includes('samesite=lax') && a.includes('max-age=900') && !a.some((x) => x.startsWith('domain')), a.join(' '));
check('Google request: prompt=select_account, state present, redirect to the gate callback', loc1.searchParams.get('prompt') === 'select_account' && !!loc1.searchParams.get('state') && loc1.searchParams.get('redirect_uri') === `${BASE}/oauth2/callback`);
// 2. Two concurrent logins in one browser: with G1 two distinct cookies (none overwritten).
const r2 = await get('/b', 'text/html', c1.length ? `${c1[0].name}=placeholder-not-a-value` : '');
const c2 = r2.headers.getSetCookie().map(parse);
const distinct = c2.length === 1 && c1.length === 1 && c2[0].name !== c1[0].name;
check(mode === 'g1' ? 'second concurrent login gets its OWN cookie name (no overwrite)' : 'second login reuses the SAME cookie name (pre-G1 behaviour)', mode === 'g1' ? distinct : c2[0]?.name === c1[0]?.name);
// 3. Background request (JSON): 401, no cookie, no redirect.
for (const p of ['/version.json', '/runtime/health']) {
  const r = await get(p, 'application/json');
  check(`background ${p} -> 401, no Set-Cookie, no Location`, r.status === 401 && r.headers.getSetCookie().length === 0 && !r.headers.get('location'), String(r.status));
}
// 4. Callbacks with fake values: refused, no session cookie set.
// The gate's state is `<nonce>:<redirect>` (encode_state is off). A malformed state is refused
// earlier, with 500 ("invalid length"); this one reaches the CSRF check.
const fakeState = encodeURIComponent('FAKE-NONCE-g1-live-check:/');
const r0 = await get('/oauth2/callback?state=FAKE-MALFORMED&code=FAKE-CODE-g1-live-check', 'text/html');
check('callback with a malformed fake state -> refused (500), no session', r0.status === 500 && !r0.headers.getSetCookie().some((c) => /^__Host-tbi_dev_lab=[^;]/.test(c) && !/max-age=0/i.test(c)), String(r0.status));
for (const [label, cookie] of [
  ['no CSRF cookie', ''],
  ['a fake CSRF cookie of the per-request form', '__Host-tbi_dev_lab_FAKEHASH_csrf=FAKE-not-a-value'],
  ['a fake fixed-name CSRF cookie', '__Host-tbi_dev_lab_csrf=FAKE-not-a-value'],
]) {
  const r = await get(`/oauth2/callback?state=${fakeState}&code=FAKE-CODE-g1-live-check`, 'text/html', cookie);
  const sess = r.headers.getSetCookie().map(parse).filter((c) => c.name === '__Host-tbi_dev_lab' && !c.attrs.some((x) => /max-age=0|expires=/i.test(x)));
  check(`callback with fake state, ${label} -> 403, no session`, r.status === 403 && sess.length === 0, String(r.status));
}
// 5. Protected content stays protected.
const r5 = await get('/assets/', 'text/html');
check('protected path, not signed in -> 302 to Google (never content)', r5.status === 302);
console.log(`\n${fails ? 'FAILED: ' + fails : 'all passed'}`);
process.exit(fails ? 1 : 0);
