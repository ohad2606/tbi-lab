/**
 * Stable refusals (Sprint 8, Phase 4). Every policy refusal is one of these codes, with an HTTP
 * status and, when waiting helps, a `Retry-After`. Bodies name only the code (and the wait): never
 * another user, their usage, or whether a private artifact exists. The app maps codes to localized
 * messages.
 *
 * | code                | status | meaning                                                         |
 * |---------------------|--------|-----------------------------------------------------------------|
 * | build_quota         | 429    | this user's builds in progress/waiting are at their limit        |
 * | build_cooldown      | 429    | too many failed builds recently; wait                            |
 * | rate_limited        | 429    | too many requests of this kind recently; wait                    |
 * | builder_busy        | 503    | the shared build queue is full; wait                             |
 * | session_quota       | 429    | this user's live sessions are at their limit                     |
 * | runtime_capacity    | 503    | the host's live sessions are at capacity; wait                   |
 * | capability_disabled | 403    | the user's policy does not allow this (Advanced prebuilt binary) |
 * | storage_quota       | 403    | the user's stored artifacts are at their limit and none can go   |
 * | storage_pressure    | 503    | the host is low on disk; wait                                    |
 * | memory_pressure     | 503    | the host is low on memory; wait                                  |
 */
import type { ServerResponse } from 'node:http';
import type { Principal } from '../identity/principal.js';

export type RefusalCode =
  | 'build_quota'
  | 'build_cooldown'
  | 'rate_limited'
  | 'builder_busy'
  | 'session_quota'
  | 'runtime_capacity'
  | 'capability_disabled'
  | 'storage_quota'
  | 'storage_pressure'
  | 'memory_pressure';

export const REFUSAL_STATUS: Record<RefusalCode, number> = {
  build_quota: 429,
  build_cooldown: 429,
  rate_limited: 429,
  builder_busy: 503,
  session_quota: 429,
  runtime_capacity: 503,
  capability_disabled: 403,
  storage_quota: 403,
  storage_pressure: 503,
  memory_pressure: 503,
};

export class Refusal extends Error {
  readonly status: number;
  constructor(
    readonly code: RefusalCode,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.status = REFUSAL_STATUS[code];
  }
  get body(): { error: RefusalCode; retryAfterS?: number } {
    return this.retryAfterMs === undefined
      ? { error: this.code }
      : { error: this.code, retryAfterS: Math.ceil(this.retryAfterMs / 1000) };
  }
}

export function sendRefusal(res: ServerResponse, r: Refusal): void {
  if (res.headersSent) return;
  const text = JSON.stringify(r.body);
  res.writeHead(r.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(r.retryAfterMs !== undefined
      ? { 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) }
      : {}),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * One bounded admission event per decision, to stderr (journald): service, action, outcome and a
 * SHORT principal reference (enough to see one account hammering; not reversible, no personal
 * data). Never source, binaries, headers, tokens or emails.
 */
export function admissionEvent(
  service: 'build' | 'runtime',
  action: string,
  outcome: 'admitted' | RefusalCode,
  principal?: Principal,
): void {
  process.stderr.write(
    `${JSON.stringify({
      event: 'admission',
      service,
      action,
      outcome,
      ...(principal ? { who: principal.slice(0, 10) } : {}),
    })}\n`,
  );
}
