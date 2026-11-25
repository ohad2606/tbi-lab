/**
 * K3: a bad TBI_HOST_IDLE_MS makes `runtime/host/main.ts` refuse to start with exit 78 (EX_CONFIG,
 * excluded from the units' restart policy) and one stderr line with no stack and no value, before any
 * side effect (no sim state lock, journal or recovery; nothing listens). Unset, 0 and valid values are
 * not refused. Same child hygiene as sim-plans-boot-guard.test.ts; no unit is stopped, no QEMU starts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HOST_SIM_REFUSED_EXIT } from '../../plans/hostflags.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MAIN = join(ROOT, 'runtime', 'host', 'main.ts');
const VITE_NODE = join(ROOT, 'node_modules', '.bin', 'vite-node');
const LINE =
  'tbi-session-host: TBI_HOST_IDLE_MS must be 0 (off) or at least 120000 ms (a safe integer); refusing to start';

const parent = mkdtempSync(join(tmpdir(), 'host-idleboot-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const live = new Set<ChildProcess>();
afterEach(() => {
  for (const c of live) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  live.clear();
});

const key = join(parent, 'key');
writeFileSync(key, randomBytes(32), { mode: 0o600 });

const baseEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  TMPDIR: mkdtempSync(join(parent, 'tmp-')),
  TBI_IDENTITY_KEY_FILE: key,
  TBI_HOST_BIND: '127.0.0.1',
  TBI_HOST_PORT: '0',
});

const runMain = (env: Record<string, string>) =>
  spawnSync(VITE_NODE, [MAIN], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    killSignal: 'SIGKILL', // a hung host never outlives its test
    env,
  });

describe('Session Host main: a bad TBI_HOST_IDLE_MS refuses to start (K3)', () => {
  it.each([
    ['below the floor', '119999'],
    ['above the safe integers', '99999999999999999999'],
  ])(
    '%s: exit 78, exactly one line, no side effect',
    (_name, value) => {
      // a valid sim config: a refusal after the sim boot would leave a journal or lock behind
      const dir = mkdtempSync(join(parent, 'sim-'));
      const cfg = join(dir, 'sim.json');
      writeFileSync(cfg, JSON.stringify({ metering: { enabled: true }, sim: { leaseMs: 30_000 } }));
      const state = join(dir, 'state');
      mkdirSync(state, { mode: 0o700 });
      chmodSync(state, 0o700);
      const r = runMain({
        ...baseEnv(),
        TBI_TICKET_KEY_FILE: key,
        TBI_HOST_SIM_PLANS_CONFIG: cfg,
        TBI_HOST_SIM_PLANS_STATE: state,
        TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy',
        TBI_HOST_IDLE_MS: value,
      });
      expect(r.status).toBe(HOST_SIM_REFUSED_EXIT);
      expect(r.stderr).toBe(`${LINE}\n`);
      expect(r.stdout).toBe('');
      expect(readdirSync(state)).toEqual([]);
    },
    100_000,
  );

  // Without TBI_TICKET_KEY_FILE the next check refuses (exit 1): reaching it proves the idle value
  // passed, without listening.
  it.each([undefined, '0', '120000', '5m'])(
    'TBI_HOST_IDLE_MS=%s is not refused by this check',
    (value) => {
      const r = runMain({
        ...baseEnv(),
        ...(value === undefined ? {} : { TBI_HOST_IDLE_MS: value }),
      });
      expect(r.stderr).toContain('TBI_TICKET_KEY_FILE is required');
      expect(r.stderr).not.toContain('TBI_HOST_IDLE_MS');
      expect(r.status).toBe(1);
    },
    100_000,
  );

  it('a valid idle limit boots: the host listens and SIGTERM exits 0', async () => {
    const child = spawn(VITE_NODE, [MAIN], {
      cwd: ROOT,
      env: { ...baseEnv(), TBI_TICKET_KEY_FILE: key, TBI_HOST_IDLE_MS: '300000' },
    });
    live.add(child);
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.resume();
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    const deadline = Date.now() + 90_000;
    while (!/listening/.test(out) && Date.now() < deadline && child.exitCode === null)
      await new Promise((r) => setTimeout(r, 200));
    expect(out).toMatch(/listening/);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 120_000);
});
