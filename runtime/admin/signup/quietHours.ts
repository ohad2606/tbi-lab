/**
 * TBI-022: quiet hours for every message we send to a person (applicant emails, the owner's
 * sign-up alerts). Messages are sent only outside the window; anything triggered inside it waits
 * for its end. The zone is fixed to Asia/Jerusalem and resolved with Intl (DST-correct), never
 * with a fixed UTC offset. Pure and clock-injected.
 *
 *   TBI_SIGNUP_QUIET   `HH:MM-HH:MM` (default `23:00-08:00`; the window may wrap midnight), or `off`
 */
export const QUIET_TZ = 'Asia/Jerusalem';
export const DEFAULT_QUIET = '23:00-08:00';

export interface QuietWindow {
  /** Minutes after local midnight at which quiet starts / ends (0..1439, start != end). */
  startMin: number;
  endMin: number;
}

/** null = quiet hours disabled (`off`); throws a short Error on a malformed value (fail closed). */
export function parseQuiet(v: string | undefined): QuietWindow | null {
  const s = (v ?? DEFAULT_QUIET).trim();
  if (s.toLowerCase() === 'off') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error('TBI_SIGNUP_QUIET must be HH:MM-HH:MM or off');
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  if (startMin === endMin) throw new Error('TBI_SIGNUP_QUIET start and end must differ');
  return { startMin, endMin };
}

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: QUIET_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wall(ms: number): Wall {
  const p: Record<string, number> = {};
  for (const x of fmt.formatToParts(new Date(ms)))
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

/** The zone's offset (ms, local minus UTC) at an instant. */
function offsetAt(ms: number): number {
  const w = wall(ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

export function isQuiet(now: number, q: QuietWindow | null): boolean {
  if (!q) return false;
  const w = wall(now);
  const m = w.h * 60 + w.mi;
  return q.startMin < q.endMin ? m >= q.startMin && m < q.endMin : m >= q.startMin || m < q.endMin;
}

/**
 * The instant a message triggered at `now` may be sent: `now` itself outside quiet hours, else the
 * next local wall-clock time equal to the window end.
 */
export function nextSendAt(now: number, q: QuietWindow | null): number {
  if (!isQuiet(now, q)) return now;
  const w = wall(now);
  const m = w.h * 60 + w.mi;
  // Quiet and not yet past the end today -> today's end; otherwise (after the start) tomorrow's.
  const dayShift = m < q!.endMin ? 0 : 1;
  const wallUtc = Date.UTC(w.y, w.mo - 1, w.d + dayShift, 0, q!.endMin, 0);
  // Wall time -> instant: apply the offset valid at the answer (two passes cover DST edges).
  let t = wallUtc - offsetAt(now);
  t = wallUtc - offsetAt(t);
  // A window end inside a skipped DST hour has no instant of its own: take the first allowed minute.
  while (t <= now || isQuiet(t, q)) t += 60_000;
  return t;
}
