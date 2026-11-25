/**
 * K3: a bad TBI_HOST_IDLE_MS makes `runtime/host/main.ts` refuse to start with exit 78 (EX_CONFIG,
 * excluded from the units' restart policy) and one stderr line with no stack and no value, before any
 * side effect (no sim state lock, journal or recovery; nothing listens). Unset, 0 and valid values are
 * not refused. Same child hygiene as sim-plans-boot-guard.test.ts; no unit is stopped, no QEMU starts.
 * The order against the unit stop is checked in process, with `stopTemplateInstances` and every
 * systemctl child call replaced by recorders: real systemctl is never invoked.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_SIM_REFUSED_EXIT } from '../../plans/hostflags.js';

const systemd = vi.hoisted(() => ({ stops: [] as unknown[][], spawned: [] as string[] }));

vi.mock('../../builder/runner.js', async (original) => ({
  ...(await original<typeof import('../../builder/runner.js')>()),
  stopTemplateInstances: (...args: unknown[]) => void systemd.stops.push(args),
}));
// Second barrier: no systemctl child can be started from this test process by another path.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  const guard = <F>(fn: F): F =>
    ((command: string, ...rest: unknown[]) => {
      if (!String(command).includes('systemctl'))
        return (fn as (...a: unknown[]) => unknown)(command, ...rest);
      systemd.spawned.push(command);
      throw new Error('systemctl is blocked in this test');
    }) as F;
  return {
    ...real,
    spawn: guard(real.spawn),
    spawnSync: guard(real.spawnSync),
    exec: guard(real.exec),
    execSync: guard(real.execSync),
    execFile: guard(real.execFile),
    execFileSync: guard(real.execFileSync),
  };
});

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MAIN = join(ROOT, 'runtime', 'host', 'main.ts');
const VITE_NODE = join(ROOT, 'node_modules', '.bin', 'vite-node');
const LINE =
  'tbi-session-host: TBI_HOST_IDLE_MS must be 0 (off) or a whole number of ms, at least 120000 (a safe integer); refusing to start';

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
    ['not a whole number', '5m'],
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
  it.each([undefined, '', '0', '000', '120000'])(
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

describe('Session Host main: the idle refusal precedes the unit stop (K3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** Imports main.ts with a runtime unit set; the missing policy file stops it before any listen. */
  const bootInProcess = async (idle: string) => {
    systemd.stops.length = 0;
    systemd.spawned.length = 0;
    vi.resetModules();
    vi.stubEnv('TBI_IDENTITY_KEY_FILE', key);
    vi.stubEnv('TBI_TICKET_KEY_FILE', key);
    vi.stubEnv('TBI_HOST_RUNTIME_UNIT', 'tbi-test-never-a-unit');
    vi.stubEnv('TBI_POLICY_FILE', join(parent, 'no-such-policy.json'));
    vi.stubEnv('TBI_HOST_IDLE_MS', idle);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    const error: unknown = await import('../main.js').then(
      () => undefined,
      (e: unknown) => e,
    );
    return { error: String(error), stderr, exit };
  };

  it.each(['119999', '5m'])(
    'TBI_HOST_IDLE_MS=%s: refused with no stopTemplateInstances and no systemctl',
    async (idle) => {
      const r = await bootInProcess(idle);
      expect(r.exit).toHaveBeenCalledWith(HOST_SIM_REFUSED_EXIT);
      expect(r.stderr).toBe(`${LINE}\n`);
      expect(systemd.stops).toEqual([]);
      expect(systemd.spawned).toEqual([]);
    },
    60_000,
  );

  it('control: a valid idle limit reaches the (recorded) unit stop', async () => {
    const r = await bootInProcess('300000');
    expect(r.error).toContain('no-such-policy');
    expect(r.exit).not.toHaveBeenCalled();
    expect(systemd.stops).toEqual([['/usr/bin/systemctl', 'tbi-test-never-a-unit']]);
    expect(systemd.spawned).toEqual([]);
  }, 60_000);
});
