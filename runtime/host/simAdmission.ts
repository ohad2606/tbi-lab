/**
 * TBI-018 pre-s3d: how the Session Host answers a SimHostAdapter admission result (runtime/plans/simhost.ts).
 * NOT WIRED into POST /sessions yet (that is s3d); the host still refuses an enabled adapter at
 * construction. This is the one place the wiring will turn a HostAdmit into an HTTP answer:
 *
 *   - exhaustive over HostAdmit.decision and over every LimitCode (a `never` check makes a new decision
 *     or a new code a compile error here, never a silent fall-through);
 *   - 'refused' (and anything malformed or unknown at run time) can never become a start: it fails closed
 *     to 503 limit.system.unavailable;
 *   - every refusal carries a user-safe message key that exists in the EN and HE texts. Internal codes
 *     (invalid_*, lease_lost, AI-only codes that cannot occur here) are shown as limit.system.unavailable
 *     with no params, so nothing about other users' sessions or internals reaches the client. The original
 *     code is returned as `cause` for the server's own log only.
 */
import { MESSAGE_KEY, type LimitCode, type LimitError } from '../plans/limits.js';
import { MESSAGES, placeholders } from '../plans/messages.js';
import type { HostAdmit } from '../plans/simhost.js';
import type { PlanId } from '../plans/config.js';
import { PLAN_IDS } from '../plans/config.js';

/** What the client may see: a code, a message key the client renders, and the params of that text. */
export interface PublicLimit {
  code: LimitCode;
  messageKey: string;
  params: Record<string, string | number>;
}

export type RefusalStatus = 400 | 403 | 409 | 429 | 503;

export type SimAdmissionResponse =
  | { kind: 'unmetered' }
  | { kind: 'start'; sessionId: string; plan: PlanId; remainingMs: number | null }
  | { kind: 'queued'; status: 202; position: number; body: PublicLimit }
  | { kind: 'refused'; status: RefusalStatus; body: PublicLimit; cause: LimitCode | 'malformed' };

interface Mapping {
  status: RefusalStatus;
  /** the code the client sees */
  code: LimitCode;
}

const SYSTEM: Mapping = { status: 503, code: 'system_unavailable' };
const limit = (code: LimitCode): Mapping => ({ status: 429, code });

/** The public answer for a refusal reason. Exhaustive: a new LimitCode does not compile until mapped. */
export function simRefusal(code: LimitCode): Mapping {
  switch (code) {
    // sim limits: the user's own allowance or the queue; shown as they are
    case 'minutes_out':
    case 'minutes_out_free':
    case 'sim_daily':
    case 'sim_concurrent':
    case 'sim_cooldown':
    case 'queue_full':
    case 'queue_timeout':
      return limit(code);
    // the waiter was dropped for not polling: for the user it is a queue timeout, try again
    case 'queue_vanished':
      return limit('queue_timeout');
    case 'system_unavailable':
      return SYSTEM;
    // contract errors: shown as a generic, uncharged failure; never which session or why
    case 'invalid_principal':
      return { status: 403, code: 'system_unavailable' };
    case 'invalid_request':
      return { status: 400, code: 'system_unavailable' };
    case 'invalid_state':
    case 'lease_lost':
      return { status: 409, code: 'system_unavailable' };
    // 'queue' is a status, not a refusal; AI / pack codes cannot come from sim admission. If one does,
    // something is wrong: refuse as unavailable (fail closed), never start.
    case 'queue':
    case 'credits_out':
    case 'credits_out_free':
    case 'daily':
    case 'rate':
    case 'too_long':
    case 'global_off':
    case 'deep_not_in_plan':
    case 'pack_needs_plan':
      return SYSTEM;
    default: {
      const unhandled: never = code;
      void unhandled;
      return SYSTEM;
    }
  }
}

const isLimitCode = (c: unknown): c is LimitCode =>
  typeof c === 'string' && Object.hasOwn(MESSAGE_KEY, c);

/**
 * The client body for a code: the message key and only the params its text uses. A key without an EN
 * or HE text, or a missing param, fails closed to limit.system.unavailable (never a blank or guessed text).
 */
function publicLimit(code: LimitCode, params: Record<string, string | number>): PublicLimit | null {
  const key = MESSAGE_KEY[code];
  if (!key) return null;
  const en = MESSAGES.en[key];
  const he = MESSAGES.he[key];
  if (en === undefined || he === undefined) return null;
  const need = [...new Set([...placeholders(en), ...placeholders(he)])];
  const out: Record<string, string | number> = {};
  for (const k of need) {
    const v = Object.hasOwn(params ?? {}, k) ? params[k] : undefined;
    if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string') return null;
    out[k] = v as string | number;
  }
  return { code, messageKey: key, params: out };
}

const SYSTEM_BODY: PublicLimit = {
  code: 'system_unavailable',
  messageKey: 'limit.system.unavailable',
  params: {},
};

function refuse(cause: LimitCode | 'malformed', err?: LimitError): SimAdmissionResponse {
  if (cause === 'malformed') return { kind: 'refused', status: 503, body: SYSTEM_BODY, cause };
  const m = simRefusal(cause);
  const body =
    (m.code === 'system_unavailable' ? null : publicLimit(m.code, err?.params ?? {})) ??
    SYSTEM_BODY;
  return {
    kind: 'refused',
    status: body.code === 'system_unavailable' && m.code !== 'system_unavailable' ? 503 : m.status,
    body,
    cause,
  };
}

/** Turn a SimHostAdapter.admit() result into the host's answer. Only a well-formed 'start' starts a run. */
export function simAdmissionResponse(a: HostAdmit): SimAdmissionResponse {
  if (a === null || typeof a !== 'object') return refuse('malformed');
  if (a.metered === false) return { kind: 'unmetered' };
  if (a.metered !== true) return refuse('malformed');
  const decision = a.decision;
  switch (decision) {
    case 'start': {
      if (
        typeof a.sessionId !== 'string' ||
        a.sessionId === '' ||
        !PLAN_IDS.includes(a.plan) ||
        !(a.remainingMs === null || (Number.isSafeInteger(a.remainingMs) && a.remainingMs >= 0))
      )
        return refuse('malformed');
      return { kind: 'start', sessionId: a.sessionId, plan: a.plan, remainingMs: a.remainingMs };
    }
    case 'queued': {
      const body =
        Number.isSafeInteger(a.position) && a.position >= 1
          ? publicLimit('queue', { n: a.position })
          : null;
      if (!body) return refuse('malformed');
      return { kind: 'queued', status: 202, position: a.position, body };
    }
    case 'refused': {
      const err = a.error as LimitError | undefined;
      if (!err || !isLimitCode(err.code)) return refuse('malformed');
      return refuse(err.code, err);
    }
    default: {
      const unhandled: never = decision;
      void unhandled;
      return refuse('malformed');
    }
  }
}
