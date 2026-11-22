/**
 * TBI-017 slice 1 (DEV-Lab builds only): the typed browser client of the TBI Lab AI service
 * (`/assist/v1/*`, same origin, behind the gate). Design note docs/design/TBI-017-ai-assistant-ui.md §9.
 *
 * Security rules this module holds:
 * - The browser never holds a provider key and never calls a provider: it talks only to the TBI
 *   service, through `gateFetch` (no login is ever started by these background requests).
 * - The explain request has EXACTLY the documented keys `{contract, locale, consent, context}`
 *   (the service rejects any other key); nothing else about the user or the project is added.
 * - Every call takes an AbortSignal; an abort is reported as `cancelled`, never thrown.
 * - Nothing throws to the UI: a network failure is `offline`, a non-JSON or unknown answer is
 *   `unavailable` (status) or `other` (preview/explain); unknown error codes map to `other`.
 * - The client never retries on its own (the user does, after `retryAfterMs`).
 */
import {
  EXPLAIN_CONTRACT,
  type Accounting,
  type EngineeringContext,
  type ExplainResponse,
  type Finding,
} from '@tbi-lab/assist';
import { gateFetch } from '../gate.js';

export const ASSIST_BASE = '/assist/v1';
export const ASSIST_PROTOCOL = 'tbi-lab.assist-service/1';

export interface ServiceStatus {
  state: 'active' | 'disabled';
  reasons: string[];
  mode?: 'live' | 'mock';
  provider?: string;
  model?: string;
  pilot: boolean;
  consentVersion: string;
  /**
   * An opaque account reference for the consent store, when the service gives one (an additive
   * field it does not send today). Never an email or a name: anything else is ignored.
   */
  account?: string;
  data: { sent: string[]; neverSent: string[]; auditRetentionDays: number };
}

export type StatusResult = { kind: 'unavailable' } | { kind: 'ok'; status: ServiceStatus };

/** The error codes the UI knows (service §9 + client-side `offline`/`other`). */
export const EXPLAIN_ERRORS = [
  'unauthenticated',
  'not_pilot',
  'pilot_disabled',
  'consent_required',
  'bad_request',
  'context_too_large',
  'rate_limited',
  'busy',
  'daily_limit',
  'spend_cap',
  'token_ceiling',
  'cancelled',
  'timeout',
  'provider_error',
  'invalid_response',
  'unavailable',
  'internal',
  'offline',
  'other',
] as const;
export type ExplainErrorCode = (typeof EXPLAIN_ERRORS)[number];

/** A TBI-018 limit refusal (parsed here; its UI is slice 2). */
export interface LimitInfo {
  code: string;
  messageKey: string;
  params: Record<string, string | number>;
}

export interface ClientError {
  ok: false;
  /** HTTP status, 0 when no answer arrived (offline, cancelled). */
  status: number;
  error: ExplainErrorCode;
  /** The raw code when it was not a known one (kept for diagnostics, never shown as text). */
  rawError?: string;
  retryAfterMs?: number;
  limit?: LimitInfo;
  message?: { he: string; en: string };
}

export interface ExplainOk {
  ok: true;
  findings: Finding[];
  response: ExplainResponse;
  unexplained: string[];
  accounting: Accounting;
}
export type ExplainResult = ExplainOk | ClientError;

export interface PreviewOk {
  ok: true;
  payload: { system: string; user: string };
  bytes: number;
  estimatedInputTokens: number;
}
export type PreviewResult = PreviewOk | ClientError;

/** The explain request body, and nothing more (the service refuses unknown keys). */
export interface ExplainRequestBody {
  contract: typeof EXPLAIN_CONTRACT;
  locale: string;
  consent: { version: string; accepted: true };
  context: EngineeringContext;
}

export function explainBody(
  locale: string,
  consentVersion: string,
  context: EngineeringContext,
): ExplainRequestBody {
  return {
    contract: EXPLAIN_CONTRACT,
    locale,
    consent: { version: consentVersion, accepted: true },
    context,
  };
}

export type FetchFn = typeof fetch;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
const OPAQUE = /^[A-Za-z0-9._-]{1,64}$/;

/** The body as JSON, or null when the answer is not JSON (a gate page, an HTML fallback). */
async function jsonOf(r: Response): Promise<unknown> {
  if (!/^application\/json\b/i.test(r.headers.get('content-type') ?? '')) return null;
  try {
    return (await r.json()) as unknown;
  } catch {
    return null;
  }
}

/** The service status, strictly checked; any other shape is `unavailable`. */
export function parseStatus(b: unknown): StatusResult {
  if (!isObj(b)) return { kind: 'unavailable' };
  if (b.protocol !== undefined && b.protocol !== ASSIST_PROTOCOL) return { kind: 'unavailable' };
  if (b.state !== 'active' && b.state !== 'disabled') return { kind: 'unavailable' };
  if (typeof b.pilot !== 'boolean') return { kind: 'unavailable' };
  if (typeof b.consentVersion !== 'string' || !OPAQUE.test(b.consentVersion))
    return { kind: 'unavailable' };
  const d = b.data;
  if (
    !isObj(d) ||
    !isStrArr(d.sent) ||
    !isStrArr(d.neverSent) ||
    typeof d.auditRetentionDays !== 'number' ||
    !Number.isFinite(d.auditRetentionDays) ||
    d.auditRetentionDays < 0
  )
    return { kind: 'unavailable' };
  const status: ServiceStatus = {
    state: b.state,
    reasons: isStrArr(b.reasons) ? b.reasons : [],
    pilot: b.pilot,
    consentVersion: b.consentVersion,
    data: { sent: d.sent, neverSent: d.neverSent, auditRetentionDays: d.auditRetentionDays },
  };
  if (b.mode === 'live' || b.mode === 'mock') status.mode = b.mode;
  if (typeof b.provider === 'string') status.provider = b.provider;
  if (typeof b.model === 'string') status.model = b.model;
  if (typeof b.account === 'string' && OPAQUE.test(b.account)) status.account = b.account;
  return { kind: 'ok', status };
}

/**
 * The runtime feature flag (design §8): the AI explanation is offered only when the service says
 * it is active and this account is allowed (the pilot list; a plan later). Default OFF: no
 * answer, a wrong answer or any other state means off. The build-time gate (DEV-Lab builds only)
 * stays in front of this.
 */
export function aiEnabled(s: StatusResult): s is { kind: 'ok'; status: ServiceStatus } {
  return s.kind === 'ok' && s.status.state === 'active' && s.status.pilot;
}

/** An error body as a typed error (unknown codes map to `other`). */
export function parseError(httpStatus: number, b: unknown): ClientError {
  const raw = isObj(b) && typeof b.error === 'string' ? b.error : '';
  const known = (EXPLAIN_ERRORS as readonly string[]).includes(raw);
  const out: ClientError = {
    ok: false,
    status: httpStatus,
    error: known ? (raw as ExplainErrorCode) : httpStatus === 401 ? 'unauthenticated' : 'other',
  };
  if (raw && !known) out.rawError = raw.slice(0, 64);
  if (isObj(b)) {
    const ra = b.retryAfterMs;
    if (typeof ra === 'number' && Number.isFinite(ra) && ra >= 0)
      out.retryAfterMs = Math.min(ra, 24 * 3_600_000);
    const l = b.limit;
    if (isObj(l) && typeof l.code === 'string' && typeof l.messageKey === 'string') {
      const params: Record<string, string | number> = {};
      if (isObj(l.params))
        for (const [k, v] of Object.entries(l.params))
          if (typeof v === 'string' || typeof v === 'number') params[k] = v;
      out.limit = { code: l.code, messageKey: l.messageKey, params };
    }
    const m = b.message;
    if (isObj(m) && typeof m.he === 'string' && typeof m.en === 'string')
      out.message = { he: m.he, en: m.en };
  }
  return out;
}

function isAccounting(v: unknown): v is Accounting {
  return (
    isObj(v) &&
    typeof v.provider === 'string' &&
    typeof v.model === 'string' &&
    typeof v.inputTokens === 'number' &&
    typeof v.outputTokens === 'number' &&
    typeof v.costUsd === 'number' &&
    typeof v.latencyMs === 'number'
  );
}

/** A 200 explain answer, strictly checked (a wrong shape is `other`, never rendered). */
export function parseExplainOk(b: unknown): ExplainResult {
  if (
    !isObj(b) ||
    !Array.isArray(b.findings) ||
    !isObj(b.response) ||
    !Array.isArray(b.response.explanations) ||
    !b.response.explanations.every(
      (e) =>
        isObj(e) &&
        typeof e.finding === 'string' &&
        typeof e.text === 'string' &&
        isStrArr(e.cites),
    ) ||
    (b.response.summary !== undefined &&
      !(isObj(b.response.summary) && typeof b.response.summary.text === 'string')) ||
    (b.response.declined !== undefined &&
      !(
        Array.isArray(b.response.declined) &&
        b.response.declined.every(
          (d) =>
            isObj(d) &&
            typeof d.finding === 'string' &&
            (d.reason === 'insufficient_evidence' || d.reason === 'out_of_scope'),
        )
      )) ||
    !b.findings.every((f) => isObj(f) && typeof f.key === 'string') ||
    !isStrArr(b.unexplained) ||
    !isAccounting(b.accounting)
  )
    return { ok: false, status: 200, error: 'other' };
  return {
    ok: true,
    findings: b.findings as Finding[],
    response: b.response as unknown as ExplainResponse,
    unexplained: b.unexplained,
    accounting: b.accounting,
  };
}

function failure(e: unknown, signal?: AbortSignal): ClientError {
  return { ok: false, status: 0, error: isAbort(e) || signal?.aborted ? 'cancelled' : 'offline' };
}

async function post(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  fetchFn?: FetchFn,
): Promise<{ r: Response; b: unknown } | ClientError> {
  try {
    const r = await gateFetch(
      `${ASSIST_BASE}${path}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
      undefined,
      fetchFn,
    );
    return { r, b: await jsonOf(r) };
  } catch (e) {
    return failure(e, signal);
  }
}

export async function getStatus(signal?: AbortSignal, fetchFn?: FetchFn): Promise<StatusResult> {
  try {
    const r = await gateFetch(
      `${ASSIST_BASE}/status`,
      { credentials: 'same-origin', signal },
      undefined,
      fetchFn,
    );
    if (!r.ok) return { kind: 'unavailable' };
    return parseStatus(await jsonOf(r));
  } catch {
    return { kind: 'unavailable' };
  }
}

/** What the service would send to the provider (nothing goes to a provider; no consent needed). */
export async function postPreview(
  context: EngineeringContext,
  locale: string,
  signal?: AbortSignal,
  fetchFn?: FetchFn,
): Promise<PreviewResult> {
  const res = await post('/preview', { locale, context }, signal, fetchFn);
  if ('ok' in res) return res;
  const { r, b } = res;
  if (!r.ok) return parseError(r.status, b);
  if (
    !isObj(b) ||
    !isObj(b.payload) ||
    typeof b.payload.system !== 'string' ||
    typeof b.payload.user !== 'string' ||
    typeof b.bytes !== 'number' ||
    typeof b.estimatedInputTokens !== 'number'
  )
    return { ok: false, status: r.status, error: 'other' };
  return {
    ok: true,
    payload: { system: b.payload.system, user: b.payload.user },
    bytes: b.bytes,
    estimatedInputTokens: b.estimatedInputTokens,
  };
}

/** One explanation, with the consent of the version the service announced. */
export async function postExplain(
  body: ExplainRequestBody,
  signal?: AbortSignal,
  fetchFn?: FetchFn,
): Promise<ExplainResult> {
  const res = await post('/explain', body, signal, fetchFn);
  if ('ok' in res) return res;
  const { r, b } = res;
  if (!r.ok) return parseError(r.status, b);
  return parseExplainOk(b);
}

/** Whether the user may usefully try again (the same request could succeed later). */
export function retryable(e: ExplainErrorCode): boolean {
  return [
    'cancelled',
    'timeout',
    'provider_error',
    'invalid_response',
    'busy',
    'rate_limited',
    'internal',
    'offline',
    'other',
    'consent_required',
  ].includes(e);
}

/** The payload as the user reads it: the system text, then the user message, pretty-printed. */
export function previewText(p: { system: string; user: string }): string {
  let user = p.user;
  try {
    user = JSON.stringify(JSON.parse(p.user), null, 2);
  } catch {
    // shown as given
  }
  return `${p.system}\n\n${user}`;
}
