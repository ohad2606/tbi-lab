/**
 * Sprint 23B (security review H1): each backend's unix socket gets its own configured group and
 * mode 0660, so only that group (the backend and the internal proxy) can connect.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listen, parseListen, socketGidFromEnv } from '../listen.js';

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('backend socket groups', () => {
  it('the socket gets the configured group and mode 0660', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tbi-sock-'));
    dirs.push(d);
    // A group this process may give a file: a supplementary one when it has any, else its own.
    const groups = process.getgroups?.() ?? [];
    const gid = groups.find((g) => g !== process.getgid?.()) ?? process.getgid!();
    const server = createServer((_req, res) => res.end('ok'));
    closers.push(() => server.close());
    const spec = parseListen(`unix:${join(d, 'api.sock')}`);
    await listen(server, spec, socketGidFromEnv('TBI_SOCKET_GID', { TBI_SOCKET_GID: String(gid) }));
    const st = statSync(join(d, 'api.sock'));
    expect(st.isSocket()).toBe(true);
    expect(st.gid).toBe(gid);
    expect(st.mode & 0o777).toBe(0o660);
    // Still reachable by its owner.
    const body = await new Promise<string>((ok, fail) => {
      const r = request({ socketPath: join(d, 'api.sock'), path: '/' }, (res) => {
        let t = '';
        res.on('data', (c: Buffer) => (t += c.toString()));
        res.on('end', () => ok(t));
      });
      r.on('error', fail);
      r.end();
    });
    expect(body).toBe('ok');
  });

  it('the group comes from the environment, strictly', () => {
    expect(socketGidFromEnv('TBI_SOCKET_GID', {})).toBeUndefined();
    expect(socketGidFromEnv('TBI_SOCKET_GID', { TBI_SOCKET_GID: '' })).toBeUndefined();
    expect(socketGidFromEnv('TBI_SOCKET_GID', { TBI_SOCKET_GID: '998' })).toBe(998);
    expect(socketGidFromEnv('X', { X: '12' })).toBe(12);
    for (const bad of ['tbi-gate', '-1', '1.5', '99999999999', ' 5'])
      expect(() => socketGidFromEnv('TBI_SOCKET_GID', { TBI_SOCKET_GID: bad })).toThrow(/group id/);
  });
});
