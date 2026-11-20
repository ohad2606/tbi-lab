/**
 * TBI-022: the sign-up workflow, pure and injectable.
 *
 *   SignupIntake   the public side: verify -> limit -> validate -> de-duplicate -> store -> notify.
 *                  Holds the HMAC secret and the notifier; can only CREATE pending requests.
 *   SignupApprover the owner side (admin service): approve (existing account-add path, then the
 *                  approval email), reject, resend. Idempotent: an account is added once and an
 *                  approval email is sent once unless the owner explicitly resends after a failure.
 */
import { NonceCache, verifyRequest, type VerifyFailure } from './hmac.js';
import { SlidingWindowLimiter } from './limits.js';
import type { SignupNotifier } from './notify.js';
import type { EmailSender } from './email.js';
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
    // Limits first: they bound the work an unauthenticated caller can cause.
    const g = this.d.globalRate.take('all');
    const s = this.d.sourceRate.take(source);
    if (!g.ok || !s.ok) {
      const retry = Math.max(g.ok ? 0 : g.retryAfterMs, s.ok ? 0 : s.retryAfterMs);
      return { status: 429, error: 'rate_limited', retryAfterMs: retry };
    }
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
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      return { status: 400, error: 'invalid' };
    }
    const val = validateSignup(raw);
    if (!val.ok) return { status: 400, error: 'invalid' };
    // Duplicate address already waiting or accepted: answer as success, store and notify nothing.
    const existing = await this.d.store.list();
    if (existing.some((r) => r.email === val.value.email && r.status !== 'rejected')) {
      this.d.log?.('signup: duplicate ignored');
      return { status: 202 };
    }
    let rec: SignupRecord;
    try {
      rec = await this.d.store.create(val.value);
    } catch (e) {
      this.d.log?.(`signup: store failed (${e instanceof StoreError ? e.code : 'error'})`);
      return { status: 503, error: 'unavailable' };
    }
    if (this.d.notifier) {
      try {
        await this.d.notifier.notify({ name: rec.name, role: rec.role });
        await this.d.store.update(rec.id, { notified: true });
      } catch (e) {
        // The request is stored; the owner sees it in the admin list. Error class only.
        this.d.log?.(`signup: notify failed (${(e as Error).message})`);
      }
    }
    return { status: 202 };
  }
}

// ---------------------------------------------------------------- owner side

export type AddOutcome = 'done' | 'exists' | 'pending' | 'cap_reached' | 'error';

/** The existing account-add path (admin spool -> root helper), behind an interface. */
export interface AccountAdder {
  add(email: string, displayName: string | null): Promise<AddOutcome>;
}

export type ApproveOutcome =
  | { ok: true; record: SignupRecord; note?: 'already_done' | 'email_not_resent' }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'bad_state'
        | 'account_pending'
        | 'cap_reached'
        | 'account_error'
        | 'email_failed';
      record?: SignupRecord;
    };

export class SignupApprover {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly d: {
      store: PendingStore;
      accounts: AccountAdder;
      email: EmailSender;
      now?: () => number;
    },
  ) {}

  /** One operation per id at a time (a double click cannot add or send twice). */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  list(): Promise<SignupRecord[]> {
    return this.d.store.list();
  }

  approve(id: string): Promise<ApproveOutcome> {
    return this.serial(id, () => this.doApprove(id));
  }

  reject(id: string): Promise<ApproveOutcome> {
    return this.serial(id, async () => {
      const r = await this.load(id);
      if (!r) return { ok: false, code: 'not_found' };
      if (r.status === 'rejected') return { ok: true, record: r, note: 'already_done' };
      if (r.status !== 'pending') return { ok: false, code: 'bad_state', record: r };
      return { ok: true, record: await this.d.store.update(id, { status: 'rejected' }) };
    });
  }

  /** Explicit resend: only after a failed (or interrupted) send, and only for an added account. */
  resend(id: string): Promise<ApproveOutcome> {
    return this.serial(id, async () => {
      const r = await this.load(id);
      if (!r) return { ok: false, code: 'not_found' };
      if (!r.accountAdded || r.status === 'rejected' || r.status === 'pending')
        return { ok: false, code: 'bad_state', record: r };
      if (r.status === 'email_sent') return { ok: true, record: r, note: 'already_done' };
      return this.send(r);
    });
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
    if (r.status === 'email_failed') return { ok: true, record: r, note: 'already_done' }; // owner uses resend
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

  private async send(r: SignupRecord): Promise<ApproveOutcome> {
    const at = new Date((this.d.now ?? Date.now)()).toISOString();
    // Persist the attempt BEFORE sending.
    r = await this.d.store.update(r.id, {
      emailAttemptedAt: at,
      emailAttempts: r.emailAttempts + 1,
    });
    try {
      await this.d.email.sendApproval({ email: r.email, name: r.name, lang: r.lang, id: r.id });
    } catch (e) {
      const code = (e as Error).message || 'error';
      r = await this.d.store.update(r.id, { status: 'email_failed', lastError: code });
      return { ok: false, code: 'email_failed', record: r };
    }
    return {
      ok: true,
      record: await this.d.store.update(r.id, { status: 'email_sent', lastError: null }),
    };
  }
}
