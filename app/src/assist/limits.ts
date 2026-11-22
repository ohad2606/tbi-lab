/**
 * TBI-017 slice 2 (DEV-Lab builds only): TBI-018 limit refusals and the credits line, as text.
 * Design note docs/design/TBI-017-ai-assistant-ui.md §5 (limit reached, credits left), §7.
 *
 * - The service is the authority: its rendered `message[<locale>]` is shown when present; the
 *   client keys `assist.limit.<messageKey>` (mirroring runtime/plans/limits.ts MESSAGE_KEY) are
 *   the fallback only, and never blank (a missing `{date}`/`{n}` picks the variant without it).
 * - The fallback texts offer no purchase/upgrade: the product has no such feature yet.
 * - Numbers (dates, seconds, credits) are isolated LTR inside the sentence (also in the service
 *   text, whose own bidi controls are dropped first).
 * - Money-adjacent: credits are shown exactly as the service gave them; no arithmetic here.
 *   The only computed value is the wait in seconds, from the service's `retryAfterMs`.
 */
import { stripControls } from './plainText.js';
import { isolateLtr, translate, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { retryable, type ClientError, type Credits } from './client.js';

/** The user-facing TBI-018 refusals /explain can answer (runtime/plans/limits.ts). */
export const LIMIT_CODES = [
  'credits_out',
  'credits_out_free',
  'daily',
  'global_off',
  'rate',
  'too_long',
  'system_unavailable',
  'deep_not_in_plan',
] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];

/** Where the same request can succeed later (after the wait): "Try again" is offered. */
const RETRY: ReadonlySet<LimitCode> = new Set(['rate', 'system_unavailable']);

const KEY: Record<LimitCode, MessageKey> = {
  credits_out: 'assist.limit.ai.credits_out',
  credits_out_free: 'assist.limit.ai.credits_out_free',
  daily: 'assist.limit.ai.daily',
  global_off: 'assist.limit.ai.global_off',
  rate: 'assist.limit.ai.rate',
  too_long: 'assist.limit.ai.too_long',
  system_unavailable: 'assist.limit.system.unavailable',
  deep_not_in_plan: 'assist.limit.ai.deep_not_in_plan',
};
/** The variant without the parameter, when the service did not give a usable one. */
const KEY_WITHOUT: Partial<Record<LimitCode, MessageKey>> = {
  credits_out: 'assist.limit.ai.credits_out.nodate',
  credits_out_free: 'assist.limit.ai.credits_out_free.nodate',
  rate: 'assist.limit.ai.rate.nowait',
};

/** Every client fallback key (tests: EN/HE parity, placeholders, wording). */
export function limitFallbackKeys(): MessageKey[] {
  return [...Object.values(KEY), ...Object.values(KEY_WITHOUT)];
}

const isLimitCode = (c: unknown): c is LimitCode =>
  typeof c === 'string' && (LIMIT_CODES as readonly string[]).includes(c);

/** The limit this error is, or null for any other error (shown as a plain error). */
export function limitCodeOf(e: ClientError): LimitCode | null {
  if (isLimitCode(e.limit?.code)) return e.limit.code;
  if (isLimitCode(e.rawError)) return e.rawError;
  return null;
}

/** dd.mm.yyyy (runtime/plans/time.ts formatDate); anything else is not shown. */
const DATE = /^\d{2}\.\d{2}\.\d{4}$/;
const NUMBER = /\d+(?:[.:/]\d+)*/g;
const MAX_SERVICE_TEXT = 600;

/** Service text as shown: plain text, its bidi controls dropped, numbers isolated LTR. */
function serviceText(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const t = stripControls(raw).trim();
  if (!t || t.length > MAX_SERVICE_TEXT) return null;
  return t.replace(NUMBER, (m) => isolateLtr(m));
}

/**
 * How long Ask stays unavailable after this error (ms): the service's `retryAfterMs`, else the
 * seconds of a `rate` refusal (`params.n`); 0 = no wait. The client never retries by itself.
 */
export function limitWaitMs(e: ClientError): number {
  if (e.retryAfterMs !== undefined) return e.retryAfterMs;
  if (limitCodeOf(e) !== 'rate') return 0;
  const n = e.limit?.params.n;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 86_400 ? n * 1000 : 0;
}

/** Whether "Try again" is offered: per limit code for a limit, else per error code. */
export function canRetry(e: ClientError): boolean {
  const code = limitCodeOf(e);
  return code ? RETRY.has(code) : retryable(e.error);
}

export interface LimitView {
  code: LimitCode;
  text: string;
  source: 'service' | 'client';
  /** How long Ask stays unavailable (ms); 0 = no wait. */
  waitMs: number;
  waitSeconds: number;
  /** Show the separate "try again in N s" line (the sentence does not say it already). */
  showWait: boolean;
  /** Offer "Try again" (after the wait). */
  retry: boolean;
}

export function limitView(locale: LocaleInfo, e: ClientError): LimitView | null {
  const code = limitCodeOf(e);
  if (!code) return null;
  const params = e.limit?.params ?? {};
  const waitMs = limitWaitMs(e);
  const waitSeconds = Math.ceil(waitMs / 1000);
  // A locale-keyed lookup (no per-language branch): the service renders the locales it knows.
  const fromService = serviceText((e.message as Record<string, string> | undefined)?.[locale.code]);
  let text: string;
  if (fromService) text = fromService;
  else if (code === 'credits_out' || code === 'credits_out_free') {
    const date = typeof params.date === 'string' && DATE.test(params.date) ? params.date : '';
    text = date
      ? translate(locale, KEY[code], { date: isolateLtr(date) })
      : translate(locale, KEY_WITHOUT[code]!);
  } else if (code === 'rate') {
    text = waitSeconds
      ? translate(locale, KEY.rate, { n: isolateLtr(String(waitSeconds)) })
      : translate(locale, KEY_WITHOUT.rate!);
  } else text = translate(locale, KEY[code]);
  return {
    code,
    text,
    source: fromService ? 'service' : 'client',
    waitMs,
    waitSeconds,
    showWait: waitMs > 0 && code !== 'rate',
    retry: RETRY.has(code),
  };
}

/** The credits line, e.g. "AI credits left: 12 of 30. Plan: Free." (numbers as given). */
export function creditsText(locale: LocaleInfo, c: Credits): string {
  const remaining = isolateLtr(String(c.remaining));
  const line =
    c.total !== undefined
      ? translate(locale, 'assist.ai.credits.left', {
          remaining,
          total: isolateLtr(String(c.total)),
        })
      : translate(locale, 'assist.ai.credits.leftNoTotal', { remaining });
  if (!c.plan) return line;
  const plan = translate(locale, `assist.ai.credits.plan.${c.plan}`);
  return `${line} ${translate(locale, 'assist.ai.credits.plan', { plan })}`;
}
