/**
 * TBI-018 s3d-5: the Session Host's public sim limits (runtime/host/simAdmission.ts PublicLimit) as
 * app text. The host sends a code and params, never text (decision O-8); the app renders its own
 * `sim.limit.*` message. An unknown code is not a limit: callers fall back to the generic message.
 * Numbers and dates are isolated LTR inside the sentence.
 */
import { isolateLtr, translate, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import type { PublicLimit } from './client.js';

const KEY = {
  queue: 'sim.limit.queue',
  queue_timeout: 'sim.limit.queue_timeout',
  queue_full: 'sim.limit.queue_full',
  queue_replaced: 'sim.limit.queue_replaced',
  sim_cooldown: 'sim.limit.cooldown',
  sim_concurrent: 'sim.limit.concurrent',
  minutes_out: 'sim.limit.minutes_out',
  minutes_out_free: 'sim.limit.minutes_out_free',
  sim_daily: 'sim.limit.daily',
  system_unavailable: 'sim.limit.system_unavailable',
  // BETA-G2: the operator paused new Free runs (try again later)
  free_paused: 'sim.limit.free_paused',
  // K3-3: not a refused start: the host ended an unattended run (controller idleStop)
  session_idle: 'sim.limit.session_idle',
} as const satisfies Record<string, MessageKey>;

/** The variant without the parameter, when the host did not give a usable one. */
const KEY_NODATE: Partial<Record<keyof typeof KEY, MessageKey>> = {
  minutes_out: 'sim.limit.minutes_out.nodate',
  minutes_out_free: 'sim.limit.minutes_out_free.nodate',
};

export type SimLimitCode = keyof typeof KEY;

/** Every app key of the limits (tests: EN/HE parity and placeholders). */
export const simLimitKeys = (): MessageKey[] => [
  ...Object.values(KEY),
  ...Object.values(KEY_NODATE),
  'sim.limit.queue.nopos',
  'sim.limit.cooldown.nowait',
  'sim.limit.session_idle.one',
];

/**
 * BETA-G2 s3: how the app presents a refused start. `status` = a calm, polite announcement (waiting or
 * "try again later"); `alert` = a hard refusal. `retry` = offer a "Try again" button (a new start can
 * succeed later without anything changing on the user's side).
 */
const UI: Record<SimLimitCode, { role: 'status' | 'alert'; retry: boolean }> = {
  queue: { role: 'status', retry: false },
  queue_timeout: { role: 'status', retry: true },
  queue_full: { role: 'status', retry: true },
  queue_replaced: { role: 'alert', retry: false },
  sim_cooldown: { role: 'status', retry: true },
  sim_concurrent: { role: 'alert', retry: false },
  minutes_out: { role: 'alert', retry: false },
  minutes_out_free: { role: 'alert', retry: false },
  sim_daily: { role: 'alert', retry: false },
  system_unavailable: { role: 'status', retry: true },
  free_paused: { role: 'status', retry: true },
  session_idle: { role: 'status', retry: true },
};

export const simLimitUi = (code: unknown): { role: 'status' | 'alert'; retry: boolean } | null =>
  isSimLimitCode(code) ? UI[code] : null;

export const isSimLimitCode = (c: unknown): c is SimLimitCode =>
  typeof c === 'string' && Object.hasOwn(KEY, c);

const DATE = /^\d{2}\.\d{2}\.\d{4}$/;

/** The sentence for a limit, or null for a code this app does not know. */
export function simLimitText(locale: LocaleInfo, limit: PublicLimit): string | null {
  if (!isSimLimitCode(limit.code)) return null;
  const code = limit.code;
  const p = limit.params;
  if (code === 'minutes_out' || code === 'minutes_out_free') {
    const date = typeof p.date === 'string' && DATE.test(p.date) ? p.date : '';
    return date
      ? translate(locale, KEY[code], { date: isolateLtr(date) })
      : translate(locale, KEY_NODATE[code]!);
  }
  if (code === 'session_idle') {
    // Its own sentence for one minute (HE has no "1 minutes").
    const m = Number(p.minutes);
    return m > 1
      ? translate(locale, KEY[code], { minutes: isolateLtr(String(m)) })
      : translate(locale, 'sim.limit.session_idle.one');
  }
  if (code === 'queue' || code === 'sim_cooldown') {
    const n = typeof p.n === 'number' && Number.isInteger(p.n) && p.n > 0 ? p.n : null;
    return n === null
      ? translate(locale, code === 'queue' ? 'sim.limit.queue.nopos' : 'sim.limit.cooldown.nowait')
      : translate(locale, KEY[code], { n: isolateLtr(String(n)) });
  }
  return translate(locale, KEY[code]);
}
