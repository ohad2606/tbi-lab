/**
 * TBI-018 s3d-1: bootSimPlans / parsePlanMap / state-dir lock (design S3D-HOST-WIRING-DESIGN §7, §9).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acquireStateLock,
  bootSimPlans,
  HostSimBootError,
  parsePlanMap,
  SIM_JOURNAL_FILE,
  SIM_LOCK_FILE,
  SIM_LOCK_TAKEOVER_FILE,
  type HostSimBootDeps,
  type HostSimBootHost,
  type HostSimPlans,
} from '../hostboot.js';
import { JournalStore } from '../store.js';
import { HOST_SIM_FLAGS, hostSimFlagsSet, hostSimStartRefusal } from '../hostflags.js';

const parent = mkdtempSync(join(tmpdir(), 'plans-hostboot-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const tmp = () => mkdtempSync(join(parent, 'd-'));
const cfgFile = (body: unknown) => {
  const f = join(tmp(), 'sim.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
};
const ON = { metering: { enabled: true } };
const HOST: HostSimBootHost = { policyPlanNames: ['preview', 'system'], housekeepingMs: 250 };
const LEASE = 30_000;
const env = (over: Record<string, string | undefined> = {}, cfg: unknown = ON) => ({
  TBI_HOST_SIM_PLANS_CONFIG: cfgFile(cfg),
  TBI_HOST_SIM_PLANS_STATE: join(tmp(), 'state'),
  TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy',
  ...over,
});
const booted: HostSimPlans[] = [];
afterAll(() => booted.forEach((b) => b.lock.release()));
const boot = async (
  e: Record<string, string | undefined>,
  lease = LEASE,
  host = HOST,
  deps: HostSimBootDeps = {},
) => {
  const b = await bootSimPlans(e, lease, host, deps);
  if (b) booted.push(b);
  return b;
};
/** refuses with HostSimBootError, creates no state dir, message matches `re` */
const refuses = async (
  e: Record<string, string | undefined>,
  re: RegExp,
  lease = LEASE,
  host = HOST,
) => {
  const p = bootSimPlans(e, lease, host);
  await expect(p).rejects.toBeInstanceOf(HostSimBootError);
  await expect(p).rejects.toThrow(re);
  if (e.TBI_HOST_SIM_PLANS_STATE) expect(existsSync(e.TBI_HOST_SIM_PLANS_STATE)).toBe(false);
};

describe('parsePlanMap', () => {
  it('parses pairs, tolerating spaces', () => {
    expect([...parsePlanMap(' preview = legacy , system=free')]).toEqual([
      ['preview', 'legacy'],
      ['system', 'free'],
    ]);
  });
  it.each([
    ['', /empty/],
    ['  ', /empty/],
    ['preview', /malformed pair/],
    ['preview=', /malformed pair/],
    ['=legacy', /malformed pair/],
    ['preview=legacy,', /malformed pair/],
    ['a=b=c', /malformed pair/],
    ['pre view=legacy', /malformed pair/],
    ['pre.view=legacy', /malformed policy plan name/],
    ['preview=gold', /unknown plan id/],
    ['preview=Legacy', /unknown plan id/],
    ['preview=legacy,preview=free', /duplicate/],
  ])('refuses %j', (raw, re) => {
    expect(() => parsePlanMap(raw)).toThrow(HostSimBootError);
    expect(() => parsePlanMap(raw)).toThrow(re);
  });
});

describe('hostSimStartRefusal (main.ts guard)', () => {
  it('no flag: null', () => {
    expect(hostSimStartRefusal({})).toBeNull();
    expect(hostSimStartRefusal({ TBI_PLANS_CONFIG: '/x', TBI_HOST_LEASE_MS: '1' })).toBeNull();
  });
  it.each(HOST_SIM_FLAGS)('%s alone (even empty) refuses, naming the flag, not its value', (f) => {
    const msg = hostSimStartRefusal({ [f]: '/secret/value-xyz' });
    expect(msg).toMatch(/refusing to start/);
    expect(msg).toContain(f);
    expect(msg).not.toContain('value-xyz');
    expect(hostSimStartRefusal({ [f]: '' })).not.toBeNull();
    expect(hostSimFlagsSet({ [f]: '' })).toEqual([f]);
  });
});

describe('bootSimPlans', () => {
  it('no flag: undefined, nothing read or created', async () => {
    expect(await bootSimPlans({}, LEASE, HOST)).toBeUndefined();
    expect(await bootSimPlans({}, LEASE, { policyPlanNames: undefined, housekeepingMs: 1 })).toBe(
      undefined,
    );
  });
  it.each(HOST_SIM_FLAGS.filter((f) => f !== 'TBI_HOST_SIM_PLANS_CONFIG'))(
    '%s without the config refuses',
    async (f) => {
      const d = join(tmp(), 'st');
      await refuses(
        { [f]: f === 'TBI_HOST_SIM_PLANS_STATE' ? d : '1' },
        /without TBI_HOST_SIM_PLANS_CONFIG/,
      );
      expect(existsSync(d)).toBe(false);
    },
  );
  it('valid: enabled adapter, defaults, 0700 state dir, lock file with our pid', async () => {
    const e = env();
    const b = (await boot(e))!;
    expect(b.adapter.enabled).toBe(true);
    expect(b.beatMs).toBe(10_000);
    expect(b.housekeepingMs).toBe(5000);
    expect(b.pollAfterS).toBe(15);
    expect([...b.planMap]).toEqual([
      ['preview', 'legacy'],
      ['system', 'legacy'],
    ]);
    const dir = e.TBI_HOST_SIM_PLANS_STATE;
    expect(readFileSync(join(dir, SIM_LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`);
    b.lock.release();
    expect(existsSync(join(dir, SIM_LOCK_FILE))).toBe(false);
    b.lock.release(); // idempotent
  });
  it('explicit intervals are taken', async () => {
    const b = (await boot(
      env({
        TBI_HOST_SIM_BEAT_MS: '29999',
        TBI_HOST_SIM_HOUSEKEEPING_MS: '250',
        TBI_HOST_SIM_POLL_S: '29',
      }),
    ))!;
    expect([b.beatMs, b.housekeepingMs, b.pollAfterS]).toEqual([29_999, 250, 29]);
  });

  describe('refusals (fail closed, no state created, no content in the message)', () => {
    it('unreadable / non-JSON / invalid config', async () => {
      await refuses(
        env({ TBI_HOST_SIM_PLANS_CONFIG: join(parent, 'nope.json') }),
        /config unusable/,
      );
      await refuses(env({}, '{nope'), /config unusable/);
      const p = bootSimPlans(env({}, { ...ON, secret_x: 1 }), LEASE, HOST);
      await expect(p).rejects.toThrow(/config unusable/);
      await expect(p).rejects.not.toThrow(/secret_x/);
    });
    it('config must be a regular file of at most 1 MiB (dir, FIFO, oversize refused)', async () => {
      await refuses(env({ TBI_HOST_SIM_PLANS_CONFIG: tmp() }), /config unusable/);
      const fifo = join(tmp(), 'fifo');
      execFileSync('mkfifo', [fifo]);
      // must refuse without blocking on the FIFO (no writer ever opens it)
      await refuses(env({ TBI_HOST_SIM_PLANS_CONFIG: fifo }), /config unusable/);
      const big = join(tmp(), 'big.json');
      writeFileSync(big, JSON.stringify(ON) + ' '.repeat(1024 * 1024));
      await refuses(env({ TBI_HOST_SIM_PLANS_CONFIG: big }), /config unusable/);
    });
    it('metering.enabled must be true', async () => {
      await refuses(env({}, {}), /metering.enabled/);
      await refuses(env({}, { metering: { enabled: false } }), /metering.enabled/);
    });
    it('sim.leaseMs must equal the host lease', async () => {
      await refuses(env(), /host lease/, 20_000);
      await refuses(env({}, { ...ON, sim: { leaseMs: 31_000 } }), /host lease/);
      await refuses(env(), /leaseMs invalid/, Number.NaN);
    });
    it('liftUntilFirstPaid is refused', async () => {
      await refuses(
        env({}, { ...ON, queue: { freeCapMode: 'liftUntilFirstPaid' } }),
        /freeCapMode/,
      );
    });
    it('maxConcurrentPerPrincipal must be 1 while minute caps apply', async () => {
      await refuses(env({}, { ...ON, sim: { maxConcurrentPerPrincipal: 2 } }), /maxConcurrent/);
      const daily = {
        ...ON,
        sim: {
          maxConcurrentPerPrincipal: 2,
          plans: {
            free: { monthlyMinutes: null },
            advanced: { monthlyMinutes: null },
            pro: { monthlyMinutes: null },
            legacy: { dailyMinutes: 30 },
          },
        },
      };
      await refuses(env({}, daily), /maxConcurrent/);
    });
    it('maxConcurrentPerPrincipal > 1 is allowed when no plan has a minute cap', async () => {
      const b = await boot(
        env(
          {},
          {
            ...ON,
            sim: {
              maxConcurrentPerPrincipal: 2,
              plans: {
                free: { monthlyMinutes: null },
                advanced: { monthlyMinutes: null },
                pro: { monthlyMinutes: null },
              },
            },
          },
        ),
      );
      expect(b?.adapter.enabled).toBe(true);
    });
    it('a host policy is required', async () => {
      await refuses(env(), /needs a host policy/, LEASE, {
        policyPlanNames: undefined,
        housekeepingMs: 250,
      });
      await refuses(env(), /needs a host policy/, LEASE, {
        policyPlanNames: [],
        housekeepingMs: 250,
      });
    });
    it('plan map: required, every policy plan mapped, no unknown names, value not echoed', async () => {
      await refuses(env({ TBI_HOST_SIM_PLAN_MAP: undefined }), /PLAN_MAP is required/);
      await refuses(env({ TBI_HOST_SIM_PLAN_MAP: 'preview=legacy' }), /not mapped/);
      await refuses(
        env({ TBI_HOST_SIM_PLAN_MAP: 'preview=legacy,system=legacy,gold=pro' }),
        /does not have/,
      );
      const p = bootSimPlans(env({ TBI_HOST_SIM_PLAN_MAP: 'preview=zzsecret' }), LEASE, HOST);
      await expect(p).rejects.toThrow(/unknown plan id/);
      await expect(p).rejects.not.toThrow(/zzsecret/);
    });
    it.each([
      ['TBI_HOST_SIM_BEAT_MS', '0'],
      ['TBI_HOST_SIM_BEAT_MS', '30000'],
      ['TBI_HOST_SIM_BEAT_MS', '-1'],
      ['TBI_HOST_SIM_BEAT_MS', '1.5'],
      ['TBI_HOST_SIM_BEAT_MS', ''],
      ['TBI_HOST_SIM_HOUSEKEEPING_MS', '249'],
      ['TBI_HOST_SIM_HOUSEKEEPING_MS', '0'],
      ['TBI_HOST_SIM_HOUSEKEEPING_MS', '5e3'],
      ['TBI_HOST_SIM_POLL_S', '0'],
      ['TBI_HOST_SIM_POLL_S', '30'],
      ['TBI_HOST_SIM_POLL_S', ' 15'],
    ])('%s=%j refuses', async (flag, v) => {
      await refuses(env({ [flag]: v }), new RegExp(flag));
    });
    it('poll interval is checked against the configured vanishMs', async () => {
      await refuses(
        env({ TBI_HOST_SIM_POLL_S: '15' }, { ...ON, queue: { vanishMs: 15_000 } }),
        /POLL_S/,
      );
    });
    it('state dir required', async () => {
      await refuses(env({ TBI_HOST_SIM_PLANS_STATE: undefined }), /STATE is required/);
      await refuses(env({ TBI_HOST_SIM_PLANS_STATE: '' }), /STATE is required/);
    });
  });

  describe('state directory (owner, mode, type)', () => {
    it('existing dir with mode other than 0700 refuses (mkdir does not fix it)', async () => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      chmodSync(d, 0o750);
      await expect(boot(env({ TBI_HOST_SIM_PLANS_STATE: d }))).rejects.toThrow(/mode must be 0700/);
      expect(existsSync(join(d, SIM_LOCK_FILE))).toBe(false);
    });
    it('dir not owned by the host user refuses', async () => {
      await expect(
        boot(env(), LEASE, HOST, { uid: (process.getuid?.() ?? 0) + 1 }),
      ).rejects.toThrow(/not owned/);
    });
    it('a file or a symlink in place of the dir refuses', async () => {
      const f = join(tmp(), 'file');
      writeFileSync(f, 'x');
      await expect(boot(env({ TBI_HOST_SIM_PLANS_STATE: f }))).rejects.toThrow(HostSimBootError);
      const real = join(tmp(), 'real');
      mkdirSync(real, { mode: 0o700 });
      const link = join(tmp(), 'link');
      symlinkSync(real, link);
      await expect(boot(env({ TBI_HOST_SIM_PLANS_STATE: link }))).rejects.toThrow(
        /not a directory/,
      );
    });
    it.each(['link/', 'link/.', 'real/', 'real/.', 'rel'])(
      'a non-normalised or relative state path %j refuses before anything is created',
      async (suffix) => {
        const base = tmp();
        const real = join(base, 'real');
        mkdirSync(real, { mode: 0o700 });
        symlinkSync(real, join(base, 'link'));
        const d = suffix === 'rel' ? 'relative-state' : `${base}/${suffix}`;
        await expect(boot(env({ TBI_HOST_SIM_PLANS_STATE: d }))).rejects.toThrow(
          /absolute normalised path/,
        );
        expect(existsSync(join(real, SIM_LOCK_FILE))).toBe(false);
        expect(existsSync('relative-state')).toBe(false);
      },
    );
    it('a state dir below a symlinked parent refuses', async () => {
      const real = join(tmp(), 'real');
      mkdirSync(join(real, 'st'), { recursive: true, mode: 0o700 });
      chmodSync(join(real, 'st'), 0o700);
      const link = join(tmp(), 'link');
      symlinkSync(real, link);
      await expect(boot(env({ TBI_HOST_SIM_PLANS_STATE: join(link, 'st') }))).rejects.toThrow(
        /symlinked parent/,
      );
      expect(existsSync(join(real, 'st', SIM_LOCK_FILE))).toBe(false);
    });
    it('a state path under a regular file refuses', async () => {
      const f = join(tmp(), 'file');
      writeFileSync(f, 'x');
      await expect(boot(env({ TBI_HOST_SIM_PLANS_STATE: join(f, 'sub') }))).rejects.toThrow(
        /STATE unusable/,
      );
    });
  });

  describe('exclusive lock', () => {
    it('two boots on the same dir: the second refuses; after release a new boot works', async () => {
      const e = env();
      const first = (await boot(e))!;
      await expect(bootSimPlans({ ...e }, LEASE, HOST)).rejects.toThrow(/locked by another host/);
      first.lock.release();
      const again = await boot({ ...e });
      expect(again?.adapter.enabled).toBe(true);
    });
    it('a lock held by a live other process refuses and is left in place', async () => {
      const e = env();
      const d = e.TBI_HOST_SIM_PLANS_STATE;
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_LOCK_FILE), '4242\n');
      await expect(boot(e, LEASE, HOST, { alive: () => true })).rejects.toThrow(/locked/);
      expect(readFileSync(join(d, SIM_LOCK_FILE), 'utf8')).toBe('4242\n');
    });
    it('a stale lock (pid provably gone) is taken over once', async () => {
      const e = env();
      const d = e.TBI_HOST_SIM_PLANS_STATE;
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_LOCK_FILE), '4242\n');
      const seen: number[] = [];
      const b = await boot(e, LEASE, HOST, {
        alive: (pid: number) => (seen.push(pid), false),
      });
      expect(seen).toEqual([4242]);
      expect(b?.adapter.enabled).toBe(true);
      expect(readFileSync(join(d, SIM_LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`);
    });
    it.each(['', 'abc', '0', '12 34', '-5'])('malformed lock content %j refuses', async (c) => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_LOCK_FILE), c);
      expect(() => acquireStateLock(d, () => false)).toThrow(/malformed/);
    });
    it('stale takeover race: a second taker that saw the same dead pid refuses after the first took over', () => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_LOCK_FILE), '4242\n');
      let first: ReturnType<typeof acquireStateLock> | undefined;
      // B has read the dead pid 4242; before B takes over, A runs its whole takeover
      expect(() =>
        acquireStateLock(d, () => false, {
          beforeTakeover: () => {
            first = acquireStateLock(d, () => false);
          },
        }),
      ).toThrow(/locked by another host/);
      expect(first).toBeDefined();
      expect(readFileSync(join(d, SIM_LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`);
      expect(existsSync(join(d, SIM_LOCK_TAKEOVER_FILE))).toBe(false);
      first!.release();
      expect(existsSync(join(d, SIM_LOCK_FILE))).toBe(false);
    });
    it('a takeover in progress (live mutex holder) refuses; mutex and lock left in place', () => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_LOCK_FILE), '4242\n');
      writeFileSync(join(d, SIM_LOCK_TAKEOVER_FILE), '5151\n');
      expect(() => acquireStateLock(d, (pid) => pid === 5151)).toThrow(/takeover in progress/);
      expect(readFileSync(join(d, SIM_LOCK_TAKEOVER_FILE), 'utf8')).toBe('5151\n');
      expect(readFileSync(join(d, SIM_LOCK_FILE), 'utf8')).toBe('4242\n');
    });
    it.each(['5151\n', 'junk'])(
      'a stale or malformed takeover mutex %j refuses with an operator message',
      (c) => {
        const d = join(tmp(), 'st');
        mkdirSync(d, { mode: 0o700 });
        writeFileSync(join(d, SIM_LOCK_FILE), '4242\n');
        writeFileSync(join(d, SIM_LOCK_TAKEOVER_FILE), c);
        expect(() => acquireStateLock(d, () => false)).toThrow(/remove .* by hand/);
        expect(readFileSync(join(d, SIM_LOCK_TAKEOVER_FILE), 'utf8')).toBe(c);
      },
    );
    it('an empty takeover mutex (holder between create and write) reads as in progress', () => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_LOCK_FILE), '4242\n');
      writeFileSync(join(d, SIM_LOCK_TAKEOVER_FILE), '');
      expect(() => acquireStateLock(d, () => false)).toThrow(/takeover in progress/);
    });
    it('a takeover mutex does not block a free lock', () => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_LOCK_TAKEOVER_FILE), '5151\n');
      const l = acquireStateLock(d, () => false);
      expect(readFileSync(join(d, SIM_LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`);
      // release under a foreign mutex: lock left (later a stale takeover), mutex untouched
      l.release();
      expect(existsSync(join(d, SIM_LOCK_FILE))).toBe(true);
      expect(readFileSync(join(d, SIM_LOCK_TAKEOVER_FILE), 'utf8')).toBe('5151\n');
    });
    it('release takes the mutex and leaves none behind', () => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      const l = acquireStateLock(d);
      l.release();
      expect(existsSync(join(d, SIM_LOCK_FILE))).toBe(false);
      expect(existsSync(join(d, SIM_LOCK_TAKEOVER_FILE))).toBe(false);
    });
    it('the journal file is created mode 0600 (independent of the umask)', async () => {
      const f = join(tmp(), SIM_JOURNAL_FILE);
      const old = process.umask(0o022);
      try {
        await new JournalStore<{ type: string }>(f).append([{ type: 'x' }]);
      } finally {
        process.umask(old);
      }
      expect(statSync(f).mode & 0o777).toBe(0o600);
    });
    it('release never removes a lock that is no longer ours', () => {
      const d = join(tmp(), 'st');
      mkdirSync(d, { mode: 0o700 });
      const l = acquireStateLock(d);
      writeFileSync(join(d, SIM_LOCK_FILE), '4242\n');
      l.release();
      expect(readFileSync(join(d, SIM_LOCK_FILE), 'utf8')).toBe('4242\n');
    });
    it('an unusable journal releases the lock again', async () => {
      const e = env();
      const d = e.TBI_HOST_SIM_PLANS_STATE;
      mkdirSync(join(d, SIM_JOURNAL_FILE), { recursive: true }); // a directory where the journal goes
      chmodSync(d, 0o700);
      await expect(boot(e)).rejects.toThrow(/state unusable/);
      expect(existsSync(join(d, SIM_LOCK_FILE))).toBe(false);
    });
    it.each([
      ['torn tail', '{"type":"sim_open"'],
      ['corrupt line', 'not json\n'],
    ])('a %s journal refuses, releases the lock and is left untouched', async (_n, body) => {
      const e = env();
      const d = e.TBI_HOST_SIM_PLANS_STATE;
      mkdirSync(d, { mode: 0o700 });
      writeFileSync(join(d, SIM_JOURNAL_FILE), body);
      await expect(boot(e)).rejects.toThrow(/state unusable/);
      expect(readFileSync(join(d, SIM_JOURNAL_FILE), 'utf8')).toBe(body);
      expect(existsSync(join(d, SIM_LOCK_FILE))).toBe(false);
    });
  });
});
