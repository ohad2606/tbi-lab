/**
 * TBI-018 s3d-6: torn-tail repair tool (runtime/plans/repairjournal.ts, CLI repair-main.ts).
 * Copies first (never overwritten), drops only a torn LAST record, refuses corruption in the middle,
 * refuses while a host holds the state lock, writes nothing on a dry run, and is never used at boot.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { acquireStateLock, bootSimPlans, SIM_JOURNAL_FILE, SIM_LOCK_FILE } from '../hostboot.js';
import { preRepairName, PRE_REPAIR_SUFFIX, repairTornTail } from '../repairjournal.js';
import { SimMeter, type SimEvent } from '../simminutes.js';
import { JournalStore } from '../store.js';
import { FakeClock } from '../time.js';
import { ADV, NOON } from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const parent = mkdtempSync(join(tmpdir(), 'plans-repair-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const CFG = parseConfig({ metering: { enabled: true } });
const clock = new FakeClock(NOON);

/** a state dir whose journal holds one open and one closed session (3 events), then `tail` */
async function stateWith(tail: string) {
  const dir = join(mkdtempSync(join(parent, 's-')), 'state');
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, SIM_JOURNAL_FILE);
  const m = await SimMeter.open(new JournalStore<SimEvent>(file), { config: CFG, clock });
  await m.open('e'.repeat(32), ADV, 'advanced');
  await m.close('e'.repeat(32), 'ended', ADV);
  await m.open('f'.repeat(32), ADV, 'advanced');
  const valid = readFileSync(file, 'utf8');
  if (tail) appendFileSync(file, tail);
  return { dir, file, valid, original: readFileSync(file, 'utf8') };
}
const copies = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(PRE_REPAIR_SUFFIX));
const TORN = 'abcdef0123456789\t{"t":"sim_beat","sessionId":"ffff';

describe('repairTornTail', () => {
  it('clean journal: nothing to do, nothing written', async () => {
    const s = await stateWith('');
    expect(await repairTornTail(s.dir, { apply: true, clock })).toEqual({
      kind: 'clean',
      events: 3,
    });
    expect(readFileSync(s.file, 'utf8')).toBe(s.original);
    expect(copies(s.dir)).toEqual([]);
    expect(existsSync(join(s.dir, SIM_LOCK_FILE))).toBe(false);
  });

  it('torn tail, dry run: reported with byte counts, nothing written', async () => {
    const s = await stateWith(TORN);
    const r = await repairTornTail(s.dir, { apply: false, clock });
    expect(r).toEqual({
      kind: 'torn',
      events: 3,
      validBytes: Buffer.byteLength(s.valid),
      dropBytes: Buffer.byteLength(TORN),
    });
    expect(readFileSync(s.file, 'utf8')).toBe(s.original);
    expect(copies(s.dir)).toEqual([]);
  });

  it('torn tail, apply: copy first (byte-identical), drop only the torn record, host boots again', async () => {
    const s = await stateWith(TORN);
    // the host refuses this journal
    const env = () => {
      const f = join(mkdtempSync(join(parent, 'c-')), 'sim.json');
      writeFileSync(f, JSON.stringify({ metering: { enabled: true } }));
      return {
        TBI_HOST_SIM_PLANS_CONFIG: f,
        TBI_HOST_SIM_PLANS_STATE: s.dir,
        TBI_HOST_SIM_PLAN_MAP: 'preview=legacy',
      };
    };
    const host = { policyPlanNames: ['preview'], housekeepingMs: 250 };
    await expect(bootSimPlans(env(), CFG.sim.leaseMs, host, { clock })).rejects.toThrow(
      /state unusable/,
    );
    const r = await repairTornTail(s.dir, { apply: true, clock });
    expect(r).toEqual({
      kind: 'repaired',
      events: 3,
      validBytes: Buffer.byteLength(s.valid),
      dropBytes: Buffer.byteLength(TORN),
      copy: preRepairName(NOON),
    });
    expect(readFileSync(join(s.dir, preRepairName(NOON)), 'utf8')).toBe(s.original);
    expect(readFileSync(s.file, 'utf8')).toBe(s.valid);
    expect(existsSync(join(s.dir, SIM_LOCK_FILE))).toBe(false);
    // the host boots and recovers the open session with 'host'
    const b = await bootSimPlans(env(), CFG.sim.leaseMs, host, { clock });
    expect(b?.boot.recovered).toBe(1);
    b?.lock.release();
  });

  it('a second repair at the same time never overwrites the first copy (refuses, nothing changed)', async () => {
    const s = await stateWith(TORN);
    writeFileSync(join(s.dir, preRepairName(NOON)), 'older copy', { mode: 0o600 });
    await expect(repairTornTail(s.dir, { apply: true, clock })).rejects.toThrow(/pre-repair copy/);
    expect(readFileSync(join(s.dir, preRepairName(NOON)), 'utf8')).toBe('older copy');
    expect(readFileSync(s.file, 'utf8')).toBe(s.original);
  });

  it('corruption in the middle is never repaired (untouched, no copy)', async () => {
    const s = await stateWith('');
    const lines = s.original.split('\n');
    lines[1] = `0000000000000000${lines[1]!.slice(16)}`; // checksum of the middle record broken
    writeFileSync(s.file, lines.join('\n'));
    const before = readFileSync(s.file, 'utf8');
    expect(await repairTornTail(s.dir, { apply: true, clock })).toEqual({ kind: 'corrupt' });
    expect(readFileSync(s.file, 'utf8')).toBe(before);
    expect(copies(s.dir)).toEqual([]);
  });

  it('a valid prefix that does not replay (sequence gap) is corrupt, not torn', async () => {
    const s = await stateWith('');
    const lines = s.original.split('\n').filter(Boolean);
    writeFileSync(s.file, `${[lines[0], lines[2]].join('\n')}\n${TORN}`);
    const before = readFileSync(s.file, 'utf8');
    expect(await repairTornTail(s.dir, { apply: true, clock })).toEqual({ kind: 'corrupt' });
    expect(readFileSync(s.file, 'utf8')).toBe(before);
  });

  it('refuses while a host holds the state lock (lock left in place)', async () => {
    const s = await stateWith(TORN);
    const held = acquireStateLock(s.dir);
    try {
      await expect(repairTornTail(s.dir, { apply: true, clock })).rejects.toThrow(/locked/);
      expect(readFileSync(s.file, 'utf8')).toBe(s.original);
    } finally {
      held.release();
    }
  });

  it('refuses a missing directory (never creates state) and a wrong mode', async () => {
    const missing = join(parent, 'nope', 'state');
    await expect(repairTornTail(missing, { apply: true })).rejects.toThrow(/missing/);
    expect(existsSync(missing)).toBe(false);
    const s = await stateWith(TORN);
    chmodSync(s.dir, 0o755);
    await expect(repairTornTail(s.dir, { apply: true })).rejects.toThrow(/0700/);
    expect(readFileSync(s.file, 'utf8')).toBe(s.original);
  });
});

describe('repair is never part of the host boot', () => {
  it('no boot module imports the repair tool or calls recoverTornTail', () => {
    for (const f of [
      'runtime/plans/hostboot.ts',
      'runtime/host/simboot.ts',
      'runtime/host/main.ts',
    ]) {
      const src = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src).not.toMatch(/recoverTornTail|repairjournal|repair-main/);
    }
  });
});

describe('repair CLI exit codes', () => {
  const VITE_NODE = join(ROOT, 'node_modules', '.bin', 'vite-node');
  const CLI = join(ROOT, 'runtime', 'plans', 'repair-main.ts');
  const run = (...a: string[]) =>
    spawnSync(VITE_NODE, [CLI, '--', ...a], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    });
  it('report 2 -> apply 0 -> clean 0; usage 1; content never printed', async () => {
    const s = await stateWith(TORN);
    const dry = run(s.dir);
    expect(dry.status).toBe(2);
    expect(JSON.parse(dry.stdout)).toMatchObject({ kind: 'torn' });
    expect(readFileSync(s.file, 'utf8')).toBe(s.original);
    const fix = run(s.dir, '--apply');
    expect(fix.status).toBe(0);
    expect(JSON.parse(fix.stdout)).toMatchObject({ kind: 'repaired' });
    expect(fix.stdout + fix.stderr).not.toContain(ADV);
    expect(run(s.dir).status).toBe(0);
    expect(run().status).toBe(1);
  }, 200_000);
});
