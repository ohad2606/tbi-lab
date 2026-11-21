/**
 * TBI-022: the sign-up workflow, pure and injectable.
 *
 *   SignupIntake   the public side: verify -> limit -> validate -> de-duplicate -> store -> notify.
 *                  Holds the HMAC secret and the notifier; can only CREATE pending requests.
 *   SignupApprover the owner side (admin service): approve (existing account-add path, then the
 *                  approval email), reject, resend. Idempotent: an account is added once and an
 *                  approval email is sent once unless the owner explicitly resends after a failure.
 */
import { errorClass } from './errors.js';
import { NonceCache, verifyRequest, type VerifyFailure } from './hmac.js';
import { SlidingWindowLimiter } from './limits.js';
import type { SignupNotifier } from './notify.js';
import { isQuiet, nextSendAt, type QuietWindow } from './quietHours.js';
import type { EmailSender } from './email.js';
import { serialById } from './locks.js';
import { PendingStore, StoreError, type SignupRecord } from './store.js';
import { validateSignup } from './validate.js';

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
}

const statusOf = (_r: VerifyFailure): 401 => 401;

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
    // Duplicate address already waiting or accepted: answer as success, store and notify nothing.
    // Atomic (mutex + hash-keyed O_EXCL marker in the store), so concurrent posts give one record.
    let rec: SignupRecord;
    try {
      const r = await this.d.store.createIfNew(val.value);
      if (!r.created) {
        this.d.log?.('signup: duplicate ignored');
        return { status: 202 };
      }
      rec = r.record;
    } catch (e) {
      this.d.log?.(`signup: store failed (${e instanceof StoreError ? e.code : errorClass(e)})`);
      return { status: 503, error: 'unavailable' };
    }
    if (this.d.notifier && isQuiet(now, this.d.quiet ?? null)) {
      // Stored now, alerted when quiet hours end (drainNotifications).
      try {
        await this.d.store.markNotifyPending(rec.id);
      } catch (e) {
        this.d.log?.(`signup: notify defer failed (${errorClass(e)})`);
      }
    } else if (this.d.notifier) {
      try {
        await this.d.notifier.notify({ name: rec.name, role: rec.role });
        await this.d.store.markNotified(rec.id);
      } catch (e) {
        // The request is stored; the owner sees it in the admin list. Error class only.
        this.d.log?.(`signup: notify failed (${errorClass(e)})`);
      }
    }
    return { status: 202 };
  }

  private draining = false;

  /**
   * Sends the alerts deferred by quiet hours, once the window is over. The deferral marker is
   * removed BEFORE the send (a crash or a failure never causes a second alert; a failed alert is
   * not retried, as for an immediate one). Requests already decided by the owner are not alerted.
   * Returns the number of alerts attempted.
   */
  async drainNotifications(): Promise<number> {
    const now = (this.d.now ?? Date.now)();
    if (!this.d.notifier || this.draining || isQuiet(now, this.d.quiet ?? null)) return 0;
    this.draining = true;
    let n = 0;
    try {
      for (const r of await this.d.store.list()) {
        if (!r.notifyPending) continue;
        await this.d.store.clearNotifyPending(r.id);
        if (r.notified || r.status !== 'pending') continue;
        n++;
        try {
          await this.d.notifier.notify({ name: r.name, role: r.role });
          await this.d.store.markNotified(r.id);
        } catch (e) {
          this.d.log?.(`signup: notify failed (${errorClass(e)})`);
        }
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
        | 'email_failed_use_resend';
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
    },
  ) {}

  /** Append-only audit line (id, action, outcome class); a failing audit write is logged, never silent. */
  private async audited(id: string, action: string, out: ApproveOutcome): Promise<ApproveOutcome> {
    const outcome = out.ok ? (out.note ?? 'ok') : out.code;
    try {
      await this.d.store.audit(id, action, outcome);
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

  /** Explicit resend: only after a failed (or interrupted) send, and only for an added account. */
  resend(id: string): Promise<ApproveOutcome> {
    return this.serial(id, async () => this.audited(id, 'resend', await this.doResend(id)));
  }

  private async doResend(id: string): Promise<ApproveOutcome> {
    {
      const r = await this.load(id);
      if (!r) return { ok: false, code: 'not_found' };
      if (!r.accountAdded || r.status === 'rejected' || r.status === 'pending')
        return { ok: false, code: 'bad_state', record: r };
      if (r.status === 'email_sent') return { ok: true, record: r, note: 'already_done' };
      if (r.status === 'email_queued') return { ok: true, record: r, note: 'email_queued' };
      return this.send(r);
    }
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
    if (r.status === 'email_sent') return { ok: true, record: r, note: 'already_done' };
    if (r.status === 'rejected') return { ok: false, code: 'bad_state', record: r };
    if (r.status === 'email_queued') return { ok: true, record: r, note: 'email_queued' };
    if (r.status === 'email_failed')
      return { ok: false, code: 'email_failed_use_resend', record: r };
    if (r.status === 'pending')
      r = await this.d.store.update(id, { status: 'approved', lastError: null });
    if (!r.accountAdded) {
      const out = await this.d.accounts.add(r.email, r.name);
      if (out === 'pending') return { ok: false, code: 'account_pending', record: r };
      if (out === 'cap_reached' || out === 'error') {
        r = await this.d.store.update(id, { status: 'pending', lastError: out });
        return {
          ok: false,
          code: out === 'cap_reached' ? 'cap_reached' : 'account_error',
          record: r,
        };
      }
      r = await this.d.store.update(id, { accountAdded: true });
    }
    // A send was attempted before and its outcome is unknown: never repeat it automatically.
    if (r.emailAttemptedAt) return { ok: true, record: r, note: 'email_not_resent' };
    return this.send(r);
  }

  /**
   * Sends the approval email, or, inside quiet hours, persists `email_queued` with its send time
   * (no attempt is recorded). `force` is the drain, which has already checked the window.
   */
  private async send(r: SignupRecord, force = false): Promise<ApproveOutcome> {
    const nowMs = (this.d.now ?? Date.now)();
    if (!force && isQuiet(nowMs, this.d.quiet ?? null)) {
      const q = await this.d.store.update(r.id, {
        status: 'email_queued',
        emailSendAfter: new Date(nextSendAt(nowMs, this.d.quiet ?? null)).toISOString(),
        lastError: null,
      });
      return { ok: true, record: q, note: 'email_queued' };
    }
    const at = new Date(nowMs).toISOString();
    // Persist the attempt BEFORE sending.
    r = await this.d.store.update(r.id, {
      emailAttemptedAt: at,
      emailAttempts: r.emailAttempts + 1,
    });
    try {
      await this.d.email.sendApproval({ email: r.email, name: r.name, lang: r.lang, id: r.id });
    } catch (e) {
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
    for (const c of await this.d.store.list()) {
      if (c.status !== 'email_queued') continue;
      const sent = await this.serial(c.id, async () => {
        const r = await this.load(c.id);
        if (!r || r.status !== 'email_queued' || !r.accountAdded) return false;
        if (r.emailSendAfter && Date.parse(r.emailSendAfter) > (this.d.now ?? Date.now)())
          return false;
        await this.audited(r.id, 'drain', await this.send(r, true));
        return true;
      });
      if (sent) n++;
    }
    return n;
  }
}
