#!/usr/bin/env node
/**
 * Frontend release verification (Sprint 10): is the intended commit what is built, and what is
 * actually served? Node built-ins only.
 *
 *   verify-build.mjs local  <dist dir>    <commit>   the build output (before publishing)
 *   verify-build.mjs served <release dir> <commit>   the gate's origin + the public site (root)
 *
 * `served` talks to the gate's internal origin (unix:/run/tbi-gate/internal.sock, the upstream the
 * authenticated public site proxies every request to) with the public Host, so it sees exactly
 * what a signed-in browser gets, and checks that the public HTTPS site is up and gated.
 * Exit 0 only if every check passes.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { join } from 'node:path';

const [mode, dir, commit] = process.argv.slice(2);
const HOST = 'dev-lab.tbi-tech.net';
const SOCKET = '/run/tbi-gate/internal.sock';
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** Content-hashed assets the entry HTML references. */
const refs = (html) => [
  ...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])),
];

function checkIdentity(v, where) {
  check(`${where}: product`, v?.product === 'TBI Lab');
  check(`${where}: commit is the intended commit`, v?.commit === commit, `${v?.commit}`);
  check(`${where}: short commit`, v?.shortCommit === commit.slice(0, 7), `${v?.shortCommit}`);
  check(`${where}: environment dev-lab`, v?.environment === 'dev-lab', `${v?.environment}`);
  check(`${where}: built from a clean commit`, v?.dirty === false);
}

if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !['local', 'served'].includes(mode)) {
  console.error('usage: verify-build.mjs local|served <dir> <40-hex commit>');
  process.exit(2);
}

const html = readFileSync(join(dir, 'index.html'), 'utf8');
const version = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'));
checkIdentity(version, 'version.json (release)');
const assets = refs(html);
check('index.html references content-hashed assets', assets.length > 0, assets.join(' '));
for (const a of assets) check(`asset present: ${a}`, existsSync(join(dir, a)));
const entry = assets.find((a) => /\/assets\/index-[\w-]+\.js$/.test(a));
check(
  'the compiled bundle carries the same commit',
  !!entry && readFileSync(join(dir, entry), 'utf8').includes(commit),
  entry ?? 'no entry script',
);

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http(
      {
        socketPath: SOCKET,
        path,
        method: 'GET',
        headers: { Host: HOST, 'X-Forwarded-User': 'deploy-verify' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
function publicGet(path) {
  return new Promise((resolve) => {
    const req = https({ host: HOST, path, method: 'GET', timeout: 15000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location ?? '' });
    });
    req.on('error', (e) => resolve({ status: 0, location: String(e) }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

if (mode === 'served') {
  const v = await get('/version.json');
  check('served /version.json: 200', v.status === 200, `${v.status}`);
  let served = null;
  try {
    served = JSON.parse(v.body.toString('utf8'));
  } catch {
    /* reported below */
  }
  checkIdentity(served, 'version.json (served)');
  check(
    'served /version.json is the release file',
    sha256(v.body) === sha256(readFileSync(join(dir, 'version.json'))),
  );
  check(
    'served /version.json is not long-cached',
    /no-store|no-cache/.test(v.headers['cache-control'] ?? ''),
    v.headers['cache-control'],
  );
  const page = await get('/');
  check(
    'served / is the release index.html (byte for byte)',
    page.status === 200 && sha256(page.body) === sha256(readFileSync(join(dir, 'index.html'))),
  );
  check(
    'served / is not long-cached',
    /no-store|no-cache/.test(page.headers['cache-control'] ?? ''),
    page.headers['cache-control'],
  );
  for (const a of refs(page.body.toString('utf8'))) {
    const r = await get(a);
    check(
      `served ${a}`,
      r.status === 200 && sha256(r.body) === sha256(readFileSync(join(dir, a))),
      `${r.status} ${r.headers['cache-control'] ?? ''}`,
    );
  }
  const pub = await publicGet('/version.json');
  check(
    'public https://dev-lab.tbi-tech.net/version.json is up and behind the sign-in gate',
    pub.status === 302 || pub.status === 401 || pub.status === 403,
    `${pub.status} ${pub.location.replace(/client_id=[^&]+/, 'client_id=…').slice(0, 80)}`,
  );
}

console.log(failed ? `\n${failed} check(s) FAILED` : `\nall checks passed: ${commit}`);
process.exit(failed ? 1 : 0);
