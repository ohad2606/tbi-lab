/**
 * TBI-017 slice 2: TBI-018 limit refusals and the credits line in the AI panel
 * (app/src/assist/limits.ts + the client's parsing). The shapes match runtime/assist/service.ts
 * `limitResponse` ({error, limit:{code, messageKey|null, params}, message?:{he, en}}) and the
 * plans engine (runtime/plans/limits.ts codes, `{date}` dd.mm.yyyy, `{n}` seconds).
 */
import { describe, expect, it } from 'vitest';
import { parseError, parseStatus } from '../src/assist/client.js';
import {
  LIMIT_CODES,
  canRetry,
  creditsText,
  limitWaitMs,
  limitCodeOf,
  limitFallbackKeys,
  limitView,
} from '../src/assist/limits.js';
import { getLocale } from '../src/i18n/i18n.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

const EN = getLocale('en');
const HE = getLocale('he');
const LRI = '⁦';
const PDI = '⁩';
const plain = (s: string) => s.replace(/[⁦-⁩]/g, '');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const STATUS = {
  protocol: 'tbi-lab.assist-service/1',
  state: 'active',
  pilot: true,
  consentVersion: '2026-11-01',
  data: { sent: ['circuit'], neverSent: ['identity'], auditRetentionDays: 30 },
};

/** A service refusal body exactly as runtime/assist/service.ts limitResponse builds it. */
const refusal = (
  code: string,
  params: Record<string, string | number> = {},
  message?: { he: string; en: string },
) => ({
  error: code,
  limit: {
    code,
    messageKey: code === 'system_unavailable' ? 'limit.system.unavailable' : `limit.ai.${code}`,
    params,
  },
  ...(message ? { message } : {}),
});

describe('limit codes from the service', () => {
  it('known user-facing codes are limits; contract errors and unknown codes are not', () => {
    for (const c of LIMIT_CODES) expect(limitCodeOf(parseError(429, refusal(c)))).toBe(c);
    // invalid_state: messageKey null, no message (service.ts) -> a plain error, not a limit text.
    const inv = parseError(409, {
      error: 'invalid_state',
      limit: { code: 'invalid_state', messageKey: null, params: {} },
    });
    expect(inv.limit).toEqual({ code: 'invalid_state', messageKey: null, params: {} });
    expect(limitCodeOf(inv)).toBeNull();
    expect(limitCodeOf(parseError(429, { error: 'daily_limit' }))).toBeNull();
    expect(limitCodeOf(parseError(429, { error: 'rate_limited', retryAfterMs: 5 }))).toBeNull();
    expect(limitCodeOf(parseError(418, { error: 'credits_out_tomorrow' }))).toBeNull();
    // The code in `error` alone (no limit object) is still recognised.
    expect(limitCodeOf(parseError(429, { error: 'credits_out' }))).toBe('credits_out');
    expect(LIMIT_CODES).not.toContain('pack_needs_plan'); // never answered by /explain
  });
});

describe('limit text: service message first, client keys as fallback', () => {
  it('uses the service text in the UI locale, numbers isolated LTR', () => {
    const e = parseError(
      429,
      refusal(
        'credits_out',
        { date: '01.12.2026' },
        {
          he: 'נגמרו הקרדיטים. הם יתחדשו ב-01.12.2026.',
          en: 'Credits out. They renew on 01.12.2026.',
        },
      ),
    );
    const vh = limitView(HE, e)!;
    expect(vh.source).toBe('service');
    expect(vh.text).toBe(`נגמרו הקרדיטים. הם יתחדשו ב-${LRI}01.12.2026${PDI}.`);
    const ve = limitView(EN, e)!;
    expect(plain(ve.text)).toBe('Credits out. They renew on 01.12.2026.');
    expect(ve.retry).toBe(false);
    expect(ve.waitMs).toBe(0);
  });
  it('service bidi controls are dropped before our own isolates', () => {
    const e = parseError(429, refusal('daily', {}, { he: '‮abc 3', en: 'x⁧y 3' }));
    expect(limitView(EN, e)!.text).toBe(`xy ${LRI}3${PDI}`);
    expect(limitView(HE, e)!.text).toBe(`abc ${LRI}3${PDI}`);
  });
  it('an empty or missing service text falls back to the client key (never blank)', () => {
    for (const message of [undefined, { he: '  ', en: '' }]) {
      const e = parseError(429, refusal('daily', {}, message));
      for (const loc of [EN, HE]) {
        const v = limitView(loc, e)!;
        expect(v.source).toBe('client');
        expect(v.text).toBe(loc.messages['assist.limit.ai.daily']);
      }
    }
    // A very long service text is not trusted either.
    const long = parseError(
      429,
      refusal('daily', {}, { he: 'א'.repeat(2000), en: 'a'.repeat(2000) }),
    );
    expect(limitView(EN, long)!.source).toBe('client');
  });
  it('fallback params: a valid date is shown, a missing or odd one picks the text without a date', () => {
    const withDate = limitView(
      EN,
      parseError(429, refusal('credits_out_free', { date: '01.12.2026' })),
    )!;
    expect(withDate.text).toContain(`${LRI}01.12.2026${PDI}`);
    expect(withDate.text).not.toContain('{date}');
    const cases: Record<string, string | number>[] = [{}, { date: '2026-12-01<b>' }, { date: 5 }];
    for (const params of cases) {
      const v = limitView(HE, parseError(429, refusal('credits_out', params)))!;
      expect(v.text).toBe(HE.messages['assist.limit.ai.credits_out.nodate']);
    }
  });
  it('rate: the wait comes from retryAfterMs or the service seconds; Ask waits, then may retry', () => {
    const n = limitView(EN, parseError(429, refusal('rate', { n: 7 })))!;
    expect(n.waitMs).toBe(7000);
    expect(n.retry).toBe(true);
    expect(n.text).toContain(`${LRI}7${PDI}`);
    expect(n.showWait).toBe(false); // the sentence already says when
    const ra = limitView(EN, { ...parseError(429, refusal('rate')), retryAfterMs: 2500 })!;
    expect(ra.waitMs).toBe(2500);
    expect(ra.text).toContain(`${LRI}3${PDI}`);
    const none = limitView(HE, parseError(429, refusal('rate', { n: -1 })))!;
    expect(none.waitMs).toBe(0);
    expect(none.text).toBe(HE.messages['assist.limit.ai.rate.nowait']);
  });
  it('retry is offered only where the same request can succeed later', () => {
    const retry = Object.fromEntries(
      LIMIT_CODES.map((c) => [c, limitView(EN, parseError(429, refusal(c)))!.retry]),
    );
    expect(retry).toEqual({
      credits_out: false,
      credits_out_free: false,
      daily: false,
      global_off: false,
      rate: true,
      too_long: false,
      system_unavailable: true,
      deep_not_in_plan: false,
    });
  });
  it('a service wait on another code shows the wait line', () => {
    const v = limitView(EN, {
      ...parseError(503, refusal('system_unavailable')),
      retryAfterMs: 4000,
    })!;
    expect(v.waitMs).toBe(4000);
    expect(v.showWait).toBe(true);
    expect(v.waitSeconds).toBe(4);
  });
  it('the controller helpers agree with the view (wait, retry); plain errors keep slice 1 rules', () => {
    expect(limitWaitMs(parseError(429, refusal('rate', { n: 9 })))).toBe(9000);
    expect(limitWaitMs(parseError(429, refusal('daily', { n: 9 })))).toBe(0);
    expect(limitWaitMs(parseError(429, { error: 'busy', retryAfterMs: 1200 }))).toBe(1200);
    expect(canRetry(parseError(429, refusal('credits_out')))).toBe(false);
    expect(canRetry(parseError(503, refusal('system_unavailable')))).toBe(true);
    expect(canRetry(parseError(429, { error: 'daily_limit' }))).toBe(false);
    expect(canRetry(parseError(502, { error: 'provider_error' }))).toBe(true);
  });
  it('no limit view for a non-limit error', () => {
    expect(limitView(EN, parseError(502, { error: 'provider_error' }))).toBeNull();
  });
});

describe('client fallback keys', () => {
  it('every limit code has EN and HE texts with the same placeholders', () => {
    const keys = limitFallbackKeys();
    expect(keys.length).toBeGreaterThanOrEqual(LIMIT_CODES.length);
    for (const k of [...keys, 'assist.limit.wait'] as const) {
      expect(en[k], k).toBeTruthy();
      expect(he[k], k).toBeTruthy();
      expect(placeholders(he[k]), k).toEqual(placeholders(en[k]));
    }
  });
  it('fallback texts never promise a purchase or upgrade (no such feature in the product)', () => {
    for (const k of limitFallbackKeys()) {
      expect(en[k]).not.toMatch(/buy|upgrade|pack/i);
      expect(he[k]).not.toMatch(/לרכוש|לשדרג|חבילת/);
    }
  });
});

describe('credits in the status (additive field, hidden when absent)', () => {
  it('parses remaining/total/plan exactly as given', () => {
    const s = parseStatus({ ...STATUS, credits: { plan: 'free', remaining: 12, total: 30 } });
    expect(s.kind === 'ok' && s.status.credits).toEqual({ plan: 'free', remaining: 12, total: 30 });
    const noTotal = parseStatus({ ...STATUS, credits: { plan: 'legacy', remaining: 4 } });
    expect(noTotal.kind === 'ok' && noTotal.status.credits).toEqual({
      plan: 'legacy',
      remaining: 4,
    });
  });
  it('absent or invalid credits are ignored, never guessed; an unknown plan id is not shown', () => {
    const none = parseStatus(STATUS);
    expect(none.kind === 'ok' && none.status.credits).toBeUndefined();
    for (const credits of [
      null,
      'lots',
      { remaining: -1, total: 30 },
      { remaining: 1.5, total: 30 },
      { remaining: '12', total: 30 },
      { remaining: Number.NaN },
      { total: 30 },
      { remaining: 3, total: 0 },
    ]) {
      const s = parseStatus({ ...STATUS, credits });
      expect(s.kind, JSON.stringify(credits)).toBe('ok');
      expect(s.kind === 'ok' && s.status.credits, JSON.stringify(credits)).toBeUndefined();
    }
    const odd = parseStatus({
      ...STATUS,
      credits: { plan: 'gold<script>', remaining: 2, total: 3 },
    });
    expect(odd.kind === 'ok' && odd.status.credits).toEqual({ remaining: 2, total: 3 });
  });
  it('the credits line: numbers isolated LTR, plan name translated, no arithmetic', () => {
    expect(plain(creditsText(EN, { plan: 'free', remaining: 12, total: 30 }))).toBe(
      'AI credits left: 12 of 30. Plan: Free.',
    );
    expect(creditsText(HE, { plan: 'advanced', remaining: 400, total: 400 })).toBe(
      `קרדיטי AI שנותרו: ${LRI}400${PDI} מתוך ${LRI}400${PDI}. מסלול: מתקדם.`,
    );
    expect(plain(creditsText(EN, { remaining: 0 }))).toBe('AI credits left: 0.');
    // More than the monthly total (rollover/packs) is shown as given.
    expect(plain(creditsText(EN, { remaining: 45, total: 30 }))).toBe('AI credits left: 45 of 30.');
  });
});
