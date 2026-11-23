/**
 * TBI-018 s3d-3b: SimHostAdapter.admit `mode` (design sections 3 and 4). Absent = 'join' (the s3c
 * behaviour). 'poll' never re-enqueues a ticket that no longer waits; 'legacy' never creates, replaces
 * or cancels a queue entry (its own queued outcome is removed in the same serial step).
 */
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import type { SimEvent } from '../simminutes.js';
import { SimHostAdapter, type HostAdmit, type HostAdmitRequest } from '../simhost.js';
import { MemoryStore } from '../store.js';
import { FakeClock } from '../time.js';
import { NOON } from './helpers.js';

const sid = (n: number): string => n.toString(16).padStart(32, '0');
const P = 'p_modeuser0001';
const Q = 'p_modeuser0002';

async function make() {
  const config = parseConfig({ metering: { enabled: true } });
  const clock = new FakeClock(NOON);
  const store = new MemoryStore<SimEvent>();
  const host = await SimHostAdapter.open(store, { config, clock });
  let n = 0;
  const admit = (
    principal: string,
    ticket: string,
    mode: HostAdmitRequest['mode'],
    capacity = 0,
  ): Promise<HostAdmit> =>
    host.admit({
      ticket,
      sessionId: sid(++n),
      principal,
      plan: 'legacy',
      slots: { capacity, running: 0 },
      ...(mode ? { mode } : {}),
    });
  return { host, clock, config, store, admit };
}

const kind = (r: HostAdmit) =>
  !r.metered ? 'off' : r.decision === 'refused' ? `refused:${r.error.code}` : r.decision;

describe('SimHostAdapter.admit mode (s3d-3b)', () => {
  it('poll: a waiting ticket refreshes its entry (same position)', async () => {
    const w = await make();
    expect(kind(await w.admit(P, 't1', 'join'))).toBe('queued');
    expect(kind(await w.admit(Q, 't2', 'join'))).toBe('queued');
    const r = await w.admit(P, 't1', 'poll');
    expect(r).toMatchObject({ decision: 'queued', position: 1 });
    expect(w.host.waiting).toBe(2);
  });

  it('poll: a timed-out ticket answers queue_timeout and is NOT re-enqueued', async () => {
    const w = await make();
    await w.admit(P, 't1', 'join');
    w.clock.advance(w.config.queue.maxWaitMs);
    for (let i = 0; i < 2; i++) {
      expect(kind(await w.admit(P, 't1', 'poll'))).toBe('refused:queue_timeout');
      expect(w.host.waiting).toBe(0);
    }
  });

  it('poll: a cancelled or unknown ticket answers queue_timeout, nothing enqueued', async () => {
    const w = await make();
    await w.admit(P, 't1', 'join');
    w.host.cancel('t1', P);
    expect(kind(await w.admit(P, 't1', 'poll'))).toBe('refused:queue_timeout');
    expect(kind(await w.admit(P, 'never', 'poll'))).toBe('refused:queue_timeout');
    expect(w.host.waiting).toBe(0);
  });

  it("poll: another principal's ticket is not this principal's (no re-enqueue, theirs untouched)", async () => {
    const w = await make();
    await w.admit(Q, 'tq', 'join');
    expect(kind(await w.admit(P, 'tq', 'poll'))).toBe('refused:queue_timeout');
    expect(w.host.hasWaiting(Q)).toBe(true);
    expect(w.host.hasWaiting(P)).toBe(false);
  });

  it('poll: a waiting ticket starts when its slot is free', async () => {
    const w = await make();
    await w.admit(P, 't1', 'join');
    expect(kind(await w.admit(P, 't1', 'poll', 1))).toBe('start');
    expect(w.host.waiting).toBe(0);
    expect(w.host.tracked).toBe(1);
  });

  it('legacy: a queued outcome leaves no entry; a free slot starts', async () => {
    const w = await make();
    expect(await w.admit(P, 'tl', 'legacy')).toMatchObject({ decision: 'queued', position: 1 });
    expect(w.host.waiting).toBe(0);
    expect(kind(await w.admit(P, 'tl2', 'legacy', 1))).toBe('start');
  });

  it("legacy: the principal's existing entry is never replaced or cancelled", async () => {
    const w = await make();
    await w.admit(Q, 'tq', 'join');
    await w.admit(P, 't1', 'join');
    const r = await w.admit(P, 'tl', 'legacy', 6);
    expect(r).toMatchObject({ decision: 'queued', position: 2 });
    expect(w.host.waiting).toBe(2);
    expect(kind(await w.admit(P, 't1', 'poll'))).toBe('queued');
    expect(w.host.tracked).toBe(0);
  });

  it('join (and absent mode) is the s3c behaviour; an unknown mode is invalid_request', async () => {
    const w = await make();
    expect(kind(await w.admit(P, 't1', undefined))).toBe('queued');
    expect(kind(await w.admit(P, 't2', 'join'))).toBe('queued'); // takes over P's entry
    expect(w.host.waiting).toBe(1);
    expect(kind(await w.admit(Q, 't3', 'bogus' as never))).toBe('refused:invalid_request');
    expect(w.store.appendCalls).toBe(0);
  });
});
