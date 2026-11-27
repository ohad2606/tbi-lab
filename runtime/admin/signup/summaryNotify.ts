/**
 * BETA-G1 G1-AUTO-VERIFY slice 4b, intake side (TBI_SIGNUP_NOTIFY=summary): the owner's morning
 * summary and alerts, built from fixed texts and the validated numbers of summary.ts only.
 *
 *   Summary  once per Israel day, from the end of the quiet hours (08:00 when quiet is `off`), from
 *            a fresh file of that day.
 *   Alerts   auto cap reached, verify cap reached, mail 80% of the day / 30-day limit, verify key
 *            unreadable; pause on / off. At most one message per type per Israel day. A condition
 *            seen during quiet hours is stored and sent when they end, with the day it was seen.
 *   State    `<STORE_DIR>/auto-notify.state.json` (0600). A message is recorded as sent BEFORE the
 *            send (a restart or crash never repeats it); a failed send is taken back and nothing is
 *            sent again for 5, 10, 20, 40, then 60 minutes. A state that cannot be written = no
 *            send. An invalid state is replaced by one that counts every type as sent today.
 * Nothing here changes a request or anything the admin reads. Logs: class codes only.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { israelDay } from './autoApprove.js';
import { errorClass } from './errors.js';
import { isQuiet, localMinutes, type QuietWindow } from './quietHours.js';
import { readSummary, replaceJson, type Summary, type SummaryAlerts } from './summary.js';

export const NOTIFY_STATE_FILE = 'auto-notify.state.json';
export const SUMMARY_DEFAULT_MINUTE = 8 * 60;
export const SEND_RETRY_MS = 5 * 60_000;
export const SEND_RETRY_MAX_MS = 60 * 60_000;
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
const TYPES = ['summary', ...CONDITION_KEYS, 'pauseOn', 'pauseOff'] as const;
type MessageType = (typeof TYPES)[number];

interface NotifyState {
  v: 1;
  /** The Israel day each type was last sent on. */
  sent: Partial<Record<MessageType, string>>;
  /** Condition day already reported / observed and still to report. */
  done: Partial<Record<Condition, string>>;
  pending: Partial<Record<Condition, string>>;
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

function validState(x: unknown): x is NotifyState {
  const s = x as NotifyState | null;
  const days = (o: unknown, keys: readonly string[]) =>
    !!o &&
    typeof o === 'object' &&
    Object.entries(o).every(
      ([k, v]) => keys.includes(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
    );
  return (
    !!s &&
    typeof s === 'object' &&
    s.v === 1 &&
    days(s.sent, TYPES) &&
    days(s.done, CONDITION_KEYS) &&
    days(s.pending, CONDITION_KEYS) &&
    typeof s.paused === 'boolean' &&
    Number.isSafeInteger(s.failures) &&
    s.failures >= 0 &&
    Number.isSafeInteger(s.retryAt) &&
    s.retryAt >= 0
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
    let text: string;
    try {
      const fh = await open(
        join(this.d.storeDir, NOTIFY_STATE_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const st = await fh.stat();
        text = st.isFile() && st.size <= STATE_MAX_BYTES ? await fh.readFile('utf8') : '';
      } finally {
        await fh.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      this.logHourly(`signup: summary state unreadable (${errorClass(e)}); nothing sent`);
      return null;
    }
    try {
      const s: unknown = JSON.parse(text);
      if (validState(s)) return s;
    } catch {
      /* invalid */
    }
    this.logHourly('signup: summary state invalid; reset, nothing more today');
    const reset: NotifyState = {
      ...emptyState(),
      sent: Object.fromEntries(TYPES.map((k) => [k, today])),
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
    // Observe conditions first (also in quiet hours), so one that ends overnight is not lost.
    if (s) {
      const pending = { ...state.pending };
      let changed = false;
      for (const k of CONDITION_KEYS)
        if (s.alerts[k] && state.done[k] !== s.day && pending[k] !== s.day) {
          pending[k] = s.day;
          changed = true;
        }
      if (changed) await this.save((state = { ...state, pending }));
    }
    if (isQuiet(t, this.d.quiet)) return;
    // A retry time further ahead than the longest delay means the clock went back: ignored.
    if (t < state.retryAt && state.retryAt - t <= SEND_RETRY_MAX_MS) return;
    for (const type of TYPES) {
      if (state.sent[type] === today) continue;
      let text: string;
      const next: NotifyState = {
        ...state,
        sent: { ...state.sent, [type]: today },
        done: { ...state.done },
        pending: { ...state.pending },
      };
      if (type === 'summary') {
        const due = this.d.quiet?.endMin ?? SUMMARY_DEFAULT_MINUTE;
        if (!s || s.day !== today || localMinutes(t) < due) continue;
        text = summaryText(s);
      } else if (type === 'pauseOn' || type === 'pauseOff') {
        const on = type === 'pauseOn';
        if (!s || s.paused !== on || state.paused === on) continue;
        next.paused = on;
        text = pauseText(on, s.day);
      } else {
        const day = state.pending[type];
        if (!day) continue;
        delete next.pending[type];
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
