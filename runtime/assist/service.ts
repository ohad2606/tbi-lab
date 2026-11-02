/**
 * Sprint 28: the AI provider service (HTTP over a unix socket behind the gate, like the build and
 * runtime services). INACTIVE by default. Endpoints (gate path /assist/...):
 *
 *   GET  /v1/status   any signed-in user: whether the pilot is active, and if not, why (the
 *                     missing owner approvals by id); whether THIS caller is a pilot user; the
 *                     consent version; the limits; what data a request would send.
 *   POST /v1/preview  pilot users: exactly what would leave TBI Lab for this request (the
 *                     provider payload), computed, never sent. No consent needed to look.
 *   POST /v1/explain  pilot users, active service, consent of the current version: the gateway
 *                     call (timeouts, retries, rate, concurrency), the strict response validation,
 *                     the spending cap and token ceiling checked before and recorded after.
 *
 * Authorization: identity only from the gate (principalOf); the pilot list holds opaque
 * principals. The service has no route to the Session Host, the build service, QEMU or the host's
 * files (its systemd unit: own user, no supplementary groups, read-only system, no other sockets).
 * Nothing it returns is applied to a project: there is no write action (Sprint 27 actions stay
 * dry-run only, AI origin rejected).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  AssistGateway,
  DEFAULT_GATEWAY,
  estimateTokens,
  type AssistProvider,
  type GatewayOptions,
} from '@tbi-lab/assist';
import { principalOf, type IdentityConfig } from '../identity/principal.js';
import {
  ASSIST_SERVICE_PROTOCOL,
  activation,
  type Activation,
  type AssistServiceConfig,
} from './config.js';
import { Ledger } from './ledger.js';
import { RequestError, checkContext, outboundPayload, parseExplain } from './request.js';
import { diagnose, EXPLAIN_CONTRACT } from '@tbi-lab/assist';

/** What a request sends to a provider, by category (the app shows these before consent). */
export const DATA_SENT = [
  'instructions', // the fixed system text
  'locale',
  'findings', // recomputed here by the deterministic debugger
  'circuit', // component types, validated parameters, nets (no names chosen by the user beyond ids)
  'checks_and_results', // electrical checks, solver state, ratings, observed pin levels
  'build_status', // status, ≤ 20 diagnostics (≤ 240 chars, quoted text emptied)
  'code_excerpts', // ≤ 8 excerpts of ±2 lines, comments and string literals masked, secrets redacted
  'capabilities_and_assumptions',
] as const;
export const DATA_NEVER_SENT = [
  'identity', // no principal, email, name or account
  'project_name',
  'net_names',
  'comments_and_strings', // masked before sending
  'serial_output',
  'screenshots',
  'whole_source_files',
] as const;

const MAX_BODY = 128 * 1024;

export interface AssistServiceDeps {
  config: AssistServiceConfig;
  configError?: string;
  identity: IdentityConfig;
  ledger: Ledger;
  /** The provider when the service is active (mock or approved live), else null. */
  provider: AssistProvider | null;
  env: { allowMock: boolean; credentialPresent: boolean };
  gateway?: Partial<GatewayOptions>;
  now?: () => number;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
    ...extra,
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
    throw new RequestError('bad_request', 'content-type: application/json');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new RequestError('context_too_large', 'body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError('bad_request', 'body: not JSON');
  }
}

export function createAssistHttpServer(d: AssistServiceDeps): Server {
  const now = d.now ?? Date.now;
  const act: Activation = d.configError
    ? { state: 'disabled', reasons: [d.configError.split(':')[0]!] }
    : activation(d.config, d.env);
  const c = d.config;
  const gateway = new AssistGateway(d.provider, {
    ...DEFAULT_GATEWAY,
    timeoutMs: c.limits.timeoutMs,
    maxRetries: c.limits.maxRetries,
    concurrency: c.limits.concurrency,
    // The service-wide rate; per-principal limits are checked below.
    perMinute: Math.max(
      c.limits.perPrincipalPerMinute,
      c.limits.perPrincipalPerMinute * c.pilot.principals.length,
    ),
    now,
    ...d.gateway,
  });
  const perMinute = new Map<string, number[]>();
  const active = act.state === 'active' && d.provider !== null;
  const pricing = d.provider?.pricing ?? { inputPerMTok: 0, outputPerMTok: 0 };

  const status = (pilot: boolean) => ({
    protocol: ASSIST_SERVICE_PROTOCOL,
    state: active ? 'active' : 'disabled',
    ...(act.state === 'disabled' ? { reasons: act.reasons } : {}),
    ...(active && d.provider
      ? {
          mode: d.provider.live ? 'live' : 'mock',
          provider: d.provider.id,
          model: d.provider.model,
        }
      : {}),
    pilot,
    consentVersion: c.consentVersion,
    limits: {
      perMinute: c.limits.perPrincipalPerMinute,
      perDay: c.limits.perPrincipalPerDay,
      timeoutMs: c.limits.timeoutMs,
      maxOutputTokens: c.limits.maxOutputTokens,
    },
    data: {
      sent: DATA_SENT,
      neverSent: DATA_NEVER_SENT,
      auditRetentionDays: c.retention.auditDays,
    },
  });

  return createServer((req, res) => {
    void (async () => {
      const principal = principalOf(req, d.identity);
      if (!principal) return send(res, 401, { error: 'unauthenticated' });
      const pilot = c.pilot.principals.includes(principal);
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/v1/status') return send(res, 200, status(pilot));
      if (req.method !== 'POST' || (url !== '/v1/explain' && url !== '/v1/preview'))
        return send(res, 404, { error: 'not_found' });
      if (!pilot) {
        d.ledger.audit({
          action: url === '/v1/explain' ? 'explain' : 'preview',
          outcome: 'not_pilot',
          principal,
        });
        return send(res, 403, { error: 'not_pilot' });
      }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (e) {
        const r = e as RequestError;
        return send(res, r.code === 'context_too_large' ? 413 : 400, {
          error: r.code,
          detail: r.message,
        });
      }

      if (url === '/v1/preview') {
        try {
          const raw = body as { locale?: unknown; context?: unknown };
          const context = checkContext(raw.context);
          const locale =
            typeof raw.locale === 'string' && /^[a-z]{2,3}(-[A-Z]{2})?$/.test(raw.locale)
              ? raw.locale
              : 'en';
          const payload = outboundPayload({
            contract: EXPLAIN_CONTRACT,
            locale,
            findings: diagnose(context),
            context,
          });
          d.ledger.audit({ action: 'preview', outcome: 'ok', principal });
          return send(res, 200, {
            payload,
            bytes: Buffer.byteLength(payload.system + payload.user),
            estimatedInputTokens: estimateTokens(payload.system + payload.user),
          });
        } catch (e) {
          const r = e as RequestError;
          return send(res, r.code === 'context_too_large' ? 413 : 400, {
            error: r.code ?? 'bad_request',
            detail: r.message,
          });
        }
      }

      // /v1/explain
      if (!active) {
        d.ledger.audit({ action: 'explain', outcome: 'disabled', principal });
        return send(res, 503, {
          error: 'pilot_disabled',
          reasons: act.state === 'disabled' ? act.reasons : ['no_provider'],
        });
      }
      let parsed;
      try {
        parsed = parseExplain(body, c.consentVersion);
      } catch (e) {
        const r = e as RequestError;
        d.ledger.audit({ action: 'explain', outcome: r.code ?? 'bad_request', principal });
        const st = r.code === 'consent_required' ? 428 : r.code === 'context_too_large' ? 413 : 400;
        return send(res, st, { error: r.code ?? 'bad_request', detail: r.message });
      }
      // Per-principal rate (rolling minute) and daily count.
      const t = now();
      const starts = (perMinute.get(principal) ?? []).filter((s) => t - s < 60_000);
      if (starts.length >= c.limits.perPrincipalPerMinute) {
        d.ledger.audit({ action: 'explain', outcome: 'rate_limited', principal });
        const wait = 60_000 - (t - starts[0]!);
        return send(
          res,
          429,
          { error: 'rate_limited', retryAfterMs: wait },
          { 'retry-after': String(Math.ceil(wait / 1000)) },
        );
      }
      if (d.ledger.requestsToday(principal) >= c.limits.perPrincipalPerDay) {
        d.ledger.audit({ action: 'explain', outcome: 'daily_limit', principal });
        return send(res, 429, { error: 'daily_limit' });
      }
      // Ceilings, with the request's worst case (every attempt, full output) BEFORE any call.
      const prompt = outboundPayload(parsed.request);
      const inTok = estimateTokens(prompt.system + prompt.user);
      const attempts = 1 + c.limits.maxRetries;
      const worstTokens = attempts * (inTok + c.limits.maxOutputTokens);
      const worstPerAttempt =
        (inTok * pricing.inputPerMTok + c.limits.maxOutputTokens * pricing.outputPerMTok) / 1e6;
      const month = d.ledger.monthTotals();
      const cap = d.provider!.live ? (c.approvals.spendCap?.usdPerMonth ?? 0) : Infinity;
      if (month.usd + attempts * worstPerAttempt > cap) {
        d.ledger.audit({ action: 'explain', outcome: 'spend_cap', principal });
        return send(res, 429, { error: 'spend_cap' });
      }
      if (month.tokens + worstTokens > c.limits.monthlyTokens) {
        d.ledger.audit({ action: 'explain', outcome: 'token_ceiling', principal });
        return send(res, 429, { error: 'token_ceiling' });
      }
      starts.push(t);
      perMinute.set(principal, starts);
      const ctl = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) ctl.abort();
      });
      const r = await gateway.explain(parsed.request, ctl.signal);
      const acc = r.accounting;
      // Charged: the provider's counts on success; a failed live attempt at its worst case.
      const usd = acc
        ? r.ok || !acc.live
          ? acc.costUsd
          : Math.max(acc.costUsd, acc.attempts * worstPerAttempt)
        : 0;
      const outTok = acc
        ? r.ok || !acc.live
          ? acc.outputTokens
          : acc.attempts * c.limits.maxOutputTokens
        : 0;
      if (acc && acc.attempts > 0)
        d.ledger.record(principal, { inputTokens: acc.inputTokens, outputTokens: outTok, usd });
      d.ledger.audit({
        action: 'explain',
        outcome: r.ok ? 'ok' : r.error,
        principal,
        inputTokens: acc?.inputTokens ?? 0,
        outputTokens: outTok,
        usd,
        latencyMs: acc?.latencyMs ?? 0,
        attempts: acc?.attempts ?? 0,
        contextBytes: Buffer.byteLength(JSON.stringify(parsed.request.context)),
      });
      if (!r.ok) {
        const st =
          r.error === 'rate_limited' || r.error === 'busy'
            ? 429
            : r.error === 'context_too_large'
              ? 413
              : r.error === 'cancelled'
                ? 499
                : 502;
        return send(res, st, {
          error: r.error,
          ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}),
          ...(acc ? { accounting: acc } : {}),
        });
      }
      return send(res, 200, {
        findings: parsed.request.findings,
        response: r.response,
        unexplained: r.unexplained,
        accounting: acc,
      });
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
}
