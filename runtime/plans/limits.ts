/** TBI-018 slice 1: refusal codes. The server returns code + params only; texts live in messages.ts. */

export type LimitCode =
  | 'credits_out'
  | 'credits_out_free'
  | 'daily'
  | 'rate'
  | 'too_long'
  | 'global_off'
  | 'system_unavailable'
  | 'deep_not_in_plan'
  | 'pack_needs_plan'
  | 'minutes_out'
  | 'minutes_out_free'
  | 'sim_daily'
  | 'queue'
  | 'queue_timeout'
  | 'queue_full'
  | 'sim_concurrent'
  | 'sim_cooldown'
  | 'queue_vanished'
  | 'queue_replaced'
  | 'lease_lost'
  | 'invalid_principal'
  | 'invalid_state'
  | 'invalid_request';

export const MESSAGE_KEY: Record<LimitCode, string | null> = {
  credits_out: 'limit.ai.credits_out',
  credits_out_free: 'limit.ai.credits_out_free',
  daily: 'limit.ai.daily',
  rate: 'limit.ai.rate',
  too_long: 'limit.ai.too_long',
  global_off: 'limit.ai.global_off',
  system_unavailable: 'limit.system.unavailable',
  deep_not_in_plan: 'limit.ai.deep_not_in_plan',
  pack_needs_plan: 'limit.pack.needs_plan',
  minutes_out: 'limit.sim.minutes_out',
  minutes_out_free: 'limit.sim.minutes_out_free',
  sim_daily: 'limit.sim.daily',
  queue: 'limit.sim.queue',
  queue_timeout: 'limit.sim.queue_timeout',
  queue_full: 'limit.sim.queue_full',
  sim_concurrent: 'limit.sim.concurrent',
  sim_cooldown: 'limit.sim.cooldown',
  // TBI-018 s3d-3b: a poll with a queue ticket that a newer tab of the same principal took over.
  queue_replaced: 'limit.sim.queue_replaced',
  // The client is gone (vanished / lease lost): nobody to show a message to.
  queue_vanished: null,
  lease_lost: null,
  // Programming/contract errors, not user-facing limits.
  invalid_principal: null,
  invalid_state: null,
  invalid_request: null,
};

export interface LimitError {
  code: LimitCode;
  messageKey: string | null;
  params: Record<string, string | number>;
}

export function limitError(
  code: LimitCode,
  params: Record<string, string | number> = {},
): LimitError {
  return { code, messageKey: MESSAGE_KEY[code], params };
}

const PRINCIPAL = /^p_[A-Za-z0-9_-]{8,}$/;
/** Key = the FULL opaque principal. An e-mail address (or anything else) is rejected. */
export function validPrincipal(p: unknown): p is string {
  return typeof p === 'string' && PRINCIPAL.test(p);
}
