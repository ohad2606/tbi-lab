/**
 * TBI-018 s3d-8: the OFFLINE sim-plans config validator (runtime/plans/validateconfig.ts, CLI
 * validate-main.ts, bundle `npm run simvalidate:build`). Pins: every problem class, several problems in
 * one run, nothing written (state dir byte- and metadata-identical), no value/path/content echoed, the
 * host refuses the same bad configs with the same first message (parity), and the bundle runs alone
 * from an empty directory with exit 0 / 1 / 78.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, hostTunablesFromEnv } from '../../host/config.js';
import { hostSimFromEnv } from '../../host/simboot.js';
import { Policy } from '../../policy/policy.js';
import { parseConfig } from '../config.js';
import {
  HostSimBootError,
  SIM_JOURNAL_FILE,
  SIM_LOCK_FILE,
  SIM_LOCK_TAKEOVER_FILE,
} from '../hostboot.js';
import { HOST_SIM_REFUSED_EXIT } from '../hostflags.js';
import { SimMeter, type SimEvent } from '../simminutes.js';
import { JournalStore } from '../store.js';
import { FakeClock } from '../time.js';
import { simBoundsProblems, validateSimConfig, type SimConfigReport } from '../validateconfig.js';
import { ADV, NOON } from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const SECRET = `S3CRET-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}`;
const ON = { metering: { enabled: true } };
const DEAD_PID = '999999999';
const dead = () => false;

const parent = mkdtempSync(join(tmpdir(), 'plans-validate-'));
afterAll(() => {
  chmodAll(parent);
  rmSync(parent, { recursive: true, force: true });
});
/** restores owner rwx below `p` so the cleanup can remove a 0500 fixture */
function chmodAll(p: string) {
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, e.name);
    if (e.isDirectory()) {
      chmodSync(q, 0o700);
      chmodAll(q);
    }
  }
}
const tmp = () => mkdtempSync(join(parent, 'd-'));
const cfgFile = (body: unknown) => {
  const f = join(tmp(), 'sim.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
};
/** an existing 0700 state directory (absolute, no symlink) */
const stateDir = (mode = 0o700) => {
  const d = join(tmp(), 'state');
  mkdirSync(d);
  chmodSync(d, mode);
  return d;
};
const env = (over: Record<string, string | undefined> = {}, cfg: unknown = ON) => {
  const e: Record<string, string | undefined> = {
    TBI_HOST_SIM_PLANS_CONFIG: cfgFile(cfg),
    TBI_HOST_SIM_PLANS_STATE: stateDir(),
    TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy',
    ...over,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
};
const validate = (e: Record<string, string | undefined>) =>
  validateSimConfig(e, { alive: (pid) => pid === process.pid });
const codes = (r: SimConfigReport) => r.problems.map((p) => p.code);

/** journal with 3 events (one session closed, one open), then `tail` */
async function withJournal(dir: string, tail = '') {
  const file = join(dir, SIM_JOURNAL_FILE);
  const m = await SimMeter.open(new JournalStore<SimEvent>(file), {
    config: parseConfig(ON),
    clock: new FakeClock(NOON),
  });
  await m.open('e'.repeat(32), ADV, 'advanced');
  await m.close('e'.repeat(32), 'ended', ADV);
  await m.open('f'.repeat(32), ADV, 'advanced');
  if (tail) appendFileSync(file, tail);
  return file;
}
const TORN = 'abcdef0123456789\t{"t":"sim_beat","sessionId":"ffff';
function corrupt(file: string) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines[1] = `0000000000000000${lines[1]!.slice(16)}`;
  writeFileSync(file, lines.join('\n'));
}

/** names, modes, sizes, mtimes and content hashes of everything under `dir` (or 'absent') */
function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  const out: string[] = [];
  const walk = (p: string) => {
    const st = lstatSync(p);
    const h = st.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : '';
    out.push(`${p} ${st.mode} ${st.size} ${st.mtimeMs} ${st.ctimeMs} ${h}`);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(dir);
  return out.join('\n');
}

describe('validateSimConfig', () => {
  it('no sim flag: off, nothing checked', async () => {
    const r = await validate({ TBI_HOST_LEASE_MS: '30000', TBI_POLICY_FILE: '/nowhere' });
    expect(r).toEqual({ status: 'off', problems: [], notes: [] });
  });

  it('a valid environment: ok, with source notes only', async () => {
    const e = env();
    await withJournal(e.TBI_HOST_SIM_PLANS_STATE!);
    const r = await validate(e);
    expect(r.problems).toEqual([]);
    expect(r.status).toBe('ok');
    expect(r.notes).toEqual([
      'host lease from the host default',
      'policy from the built-in default',
    ]);
  });

  it('a stale lock (dead pid) without a mutex is not a problem (the host takes it over)', async () => {
    const e = env();
    writeFileSync(join(e.TBI_HOST_SIM_PLANS_STATE!, SIM_LOCK_FILE), `${DEAD_PID}\n`);
    expect((await validateSimConfig(e, { alive: dead })).status).toBe('ok');
  });

  // one problem class per row: [name, env overrides, config, expected code]
  const leaseCfg = { ...ON, sim: { leaseMs: 20_000 } };
  it.each<[string, Record<string, string | undefined>, unknown, string]>([
    [
      'config file missing',
      { TBI_HOST_SIM_PLANS_CONFIG: '/nonexistent/sim.json' },
      ON,
      'config_missing',
    ],
    ['config not JSON', {}, '{"metering": {', 'config_unusable'],
    ['config unknown key', {}, { ...ON, extra: 1 }, 'config_unusable'],
    ['config strict-parse error', {}, { ...ON, sim: { leaseMs: -1 } }, 'config_unusable'],
    ['metering not enabled', {}, {}, 'metering_disabled'],
    ['sim.leaseMs != host lease', {}, leaseCfg, 'lease_mismatch'],
    [
      'liftUntilFirstPaid (O-11: boot must refuse)',
      {},
      { ...ON, queue: { freeCapMode: 'liftUntilFirstPaid' } },
      'lift_until_first_paid',
    ],
    [
      'maxConcurrentPerPrincipal > 1 with caps',
      {},
      { ...ON, sim: { maxConcurrentPerPrincipal: 2 } },
      'max_concurrent',
    ],
    [
      'plan map: unknown plan id',
      { TBI_HOST_SIM_PLAN_MAP: 'preview=gold,system=legacy' },
      ON,
      'plan_map_invalid',
    ],
    ['plan map: malformed', { TBI_HOST_SIM_PLAN_MAP: 'preview' }, ON, 'plan_map_invalid'],
    [
      'plan map: policy plan unmapped',
      { TBI_HOST_SIM_PLAN_MAP: 'preview=legacy' },
      ON,
      'plan_map_unmapped',
    ],
    [
      'plan map: names a plan the policy lacks',
      { TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy,gold=pro' },
      ON,
      'plan_map_unknown_policy_plan',
    ],
    ['beat >= lease', { TBI_HOST_SIM_BEAT_MS: '30000' }, ON, 'bound_beat'],
    ['beat 0', { TBI_HOST_SIM_BEAT_MS: '0' }, ON, 'bound_beat'],
    [
      'housekeeping below the host',
      { TBI_HOST_SIM_HOUSEKEEPING_MS: '100' },
      ON,
      'bound_housekeeping',
    ],
    ['poll >= vanishMs', { TBI_HOST_SIM_POLL_S: '30' }, ON, 'bound_poll'],
    ['flag not a whole number', { TBI_HOST_SIM_BEAT_MS: '1.5' }, ON, 'flag_not_integer'],
    ['partial: plan map missing', { TBI_HOST_SIM_PLAN_MAP: undefined }, ON, 'flags_partial'],
    ['partial: state dir missing', { TBI_HOST_SIM_PLANS_STATE: undefined }, ON, 'flags_partial'],
    ['partial: no config', { TBI_HOST_SIM_PLANS_CONFIG: undefined }, ON, 'flags_partial'],
    [
      'policy file unusable',
      { TBI_POLICY_FILE: '/nonexistent/policy.json' },
      ON,
      'policy_unusable',
    ],
    ['idle limit below the floor', { TBI_HOST_IDLE_MS: '60000' }, ON, 'idle_limit_invalid'],
    ['idle limit not a whole number', { TBI_HOST_IDLE_MS: '5m' }, ON, 'idle_limit_invalid'],
    ['state dir relative', { TBI_HOST_SIM_PLANS_STATE: 'rel/state' }, ON, 'state_dir_path'],
  ])('%s -> %s', async (_n, over, cfg, code) => {
    const r = await validate(env(over, cfg));
    expect(r.status).toBe('problems');
    expect(codes(r)).toContain(code);
  });

  it('state dir missing: reported, NOT created', async () => {
    const d = join(tmp(), 'state');
    const r = await validate(env({ TBI_HOST_SIM_PLANS_STATE: d }));
    expect(codes(r)).toEqual(['state_dir_missing']);
    expect(existsSync(d)).toBe(false);
  });

  it('state dir world-readable (0755) and group-writable (0770): mode', async () => {
    for (const mode of [0o755, 0o770]) {
      const r = await validate(env({ TBI_HOST_SIM_PLANS_STATE: stateDir(mode) }));
      expect(codes(r)).toEqual(['state_dir_mode']);
      expect(r.problems[0]!.detail).toMatch(/group\/world/);
    }
  });

  it('state dir not writable (0500): mode and not writable', async () => {
    if (process.getuid?.() === 0) return; // root may write anyway
    const r = await validate(env({ TBI_HOST_SIM_PLANS_STATE: stateDir(0o500) }));
    expect(codes(r)).toEqual(['state_dir_mode', 'state_dir_not_writable']);
  });

  it('state dir not a directory, not ours, symlinked parent', async () => {
    const f = join(tmp(), 'file');
    writeFileSync(f, '');
    expect(codes(await validate(env({ TBI_HOST_SIM_PLANS_STATE: f })))).toEqual([
      'state_dir_not_dir',
    ]);
    const e = env();
    expect(codes(await validateSimConfig(e, { uid: 12345, alive: dead }))).toEqual([
      'state_dir_owner',
    ]);
    const real = tmp();
    mkdirSync(join(real, 'state'), { mode: 0o700 });
    const link = join(tmp(), 'link');
    symlinkSync(real, link);
    expect(codes(await validate(env({ TBI_HOST_SIM_PLANS_STATE: join(link, 'state') })))).toEqual([
      'state_dir_symlink',
    ]);
  });

  it('lock: held by a live process, malformed, stale with a leftover takeover mutex', async () => {
    const held = env();
    writeFileSync(join(held.TBI_HOST_SIM_PLANS_STATE!, SIM_LOCK_FILE), `${process.pid}\n`);
    expect(codes(await validate(held))).toEqual(['state_locked']);
    const bad = env();
    writeFileSync(join(bad.TBI_HOST_SIM_PLANS_STATE!, SIM_LOCK_FILE), 'not-a-pid\n');
    expect(codes(await validate(bad))).toEqual(['state_lock']);
    const mutex = env();
    writeFileSync(join(mutex.TBI_HOST_SIM_PLANS_STATE!, SIM_LOCK_FILE), `${DEAD_PID}\n`);
    writeFileSync(join(mutex.TBI_HOST_SIM_PLANS_STATE!, SIM_LOCK_TAKEOVER_FILE), `${DEAD_PID}\n`);
    expect(codes(await validateSimConfig(mutex, { alive: dead }))).toEqual(['state_lock']);
  });

  it('journal torn / corrupt: reported only (file unchanged)', async () => {
    const t = env();
    const tf = await withJournal(t.TBI_HOST_SIM_PLANS_STATE!, TORN);
    const before = readFileSync(tf);
    const r = await validate(t);
    expect(codes(r)).toEqual(['journal_torn']);
    expect(r.problems[0]!.detail).toMatch(/sim-journal-repair/);
    expect(readFileSync(tf).equals(before)).toBe(true);
    const c = env();
    corrupt(await withJournal(c.TBI_HOST_SIM_PLANS_STATE!));
    expect(codes(await validate(c))).toEqual(['journal_corrupt']);
  });

  it('endWaitMs bound (no flag; checked with checkSimBounds like simboot)', () => {
    const host = { leaseMs: 30_000, housekeepingMs: 250 };
    expect(simBoundsProblems(host, { beatMs: 10_000, housekeepingMs: 5000 })).toEqual([]);
    expect(simBoundsProblems(host, { endWaitMs: 12_000 })).toEqual([]);
    expect(simBoundsProblems(host, { endWaitMs: 12_001 }).map((p) => p.code)).toEqual([
      'sim_bounds',
    ]);
  });

  it('reports every problem at once, in the host order', async () => {
    const e = env(
      {
        TBI_HOST_SIM_PLAN_MAP: 'preview=gold',
        TBI_HOST_SIM_BEAT_MS: '99999',
        TBI_HOST_SIM_POLL_S: '0',
        TBI_HOST_SIM_PLANS_STATE: stateDir(0o755),
      },
      { ...ON, queue: { freeCapMode: 'liftUntilFirstPaid' }, sim: { leaseMs: 20_000 } },
    );
    await withJournal(e.TBI_HOST_SIM_PLANS_STATE!, TORN);
    const r = await validate(e);
    expect(codes(r)).toEqual([
      'lease_mismatch',
      'lift_until_first_paid',
      'plan_map_invalid',
      'bound_beat',
      'bound_poll',
      'state_dir_mode',
      'journal_torn',
    ]);
  });

  it('writes nothing: the state dir is identical after ok, problem, lock and journal runs', async () => {
    const cases: Record<string, string | undefined>[] = [];
    const ok = env();
    await withJournal(ok.TBI_HOST_SIM_PLANS_STATE!);
    cases.push(ok);
    const torn = env({ TBI_HOST_SIM_BEAT_MS: '0' });
    await withJournal(torn.TBI_HOST_SIM_PLANS_STATE!, TORN);
    cases.push(torn);
    const stale = env();
    writeFileSync(join(stale.TBI_HOST_SIM_PLANS_STATE!, SIM_LOCK_FILE), `${DEAD_PID}\n`);
    cases.push(stale);
    cases.push(env({ TBI_HOST_SIM_PLANS_STATE: stateDir(0o755) }));
    for (const e of cases) {
      const dir = e.TBI_HOST_SIM_PLANS_STATE!;
      const cfgBefore = snapshot(e.TBI_HOST_SIM_PLANS_CONFIG!);
      const before = snapshot(dir);
      await validateSimConfig(e, { alive: dead });
      expect(snapshot(dir)).toBe(before);
      expect(snapshot(e.TBI_HOST_SIM_PLANS_CONFIG!)).toBe(cfgBefore);
    }
  });

  it('never echoes a value, a path or file content', async () => {
    const secretDir = join(tmp(), SECRET);
    mkdirSync(secretDir, { mode: 0o755 });
    const policy = join(tmp(), `${SECRET}.json`);
    writeFileSync(policy, `{"token": "${SECRET}"`);
    const runs = [
      env({}, { ...ON, apiKey: SECRET }),
      env({}, { ...ON, [SECRET]: 1 }),
      env({}, `{"metering": {"enabled": true}, "x": "${SECRET}"`),
      env({ TBI_HOST_SIM_PLAN_MAP: `preview=${SECRET}` }),
      env({ TBI_HOST_SIM_PLAN_MAP: `${SECRET}=legacy` }),
      env({ TBI_HOST_SIM_BEAT_MS: SECRET, TBI_HOST_LEASE_MS: SECRET }),
      env({ TBI_HOST_SIM_PLANS_STATE: secretDir, TBI_POLICY_FILE: policy }),
      env({ TBI_HOST_SIM_PLANS_CONFIG: join(tmp(), SECRET, 'x.json') }),
    ];
    for (const e of runs) {
      const r = await validate(e);
      expect(r.status).toBe('problems');
      const text = JSON.stringify(r);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(parent);
    }
  });
});

describe('parity: the host refuses the same bad configs (same first message)', () => {
  /** boots the real host path main.ts uses (hostSimFromEnv over main.ts's config) */
  async function hostBoot(e: Record<string, string | undefined>) {
    const config = defaultConfig({
      qemu: '',
      artifactsDir: '',
      ticketKey: Buffer.alloc(0),
      policy: Policy.fromEnv(e as NodeJS.ProcessEnv),
      ...hostTunablesFromEnv(e),
    });
    return hostSimFromEnv(e, config, { alive: (pid) => pid === process.pid });
  }

  const bad: [string, () => Promise<Record<string, string | undefined>>][] = [
    ['partial flags', async () => env({ TBI_HOST_SIM_PLANS_CONFIG: undefined })],
    ['config missing', async () => env({ TBI_HOST_SIM_PLANS_CONFIG: '/nonexistent/x.json' })],
    ['config not JSON', async () => env({}, '{')],
    ['metering off', async () => env({}, {})],
    ['lease mismatch', async () => env({ TBI_HOST_LEASE_MS: '20000' })],
    [
      'liftUntilFirstPaid',
      async () => env({}, { ...ON, queue: { freeCapMode: 'liftUntilFirstPaid' } }),
    ],
    [
      'plan map unknown plan',
      async () => env({ TBI_HOST_SIM_PLAN_MAP: 'preview=gold,system=legacy' }),
    ],
    ['plan map unmapped', async () => env({ TBI_HOST_SIM_PLAN_MAP: 'preview=legacy' })],
    ['beat >= lease', async () => env({ TBI_HOST_SIM_BEAT_MS: '30000' })],
    ['housekeeping below host', async () => env({ TBI_HOST_SIM_HOUSEKEEPING_MS: '1' })],
    ['poll too high', async () => env({ TBI_HOST_SIM_POLL_S: '30' })],
    ['state dir mode 0755', async () => env({ TBI_HOST_SIM_PLANS_STATE: stateDir(0o755) })],
    ['state dir relative', async () => env({ TBI_HOST_SIM_PLANS_STATE: 'rel/state' })],
    [
      'lock held by a live process',
      async () => {
        const e = env();
        writeFileSync(join(e.TBI_HOST_SIM_PLANS_STATE!, SIM_LOCK_FILE), `${process.pid}\n`);
        return e;
      },
    ],
    [
      'torn journal',
      async () => {
        const e = env();
        await withJournal(e.TBI_HOST_SIM_PLANS_STATE!, TORN);
        return e;
      },
    ],
    [
      'corrupt journal',
      async () => {
        const e = env();
        corrupt(await withJournal(e.TBI_HOST_SIM_PLANS_STATE!));
        return e;
      },
    ],
    [
      'several at once',
      async () =>
        env(
          { TBI_HOST_SIM_BEAT_MS: '0', TBI_HOST_SIM_PLAN_MAP: 'x=gold' },
          { ...ON, queue: { freeCapMode: 'liftUntilFirstPaid' } },
        ),
    ],
  ];

  it.each(bad)('%s', async (_n, make) => {
    const e = await make();
    const v = await validate(e); // first: read-only
    expect(v.status).toBe('problems');
    const p = hostBoot(e);
    await expect(p).rejects.toBeInstanceOf(HostSimBootError);
    await expect(p).rejects.toThrow(v.problems[0]!.message);
  });

  it('a config the validator accepts boots the host', async () => {
    const e = env();
    await withJournal(e.TBI_HOST_SIM_PLANS_STATE!);
    expect((await validate(e)).status).toBe('ok');
    const booted = await hostBoot(e);
    expect(booted).toBeDefined();
    booted!.lock.release();
  });

  it('no flag: validator off, host unmetered', async () => {
    expect((await validate({})).status).toBe('off');
    expect(await hostBoot({})).toBeUndefined();
  });
});

describe('validator CLI bundle (simvalidate:build)', () => {
  const ENTRY = 'runtime/plans/validate-main.ts';
  const OUTFILE = 'runtime/plans/dist/sim-config-validate.mjs';
  it('has the npm script, built like the repair and host bundles', () => {
    expect(PKG.scripts['simvalidate:build']).toBe(
      `esbuild ${ENTRY} --bundle --platform=node --format=esm --target=node22 --outfile=${OUTFILE} --log-level=warning`,
    );
  });

  let bundle = '';
  let work = '';
  beforeAll(() => {
    const build = mkdtempSync(join(parent, 'build-'));
    const args = PKG.scripts['simvalidate:build']!.split(' ')
      .slice(1)
      .map((a) => (a.startsWith('--outfile=') ? `--outfile=${join(build, 'x.mjs')}` : a));
    execFileSync(join(ROOT, 'node_modules', '.bin', 'esbuild'), args, {
      cwd: ROOT,
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    // alone in an empty directory: no node_modules and no sources to resolve against
    work = mkdtempSync(join(parent, 'host-'));
    bundle = join(work, 'sim-config-validate.mjs');
    copyFileSync(join(build, 'x.mjs'), bundle);
  }, 70_000);

  const run = (e: Record<string, string | undefined>, ...a: string[]) =>
    spawnSync(process.execPath, [bundle, ...a], {
      cwd: work,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work, ...e },
    });

  it('exit 0 on a valid environment, nothing written', async () => {
    const e = env();
    await withJournal(e.TBI_HOST_SIM_PLANS_STATE!);
    const before = snapshot(e.TBI_HOST_SIM_PLANS_STATE!);
    const r = run(e);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'ok', problems: [] });
    expect(snapshot(e.TBI_HOST_SIM_PLANS_STATE!)).toBe(before);
    expect(readdirSync(work)).toEqual(['sim-config-validate.mjs']);
  });

  it('exit 1 with every problem listed, nothing written, no secret echoed', async () => {
    const e = env(
      { TBI_HOST_SIM_PLAN_MAP: `preview=${SECRET}`, TBI_HOST_SIM_BEAT_MS: SECRET },
      { ...ON, queue: { freeCapMode: 'liftUntilFirstPaid' }, token: SECRET },
    );
    await withJournal(e.TBI_HOST_SIM_PLANS_STATE!, TORN);
    const before = snapshot(e.TBI_HOST_SIM_PLANS_STATE!);
    const r = run(e);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as SimConfigReport;
    expect(out.problems.map((p) => p.code)).toEqual([
      'config_unusable',
      'plan_map_invalid',
      'flag_not_integer',
      'journal_torn',
    ]);
    expect(r.stderr.trim().split('\n')).toHaveLength(4);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain(parent);
    expect(snapshot(e.TBI_HOST_SIM_PLANS_STATE!)).toBe(before);
  });

  it('exit 1 for liftUntilFirstPaid alone', () => {
    const r = run(env({}, { ...ON, queue: { freeCapMode: 'liftUntilFirstPaid' } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lift_until_first_paid/);
  });

  it(`exit ${HOST_SIM_REFUSED_EXIT} (refused): no sim flag set, or any argument`, () => {
    const none = run({});
    expect(none.status).toBe(HOST_SIM_REFUSED_EXIT);
    expect(none.stderr).toMatch(/nothing to validate/);
    const arg = run(env(), '--apply');
    expect(arg.status).toBe(HOST_SIM_REFUSED_EXIT);
    expect(arg.stdout).toBe('');
  });
});
