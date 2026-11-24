/**
 * K12 slice 1: server-side funnel counters. Indicative numbers only (how many sign-ups were
 * submitted / approved per day): never used for billing, limits, quotas or any decision about a
 * person.
 *
 * What is stored: `{day, event} -> integer`, nothing else. `day` is the UTC date (YYYY-MM-DD) of
 * the increment; `event` is one of the fixed allow-list below. No IP address, user agent,
 * referrer, URL, email address, name, cookie, request id or client id is ever accepted, stored
 * or logged: the only input of `increment` is the event name.
 *
 * Storage: ONE JSON file `<dir>/funnel-counters.json` (0600) in a private directory (0700, refused
 * when group/other have any access: the store does not start, it does not repair). Writes are
 * atomic (exclusive temp file 0600, fsync, rename) and serialised across processes sharing the
 * directory by an O_EXCL lock file; each write re-reads the file and adds this process's pending
 * deltas, so two writers do not lose each other's counts. Processes running as different users
 * (the intake and the admin service) each get their own directory (one file each).
 *
 * Bounds: at most `FUNNEL_DAY_CAP` per day per event (above it: silently not counted); days older
 * than `FUNNEL_KEEP_DAYS` are pruned on every write. A file that cannot be parsed is renamed aside
 * (`funnel-counters.json.corrupt-<ms>`, kept for the operator) and one log line says so; it is
 * never silently reset or overwritten.
 *
 * Failure: `increment` is synchronous, O(1), never throws and never waits for I/O. The write runs
 * later; a failing write (unwritable or full disk) keeps the deltas in memory (bounded by the cap
 * and the day window), retries on the next increment, and logs the error class only (throttled).
 * The caller's request (a sign-up) never fails because of the counters.
 *
 * Off unless TBI_FUNNEL_COUNTERS=1 (then TBI_FUNNEL_DIR, absolute, is required). There is no
 * HTTP endpoint for the counters; `snapshot()` is for the operator / a later owner view.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const FUNNEL_EVENTS = [
  'landing_view',
  'signup_form_view',
  'signup_submitted',
  'signup_approved',
  'first_session',
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

export const FUNNEL_FILE = 'funnel-counters.json';
export const FUNNEL_LOCK = 'funnel-counters.lock';
/** Per day per event: increments above this are not counted (bounds a flood). */
export const FUNNEL_DAY_CAP = 10_000;
/** Days kept (by UTC date, counted back from the newest write). */
export const FUNNEL_KEEP_DAYS = 400;
/** A lock file older than this is from a crashed writer and is removed. */
export const FUNNEL_LOCK_STALE_MS = 30_000;
/** Lock busy: retry the write after this long, at most `FUNNEL_LOCK_RETRIES` times in a row. */
export const FUNNEL_LOCK_RETRY_MS = 100;
export const FUNNEL_LOCK_RETRIES = 20;
/** At most one log line per error class per this interval. */
export const FUNNEL_LOG_EVERY_MS = 10 * 60_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export type FunnelDays = Record<string, Partial<Record<FunnelEvent, number>>>;
export interface FunnelSnapshot {
  v: 1;
  days: FunnelDays;
}

export class FunnelError extends Error {
  constructor(readonly code: 'unsafe_dir' | 'corrupt' | 'lock_busy') {
    super(code);
  }
}

/** What the sign-up hooks depend on (the counters, or nothing when off). */
export interface FunnelSink {
  /** Counts one event for today; false when not counted (unknown event, cap). Never throws. */
  increment(event: FunnelEvent): boolean;
}

export function isFunnelEvent(v: unknown): v is FunnelEvent {
  return typeof v === 'string' && (FUNNEL_EVENTS as readonly string[]).includes(v);
}

/** Error class for the log: our code, a node `E...` code, or `error`. Never a message or path. */
function errClass(e: unknown): string {
  if (e instanceof FunnelError) return e.code;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z]{2,15}$/.test(code) ? code : 'error';
}

/** Strict parse of the file; null when it is not exactly our format. */
export function parseFunnelFile(text: string, cap = FUNNEL_DAY_CAP): FunnelDays | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!obj(raw) || raw.v !== 1 || !obj(raw.days) || Object.keys(raw).length !== 2) return null;
  const days: FunnelDays = {};
  for (const [day, counts] of Object.entries(raw.days)) {
    if (!DAY_RE.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || !obj(counts))
      return null;
    const out: Partial<Record<FunnelEvent, number>> = {};
    for (const [ev, n] of Object.entries(counts)) {
      if (!isFunnelEvent(ev)) return null;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > cap) return null;
      out[ev] = n;
    }
    days[day] = out;
  }
  return days;
}

export interface FunnelIo {
  open: typeof open;
  rename: typeof rename;
}

export class FunnelCounters implements FunnelSink {
  /** Deltas not yet written: `${day} ${event}` -> count. */
  private pending = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastLog = new Map<string, number>();
  private ready = false;

  constructor(
    private readonly dir: string,
    private readonly opts: {
      now?: () => number;
      log?: (line: string) => void;
      cap?: number;
      keepDays?: number;
      io?: Partial<FunnelIo>;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private get cap(): number {
    return this.opts.cap ?? FUNNEL_DAY_CAP;
  }
  private get file(): string {
    return join(this.dir, FUNNEL_FILE);
  }

  /**
   * Creates the directory (0700) when missing; refuses (throws `unsafe_dir`) a directory that is
   * not a real directory, is not ours, or that group/other can access in any way.
   */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const s = await lstat(this.dir);
    const uid = process.getuid?.();
    if (!s.isDirectory() || (s.mode & 0o077) !== 0 || (uid !== undefined && s.uid !== uid))
      throw new FunnelError('unsafe_dir');
    this.ready = true;
  }

  private log(cls: string, what: string): void {
    const t = this.now();
    const key = `${what}:${cls}`;
    const last = this.lastLog.get(key);
    if (last !== undefined && t - last < FUNNEL_LOG_EVERY_MS) return;
    this.lastLog.set(key, t);
    try {
      this.opts.log?.(`funnel: ${what} (${cls})`);
    } catch {
      /* a broken logger never breaks the caller */
    }
  }

  increment(event: FunnelEvent): boolean {
    try {
      if (!isFunnelEvent(event)) {
        this.log('unknown_event', 'increment refused');
        return false;
      }
      if (!this.ready) return false;
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const key = `${day} ${event}`;
      const cur = this.pending.get(key) ?? 0;
      if (cur >= this.cap) return false;
      this.pending.set(key, cur + 1);
      this.schedule();
      return true;
    } catch (e) {
      this.log(errClass(e), 'increment failed');
      return false;
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.chain = this.chain
      .then(() => {
        this.scheduled = false;
        return this.writeOnce();
      })
      .catch((e: unknown) => this.log(errClass(e), 'write failed'));
  }

  /** Waits until the deltas known now have been written (or the attempt failed). Never throws. */
  async flush(): Promise<void> {
    if (this.pending.size > 0) this.schedule();
    await this.chain;
  }

  /** Stops a pending lock retry (shutdown, tests). */
  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private mergeBack(d: Map<string, number>): void {
    for (const [k, n] of d) this.pending.set(k, Math.min(this.cap, (this.pending.get(k) ?? 0) + n));
  }

  private oldestKeptDay(): string {
    const keep = this.opts.keepDays ?? FUNNEL_KEEP_DAYS;
    return new Date(this.now() - (keep - 1) * DAY_MS).toISOString().slice(0, 10);
  }

  private async writeOnce(): Promise<void> {
    if (this.pending.size === 0) return;
    const deltas = this.pending;
    this.pending = new Map();
    let locked = false;
    try {
      locked = await this.lock();
      if (!locked) throw new FunnelError('lock_busy');
      const days = await this.readForWrite();
      for (const [k, n] of deltas) {
        const [day, ev] = k.split(' ') as [string, FunnelEvent];
        const row = (days[day] ??= {});
        row[ev] = Math.min(this.cap, (row[ev] ?? 0) + n);
      }
      const oldest = this.oldestKeptDay();
      for (const day of Object.keys(days)) if (day < oldest) delete days[day];
      await this.writeAtomic({ v: 1, days: sortDays(days) });
      this.retries = 0;
    } catch (e) {
      // Deltas outside the kept window are dropped; the rest wait for the next attempt.
      const oldest = this.oldestKeptDay();
      for (const k of [...deltas.keys()]) if (k.slice(0, 10) < oldest) deltas.delete(k);
      this.mergeBack(deltas);
      if (
        e instanceof FunnelError &&
        e.code === 'lock_busy' &&
        this.retries < FUNNEL_LOCK_RETRIES
      ) {
        this.retries++;
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.schedule();
          }, FUNNEL_LOCK_RETRY_MS);
          this.retryTimer.unref?.();
        }
        return;
      }
      this.retries = 0;
      throw e;
    } finally {
      if (locked) await unlink(join(this.dir, FUNNEL_LOCK)).catch(() => undefined);
    }
  }

  /** O_EXCL lock file; a stale one (crashed writer) is removed once. False = busy. */
  private async lock(): Promise<boolean> {
    const p = join(this.dir, FUNNEL_LOCK);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await (this.opts.io?.open ?? open)(p, 'wx', 0o600);
        await fh.close();
        return true;
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e;
        const s = await stat(p).catch(() => null);
        if (s && this.now() - s.mtimeMs <= FUNNEL_LOCK_STALE_MS) return false;
        await unlink(p).catch(() => undefined);
      }
    }
    return false;
  }

  /** Under the lock: the current file; missing = empty; corrupt = renamed aside (logged), empty. */
  private async readForWrite(): Promise<FunnelDays> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return {};
      throw e;
    }
    const days = parseFunnelFile(text, this.cap);
    if (days) return days;
    const aside = `${this.file}.corrupt-${this.now()}`;
    await (this.opts.io?.rename ?? rename)(this.file, aside);
    this.log('corrupt', 'counters file unreadable, moved aside');
    return {};
  }

  private async writeAtomic(snap: FunnelSnapshot): Promise<void> {
    const tmp = join(this.dir, `${FUNNEL_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await (this.opts.io?.open ?? open)(tmp, 'wx', 0o600);
    try {
      try {
        await fh.chmod(0o600);
        await fh.writeFile(`${JSON.stringify(snap)}\n`, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await (this.opts.io?.rename ?? rename)(tmp, this.file);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  /**
   * The written counts (after writing what is pending). A missing file is empty; an unreadable
   * one throws `corrupt` (it is moved aside by the next write, not here).
   */
  async snapshot(): Promise<FunnelSnapshot> {
    await this.flush();
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return { v: 1, days: {} };
      throw e;
    }
    const days = parseFunnelFile(text, this.cap);
    if (!days) throw new FunnelError('corrupt');
    return { v: 1, days };
  }
}

function sortDays(days: FunnelDays): FunnelDays {
  const out: FunnelDays = {};
  for (const d of Object.keys(days).sort()) out[d] = days[d]!;
  return out;
}

/**
 * The counters for a process, from its environment: null unless TBI_FUNNEL_COUNTERS=1. Enabled
 * but misconfigured or with an unsafe directory: ONE log line (a fixed reason or class code,
 * never a path) and null, so the service runs without counters. Never throws.
 */
export async function funnelCountersFromEnv(
  env: NodeJS.ProcessEnv,
  io: { log: (line: string) => void; now?: () => number },
): Promise<FunnelCounters | null> {
  if (env.TBI_FUNNEL_COUNTERS !== '1') return null;
  const dir = env.TBI_FUNNEL_DIR;
  if (!dir || !dir.startsWith('/')) {
    io.log('funnel: counters off (config: TBI_FUNNEL_DIR must be an absolute path)');
    return null;
  }
  const c = new FunnelCounters(dir, { log: io.log, ...(io.now ? { now: io.now } : {}) });
  try {
    await c.init();
  } catch (e) {
    io.log(`funnel: counters off (${errClass(e)})`);
    return null;
  }
  io.log('funnel: counters on');
  return c;
}
