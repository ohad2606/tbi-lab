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
 *              hashes to the verified one; checked by auto-approve in `eligible`, in the claim and
 *              right before the account request (autoApprove.ts).
 * Logs carry class codes and counts only: never an id, token, hash, file name, address or name.
 */
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
import { StoreError, VERIFY_MARKER_RE, type PendingStore, type SignupRecord } from './store.js';
import {
  checkVerifyToken,
  mintVerifyToken,
  parseSiteUrl,
  sameHash,
  tokenHash,
  verifyLink,
  type VerifyKeys,
} from './verify.js';

export const VERIFY_DIR = 'verify';
export const VERIFY_MAX_PER_DAY = 50;
export const VERIFY_PER_ADDRESS = 3;
export const VERIFY_ADDRESS_WINDOW_MS = 7 * 86_400_000;
export const VERIFY_ADDRESS_GAP_MS = 10 * 60_000;
export const VERIFY_PER_RECORD = 5;
export const VERIFY_LIVE_GENS = 3;
export const VERIFY_MARKERS_PER_SWEEP = 200;
export const VERIFY_MARKER_MAX_BYTES = 1024;
const STATE_MAX_BYTES = 256 * 1024;
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
 * TBI_SIGNUP_AUTO_WEB=included (web requests would be approved without proof anyway).
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
}
interface IdState {
  v: 1;
  id: string;
  gens: Gen[];
  sends: number;
  usedAt?: string;
  verifiedAt?: string;
  verifiedAddr?: string;
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
  if (s.usedAt !== undefined && !isTime(s.usedAt)) return false;
  if (s.verifiedAt !== undefined && !isTime(s.verifiedAt)) return false;
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

/** null = no such file. Throws Unreadable on anything but a small regular JSON file. */
async function readJson<T>(path: string): Promise<T | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Unreadable('state_unreadable');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > STATE_MAX_BYTES) throw new Unreadable('state_unreadable');
    return JSON.parse(await fh.readFile('utf8')) as T;
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

export type MintOutcome =
  | 'sent'
  | 'send_failed'
  | 'paused'
  | 'skip'
  | 'not_pending'
  | 'bad_address'
  | 'state_unreadable'
  | 'limit_day'
  | 'limit_address'
  | 'limit_gap'
  | 'limit_record'
  | 'limit_live'
  | 'limit_unreadable';

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
    this.onceLogged.set(line, t);
    this.log(line);
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
   */
  mint(id: string, keys: VerifyKeys, resend = false): Promise<MintOutcome> {
    return serialById(id, async () => {
      if (await this.paused()) return 'paused';
      const r = await this.d.store.get(id).catch(() => null);
      if (!r || r.status !== 'pending') return 'not_pending';
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
      const gen = st.gens.reduce((m, g) => Math.max(m, g.gen), 0) + 1;
      const minted = mintVerifyToken(keys.current, { id, gen, now: t, purpose: 'verify' });
      const at = new Date(t).toISOString();
      // 1. The shared counters (fail closed), persisted first: a crash later over-counts.
      const counted = await countersLock(async (): Promise<MintOutcome | null> => {
        let c: Counters | null;
        try {
          c = await readJson<Counters>(join(this.vdir, COUNTERS));
        } catch {
          return 'limit_unreadable';
        }
        if (c !== null && !validCounters(c)) return 'limit_unreadable';
        const day = israelDay(t);
        const cur: Counters = c ?? { v: 1, day, dayCount: 0, addrs: {} };
        if (cur.day > day) return 'limit_unreadable';
        const dayCount = cur.day === day ? cur.dayCount : 0;
        if (dayCount >= VERIFY_MAX_PER_DAY) return 'limit_day';
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
      };
      await writeJson(this.vdir, `${id}.json`, {
        ...st,
        gens: [...st.gens, g].slice(-VERIFY_PER_RECORD),
        sends: st.sends + 1,
      } satisfies IdState);
      // 3. The kill switch once more, right before the send (the slot stays counted).
      if (await this.paused()) return 'paused';
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
        this.log(`signup: verify send failed (${errorClass(e)})`);
        return 'send_failed';
      }
      await this.d.store.update(id, { verifySentAt: at }).catch((e: unknown) => {
        this.logHourly(`signup: verify mirror not written (${errorClass(e)})`);
      });
      return 'sent';
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
    const hash = tokenHash(token);
    if (hash.slice(0, 16) !== suffix) return { cls: 'bad_marker', unlink: true };
    const p = checkVerifyToken(
      keys.prev ? [keys.current, keys.prev] : [keys.current],
      token,
      'verify',
    );
    if (!p) return { cls: /^v1\./.test(token) ? 'bad_mac' : 'bad_format', unlink: true };
    if (p.id !== fileId) return { cls: 'id_mismatch', unlink: true };
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
      const g = s.gens.find((x) => x.gen === p.gen && sameHash(x.hash, hash));
      if (!g) return { cls: 'unknown_gen', unlink: true };
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

  private sweeping = false;

  /** One pass: orphan state, first mails, then confirm markers. Never throws for a single item. */
  async sweep(): Promise<VerifySweepResult> {
    const out: VerifySweepResult = { sent: 0, verified: 0, rejected: 0 };
    if (this.sweeping) return out;
    this.sweeping = true;
    try {
      return await this.sweepInner(out);
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepInner(out: VerifySweepResult): Promise<VerifySweepResult> {
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
    for (const f of await readdir(this.vdir)) {
      const m = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(f);
      if (m && !live.has(m[1]!) && (await this.d.store.get(m[1]!).catch(() => null)) === null)
        await this.remove(m[1]!).catch(() => undefined);
    }
    const counts = new Map<string, number>();
    const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const r of records) {
      if (r.status !== 'pending' || r.origin !== 'web' || !(Date.parse(r.createdAt) > since))
        continue;
      const o = await this.mint(r.id, keys).catch(() => 'state_unreadable' as const);
      if (o === 'sent') out.sent++;
      else if (o !== 'skip' && o !== 'not_pending') bump(`not sent (${o})`);
      if (o === 'paused') break;
    }
    let seen = 0;
    for (const f of await readdir(this.d.storeDir)) {
      const m = VERIFY_MARKER_RE.exec(f);
      if (!m) continue;
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
    if (out.sent > 0) this.log(`signup: verify sent ${out.sent}`);
    if (out.verified > 0) this.log(`signup: verify ok ${out.verified}`);
    for (const [k, n] of [...counts].sort()) this.log(`signup: verify ${k} ${n}`);
    return out;
  }
}
