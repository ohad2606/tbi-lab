// G2 live logging check, part 1: send requests carrying FAKE, marker-tagged "secrets" through the
// public gate. Prints only the marker (random, non-secret) and statuses. Part 2 (shell) then counts
// the marker in the journal and /var/log/syslog: the secret-shaped values must never be stored;
// the KEEP values (non-secret) must stay observable.
import { randomBytes } from 'node:crypto';
const BASE = 'https://dev-lab.tbi-tech.net';
const M = `G2M${randomBytes(5).toString('hex')}`;
const get = (path, h = {}) => fetch(BASE + path, { redirect: 'manual', headers: { 'user-agent': `tbi-g2-check KEEPUA-${M}`, ...h } });
const out = { marker: M };
const st = (s) => encodeURIComponent(`${M}-STATE-nonce:/`) + (s ?? '');
// 1. A callback without a CSRF cookie, from a "signed-in" browser (fake session cookie) with a
//    fake bearer: oauth2-proxy's failure path dumps this whole request (must be dropped).
out.callbackNoCsrf = (await get(`/oauth2/callback?state=${st()}&code=${M}-CODE1`, { accept: 'text/html', cookie: `__Host-tbi_dev_lab=${M}-SESSION1`, authorization: `Bearer ${M}-BEARER1` })).status;
// 2. A callback with a fake per-request CSRF cookie that does not match.
out.callbackWrongCsrf = (await get(`/oauth2/callback?state=${st()}&code=${M}-CODE2`, { accept: 'text/html', cookie: `__Host-tbi_dev_lab_abcdef_csrf=${M}-CSRF2; __Host-tbi_dev_lab=${M}-SESSION2` })).status;
// 3. A malformed state: an operational error line that must stay observable (without the code).
out.callbackMalformed = (await get(`/oauth2/callback?state=${M}-STATEBAD&code=${M}-CODE3`, { accept: 'text/html' })).status;
// 4. Ordinary requests with fake credentials: still logged (path, status), never the credential.
out.pageLoad = (await get(`/?probe=KEEPPAGE-${M}`, { accept: 'text/html', cookie: `__Host-tbi_dev_lab=${M}-SESSION4`, authorization: `Bearer ${M}-BEARER4` })).status;
out.background = (await get(`/version.json?probe=KEEPJSON-${M}`, { accept: 'application/json', authorization: `Bearer ${M}-BEARER5` })).status;
console.log(JSON.stringify(out));
const ok = out.callbackNoCsrf === 403 && out.callbackWrongCsrf === 403 && out.callbackMalformed === 500 && out.pageLoad === 302 && out.background === 401;
process.exit(ok ? 0 : 1);
