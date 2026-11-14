/**
 * Sprint 28 on staging (the real tbi-s8-assist unit, as install.sh renders it): the AI provider
 * service through its unix socket, with the instance's real identity key.
 *
 * - its sandbox: own user, no gate group, no IP traffic, the build service's and Session Host's
 *   sockets and the artifact store inaccessible in its mount namespace;
 * - inactive states: provider none; a live provider without the owner approvals (every reason
 *   named); the explain endpoint refuses before reading the request;
 * - the mock path end to end (staging only allows the mock): consent, recomputed findings,
 *   validated reply, the audit log.
 * Skipped unless the staging instance is installed. The staging config is restored afterwards.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mutationAllowed, mutationSkipReason } from './mutation-gate.js';
import { EXPLAIN_CONTRACT, buildEngineeringContext, diagnose } from '@tbi-lab/assist';
import { CASES } from '../../packages/assist/eval/cases.js';
import { derivePrincipal, identityConfig } from '../identity/principal.js';

const N = 'tbi-s8';
const SOCK = `/run/${N}-assist/api.sock`;
// Config-mutating and service-restarting (installs /etc/tbi-s8/assist.json, restarts the assist
// and build services) and it reads the instance's identity key as root: gated (mutation-gate.ts).
const HAVE = spawnSync('sudo', ['-n', 'test', '-S', SOCK]).status === 0 && mutationAllowed(N);
if (!HAVE)
  console.warn(mutationSkipReason(N, 's28-assist (assist.json install, service restarts)'));
const STAGING_CONFIG = new URL('../../deploy/dev-lab/s8/assist.staging.json', import.meta.url)
  .pathname;
const sudo = (...a: string[]) => {
  const r = spawnSync('sudo', ['-n', ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const relays: ChildProcess[] = [];
let BASE = '';

async function relay(socket: string): Promise<string> {
  // 5060/5061 are refused by fetch (Sprint 27 finding): never chosen.
  let port: number;
  do port = 5300 + Math.floor(Math.random() * 300);
  while (port === 5060 || port === 5061);
  const code = `const net=require('node:net');net.createServer((c)=>{const u=net.connect(${JSON.stringify(socket)});c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(${port},'127.0.0.1',()=>console.log('ready'));`;
  const child = spawn('sudo', ['-n', process.execPath, '-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  relays.push(child);
  await new Promise<void>((resolve) => child.stdout!.on('data', () => resolve()));
  return `http://127.0.0.1:${port}`;
}

function installConfig(c: unknown) {
  const tmp = `/tmp/claude-1001/assist-${process.pid}.json`;
  writeFileSync(tmp, JSON.stringify(c));
  sudo('install', '-m', '0400', tmp, `/etc/${N}/assist.json`);
  sudo('systemctl', 'restart', `${N}-assist.service`);
}
async function healthy() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/v1/status`)).status === 401) return;
    } catch {
      /* restarting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
const call = async (method: string, path: string, subject: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'x-forwarded-user': subject,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const SUBJECT = 's28-pilot-test-subject';
let pilot = '';
const context = () => {
  for (const c of CASES) {
    const r = buildEngineeringContext(c.input());
    if (r.ok && diagnose(r.context).length) return r.context;
  }
  throw new Error('no case');
};

beforeAll(async () => {
  if (!HAVE) return;
  // The instance's principal for the test subject (its real identity key, read as root).
  const key = Buffer.from(sudo('base64', '-w0', `/etc/${N}/identity.key`), 'base64');
  pilot = derivePrincipal(identityConfig({ issuer: 'google', key }), SUBJECT);
  BASE = await relay(SOCK);
}, 60_000);
afterAll(() => {
  if (!HAVE) return;
  installConfig(JSON.parse(readFileSync(STAGING_CONFIG, 'utf8'))); // back to the staging default
  for (const r of relays) if (r.pid) sudo('pkill', '-TERM', '-P', String(r.pid));
});

describe.skipIf(!HAVE)('Sprint 28: the AI provider service on staging (real unit)', () => {
  it('its sandbox: own user, no gate group, no IP, other services unreachable', () => {
    // The build service restarts first: its runtime directory is recreated AFTER this service's
    // namespace was set up (the case an InaccessiblePaths= mask missed).
    sudo('systemctl', 'restart', `${N}-build.service`);
    const show = sudo(
      'systemctl',
      'show',
      `${N}-assist.service`,
      '-p',
      'User,Group,SupplementaryGroups,RestrictAddressFamilies,IPAddressDeny,NoNewPrivileges,ProtectSystem,MainPID',
    );
    expect(show).toMatch(/^User=tbi-s8-assist$/m);
    expect(show).toMatch(/^Group=tbi-s8-assist$/m);
    expect(show).toMatch(/^SupplementaryGroups=$/m);
    expect(show).toMatch(/^RestrictAddressFamilies=AF_UNIX$/m);
    expect(show).toMatch(/^IPAddressDeny=.*(0\.0\.0\.0\/0|any)/m);
    expect(show).toMatch(/^NoNewPrivileges=yes$/m);
    expect(show).toMatch(/^ProtectSystem=strict$/m);
    const pid = /^MainPID=(\d+)$/m.exec(show)![1]!;
    // In the service's own mount namespace: the other services' sockets do not exist there, also
    // after those services restarted (the s8-policy suite restarts them), and the store is masked.
    for (const path of [
      `/run/${N}-build/api.sock`,
      `/run/${N}-runtime/api.sock`,
      `/run/tbi-gate`,
    ]) {
      const r = spawnSync('sudo', ['-n', 'nsenter', '-t', pid, '-m', 'test', '-e', path]);
      expect(r.status, `${path} visible to the service`).not.toBe(0);
    }
    // As the service's own user and group, in its namespace: the host's build socket cannot be
    // connected to even by path through /proc/1/root (its group is not the gate group).
    const uid = sudo('id', '-u', 'tbi-s8-assist').trim();
    const gid = sudo('id', '-g', 'tbi-s8-assist').trim();
    const connect = spawnSync('sudo', [
      '-n',
      'nsenter',
      '-t',
      pid,
      '-m',
      '-S',
      uid,
      '-G',
      gid,
      '/usr/bin/python3',
      '-c',
      `import socket;s=socket.socket(socket.AF_UNIX);s.connect('/proc/1/root/run/${N}-build/api.sock')`,
    ]);
    expect(connect.status, 'connect to the build socket as tbi-s8-assist').not.toBe(0);
    const store = spawnSync('sudo', [
      '-n',
      'nsenter',
      '-t',
      pid,
      '-m',
      'ls',
      `/var/lib/${N}-artifacts`,
    ]);
    expect(store.stdout.toString().trim()).toBe(''); // masked: empty, nothing listed
    const groups = sudo('id', '-nG', 'tbi-s8-assist').trim().split(/\s+/);
    expect(groups).toEqual(['tbi-s8-assist']);
  });

  it('provider none: disabled, named; explain refused before the request is read', async () => {
    installConfig({ version: 1, provider: { kind: 'none' }, pilot: { principals: [pilot] } });
    await healthy();
    expect((await call('GET', '/v1/status', SUBJECT)).body).toMatchObject({
      state: 'disabled',
      reasons: ['no_provider'],
      pilot: true,
    });
    expect(await call('POST', '/v1/explain', SUBJECT, { anything: true })).toMatchObject({
      status: 503,
      body: { error: 'pilot_disabled', reasons: ['no_provider'] },
    });
    expect(await call('POST', '/v1/explain', 'not-a-pilot', { anything: true })).toMatchObject({
      status: 403,
    });
  });

  it('a live provider without the owner approvals stays disabled, every reason named', async () => {
    installConfig({
      version: 1,
      provider: { kind: 'anthropic', model: 'claude-haiku-5-5' },
      pilot: { principals: [pilot] },
    });
    await healthy();
    const s = await call('GET', '/v1/status', SUBJECT);
    expect(s.body).toMatchObject({ state: 'disabled' });
    expect(s.body.reasons).toEqual([
      'approval_missing:providerAndModel',
      'approval_missing:dataTerms',
      'approval_missing:spendCap',
      'approval_missing:securityReview',
      'approval_missing:ownerActivation',
      'no_pricing',
      'no_credential',
    ]);
  });

  it('the mock end to end through the real unit: consent, recomputed findings, validated reply, audit', async () => {
    installConfig({ version: 1, provider: { kind: 'mock' }, pilot: { principals: [pilot] } });
    await healthy();
    const c = context();
    const body = { contract: EXPLAIN_CONTRACT, locale: 'en', context: c };
    expect((await call('POST', '/v1/explain', SUBJECT, body)).status).toBe(428);
    const r = await call('POST', '/v1/explain', SUBJECT, {
      ...body,
      consent: { version: '2026-11-02', accepted: true },
    });
    expect(r.status).toBe(200);
    expect(r.body.findings).toEqual(JSON.parse(JSON.stringify(diagnose(c))));
    expect(r.body.accounting).toMatchObject({ provider: 'mock', live: false, costUsd: 0 });
    const audit = sudo('bash', '-c', `cat /var/lib/${N}-assist/audit-*.jsonl`);
    expect(audit).toContain('"outcome":"ok"');
    expect(audit).not.toContain(pilot);
    expect(audit).not.toContain(SUBJECT);
  });
});
