/**
 * BETA-G1 G1-AUTO-VERIFY slice 4b, intake side (TBI_SIGNUP_NOTIFY=summary): the owner's morning
 * summary and alerts, built from fixed texts and the validated numbers of summary.ts only.
 *
 *   Summary  once per Israel day, from the end of the quiet hours (08:00 when quiet is `off`), from
 *            a fresh file of that day.
 *   Alerts   auto cap reached, verify cap reached, mail 80% of the day / 30-day limit, verify key
 *            unreadable: once per type per CONDITION day (the day it was seen), at most 2 sends per
 *            type per Israel send day. Seen during quiet hours = stored (the last 2 unsent days)
 *            and sent when they end. Pause on / off: each at most once per Israel day.
 *   Stale    no fresh valid summary for more than 30 minutes (counted from the first pass without
 *            one, persisted), or for 2 minutes while today's morning summary is due: one class
 *            code (stale|missing|unreadable|invalid), once per Israel day, not in quiet hours.
 *   State    `<STORE_DIR>/auto-notify.state.json` (0600). A message is recorded as sent BEFORE the
 *            send (a restart or crash never repeats it); a failed send is taken back and nothing is
 *            sent again for 5, 10, 20, 40, then 60 minutes. A state that cannot be written = no
 *            send. An invalid state is replaced by one that counts every type as sent today.
 * Nothing here changes a request or anything the admin reads. Logs: class codes only.
 */
import { join } from 'node:path';
import { israelDay } from './autoApprove.js';
import { errorClass } from './errors.js';
import { isQuiet, localMinutes, type QuietWindow } from './quietHours.js';
import {
  readBounded,
  readSummary,
  replaceJson,
  type Summary,
  type SummaryAlerts,
  type SummaryRefusal,
} from './summary.js';

export const NOTIFY_STATE_FILE = 'auto-notify.state.json';
export const SUMMARY_DEFAULT_MINUTE = 8 * 60;
export const SEND_RETRY_MS = 5 * 60_000;
export const SEND_RETRY_MAX_MS = 60 * 60_000;
/** No fresh summary for longer than this = the owner is told. */
export const NO_SUMMARY_ALERT_MS = 30 * 60_000;
/** While the morning summary is due: time for the admin's once-a-minute write after a start. */
export const NO_SUMMARY_DUE_MS = 2 * 60_000;
const CONDITION_SENDS_PER_DAY = 2;
const STATE_MAX_BYTES = 4096;

const CONDITIONS = {
  autoCap: 'the daily auto-approval cap was reached; further requests wait.',
  verifyCap: 'the daily verification mail cap was reached; further verification mails wait.',
  mailDay80: 'at least 80% of the daily mail limit is used.',
  mail30d80: 'at least 80% of the 30-day mail limit is used.',
  verifyKey: 'the verification key cannot be read; email verification is not working.',
} as const satisfies Record<keyof SummaryAlerts, string>;
type Condition = keyof SummaryAlerts;
const CONDITION_KEYS = Object.keys(CONDITIONS) as Condition[];
const TYPES = ['summaryStale', 'summary', ...CONDITION_KEYS, 'pauseOn', 'pauseOff'] as const;
type MessageType = (typeof TYPES)[number];
const isCondition = (t: MessageType): t is Condition => Object.hasOwn(CONDITIONS, t);

type StaleClass = 'stale' | 'missing' | 'unreadable' | 'invalid';
const staleClass = (r: SummaryRefusal): StaleClass =>
  r === 'stale' || r === 'missing' || r === 'unreadable' ? r : 'invalid';

interface NotifyState {
  v: 1;
  /** The Israel day each type was last sent on, and how often on that day. */
  sent: Partial<Record<MessageType, { day: string; n: number }>>;
  /** Condition day last reported / days observed and still to report (oldest first). */
  done: Partial<Record<Condition, string>>;
  pending: Partial<Record<Condition, string[]>>;
  /** The first pass without a fresh summary; absent while there is one. */
  noSummarySince?: number;
  /** The pause state last reported (false before the first report). */
  paused: boolean;
  failures: number;
  retryAt: number;
}

const emptyState = (): NotifyState => ({
  v: 1,
  sent: {},
  done: {},
  pending: {},
  paused: false,
  failures: 0,
  retryAt: 0,
});

const isDay = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;

function validState(x: unknown): x is NotifyState {
  const s = x as NotifyState | null;
  const map = (o: unknown, keys: readonly string[], ok: (v: unknown) => boolean) =>
    !!o && typeof o === 'object' && Object.entries(o).every(([k, v]) => keys.includes(k) && ok(v));
  const sent = (v: unknown) => {
    const e = v as { day?: unknown; n?: unknown } | null;
    return !!e && isDay(e.day) && isTime(e.n);
  };
  const days = (v: unknown) => Array.isArray(v) && v.length <= 2 && v.every(isDay);
  return (
    !!s &&
    typeof s === 'object' &&
    s.v === 1 &&
    map(s.sent, TYPES, sent) &&
    map(s.done, CONDITION_KEYS, isDay) &&
    map(s.pending, CONDITION_KEYS, days) &&
    (s.noSummarySince === undefined || isTime(s.noSummarySince)) &&
    typeof s.paused === 'boolean' &&
    isTime(s.failures) &&
    isTime(s.retryAt)
  );
}

const n = (x: number | null) => (x === null ? 'n/a' : String(x));

export function summaryText(s: Summary): string {
  const line = (c: Summary['today']) =>
    `sign-ups ${c.signups}, verification mails ${n(c.verifyMails)}, ` +
    `confirmed ${n(c.verified)}, auto-approved ${c.autoApproved}`;
  const mail = s.mail
    ? `today ${s.mail.dayUsed}/${s.mail.dayLimit}, 30 days ${s.mail.d30Used}/${s.mail.d30Limit}`
    : 'n/a';
  return [
    `TBI Lab sign-ups, summary ${s.day}`,
    `Yesterday: ${line(s.yesterday)}`,
    `Today so far: ${line(s.today)}`,
    `Waiting for the daily cap: ${n(s.waitingCap)}`,
    `Mail budget used: ${mail}`,
    `Paused: ${s.paused ? 'yes' : 'no'}`,
  ].join('\n');
}

export const alertText = (type: Condition, day: string): string =>
  `TBI Lab alert (${day}): ${CONDITIONS[type]}`;

export const noSummaryText = (code: StaleClass, day: string): string =>
  `TBI Lab alert (${day}): no fresh sign-up summary (${code}); check the services.`;

export const pauseText = (paused: boolean, day: string): string =>
  paused
    ? `TBI Lab alert (${day}): automatic sign-up is paused.`
    : `TBI Lab alert (${day}): automatic sign-up is no longer paused.`;

export interface SummaryNotifierDeps {
  storeDir: string;
  send: (text: string) => Promise<void>;
  quiet: QuietWindow | null;
  now?: () => number;
  log?: (line: string) => void;
}

export class SummaryNotifier {
  private running: Promise<void> | null = null;
  private readonly logged = new Map<string, number>();
  constructor(private readonly d: SummaryNotifierDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private logHourly(line: string): void {
    const t = this.now();
    const last = this.logged.get(line);
    if (last !== undefined && t >= last && t - last < 3_600_000) return;
    if (this.logged.size >= 64) this.logged.clear();
    this.logged.set(line, t);
    this.d.log?.(line);
  }

  /** Resolves when a pass in progress has finished (shutdown). */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** One pass; concurrent calls share it. Never rejects. */
  tick(): Promise<void> {
    this.running ??= this.pass()
      .catch((e: unknown) => this.logHourly(`signup: summary notify failed (${errorClass(e)})`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** null = nothing may be sent (unreadable state). */
  private async load(today: string, paused: boolean): Promise<NotifyState | null> {
    const r = await readBounded(join(this.d.storeDir, NOTIFY_STATE_FILE), STATE_MAX_BYTES);
    if ('refused' in r) {
      if (r.refused === 'missing') return emptyState();
      if (r.refused === 'unreadable') {
        this.logHourly('signup: summary state unreadable; nothing sent');
        return null;
      }
    }
    try {
      // Not a plain single-link file, or too large: invalid (the reset replaces the entry).
      const s: unknown = JSON.parse('text' in r ? r.text : '');
      if (validState(s)) return s;
    } catch {
      /* invalid */
    }
    this.logHourly('signup: summary state invalid; reset, nothing more today');
    const reset: NotifyState = {
      ...emptyState(),
      sent: Object.fromEntries(TYPES.map((k) => [k, { day: today, n: CONDITION_SENDS_PER_DAY }])),
      done: Object.fromEntries(CONDITION_KEYS.map((k) => [k, today])),
      paused,
    };
    await this.save(reset);
    return reset;
  }

  private save(s: NotifyState): Promise<void> {
    return replaceJson(this.d.storeDir, NOTIFY_STATE_FILE, s);
  }

  private async pass(): Promise<void> {
    const t = this.now();
    const today = israelDay(t);
    const read = await readSummary(this.d.storeDir, t);
    const s = 'summary' in read ? read.summary : null;
    if ('refused' in read) this.logHourly(`signup: summary ignored (${read.refused})`);
    let state = await this.load(today, s?.paused ?? false);
    if (!state) return;
    // Observe first (also in quiet hours), so a condition that ends overnight is not lost.
    const seen: NotifyState = { ...state, pending: { ...state.pending } };
    let changed = false;
    if (s) {
      changed = seen.noSummarySince !== undefined;
      delete seen.noSummarySince;
      for (const k of CONDITION_KEYS) {
        const days = seen.pending[k] ?? [];
        if (s.alerts[k] && state.done[k] !== s.day && !days.includes(s.day)) {
          seen.pending[k] = [...days, s.day].slice(-2);
          changed = true;
        }
      }
    } else if (seen.noSummarySince === undefined || seen.noSummarySince > t) {
      // A start in the future means the clock went back: counted again from now.
      seen.noSummarySince = t;
      changed = true;
    }
    if (changed) await this.save((state = seen));
    if (isQuiet(t, this.d.quiet)) return;
    // A retry time further ahead than the longest delay means the clock went back: ignored.
    if (t < state.retryAt && state.retryAt - t <= SEND_RETRY_MAX_MS) return;
    const due = localMinutes(t) >= (this.d.quiet?.endMin ?? SUMMARY_DEFAULT_MINUTE);
    for (const type of TYPES) {
      const count = state.sent[type]?.day === today ? state.sent[type].n : 0;
      if (count >= (isCondition(type) ? CONDITION_SENDS_PER_DAY : 1)) continue;
      let text: string;
      const next: NotifyState = {
        ...state,
        sent: { ...state.sent, [type]: { day: today, n: count + 1 } },
        done: { ...state.done },
        pending: { ...state.pending },
      };
      if (type === 'summaryStale') {
        if (!('refused' in read)) continue;
        const age = t - state.noSummarySince!;
        const waited = due && state.sent.summary?.day !== today && age >= NO_SUMMARY_DUE_MS;
        if (age <= NO_SUMMARY_ALERT_MS && !waited) continue;
        text = noSummaryText(staleClass(read.refused), today);
      } else if (type === 'summary') {
        if (!s || s.day !== today || !due) continue;
        text = summaryText(s);
      } else if (type === 'pauseOn' || type === 'pauseOff') {
        const on = type === 'pauseOn';
        if (!s || s.paused !== on || state.paused === on) continue;
        next.paused = on;
        text = pauseText(on, s.day);
      } else {
        const [day, ...later] = state.pending[type] ?? [];
        if (!day) continue;
        next.pending[type] = later;
        next.done[type] = day;
        text = alertText(type, day);
      }
      await this.save(next);
      try {
        await this.d.send(text);
      } catch (e) {
        const failures = state.failures + 1;
        const wait = Math.min(SEND_RETRY_MS * 2 ** Math.min(failures - 1, 10), SEND_RETRY_MAX_MS);
        this.logHourly(`signup: summary send failed (${errorClass(e)})`);
        await this.save({ ...state, failures, retryAt: this.now() + wait });
        return;
      }
      state = { ...next, failures: 0, retryAt: 0 };
      await this.save(state);
    }
  }
}
