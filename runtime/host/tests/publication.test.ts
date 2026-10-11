/**
 * Sprint 12 Gate B (H-1): the published stream is sampled per publication window, and windows are
 * attributed by event time, whatever simulation time a tick reports. QEMU arms ticks on the
 * quantum grid but reports the virtual clock at which the tick ran, which can be an instruction
 * past the deadline; before the fix a late tick at a window boundary skipped that window, and
 * persistent late ticks stopped publication altogether. Fake runtime; the same host runs against
 * real QEMU in runtime/tests/s12-*.runtime.test.ts.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { principalFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { SessionEvent } from '../protocol.js';
import { alive, createRequest, fakeHost, gone, waitEvent, waitState } from './support.js';

const MS = 1_000_000n;
const WINDOW = 10n * MS;
const HORIZON = 100n * MS;

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

type Gpio = Extract<SessionEvent, { type: 'gpio' }>;
const at = (e: SessionEvent) => BigInt(e.simNs ?? '0');

/**
 * One session of the fake firmware: GPIO2 toggles every 5 ms off the grid; the toggle switch on
 * GPIO5 closes at 12 ms and opens at 31 ms, and GPIO18 follows GPIO5 8 ns later (with serial).
 */
async function runSession(env: Record<string, string>, horizon = HORIZON) {
  const { host, art } = fakeHost('normal', {
    runtimeEnv: { PATH: process.env.PATH, TBI_FAKE_MODE: 'normal', ...env },
  });
  hosts.push(host);
  const req = createRequest(art.sha256);
  const sw = req.circuit.components.find((c) => c.type === 'component.toggle_switch')!.id;
  const c = host.create(req, principalFor());
  if (!c.ok) throw new Error(c.error);
  const s = c.value.session;
  for (const [seq, ms, closed] of [
    [1, 12, true],
    [2, 31, false],
  ] as const)
    host.command(s, {
      category: 'mirror',
      seq,
      atSimNs: (BigInt(ms) * MS).toString(),
      projectRevision: seq + 1,
      component: sw,
      control: { closed },
    });
  s.run();
  await waitEvent(s, (e) => e.type === 'gpio' && at(e) > horizon + WINDOW);
  const pid = s.status().runtime.pid;
  s.stop();
  await waitState(s, 'ended');
  await s.done();
  return { s, pid, dir: s.privateDir, events: s.log.since(0) };
}

/** Published runtime state up to the horizon (command acks carry the tick's own time). */
const published = (events: SessionEvent[], horizon = HORIZON) =>
  events.filter((e) => ['gpio', 'electrical', 'serial'].includes(e.type) && at(e) <= horizon);
const hash = (events: SessionEvent[]) =>
  createHash('sha256').update(JSON.stringify(events)).digest('hex');
const transitions = (events: SessionEvent[], gpio: number) =>
  events
    .filter((e): e is Gpio => e.type === 'gpio')
    .flatMap((e) => e.changes.filter((c) => c.gpio === gpio))
    .reduce((a, c) => a + c.transitions, 0);
const serial = (events: SessionEvent[]) =>
  events
    .filter((e) => e.type === 'serial')
    .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
    .join('');

/** Stream invariants: seq strictly increasing, runtime simNs non-decreasing, one window per stamp. */
function expectWellFormed(events: SessionEvent[]) {
  for (let i = 1; i < events.length; i++) expect(events[i]!.seq).toBe(events[i - 1]!.seq + 1);
  const runtime = events.filter((e) => e.simNs !== null);
  for (let i = 1; i < runtime.length; i++)
    expect(at(runtime[i]!) >= at(runtime[i - 1]!), `${runtime[i]!.seq}`).toBe(true);
  // Every window is published once: no two events of one type carry the same stamp.
  for (const type of ['gpio', 'electrical', 'serial']) {
    const stamps = events.filter((e) => e.type === type).map((e) => e.simNs);
    expect(new Set(stamps).size, type).toBe(stamps.length);
  }
}

describe('H-1: publication is attributed by event time, not by when a tick ran', () => {
  let exact: Awaited<ReturnType<typeof runSession>>;

  it('baseline (exact ticks): one window per 10 ms, every edge counted, stamps on the boundary', async () => {
    exact = await runSession({});
    const pub = published(exact.events);
    expectWellFormed(exact.events);
    const gpio = pub.filter((e): e is Gpio => e.type === 'gpio');
    expect(gpio.map(at)).toEqual(Array.from({ length: 10 }, (_, i) => BigInt(i + 1) * WINDOW));
    // GPIO2 toggles at 4.001234 ms + 5k ms: 20 edges by 100 ms, 2 per window.
    expect(transitions(pub, 2)).toBe(20);
    for (const e of gpio) expect(transitions([e], 2), `${e.simNs}`).toBe(2);
    // GPIO18 follows GPIO5: driven low at boot, high from 12 ms, low from 31 ms.
    expect(transitions(pub, 18)).toBe(3);
    expect(serial(pub)).toMatch(/^BOOT 1\nIN5=0\nIN5=1\nIN5=0\n$/);
    expect(pub.filter((e) => e.type === 'electrical').length).toBeGreaterThanOrEqual(3);
  });

  // Exact, single late, repeated isolated late, persistent late from boot and from mid-session,
  // late ticks only off the boundaries, and a run of late ticks across two boundaries.
  for (const late of [
    '4@10-10',
    '4@10-10,4@30-30,7@50-50',
    '4',
    '4@25',
    '4@11-19,4@21-29',
    '4@19-21,4@39-41',
    '7@1-9,4@10,0@11-19',
  ])
    it(`ticks late ${late}: the same published stream, byte for byte`, async () => {
      const r = await runSession({ TBI_FAKE_TICK_LATE_NS: late });
      expectWellFormed(r.events);
      // Identical published state, stamps included: no window skipped, merged, duplicated or
      // reordered, and no edge, operating point or serial byte lost.
      expect(published(r.events)).toEqual(published(exact.events));
      expect(hash(published(r.events))).toBe(hash(published(exact.events)));
      // The commands still applied at the tick at or after their time (12 and 31 ms).
      const acks = r.events.filter((e) => e.type === 'command');
      expect(acks.map((e) => (e as { result: string }).result)).toEqual(['applied', 'applied']);
      expect(acks.map((e) => at(e) / MS)).toEqual([12n, 31n]);
    });
});

describe('H-1: window boundary cases (several events, on and around a boundary)', () => {
  // GPIO4 (unattached, so recorded but not solved): high 1 ns before the 10 ms boundary, low
  // exactly on it, then high and low 5 and 6 ns after it (after any late tick). Windows are
  // (end - 10 ms, end]: the first two edges belong to the 10 ms window, the last two to the 20 ms
  // window, whether the 10 ms tick is exact or late.
  const frames = [
    '10@G 9999999 4 1 1',
    '10@G 10000000 4 1 0',
    '11@G 10000005 4 1 1',
    '11@G 10000006 4 1 0',
  ].join(';');
  const gpio4 = (events: SessionEvent[]) =>
    events
      .filter((e): e is Gpio => e.type === 'gpio' && at(e) <= 2n * WINDOW)
      .map((e) => [e.simNs, e.changes.find((c) => c.gpio === 4)]);

  for (const late of ['', '4@10-10', '4'])
    it(`events at 10 ms - 1 ns, 10 ms, 10 ms + 5 ns, + 6 ns${late ? ` (ticks late ${late})` : ''}`, async () => {
      const r = await runSession(
        { TBI_FAKE_FRAMES: frames, TBI_FAKE_TICK_LATE_NS: late },
        2n * WINDOW,
      );
      expectWellFormed(r.events);
      expect(gpio4(r.events)).toEqual([
        ['10000000', { gpio: 4, drive: 1, level: 0, transitions: 2 }],
        ['20000000', { gpio: 4, drive: 1, level: 0, transitions: 2 }],
      ]);
    });

  it('an event between a boundary and its late tick belongs to the next window', async () => {
    // Tick 10 reports 10 ms + 4 ns; a pad event at 10 ms + 2 ns arrives before it.
    const r = await runSession(
      {
        TBI_FAKE_FRAMES: '10@G 9999999 4 1 1;10@G 10000002 4 1 0',
        TBI_FAKE_TICK_LATE_NS: '4@10-10',
      },
      2n * WINDOW,
    );
    expectWellFormed(r.events);
    expect(gpio4(r.events)).toEqual([
      ['10000000', { gpio: 4, drive: 1, level: 1, transitions: 1 }],
      ['20000000', { gpio: 4, drive: 1, level: 0, transitions: 1 }],
    ]);
  });
});

describe('H-1: stop, restart and cleanup with late ticks', () => {
  it('stop publishes the partial window once; a restart is a fresh session with the same stream', async () => {
    const runs = [];
    for (let i = 0; i < 2; i++) runs.push(await runSession({ TBI_FAKE_TICK_LATE_NS: '4' }));
    for (const r of runs) {
      expect(r.s.status()).toMatchObject({ state: 'ended', reason: 'stopped' });
      expect(alive(r.pid)).toBe(false);
      expect(gone(r.dir)).toBe(true);
      expectWellFormed(r.events);
      // The final (partial) window: stamped at the last frame's time, after every full window.
      const gpio = r.events.filter((e): e is Gpio => e.type === 'gpio');
      const full = gpio.filter((e) => at(e) % WINDOW === 0n);
      expect(gpio.slice(0, full.length)).toEqual(full);
      for (let k = 0; k < full.length; k++) expect(at(full[k]!)).toBe(BigInt(k + 1) * WINDOW);
      // Every GPIO2 edge produced before the session ended was published exactly once.
      const end = at(r.events.filter((e) => e.simNs !== null).at(-1)!);
      const produced = Array.from(
        { length: 1000 },
        (_, k) => 4_001_234n + BigInt(k) * 5n * MS,
      ).filter((t) => t <= end).length;
      expect(transitions(r.events, 2)).toBe(produced);
    }
    // The restart starts from window 1 again (no state carried over) and reproduces the stream.
    expect(hash(published(runs[1]!.events))).toBe(hash(published(runs[0]!.events)));
  });
});
