/**
 * BETA-G1 G1-AUTO-VERIFY slice 4a: the admin's one mail gate (every applicant mail: approval,
 * drain, owner resend, verify) and the S4a settings. OFF while every setting below is unset: no
 * gate is built, nothing is read or written, behaviour is today's.
 *
 *   TBI_SIGNUP_MAIL_MAX_PER_HOUR   mails per rolling hour         1..1000    (example: 30)
 *   TBI_SIGNUP_MAIL_MAX_PER_DAY    mails per Israel calendar day  1..10000   (example: 95)
 *   TBI_SIGNUP_MAIL_MAX_PER_30D    mails per rolling 30 days      1..300000  (example: 2700)
 *   TBI_SIGNUP_VERIFY_MAX_PER_DAY  verify mails per Israel day    1..1000    (example: 50; unset = 50)
 *   TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS  unverified web requests are purged this many days after
 *                                  `createdAt`, 1..90 (example: 7; unset = no such purge)
 *   TBI_SIGNUP_AUTO_CUTOFF_KEEP_S  S4b, owner decision open (DEC-38): 0..3600 seconds; unset or 0
 *                                  = every restart resets the auto-approve cut-off (autoApprove.ts)
 * The example values are proposals only (DEC-38 is open). The three mail caps are set together
 * (hour <= day <= 30d) and need TBI_SIGNUP_AUTO_STATE_DIR (admin-only, never the store dir). A bad
 * value refuses the sign-up admin wiring (one log line naming the variable, never the value).
 *
 * Gate state `<STATE_DIR>/mail-gate.json` (0600, tmp + fsync + rename + dir fsync): reservation
 * times (ms) of the last 30 days and a provider block time. Each send first RESERVES a slot that
 * is persisted before the provider call: a crash, a failed or a retried send counts again
 * (over-count, never under). Fail closed (= "cap reached", one class log line per hour): state dir
 * unsafe (autoStateDirCheck on every reservation), state missing after it existed
 * (`mail-gate.seen`), unreadable, invalid, an entry dated after now (clock stepped back). A
 * provider 429 blocks until the next hour (`http_429`) or the next Israel day (`http_429_quota`).
 * To recover from a fail-closed state the operator removes both files AND restarts the service (a
 * running process that has read the state stays closed); see the runbook.
 */
import { constants } from 'node:fs';
import { open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AUTO_PAUSE_FILE, autoPauseCheck, autoStateDirCheck, israelDay } from './autoApprove.js';
import type { EmailSender, VerifyMailTo } from './email.js';
import { errorClass } from './errors.js';

export interface MailLimits {
  perHour: number;
  perDay: number;
  per30d: number;
}

export interface Safeguards {
  mail?: MailLimits;
  verifyPerDay?: number;
  unverifiedDays?: number;
  /** S4b: TBI_SIGNUP_AUTO_CUTOFF_KEEP_S in ms; absent when unset or 0. */
  cutoffKeepMs?: number;
}

export const CUTOFF_KEEP_MAX_S = 3600;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WINDOW_30D_MS = 30 * DAY_MS;
export const GATE_FILE = 'mail-gate.json';
export const GATE_SEEN_FILE = 'mail-gate.seen';
// 300000 entries (the largest _PER_30D) of 13 digits and a comma are about 4.2 MB.
const GATE_MAX_BYTES = 8 * 1024 * 1024;

/** Parses the S4a settings; throws Error(fixed text naming the variable) on any bad value. */
export function safeguardsFromEnv(env: NodeJS.ProcessEnv): Safeguards {
  const num = (name: string, max: number): number | undefined => {
    const v = env[name];
    if (v === undefined || v === '') return undefined;
    if (!/^\d{1,7}$/.test(v) || Number(v) < 1 || Number(v) > max)
      throw new Error(`${name} must be a whole number from 1 to ${max}`);
    return Number(v);
  };
  const perHour = num('TBI_SIGNUP_MAIL_MAX_PER_HOUR', 1000);
  const perDay = num('TBI_SIGNUP_MAIL_MAX_PER_DAY', 10_000);
  const per30d = num('TBI_SIGNUP_MAIL_MAX_PER_30D', 300_000);
  const out: Safeguards = {};
  const set = [perHour, perDay, per30d].filter((x) => x !== undefined).length;
  if (set !== 0 && set !== 3)
    throw new Error('TBI_SIGNUP_MAIL_MAX_PER_HOUR, _PER_DAY and _PER_30D must be set together');
  if (set === 3) {
    if (perHour! > perDay! || perDay! > per30d!)
      throw new Error('TBI_SIGNUP_MAIL_MAX_PER_HOUR <= _PER_DAY <= _PER_30D is required');
    out.mail = { perHour: perHour!, perDay: perDay!, per30d: per30d! };
  }
  const verifyPerDay = num('TBI_SIGNUP_VERIFY_MAX_PER_DAY', 1000);
  if (verifyPerDay !== undefined) out.verifyPerDay = verifyPerDay;
  const unverifiedDays = num('TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS', 90);
  if (unverifiedDays !== undefined) out.unverifiedDays = unverifiedDays;
  const keep = env.TBI_SIGNUP_AUTO_CUTOFF_KEEP_S;
  if (keep !== undefined && keep !== '') {
    if (!/^\d{1,4}$/.test(keep) || Number(keep) > CUTOFF_KEEP_MAX_S)
      throw new Error(
        `TBI_SIGNUP_AUTO_CUTOFF_KEEP_S must be a whole number from 0 to ${CUTOFF_KEEP_MAX_S}`,
      );
    if (Number(keep) > 0) out.cutoffKeepMs = Number(keep) * 1000;
  }
  return out;
}

/** Refused before the provider call: nothing was sent; `retryAt` (ms) is the earliest new slot. */
export class MailCapError extends Error {
  readonly code = 'mail_cap';
  constructor(
    readonly retryAt: number,
    readonly reason: string,
  ) {
    super('mail_cap');
  }
}

/** A verify mail stopped by the kill switch after its slot was reserved (the slot stays counted). */
export class MailPausedError extends Error {
  readonly code = 'paused';
  constructor() {
    super('paused');
  }
}

interface GateState {
  v: 1;
  sent: number[];
  blockedUntil?: number;
}

class Closed extends Error {}

const validGate = (s: GateState | null): s is GateState =>
  !!s &&
  typeof s === 'object' &&
  s.v === 1 &&
  Array.isArray(s.sent) &&
  s.sent.every((x) => Number.isSafeInteger(x) && x > 0) &&
  (s.blockedUntil === undefined || (Number.isSafeInteger(s.blockedUntil) && s.blockedUntil > 0));

/** The first instant after `t` that belongs to the next Israel calendar day (DST-correct). */
export function nextIsraelDay(t: number): number {
  const day = israelDay(t);
  // Israel midnight is always on a whole UTC hour (+02:00 / +03:00).
  let x = Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS;
  while (israelDay(x) === day) x += HOUR_MS;
  return x;
}

/** Reservations of the Israel day of `t`. */
function sentToday(sent: number[], t: number): number {
  const day = israelDay(t);
  // Only the last 2 days can be today (the date formatting is slow over a full 30 d list).
  return sent.filter((x) => t - x < 2 * DAY_MS && israelDay(x) === day).length;
}

export interface MailGateDeps {
  stateDir: string;
  storeDir: string;
  limits: MailLimits;
  now?: () => number;
  log?: (line: string) => void;
  /** Test hook: replaces lstat for the kill switch. */
  stat?: (p: string) => Promise<unknown>;
}

export class MailGate {
  private chain: Promise<unknown> = Promise.resolve();
  private hadState = false;
  private readonly logged = new Map<string, number>();
  constructor(private readonly d: MailGateDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private logHourly(line: string): void {
    const t = this.now();
    const last = this.logged.get(line);
    if (last !== undefined && t >= last && t - last < HOUR_MS) return;
    if (this.logged.size >= 64) this.logged.clear();
    this.logged.set(line, t);
    try {
      this.d.log?.(line);
    } catch {
      /* logging never changes the answer */
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(t: number): Promise<GateState> {
    const bad = await autoStateDirCheck(this.d.stateDir);
    if (bad) throw new Closed('state_dir_unsafe');
    const [a, b] = await Promise.all([
      realpath(this.d.stateDir),
      realpath(this.d.storeDir).catch(() => ''),
    ]).catch(() => ['', '']);
    if (!a || a === b) throw new Closed('state_dir_unsafe');
    let s: GateState | null;
    let fh;
    try {
      fh = await open(
        join(this.d.stateDir, GATE_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Closed('unreadable');
    }
    if (fh) {
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > GATE_MAX_BYTES) throw new Closed('unreadable');
        s = JSON.parse(await fh.readFile('utf8')) as GateState;
      } catch {
        throw new Closed('unreadable');
      } finally {
        await fh.close();
      }
      if (!validGate(s)) throw new Closed('invalid');
    } else {
      const seen = await stat(join(this.d.stateDir, GATE_SEEN_FILE)).then(
        () => true,
        (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? false : null),
      );
      if (seen !== false || this.hadState) throw new Closed('missing');
      s = { v: 1, sent: [] };
    }
    if (fh) this.hadState = true;
    if (s.sent.some((x) => x > t)) throw new Closed('clock_back');
    return { ...s, sent: s.sent.filter((x) => t - x < WINDOW_30D_MS).sort((x, y) => x - y) };
  }

  private async write(s: GateState): Promise<void> {
    const dir = this.d.stateDir;
    await writeFile(join(dir, GATE_SEEN_FILE), '', { mode: 0o600, flag: 'a' });
    const tmp = join(dir, `${GATE_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      try {
        await fh.writeFile(`${JSON.stringify(s)}\n`, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, join(dir, GATE_FILE));
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    const dh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }

  /** null = a slot is free now; else the earliest time one may be (no write). */
  private judge(s: GateState, t: number): { retryAt: number; reason: string } | null {
    const { perHour, perDay, per30d } = this.d.limits;
    let retryAt = 0;
    let reason = '';
    const block = (at: number, why: string) => {
      if (at > retryAt) [retryAt, reason] = [at, why];
    };
    if (s.blockedUntil !== undefined && s.blockedUntil > t) block(s.blockedUntil, 'provider');
    const hour = s.sent.filter((x) => t - x < HOUR_MS);
    if (hour.length >= perHour) block(hour[hour.length - perHour]! + HOUR_MS, 'hour');
    if (sentToday(s.sent, t) >= perDay) block(nextIsraelDay(t), 'day');
    if (s.sent.length >= per30d) block(s.sent[s.sent.length - per30d]! + WINDOW_30D_MS, '30d');
    return retryAt > 0 ? { retryAt, reason } : null;
  }

  /** Read-only: null when a mail could be sent now, else the refusal (fail closed). */
  check(): Promise<MailCapError | null> {
    return this.serial(async () => {
      const t = this.now();
      try {
        const j = this.judge(await this.read(t), t);
        return j ? new MailCapError(j.retryAt, j.reason) : null;
      } catch (e) {
        return this.closed(e, t);
      }
    });
  }

  /** Read-only (summary file): mails counted today and in 30 days; null = state not trusted. */
  usage(): Promise<{ day: number; d30: number } | null> {
    return this.serial(async () => {
      const t = this.now();
      try {
        const s = await this.read(t);
        return { day: sentToday(s.sent, t), d30: s.sent.length };
      } catch {
        return null;
      }
    });
  }

  private closed(e: unknown, t: number): MailCapError {
    const why = e instanceof Closed ? e.message : errorClass(e);
    this.logHourly(`signup: mail cap reached (${why})`);
    return new MailCapError(t + HOUR_MS, why);
  }

  /** Reserves (persists) one slot or throws MailCapError. */
  reserve(): Promise<void> {
    return this.serial(async () => {
      const t = this.now();
      let s: GateState;
      try {
        s = await this.read(t);
      } catch (e) {
        throw this.closed(e, t);
      }
      const j = this.judge(s, t);
      if (j) {
        this.logHourly(`signup: mail cap reached (${j.reason})`);
        throw new MailCapError(j.retryAt, j.reason);
      }
      try {
        await this.write({ ...s, sent: [...s.sent, t] });
      } catch (e) {
        throw this.closed(e, t);
      }
    });
  }

  /** After a provider 429: no slot until the next hour / Israel day. */
  private limited(code: string): Promise<MailCapError> {
    return this.serial(async () => {
      const t = this.now();
      const until = code === 'http_429_quota' ? nextIsraelDay(t) : t + HOUR_MS;
      try {
        const s = await this.read(t);
        await this.write({ ...s, blockedUntil: Math.max(s.blockedUntil ?? 0, until) });
      } catch (e) {
        this.closed(e, t);
      }
      this.logHourly('signup: mail provider limited (http_429)');
      return new MailCapError(until, 'provider');
    });
  }

  private paused(): Promise<boolean> {
    return autoPauseCheck(join(this.d.stateDir, AUTO_PAUSE_FILE), this.d.stat).then(
      (r) => r.paused,
      () => true,
    );
  }

  private async deliver(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (e) {
      const c = errorClass(e);
      if (c === 'http_429' || c === 'http_429_quota') throw await this.limited(c);
      throw e;
    }
  }

  /** The one wrapper, built once around the real sender (admin-wiring.ts). */
  wrap(inner: EmailSender): EmailSender {
    const out: EmailSender = {
      sendApproval: async (to) => {
        await this.reserve();
        await this.deliver(() => inner.sendApproval(to));
      },
    };
    if (inner.sendVerify) {
      const sv = inner.sendVerify.bind(inner);
      out.sendVerify = async (to: VerifyMailTo) => {
        // Kill switch before the reservation and again right before the send.
        if (await this.paused()) throw new MailPausedError();
        await this.reserve();
        if (await this.paused()) throw new MailPausedError();
        await this.deliver(() => sv(to));
      };
    }
    return out;
  }
}

/** Reads a gate state's reservation count (tests, operator checks); null when absent. */
export async function gateCount(stateDir: string): Promise<number | null> {
  const text = await readFile(join(stateDir, GATE_FILE), 'utf8').catch(() => null);
  return text === null ? null : (JSON.parse(text) as GateState).sent.length;
}
