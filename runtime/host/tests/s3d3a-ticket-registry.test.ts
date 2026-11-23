/**
 * TBI-018 s3d-3a: the host's queue-ticket registry (ops review M2), the `Tbi-Queue*` header parsing and
 * the read-only `hasWaiting` peek (FairQueue / SimHostAdapter). docs/plans/S3D-HOST-WIRING-DESIGN.md
 * sections 3, 4, 11.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../plans/config.js';
import { FairQueue } from '../../plans/queue.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import {
  QUEUE_TICKET_RE,
  TicketRegistry,
  isQueueTicket,
  newQueueTicket,
  queueCapable,
  queueTicketOf,
} from '../queueTickets.js';
import { newSessionId } from '../session.js';
import type { PublicLimit } from '../simAdmission.js';

const T0 = Date.parse('2026-11-23T10:00:00Z');
const TTL = 600_000 + 30_000; // queue.maxWaitMs + queue.vanishMs (plans defaults)
const P = (i: number) => `p_principal${String(i).padStart(6, '0')}`;
const TIMEOUT: PublicLimit = {
  code: 'queue_timeout',
  messageKey: 'limit.sim.queue_timeout',
  params: {},
};

function registry(over: { cap?: number; perPrincipalCap?: number; ttlMs?: number } = {}) {
  const clock = new FakeClock(T0);
  const reg = new TicketRegistry({
    ttlMs: over.ttlMs ?? TTL,
    cap: over.cap ?? 50,
    perPrincipalCap: over.perPrincipalCap ?? 4,
    clock,
  });
  return { clock, reg };
}

/** Everything written to stdout / stderr / console while a test runs. */
let output: string[] = [];
beforeEach(() => {
  output = [];
  const keep =
    (orig: (...a: never[]) => unknown) =>
    (...a: unknown[]) => {
      output.push(a.map(String).join(' '));
      return (orig as (...b: unknown[]) => unknown)(...a);
    };
  vi.spyOn(process.stderr, 'write').mockImplementation(
    keep(process.stderr.write.bind(process.stderr)) as never,
  );
  vi.spyOn(process.stdout, 'write').mockImplementation(
    keep(process.stdout.write.bind(process.stdout)) as never,
  );
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation(
      (...a: unknown[]) => void output.push(a.map(String).join(' ')),
    );
});
afterEach(() => vi.restoreAllMocks());

describe('ticket format and headers', () => {
  it('server tickets are 16 random bytes, base64url, 22 characters, and pass the strict check', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = newQueueTicket();
      expect(t).toMatch(QUEUE_TICKET_RE);
      expect(Buffer.from(t, 'base64url')).toHaveLength(16);
      expect(isQueueTicket(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(500);
  });

  it('malformed tickets are rejected: length, alphabet, padding, non-canonical last character, types', () => {
    const good = newQueueTicket();
    const bad: unknown[] = [
      '',
      good.slice(0, 21),
      `${good}A`,
      `${good}==`,
      `${good.slice(0, 21)}B`, // non-canonical: low bits of the last character set
      `${good.slice(0, 21)}=`,
      `${good.slice(0, 20)}+/`,
      `${good.slice(0, 20)}.A`,
      ` ${good.slice(1)}`,
      'A'.repeat(4096),
      `${good}, ${good}`,
      null,
      undefined,
      42,
      [good],
      { ticket: good },
    ];
    for (const b of bad) expect(isQueueTicket(b)).toBe(false);
  });

  it('Tbi-Queue: 1 exactly; Tbi-Queue-Ticket only when well formed (malformed = no ticket)', () => {
    const t = newQueueTicket();
    const h = (headers: Record<string, string | string[] | undefined>) => ({ headers });
    expect(queueCapable(h({ 'tbi-queue': '1' }))).toBe(true);
    for (const v of [undefined, '', '0', '2', 'true', ' 1', '1 ', '01', ['1', '1']])
      expect(queueCapable(h({ 'tbi-queue': v }))).toBe(false);
    // the proxy-stripped X-Tbi-* spelling is not the protocol header
    expect(queueCapable(h({ 'x-tbi-queue': '1' }))).toBe(false);
    expect(queueTicketOf(h({ 'tbi-queue-ticket': t }))).toBe(t);
    for (const v of [undefined, '', `${t} `, `${t}, ${t}`, [t, t], t.slice(1), 'x'.repeat(10_000)])
      expect(queueTicketOf(h({ 'tbi-queue-ticket': v }))).toBeNull();
    expect(queueTicketOf(h({ 'x-tbi-queue-ticket': t }))).toBeNull();
  });
});

describe('TicketRegistry (M2)', () => {
  it('refuses bad options', () => {
    const clock = new FakeClock(T0);
    for (const o of [
      { ttlMs: 0, cap: 10, perPrincipalCap: 2 },
      { ttlMs: 1.5, cap: 10, perPrincipalCap: 2 },
      { ttlMs: 10, cap: 0, perPrincipalCap: 2 },
      { ttlMs: 10, cap: 10, perPrincipalCap: 1 },
      { ttlMs: 10, cap: 10, perPrincipalCap: 11 },
      { ttlMs: Number.NaN, cap: 10, perPrincipalCap: 2 },
    ])
      expect(() => new TicketRegistry({ ...o, clock })).toThrow(/ticket registry/);
  });

  it('is empty until issue() is called (entries only through the explicit API)', () => {
    const { reg } = registry();
    expect(reg.size).toBe(0);
    expect(reg.lookup(newQueueTicket(), P(1))).toBeNull();
    expect(reg.markStarted(newQueueTicket(), P(1), newSessionId())).toBe(false);
    expect(reg.markDropped(newQueueTicket(), P(1), TIMEOUT)).toBe(false);
    expect(reg.forget(newQueueTicket(), P(1))).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('waiting -> started { sessionId }, once; started is terminal', () => {
    const { reg } = registry();
    const { ticket, replaced } = reg.issue(P(1));
    expect(replaced).toBe(false);
    expect(reg.lookup(ticket, P(1))).toEqual({ kind: 'waiting' });
    const id = newSessionId();
    expect(reg.markStarted(ticket, P(1), 'not-an-id')).toBe(false);
    expect(reg.markStarted(ticket, P(1), id)).toBe(true);
    expect(reg.lookup(ticket, P(1))).toEqual({ kind: 'started', sessionId: id });
    expect(reg.markStarted(ticket, P(1), newSessionId())).toBe(false);
    expect(reg.markDropped(ticket, P(1), TIMEOUT)).toBe(false);
    expect(reg.lookup(ticket, P(1))).toEqual({ kind: 'started', sessionId: id });
    expect(reg.counts()).toEqual({ waiting: 0, started: 1, dropped: 0 });
  });

  it('waiting -> dropped { limit }; the stored limit is a copy', () => {
    const { reg } = registry();
    const { ticket } = reg.issue(P(1));
    const limit = structuredClone(TIMEOUT);
    expect(reg.markDropped(ticket, P(1), limit)).toBe(true);
    limit.params.n = 9;
    expect(reg.lookup(ticket, P(1))).toEqual({ kind: 'dropped', reason: 'limit', limit: TIMEOUT });
    expect(reg.markStarted(ticket, P(1), newSessionId())).toBe(false);
    // lookup returns a copy too
    const s = reg.lookup(ticket, P(1)) as { limit: PublicLimit };
    s.limit.code = 'queue_full';
    expect(reg.lookup(ticket, P(1))).toEqual({ kind: 'dropped', reason: 'limit', limit: TIMEOUT });
  });

  it('one waiting ticket per principal: a new one replaces the old, which becomes dropped replaced', () => {
    const { reg } = registry();
    const first = reg.issue(P(1)).ticket;
    const second = reg.issue(P(1));
    expect(second.replaced).toBe(true);
    expect(second.ticket).not.toBe(first);
    expect(reg.lookup(first, P(1))).toEqual({ kind: 'dropped', reason: 'replaced' });
    expect(reg.lookup(second.ticket, P(1))).toEqual({ kind: 'waiting' });
    expect(reg.counts()).toEqual({ waiting: 1, started: 0, dropped: 1 });
    // a replaced ticket can never come back
    expect(reg.markStarted(first, P(1), newSessionId())).toBe(false);
    expect(reg.lookup(first, P(1))).toEqual({ kind: 'dropped', reason: 'replaced' });
    // a third tab: the second becomes replaced too, the first stays replaced
    const third = reg.issue(P(1)).ticket;
    expect(reg.lookup(first, P(1))).toEqual({ kind: 'dropped', reason: 'replaced' });
    expect(reg.lookup(second.ticket, P(1))).toEqual({ kind: 'dropped', reason: 'replaced' });
    expect(reg.lookup(third, P(1))).toEqual({ kind: 'waiting' });
    // a started ticket is not waiting: a new ticket does not replace it
    expect(reg.markStarted(third, P(1), newSessionId())).toBe(true);
    expect(reg.issue(P(1)).replaced).toBe(false);
    expect(reg.lookup(third, P(1))?.kind).toBe('started');
    // other principals are untouched
    const other = reg.issue(P(2));
    expect(other.replaced).toBe(false);
  });

  it('a foreign ticket is indistinguishable from an unknown one and changes nothing', () => {
    const { reg } = registry();
    const mine = reg.issue(P(1)).ticket;
    const unknown = newQueueTicket();
    expect(reg.lookup(mine, P(2))).toBeNull();
    expect(reg.lookup(mine, P(2))).toEqual(reg.lookup(unknown, P(2)));
    expect(reg.markStarted(mine, P(2), newSessionId())).toBe(false);
    expect(reg.markDropped(mine, P(2), TIMEOUT)).toBe(false);
    expect(reg.forget(mine, P(2))).toBe(false);
    expect(reg.lookup(mine, P(1))).toEqual({ kind: 'waiting' });
    // the foreign principal's own issue does not replace it
    reg.issue(P(2));
    expect(reg.lookup(mine, P(1))).toEqual({ kind: 'waiting' });
    // malformed tickets are unknown
    for (const bad of ['', 'x', `${mine}A`, null, 7]) expect(reg.lookup(bad, P(1))).toBeNull();
  });

  it('forget (cancel) removes only the own ticket', () => {
    const { reg } = registry();
    const t = reg.issue(P(1)).ticket;
    expect(reg.forget(t, P(1))).toBe(true);
    expect(reg.lookup(t, P(1))).toBeNull();
    expect(reg.size).toBe(0);
    // the principal has no waiting ticket any more: a new one replaces nothing
    expect(reg.issue(P(1)).replaced).toBe(false);
  });

  it('TTL: an entry expires ttlMs after its last state change and then behaves as unknown', () => {
    const { reg, clock } = registry();
    const t = reg.issue(P(1)).ticket;
    clock.advance(TTL - 1);
    expect(reg.lookup(t, P(1))).toEqual({ kind: 'waiting' });
    clock.advance(1);
    expect(reg.lookup(t, P(1))).toBeNull();
    expect(reg.size).toBe(0);
    expect(reg.markStarted(t, P(1), newSessionId())).toBe(false);
    // the expired waiting ticket no longer counts as the principal's waiting one
    expect(reg.issue(P(1)).replaced).toBe(false);

    // a state change restarts the TTL once: started stays readable for ttlMs after the start
    const u = reg.issue(P(2)).ticket;
    clock.advance(TTL - 10);
    expect(reg.markStarted(u, P(2), newSessionId())).toBe(true);
    clock.advance(TTL - 1);
    expect(reg.lookup(u, P(2))?.kind).toBe('started');
    clock.advance(1);
    expect(reg.lookup(u, P(2))).toBeNull();

    // a replaced ticket stays answerable for ttlMs after it was replaced
    const r1 = reg.issue(P(3)).ticket;
    clock.advance(TTL - 5);
    reg.issue(P(3));
    clock.advance(TTL - 1);
    expect(reg.lookup(r1, P(3))).toEqual({ kind: 'dropped', reason: 'replaced' });
    clock.advance(1);
    expect(reg.lookup(r1, P(3))).toBeNull();
  });

  it('sweep removes expired entries (count only) and issue sweeps first', () => {
    const { reg, clock } = registry({ cap: 3, perPrincipalCap: 2 });
    reg.issue(P(1));
    reg.issue(P(2));
    clock.advance(TTL);
    expect(reg.sweep()).toBe(2);
    expect(reg.size).toBe(0);
    const a = reg.issue(P(3)).ticket;
    reg.issue(P(4));
    clock.advance(TTL);
    reg.issue(P(5)); // sweeps a and P(4) instead of evicting anything live
    expect(reg.size).toBe(1);
    expect(reg.lookup(a, P(3))).toBeNull();
  });

  it('cap: a ticketless flood from many principals never grows past the cap (oldest first)', () => {
    const cap = 25;
    const { reg, clock } = registry({ cap });
    const issued: { p: string; t: string }[] = [];
    for (let i = 0; i < 1_000; i++) {
      const p = P(i);
      issued.push({ p, t: reg.issue(p).ticket });
      clock.advance(1);
      expect(reg.size).toBeLessThanOrEqual(cap);
    }
    expect(reg.size).toBe(cap);
    // the newest `cap` survive, every older one behaves as unknown
    for (const [i, { p, t }] of issued.entries())
      expect(reg.lookup(t, p)).toEqual(i >= 1_000 - cap ? { kind: 'waiting' } : null);
    expect(reg.counts()).toEqual({ waiting: cap, started: 0, dropped: 0 });
  });

  it('cap: a flood from ONE principal never exceeds its own cap and never evicts other principals', () => {
    const cap = 25;
    const perPrincipalCap = 4;
    const { reg, clock } = registry({ cap, perPrincipalCap });
    const others = Array.from({ length: 10 }, (_, i) => ({ p: P(100 + i), t: '' }));
    for (const o of others) o.t = reg.issue(o.p).ticket;
    const mine: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      mine.push(reg.issue(P(1)).ticket);
      clock.advance(1);
      expect(reg.size).toBeLessThanOrEqual(cap);
      expect(reg.size).toBeLessThanOrEqual(others.length + perPrincipalCap);
    }
    for (const o of others) expect(reg.lookup(o.t, o.p)).toEqual({ kind: 'waiting' });
    // the flooder keeps its newest ticket waiting and the most recent replaced ones
    expect(reg.lookup(mine.at(-1), P(1))).toEqual({ kind: 'waiting' });
    for (const t of mine.slice(-perPrincipalCap, -1))
      expect(reg.lookup(t, P(1))).toEqual({ kind: 'dropped', reason: 'replaced' });
    for (const t of mine.slice(0, -perPrincipalCap)) expect(reg.lookup(t, P(1))).toBeNull();
    expect(reg.counts()).toEqual({ waiting: 11, started: 0, dropped: perPrincipalCap - 1 });
  });

  it("an evicted waiting ticket is unknown and no longer the principal's waiting ticket", () => {
    const { reg } = registry({ cap: 2, perPrincipalCap: 2 });
    const a = reg.issue(P(1)).ticket;
    reg.issue(P(2));
    reg.issue(P(3)); // evicts a
    expect(reg.lookup(a, P(1))).toBeNull();
    expect(reg.issue(P(1)).replaced).toBe(false);
    expect(reg.size).toBe(2);
  });

  it('no trustworthy time: issue refuses (throws), nothing is created', () => {
    const { reg, clock } = registry();
    const t = reg.issue(P(1)).ticket;
    clock.t = Number.NaN;
    expect(() => reg.issue(P(2))).toThrow(/no trustworthy time/);
    expect(() => reg.lookup(t, P(1))).toThrow(/no trustworthy time/);
    clock.t = T0;
    expect(reg.size).toBe(1);
  });

  it('never logs, and no ticket value appears in any output', () => {
    const { reg, clock } = registry({ cap: 30 });
    const tickets: string[] = [];
    for (let i = 0; i < 200; i++) {
      const t = reg.issue(P(i % 40)).ticket;
      tickets.push(t);
      if (i % 3 === 0) reg.markStarted(t, P(i % 40), newSessionId());
      if (i % 5 === 0) reg.markDropped(t, P(i % 40), TIMEOUT);
      if (i % 7 === 0) reg.forget(t, P(i % 40));
      reg.lookup(t, P((i + 1) % 40));
      clock.advance(10_000);
      reg.sweep();
    }
    expect(output).toEqual([]);
    // nothing but issue() returns a ticket value; the registry does not serialise its entries
    const visible = JSON.stringify([reg.counts(), reg]);
    for (const t of tickets) expect(visible).not.toContain(t);
  });
});

describe('hasWaiting peek (M3): read-only', () => {
  const cfg = (enabled = true) =>
    parseConfig({ metering: { enabled }, queue: { maxWaitMs: 60_000, vanishMs: 20_000 } });

  it('FairQueue.hasWaiting follows tick()s expiry rules and mutates nothing', () => {
    const clock = new FakeClock(T0);
    const q = new FairQueue(cfg(), clock);
    expect(q.hasWaiting(P(1))).toBe(false);
    const t = newQueueTicket();
    expect(q.enqueue({ ticket: t, principal: P(1), plan: 'legacy', simMsToday: 0 }).ok).toBe(true);
    const before = q.snapshot();
    expect(q.hasWaiting(P(1))).toBe(true);
    expect(q.hasWaiting(P(2))).toBe(false);
    clock.advance(19_999);
    expect(q.hasWaiting(P(1))).toBe(true);
    expect(q.snapshot()).toEqual(before); // no lease refresh, no reorder
    clock.advance(1); // vanished now (no poll for vanishMs)
    expect(q.hasWaiting(P(1))).toBe(false);
    expect(q.length).toBe(1); // still there: only tick() removes it
    expect(q.tick().map((d) => d.reason)).toEqual(['vanished']);

    const u = newQueueTicket();
    q.enqueue({ ticket: u, principal: P(2), plan: 'legacy', simMsToday: 0 });
    for (let i = 0; i < 3; i++) {
      clock.advance(19_000);
      q.touch(u, P(2));
    }
    clock.advance(3_000); // 60 s since enqueue: max wait reached
    expect(q.hasWaiting(P(2))).toBe(false);
  });

  it('SimHostAdapter.hasWaiting: false when metering is disabled; the queue view otherwise', async () => {
    const clock = new FakeClock(T0);
    const off = await SimHostAdapter.open(new MemoryStore<SimEvent>(), {
      config: cfg(false),
      clock,
    });
    expect(off.hasWaiting(P(1))).toBe(false);

    const store = new MemoryStore<SimEvent>();
    const on = await SimHostAdapter.open(store, { config: cfg(true), clock });
    const t = newQueueTicket();
    const a = await on.admit({
      ticket: t,
      sessionId: newSessionId(),
      principal: P(1),
      plan: 'legacy',
      slots: { capacity: 0, running: 0 },
    });
    expect(a).toMatchObject({ metered: true, decision: 'queued', position: 1 });
    const writes = store.appendCalls;
    expect(on.hasWaiting(P(1))).toBe(true);
    expect(on.hasWaiting(P(2))).toBe(false);
    expect(on.waiting).toBe(1);
    expect(store.appendCalls).toBe(writes);
    on.cancel(t, P(1));
    expect(on.hasWaiting(P(1))).toBe(false);
  });
});
