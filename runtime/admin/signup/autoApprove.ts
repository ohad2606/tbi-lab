/**
 * BETA-G1: automatic approval of validated sign-ups (docs/plans/BETA-G1-AUTO-APPROVE.md). OFF by
 * default: nothing here runs unless the admin service is started with TBI_SIGNUP_AUTO_APPROVE=1
 * and a valid TBI_SIGNUP_AUTO_DAILY_CAP. With the flag absent the sign-up flow is unchanged
 * (no timer, no file written, no record field added).
 *
 * It runs in the ADMIN SERVICE (the only process with the account spool and the mail key), never
 * in the public intake, which keeps its create-only role. A periodic sweep approves pending
 * requests through the SAME `SignupApprover.approve` the owner's Approve button uses (same
 * account path, same idempotency, same quiet-hours mail queue, same audit log; the audit line is
 * marked `actor=auto`).
 *
 *   Daily cap      at most `dailyCap` requests are CLAIMED for auto-approval per Israel calendar
 *                  day (Asia/Jerusalem, DST-correct via Intl). The count lives in
 *                  `<store>/auto-approve.day.json` (0600, atomic write), so it survives a restart.
 *                  A slot is persisted BEFORE the record is touched (a crash can waste a slot,
 *                  never exceed the cap). Over the cap a request simply stays `pending` (the
 *                  "waitlist"): it is never lost, the owner may approve it by hand, and later
 *                  days' sweeps take it oldest first. An unreadable counter = cap reached (fail
 *                  closed, logged, never reset silently).
 *   Kill switch    while `<store>/auto-approve.paused` exists (any entry: file, dir, symlink, even
 *                  dangling; lstat, never followed) nothing is auto-approved; every check error
 *                  other than ENOENT counts as paused (fail closed). Checked before every claim,
 *                  so `touch` / `rm` takes effect without a restart.
 *   Who is eligible  `pending`, never claimed before (`autoApprovedAt` unset) and without an
 *                  error from an earlier approve attempt (`lastError` null: those need the owner).
 *                  A claimed request whose account step answered `account_pending` (status
 *                  `approved`, nothing sent yet) is retried by later sweeps without a new slot.
 *
 * Log lines carry counts, states and error classes only: never an id, name, address or path.
 * Single writer: only one admin service runs the sweep (the in-process mutex below, plus the
 * per-id lock shared with the owner's actions, locks.ts).
 */
import { lstat as lstatAsync, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { errorClass } from './errors.js';
import { serialById } from './locks.js';
import type { SignupApprover } from './service.js';
import type { PendingStore, SignupRecord } from './store.js';

export const AUTO_PAUSE_FILE = 'auto-approve.paused';
export const AUTO_COUNTER_FILE = 'auto-approve.day.json';
export const AUTO_CAP_MAX = 1000;
export const AUTO_APPROVE_INTERVAL_MS = 60_000;
export const AUTO_TZ = 'Asia/Jerusalem';

export type AutoApproveConfigResult =
  | { enabled: false; error?: false; reason: string }
  | { enabled: false; error: true; reason: string }
  | { enabled: true; dailyCap: number };

/**
 *   TBI_SIGNUP_AUTO_APPROVE     must be exactly `1` to enable (unset or empty: off, silently)
 *   TBI_SIGNUP_AUTO_DAILY_CAP   required when enabled: whole number 1..1000
 * Any other value is an error: auto-approve stays OFF (manual approval keeps working).
 */
export function autoApproveConfigFromEnv(env: NodeJS.ProcessEnv): AutoApproveConfigResult {
  const flag = env.TBI_SIGNUP_AUTO_APPROVE;
  if (flag === undefined || flag === '')
    return { enabled: false, reason: 'TBI_SIGNUP_AUTO_APPROVE is not set (feature off)' };
  const bad = (reason: string): AutoApproveConfigResult => ({
    enabled: false,
    error: true,
    reason,
  });
  if (flag !== '1') return bad('TBI_SIGNUP_AUTO_APPROVE must be 1 or unset');
  const cap = env.TBI_SIGNUP_AUTO_DAILY_CAP;
  if (cap === undefined || !/^\d{1,4}$/.test(cap) || Number(cap) < 1 || Number(cap) > AUTO_CAP_MAX)
    return bad(`TBI_SIGNUP_AUTO_DAILY_CAP must be a whole number from 1 to ${AUTO_CAP_MAX}`);
  return { enabled: true, dailyCap: Number(cap) };
}

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: AUTO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Israel calendar day of an instant, `YYYY-MM-DD`. */
export function israelDay(ms: number): string {
  const p: Record<string, string> = {};
  for (const x of dayFmt.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

const ERRNO_NAME = /^E[A-Z0-9]{1,15}$/;

/** One lstat of the pause path: any entry = paused; ENOENT = not; any other error = paused. */
export async function autoPauseCheck(
  path: string,
  stat: (p: string) => Promise<unknown> = lstatAsync,
): Promise<{ paused: boolean; error?: string }> {
  try {
    await stat(path);
    return { paused: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { paused: false };
    return {
      paused: true,
      error: typeof code === 'string' && ERRNO_NAME.test(code) ? code : 'unknown',
    };
  }
}

interface DayCounter {
  v: 1;
  day: string;
  count: number;
}

class CounterUnreadable extends Error {}

/** Per store directory: one sweep / claim at a time in this process. */
const mutexes = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  mutexes.set(key, tail);
  void tail.then(() => {
    if (mutexes.get(key) === tail) mutexes.delete(key);
  });
  return run;
}

export interface AutoApproverDeps {
  dir: string;
  store: PendingStore;
  dailyCap: number;
  /**
   * The approver for one sweep (built with the owner's principal as the spool actor, because the
   * root helper accepts account requests from the owner only), or null when the owner principal
   * is not recorded yet: then nothing is auto-approved (manual only, logged once).
   */
  approver: () => SignupApprover | null;
  now?: () => number;
  log?: (line: string) => void;
  /** Test hook: replaces lstat for the kill switch. */
  stat?: (p: string) => Promise<unknown>;
}

export interface SweepResult {
  /** Requests claimed (a slot of today's cap was used) in this sweep. */
  claimed: number;
  /** Approve calls made (claims plus retries of earlier claims). */
  attempted: number;
  /** Why the sweep stopped early, if it did. */
  stopped?: 'paused' | 'cap' | 'no_owner' | 'counter_unreadable' | 'busy';
}

export class AutoApprover {
  private lastPaused = false;
  private readonly seenErrors = new Set<string>();
  private capLoggedDay: string | null = null;
  private noOwnerLogged = false;

  constructor(private readonly d: AutoApproverDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private log(line: string): void {
    try {
      this.d.log?.(line);
    } catch {
      /* logging never changes the answer */
    }
  }

  private get counterPath(): string {
    return join(this.d.dir, AUTO_COUNTER_FILE);
  }

  /** Kill switch, with one log line per transition and per distinct error code. */
  async paused(): Promise<boolean> {
    const r = await autoPauseCheck(join(this.d.dir, AUTO_PAUSE_FILE), this.d.stat);
    if (r.error && !this.seenErrors.has(r.error) && this.seenErrors.size < 16) {
      this.seenErrors.add(r.error);
      this.log(`signup: auto-approve pause check failed (${r.error}); treated as paused`);
    }
    if (r.paused !== this.lastPaused) {
      this.lastPaused = r.paused;
      this.log(`signup: auto-approve ${r.paused ? 'paused' : 'resumed'}`);
    }
    return r.paused;
  }

  /** Today's count: 0 when the file is missing or from another day; throws when unreadable. */
  private async readCounter(day: string): Promise<number> {
    let text: string;
    try {
      text = await readFile(this.counterPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw new CounterUnreadable(errorClass(e));
    }
    let c: DayCounter;
    try {
      c = JSON.parse(text) as DayCounter;
    } catch {
      throw new CounterUnreadable('corrupt');
    }
    if (
      c?.v !== 1 ||
      typeof c.day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(c.day) ||
      !Number.isInteger(c.count) ||
      c.count < 0
    )
      throw new CounterUnreadable('corrupt');
    return c.day === day ? c.count : 0;
  }

  private async writeCounter(c: DayCounter): Promise<void> {
    const tmp = join(this.d.dir, `auto-approve.day.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      try {
        await fh.writeFile(`${JSON.stringify(c)}\n`, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.counterPath);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  /** Today's count as persisted (for tests and the design's operator check). */
  async todayCount(): Promise<number> {
    return this.readCounter(israelDay(this.now()));
  }

  /**
   * Claims one slot for `id` if it is still eligible and today's cap allows: the slot is
   * persisted first, then the record is marked (`autoApprovedAt`). Atomic with the owner's
   * actions (per-id lock) and with other claims (store mutex).
   */
  private claim(id: string): Promise<'claimed' | 'ineligible' | 'cap'> {
    return exclusive(this.d.dir, async () => {
      const day = israelDay(this.now());
      const count = await this.readCounter(day);
      if (count >= this.d.dailyCap) return 'cap';
      return serialById(id, async () => {
        const cur = await this.d.store.get(id).catch(() => null);
        if (!cur || !eligible(cur)) return 'ineligible' as const;
        await this.writeCounter({ v: 1, day, count: count + 1 });
        await this.d.store.update(id, { autoApprovedAt: new Date(this.now()).toISOString() });
        return 'claimed' as const;
      });
    });
  }

  private sweeping = false;

  /** One pass: retries of earlier claims, then new claims oldest first, until the cap. */
  async sweep(): Promise<SweepResult> {
    const out: SweepResult = { claimed: 0, attempted: 0 };
    if (this.sweeping) return { ...out, stopped: 'busy' };
    this.sweeping = true;
    try {
      if (await this.paused()) return { ...out, stopped: 'paused' };
      const approver = this.d.approver();
      if (!approver) {
        if (!this.noOwnerLogged) {
          this.noOwnerLogged = true;
          this.log('signup: auto-approve waiting (owner principal not recorded; manual only)');
        }
        return { ...out, stopped: 'no_owner' };
      }
      this.noOwnerLogged = false;
      const records = await this.d.store.list(); // oldest first
      // 1. Earlier claims whose account step did not finish (helper had not answered): no new slot.
      for (const r of records) {
        if (!(r.autoApprovedAt && r.status === 'approved' && !r.emailAttemptedAt)) continue;
        if (await this.paused()) return { ...out, stopped: 'paused' };
        out.attempted++;
        await approver.approve(r.id);
      }
      // 2. New claims.
      for (const r of records) {
        if (!eligible(r)) continue;
        if (await this.paused()) return { ...out, stopped: 'paused' };
        let c: 'claimed' | 'ineligible' | 'cap';
        try {
          c = await this.claim(r.id);
        } catch (e) {
          if (e instanceof CounterUnreadable) {
            this.log(
              `signup: auto-approve counter unreadable (${e.message}); treated as cap reached`,
            );
            return { ...out, stopped: 'counter_unreadable' };
          }
          throw e;
        }
        if (c === 'cap') {
          const day = israelDay(this.now());
          if (this.capLoggedDay !== day) {
            this.capLoggedDay = day;
            this.log(
              `signup: auto-approve daily cap reached (${this.d.dailyCap}); the rest stay pending`,
            );
          }
          return { ...out, stopped: 'cap' };
        }
        if (c !== 'claimed') continue;
        out.claimed++;
        out.attempted++;
        await approver.approve(r.id);
      }
      return out;
    } finally {
      this.sweeping = false;
    }
  }
}

function eligible(r: SignupRecord): boolean {
  return r.status === 'pending' && !r.autoApprovedAt && r.lastError === null;
}
