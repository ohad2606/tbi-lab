/**
 * "Report a problem" (Sprint 14): the dialog's logic without the DOM, so it is unit-tested. The
 * request contract and its limits are shared with the Session Host (reportProtocol.ts).
 *
 * The dialog's states: editing (with the last send error, if any) -> sending -> sent, or back to
 * editing with an error and the text kept. `sent` is reached ONLY from a 201 carrying a well-formed
 * report id: the server has then durably stored the report. Anything else is an error.
 */
import {
  MAX_COMPONENT_NAME_CHARS,
  MAX_DESCRIPTION_CHARS,
  REPORT_ID_RE,
  cleanComponentName,
  cleanDescription,
  codePoints,
  type ProblemReportRequest,
  type ReportCategory,
  type ReportDevice,
  type ReportKind,
  type ReportView,
} from '../../../runtime/host/reportProtocol.js';
import type { BuildInfo } from '../buildInfo.js';
import type { SimState } from '../sim/controller.js';

export {
  MAX_COMPONENT_NAME_CHARS,
  MAX_DESCRIPTION_CHARS,
  REPORT_CATEGORIES,
  REPORT_KINDS,
} from '../../../runtime/host/reportProtocol.js';
export type { ReportCategory, ReportKind } from '../../../runtime/host/reportProtocol.js';

/** What the tester has written and chosen (kept while the dialog is closed, until it is sent). */
export interface ReportDraft {
  /** Sprint 23B: the kind of feedback (default: a bug report, as RC4). */
  kind: ReportKind;
  description: string;
  /** The area (bug reports only). */
  category: ReportCategory | null;
  /** Bug reports only. */
  blocking: boolean;
  /** The requested component's name (component requests only; optional). */
  component: string;
  /** Sprint 23B: include the optional technical context (runtime version, device, project id). */
  includeContext: boolean;
}

export const emptyDraft = (): ReportDraft => ({
  kind: 'bug',
  description: '',
  category: null,
  blocking: false,
  component: '',
  includeContext: true,
});

export type SendError =
  | { code: 'rate_limited'; retryAfterS: number | null }
  | { code: 'unavailable' } // reports off, storage full or failing, host shutting down: try later
  | { code: 'signed_out' }
  | { code: 'rejected' } // the host refused the content (should not happen after validation)
  | { code: 'network' }; // no answer, or an answer that is not a confirmation

export type ReportPhase =
  { kind: 'editing'; error: SendError | null } | { kind: 'sending' } | { kind: 'sent'; id: string };

export interface DraftProblems {
  description?: 'required' | 'too_long';
  category?: 'required';
  component?: 'too_long';
}

/** The counter's value: code points of the text as it will be sent. */
export const descriptionLength = (text: string): number => codePoints(cleanDescription(text));

export function validateDraft(d: ReportDraft): DraftProblems {
  const out: DraftProblems = {};
  const n = descriptionLength(d.description);
  if (n === 0) out.description = 'required';
  else if (n > MAX_DESCRIPTION_CHARS) out.description = 'too_long';
  // Only a bug report asks for an area.
  if (d.kind === 'bug' && !d.category) out.category = 'required';
  if (d.kind === 'component' && componentLength(d.component) > MAX_COMPONENT_NAME_CHARS)
    out.component = 'too_long';
  return out;
}

/** The component name counter's value (code points as sent). */
export const componentLength = (text: string): number => codePoints(cleanComponentName(text));

export interface ReportContext {
  locale: string;
  view: ReportView;
  build: BuildInfo | null;
  sim: SimState;
  /** Sprint 23B optional context, sent only when the tester keeps it included. */
  runtimeVersion?: string | null;
  device?: ReportDevice;
  projectId?: string | null;
}

/**
 * The device class from the screen alone (no model, no fingerprint): a coarse pointer without a
 * fine one is a tablet; a fine pointer a desktop; anything else `other`.
 */
export function deviceClass(match: (query: string) => boolean): ReportDevice {
  if (match('(any-pointer: fine)')) return 'desktop';
  if (match('(pointer: coarse)')) return 'tablet';
  return 'other';
}

/**
 * The request body: the draft plus the app facts the disclosure names (version, language, the
 * simulation status shown). Never project content: no circuit, code, names or component ids.
 */
export function buildRequest(d: ReportDraft, ctx: ReportContext): ProblemReportRequest {
  const sim = ctx.sim;
  let code: string | undefined =
    sim.status !== 'failed'
      ? undefined
      : sim.failure.kind === 'engine'
        ? sim.failure.error.code
        : sim.failure.code;
  const sessionId = 'runtime' in sim ? sim.runtime?.sessionId : undefined;
  // Product failure codes are snake_case; anything else is left out rather than refused.
  if (code !== undefined && !/^[a-z0-9_]{1,48}$/.test(code)) code = undefined;
  const bug = d.kind === 'bug';
  const name = d.kind === 'component' ? cleanComponentName(d.component) : '';
  const context: NonNullable<ProblemReportRequest['context']> = {};
  if (d.includeContext) {
    if (ctx.runtimeVersion && /^[0-9A-Za-z.+-]{1,32}$/.test(ctx.runtimeVersion))
      context.runtime = ctx.runtimeVersion;
    if (ctx.device) context.device = ctx.device;
    if (ctx.projectId && /^prj_[A-Za-z0-9]{1,64}$/.test(ctx.projectId))
      context.projectId = ctx.projectId;
  }
  return {
    description: cleanDescription(d.description),
    // Only a bug report has an area; every other kind is filed under `other`.
    category: bug ? d.category! : 'other',
    blocking: bug ? d.blocking : false,
    locale: ctx.locale,
    view: ctx.view,
    ...(ctx.build ? { app: { version: ctx.build.version, commit: ctx.build.commit } } : {}),
    ...(sessionId ? { sessionId } : {}),
    sim: { status: sim.status, ...(code ? { code } : {}) },
    // An RC4-shaped request for a plain bug report without context; the new fields otherwise.
    ...(bug ? {} : { kind: d.kind }),
    ...(name ? { component: name } : {}),
    ...(Object.keys(context).length ? { context } : {}),
  };
}

export type SendResult = { ok: true; id: string } | { ok: false; error: SendError };

/**
 * The dialog's transitions. A send starts only from editing and only with a valid draft (no
 * double submission while one is in flight); a result only ends a send in flight.
 */
export function nextPhase(
  phase: ReportPhase,
  event: { type: 'send'; draft: ReportDraft } | { type: 'result'; result: SendResult },
): ReportPhase {
  if (event.type === 'send') {
    if (phase.kind !== 'editing') return phase;
    return Object.keys(validateDraft(event.draft)).length ? phase : { kind: 'sending' };
  }
  if (phase.kind !== 'sending') return phase;
  return event.result.ok
    ? { kind: 'sent', id: event.result.id }
    : { kind: 'editing', error: event.result.error };
}

/** The outcome of one send from the HTTP answer (or its absence). */
export function interpretResponse(
  status: number | null,
  body: unknown,
  retryAfter: string | null,
): SendResult {
  if (status === 201) {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && REPORT_ID_RE.test(id)) return { ok: true, id };
    return { ok: false, error: { code: 'network' } };
  }
  if (status === 429) {
    const header = retryAfter !== null && /^\d{1,7}$/.test(retryAfter) ? Number(retryAfter) : null;
    const fromBody = (body as { retryAfterS?: unknown } | null)?.retryAfterS;
    const s = header ?? (typeof fromBody === 'number' ? fromBody : null);
    return { ok: false, error: { code: 'rate_limited', retryAfterS: s } };
  }
  if (status === 401) return { ok: false, error: { code: 'signed_out' } };
  if (status === 400 || status === 413 || status === 415)
    return { ok: false, error: { code: 'rejected' } };
  if (status === 503) return { ok: false, error: { code: 'unavailable' } };
  return { ok: false, error: { code: 'network' } };
}

/** POST the report to the Session Host (same origin, behind the deployment's gate). */
export async function sendReport(
  req: ProblemReportRequest,
  fetchFn: typeof fetch,
  base = '/runtime',
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn(`${base}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    return interpretResponse(null, null, null);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON (e.g. a proxy page): never a confirmation
  }
  return interpretResponse(res.status, body, res.headers.get('retry-after'));
}

/** Whole minutes to wait, at least one (for the rate-limit message). */
export const waitMinutes = (retryAfterS: number | null): number =>
  Math.max(1, Math.ceil((retryAfterS ?? 60) / 60));
