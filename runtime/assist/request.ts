/**
 * Sprint 28: the AI provider service's request boundary. The browser sends the Engineering Context
 * it built; the service trusts none of it:
 *
 * - the request has exactly the documented keys, a supported contract and a consent;
 * - the context has the documented format, version and top-level parts, stays inside the
 *   Sprint 27 bounds (bytes, counts, string lengths, depth) and holds JSON values only;
 * - user-written text is sanitised again (comments and string literals masked in excerpts,
 *   quoted text emptied in build messages, credential-like assignments redacted);
 * - the FINDINGS are recomputed here from the context by the deterministic `diagnose`: a client
 *   cannot choose what the model is asked to explain, nor add free text through findings.
 *
 * What leaves TBI Lab for a request is exactly `renderPrompt({contract, locale, findings,
 * context})` of this module's output (outboundPayload): the fixed instructions, the locale, the
 * recomputed findings and the sanitised context. Nothing else (no identity, no project name).
 */
import {
  CONTEXT_FORMAT,
  CONTEXT_LIMITS,
  CONTEXT_VERSION,
  EXPLAIN_CONTRACT,
  diagnose,
  maskComments,
  maskMessage,
  redactSecrets,
  renderPrompt,
  type EngineeringContext,
  type ExplainRequest,
  type Prompt,
} from '@tbi-lab/assist';

export class RequestError extends Error {
  constructor(
    readonly code: 'bad_request' | 'consent_required' | 'context_too_large',
    detail: string,
  ) {
    super(detail);
  }
}

const CONTEXT_KEYS = [
  'format',
  'version',
  'product',
  'circuit',
  'checks',
  'solver',
  'ratings',
  'program',
  'build',
  'failure',
  'observed',
  'capabilities',
  'assumptions',
  'excerpts',
  'unknowns',
  'truncated',
] as const;
const REQUIRED = [
  'format',
  'version',
  'product',
  'circuit',
  'checks',
  'solver',
  'ratings',
  'capabilities',
  'assumptions',
  'excerpts',
  'unknowns',
  'truncated',
];

/** Locales the service answers in (the product's; any BCP 47 tag of this shape is accepted). */
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;
/** No string in a context is longer than this (the context's own longest: a 240-char message). */
const MAX_STRING = 320;
const MAX_DEPTH = 8;
const MAX_ARRAY = 400;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON values only, bounded depth, array length and string length. */
function checkValue(v: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) throw new RequestError('bad_request', `${path}: too deep`);
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RequestError('bad_request', `${path}: not a finite number`);
    return;
  }
  if (typeof v === 'string') {
    if (v.length > MAX_STRING) throw new RequestError('bad_request', `${path}: string too long`);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY) throw new RequestError('bad_request', `${path}: too many items`);
    v.forEach((x, i) => checkValue(x, `${path}[${i}]`, depth + 1));
    return;
  }
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k.length > 64 || k === '__proto__')
        throw new RequestError('bad_request', `${path}: bad key`);
      checkValue(x, `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new RequestError('bad_request', `${path}: not JSON`);
}

const arr = (v: unknown, path: string, max: number): unknown[] => {
  if (!Array.isArray(v)) throw new RequestError('bad_request', `${path}: an array`);
  if (v.length > max) throw new RequestError('bad_request', `${path}: more than ${max}`);
  return v;
};

/** The context, checked and sanitised again (a copy). */
export function checkContext(raw: unknown): EngineeringContext {
  if (!isObj(raw)) throw new RequestError('bad_request', 'context: an object');
  for (const k of Object.keys(raw))
    if (!(CONTEXT_KEYS as readonly string[]).includes(k))
      throw new RequestError('bad_request', `context: unknown part ${k}`);
  for (const k of REQUIRED)
    if (!(k in raw)) throw new RequestError('bad_request', `context: missing ${k}`);
  if (raw.format !== CONTEXT_FORMAT || raw.version !== CONTEXT_VERSION)
    throw new RequestError('bad_request', 'context: unsupported format or version');
  const bytes = new TextEncoder().encode(JSON.stringify(raw)).length;
  if (bytes > CONTEXT_LIMITS.maxBytes)
    throw new RequestError('context_too_large', `context: ${bytes} bytes`);
  checkValue(raw, 'context', 0);
  const c = structuredClone(raw) as unknown as EngineeringContext;
  if (!isObj(c.circuit)) throw new RequestError('bad_request', 'context.circuit: an object');
  arr(c.circuit.components, 'context.circuit.components', CONTEXT_LIMITS.maxComponents);
  arr(c.circuit.nets, 'context.circuit.nets', CONTEXT_LIMITS.maxNets);
  arr(c.checks, 'context.checks', CONTEXT_LIMITS.maxChecks);
  arr(c.ratings, 'context.ratings', CONTEXT_LIMITS.maxRatings);
  const excerpts = arr(
    c.excerpts,
    'context.excerpts',
    CONTEXT_LIMITS.maxExcerpts,
  ) as EngineeringContext['excerpts'];
  // Sanitise user-written text again (defence in depth; the browser already did).
  const language = (c.program as { language?: unknown } | undefined)?.language;
  const lang = typeof language === 'string' ? language : 'cpp';
  for (const e of excerpts) {
    if (!isObj(e) || !Array.isArray(e.lines))
      throw new RequestError('bad_request', 'context.excerpts: malformed');
    arr(e.lines, 'context.excerpts[].lines', 2 * CONTEXT_LIMITS.excerptRadius + 1);
    e.lines = e.lines.map((l) =>
      typeof l === 'string'
        ? redactSecrets(maskComments(l, lang)).slice(0, CONTEXT_LIMITS.maxExcerptLineChars)
        : '',
    );
    e.untrusted = true;
  }
  if (c.build !== undefined) {
    if (!isObj(c.build)) throw new RequestError('bad_request', 'context.build: an object');
    const d = arr(
      c.build.diagnostics,
      'context.build.diagnostics',
      CONTEXT_LIMITS.maxBuildDiagnostics,
    );
    for (const x of d as { message?: unknown }[])
      if (isObj(x) && typeof x.message === 'string')
        x.message = redactSecrets(maskMessage(x.message)).slice(
          0,
          CONTEXT_LIMITS.maxDiagnosticChars,
        );
  }
  return c;
}

export interface ParsedExplain {
  request: ExplainRequest;
  consentVersion: string;
}

/** The explain request: `{ contract, locale, consent: { version, accepted: true }, context }`. */
export function parseExplain(raw: unknown, consentVersion: string): ParsedExplain {
  if (!isObj(raw)) throw new RequestError('bad_request', 'body: an object');
  for (const k of Object.keys(raw))
    if (!['contract', 'locale', 'consent', 'context'].includes(k))
      throw new RequestError('bad_request', `body: unknown key ${k}`);
  if (raw.contract !== EXPLAIN_CONTRACT)
    throw new RequestError('bad_request', 'contract: unsupported');
  if (typeof raw.locale !== 'string' || !LOCALE.test(raw.locale))
    throw new RequestError('bad_request', 'locale: a BCP 47 tag');
  const consent = raw.consent;
  if (!isObj(consent) || consent.accepted !== true || consent.version !== consentVersion)
    throw new RequestError('consent_required', `consent ${consentVersion} required`);
  const context = checkContext(raw.context);
  const findings = diagnose(context);
  return {
    request: { contract: EXPLAIN_CONTRACT, locale: raw.locale, findings, context },
    consentVersion,
  };
}

/** Exactly what a provider would receive for this request (shown to the user before consent). */
export function outboundPayload(req: ExplainRequest): Prompt {
  return renderPrompt(req);
}
