/**
 * TBI-018 s3d-2 regression: `POST /sessions` awaits `SessionHost.admitCreate`. The routine CI
 * browser acceptance serves ESP32 sessions from the e2e fake Session Host
 * (app/e2e/fixtures/fake-session-host.ts), which is cast to `SessionHost` structurally; without
 * an `admitCreate` of its own every session create answered 500 ("host.admitCreate is not a
 * function") and ~30 ESP32 e2e specs failed at `creating-request`. This starts that fixture on
 * free ports and checks that session create reaches the fake host's create again: a malformed
 * body is the validation 400, an injected create failure is that status, never a 500.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });

let child: ChildProcess | null = null;
let base = '';

beforeAll(async () => {
  const [port, admin, reports, build] = [
    await freePort(),
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [join(ROOT, 'node_modules', '.bin', 'vite-node'), 'app/e2e/fixtures/fake-session-host.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_PORT: String(admin),
        REPORTS_PORT: String(reports),
        BUILD_PORT: String(build),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`fake session host did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, 70_000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const c = child;
  const exited = new Promise((r) => c.once('exit', r));
  c.kill('SIGTERM'); // the fixture removes its temporary stores on SIGTERM
  // never leave a stray process: SIGKILL if it has not exited after 10 s
  const t = setTimeout(() => c.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(t);
}, 20_000);

const createSession = (body: string) =>
  fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-user': 'e2e-user' },
    body,
  });

describe('s3d-2: the e2e fake Session Host serves POST /sessions through admitCreate', () => {
  it('a malformed create body is the validation 400, not an internal error', async () => {
    const r = await createSession('{}');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).not.toBe('internal error');
  });

  it('an injected create failure keeps its own status', async () => {
    expect((await fetch(`${base}/__test/fail-next-create?status=503`, { method: 'POST' })).ok).toBe(
      true,
    );
    const r = await createSession('{}');
    expect(r.status).toBe(503);
    // the injection is one-shot: the next create is validated again
    expect((await createSession('{}')).status).toBe(400);
  });
});
