/**
 * BACKLOG 12/G1 before-enable: the shutdown flush of the funnel counters (intake close -> flush,
 * admin drain -> flush, both bounded) and flush under a busy lock. Temporary directories only.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rename } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FUNNEL_FILE,
  FUNNEL_LOCK,
  FUNNEL_LOCK_RETRIES,
  FunnelCounters,
} from '../funnel/counters.js';
import { closeThenFlush, drainThenFlush } from '../funnel/shutdown.js';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function counters(minWriteIntervalMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), 'tbi-funnel-be-'));
  roots.push(dir);
  const logs: string[] = [];
  const c = new FunnelCounters(dir, { log: (l) => logs.push(l), minWriteIntervalMs });
  await c.init();
  return { c, dir, logs };
}
const days = (dir: string) =>
  (
    JSON.parse(readFileSync(join(dir, FUNNEL_FILE), 'utf8')) as {
      days: Record<string, Record<string, number>>;
    }
  ).days;
const total = (dir: string, ev: string) =>
  existsSync(join(dir, FUNNEL_FILE))
    ? Object.values(days(dir)).reduce((n, d) => n + (d[ev] ?? 0), 0)
    : 0;
const never = () => new Promise<void>(() => undefined);

/** Frozen copy of parseFunnelFile as released at dea6f93 (the previous release's reader). */
function oldParse(text: string, cap = 10_000): unknown {
  const EV = [
    'landing_view',
    'signup_form_view',
    'signup_submitted',
    'signup_approved',
    'first_session',
  ];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!obj(raw) || raw.v !== 1 || !obj(raw.days) || Object.keys(raw).length !== 2) return null;
  const out: Record<string, Record<string, number>> = {};
  for (const [day, counts] of Object.entries(raw.days)) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      !obj(counts)
    )
      return null;
    const row: Record<string, number> = {};
    for (const [ev, n] of Object.entries(counts)) {
      if (!EV.includes(ev)) return null;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > cap) return null;
      row[ev] = n;
    }
    out[day] = row;
  }
  return out;
}

describe('shutdown: intake close() -> flush()', () => {
  it('an increment made during close() is persisted', async () => {
    const { c, dir } = await counters();
    await closeThenFlush(async () => {
      await new Promise((r) => setTimeout(r, 20));
      c.increment('signup_submitted'); // a request finishing while the server closes
    }, c);
    expect(total(dir, 'signup_submitted')).toBe(1);
  });

  it('a hanging close() still reaches the flush, within the overall deadline', async () => {
    const { c, dir } = await counters();
    c.increment('signup_submitted');
    const t0 = performance.now();
    await closeThenFlush(never, c, { totalMs: 400, closeMs: 150 });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(total(dir, 'signup_submitted')).toBe(1);
  });

  it('counters off: close() is awaited unbounded as before (no flush, no timer)', async () => {
    let closed = false;
    await closeThenFlush(async () => {
      await new Promise((r) => setTimeout(r, 30));
      closed = true;
    }, null);
    expect(closed).toBe(true);
    let done = false;
    void closeThenFlush(never, null).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(false);
  });
});

describe('shutdown: admin drain -> flush', () => {
  it('flushes after the drain timed out (drain never finishes)', async () => {
    const { c, dir } = await counters();
    c.increment('signup_approved');
    const t0 = performance.now();
    await drainThenFlush(never, 50, c, 500);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(total(dir, 'signup_approved')).toBe(1);
  });

  it('flushes after the drain finished, including a count made by the drain', async () => {
    const { c, dir } = await counters();
    await drainThenFlush(async () => void c.increment('signup_approved'), 5_000, c);
    expect(total(dir, 'signup_approved')).toBe(1);
  });

  it('counters off: only the drain wait (a rejecting drain still ends the wait)', async () => {
    await drainThenFlush(async () => undefined, 5_000, null);
    await drainThenFlush(() => Promise.reject(new Error('x')), 5_000, undefined);
  });
});

describe('flush under a busy lock', () => {
  it('lock busy, then freed: written within the deadline, counted once', async () => {
    const { c, dir } = await counters();
    const lock = join(dir, FUNNEL_LOCK);
    writeFileSync(lock, '', { mode: 0o600 }); // a fresh foreign lock
    c.increment('signup_submitted');
    c.increment('signup_submitted');
    setTimeout(() => unlinkSync(lock), 250);
    await c.flush(1_000);
    expect(total(dir, 'signup_submitted')).toBe(2);
    await c.flush(1_000);
    expect(total(dir, 'signup_submitted')).toBe(2);
  });

  it('busy forever: bounded, the fresh foreign lock is kept, one log line (class + count), no double count later', async () => {
    const { c, dir, logs } = await counters();
    const lock = join(dir, FUNNEL_LOCK);
    writeFileSync(lock, 'foreign', { mode: 0o600 });
    const mtime = statSync(lock).mtimeMs;
    c.increment('signup_submitted');
    c.increment('signup_form_view');
    const t0 = performance.now();
    await c.flush(400);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(existsSync(join(dir, FUNNEL_FILE))).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('foreign');
    expect(statSync(lock).mtimeMs).toBe(mtime);
    expect(logs).toEqual(['funnel: flush gave up (lock_busy), 2 not written']);
    // The deltas are still held exactly once: freed later, each is written once.
    unlinkSync(lock);
    await c.flush(1_000);
    expect(total(dir, 'signup_submitted')).toBe(1);
    expect(total(dir, 'signup_form_view')).toBe(1);
    expect(FUNNEL_LOCK_RETRIES).toBeGreaterThan(0);
  });

  it('an error reported after the rename took effect is not re-added (counted at most once)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tbi-funnel-be-'));
    roots.push(dir);
    let fail = true;
    const c = new FunnelCounters(dir, {
      minWriteIntervalMs: 60_000,
      io: {
        rename: (async (a: string, b: string) => {
          await rename(a, b);
          if (fail) throw Object.assign(new Error('io'), { code: 'EIO' });
        }) as typeof rename,
      },
    });
    await c.init();
    c.increment('signup_submitted');
    await c.flush();
    fail = false;
    c.increment('signup_submitted');
    await c.flush();
    expect(total(dir, 'signup_submitted')).toBe(2);
  });

  it('the written file keeps exactly {v:1, days} and is accepted by the previous release parser', async () => {
    const { c, dir } = await counters();
    c.increment('signup_submitted');
    await c.flush();
    const text = readFileSync(join(dir, FUNNEL_FILE), 'utf8');
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['v', 'days']);
    expect(oldParse(text)).toEqual(days(dir));
  });
});
