/**
 * Per-principal rate limits and event counters (Sprint 8, Phase 4): sliding windows over recorded
 * events in SQLite (`node:sqlite`), so they survive a service restart. `take` checks and records in
 * one synchronous transaction: concurrent requests cannot both pass a limit (no check-then-act
 * race inside the process, and BEGIN IMMEDIATE across connections).
 *
 * Only timestamps are stored; the window and count come from policy at the time of the check, so
 * changing a policy value needs no migration. Old events are pruned as they leave the longest
 * window in use.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Principal } from '../identity/principal.js';
import type { RateRule } from './policy.js';

export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };

export class RateLimiter {
  private readonly db: DatabaseSync;

  constructor(
    pathOrDb: string | DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.db = typeof pathOrDb === 'string' ? new DatabaseSync(pathOrDb) : pathOrDb;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rate_event (
        principal TEXT NOT NULL,
        action    TEXT NOT NULL,
        at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rate_by_key ON rate_event (principal, action, at);
    `);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private window(principal: Principal, action: string, rule: RateRule, now: number) {
    this.db
      .prepare(`DELETE FROM rate_event WHERE principal = ? AND action = ? AND at <= ?`)
      .run(principal, action, now - rule.windowMs);
    return this.db
      .prepare(
        `SELECT count(*) AS n, min(at) AS oldest FROM rate_event WHERE principal = ? AND action = ?`,
      )
      .get(principal, action) as { n: number; oldest: number | null };
  }

  /** Whether one more event fits; never records. */
  check(principal: Principal, action: string, rule: RateRule): Verdict {
    const now = this.now();
    return this.tx(() => {
      const w = this.window(principal, action, rule, now);
      if (w.n < rule.count) return { ok: true } as const;
      return { ok: false, retryAfterMs: Math.max(1, (w.oldest ?? now) + rule.windowMs - now) };
    });
  }

  /** Check and, if it fits, record one event — atomically. */
  take(principal: Principal, action: string, rule: RateRule): Verdict {
    const now = this.now();
    return this.tx(() => {
      const w = this.window(principal, action, rule, now);
      if (w.n >= rule.count)
        return { ok: false, retryAfterMs: Math.max(1, (w.oldest ?? now) + rule.windowMs - now) };
      this.db
        .prepare(`INSERT INTO rate_event (principal, action, at) VALUES (?, ?, ?)`)
        .run(principal, action, now);
      return { ok: true } as const;
    });
  }

  /** Record an event without checking (e.g. a failed build, counted after the fact). */
  record(principal: Principal, action: string): void {
    this.db
      .prepare(`INSERT INTO rate_event (principal, action, at) VALUES (?, ?, ?)`)
      .run(principal, action, this.now());
  }

  /** The newest recorded event of a kind (cool-downs count from it). */
  latest(principal: Principal, action: string): number | null {
    const r = this.db
      .prepare(`SELECT max(at) AS at FROM rate_event WHERE principal = ? AND action = ?`)
      .get(principal, action) as { at: number | null };
    return r.at;
  }
}

/**
 * In-memory sliding window for the cheap anti-hammering backstop (all API requests): not worth a
 * database write per request, and losing it on restart gives nobody more than one window.
 */
export class MemoryRate {
  private readonly events = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  take(principal: Principal, action: string, rule: RateRule): Verdict {
    const now = this.now();
    const k = `${principal}|${action}`;
    const list = (this.events.get(k) ?? []).filter((t) => t > now - rule.windowMs);
    if (list.length >= rule.count) {
      this.events.set(k, list);
      return { ok: false, retryAfterMs: Math.max(1, list[0]! + rule.windowMs - now) };
    }
    list.push(now);
    this.events.set(k, list);
    if (this.events.size > 100_000) this.events.clear(); // bounded memory under abuse
    return { ok: true };
  }
}
