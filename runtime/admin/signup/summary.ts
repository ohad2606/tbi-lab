/**
 * BETA-G1 G1-AUTO-VERIFY slice 4b: the counts-only summary file `<STORE_DIR>/auto-summary.json`,
 * written by the admin (summaryAdmin.ts) and read by the intake (summaryNotify.ts). Numbers,
 * booleans and dates only: no id, name, address, path or free text. `null` = the admin could not
 * tell, or the feature is off (never a guessed 0).
 *
 * The file lives in the intake-owned store dir, so the READER treats it as hostile: a regular file
 * (no symlink, one link) of at most SUMMARY_MAX_BYTES with exactly this schema, fresh by the
 * reader's clock; anything else is ignored. It can only cause a message to the owner: nothing
 * approves or changes state from it, and the admin NEVER reads it back.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { israelDay } from './autoApprove.js';

export const SUMMARY_FILE = 'auto-summary.json';
export const SUMMARY_MAX_BYTES = 2048;
/** Older than this (the admin writes about once a minute) or further in the future = ignored. */
export const SUMMARY_STALE_MS = 10 * 60_000;
export const SUMMARY_SKEW_MS = 2 * 60_000;
const COUNT_MAX = 1_000_000;

export interface DayCounts {
  signups: number;
  verifyMails: number | null;
  verified: number | null;
  autoApproved: number;
}

export interface SummaryAlerts {
  autoCap: boolean;
  verifyCap: boolean;
  mailDay80: boolean;
  mail30d80: boolean;
  verifyKey: boolean;
}

export interface Summary {
  v: 1;
  /** Write time, `Date.toISOString()` form. */
  at: string;
  /** The Israel calendar day of `at`; `today` counts that day, `yesterday` the one before. */
  day: string;
  today: DayCounts;
  yesterday: DayCounts;
  /** Eligible requests held back by today's auto-approve cap. */
  waitingCap: number | null;
  mail: { dayUsed: number; dayLimit: number; d30Used: number; d30Limit: number } | null;
  paused: boolean;
  alerts: SummaryAlerts;
}

type Check = (x: unknown) => boolean;
const count: Check = (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= COUNT_MAX;
const limit: Check = (x) => count(x) && (x as number) >= 1;
const bool: Check = (x) => typeof x === 'boolean';
const orNull =
  (c: Check): Check =>
  (x) =>
    x === null || c(x);
/** A plain object with exactly the keys of `shape`, each passing its check. */
const exact =
  (shape: Record<string, Check>): Check =>
  (x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const keys = Object.keys(x);
    return (
      keys.length === Object.keys(shape).length &&
      keys.every((k) => Object.hasOwn(shape, k) && shape[k]!((x as Record<string, unknown>)[k]))
    );
  };
const dayCounts = exact({
  signups: count,
  verifyMails: orNull(count),
  verified: orNull(count),
  autoApproved: count,
});
const isoTime: Check = (x) =>
  typeof x === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(Date.parse(x)).toISOString() === x;
const schema = exact({
  v: (x) => x === 1,
  at: isoTime,
  day: (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x),
  today: dayCounts,
  yesterday: dayCounts,
  waitingCap: orNull(count),
  mail: orNull(exact({ dayUsed: count, dayLimit: limit, d30Used: count, d30Limit: limit })),
  paused: bool,
  alerts: exact({
    autoCap: bool,
    verifyCap: bool,
    mailDay80: bool,
    mail30d80: bool,
    verifyKey: bool,
  }),
});

/** Why a summary file is ignored (log classes). */
export type SummaryRefusal =
  'missing' | 'unreadable' | 'not_file' | 'too_large' | 'invalid' | 'stale' | 'future';

export function parseSummary(
  text: string,
  now: number,
): { summary: Summary } | { refused: SummaryRefusal } {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return { refused: 'invalid' };
  }
  if (!schema(x)) return { refused: 'invalid' };
  const s = x as Summary;
  const at = Date.parse(s.at);
  if (israelDay(at) !== s.day) return { refused: 'invalid' };
  if (now - at > SUMMARY_STALE_MS) return { refused: 'stale' };
  if (at - now > SUMMARY_SKEW_MS) return { refused: 'future' };
  return { summary: s };
}

/**
 * At most `max` bytes of a regular file with one link. Never throws, never follows a symlink,
 * never blocks on a FIFO.
 */
export async function readBounded(
  path: string,
  max: number,
): Promise<{ text: string } | { refused: 'missing' | 'unreadable' | 'not_file' | 'too_large' }> {
  let fh;
  try {
    if (!(await lstat(path)).isFile()) return { refused: 'not_file' };
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return {
      refused: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink > 1) return { refused: 'not_file' };
    if (st.size > max) return { refused: 'too_large' };
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r)
      r = (await fh.read(buf, n, buf.length - n, n)).bytesRead;
    if (n > max) return { refused: 'too_large' };
    return { text: buf.subarray(0, n).toString('utf8') };
  } catch {
    return { refused: 'unreadable' };
  } finally {
    await fh.close();
  }
}

/** The strict reader (intake). */
export async function readSummary(
  storeDir: string,
  now: number,
): Promise<{ summary: Summary } | { refused: SummaryRefusal }> {
  const r = await readBounded(join(storeDir, SUMMARY_FILE), SUMMARY_MAX_BYTES);
  return 'text' in r ? parseSummary(r.text, now) : r;
}

/**
 * Writes `value` as `<dir>/<name>`: a fresh temp file (O_EXCL, O_NOFOLLOW, 0600), fsync, rename.
 * The temp name ends in `.tmp`, so the store purge removes one orphaned by a crash.
 */
export async function replaceJson(dir: string, name: string, value: unknown): Promise<void> {
  const tmp = join(dir, `${name}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await fh.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, join(dir, name));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}
