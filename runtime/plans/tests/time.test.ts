import { describe, expect, it } from 'vitest';
import { addMonths, dayKey, formatDate, monthKey, monthStart, zonedToMs } from '../time.js';

const TZ = 'Asia/Jerusalem';
const ms = (iso: string): number => Date.parse(iso);

describe('dayKey / monthKey (Asia/Jerusalem via Intl)', () => {
  const table: [string, string, string][] = [
    ['2026-11-19T21:59:59Z', '2026-11-19', '2026-11'],
    ['2026-11-19T22:00:00Z', '2026-11-20', '2026-11'],
    ['2026-11-30T22:00:00Z', '2026-12-01', '2026-12'],
    ['2026-07-01T20:59:59Z', '2026-07-01', '2026-07'],
    ['2026-07-01T21:00:00Z', '2026-07-02', '2026-07'],
    ['2026-10-31T21:59:59Z', '2026-10-31', '2026-10'],
    ['2026-10-31T22:00:00Z', '2026-11-01', '2026-11'],
    ['2026-03-26T22:00:00Z', '2026-03-27', '2026-03'],
    ['2026-03-27T21:00:00Z', '2026-03-28', '2026-03'],
  ];
  it.each(table)('%s -> %s / %s', (utc, d, m) => {
    expect(dayKey(ms(utc), TZ)).toBe(d);
    expect(monthKey(ms(utc), TZ)).toBe(m);
  });

  it('DST dates are derived from Intl, not hard-coded offsets', () => {
    // Israel: UTC+2 in winter, UTC+3 in summer; the switch is on 2026-03-27 (Fri) and 2026-10-25 (Sun).
    const off = (iso: string): number => {
      const t = ms(iso);
      const local = Date.parse(
        new Intl.DateTimeFormat('sv-SE', {
          timeZone: TZ,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
          .format(new Date(t))
          .replace(' ', 'T') + 'Z',
      );
      return (local - t) / 3_600_000;
    };
    expect(off('2026-03-26T12:00:00Z')).toBe(2);
    expect(off('2026-03-28T12:00:00Z')).toBe(3);
    expect(off('2026-10-24T12:00:00Z')).toBe(3);
    expect(off('2026-10-26T12:00:00Z')).toBe(2);
  });

  it('dayKey is monotonic non-decreasing across a full year (seeded steps)', () => {
    let t = ms('2026-01-01T00:00:00Z');
    let seed = 12345;
    let prev = '';
    while (t < ms('2027-01-01T00:00:00Z')) {
      const k = dayKey(t, TZ);
      expect(k >= prev).toBe(true);
      prev = k;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      t += 1 + (seed % 7_200_000);
    }
  });
});

describe('formatting and zoned arithmetic', () => {
  it('formatDate dd.mm.yyyy in zone', () => {
    expect(formatDate(ms('2026-12-31T22:30:00Z'), TZ)).toBe('01.01.2027');
  });
  it('monthStart handles DST months', () => {
    expect(monthStart(ms('2026-11-19T12:00:00Z'), TZ, 1)).toBe(ms('2026-11-30T22:00:00Z'));
    expect(monthStart(ms('2026-03-10T12:00:00Z'), TZ, 1)).toBe(ms('2026-03-31T21:00:00Z'));
    expect(monthStart(ms('2026-12-10T12:00:00Z'), TZ, 1)).toBe(ms('2026-12-31T22:00:00Z'));
  });
  it('zonedToMs round trips local midnight across a DST switch', () => {
    expect(zonedToMs(TZ, 2026, 3, 28)).toBe(ms('2026-03-27T21:00:00Z'));
    expect(zonedToMs(TZ, 2026, 10, 26)).toBe(ms('2026-10-25T22:00:00Z'));
  });
  it('addMonths clamps the day', () => {
    expect(addMonths(ms('2026-01-31T09:00:00Z'), 1, TZ)).toBe(ms('2026-02-28T09:00:00Z'));
    expect(addMonths(ms('2026-12-20T09:00:00Z'), 1, TZ)).toBe(ms('2027-01-20T09:00:00Z'));
    expect(addMonths(ms('2026-12-20T09:00:00Z'), 0, TZ)).toBe(ms('2026-12-20T09:00:00Z'));
  });
});
