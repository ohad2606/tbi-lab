/**
 * TBI-022: the sign-up workflow, pure and injectable.
 *
 *   SignupIntake   the public side: verify -> limit -> validate -> de-duplicate -> store -> notify.
 *                  Holds the HMAC secret and the notifier; can only CREATE pending requests.
 *   SignupApprover the owner side (admin service): approve (existing account-add path, then the
 *                  approval email), reject, resend. Idempotent: an account is added once and an
 *                  approval email is sent once unless the owner explicitly resends after a failure.
 */
import { createHash } from 'node:crypto';
import { normalizeAddEmail } from '../accounts.js';
import type { FunnelEvent, FunnelSink } from '../funnel/counters.js';
import { errorClass } from './errors.js';
import { NonceCache, verifyRequest, type VerifyFailure } from './hmac.js';
import { SlidingWindowLimiter } from './limits.js';
import type { SignupNotifier } from './notify.js';
import { MailCapError, MailPausedError } from './mailGate.js';
import { isQuiet, nextSendAt, type QuietWindow } from './quietHours.js';
import type { EmailSender } from './email.js';
import { serialById } from './locks.js';
import { PendingStore, StoreError, type DeleteOutcome, type SignupRecord } from './store.js';
import { validateSignup, type SignupInput } from './validate.js';
import {
  checkToken,
  HONEYPOT_FIELD,
  issueToken,
  TOKEN_FIELD,
  WEB_MIN_FILL_MS,
  WEB_TOKEN_TTL_MS,
  type TokenFailure,
} from './web.js';

export type IntakeOutcome =
  | { status: 202 }
  | { status: 400 | 401 | 413 | 415 | 429 | 503; error: string; retryAfterMs?: number };

export interface IntakeDeps {
  secret: Buffer;
  store: PendingStore;
  notifier: SignupNotifier | null;
  now?: () => number;
  sourceRate: SlidingWindowLimiter;
  globalRate: SlidingWindowLimiter;
  nonces: NonceCache;
  /** Quiet hours for the owner alert (null / unset: always send at once). */
  quiet?: QuietWindow | null;
  windowMs?: number;
  log?: (line: string) => void;
  /** BETA-G1 s8: the browser route (`POST /signup/web`); absent = the route does not exist. */
  web?: WebIntakeDeps;
  /** K12: funnel counters (`signup_submitted`, `signup_form_view`); null / unset = off. */
  counters?: FunnelSink | null;
  /**
   * G1-AUTO-VERIFY slice 2 (`TBI_SIGNUP_VERIFY=1`, needs `web`): `POST /signup/verify` and
   * `/signup/resend`, and a duplicate web sign-up asks for a resend. Absent = all of it is off.
   * The intake never holds the verify key: it checks the token's format and plaintext expiry only.
   */
  verify?: VerifyIntakeDeps;
}

/** Own buckets, separate from `/signup/web`'s. */
export interface VerifyIntakeDeps {
  verifyRate: SlidingWindowLimiter;
  verifyGlobal: SlidingWindowLimiter;
  resendRate: SlidingWindowLimiter;
  resendGlobal: SlidingWindowLimiter;
}

/** Token syntax as the admin mints it (verify.ts); the intake cannot and does not check the MAC. */
const VERIFY_TOKEN_RE =
  /^v1\.([0-9A-HJKMNP-TV-Z]{26})\.[1-9][0-9]{0,3}\.([1-9][0-9]{9,10})\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
/** A token never expires more than this far ahead (24 h + clock slack). */
const VERIFY_MAX_AHEAD_MS = 25 * 3_600_000;

export type VerifyOutcome =
  { status: 202 } | { status: 400 | 404 | 410 | 429; error: string; retryAfterMs?: number };

/** K12: counts an event; the counters never throw, and this guard keeps it so for any sink. */
function count(sink: FunnelSink | null | undefined, event: FunnelEvent): void {
  try {
    sink?.increment(event);
  } catch {
    /* counters are indicative; a sign-up never fails because of them */
  }
}

/**
 * The web route's own limiters and nonce cache (separate instances from the signed route's, so a
 * flood on one route cannot spend the other's budget or fill its replay cache).
 */
export interface WebIntakeDeps {
  /** Derived token key (web.ts `deriveWebKey`), never the raw secret. */
  webKey: Buffer;
  /** Per-source limit of `GET /signup/form-token`. */
  tokenRate: SlidingWindowLimiter;
  /** Per-source limit of `POST /signup/web` (checked before the token). */
  sourceRate: SlidingWindowLimiter;
  globalRate: SlidingWindowLimiter;
  /** Used-token nonces; its window must cover the token TTL. */
  nonces: NonceCache;
  ttlMs?: number;
  minFillMs?: number;
}

export type WebOutcome =
  { status: 200 } | { status: 400 | 401 | 404 | 429 | 503; error: string; retryAfterMs?: number };

export type TokenOutcome =
  | { status: 200; token: string; ttl: number; minFill: number }
  | { status: 404 | 429; error: string; retryAfterMs?: number };

const statusOf = (_r: VerifyFailure): 401 => 401;

/** Missing, forged and replayed tokens share one code; an expired one tells the page to refetch. */
const webAuthError = (r: Exclude<TokenFailure, 'too_fast'>): string =>
  r === 'expired' ? 'expired' : 'unauthorized';

export class SignupIntake {
  constructor(private readonly d: IntakeDeps) {}

  /** `source` is the proxy-asserted client key; `body` is the raw, already size-capped body. */
  async submit(
    source: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): Promise<IntakeOutcome> {
    const now = (this.d.now ?? Date.now)();
    // Per-source limit first (bounds what one caller can make us do). The GLOBAL budget is taken
    // only after the HMAC verifies, so unsigned junk from many sources cannot spend it.
    const s = this.d.sourceRate.take(source);
    if (!s.ok) return { status: 429, error: 'rate_limited', retryAfterMs: s.retryAfterMs };
    const v = verifyRequest({
      secret: this.d.secret,
      headers,
      body,
      now,
      nonces: this.d.nonces,
      windowMs: this.d.windowMs,
    });
    // One answer for every authentication failure; the reason goes to the log only.
    if (!v.ok) {
      this.d.log?.(`signup: refused (${v.reason})`);
      return { status: statusOf(v.reason), error: 'unauthorized' };
    }
    const g = this.d.globalRate.take('all');
    if (!g.ok) {
      // The nonce is already consumed: the sender must retry with a fresh nonce and signature.
      this.d.log?.('signup: global limit');
      return { status: 429, error: 'rate_limited', retryAfterMs: g.retryAfterMs };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      return { status: 400, error: 'invalid' };
    }
    const val = validateSignup(raw);
    if (!val.ok) return { status: 400, error: 'invalid' };
    const a = await this.accept(val.value, now, true);
    return a === 'unavailable' ? { status: 503, error: 'unavailable' } : { status: 202 };
  }

  /**
   * `GET /signup/form-token`: a fresh stateless token (web.ts), per-source rate limited. `ttl` and
   * `minFill` are in seconds. Nothing is stored; the token carries its own issue time and MAC.
   *
   * K12: each 200 counts `signup_form_view`, which means FORM TOKENS ISSUED, not people and not
   * distinct visits. The page (site/signup.mjs) fetches a token when it loads (so again after a
   * reload), on focus or submit when it has none still fresh (failed, close to expiry, or
   * discarded; there is no timer), and after a 401. A refused submit that discards the token (a 400
   * other than `too_fast`, 403, 500 and other statuses except 429 and 503, a second 401) focuses
   * the error summary inside the form, so a new token is fetched at once. A bot can raise it to the
   * daily cap (10 000) while staying within the per-source token limit; accepted for an indicative
   * number (nothing is kept per source).
   */
  issueWebToken(source: string): TokenOutcome {
    const w = this.d.web;
    if (!w) return { status: 404, error: 'not_found' };
    const r = w.tokenRate.take(source);
    if (!r.ok) {
      this.d.log?.('signup: web refused (token_limit)');
      return { status: 429, error: 'rate_limited', retryAfterMs: r.retryAfterMs };
    }
    const now = (this.d.now ?? Date.now)();
    const ttlMs = w.ttlMs ?? WEB_TOKEN_TTL_MS;
    // The page waits this long after the token arrives before it posts (fixed, whole seconds,
    // rounded up so the page never waits less than the server requires).
    const minFill = Math.ceil((w.minFillMs ?? WEB_MIN_FILL_MS) / 1000);
    const token = issueToken(w.webKey, now);
    count(this.d.counters, 'signup_form_view');
    return { status: 200, token, ttl: Math.floor(ttlMs / 1000), minFill };
  }

  /**
   * `POST /signup/web` after the HTTP checks (method, origin, content type, size cap, source key).
   * Order: the per-source limit (before any crypto), the token (MAC, age, minimum fill time; not
   * consumed), the honeypot (a hit records nothing, so it cannot fill the nonce cache; a resend
   * is bounded by the per-source limit), field validation
   * (not consumed: the person fixes a typo and retries), the GLOBAL limit (taken only by requests
   * that would be stored, so honeypot hits and junk cannot drain it; a 429 does not consume the
   * token), then the token is consumed (single use) and the request takes the same path as
   * `/signup`, marked `origin: 'web'` (web sub-cap). If the store refuses (503, nothing stored)
   * the token is released again, so the page may retry with it; it was reserved during the store
   * call, so a concurrent post with the same token gets 401 and never a second record.
   * A duplicate address answers exactly like a new one (200), see `accept`.
   */
  async submitWeb(source: string, body: Buffer): Promise<WebOutcome> {
    const w = this.d.web;
    if (!w) return { status: 404, error: 'not_found' };
    const now = (this.d.now ?? Date.now)();
    const refuse = (why: string) => this.d.log?.(`signup: web refused (${why})`);
    const s = w.sourceRate.take(source);
    if (!s.ok) {
      refuse('source_limit');
      return { status: 429, error: 'rate_limited', retryAfterMs: s.retryAfterMs };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      refuse('bad_json');
      return { status: 400, error: 'invalid' };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      refuse('bad_json');
      return { status: 400, error: 'invalid' };
    }
    const {
      [TOKEN_FIELD]: token,
      [HONEYPOT_FIELD]: honey,
      ...fields
    } = raw as Record<string, unknown>;
    const t = checkToken(w.webKey, token, now, { ttlMs: w.ttlMs, minFillMs: w.minFillMs });
    if (!t.ok) {
      refuse(t.reason);
      return t.reason === 'too_fast'
        ? { status: 400, error: 'too_fast' }
        : { status: 401, error: webAuthError(t.reason) };
    }
    if (honey !== '') {
      // Same answer as a typo. The nonce is NOT recorded (Fable review finding 2): honeypot hits
      // from many sources would otherwise fill the bounded cache and lock real people out. The
      // same token may therefore be resent here; that is bounded by the per-source limit above.
      refuse('honeypot');
      return { status: 400, error: 'invalid' };
    }
    const val = validateSignup(fields, { heardFrom: true });
    if (!val.ok) {
      refuse(`invalid_${val.field}`);
      return { status: 400, error: 'invalid' };
    }
    // An already used token is refused before it can spend the global budget.
    if (w.nonces.has(t.nonce, now)) {
      refuse('replayed');
      return { status: 401, error: 'unauthorized' };
    }
    const g = w.globalRate.take('all');
    if (!g.ok) {
      refuse('global_limit');
      return { status: 429, error: 'rate_limited', retryAfterMs: g.retryAfterMs };
    }
    if (!w.nonces.take(t.nonce, now)) {
      refuse('replayed');
      return { status: 401, error: 'unauthorized' };
    }
    const a = await this.accept(val.value, now, false, 'web');
    if (a === 'unavailable') {
      // Nothing was stored: give the token back so the page can retry with it.
      w.nonces.release(t.nonce);
      return { status: 503, error: 'unavailable' };
    }
    return { status: 200 };
  }

  /**
   * Marker work after the answer: detached (never awaited by the caller), errors caught and
   * logged as one class line. The answer therefore cannot depend on the id or the address.
   */
  private later(fn: () => Promise<string>, what: string): void {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(fn)
      .then(
        (o) => {
          if (o === 'limit') this.d.log?.(`signup: ${what} marker limit`);
        },
        (e: unknown) =>
          this.d.log?.(
            `signup: ${what} marker failed (${e instanceof StoreError ? e.code : errorClass(e)})`,
          ),
      )
      .finally(() => this.pendingAlerts.delete(p));
    this.pendingAlerts.add(p);
  }

  /**
   * `POST /signup/verify` `{token}`: per-source limit, format, plaintext expiry, global limit,
   * then 202 `received` for every well-formed unexpired token; the confirm marker is written
   * afterwards (`later`), so unknown, verified and over-limit ids answer exactly alike.
   */
  async submitVerify(source: string, body: Buffer): Promise<VerifyOutcome> {
    const v = this.d.web && this.d.verify;
    if (!v) return { status: 404, error: 'not_found' };
    const refuse = (why: string) => this.d.log?.(`signup: verify refused (${why})`);
    const s = v.verifyRate.take(source);
    if (!s.ok) {
      refuse('source_limit');
      return { status: 429, error: 'rate_limited', retryAfterMs: s.retryAfterMs };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      refuse('bad_json');
      return { status: 400, error: 'invalid' };
    }
    const token =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).token
        : undefined;
    const m = typeof token === 'string' ? VERIFY_TOKEN_RE.exec(token) : null;
    if (!m) {
      refuse('bad_format');
      return { status: 400, error: 'invalid' };
    }
    const now = (this.d.now ?? Date.now)();
    const exp = Number(m[2]) * 1000;
    if (!Number.isSafeInteger(exp) || exp - now > VERIFY_MAX_AHEAD_MS) {
      refuse('bad_exp');
      return { status: 400, error: 'invalid' };
    }
    if (exp <= now) {
      refuse('expired');
      return { status: 410, error: 'expired' };
    }
    const g = v.verifyGlobal.take('all');
    if (!g.ok) {
      refuse('global_limit');
      return { status: 429, error: 'rate_limited', retryAfterMs: g.retryAfterMs };
    }
    const id = m[1]!;
    const suffix = createHash('sha256')
      .update(token as string, 'utf8')
      .digest('hex')
      .slice(0, 16);
    this.later(() => this.d.store.writeVerifyMarker(id, suffix), 'verify');
    return { status: 202 };
  }

  /**
   * `POST /signup/resend` `{email, token, website}`: the same form token, honeypot and minimum
   * fill as `/signup/web` (same refusals), own limits; then 200 for any address, valid or not.
   * The resend marker is written afterwards (`later`) and only for a web pending unverified record.
   */
  async submitResend(source: string, body: Buffer): Promise<WebOutcome> {
    const w = this.d.web;
    const v = w && this.d.verify;
    if (!w || !v) return { status: 404, error: 'not_found' };
    const now = (this.d.now ?? Date.now)();
    const refuse = (why: string) => this.d.log?.(`signup: resend refused (${why})`);
    const s = v.resendRate.take(source);
    if (!s.ok) {
      refuse('source_limit');
      return { status: 429, error: 'rate_limited', retryAfterMs: s.retryAfterMs };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      refuse('bad_json');
      return { status: 400, error: 'invalid' };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      refuse('bad_json');
      return { status: 400, error: 'invalid' };
    }
    const o = raw as Record<string, unknown>;
    const t = checkToken(w.webKey, o[TOKEN_FIELD], now, { ttlMs: w.ttlMs, minFillMs: w.minFillMs });
    if (!t.ok) {
      refuse(t.reason);
      return t.reason === 'too_fast'
        ? { status: 400, error: 'too_fast' }
        : { status: 401, error: webAuthError(t.reason) };
    }
    if (o[HONEYPOT_FIELD] !== '') {
      refuse('honeypot');
      return { status: 400, error: 'invalid' };
    }
    if (w.nonces.has(t.nonce, now)) {
      refuse('replayed');
      return { status: 401, error: 'unauthorized' };
    }
    const g = v.resendGlobal.take('all');
    if (!g.ok) {
      refuse('global_limit');
      return { status: 429, error: 'rate_limited', retryAfterMs: g.retryAfterMs };
    }
    if (!w.nonces.take(t.nonce, now)) {
      refuse('replayed');
      return { status: 401, error: 'unauthorized' };
    }
    // Any address answers 200: an invalid one simply writes nothing.
    const email = normalizeAddEmail(o.email);
    if (email) this.later(() => this.d.store.writeResendMarkerFor(email), 'resend');
    return { status: 200 };
  }

  /** Alerts the web route started without waiting (tests and shutdown can await them). */
  private readonly pendingAlerts = new Set<Promise<void>>();

  async settled(): Promise<void> {
    while (this.pendingAlerts.size) await Promise.all([...this.pendingAlerts]);
  }

  /**
   * The one downstream path of both routes: de-duplicate -> store -> alert (or defer it in quiet
   * hours). `stored` also for a duplicate (nothing written, nothing alerted). The auto-approve
   * sweep (admin service) picks the record up from the store like any other pending request.
   */
  private async accept(
    input: SignupInput,
    now: number,
    awaitNotify: boolean,
    origin?: 'web',
  ): Promise<'stored' | 'unavailable'> {
    // Duplicate address already waiting or accepted: answer as success, store and notify nothing.
    // Atomic (mutex + hash-keyed O_EXCL marker in the store), so concurrent posts give one record.
    let rec: SignupRecord;
    try {
      const r = await (origin
        ? this.d.store.createIfNew(input, { origin })
        : this.d.store.createIfNew(input));
      if (!r.created) {
        this.d.log?.('signup: duplicate ignored');
        // G1-AUTO-VERIFY: a web duplicate of a waiting unverified request asks for a new link
        // (the admin sweep applies every mail limit). Detached: the answer stays the same.
        if (origin && this.d.web && this.d.verify) {
          const id = r.record.id;
          this.later(() => this.d.store.writeResendMarker(id), 'resend');
        }
        return 'stored';
      }
      rec = r.record;
      count(this.d.counters, 'signup_submitted');
    } catch (e) {
      this.d.log?.(`signup: store failed (${e instanceof StoreError ? e.code : errorClass(e)})`);
      return 'unavailable';
    }
    if (this.d.notifier && isQuiet(now, this.d.quiet ?? null)) {
      // Stored now, alerted when quiet hours end (drainNotifications).
      try {
        await this.d.store.markNotifyPending(rec.id);
      } catch (e) {
        // Never lost silently: kept in memory, the marker is written again by the next drain, and
        // when quiet hours end the alert is sent from memory if the marker still could not be.
        // (Only a restart before either happens loses it; the request stays in the admin list.)
        this.unpersisted.add(rec.id);
        this.d.log?.(`signup: notify defer failed (${errorClass(e)}); kept in memory`);
      }
    } else if (this.d.notifier) {
      const notifier = this.d.notifier;
      const send = async () => {
        try {
          await notifier.notify({ name: rec.name, role: rec.role });
          await this.d.store.markNotified(rec.id);
        } catch (e) {
          // The request is stored; the owner sees it in the admin list. Error class only.
          this.d.log?.(`signup: notify failed (${errorClass(e)})`);
        }
      };
      // The web route does not wait for the alert: a new address must not answer measurably
      // slower than a known one (the network round trip would reveal it). Same alert, same logs.
      if (awaitNotify) await send();
      else {
        const p: Promise<void> = send().finally(() => this.pendingAlerts.delete(p));
        this.pendingAlerts.add(p);
      }
    }
    return 'stored';
  }

  private draining = false;
  /** Deferred alerts whose marker could not be written (see submit). */
  private readonly unpersisted = new Set<string>();

  /**
   * Sends the alerts deferred by quiet hours, once the window is over. The deferral marker is
   * removed BEFORE the send (a crash or a failure never causes a second alert; a failed alert is
   * not retried, as for an immediate one). Requests already decided by the owner are not alerted.
   * Deferrals whose marker write failed are retried on every call (also inside quiet hours) and,
   * once quiet hours are over, sent from memory if the marker still is not there.
   * Returns the number of alerts attempted.
   */
  async drainNotifications(): Promise<number> {
    const now = (this.d.now ?? Date.now)();
    if (!this.d.notifier || this.draining) return 0;
    this.draining = true;
    let n = 0;
    try {
      for (const id of [...this.unpersisted]) {
        try {
          await this.d.store.markNotifyPending(id);
          this.unpersisted.delete(id);
        } catch {
          /* still in memory; logged once at submit */
        }
      }
      if (isQuiet(now, this.d.quiet ?? null)) return 0;
      const records = await this.d.store.list();
      // An id leaves memory only once handled (a throw mid-loop keeps the unhandled ones); ids whose
      // record is gone are dropped after a successful list.
      const present = new Set(records.map((r) => r.id));
      for (const id of [...this.unpersisted]) if (!present.has(id)) this.unpersisted.delete(id);
      for (const r of records) {
        const inMemory = this.unpersisted.has(r.id);
        if (!r.notifyPending && !inMemory) continue;
        if (r.notifyPending) await this.d.store.clearNotifyPending(r.id);
        if (r.notified || r.status !== 'pending') {
          this.unpersisted.delete(r.id);
          continue;
        }
        n++;
        try {
          await this.d.notifier.notify({ name: r.name, role: r.role });
          await this.d.store.markNotified(r.id);
        } catch (e) {
          this.d.log?.(`signup: notify failed (${errorClass(e)})`);
        }
        this.unpersisted.delete(r.id);
      }
    } catch (e) {
      this.d.log?.(`signup: notify drain failed (${errorClass(e)})`);
    } finally {
      this.draining = false;
    }
    return n;
  }
}

// ---------------------------------------------------------------- owner side

export type AddOutcome = 'done' | 'exists' | 'pending' | 'cap_reached' | 'error';

/** The existing account-add path (admin spool -> root helper), behind an interface. */
export interface AccountAdder {
  add(email: string, displayName: string | null): Promise<AddOutcome>;
}

/**
 * G1-AUTO-VERIFY, verified mode only (verifyState.ts `Verifier`): the admin-only binding of the
 * approval mail to the address the account was added for. The record lives in the intake-owned
 * store, so its address may change after the account request; the mail goes out only while the
 * record's current address is the bound one.
 */
export interface ApprovalMailBinding {
  /** Stores the hash of the address an account was just added for. Throws on failure. */
  bindApproval(id: string, email: string): Promise<void>;
  /** `ok`, else a class code; `needProof` (auto approvals) also requires the recorded confirmation. */
  checkApproval(id: string, email: string, needProof: boolean): Promise<string>;
  /**
   * Whether the admin state holds a binding for `id` at all (any address). Throws when the state
   * cannot be read or its dirs are unsafe (the caller then refuses: `unbound_state`).
   */
  hasApproval(id: string): Promise<boolean>;
}

export type ApproveOutcome =
  | { ok: true; record: SignupRecord; note?: 'already_done' | 'email_not_resent' | 'email_queued' }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'bad_state'
        | 'account_pending'
        | 'cap_reached'
        | 'account_error'
        | 'email_failed'
        | 'email_failed_use_resend'
        | 'mail_cap'
        | 'unbound_state';
      record?: SignupRecord;
    };

export class SignupApprover {
  constructor(
    private readonly d: {
      store: PendingStore;
      accounts: AccountAdder;
      email: EmailSender;
      /** Quiet hours for applicant emails (null / unset: send at once). */
      quiet?: QuietWindow | null;
      now?: () => number;
      log?: (line: string) => void;
      /** BETA-G1: the auto-approve sweep's approver; its audit lines are marked `actor=auto`. */
      actor?: 'auto';
      /** K12: funnel counters (`signup_approved`, once per request); null / unset = off. */
      counters?: FunnelSink | null;
      /**
       * G1-AUTO-VERIFY verified mode: the approval mail goes only to the bound address and
       * carries no sign-up name (intake-rewritable text). Unset = unchanged behaviour.
       */
      mailBinding?: ApprovalMailBinding | null;
      /**
       * The owner's own approver: an explicit approve / resend of a request with no binding binds
       * the address the owner is looking at (the drain and auto-approve never do).
       */
      ownerActions?: boolean;
      /**
       * The drain and the auto approver only (never the owner's approver): whether applicant mail
       * must wait (`auto-approve.paused`; an error counts as paused). While paused, mails of
       * automatic approvals and queued mails of auto-approved requests stay `email_queued`; the
       * owner's queued mails go.
       */
      paused?: () => Promise<boolean>;
    },
  ) {}

  /** Append-only audit line (id, action, outcome class); a failing audit write is logged, never silent. */
  private async audited(id: string, action: string, out: ApproveOutcome): Promise<ApproveOutcome> {
    const outcome = out.ok ? (out.note ?? 'ok') : out.code;
    try {
      await (this.d.actor
        ? this.d.store.audit(id, action, outcome, this.d.actor)
        : this.d.store.audit(id, action, outcome));
    } catch (e) {
      this.d.log?.(`signup: audit write failed (${errorClass(e)})`);
    }
    return out;
  }

  /**
   * One operation per id at a time (a double click cannot add or send twice); the lock is shared
   * with every approver instance and with the store's purge (locks.ts).
   */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return serialById(id, fn);
  }

  list(): Promise<SignupRecord[]> {
    return this.d.store.list();
  }

  approve(id: string): Promise<ApproveOutcome> {
    return this.serial(id, async () => this.audited(id, 'approve', await this.doApprove(id)));
  }

  reject(id: string): Promise<ApproveOutcome> {
    return this.serial(id, async () => this.audited(id, 'reject', await this.doReject(id)));
  }

  private async doReject(id: string): Promise<ApproveOutcome> {
    const r = await this.load(id);
    if (!r) return { ok: false, code: 'not_found' };
    if (r.status === 'rejected') return { ok: true, record: r, note: 'already_done' };
    if (r.status !== 'pending') return { ok: false, code: 'bad_state', record: r };
    return { ok: true, record: await this.d.store.update(id, { status: 'rejected' }) };
  }

  /**
   * K12: the owner deletes a request now (PendingStore.deleteNow: own per-id lock and audit line).
   * Only the request is removed; an account already added is not touched (disable it separately).
   */
  remove(id: string): Promise<DeleteOutcome> {
    return this.d.store.deleteNow(id);
  }

  /** Explicit resend: only after a failed (or interrupted) send, and only for an added account. */
  resend(id: string): Promise<ApproveOutcome> {
    return this.serial(id, async () => this.audited(id, 'resend', await this.doResend(id)));
  }

  private async doResend(id: string): Promise<ApproveOutcome> {
    {
      let r = await this.load(id);
      if (!r) return { ok: false, code: 'not_found' };
      if (!r.accountAdded || r.status === 'rejected' || r.status === 'pending')
        return { ok: false, code: 'bad_state', record: r };
      const unbound = await this.unboundProgress(r);
      if (unbound) {
        if (!unbound.ok) return unbound;
        r = unbound.record;
      }
      if (r.status === 'email_sent') return { ok: true, record: r, note: 'already_done' };
      if (r.status === 'email_queued') return { ok: true, record: r, note: 'email_queued' };
      return this.send(r, false, true);
    }
  }

  /**
   * Verified mode only (BETA-G1 fix 1). A record that SAYS its account was added (`accountAdded`,
   * or status approved / email_failed / email_queued) is intake-owned text: only the admin's own
   * binding (`approvedAddr`, written right after a successful account request) proves it. With no
   * binding the account request runs again (an existing account answers `exists`, which counts as
   * added) and the binding is written; if that cannot be done the action is refused
   * (`unbound_state`) and nothing is sent. A web request marked `email_sent` is checked the same
   * way (the caller then answers `already_done`, with no mail). Returns null when nothing had to be done (bound, not
   * verified mode, or a record that claims no progress), else the outcome or the refreshed record.
   * This only stops intake LOGIC bugs (a wrong field write): while the intake and the admin share
   * one unix user, no code here can protect against a compromised intake (see the runbook).
   */
  private async unboundProgress(
    r: SignupRecord,
  ): Promise<{ ok: true; record: SignupRecord } | (ApproveOutcome & { ok: false }) | null> {
    const b = this.d.mailBinding;
    if (!b) return null;
    // A sent mail needs the check only on a web request.
    const claims =
      r.status === 'email_sent'
        ? r.origin === 'web'
        : r.accountAdded ||
          r.status === 'approved' ||
          r.status === 'email_failed' ||
          r.status === 'email_queued';
    // `approved` without `accountAdded` takes the normal account step in doApprove.
    if (!claims || (r.status === 'approved' && !r.accountAdded)) return null;
    const bound = await b.hasApproval(r.id).catch(() => null);
    if (bound === true) return null;
    const refuse = (why: string) => {
      this.d.log?.(`signup: unbound record state refused (${why})`);
      return { ok: false as const, code: 'unbound_state' as const, record: r };
    };
    if (bound === null) return refuse('state_unreadable');
    const addEmail = r.email;
    const out = await this.d.accounts.add(addEmail, r.name);
    if (out === 'pending') return { ok: false, code: 'account_pending', record: r };
    if (out !== 'done' && out !== 'exists') return refuse(`account_${out}`);
    try {
      await b.bindApproval(r.id, addEmail);
    } catch (e) {
      return refuse(`bind_${errorClass(e)}`);
    }
    if (r.accountAdded) return { ok: true, record: r };
    const rec = await this.d.store.update(r.id, { accountAdded: true, ...this.ownerMark() });
    // Counted exactly once per request, as in doApprove: `accountAdded` was not set before.
    count(this.d.counters, 'signup_approved');
    return { ok: true, record: rec };
  }

  /**
   * BETA-G1: the owner's own approver records that it added the account (display only, never
   * read for a decision); `autoApprovedAt` is left as written.
   */
  private ownerMark(): { approvedBy?: 'owner' } {
    return this.d.ownerActions && this.d.actor !== 'auto' ? { approvedBy: 'owner' } : {};
  }

  private async load(id: string): Promise<SignupRecord | null> {
    try {
      return await this.d.store.get(id);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'not_found') return null;
      throw e;
    }
  }

  private async doApprove(id: string): Promise<ApproveOutcome> {
    let r = await this.load(id);
    if (!r) return { ok: false, code: 'not_found' };
    if (r.status === 'rejected') return { ok: false, code: 'bad_state', record: r };
    const unbound = await this.unboundProgress(r);
    if (unbound) {
      if (!unbound.ok) return unbound;
      r = unbound.record;
    }
    // After the binding check: a web row's "sent" is intake-owned text too. Nothing is mailed.
    if (r.status === 'email_sent') return { ok: true, record: r, note: 'already_done' };
    if (r.status === 'email_queued') return { ok: true, record: r, note: 'email_queued' };
    if (r.status === 'email_failed')
      return { ok: false, code: 'email_failed_use_resend', record: r };
    if (r.status === 'pending')
      r = await this.d.store.update(id, { status: 'approved', lastError: null });
    if (!r.accountAdded) {
      const addEmail = r.email;
      const out = await this.d.accounts.add(addEmail, r.name);
      if (out === 'pending') return { ok: false, code: 'account_pending', record: r };
      if (out === 'cap_reached' || out === 'error') {
        r = await this.d.store.update(id, { status: 'pending', lastError: out });
        return {
          ok: false,
          code: out === 'cap_reached' ? 'cap_reached' : 'account_error',
          record: r,
        };
      }
      // Verified mode: bind the mail to the address the account was added for (admin state).
      if (this.d.mailBinding)
        await this.d.mailBinding.bindApproval(id, addEmail).catch((e: unknown) => {
          this.d.log?.(`signup: approval mail binding not written (${errorClass(e)})`);
        });
      r = await this.d.store.update(id, { accountAdded: true, ...this.ownerMark() });
      // Counted exactly once per request: `accountAdded` is set once and never cleared.
      count(this.d.counters, 'signup_approved');
    }
    // A send was attempted before and its outcome is unknown: never repeat it automatically.
    if (r.emailAttemptedAt) return { ok: true, record: r, note: 'email_not_resent' };
    return this.send(r, false, true);
  }

  /**
   * Verified mode, on the very record whose address is mailed: `ok` or the refusal class.
   * `explicit` = an approve / resend call (never the drain); only the owner's approver may then
   * bind a request that has no binding yet.
   */
  private async mailCheck(r: SignupRecord, explicit: boolean): Promise<string> {
    const b = this.d.mailBinding!;
    const c = await b.checkApproval(r.id, r.email, this.d.actor === 'auto').catch(() => 'unbound');
    if (c !== 'unbound' || !explicit || !this.d.ownerActions || this.d.actor === 'auto') return c;
    return b.bindApproval(r.id, r.email).then(
      () => 'ok',
      () => 'unbound',
    );
  }

  /**
   * Sends the approval email, or, inside quiet hours, persists `email_queued` with its send time
   * (no attempt is recorded). `force` is the drain, which has already checked the window.
   */
  private async send(r: SignupRecord, force = false, explicit = false): Promise<ApproveOutcome> {
    const nowMs = (this.d.now ?? Date.now)();
    if (!force && isQuiet(nowMs, this.d.quiet ?? null)) {
      // BETA-G1: the owner's explicit approve / resend binds and checks BEFORE it queues, so a
      // failed bind is refused now (never ok / queued). The drain (`force`) and the auto
      // approver never bind.
      if (this.d.mailBinding && explicit && this.d.ownerActions && this.d.actor !== 'auto') {
        const c = await this.mailCheck(r, true);
        if (c !== 'ok') {
          this.d.log?.(`signup: approval mail refused before queueing (${c})`);
          return { ok: false, code: 'unbound_state', record: r };
        }
      }
      const q = await this.d.store.update(r.id, {
        status: 'email_queued',
        emailSendAfter: new Date(nextSendAt(nowMs, this.d.quiet ?? null)).toISOString(),
        lastError: null,
      });
      return { ok: true, record: q, note: 'email_queued' };
    }
    // The kill switch: automatic approval, and the drain of an auto-approved request.
    const paused = this.d.paused;
    const held =
      paused && (this.d.actor === 'auto' || (!explicit && r.autoApprovedAt))
        ? () => paused().catch(() => true)
        : undefined;
    const attemptedBefore = r.emailAttemptedAt;
    // A held mail waits, due at once: no attempt, no failure; the drain sends it after resume.
    const hold = async (cur: SignupRecord, emailAttempts: number): Promise<ApproveOutcome> => ({
      ok: true,
      record: await this.d.store.update(cur.id, {
        status: 'email_queued',
        emailSendAfter: new Date(nowMs).toISOString(),
        emailAttemptedAt: attemptedBefore,
        emailAttempts,
        lastError: null,
      }),
      note: 'email_queued',
    });
    // Before any attempt is recorded or a mail slot is reserved.
    if (held && (await held())) return hold(r, r.emailAttempts);
    const at = new Date(nowMs).toISOString();
    // Persist the attempt BEFORE sending. A drained (queued) record also leaves `email_queued` in
    // the same write: if the process dies after the provider accepted the mail but before
    // `email_sent` is saved, the record is `approved` with an attempt recorded, so no later drain
    // sends it again (approve answers email_not_resent; the owner decides).
    r = await this.d.store.update(r.id, {
      ...(r.status === 'email_queued' ? { status: 'approved' as const, emailSendAfter: null } : {}),
      emailAttemptedAt: at,
      emailAttempts: r.emailAttempts + 1,
    });
    if (this.d.mailBinding) {
      const c = await this.mailCheck(r, explicit);
      if (c !== 'ok') {
        this.d.log?.(`signup: approval mail refused (${c})`);
        r = await this.d.store.update(r.id, { status: 'email_failed', lastError: `mail_${c}` });
        return { ok: false, code: 'email_failed', record: r };
      }
    }
    // Again right before the send (a mail gate asks once more, after its reservation).
    if (held && (await held())) return hold(r, r.emailAttempts - 1);
    try {
      await this.d.email.sendApproval(
        {
          email: r.email,
          // Verified mode: no sign-up text in the mail (the generic greeting).
          name: this.d.mailBinding ? '' : r.name,
          lang: r.lang,
          id: r.id,
        },
        held,
      );
    } catch (e) {
      if (e instanceof MailPausedError) return hold(r, r.emailAttempts - 1);
      // S4a mail gate: refused before the provider call, nothing was sent. The mail waits
      // (`email_queued`, due when a slot frees) and is never `email_failed`; the attempt is not
      // counted. The owner's own action sees the class `mail_cap`.
      if (e instanceof MailCapError) {
        r = await this.d.store.update(r.id, {
          status: 'email_queued',
          emailSendAfter: new Date(Math.max(e.retryAt, nowMs)).toISOString(),
          emailAttempts: Math.max(0, r.emailAttempts - 1),
          lastError: 'mail_cap',
        });
        return explicit && this.d.ownerActions
          ? { ok: false, code: 'mail_cap', record: r }
          : { ok: true, record: r, note: 'email_queued' };
      }
      const code = errorClass(e);
      r = await this.d.store.update(r.id, { status: 'email_failed', lastError: code });
      return { ok: false, code: 'email_failed', record: r };
    }
    return {
      ok: true,
      record: await this.d.store.update(r.id, {
        status: 'email_sent',
        emailSendAfter: null,
        lastError: null,
      }),
    };
  }

  /**
   * Sends the approval emails whose quiet hours are over. Each record is re-read under the per-id
   * lock and sent only if it is still `email_queued` and due, so a drain and an owner action (or
   * two drains) never double-send; a failed send ends as `email_failed` (owner resends), as before.
   * Returns the number of sends attempted.
   */
  async drainEmails(): Promise<number> {
    const nowMs = (this.d.now ?? Date.now)();
    if (isQuiet(nowMs, this.d.quiet ?? null)) return 0;
    let n = 0;
    // The kill switch holds auto-approved mails (checked per record; an error = paused).
    const paused = async () => (this.d.paused ? this.d.paused().catch(() => true) : false);
    for (const c of await this.d.store.list()) {
      if (c.status !== 'email_queued') continue;
      const sent = await this.serial(c.id, async () => {
        const r = await this.load(c.id);
        if (!r || r.status !== 'email_queued' || !r.accountAdded) return false;
        if (r.autoApprovedAt && (await paused())) return false;
        if (r.emailSendAfter && Date.parse(r.emailSendAfter) > (this.d.now ?? Date.now)())
          return false;
        const out = await this.send(r, true);
        // Held by the kill switch during the send: the owner's queued mails still go.
        const queuedAgain = out.ok && out.note === 'email_queued';
        if (queuedAgain && out.record.lastError !== 'mail_cap') return false;
        await this.audited(r.id, 'drain', out);
        return queuedAgain ? 'cap' : true;
      });
      // Over the mail cap: the rest waits for the next drain (each stays `email_queued`).
      if (sent === 'cap') break;
      if (sent) n++;
    }
    return n;
  }
}
