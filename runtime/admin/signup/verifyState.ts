/**
 * BETA-G1 G1-AUTO-VERIFY slice 1: the admin-only verify state and the verify sweep step. OFF unless
 * the admin service runs with TBI_SIGNUP_VERIFY=1 (verifyConfigFromEnv); unset = nothing here runs,
 * no key is read, no directory or file is created, no record changes.
 *
 *   State      `<STATE_DIR>/verify/` (STATE_DIR = TBI_SIGNUP_AUTO_STATE_DIR, required, never the
 *              store dir: the intake owns the store, so every record field, marker and file name
 *              there is hostile input). Both dirs pass autoStateDirCheck at every sweep. Files are
 *              0600, written tmp (O_EXCL) + fsync + rename + dir fsync; read with O_NOFOLLOW and a
 *              size bound. Per request `<id>.json`: generations (token hash, gen, stored expiry,
 *              sha256 of the normalised address, sent time), the send count, `usedAt`,
 *              `verifiedAt`, `verifiedAddr`. Shared `mail-counters.json`: verify mails per Israel day
 *              and per address hash (7-day window). `since.json`: the verify cut-off.
 *   Mint       only for `pending` requests with `origin: 'web'` created after the verify cut-off
 *              (TBI_SIGNUP_VERIFY_SINCE, else the first enable time: the backlog is never mailed)
 *              that have no generation yet. A further generation only through `mint(id, resend)`
 *              (the resend route, slice 2). Limits (req 9): 50 per day, 3 per address per 7 days and
 *              10 min apart, 5 per request, 3 live generations. An unreadable counter = limit
 *              reached. Counters and the generation are persisted (fsync) BEFORE the send, so a
 *              crash over-counts and never mails twice (idempotency `signup-verify-<id>-g<n>`).
 *   Pause      `<STATE_DIR>/auto-approve.paused` (lstat, any error = paused) stops minting and
 *              sending, checked before each mint and again right before each send.
 *   Consume    `<STORE_DIR>/<id>.vq-<16 hex>` markers (written by the intake, slice 2) only signal.
 *              At most VERIFY_MARKERS_PER_SWEEP per sweep; opened O_NOFOLLOW|O_NONBLOCK, fstat on
 *              the descriptor (regular, nlink 1, <= 1 KB); the suffix must be the token hash, the
 *              token id the file id, the MAC valid for `verify`; then under the per-id lock: record
 *              still `pending`, hash equals an unused generation (timing-safe), the STORED expiry
 *              not past by the admin clock, the address hash unchanged. `usedAt`/`verifiedAt` are
 *              persisted before the record mirror and before the marker is unlinked. One successful
 *              use makes every generation of that request unusable; earlier unexpired generations
 *              stay usable until then (at most 3 live).
 *   Binding    `verifiedFor(id, email)`: the verification counts only while the record's address
 *              hashes to the verified one, and only while both dirs pass the same checks as the
 *              sweep; checked by auto-approve in `eligible`, in the claim and right before the
 *              account request (autoApprove.ts).
 *   Approval   verified mode only (`bindApproval` / `checkApproval`, service.ts): after a successful
 *   mail       account request the admin stores `approvedAddr`, the hash of the address the account
 *              was added for; right before the approval mail the record's current address must
 *              hash to it (auto approvals also need the proof). No binding = no mail, except on an
 *              owner's own approve/resend, which binds the address the owner is looking at.
 * Logs carry class codes and counts only: never an id, token, hash, file name, address or name.
 */
import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { normalizeAddEmail } from '../accounts.js';
import { REQUEST_ID_RE } from '../common.js';
import { AUTO_PAUSE_FILE, autoPauseCheck, autoStateDirCheck, israelDay } from './autoApprove.js';
import type { EmailSender } from './email.js';
import { errorClass } from './errors.js';
import { serialById } from './locks.js';
import {
  RESEND_MARKER_RE,
  StoreError,
  VERIFY_MARKER_RE,
  type PendingStore,
  type SignupRecord,
} from './store.js';
import {
  checkVerifyToken,
  mintVerifyToken,
  parseSiteUrl,
  sameHash,
  tokenHash,
  verifyKeyId,
  verifyLink,
  type VerifyKeys,
} from './verify.js';
import { MailCapError, MailPausedError, type MailGate } from './mailGate.js';

export const VERIFY_DIR = 'verify';
export const VERIFY_MAX_PER_DAY = 50;
export const VERIFY_PER_ADDRESS = 3;
export const VERIFY_ADDRESS_WINDOW_MS = 7 * 86_400_000;
export const VERIFY_ADDRESS_GAP_MS = 10 * 60_000;
export const VERIFY_PER_RECORD = 5;
/** `.rq` after a failed send: the least wait before its one automatic retry. */
export const RESEND_RETRY_MS = 60 * 60_000;
export const VERIFY_LIVE_GENS = 3;
export const VERIFY_MARKERS_PER_SWEEP = 200;
export const VERIFY_MARKER_MAX_BYTES = 1024;
const STATE_MAX_BYTES = 256 * 1024;
/**
 * `mail-counters.json` holds one timestamp per verify mail of the 7-day window, which can touch 8
 * Israel calendar days. Worst case: TBI_SIGNUP_VERIFY_MAX_PER_DAY at its maximum (1000) on each
 * of those 8 days, every mail to a distinct address: 8000 entries of about 96 bytes
 * (`"<64 hex>":["<24-char ISO time>"],`), about 750 KiB. 2 MiB leaves room; larger = unreadable
 * (fail closed: limit reached), never reset.
 */
export const VERIFY_COUNTERS_MAX_BYTES = 2 * 1024 * 1024;
const COUNTERS = 'mail-counters.json';
const SINCE = 'since.json';
const HEX64 = /^[0-9a-f]{64}$/;

export interface VerifyConfig {
  keyFile: string;
  stateDir: string;
  siteUrl: string;
  since?: number;
}

export type VerifyConfigResult =
  | { enabled: false; error?: false; reason: string }
  | { enabled: false; error: true; reason: string }
  | { enabled: true; config: VerifyConfig };

const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const absNorm = (p: string) => p.startsWith('/') && !p.includes('\0') && !/\/\.{0,2}(\/|$)/.test(p);

/**
 *   TBI_SIGNUP_VERIFY            exactly `1` enables (unset/empty: off, silently)
 *   TBI_SIGNUP_VERIFY_KEY_FILE   required: the verify key (admin only, never the intake's secrets)
 *   TBI_SIGNUP_SITE_URL          required: https origin of the site (the link base)
 *   TBI_SIGNUP_AUTO_STATE_DIR    required: admin-only dir, not the store dir
 *   TBI_SIGNUP_VERIFY_SINCE      optional ISO time with zone: the verify cut-off
 * Refused (verification stays off, manual approval unchanged): any bad value, and
 * TBI_SIGNUP_AUTO_WEB=included (web requests would be approved without proof anyway). The admin
 * wiring refuses the whole sign-up admin for that combination and for AUTO_WEB=verified without
 * a working verification (admin-wiring.ts, BETA-G1 fix 3).
 */
export function verifyConfigFromEnv(env: NodeJS.ProcessEnv, storeDir: string): VerifyConfigResult {
  const flag = env.TBI_SIGNUP_VERIFY;
  if (flag === undefined || flag === '')
    return { enabled: false, reason: 'TBI_SIGNUP_VERIFY is not set (feature off)' };
  const bad = (reason: string): VerifyConfigResult => ({ enabled: false, error: true, reason });
  if (flag !== '1') return bad('TBI_SIGNUP_VERIFY must be 1 or unset');
  const keyFile = env.TBI_SIGNUP_VERIFY_KEY_FILE ?? '';
  if (!absNorm(keyFile)) return bad('TBI_SIGNUP_VERIFY_KEY_FILE must be an absolute path');
  if ([env.TBI_SIGNUP_HMAC_FILE, env.TBI_SIGNUP_RESEND_KEY_FILE].includes(keyFile))
    return bad('TBI_SIGNUP_VERIFY_KEY_FILE must be its own key file');
  const siteUrl = parseSiteUrl(env.TBI_SIGNUP_SITE_URL);
  if (!siteUrl) return bad('TBI_SIGNUP_SITE_URL must be an https origin');
  const stateDir = env.TBI_SIGNUP_AUTO_STATE_DIR ?? '';
  if (!absNorm(stateDir)) return bad('TBI_SIGNUP_AUTO_STATE_DIR is required for verification');
  if (stateDir.replace(/\/+$/, '') === storeDir.replace(/\/+$/, ''))
    return bad('TBI_SIGNUP_AUTO_STATE_DIR must not be the store dir');
  if (env.TBI_SIGNUP_AUTO_WEB === 'included')
    return bad('TBI_SIGNUP_VERIFY needs TBI_SIGNUP_AUTO_WEB verified or excluded');
  const out: VerifyConfig = { keyFile, stateDir, siteUrl };
  const since = env.TBI_SIGNUP_VERIFY_SINCE;
  if (since !== undefined && since !== '') {
    if (!ISO_ZONED.test(since) || !Number.isFinite(Date.parse(since)))
      return bad('TBI_SIGNUP_VERIFY_SINCE must be an ISO time with a zone');
    out.since = Date.parse(since);
  }
  return { enabled: true, config: out };
}

/** sha256 hex of the normalised address; null when it is no valid address (never mailed). */
export function addressHash(email: string): string | null {
  const n = normalizeAddEmail(email);
  return n ? createHash('sha256').update(n, 'utf8').digest('hex') : null;
}

interface Gen {
  gen: number;
  hash: string;
  exp: string;
  addr: string;
  sentAt: string;
  /** S5: written only after the send succeeded; absent = never shown as sent. */
  ok?: true;
  /** S4a: verifyKeyId of the key that minted it (absent on older state: never matches). */
  kid?: string;
}
interface IdState {
  v: 1;
  id: string;
  gens: Gen[];
  sends: number;
  usedAt?: string;
  verifiedAt?: string;
  verifiedAddr?: string;
  /** Verified mode: sha256 of the address an account was added for (approval mail binding). */
  approvedAddr?: string;
}
interface Counters {
  v: 1;
  day: string;
  dayCount: number;
  addrs: Record<string, string[]>;
}

const isTime = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
const isCount = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

function validId(s: IdState | null, id: string): s is IdState {
  if (!s || typeof s !== 'object' || s.v !== 1 || s.id !== id || !isCount(s.sends)) return false;
  if (!Array.isArray(s.gens) || s.gens.length > VERIFY_PER_RECORD) return false;
  for (const g of s.gens)
    if (!g || !isCount(g.gen) || !HEX64.test(g.hash) || !HEX64.test(g.addr)) return false;
    else if (!isTime(g.exp) || !isTime(g.sentAt)) return false;
    else if (g.ok !== undefined && g.ok !== true) return false;
    else if (g.kid !== undefined && !/^[0-9a-f]{16}$/.test(g.kid)) return false;
  if (s.usedAt !== undefined && !isTime(s.usedAt)) return false;
  if (s.verifiedAt !== undefined && !isTime(s.verifiedAt)) return false;
  if (s.approvedAddr !== undefined && !HEX64.test(s.approvedAddr)) return false;
  return s.verifiedAddr === undefined || HEX64.test(s.verifiedAddr);
}

function validCounters(c: Counters | null): c is Counters {
  if (!c || typeof c !== 'object' || c.v !== 1 || typeof c.day !== 'string') return false;
  if (!isCount(c.dayCount) || !c.addrs || typeof c.addrs !== 'object') return false;
  return Object.entries(c.addrs).every(
    ([h, l]) => HEX64.test(h) && Array.isArray(l) && l.length <= 64 && l.every(isTime),
  );
}

class Unreadable extends Error {}

/**
 * null = no such file. Throws Unreadable on anything but a small regular JSON file; with
 * `object`, also on a file that holds null or any other non-object.
 */
async function readJson<T>(
  path: string,
  object = false,
  maxBytes = STATE_MAX_BYTES,
): Promise<T | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Unreadable('state_unreadable');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) throw new Unreadable('state_unreadable');
    const v = JSON.parse(await fh.readFile('utf8')) as unknown;
    if (object && (v === null || typeof v !== 'object' || Array.isArray(v)))
      throw new Unreadable('state_unreadable');
    return v as T;
  } catch {
    throw new Unreadable('state_unreadable');
  } finally {
    await fh.close();
  }
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  const tmp = join(dir, `${name}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
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
  const d = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}

let countersChain: Promise<unknown> = Promise.resolve();
function countersLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = countersChain.then(fn, fn);
  countersChain = run.catch(() => undefined);
  return run;
}

/** S5 (owner view): what the admin state of one request says. Never leaves the server as is. */
export interface VerifyPeek {
  /** The newest generation whose send succeeded: mint time and the address hash it went to. */
  sent?: { at: string; addr: string };
  /** Set once the address was confirmed (with the hash it was confirmed for). */
  confirmed?: { at: number; addr: string };
}

/**
 * S5: both dirs pass the sweep's checks, WITHOUT creating anything (`checkDirs` creates
 * `verify/`). `stateBad` is the already known answer of autoStateDirCheck(stateDir).
 */
export async function verifyDirsReadOnly(
  stateDir: string,
  storeDir: string,
  stateBad: string | null,
): Promise<string | null> {
  if (stateBad) return stateBad;
  try {
    const [a, b] = await Promise.all([realpath(stateDir), realpath(storeDir)]);
    if (a === b) return 'store_dir';
  } catch (e) {
    return errorClass(e);
  }
  return autoStateDirCheck(join(stateDir, VERIFY_DIR));
}

/**
 * S5: one read of `verify/<id>.json` (O_NOFOLLOW, size bound), no lock, no write. No file = {}.
 * Throws on an invalid id and on anything unreadable, invalid or contradictory.
 */
export async function peekVerifyState(stateDir: string, id: string): Promise<VerifyPeek> {
  if (!REQUEST_ID_RE.test(id)) throw new Unreadable('state_unreadable');
  const s = await readJson<IdState>(join(stateDir, VERIFY_DIR, `${id}.json`), true);
  if (s === null) return {};
  if (!validId(s, id)) throw new Unreadable('state_unreadable');
  if (s.usedAt || s.verifiedAt || s.verifiedAddr) {
    if (!s.verifiedAt || !s.verifiedAddr) throw new Unreadable('state_unreadable');
    return { confirmed: { at: Date.parse(s.verifiedAt), addr: s.verifiedAddr } };
  }
  const sent = s.gens.filter((g) => g.ok === true).at(-1);
  return sent ? { sent: { at: sent.sentAt, addr: sent.addr } } : {};
}

/** S5: verify mails counted on Israel day `day`, read only; null = counters not trusted. */
export async function peekMailCount(stateDir: string, day: string): Promise<number | null> {
  const path = join(stateDir, VERIFY_DIR, COUNTERS);
  const c = await readJson<Counters>(path, true, VERIFY_COUNTERS_MAX_BYTES).catch(() => undefined);
  if (c === null) return 0;
  if (c === undefined || !validCounters(c) || c.day > day) return null;
  return c.day === day ? c.dayCount : 0;
}

export type MintOutcome =
  | 'sent'
  | 'send_failed'
  | 'paused'
  | 'skip'
  | 'not_pending'
  | 'before_cutoff'
  | 'bad_address'
  | 'state_unreadable'
  | 'limit_day'
  | 'limit_address'
  | 'limit_gap'
  | 'limit_record'
  | 'limit_live'
  | 'limit_mail'
  | 'limit_unreadable'
  | 'caps_missing';

export interface VerifySweepResult {
  sent: number;
  verified: number;
  rejected: number;
  stopped?: 'state_dir_unsafe' | 'key_unusable' | 'since_unreadable' | 'no_sender';
}

export interface VerifierDeps {
  stateDir: string;
  storeDir: string;
  store: PendingStore;
  email: EmailSender;
  siteUrl: string;
  keys: () => Promise<VerifyKeys>;
  since?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Test hook: replaces lstat for the kill switch. */
  stat?: (p: string) => Promise<unknown>;
  /** S4a: TBI_SIGNUP_VERIFY_MAX_PER_DAY (unset: VERIFY_MAX_PER_DAY). */
  maxPerDay?: number;
  /** S4a: the mail gate (read-only check before a generation is minted); unset = no gate. */
  gate?: MailGate | null;
  /**
   * S4a: verified mode without the mail caps: no verify mail is minted or sent (resend markers
   * wait) and nothing is purged as unverified; confirm markers are still consumed.
   */
  mailsHeld?: boolean;
  /** S4a: TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS; unset = no unverified purge. */
  unverifiedDays?: number;
  /** S4a: ids in the auto-approve claim set (null = unreadable: nothing is purged). */
  claimed?: () => Promise<Set<string> | null>;
}

export interface UnverifiedPurgeResult {
  purged: number;
  /** Of those: requests that never got a verify mail (e.g. a verify-cap backlog). */
  neverMailed: number;
  stopped?: string;
}

export type ApprovalMailCheck = 'ok' | 'addr_changed' | 'unbound' | 'unproven' | 'state_unsafe';

/** Options of one sweep: `stop` true = end after the current item (service shutdown). */
export interface VerifySweepOptions {
  stop?: () => boolean;
}

/** Timing-safe equality of two 16-hex hash prefixes (an empty confirm marker's name). */
function samePrefix(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 8 && y.length === 8 && timingSafeEqual(x, y);
}

export class Verifier {
  private readonly vdir: string;
  private readonly onceLogged = new Map<string, number>();
  constructor(private readonly d: VerifierDeps) {
    this.vdir = join(d.stateDir, VERIFY_DIR);
  }

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

  /** The same line at most once per hour (a persistent condition does not flood the log). */
  private logHourly(line: string): void {
    const t = this.now();
    const last = this.onceLogged.get(line);
    if (last !== undefined && t - last < 3_600_000 && t >= last) return;
    if (this.onceLogged.size >= 256) this.onceLogged.clear(); // bounded: class lines only
    this.onceLogged.set(line, t);
    this.log(line);
  }

  /**
   * S4b (summary file, read-only): verify mails counted on each Israel day of `days`, from the
   * shared counters (refunded slots are not counted). null = dirs unsafe or counters unreadable.
   */
  async mailCounts(days: string[]): Promise<number[] | null> {
    if ((await this.checkDirs().catch(() => 'error')) !== null) return null;
    let c: Counters | null;
    try {
      c = await readJson<Counters>(join(this.vdir, COUNTERS), false, VERIFY_COUNTERS_MAX_BYTES);
    } catch {
      return null;
    }
    if (c === null) return days.map(() => 0);
    if (!validCounters(c)) return null;
    const sent = Object.values(c.addrs)
      .flat()
      .map((x) => israelDay(Date.parse(x)));
    // The day counter is what the cap is judged on, so it is the answer for its own day.
    return days.map((d) => (d === c.day ? c.dayCount : sent.filter((x) => x === d).length));
  }

  /** Both dirs safe (creating `verify/` 0700 once): null, else a fixed reason. */
  async checkDirs(): Promise<string | null> {
    const bad = await autoStateDirCheck(this.d.stateDir);
    if (bad) return bad;
    try {
      const [a, b] = await Promise.all([realpath(this.d.stateDir), realpath(this.d.storeDir)]);
      if (a === b) return 'store_dir';
      await mkdir(this.vdir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    } catch (e) {
      return errorClass(e);
    }
    return autoStateDirCheck(this.vdir);
  }

  private async paused(): Promise<boolean> {
    return (await autoPauseCheck(join(this.d.stateDir, AUTO_PAUSE_FILE), this.d.stat)).paused;
  }

  private async readId(id: string): Promise<IdState | null> {
    const s = await readJson<IdState>(join(this.vdir, `${id}.json`));
    if (s !== null && !validId(s, id)) throw new Unreadable('state_unreadable');
    return s;
  }

  /** Removes the state of a deleted / purged request (PendingStore `onRemoved`). */
  async remove(id: string): Promise<void> {
    if (!REQUEST_ID_RE.test(id)) return;
    await unlink(join(this.vdir, `${id}.json`)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  /**
   * Whether `id` holds an admin-recorded verification for exactly this address, recorded after
   * `after` (ms). Any read error or mismatch = false; a changed address logs `addr_changed`.
   */
  async verifiedFor(id: string, email: string, after = -Infinity): Promise<boolean> {
    // The same dir checks as the sweep: an unsafe state dir or verify/ is never trusted.
    if ((await this.checkDirs().catch(() => 'error')) !== null) return false;
    let s: IdState | null;
    try {
      s = REQUEST_ID_RE.test(id) ? await this.readId(id) : null;
    } catch {
      return false;
    }
    if (!s?.verifiedAt || !s.verifiedAddr) return false;
    const h = addressHash(email);
    if (!h || !sameHash(h, s.verifiedAddr)) {
      this.logHourly('signup: verify rejected (addr_changed)');
      return false;
    }
    return Date.parse(s.verifiedAt) > after;
  }

  /**
   * Verified mode, after a successful account request (the caller holds the per-id lock):
   * records the hash of the address the account was added for. Throws on any failure.
   */
  async bindApproval(id: string, email: string): Promise<void> {
    const addr = addressHash(email);
    if (!REQUEST_ID_RE.test(id) || !addr) throw new Error('bad_address');
    const bad = await this.checkDirs();
    if (bad) throw new Error('state_unsafe');
    const s = await this.readId(id);
    await writeJson(this.vdir, `${id}.json`, {
      ...(s ?? { v: 1, id, gens: [], sends: 0 }),
      approvedAddr: addr,
    } satisfies IdState);
  }

  /**
   * Verified mode, right before the approval mail (caller holds the per-id lock): `ok` only when
   * `email` hashes to the bound address and, with `needProof` (auto approvals), also carries the
   * recorded confirmation. Any read error = `unbound`; an unsafe dir = `state_unsafe`.
   */
  async checkApproval(id: string, email: string, needProof: boolean): Promise<ApprovalMailCheck> {
    if ((await this.checkDirs().catch(() => 'error')) !== null) return 'state_unsafe';
    let s: IdState | null;
    try {
      s = REQUEST_ID_RE.test(id) ? await this.readId(id) : null;
    } catch {
      return 'unbound';
    }
    if (!s?.approvedAddr) return 'unbound';
    const h = addressHash(email);
    if (!h || !sameHash(h, s.approvedAddr)) return 'addr_changed';
    if (needProof && !(await this.verifiedFor(id, email))) return 'unproven';
    return 'ok';
  }

  /**
   * Verified mode (BETA-G1 fix 1): whether `id` has an approval binding at all. Throws when the
   * dirs are unsafe or the state cannot be read (the approver then refuses, never skips).
   */
  async hasApproval(id: string): Promise<boolean> {
    if (!REQUEST_ID_RE.test(id)) throw new Error('bad_id');
    const bad = await this.checkDirs();
    if (bad) throw new Error('state_unsafe');
    return !!(await this.readId(id))?.approvedAddr;
  }

  /** The verify cut-off: config, else the persisted first-enable time (written now if absent). */
  private async cutoff(): Promise<number> {
    if (this.d.since !== undefined) return this.d.since;
    const s = await readJson<{ v: 1; since: string }>(join(this.vdir, SINCE));
    if (s === null) {
      const since = new Date(this.now()).toISOString();
      await writeJson(this.vdir, SINCE, { v: 1, since });
      return Date.parse(since);
    }
    if (s.v !== 1 || !isTime(s.since)) throw new Unreadable('since_unreadable');
    return Date.parse(s.since);
  }

  /**
   * Mints a generation for `id` and sends its mail, within every limit. `resend` = a further
   * generation (slice 2); without it only a request with no generation yet gets one.
   * Neither form mails a request created at or before the verify cut-off.
   */
  mint(id: string, keys: VerifyKeys, resend = false): Promise<MintOutcome> {
    return serialById(id, async () => {
      if (this.d.mailsHeld) return 'caps_missing';
      if (await this.paused()) return 'paused';
      // Unreadable is not "gone": nothing is decided (the sweep keeps its `.rq` marker).
      const r = await this.d.store.get(id).catch((e: unknown) => {
        if (e instanceof StoreError && e.code === 'unreadable') return 'unreadable' as const;
        return null;
      });
      if (r === 'unreadable') return 'state_unreadable';
      if (!r || r.status !== 'pending' || (resend && r.origin !== 'web')) return 'not_pending';
      const since = await this.cutoff().catch(() => null);
      if (since === null) return 'state_unreadable';
      if (!(Date.parse(r.createdAt) > since)) return 'before_cutoff';
      const addr = addressHash(r.email);
      if (!addr) return 'bad_address';
      let s: IdState | null;
      try {
        s = await this.readId(id);
      } catch {
        return 'state_unreadable';
      }
      const st: IdState = s ?? { v: 1, id, gens: [], sends: 0 };
      if (st.usedAt || (!resend && st.gens.length > 0)) return 'skip';
      const t = this.now();
      if (st.sends >= VERIFY_PER_RECORD) return 'limit_record';
      if (st.gens.filter((g) => Date.parse(g.exp) > t).length >= VERIFY_LIVE_GENS)
        return 'limit_live';
      // S4a: no mail slot now = no generation, no counter (the request is minted fresh later).
      if (this.d.gate && (await this.d.gate.check())) return 'limit_mail';
      const gen = st.gens.reduce((m, g) => Math.max(m, g.gen), 0) + 1;
      const minted = mintVerifyToken(keys.current, { id, gen, now: t, purpose: 'verify' });
      const at = new Date(t).toISOString();
      // 1. The shared counters (fail closed), persisted first: a crash later over-counts.
      const counted = await countersLock(async (): Promise<MintOutcome | null> => {
        let c: Counters | null;
        try {
          c = await readJson<Counters>(join(this.vdir, COUNTERS), false, VERIFY_COUNTERS_MAX_BYTES);
        } catch {
          return 'limit_unreadable';
        }
        if (c !== null && !validCounters(c)) return 'limit_unreadable';
        const day = israelDay(t);
        const cur: Counters = c ?? { v: 1, day, dayCount: 0, addrs: {} };
        if (cur.day > day) return 'limit_unreadable';
        const dayCount = cur.day === day ? cur.dayCount : 0;
        if (dayCount >= (this.d.maxPerDay ?? VERIFY_MAX_PER_DAY)) return 'limit_day';
        const addrs: Record<string, string[]> = {};
        for (const [h, l] of Object.entries(cur.addrs)) {
          const keep = l.filter((x) => t - Date.parse(x) < VERIFY_ADDRESS_WINDOW_MS);
          if (keep.length > 0) addrs[h] = keep;
        }
        const mine = addrs[addr] ?? [];
        if (mine.length >= VERIFY_PER_ADDRESS) return 'limit_address';
        if (mine.some((x) => t - Date.parse(x) < VERIFY_ADDRESS_GAP_MS)) return 'limit_gap';
        if (await this.paused()) return 'paused';
        addrs[addr] = [...mine, at];
        await writeJson(this.vdir, COUNTERS, { v: 1, day, dayCount: dayCount + 1, addrs });
        return null;
      });
      if (counted) return counted;
      // 2. The generation (hash only, never the token) and the per-request count.
      const g: Gen = {
        gen,
        hash: minted.hash,
        exp: new Date(minted.exp).toISOString(),
        addr,
        sentAt: at,
        kid: verifyKeyId(keys.current),
      };
      await writeJson(this.vdir, `${id}.json`, {
        ...st,
        gens: [...st.gens, g].slice(-VERIFY_PER_RECORD),
        sends: st.sends + 1,
      } satisfies IdState);
      // A refused send revokes the generation again: no token of an unsent mail stays live.
      const revoke = () =>
        writeJson(this.vdir, `${id}.json`, st).catch((e: unknown) => {
          this.logHourly(`signup: verify generation not revoked (${errorClass(e)})`);
        });
      // 3. The kill switch once more, right before the send (the slot stays counted).
      if (await this.paused()) {
        await revoke();
        return 'paused';
      }
      const lang = r.lang === 'en' ? 'en' : 'he';
      try {
        await this.d.email.sendVerify!({
          email: r.email,
          lang,
          id,
          gen,
          link: verifyLink(this.d.siteUrl, lang, minted.token),
        });
      } catch (e) {
        if (e instanceof MailCapError || e instanceof MailPausedError) {
          await revoke();
          if (e instanceof MailPausedError) return 'paused';
          // Nothing was sent: the day and per-address slots are given back.
          await this.refund(addr, at);
          return 'limit_mail';
        }
        this.log(`signup: verify send failed (${errorClass(e)})`);
        return 'send_failed';
      }
      // S5: only now may the owner's view say "sent". A failed write leaves it unsaid.
      await writeJson(this.vdir, `${id}.json`, {
        ...st,
        gens: [...st.gens, { ...g, ok: true as const }].slice(-VERIFY_PER_RECORD),
        sends: st.sends + 1,
      } satisfies IdState).catch((e: unknown) => {
        this.logHourly(`signup: verify send not recorded (${errorClass(e)})`);
      });
      await this.d.store.update(id, { verifySentAt: at }).catch((e: unknown) => {
        this.logHourly(`signup: verify mirror not written (${errorClass(e)})`);
      });
      return 'sent';
    });
  }

  /**
   * Gives back the counters one `mint` took at `at` for a mail the gate or the provider refused.
   * A crash before this, or a failed write, leaves them counted (over-count, never under).
   */
  private refund(addr: string, at: string): Promise<void> {
    return countersLock(async () => {
      const c = await readJson<Counters>(
        join(this.vdir, COUNTERS),
        false,
        VERIFY_COUNTERS_MAX_BYTES,
      );
      if (!validCounters(c)) return;
      const mine = c.addrs[addr] ?? [];
      const i = mine.lastIndexOf(at);
      if (i < 0) return;
      const addrs = { ...c.addrs, [addr]: mine.filter((_, j) => j !== i) };
      if (addrs[addr]!.length === 0) delete addrs[addr];
      const sameDay = c.day === israelDay(Date.parse(at));
      const dayCount = sameDay ? Math.max(0, c.dayCount - 1) : c.dayCount;
      await writeJson(this.vdir, COUNTERS, { ...c, dayCount, addrs });
    }).catch((e: unknown) => {
      this.logHourly(`signup: verify slot not refunded (${errorClass(e)})`);
    });
  }

  /** One marker: a class code (`ok` or why not) and whether the file may be removed. */
  private async consume(
    name: string,
    fileId: string,
    suffix: string,
    keys: VerifyKeys,
  ): Promise<{ cls: string; unlink: boolean }> {
    let token: string;
    const fh = await open(
      join(this.d.storeDir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => null);
    if (!fh) return { cls: 'bad_marker', unlink: true };
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > VERIFY_MARKER_MAX_BYTES)
        return { cls: 'bad_marker', unlink: true };
      const buf = Buffer.alloc(VERIFY_MARKER_MAX_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > VERIFY_MARKER_MAX_BYTES) return { cls: 'bad_marker', unlink: true };
      token = buf.subarray(0, bytesRead).toString('utf8').replace(/\n$/, '');
    } finally {
      await fh.close();
    }
    // Slice 2: the intake writes an EMPTY marker (it never stores the token); the 64-bit hash
    // prefix in the name is then matched against this id's minted generations (hash only, timing
    // safe). A marker holding a token (slice 1 form) is still checked by its MAC first.
    let p: { gen: number } | null = null;
    let hash: string | null = null;
    if (token !== '') {
      hash = tokenHash(token);
      if (hash.slice(0, 16) !== suffix) return { cls: 'bad_marker', unlink: true };
      const q = checkVerifyToken(
        keys.prev ? [keys.current, keys.prev] : [keys.current],
        token,
        'verify',
      );
      if (!q) return { cls: /^v1\./.test(token) ? 'bad_mac' : 'bad_format', unlink: true };
      if (q.id !== fileId) return { cls: 'id_mismatch', unlink: true };
      p = q;
    }
    return serialById(fileId, async () => {
      let r: SignupRecord;
      try {
        r = await this.d.store.get(fileId);
      } catch (e) {
        const gone = e instanceof StoreError && e.code === 'not_found';
        return { cls: gone ? 'no_record' : 'record_unreadable', unlink: gone };
      }
      if (r.status !== 'pending') return { cls: 'not_pending', unlink: true };
      let s: IdState | null;
      try {
        s = await this.readId(fileId);
      } catch {
        return { cls: 'state_unreadable', unlink: false };
      }
      if (!s) return { cls: 'unknown_gen', unlink: true };
      if (s.usedAt) return { cls: 'replay', unlink: true };
      const g = s.gens.find((x) =>
        p && hash
          ? x.gen === p.gen && sameHash(x.hash, hash)
          : samePrefix(x.hash.slice(0, 16), suffix),
      );
      if (!g) return { cls: 'unknown_gen', unlink: true };
      // An empty marker carries no MAC: its generation must come from a key still held (current
      // or prev), so rotating or removing a key revokes every link it minted.
      if (!p) {
        const held = [keys.current, ...(keys.prev ? [keys.prev] : [])].map(verifyKeyId);
        if (!g.kid || !held.includes(g.kid)) return { cls: 'key_retired', unlink: true };
      }
      const t = this.now();
      if (Date.parse(g.exp) <= t) return { cls: 'expired', unlink: true };
      const addr = addressHash(r.email);
      if (!addr || !sameHash(addr, g.addr)) return { cls: 'addr_changed', unlink: true };
      const at = new Date(t).toISOString();
      try {
        await writeJson(this.vdir, `${fileId}.json`, {
          ...s,
          usedAt: at,
          verifiedAt: at,
          verifiedAddr: g.addr,
        } satisfies IdState);
      } catch (e) {
        return { cls: `write_${errorClass(e)}`, unlink: false };
      }
      await this.d.store.update(fileId, { verifiedAt: at }).catch((e: unknown) => {
        this.logHourly(`signup: verify mirror not written (${errorClass(e)})`);
      });
      return { cls: 'ok', unlink: true };
    });
  }

  /**
   * S4a: purges web `pending` requests created after the verify cut-off, at least `days` old by
   * `createdAt` (minus `horizonMs`, the time to the next run), with no admin-recorded verification
   * and not in the auto-approve claim set; all re-checked under the per-id lock. An unreadable
   * verify state or claim set keeps the request. Also expires address-hash counters (7 days).
   */
  async purgeUnverified(days: number, horizonMs = 0): Promise<UnverifiedPurgeResult> {
    const out: UnverifiedPurgeResult = { purged: 0, neverMailed: 0 };
    const bad = await this.checkDirs();
    if (bad) return { ...out, stopped: 'state_dir_unsafe' };
    let since: number;
    try {
      since = await this.cutoff();
    } catch {
      return { ...out, stopped: 'since_unreadable' };
    }
    const t = this.now();
    const old = (r: SignupRecord) => {
      const c = Date.parse(r.createdAt);
      return (
        r.status === 'pending' &&
        r.origin === 'web' &&
        Number.isFinite(c) &&
        c > since &&
        t + horizonMs - c >= days * 86_400_000
      );
    };
    // Why requests were kept or not removed: class codes and counts only.
    const skipped = new Map<string, number>();
    const bump = (k: string) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
    const keep = (why: string) => {
      bump(`kept (${why})`);
      return false;
    };
    for (const cand of await this.d.store.list()) {
      if (!old(cand)) continue;
      let never = false;
      const gone = await this.d.store
        .purgeIf(
          cand.id,
          async (r) => {
            if (!old(r)) return false;
            let s: IdState | null;
            try {
              s = await this.readId(r.id);
            } catch {
              return keep('state_unreadable'); // unreadable verify state = keep
            }
            if (s?.verifiedAt || s?.usedAt || s?.approvedAddr) return false;
            const claims = this.d.claimed ? await this.d.claimed().catch(() => null) : new Set();
            if (!claims) return keep('claims_unreadable');
            if (claims.has(r.id)) return false;
            never = !s || s.sends === 0;
            return true;
          },
          () => this.remove(cand.id),
        )
        .catch((e: unknown) => {
          bump(`failed (${errorClass(e)})`);
          return false;
        });
      if (gone) {
        out.purged++;
        if (never) out.neverMailed++;
      }
    }
    await countersLock(async () => {
      const c = await readJson<Counters>(
        join(this.vdir, COUNTERS),
        false,
        VERIFY_COUNTERS_MAX_BYTES,
      ).catch(() => null);
      if (!validCounters(c)) return;
      const addrs: Record<string, string[]> = {};
      for (const [h, l] of Object.entries(c.addrs)) {
        const keep = l.filter((x) => t - Date.parse(x) < VERIFY_ADDRESS_WINDOW_MS);
        if (keep.length > 0) addrs[h] = keep;
      }
      // Any expired entry (also one of an address that keeps newer ones) shrinks the file.
      const n = (x: Record<string, string[]>) => Object.values(x).reduce((m, l) => m + l.length, 0);
      if (n(addrs) !== n(c.addrs)) await writeJson(this.vdir, COUNTERS, { ...c, addrs });
    }).catch((e: unknown) => {
      this.logHourly(`signup: purge unverified counters not expired (${errorClass(e)})`);
    });
    for (const [k, n] of [...skipped].sort()) this.logHourly(`signup: purge unverified ${k} ${n}`);
    if (out.purged > 0) this.log(`signup: purge unverified removed ${out.purged}`);
    if (out.neverMailed > 0) this.log(`signup: purge unverified never mailed ${out.neverMailed}`);
    return out;
  }

  private lastPurge: number | undefined;
  private sweeping = false;
  /** `.rq` round robin: the last marker name handled (in memory; a restart starts at the top). */
  private rqCursor: string | undefined;
  /**
   * Kept `.rq` markers to retry: the time the resend failed, or null (only paused so far). Such a
   * marker waits out the address gap; after a failed send it also waits RESEND_RETRY_MS and gets
   * one retry only.
   */
  private readonly rqRetry = new Map<string, number | null>();

  /** One pass: orphan state, first mails, then confirm markers. Never throws for a single item. */
  async sweep(opts: VerifySweepOptions = {}): Promise<VerifySweepResult> {
    const out: VerifySweepResult = { sent: 0, verified: 0, rejected: 0 };
    if (this.sweeping) return out;
    this.sweeping = true;
    try {
      return await this.sweepInner(out, opts.stop ?? (() => false));
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepInner(
    out: VerifySweepResult,
    stop: () => boolean,
  ): Promise<VerifySweepResult> {
    if (!this.d.email.sendVerify) {
      this.logHourly('signup: verify off (mail sender cannot send verify mail)');
      return { ...out, stopped: 'no_sender' };
    }
    const bad = await this.checkDirs();
    if (bad) {
      this.logHourly(`signup: verify state dir unsafe (${bad}); verification off`);
      return { ...out, stopped: 'state_dir_unsafe' };
    }
    let keys: VerifyKeys;
    try {
      keys = await this.d.keys();
    } catch (e) {
      this.logHourly(`signup: verify key unusable (${errorClass(e)}); verification off`);
      return { ...out, stopped: 'key_unusable' };
    }
    let since: number;
    try {
      since = await this.cutoff();
    } catch {
      this.logHourly('signup: verify cut-off unreadable; nothing minted or verified');
      return { ...out, stopped: 'since_unreadable' };
    }
    const records = await this.d.store.list();
    const live = new Set(records.map((r) => r.id));
    // Orphan state: removed only when the store says the record is gone (not on a read error).
    for (const f of await readdir(this.vdir)) {
      const m = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(f);
      if (!m || live.has(m[1]!)) continue;
      const gone = await this.d.store.get(m[1]!).then(
        () => false,
        (e: unknown) => e instanceof StoreError && e.code === 'not_found',
      );
      if (gone) await this.remove(m[1]!).catch(() => undefined);
    }
    const held = this.d.mailsHeld === true;
    if (held) this.logHourly('signup: verify mails held (mail_caps_missing)');
    const counts = new Map<string, number>();
    const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const r of records) {
      if (stop() || held) break;
      if (r.status !== 'pending' || r.origin !== 'web' || !(Date.parse(r.createdAt) > since))
        continue;
      const o = await this.mint(r.id, keys).catch(() => 'state_unreadable' as const);
      if (o === 'sent') out.sent++;
      else if (o !== 'skip' && o !== 'not_pending') bump(`not sent (${o})`);
      // Shared conditions: no later record can be sent in this sweep either.
      if (o === 'paused' || o === 'limit_day' || o === 'limit_unreadable' || o === 'limit_mail')
        break;
    }
    let seen = 0;
    for (const e of await readdir(this.d.storeDir, { withFileTypes: true })) {
      if (stop()) break;
      const f = e.name;
      const m = VERIFY_MARKER_RE.exec(f);
      // A directory can never be a marker (nor be unlinked): skipped, it takes no slot.
      if (!m || e.isDirectory()) continue;
      if (++seen > VERIFY_MARKERS_PER_SWEEP) break;
      const res = await this.consume(f, m[1]!, m[2]!, keys).catch((e: unknown) => ({
        cls: `error_${errorClass(e)}`,
        unlink: false,
      }));
      if (res.cls === 'ok') out.verified++;
      else {
        out.rejected++;
        bump(`rejected (${res.cls})`);
      }
      if (res.unlink)
        await unlink(join(this.d.storeDir, f)).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') bump(`marker not removed (${errorClass(e)})`);
        });
    }
    // Resend requests (`<id>.rq`, intake: /signup/resend or a duplicate web sign-up). `mint`
    // applies every mail limit under the per-id lock; the marker is removed once the outcome is
    // persisted, also when a limit blocks (so repeated requests never queue up mails). Kept for a
    // later sweep: unreadable state or counters (nothing was decided), over the mail cap (minted
    // when a slot frees), paused (nothing sent; the loop stops, no marker can go out), and the
    // first failed send (one retry, at least RESEND_RETRY_MS later; it takes a per-address slot).
    // The retry state is in memory only: after a restart a kept marker is a new request.
    // The markers are visited in name order from where the last sweep stopped, so kept markers
    // can never hold the per-sweep cap against the others.
    // A directory can never be a marker (nor be unlinked): skipped, it takes no slot.
    const rqFile = new Map<string, boolean>();
    for (const e of await readdir(this.d.storeDir, { withFileTypes: true }))
      if (RESEND_MARKER_RE.test(e.name) && !e.isDirectory()) rqFile.set(e.name, e.isFile());
    const rqNames = [...rqFile.keys()].sort();
    const start = this.rqCursor === undefined ? 0 : rqNames.findIndex((n) => n > this.rqCursor!);
    const ordered = start <= 0 ? rqNames : [...rqNames.slice(start), ...rqNames.slice(0, start)];
    const present = new Set(rqNames.map((n) => n.slice(0, -3)));
    for (const id of [...this.rqRetry.keys()]) if (!present.has(id)) this.rqRetry.delete(id);
    let rqSeen = 0;
    for (const f of ordered) {
      if (stop() || held) break;
      const m = RESEND_MARKER_RE.exec(f)!;
      const id = m[1]!;
      // Backing off after a failed send: not visited, so it takes no slot of the per-sweep cap.
      const failedAt = this.rqRetry.get(id) ?? null;
      if (failedAt !== null && this.now() - failedAt < RESEND_RETRY_MS) continue;
      if (++rqSeen > VERIFY_MARKERS_PER_SWEEP) break;
      this.rqCursor = f;
      const o: string = rqFile.get(f)
        ? await this.mint(id, keys, true).catch(() => 'state_unreadable')
        : 'bad_marker';
      if (o === 'sent') out.sent++;
      else if (o !== 'skip' && o !== 'not_pending') bump(`resend not sent (${o})`);
      // A paused send is retried after the resume (one paused at the send already took its slot).
      if (o === 'paused') {
        this.rqRetry.set(id, failedAt);
        break;
      }
      // The first failed send is retried once, later; a failed retry removes the marker, so an
      // outage cannot use up the address limit and a new request for a link still has a slot.
      if (o === 'send_failed' && failedAt === null) {
        this.rqRetry.set(id, this.now());
        continue;
      }
      // A retry waits out the address gap instead of being dropped by it.
      if (o === 'limit_gap' && this.rqRetry.has(id)) continue;
      if (o === 'state_unreadable' || o === 'limit_unreadable' || o === 'limit_mail') continue;
      this.rqRetry.delete(id);
      await unlink(join(this.d.storeDir, f)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') bump(`marker not removed (${errorClass(e)})`);
      });
    }
    // S4a: the unverified purge at most once per hour (deadline met within the hour).
    const days = this.d.unverifiedDays;
    const t = this.now();
    if (
      days !== undefined &&
      !held &&
      !stop() &&
      (this.lastPurge === undefined || t - this.lastPurge >= 3_600_000 || t < this.lastPurge)
    ) {
      this.lastPurge = t;
      const p = await this.purgeUnverified(days, 3_600_000).catch(() => null);
      if (!p || p.stopped)
        this.logHourly(`signup: purge unverified skipped (${p?.stopped ?? 'error'})`);
    }
    if (out.sent > 0) this.log(`signup: verify sent ${out.sent}`);
    if (out.verified > 0) this.log(`signup: verify ok ${out.verified}`);
    // Repeated identical class lines (a limit, a stuck marker) at most once per hour.
    for (const [k, n] of [...counts].sort()) this.logHourly(`signup: verify ${k} ${n}`);
    return out;
  }
}
