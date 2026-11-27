/**
 * BETA-G1 G1-AUTO-VERIFY slice 5: the owner's read-only view of email verification. Added to the
 * existing `GET /signups*` answers (one `verification` per row) and `GET /signups/auto-approve`
 * (`safeguards`). Nothing here exists while TBI_SIGNUP_VERIFY and the mail caps are unset.
 *
 *   Sources   only admin-owned state: `verify/<id>.json`, the verify mail counters, the mail gate,
 *             the auto-approve state and the kill switch. The record mirrors (`verifySentAt`,
 *             `verifiedAt`) and the summary file are never read: the intake can write them.
 *             (`approved_auto` rests on the record's `accountAdded` + `autoApprovedAt`, as the
 *             existing badge does.)
 *   Output    a closed state and, for `sent`, the time. A `verification` key found in a record is
 *             always replaced or removed. No hash, key id, generation, address, path or error.
 *   Reads     no write, no directory created, no key loaded. Per computation: one store.list(),
 *             one dir check, at most one mail gate read, one state read per web `pending` request
 *             (at most READS at a time). Concurrent requests share a computation.
 *   Failure   anything unsafe or unreadable = `unknown` (never "not confirmed", never 0); the list
 *             and the owner's actions keep working. Logs carry class codes only, at most hourly.
 */
import { join } from 'node:path';
import { sameHash } from './verify.js';
import { AUTO_PAUSE_FILE, autoPauseCheck, autoStateDirCheck, israelDay } from './autoApprove.js';
import type { AutoApprover } from './autoApprove.js';
import { errorClass } from './errors.js';
import type { MailGate, MailLimits } from './mailGate.js';
import type { PendingStore, SignupRecord } from './store.js';
import type { AutoApproveStatusAnswer } from './admin-wiring.js';
import { addressHash, peekMailCount, peekVerifyState, verifyDirsReadOnly } from './verifyState.js';

export const VERIFICATION_STATES = [
  'not_sent',
  'sent',
  /** Confirmed, eligible, and today's automatic approval limit is used up. */
  'confirmed_waiting_limit',
  /** Confirmed and eligible with a free slot: the next automatic sweep takes it. */
  'confirmed_queued',
  /** Confirmed; nothing says it will be approved without the owner. */
  'confirmed_review',
  'address_changed',
  'approved_auto',
  'unknown',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export interface RowVerification {
  state: VerificationState;
  sentAt?: string;
}
export type ViewRow = SignupRecord & { verification?: RowVerification };

type Count = number | 'unknown';
export interface SafeguardStatus {
  /** The kill switch (any check error = paused). */
  paused: boolean;
  verify?: { today: Count; limit: number; waiting: Count };
  mail?: { day: Count; dayLimit: number; d30: Count; d30Limit: number };
}

export const READS = 16;
const LOG_MS = 3_600_000;

export interface OwnerViewDeps {
  storeDir: string;
  store: PendingStore;
  verify: { stateDir: string; maxPerDay: number } | null;
  auto: AutoApprover | null;
  autoDir: string | null;
  /** The auto-approve sweep timer of this process is active. */
  running: () => boolean;
  mail: { gate: MailGate; limits: MailLimits } | null;
  pauseDir: string | null;
  now?: () => number;
  log?: (line: string) => void;
  /** Test hooks (read counting and failures). */
  peek?: typeof peekVerifyState;
  dirCheck?: typeof autoStateDirCheck;
}

/**
 * At most one computation runs and one waits: a caller joins the waiting one, which starts after
 * the call, so a shared answer is never older than the request (e.g. after a delete).
 */
export function coalesce<T>(fn: () => Promise<T>): () => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let queued: Promise<T> | null = null;
  return () => {
    if (queued) return queued;
    const p = tail.then(() => {
      queued = null;
      return fn();
    });
    queued = p;
    tail = p.catch(() => undefined);
    return p;
  };
}

export function ownerView(d: OwnerViewDeps): {
  rows?: () => Promise<ViewRow[]>;
  status: () => Promise<AutoApproveStatusAnswer>;
} {
  const logged = new Map<string, number>();
  const log = (what: string) => {
    const t = (d.now ?? Date.now)();
    const last = logged.get(what);
    if (last !== undefined && t >= last && t - last < LOG_MS) return;
    logged.set(what, t);
    try {
      d.log?.(`signup: owner view unknown (${what})`);
    } catch {
      /* logging never changes the answer */
    }
  };
  const dirCheck = d.dirCheck ?? autoStateDirCheck;
  const peek = d.peek ?? peekVerifyState;

  /** The one dir check of a computation, and what it says about the auto-approve dir. */
  async function dirs() {
    const v = d.verify!;
    const stateBad = await dirCheck(v.stateDir).catch(() => 'error');
    const bad = await verifyDirsReadOnly(v.stateDir, d.storeDir, stateBad).catch(() => 'error');
    if (bad) log('state_dir_unsafe');
    // undefined = a different dir: the approver checks its own.
    return { bad, autoBad: d.autoDir === v.stateDir ? stateBad : undefined };
  }

  /** The state of every web `pending` request, by id. */
  async function rowStates(
    records: SignupRecord[],
    checked: Awaited<ReturnType<typeof dirs>>,
  ): Promise<Map<string, RowVerification>> {
    const out = new Map<string, RowVerification>();
    const todo = records.filter(
      (r) => r.status === 'pending' && r.origin === 'web' && !(r.accountAdded && r.autoApprovedAt),
    );
    const facts =
      !checked.bad && todo.length > 0 && d.auto && d.running()
        ? await d.auto.queueFacts(checked.autoBad).catch(() => null)
        : null;
    const one = async (r: SignupRecord): Promise<RowVerification> => {
      if (checked.bad) return { state: 'unknown' };
      try {
        const s = await peek(d.verify!.stateDir, r.id);
        if (s.confirmed) {
          const h = addressHash(r.email);
          if (!h || !sameHash(h, s.confirmed.addr)) return { state: 'address_changed' };
          if (!facts || !facts.eligible(r) || !(s.confirmed.at > facts.since))
            return { state: 'confirmed_review' };
          return { state: facts.capReached ? 'confirmed_waiting_limit' : 'confirmed_queued' };
        }
        return s.sentAt
          ? { state: 'sent', sentAt: new Date(Date.parse(s.sentAt)).toISOString() }
          : { state: 'not_sent' };
      } catch {
        log('state_unreadable');
        return { state: 'unknown' };
      }
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(READS, todo.length) }, async () => {
        for (let r = todo[next++]; r; r = todo[next++]) out.set(r.id, await one(r));
      }),
    );
    return out;
  }

  const rows = coalesce(async (): Promise<ViewRow[]> => {
    const records = await d.store.list();
    let states = new Map<string, RowVerification>();
    let failed = false;
    try {
      states = await rowStates(records, await dirs());
    } catch (e) {
      failed = true;
      log(errorClass(e));
    }
    return records.map((r) => {
      const row: ViewRow = { ...r };
      delete row.verification;
      const v: RowVerification | undefined =
        r.accountAdded === true && typeof r.autoApprovedAt === 'string' && r.autoApprovedAt
          ? { state: 'approved_auto' }
          : (states.get(r.id) ??
            (failed && r.status === 'pending' && r.origin === 'web'
              ? { state: 'unknown' }
              : undefined));
      if (v) row.verification = v;
      return row;
    });
  });

  const status = coalesce(async (): Promise<AutoApproveStatusAnswer> => {
    let listing: Promise<SignupRecord[]> | undefined;
    const list = () => (listing ??= d.store.list());
    const checked = d.verify
      ? await dirs().catch(() => ({ bad: 'error', autoBad: undefined }))
      : null;
    const base: AutoApproveStatusAnswer = d.auto
      ? {
          enabled: true,
          running: d.running(),
          ...(await d.auto.status({
            list,
            ...(checked?.autoBad !== undefined ? { dirBad: checked.autoBad } : {}),
          })),
        }
      : { enabled: false };
    const safeguards: SafeguardStatus = {
      paused: d.pauseDir
        ? await autoPauseCheck(join(d.pauseDir, AUTO_PAUSE_FILE)).then(
            (p) => p.paused,
            () => true,
          )
        : false,
    };
    if (d.verify) {
      let today: Count = 'unknown';
      let waiting: Count = 'unknown';
      try {
        if (!checked!.bad) {
          const day = israelDay((d.now ?? Date.now)());
          const n = await peekMailCount(d.verify.stateDir, day);
          if (n === null) log('counters_unreadable');
          else today = n;
          const states = [...(await rowStates(await list(), checked!)).values()];
          if (!states.some((s) => s.state === 'unknown'))
            waiting = states.filter((s) => s.state.startsWith('confirmed_')).length;
        }
      } catch (e) {
        log(errorClass(e));
      }
      safeguards.verify = { today, limit: d.verify.maxPerDay, waiting };
    }
    if (d.mail) {
      const used = await d.mail.gate.usage().catch(() => null);
      if (!used) log('mail_gate_unreadable');
      safeguards.mail = {
        day: used ? used.day : 'unknown',
        dayLimit: d.mail.limits.perDay,
        d30: used ? used.d30 : 'unknown',
        d30Limit: d.mail.limits.per30d,
      };
    }
    return { ...base, safeguards };
  });

  return { ...(d.verify ? { rows } : {}), status };
}
