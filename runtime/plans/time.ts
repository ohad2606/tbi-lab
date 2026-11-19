/** TBI-018 slice 1: time. All "now" values come from an injected Clock (ms epoch UTC). Day/month keys use Intl. */

export interface Clock {
  now(): number;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? NaN,
    month: out.month ?? NaN,
    day: out.day ?? NaN,
    hour: out.hour ?? NaN,
    minute: out.minute ?? NaN,
    second: out.second ?? NaN,
  };
}

const p2 = (n: number): string => String(n).padStart(2, '0');

export function dayKey(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
}

export function monthKey(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${p2(p.month)}`;
}

/** dd.mm.yyyy in the zone (display rule, design section 8). */
export function formatDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p2(p.day)}.${p2(p.month)}.${p.year}`;
}

/** Offset (ms) of the zone from UTC at an instant: local wall time minus UTC. */
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Instant (ms UTC) of a local wall-clock time in the zone. Month/day may overflow and are normalised. */
export function zonedToMs(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wall - offsetAt(wall, tz);
  guess = wall - offsetAt(guess, tz);
  return guess;
}

/** Start (ms UTC) of the zone's calendar month that contains `ms`, plus `plusMonths`. */
export function monthStart(ms: number, tz: string, plusMonths = 0): number {
  const p = localParts(ms, tz);
  return zonedToMs(tz, p.year, p.month + plusMonths, 1);
}

/** Same local wall-clock time `n` months later (day clamped to the target month's length). */
export function addMonths(ms: number, n: number, tz: string): number {
  if (n === 0) return ms;
  const p = localParts(ms, tz);
  const total = p.year * 12 + (p.month - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return zonedToMs(tz, y, m, Math.min(p.day, last), p.hour, p.minute, p.second);
}

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
