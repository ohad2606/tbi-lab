/**
 * Sprint 23C: the admin service's socket (group tbi-sock-admin, mode 0660, owner-only from the
 * moment it is bound: the N5 umask bind) and its live-session count, read from the Session Host's
 * health-only socket (counts only).
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccessView } from '../../identity/access.js';
import { listen, parseListen, socketGidFromEnv } from '../../identity/listen.js';
import { TEST_IDENTITY } from '../../identity/test-gate.js';
import type { SessionHost } from '../../host/host.js';
import { createHealthServer } from '../../host/http.js';
import { fakeHost } from '../../host/tests/support.js';
import { createAdminServer } from '../accounts.js';
import { healthCapacity, parseCapacity } from '../capacity.js';

let host: SessionHost;
beforeAll(() => {
  host = fakeHost('normal').host;
});
afterAll(async () => {
  await host.shutdown();
});
const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tbi-admin-sock-'));
  dirs.push(d);
  return d;
};

function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ socketPath, path }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', fail);
    r.end();
  });
}

describe('admin service socket', () => {
  it('its configured group and mode 0660, owner-only while being bound (N5)', async () => {
    const d = tmp();
    writeFileSync(join(d, 'access.json'), 'not a view');
    const access = new AccessView(join(d, 'access.json'));
    const server = createAdminServer(TEST_IDENTITY, {
      access,
      spool: null,
      capacity: async () => null,
    });
    closers.push(() => server.close());
    const groups = process.getgroups?.() ?? [];
    const gid = groups.find((g) => g !== process.getgid?.()) ?? process.getgid!();
    const path = join(d, 'api.sock');
    let first = -1;
    server.once('listening', () => (first = statSync(path).mode & 0o777));
    await listen(
      server,
      parseListen(`unix:${path}`),
      socketGidFromEnv('TBI_SOCKET_GID', { TBI_SOCKET_GID: String(gid) }),
    );
    const st = statSync(path);
    expect(st.isSocket()).toBe(true);
    expect(st.gid).toBe(gid);
    expect(st.mode & 0o777).toBe(0o660);
    expect(first & 0o077).toBe(0); // nobody but the owner while the group was not set yet
    // Reachable, and with no identity every route is refused (here: no valid view either).
    expect((await get(path, '/accounts')).status).toBe(401);
  });

  it('reads the live-session count from the health-only socket (counts only)', async () => {
    const d = tmp();
    const health = createHealthServer(host);
    closers.push(() => health.close());
    const path = join(d, 'health.sock');
    await listen(health, parseListen(`unix:${path}`));
    const body = JSON.parse((await get(path, '/health')).body) as Record<string, unknown>;
    expect(body.capacity).toEqual(host.capacity());
    expect(JSON.stringify(body)).not.toMatch(/p_[A-Za-z0-9_-]{26}/);
    expect(await healthCapacity(parseListen(`unix:${path}`))()).toEqual(host.capacity());
    // Unreachable or malformed: unknown (the API answers 503).
    expect(await healthCapacity(parseListen(`unix:${join(d, 'none.sock')}`))()).toBeNull();
    for (const bad of ['', '{}', '{"capacity":{"live":-1,"max":4}}', '{"capacity":{"live":"1"}}'])
      expect(parseCapacity(bad), bad).toBeNull();
  });
});
