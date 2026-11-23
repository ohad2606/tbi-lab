/**
 * TBI-018 s3d-6: the operator's torn-tail repair tool for the Session Host sim journal (design
 * S3D-HOST-WIRING-DESIGN §7, M5/M6, decision O-7). NEVER called by the host: a torn or corrupt journal
 * makes the host refuse to start (exit 78), and only an operator runs this, with the host stopped.
 *
 *   repairTornTail(dir, { apply: false })   report only (the default of the CLI): nothing is written
 *   repairTornTail(dir, { apply: true })    torn tail only: copy the journal first to a timestamped
 *                                           `sim-journal.log.<UTC>.pre-repair` (never overwritten, never
 *                                           deleted), then drop the torn last record (JournalStore
 *                                           .recoverTornTail), then check that the result replays.
 *
 * Corruption in the middle (or a record that does not replay) is NEVER repaired: the outcome is
 * `corrupt` and the files are untouched; the operator path is rollback (unset TBI_HOST_SIM_PLANS_CONFIG)
 * and a manual investigation. The tool takes the host's state lock, so it refuses while a host runs
 * on the directory, and checks the directory like the host does (absolute, ours, 0700, no symlink).
 * Output: counts, byte offsets and the copy's file name only (never journal content or principals).
 *
 * The dropped record is a write the old host never completed (no newline on disk). It may have been an
 * open, a beat or a close. After the repair the next host boot treats the journal like any crash: an
 * open session is closed with 'host' and billed min(boot time, last JOURNALED beat + lease), i.e. at most
 * one lease past the last journaled beat (the documented s3c crash bound). That can be more or less than
 * the lost close record would have billed, never more than that bound.
 */
import { existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from './config.js';
import {
  acquireStateLock,
  checkStateDir,
  durableCopy,
  HostSimBootError,
  SIM_JOURNAL_FILE,
} from './hostboot.js';
import { SimMeter, type SimEvent } from './simminutes.js';
import { JournalStore } from './store.js';
import type { Clock } from './time.js';

export const PRE_REPAIR_SUFFIX = '.pre-repair';

export type RepairOutcome =
  /** no journal, or one without a problem: nothing to do */
  | { kind: 'clean'; events: number }
  /** a torn last record was found; dry run, nothing written */
  | { kind: 'torn'; events: number; validBytes: number; dropBytes: number }
  /** the torn record was dropped after the copy; the journal replays */
  | { kind: 'repaired'; events: number; validBytes: number; dropBytes: number; copy: string }
  /** corruption in the middle or a journal that does not replay: refused, nothing written */
  | { kind: 'corrupt' };

export interface RepairOptions {
  apply: boolean;
  clock?: Clock;
  /** effective uid the state directory must belong to; default process.getuid() */
  uid?: number;
  /** stale-lock liveness probe (tests) */
  alive?: (pid: number) => boolean;
}

export class RepairError extends Error {}

/** `sim-journal.log.<UTC time>.pre-repair` (no ':' or '.' in the time). */
export function preRepairName(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `${SIM_JOURNAL_FILE}.${stamp}${PRE_REPAIR_SUFFIX}`;
}

/** Events of the journal replay (metering off: replay only, no sweep, nothing written). */
async function replays(file: string): Promise<{ ok: boolean; events: number }> {
  const store = new JournalStore<SimEvent>(file);
  const loaded = await store.load();
  if (loaded.problem) return { ok: false, events: loaded.events.length };
  const m = await SimMeter.open(store, {
    config: parseConfig({ metering: { enabled: false } }),
    clock: { now: () => Date.now() },
  });
  return { ok: m.storeProblem === undefined, events: loaded.events.length };
}

export async function repairTornTail(dir: string, opts: RepairOptions): Promise<RepairOutcome> {
  // the directory must already exist: the tool never creates state
  let isDir = false;
  try {
    isDir = lstatSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new RepairError('state directory missing or not a directory');
  try {
    checkStateDir(dir, opts.uid ?? process.getuid?.());
  } catch (e) {
    throw new RepairError(e instanceof HostSimBootError ? e.message : 'state directory unusable');
  }
  let lock;
  try {
    lock = acquireStateLock(dir, opts.alive);
  } catch (e) {
    throw new RepairError(
      e instanceof HostSimBootError ? e.message : 'state lock unusable (is a host running?)',
    );
  }
  try {
    const file = join(dir, SIM_JOURNAL_FILE);
    if (!existsSync(file)) return { kind: 'clean', events: 0 };
    const store = new JournalStore<SimEvent>(file);
    const loaded = await store.load();
    const p = loaded.problem;
    if (!p) {
      const r = await replays(file);
      return r.ok ? { kind: 'clean', events: r.events } : { kind: 'corrupt' };
    }
    if (p.kind !== 'torn_tail') return { kind: 'corrupt' };
    // the valid prefix must replay on its own, or this is not "just a torn tail"
    const prefix = { ...loaded, problem: undefined };
    const check = await SimMeter.open(
      { append: async () => {}, load: async () => prefix },
      { config: parseConfig({ metering: { enabled: false } }), clock: { now: () => 0 } },
    );
    if (check.storeProblem) return { kind: 'corrupt' };
    const size = statSync(file).size;
    const base = {
      events: loaded.events.length,
      validBytes: p.validBytes,
      dropBytes: size - p.validBytes,
    };
    if (!opts.apply) return { kind: 'torn', ...base };
    const now = (opts.clock ?? { now: () => Date.now() }).now();
    const copy = preRepairName(now);
    try {
      durableCopy(file, join(dir, copy));
    } catch {
      throw new RepairError(
        'could not write the pre-repair copy (exists or no space); nothing changed',
      );
    }
    await store.recoverTornTail();
    const after = await replays(file);
    if (!after.ok)
      throw new RepairError('journal still does not replay after the repair; restore the copy');
    return { kind: 'repaired', ...base, copy };
  } finally {
    lock.release();
  }
}
