/**
 * Sprint 18 (F-17C-2): the Session Host's cost of PWM changes, with the fake runtime injecting the
 * frames patch 0009 sends. N high-speed channels on N pads, each pad -> 220 Ω -> LED -> GND
 * (independent loads), every channel latching a new duty at every 1 ms cycle.
 *
 * Counted, not timed (deterministic, CI-safe): the engine solves the host performs. With TBI_PERF=1
 * the wall time spent in solves is also printed (evidence for the record, never asserted).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineSession } from '@tbi-lab/engine';
import { principalFor, ticketFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import { HostSession, PWM_SOLVE_BUDGET_PER_SIM_S } from '../session.js';
import { Circuit } from './r1-support.js';
import { fakeHost, waitState } from './support.js';

const CAPS = '2 i2c,pad-func,pwm,sched-input';
const GPIOS = [18, 19, 21, 22, 23, 25, 26, 27];
const hosts: SessionHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

function bench(n: number, gpio2 = false) {
  const c = new Circuit();
  // The fake firmware toggles GPIO2 every 5 ms: optionally a plain digital LED load on it.
  if (gpio2) {
    const r = c.add('component.resistor');
    const d = c.add('component.led');
    c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(2, `${r}.a`);
  }
  for (const gpio of GPIOS.slice(0, n)) {
    const r = c.add('component.resistor');
    const d = c.add('component.led');
    c.ohms(r, 220)
      .wire(`${r}.b`, `${d}.anode`)
      .wire(`${d}.cathode`, 'GND1.ref')
      .pad(gpio, `${r}.a`);
  }
  return c;
}

/**
 * Frames: pad i routed to high-speed channel i (signal 71 + i), timer 0 at 1 kHz from REF_TICK
 * (8 bit), then before each tick t in [12, 12 + cycles) each channel's duty, where it changes. `pattern`
 * gives the duty of channel i at tick t (0 < duty < 256 is a waveform; 0 is duty 0).
 */
function frames(n: number, cycles: number, pattern: (i: number, t: number) => number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`F 9500000 ${GPIOS[i]} periph:${71 + i} 0`);
  out.push('P 9500100 0 reset', 'P 9500200 0 run 1000000 1000 8');
  for (let i = 0; i < n; i++) out.push(`W 9500300 ${71 + i} on 0 0 ${pattern(i, 11)}`);
  for (let t = 12; t < 12 + cycles; t++)
    for (let i = 0; i < n; i++)
      if (pattern(i, t) !== pattern(i, t - 1))
        out.push(`${t}@W ${(t - 1) * 1_000_000 + 300_000} ${71 + i} on 0 0 ${pattern(i, t)}`);
  return out;
}

async function measure(
  n: number,
  cycles: number,
  pattern: (i: number, t: number) => number,
  opts: { cache?: number; budget?: number; gpio2?: boolean } = {},
) {
  const keep = [HostSession.pwmPointsCacheEntries, HostSession.pwmSolveBudgetPerSimS] as const;
  HostSession.pwmPointsCacheEntries = opts.cache ?? keep[0];
  HostSession.pwmSolveBudgetPerSimS = opts.budget ?? keep[1];
  try {
    return await measureWith(n, cycles, pattern, opts.gpio2 ?? false);
  } finally {
    [HostSession.pwmPointsCacheEntries, HostSession.pwmSolveBudgetPerSimS] = keep;
    vi.restoreAllMocks();
  }
}

async function measureWith(
  n: number,
  cycles: number,
  pattern: (i: number, t: number) => number,
  gpio2: boolean,
) {
  const r = fakeHost('normal', {
    runtimeEnv: {
      PATH: process.env.PATH,
      TBI_FAKE_MODE: 'normal',
      TBI_FAKE_HELLO: CAPS,
      TBI_FAKE_FRAMES: frames(n, cycles, pattern).join(';'),
    },
  });
  hosts.push(r.host);
  const solve = EngineSession.prototype.solve;
  let solves = 0;
  let ms = 0;
  vi.spyOn(EngineSession.prototype, 'solve').mockImplementation(function (this: EngineSession) {
    const t0 = performance.now();
    try {
      return solve.call(this);
    } finally {
      ms += performance.now() - t0;
      solves++;
    }
  });
  // The whole host reaction to a latched change (solves, A1 combination, servos, inputs).
  const proto = HostSession.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const react = proto.solveAndInject!;
  let hostMs = 0;
  // Solves after the first configuration is known (from 15 ms on), and the operating point after
  // every reaction (the comparison of the cached and uncached paths).
  let lateSolves = 0;
  let lateMs = 0;
  let lateCalls = 0;
  const latest: { vns: bigint; o: string }[] = [];
  vi.spyOn(proto, 'solveAndInject').mockImplementation(function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    const s0 = solves;
    try {
      return react.apply(this, a);
    } finally {
      hostMs += performance.now() - t0;
      if ((a[0] as bigint) >= 15_000_000n) {
        lateSolves += solves - s0;
        lateMs += performance.now() - t0;
        lateCalls++;
      }
      latest.push({ vns: a[0] as bigint, o: JSON.stringify((this as { latest: unknown }).latest) });
    }
  });
  const ticket = ticketFor(r.art.sha256, principalFor(), null);
  const c = r.host.create({ ...bench(n, gpio2).request(r.art.sha256), ticket }, principalFor());
  if (!c.ok) throw new Error(c.error);
  const s: HostSession = c.value.session;
  s.run();
  await waitState(s, 'running');
  // Until the last latched change has been applied (the fake runtime sends ticks unpaced).
  const until = BigInt(12 + cycles + 2) * 1_000_000n;
  const t0 = Date.now();
  const live = () => !['failed', 'ended'].includes(s.status().state);
  while (live() && BigInt(s.status().simNs ?? '0') < until && Date.now() - t0 < 60_000)
    await new Promise((res) => setTimeout(res, 20));
  const before = { solves, ms, hostMs, lateSolves, lateMs, lateCalls };
  if (live()) s.stop();
  await Promise.race([waitState(s, 'ended', 15_000), waitState(s, 'failed', 15_000)]);
  await s.done();
  // For the cached/uncached comparison: everything up to `until` (the run stops at a wall-clock
  // moment, so what follows differs between runs).
  const published = s.log
    .since(0)
    .filter((e) => (e.type === 'electrical' || e.type === 'gpio') && BigInt(e.simNs!) <= until)
    .map((e) => JSON.stringify(e));
  const pwmErrors = s.log
    .since(0)
    .filter(
      (e) => e.type === 'diagnostic' && String((e as { code?: string }).code).startsWith('pwm'),
    );
  return {
    ...before,
    status: s.status(),
    pwmErrors,
    published,
    latest: latest.filter((x) => x.vns <= until).map((x) => x.o),
  };
}

const perf = process.env.TBI_PERF === '1';
const fade = (i: number, t: number) => 1 + ((t * 7 + i * 31) % 254);

describe('R4 PWM scaling on the Session Host (F-17C-2)', () => {
  it.each([1, 2, 4, 8])('%i channels fading: solves per latched change', async (n) => {
    const cycles = 40;
    const m = await measure(n, cycles, fade);
    expect(m.status).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(m.pwmErrors).toEqual([]);
    if (perf)
      console.log(
        `F-17C-2 n=${n} solves=${m.solves} perCycle=${(m.solves / cycles).toFixed(2)} ` +
          `solveMs=${m.ms.toFixed(1)} perCycleMs=${(m.ms / cycles).toFixed(3)} ` +
          `hostPerCycleMs=${(m.hostMs / cycles).toFixed(3)} ` +
          `steadyPerReactionMs=${(m.lateMs / m.lateCalls).toFixed(3)} (${m.lateCalls} reactions)`,
      );
    // A fade moves no operating point: one solve set for the configuration, none per change.
    expect(m.lateSolves).toBe(0);
  });

  it('8 channels: the cached path publishes exactly what solving every change publishes', async () => {
    const cached = await measure(8, 20, fade);
    // Uncached: every change solved (the budget lifted: this arm compares, it does not police).
    const uncached = await measure(8, 20, fade, { cache: 0, budget: 1e9 });
    expect(uncached.solves).toBeGreaterThan(20 * 38);
    expect(cached.latest.length).toBeGreaterThan(20);
    expect(cached.latest).toEqual(uncached.latest);
    expect(cached.published.length).toBeGreaterThan(5);
    expect(cached.published).toEqual(uncached.published);
  });
});

// Sprint 18: a staggered 8-channel triangle fade (period 512 ms, a step every 8 ms, channel i
// offset by 64 ms) between 8/256 and 100 % (a static high: the set of switching pads changes; duty
// 0 into an LED is refused, O-R4-1). Evidence for the cache size (printed with TBI_PERF=1).
describe('R4 PWM scaling: configuration changes (F-17C-2)', () => {
  const tri = (i: number, t: number) => {
    const k = Math.floor((t + i * 64) / 8) % 64; // 64 steps of 8 ms
    return 8 * (k < 32 ? k + 1 : 64 - k); // 8 .. 256, 256 .. 8
  };
  it.each([16, 64])('staggered fade, cache %i', async (entries) => {
    const cycles = 1100;
    const m = await measure(8, cycles, tri, { cache: entries });
    expect(m.status).toMatchObject({ state: 'ended', reason: 'stopped' });
    if (perf)
      console.log(
        `F-17C-2 staggered cache=${entries} solves=${m.solves} lateSolves=${m.lateSolves} ` +
          `solveMs=${m.ms.toFixed(1)} hostMs=${m.hostMs.toFixed(1)} reactions=${m.lateCalls} ` +
          `steadyPerReactionMs=${(m.lateMs / m.lateCalls).toFixed(3)}`,
      );
    // Deterministic (fixed frames): the first configuration (10 solves at start, then 38), then
    // the 8 configurations with one pad at 100 % (30 solves each) once each; the second 512 ms
    // period is all cache hits.
    expect(m.solves).toBe(288);
    expect(m.lateSolves).toBe(8 * 30);
  });
});

// Sprint 18 (independent review): only changes of the switching-pad configuration are charged.
// Eight steady PWM pads and a digital LED that the firmware toggles every 5 ms, with the cache
// disabled so that every edge is a full 38-solve miss (~7600 solves per simulated second): not a
// PWM reconfiguration, so it is not refused (before the review it would have been).
describe('R4 PWM scaling: the budget charges reconfigurations only (F-17C-2)', () => {
  it('digital edges next to steady PWM pads are not charged', async () => {
    const m = await measure(8, 600, () => 128, { cache: 0, gpio2: true });
    expect(m.status).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(m.pwmErrors).toEqual([]);
    expect(m.solves).toBeGreaterThan(2000);
  });
});

// Sprint 18: a sketch that makes every 1 ms cycle a new configuration (channel i at 100 % when bit
// i of the cycle number is set, else 50 %) exceeds the budget and is refused, named, at the same
// simulated instant on every run; nothing is slowed down or approximated.
describe('R4 PWM scaling: the budget (F-17C-2)', () => {
  const binary = (i: number, t: number) => (((t >> i) & 1) === 1 ? 256 : 128);
  it('a new configuration every cycle: refused as pwm_rate_exceeded, deterministically', async () => {
    const runs = [await measure(8, 300, binary), await measure(8, 300, binary)];
    const refusals = runs.map((m) => {
      expect(m.status).toMatchObject({ state: 'failed', reason: 'pwm_unsupported' });
      const d = m.pwmErrors as unknown as {
        code: string;
        simNs: string;
        detail: { used: number; needed: number; budget: number; gpios: number[] };
      }[];
      expect(d.map((x) => x.code)).toEqual(['pwm_rate_exceeded']);
      expect(d[0]!.detail.budget).toBe(PWM_SOLVE_BUDGET_PER_SIM_S);
      expect(d[0]!.detail.used + d[0]!.detail.needed).toBeGreaterThan(PWM_SOLVE_BUDGET_PER_SIM_S);
      // The pads switching in the refused configuration (the others are at a static 100 %).
      expect(d[0]!.detail.gpios.length).toBeGreaterThan(0);
      expect(d[0]!.detail.gpios.every((g) => GPIOS.includes(g))).toBe(true);
      return d[0]!.simNs;
    });
    expect(refusals[0]).toBe(refusals[1]);
    if (perf) console.log(`F-17C-2 budget refusal at simNs=${refusals[0]}`);
  });
});
