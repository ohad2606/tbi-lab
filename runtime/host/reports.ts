/**
 * In-app problem reports (Sprint 14): acceptance, durable storage, limits and retention in the
 * Session Host. The request contract is reportProtocol.ts; the operator guide is
 * docs/alpha/PROBLEM-REPORTS.md.
 *
 * - OFF unless TBI_REPORTS_DIR is set: without it the endpoint answers 503 and nothing is written.
 * - Identity comes from the gate only (the principal http.ts derived); the body cannot name one.
 * - A session id in the body is associated only when that session exists and belongs to the same
 *   principal, and its diagnostics are read from the host's own status. The answer is the same
 *   either way (no existence oracle).
 * - Durable before acknowledged: one JSON file per report (0600, in a 0700 directory), written to
 *   an exclusive temporary file, fsynced, renamed, and the directory fsynced, BEFORE 201. Any
 *   storage failure is 503 and leaves no file behind.
 * - After acceptance, ONE journald line (`problem_report`) for the operator's alerter, without the
 *   description. Logging can never turn an accepted report into a failure.
 * - Bounded: per-principal and global rates (429), a maximum stored count (503), a retention
 *   period enforced by housekeeping. The host holds no messaging credentials.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Principal } from '../identity/principal.js';
import type { RateRule } from '../policy/policy.js';
import { Refusal, admissionEvent } from '../policy/refusal.js';
import { runtimeIdentity } from './identity.js';
import type { SessionStatus } from './session.js';
import { browserOf, validateReport, type ProblemReportRequest } from './reportProtocol.js';

/** What the reports need from the host: the status of the principal's OWN session, or null. */
export interface ReportSessionLookup {
  statusFor(sessionId: string, principal: Principal): ReportSessionStatus | null;
}
export type ReportSessionStatus = Pick<
  SessionStatus,
  'state' | 'reason' | 'createdAt' | 'endedAt' | 'simNs' | 'runtime'
>;

export interface ReportsConfig {
  /** Absolute directory of the reports (created 0700 if missing). */
  dir: string;
  /** Reports older than this are deleted by housekeeping. */
  retentionMs: number;
  /** Stored reports beyond which new ones are refused (503). */
  maxReports: number;
  /** Per-principal windows; every one must have room. */
  perPrincipal: readonly RateRule[];
  /** All principals together. */
  global: RateRule;
  housekeepingMs: number;
}

const DAY_MS = 24 * 3600_000;
export const DEFAULT_REPORTS: Omit<ReportsConfig, 'dir'> = {
  retentionMs: 90 * DAY_MS,
  maxReports: 2000,
  perPrincipal: [
    { count: 5, windowMs: 10 * 60_000 },
    { count: 20, windowMs: DAY_MS },
  ],
  global: { count: 200, windowMs: 3600_000 },
  housekeepingMs: 6 * 3600_000,
};

/**
 * From the process environment:
 *   TBI_REPORTS_DIR              absolute directory; unset or empty: the feature is OFF (503)
 *   TBI_REPORTS_RETENTION_DAYS   default 90
 *   TBI_REPORTS_MAX              stored reports at most, default 2000
 * A set but invalid value stops the host at start (an operator error, seen at once).
 */
export function reportsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReportsConfig | null {
  const dir = env.TBI_REPORTS_DIR;
  if (!dir) return null;
  if (!isAbsolute(dir)) throw new Error('TBI_REPORTS_DIR must be an absolute path');
  const int = (name: string, min: number, max: number): number | undefined => {
    const v = env[name];
    if (v === undefined || v === '') return undefined;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max)
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return Number(v);
  };
  const days = int('TBI_REPORTS_RETENTION_DAYS', 1, 3650);
  const max = int('TBI_REPORTS_MAX', 1, 1_000_000);
  return {
    ...DEFAULT_REPORTS,
    dir,
    ...(days !== undefined ? { retentionMs: days * DAY_MS } : {}),
    ...(max !== undefined ? { maxReports: max } : {}),
  };
}

/** File-system steps tests replace to simulate a failing disk. */
export interface ReportIo {
  syncFile(fh: FileHandle): Promise<void>;
  syncDir(dir: string): Promise<void>;
}
const defaultIo: ReportIo = {
  syncFile: (fh) => fh.sync(),
  async syncDir(dir) {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
};

/** One journald line (stderr). Replaceable in tests; failures are always contained. */
export type LineWriter = (line: string) => void;
const stderrLine: LineWriter = (line) => void process.stderr.write(`${line}\n`);

export type ReportOutcome =
  | { status: 201; body: { id: string } }
  | { status: 400; body: { error: string } }
  | { refusal: Refusal };

// Crockford base32: no I, L, O, U (unambiguous when read aloud or retyped).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newReportId(): string {
  const bytes = randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Stored report files are named `<id>.json`; nothing else in the directory is a report. */
export const REPORT_FILE_RE = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\.json$/;
const TMP_RE = /^\.[0-9A-Z-]{14}\.tmp$/;

/**
 * In-memory sliding windows (check every window, then record in all: no partial consumption). A
 * request refused later for a reason that is not the requester's (global limit, full or failing
 * store) is refunded, so it never turns into a misleading per-user 429.
 */
class Windows {
  private readonly events = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  take(
    key: string,
    rules: readonly RateRule[],
  ): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const longest = Math.max(...rules.map((r) => r.windowMs));
    const list = (this.events.get(key) ?? []).filter((t) => t > now - longest);
    let wait = 0;
    for (const r of rules) {
      const inside = list.filter((t) => t > now - r.windowMs);
      if (inside.length >= r.count) wait = Math.max(wait, inside[0]! + r.windowMs - now);
    }
    if (wait > 0) {
      this.events.set(key, list);
      return { ok: false, retryAfterMs: Math.max(1000, wait) };
    }
    list.push(now);
    this.events.set(key, list);
    if (this.events.size > 100_000) this.events.clear(); // bounded memory under abuse
    return { ok: true };
  }

  /** Give back one taken event (a refusal that is not the requester's doing costs nothing). */
  refund(key: string): void {
    this.events.get(key)?.pop();
  }
}

export class ReportStore {
  private readonly windows: Windows;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = 0;

  constructor(
    readonly config: ReportsConfig,
    private readonly opts: { io?: ReportIo; log?: LineWriter; now?: () => number } = {},
  ) {
    this.windows = new Windows(opts.now ?? Date.now);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Housekeeping: a retention pass now, then periodically (never keeps the process alive). */
  start(): void {
    void this.purge().catch(() => undefined);
    this.timer = setInterval(
      () => void this.purge().catch(() => undefined),
      this.config.housekeepingMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Validate, limit, store durably, then announce one report. `body` is the parsed JSON (the
   * HTTP layer bounds its size); `principal` is the gate's.
   */
  async submit(
    body: unknown,
    principal: Principal,
    userAgent: string | undefined,
    sessions: ReportSessionLookup,
  ): Promise<ReportOutcome> {
    const v = validateReport(body);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    // Limits after validation (a malformed request costs nothing), before any disk access.
    const mine = this.windows.take(principal, this.config.perPrincipal);
    if (!mine.ok) return this.refuse(new Refusal('rate_limited', mine.retryAfterMs), principal);
    const all = this.windows.take('*', [this.config.global]);
    if (!all.ok) {
      this.windows.refund(principal);
      return this.refuse(new Refusal('rate_limited', all.retryAfterMs), principal);
    }
    // A store that is full or failing is the host's problem: the report is not counted.
    const unstored = (r: Refusal) => {
      this.windows.refund(principal);
      this.windows.refund('*');
      return this.refuse(r, principal);
    };

    const id = newReportId();
    const at = new Date(this.now()).toISOString();
    const record = buildRecord(id, at, principal, v.value, userAgent, sessions);
    this.pending++;
    try {
      if ((await this.count()) + this.pending > this.config.maxReports)
        return unstored(new Refusal('storage_pressure'));
      await this.write(id, `${JSON.stringify(record, null, 2)}\n`);
    } catch (e) {
      this.line(`problem report storage error: ${(e as NodeJS.ErrnoException)?.code ?? 'error'}`);
      return unstored(new Refusal('storage_pressure'));
    } finally {
      this.pending--;
    }
    safely(() => admissionEvent('runtime', 'report', 'admitted', principal));
    // The operator's alerter forwards this line (e.g. to Telegram). No description, no identity.
    this.line(
      JSON.stringify({
        event: 'problem_report',
        v: 1,
        id,
        category: record.category,
        blocking: record.blocking,
        release: record.release?.version ?? null,
        app: record.app?.version ?? null,
        at,
      }),
    );
    return { status: 201, body: { id } };
  }

  private refuse(r: Refusal, principal: Principal): ReportOutcome {
    safely(() => admissionEvent('runtime', 'report', r.code, principal));
    return { refusal: r };
  }

  private line(text: string): void {
    safely(() => (this.opts.log ?? stderrLine)(text));
  }

  /** The private directory, created 0700 (group and other access removed if it had any). */
  private async ensureDir(): Promise<string> {
    const dir = this.config.dir;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mode = (await stat(dir)).mode;
    if (mode & 0o077) await chmod(dir, mode & 0o700); // only ever tightened
    return dir;
  }

  private async count(): Promise<number> {
    const dir = await this.ensureDir();
    return (await readdir(dir)).filter((n) => REPORT_FILE_RE.test(n)).length;
  }

  /** tmp (O_CREAT|O_EXCL, 0600) -> write -> fsync -> rename -> fsync(dir). On failure: no file. */
  private async write(id: string, text: string): Promise<void> {
    const io = this.opts.io ?? defaultIo;
    const dir = await this.ensureDir();
    const tmp = join(dir, `.${id}.tmp`);
    const final = join(dir, `${id}.json`);
    let renamed = false;
    try {
      const fh = await open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(text, 'utf8');
        await io.syncFile(fh);
      } finally {
        await fh.close();
      }
      await rename(tmp, final);
      renamed = true;
      await io.syncDir(dir);
    } catch (e) {
      // Not acknowledged, so not kept: the tester will retry, and must not create a duplicate.
      await unlink(tmp).catch(() => undefined);
      if (renamed) await unlink(final).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Retention: delete reports received more than `retentionMs` ago, and temporary files left by
   * an interrupted write. Returns the number of reports deleted.
   */
  async purge(): Promise<number> {
    return purgeOlderThan(this.config.dir, this.now() - this.config.retentionMs);
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Logging is never a reason to fail an accepted report.
  }
}

export interface StoredReport {
  v: 1;
  id: string;
  receivedAt: string;
  /** The gate-derived opaque principal (no email); lets the operator honour a deletion request. */
  principal: Principal;
  category: ProblemReportRequest['category'];
  blocking: boolean;
  description: string;
  locale: string;
  view: ProblemReportRequest['view'];
  /** The Session Host's own build identity (null for an unstamped build). */
  release: { version: string; commit: string } | null;
  /** The app build the client says it runs (validated format; informational). */
  app: { version: string; commit: string } | null;
  browser: ReturnType<typeof browserOf>;
  /** The tester's own session, from the host's authoritative status; null when not associated. */
  session: {
    id: string;
    state: string;
    reason: string | null;
    outcome: string | null;
    ageS: number;
    endedAgoS: number | null;
    simS: number;
  } | null;
  /** What the app showed (client-reported, kept apart from the host's diagnostics). */
  appSim: ProblemReportRequest['sim'] | null;
}

function buildRecord(
  id: string,
  at: string,
  principal: Principal,
  r: ProblemReportRequest,
  userAgent: string | undefined,
  sessions: ReportSessionLookup,
): StoredReport {
  const now = Date.parse(at);
  const status = r.sessionId ? sessions.statusFor(r.sessionId, principal) : null;
  const seconds = (iso: string | null) =>
    iso === null ? null : Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return {
    v: 1,
    id,
    receivedAt: at,
    principal,
    category: r.category,
    blocking: r.blocking,
    description: r.description,
    locale: r.locale,
    view: r.view,
    release: runtimeIdentity(),
    app: r.app ?? null,
    browser: browserOf(userAgent),
    session:
      status && r.sessionId
        ? {
            id: r.sessionId,
            state: status.state,
            reason: status.reason,
            outcome: status.runtime.outcome,
            ageS: seconds(status.createdAt) ?? 0,
            endedAgoS: seconds(status.endedAt),
            simS: Number(BigInt(status.simNs) / 1_000_000n) / 1000,
          }
        : null,
    appSim: r.sim ?? null,
  };
}

/**
 * Delete reports received before `cutoffMs` (by their `receivedAt`; the file time if unreadable)
 * and temporary files older than an hour. Shared by housekeeping and tests; the operator CLI
 * (scripts/problem-reports.mjs) applies the same rule.
 */
export async function purgeOlderThan(dir: string, cutoffMs: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // nothing stored yet
  }
  let deleted = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (TMP_RE.test(name)) {
        // An interrupted write (crash between create and rename), by the real file time.
        if ((await stat(path)).mtimeMs < Date.now() - 3600_000) await unlink(path);
        continue;
      }
      if (!REPORT_FILE_RE.test(name)) continue;
      let received = NaN;
      try {
        received = Date.parse(
          (JSON.parse(await readFile(path, 'utf8')) as StoredReport).receivedAt,
        );
      } catch {
        // unreadable: fall back to the file time
      }
      if (!Number.isFinite(received)) received = (await stat(path)).mtimeMs;
      if (received < cutoffMs) {
        await unlink(path);
        deleted++;
      }
    } catch {
      // one bad entry never stops the pass
    }
  }
  return deleted;
}
