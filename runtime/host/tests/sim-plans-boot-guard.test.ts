/**
 * TBI-018 `runtime/host/main.ts` and the sim-plans flags.
 *   s3d-1 .. s3d-5: any TBI_HOST_SIM_* flag refused to start ("not wired").
 *   s3d-6: the flags are booted (runtime/host/simboot.ts). No flag = today's path, unchanged. A refusal
 *   (bad config, stray flag, torn journal) exits HOST_SIM_REFUSED_EXIT (78) with one line that carries no
 *   path or value, before the host listens; the units exclude 78 from their restart policy (no hot loop).
 *   A valid config boots: the previous process's open meter sessions are closed with 'host', the host
 *   listens, and SIGTERM releases the state lock.
 * The process gets a minimal environment and its own TMPDIR; no unit is stopped (TBI_HOST_RUNTIME_UNIT
 * unset), no QEMU starts (no session is created), the port is 0 on 127.0.0.1.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../plans/config.js';
import { HOST_SIM_FLAGS, HOST_SIM_REFUSED_EXIT } from '../../plans/hostflags.js';
import { SIM_JOURNAL_FILE, SIM_LOCK_FILE } from '../../plans/hostboot.js';
import { SimMeter, type SimEvent } from '../../plans/simminutes.js';
import { JournalStore } from '../../plans/store.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MAIN = join(ROOT, 'runtime', 'host', 'main.ts');
const VITE_NODE = join(ROOT, 'node_modules', '.bin', 'vite-node');
const LEASE = 600_000; // long, so a slow process start never lets the lease run out before recovery

const parent = mkdtempSync(join(tmpdir(), 'host-simboot-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

/** async children of this file; afterEach kills any still alive (also after a test timeout) */
const live = new Set<ChildProcess>();
afterEach(() => {
  for (const c of live) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  live.clear();
});

const keyFile = (name: string) => {
  const f = join(parent, name);
  if (!existsSync(f)) writeFileSync(f, randomBytes(32), { mode: 0o600 });
  return f;
};

/** the environment main.ts needs to get past its required settings (no flag, nothing deployed) */
const baseEnv = () => {
  const tmp = mkdtempSync(join(parent, 'tmp-'));
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: tmp,
    TBI_IDENTITY_KEY_FILE: keyFile('identity.key'),
    TBI_TICKET_KEY_FILE: keyFile('ticket.key'),
    TBI_HOST_BIND: '127.0.0.1',
    TBI_HOST_PORT: '0',
    TBI_HOST_LEASE_MS: String(LEASE),
  };
};

const simEnv = (cfg: unknown = { metering: { enabled: true }, sim: { leaseMs: LEASE } }) => {
  const d = mkdtempSync(join(parent, 'sim-'));
  const f = join(d, 'sim.json');
  writeFileSync(f, JSON.stringify(cfg));
  const state = join(d, 'state');
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  return {
    TBI_HOST_SIM_PLANS_CONFIG: f,
    TBI_HOST_SIM_PLANS_STATE: state,
    TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy',
  };
};

const runMain = (env: Record<string, string>) =>
  spawnSync(VITE_NODE, [MAIN], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
    killSignal: 'SIGKILL', // a hung host never outlives its test
    env,
  });

describe('Session Host main: sim-plans flags (s3d-6 boot)', () => {
  it("no flag: today's path (first required setting refuses, exit 1, no sim line)", () => {
    const r = runMain({
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TBI_IDENTITY_KEY_FILE is required');
    expect(r.stderr).not.toMatch(/sim/);
    expect(r.stdout).not.toMatch(/listening/);
  }, 100_000);

  it(`refusals exit ${HOST_SIM_REFUSED_EXIT} before listening; no path or value in the line`, () => {
    // (a) metering.enabled false, (b) a stray flag without the config, (c) a torn journal
    const off = simEnv({ metering: { enabled: false } });
    const torn = simEnv();
    writeFileSync(join(torn.TBI_HOST_SIM_PLANS_STATE, SIM_JOURNAL_FILE), '{"t":"sim_open"', {
      mode: 0o600,
    });
    const cases: [Record<string, string>, RegExp][] = [
      [off, /metering\.enabled is not true/],
      [{ [HOST_SIM_FLAGS[5]]: '/private/secret-value' }, /set without TBI_HOST_SIM_PLANS_CONFIG/],
      [torn, /sim plans state unusable; refusing to start/],
    ];
    for (const [extra, re] of cases) {
      const r = runMain({ ...baseEnv(), ...extra });
      expect(r.status).toBe(HOST_SIM_REFUSED_EXIT);
      expect(r.stderr).toMatch(re);
      expect(r.stderr).not.toContain('secret-value');
      for (const v of Object.values(extra)) expect(r.stderr).not.toContain(v);
      expect(r.stdout).not.toMatch(/listening/);
    }
    // the torn journal is left exactly as it was (never repaired at boot), the lock is released
    expect(readFileSync(join(torn.TBI_HOST_SIM_PLANS_STATE, SIM_JOURNAL_FILE), 'utf8')).toBe(
      '{"t":"sim_open"',
    );
    expect(existsSync(join(torn.TBI_HOST_SIM_PLANS_STATE, SIM_LOCK_FILE))).toBe(false);
  }, 300_000);

  it("valid config: recovers the previous process's open meter session ('host'), listens, SIGTERM releases the lock", async () => {
    const env = simEnv();
    const state = env.TBI_HOST_SIM_PLANS_STATE;
    const store = new JournalStore<SimEvent>(join(state, SIM_JOURNAL_FILE));
    const config = parseConfig({ metering: { enabled: true }, sim: { leaseMs: LEASE } });
    const prev = await SimMeter.open(store, { config, clock: { now: () => Date.now() } });
    expect((await prev.open('d'.repeat(32), 'p_previous0001', 'legacy')).ok).toBe(true);

    const child = spawn(VITE_NODE, [MAIN], { cwd: ROOT, env: { ...baseEnv(), ...env } });
    live.add(child);
    try {
      let out = '';
      let err = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.stderr.on('data', (b: Buffer) => (err += b.toString()));
      const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
      const deadline = Date.now() + 90_000;
      while (!/listening/.test(out) && Date.now() < deadline && child.exitCode === null)
        await new Promise((r) => setTimeout(r, 200));
      expect(out).toMatch(/listening/);
      expect(existsSync(join(state, SIM_LOCK_FILE))).toBe(true);
      const line = err.split('\n').find((l) => l.includes('sim_boot'));
      expect(JSON.parse(line ?? '{}')).toEqual({
        event: 'sim_boot',
        recovered: 1,
        compaction: 'no',
      });
      expect(err).not.toContain('p_previous0001');

      const events = (await store.load()).events;
      const close = events.find((e) => e.t === 'sim_close');
      expect(close).toMatchObject({ reason: 'host' });

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(existsSync(join(state, SIM_LOCK_FILE))).toBe(false);
    } finally {
      // a failed expectation must not leave a listening host behind
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 120_000);

  it("the refusal exit code is distinct from the host's other exits (0, 1)", () => {
    expect([0, 1]).not.toContain(HOST_SIM_REFUSED_EXIT);
  });

  it.each([
    'deploy/dev-lab/tbi-session-host.service',
    'deploy/dev-lab/s8/tbi-session-host.service.in',
  ])('%s does not restart on the refusal exit code (no hot loop)', (unit) => {
    const text = readFileSync(join(ROOT, unit), 'utf8');
    expect(text).toMatch(/^Restart=on-failure$/m);
    expect(text).toMatch(new RegExp(`^RestartPreventExitStatus=${HOST_SIM_REFUSED_EXIT}$`, 'm'));
  });
});
