/**
 * TBI-017 slice 1: the typed AI service client (app/src/assist/client.ts). Shapes, the runtime
 * flag, error mapping (unknown codes, non-JSON, offline, abort), the exact request body, no
 * client retry, and the gate's Accept header on every call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPLAIN_CONTRACT, type EngineeringContext } from '@tbi-lab/assist';
import { resetGateForTests } from '../src/gate.js';
import {
  EXPLAIN_ERRORS,
  aiEnabled,
  explainBody,
  getStatus,
  parseError,
  parseStatus,
  postExplain,
  postPreview,
  previewText,
  retryable,
  type FetchFn,
} from '../src/assist/client.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { errorKey } from '../src/assist/pilot.js';

const STATUS = {
  protocol: 'tbi-lab.assist-service/1',
  state: 'active',
  mode: 'mock',
  provider: 'mock',
  model: 'template-mock-1',
  pilot: true,
  consentVersion: '2026-11-01',
  limits: { perMinute: 6, perDay: 50, timeoutMs: 20000, maxOutputTokens: 800 },
  data: {
    sent: ['instructions', 'locale', 'circuit'],
    neverSent: ['identity', 'project_name'],
    auditRetentionDays: 30,
  },
};
const ACC = {
  provider: 'mock',
  model: 'template-mock-1',
  live: false,
  attempts: 1,
  inputTokens: 10,
  outputTokens: 5,
  estimatedTokens: false,
  costUsd: 0,
  latencyMs: 3,
};
const OK = {
  findings: [{ key: 'f1' }],
  response: {
    contract: EXPLAIN_CONTRACT,
    explanations: [{ finding: 'f1', text: 'Because.', cites: ['check:0'] }],
  },
  unexplained: [],
  accounting: ACC,
};
const ctx = { format: 'tbi-lab.engineering-context' } as unknown as EngineeringContext;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; init: RequestInit };
function fake(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers.shift();
    if (!a) throw new Error('no answer scripted');
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as FetchFn;
  return { fn, calls };
}

afterEach(() => resetGateForTests());

describe('status and the runtime flag', () => {
  it('a valid active pilot status turns the AI on', async () => {
    const { fn, calls } = fake(json(200, STATUS));
    const s = await getStatus(undefined, fn);
    expect(s.kind).toBe('ok');
    expect(aiEnabled(s)).toBe(true);
    expect(calls[0]!.url).toBe('/assist/v1/status');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(new Headers(calls[0]!.init.headers).get('accept')).toContain('application/json');
  });
  it('off by default: disabled, not pilot, wrong shape, wrong protocol, HTML, 404, offline', async () => {
    expect(aiEnabled(parseStatus({ ...STATUS, state: 'disabled', reasons: ['no_provider'] }))).toBe(
      false,
    );
    expect(aiEnabled(parseStatus({ ...STATUS, pilot: false }))).toBe(false);
    expect(parseStatus({ ...STATUS, state: 'on' }).kind).toBe('unavailable');
    expect(parseStatus({ ...STATUS, protocol: 'other/9' }).kind).toBe('unavailable');
    expect(parseStatus({ ...STATUS, data: { sent: 'all' } }).kind).toBe('unavailable');
    expect(parseStatus({ ...STATUS, consentVersion: 'v 1/../x' }).kind).toBe('unavailable');
    expect(parseStatus(null).kind).toBe('unavailable');
    const html = new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    for (const a of [html, json(404, { error: 'not_found' }), new TypeError('network')]) {
      const { fn } = fake(a);
      const s = await getStatus(undefined, fn);
      expect(s.kind).toBe('unavailable');
      expect(aiEnabled(s)).toBe(false);
    }
  });
  it('keeps an opaque account reference only (never an email-like value)', () => {
    const a = parseStatus({ ...STATUS, account: 'acc_7f3a' });
    expect(a.kind === 'ok' && a.status.account).toBe('acc_7f3a');
    const b = parseStatus({ ...STATUS, account: ['someone', 'example.com'].join('@') });
    expect(b.kind === 'ok' && b.status.account).toBeUndefined();
  });
});

describe('explain', () => {
  it('sends exactly {contract, locale, consent, context} and nothing else', async () => {
    const { fn, calls } = fake(json(200, OK));
    const r = await postExplain(explainBody('he', '2026-11-01', ctx), undefined, fn);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe('/assist/v1/explain');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['consent', 'context', 'contract', 'locale']);
    expect(body.consent).toEqual({ version: '2026-11-01', accepted: true });
    expect(body.contract).toBe(EXPLAIN_CONTRACT);
    expect(body.locale).toBe('he');
    // No key or secret-looking header is ever added by the browser.
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get('authorization')).toBeNull();
    expect([...h.keys()].sort()).toEqual(['accept', 'content-type']);
  });
  it('maps every documented error, unknown codes to other, 401 to unauthenticated', async () => {
    for (const code of EXPLAIN_ERRORS.filter((c) => c !== 'offline' && c !== 'other')) {
      const { fn } = fake(json(code === 'rate_limited' ? 429 : 400, { error: code }));
      const r = await postExplain(explainBody('en', 'v1', ctx), undefined, fn);
      expect(r.ok === false && r.error).toBe(code);
    }
    const { fn } = fake(json(418, { error: 'credits_out_tomorrow' }));
    const r = await postExplain(explainBody('en', 'v1', ctx), undefined, fn);
    expect(r).toMatchObject({
      ok: false,
      status: 418,
      error: 'other',
      rawError: 'credits_out_tomorrow',
    });
    expect(parseError(401, null).error).toBe('unauthenticated');
    expect(parseError(500, 'boom').error).toBe('other');
  });
  it('keeps retryAfterMs, limit and service message (TBI-018 shapes)', () => {
    const e = parseError(429, {
      error: 'rate_limited',
      retryAfterMs: 12_300,
      limit: {
        code: 'daily',
        messageKey: 'plans.limit.daily',
        params: { reset: '00:00', n: 3, x: {} },
      },
      message: { he: 'מגבלה', en: 'Limit' },
    });
    expect(e.retryAfterMs).toBe(12_300);
    expect(e.limit).toEqual({
      code: 'daily',
      messageKey: 'plans.limit.daily',
      params: { reset: '00:00', n: 3 },
    });
    expect(e.message).toEqual({ he: 'מגבלה', en: 'Limit' });
    expect(parseError(429, { error: 'busy', retryAfterMs: -5 }).retryAfterMs).toBeUndefined();
  });
  it('a 200 with a wrong shape is never rendered', async () => {
    for (const bad of [
      { ...OK, accounting: null },
      { ...OK, response: { explanations: [{ finding: 'f1', text: 3, cites: [] }] } },
      { ...OK, response: { ...OK.response, declined: [{ finding: 'f1', reason: 'because' }] } },
      { ...OK, unexplained: 'none' },
    ]) {
      const { fn } = fake(json(200, bad));
      const r = await postExplain(explainBody('en', 'v1', ctx), undefined, fn);
      expect(r).toMatchObject({ ok: false, error: 'other' });
    }
  });
  it('non-JSON answers, offline and abort never throw', async () => {
    const html = new Response('<html>', { status: 502, headers: { 'content-type': 'text/html' } });
    let { fn } = fake(html);
    expect(await postExplain(explainBody('en', 'v1', ctx), undefined, fn)).toMatchObject({
      ok: false,
      status: 502,
      error: 'other',
    });
    ({ fn } = fake(new TypeError('Failed to fetch')));
    expect(await postExplain(explainBody('en', 'v1', ctx), undefined, fn)).toMatchObject({
      ok: false,
      status: 0,
      error: 'offline',
    });
    const ctl = new AbortController();
    ctl.abort();
    ({ fn } = fake(new DOMException('aborted', 'AbortError')));
    expect(await postExplain(explainBody('en', 'v1', ctx), ctl.signal, fn)).toMatchObject({
      ok: false,
      error: 'cancelled',
    });
  });
  it('passes the AbortSignal to fetch and never retries by itself', async () => {
    const ctl = new AbortController();
    const { fn, calls } = fake(json(503, { error: 'busy', retryAfterMs: 1000 }));
    await postExplain(explainBody('en', 'v1', ctx), ctl.signal, fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.signal).toBe(ctl.signal);
  });
});

describe('preview', () => {
  it('posts {locale, context} only and returns the payload', async () => {
    const { fn, calls } = fake(
      json(200, {
        payload: { system: 'SYS', user: '{"a":1}' },
        bytes: 10,
        estimatedInputTokens: 3,
      }),
    );
    const r = await postPreview(ctx, 'en', undefined, fn);
    expect(r.ok).toBe(true);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['context', 'locale']);
    if (r.ok) expect(previewText(r.payload)).toBe('SYS\n\n{\n  "a": 1\n}');
  });
  it('errors map like explain', async () => {
    const { fn } = fake(json(403, { error: 'not_pilot' }));
    expect(await postPreview(ctx, 'en', undefined, fn)).toMatchObject({
      ok: false,
      error: 'not_pilot',
    });
  });
});

describe('UI text for every error code', () => {
  it('each code has an EN and HE message; unknown falls back to other', () => {
    for (const code of EXPLAIN_ERRORS) {
      const k = errorKey(code);
      expect(k).toBe(`assist.ai.error.${code}`);
      expect(en[k]).toBeTruthy();
      expect(he[k]).toBeTruthy();
    }
    expect(errorKey('nonsense' as never)).toBe('assist.ai.error.other');
  });
  it('limits that do not clear by retrying are not offered a retry', () => {
    for (const c of [
      'daily_limit',
      'spend_cap',
      'token_ceiling',
      'not_pilot',
      'context_too_large',
    ] as const)
      expect(retryable(c)).toBe(false);
    for (const c of ['timeout', 'provider_error', 'busy', 'rate_limited', 'offline'] as const)
      expect(retryable(c)).toBe(true);
  });
});
