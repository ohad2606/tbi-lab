/**
 * T-R4-1 (host half): LEDC frames -> exact waveforms, by the hardware's update rules, checked
 * against hand calculation (the values of docs/sprints/s13-evidence/r4/R4-PROBE.md §4) and against
 * the frame sequences patch 0009 produced for the three probe sketches.
 */
import { describe, expect, it } from 'vitest';
import { parseFrame, ProtocolError, type Frame } from '../../harness/protocol.js';
import { edgesIn, LedcTracker, ns, ratFloorNs, ratToNumber, type Waveform } from '../pwm.js';

/** Feed frames to a tracker; return the waveform of `signal` at `atNs`. */
function run(lines: string[], signal: number, atNs: bigint): Waveform {
  const t = new LedcTracker();
  for (const line of lines) {
    const f = parseFrame(line) as Extract<Frame, { type: 'P' | 'W' }>;
    if (f.vns > atNs) break; // the state at atNs: later frames have not happened yet
    t.advance(f.vns);
    if (f.type === 'P') t.timer(f.vns, f.timer, f.state);
    else t.channel(f.vns, f.signal, f.state);
  }
  t.advance(atNs);
  return t.waveform(signal);
}
const wave = (w: Waveform) => {
  if (w.kind !== 'wave') throw new Error(`not a wave: ${JSON.stringify(w)}`);
  return { period: ratToNumber(w.periodNs), high: ratToNumber(w.highNs), duty: w.duty, w };
};

// patch 0009 on R4ProbeAnalog (analogWrite(2, 64/128/255/0), 50 ms apart), verbatim.
const ANALOG = [
  'P 889240752 0 run 1000000 1000 8',
  'P 889244072 0 reset',
  'P 889244128 0 run 1000000 1000 8',
  'W 889255136 71 on 0 0 0',
  'W 889272256 71 on 0 0 64',
  'W 939762315 71 on 0 0 128',
  'W 989762331 71 on 0 0 256',
  'W 1039762315 71 on 0 0 0',
];
// R4ProbeServo (ledcAttach(18, 50, 16); 3277 / 4915 / 6554, 100 ms apart).
const SERVO = [
  'P 890240512 0 run 80000000 6250 16',
  'P 890243832 0 reset',
  'P 890243888 0 run 80000000 6250 16',
  'W 890254896 71 on 0 0 0',
  'W 890272088 71 on 0 0 3277',
  'W 990761998 71 on 0 0 4915',
  'W 1090761998 71 on 0 0 6554',
];

describe('LEDC waveforms (T-R4-1, host)', () => {
  it('analogWrite: REF_TICK 1 MHz / 3.90625 / 256 = 1 kHz exactly; duty 64, 128, 255 -> 25 %, 50 %, high', () => {
    // A duty change takes effect at the next cycle: the counter restarted at 889 244 128 ns.
    const w64 = wave(run(ANALOG, 71, 900_000_000n));
    expect(w64.period).toBe(1_000_000);
    expect(w64.high).toBe(250_000);
    expect(w64.duty).toBe(0.25);
    expect(w64.w.risingNs).toEqual(ns(889_244_128n));
    expect(wave(run(ANALOG, 71, 950_000_000n)).high).toBe(500_000);
    // analogWrite(255) writes 2^8: constant high (the low point is never reached).
    expect(run(ANALOG, 71, 1_000_000_000n)).toEqual({ kind: 'static', level: 1 });
    // Duty 0: not established (O-R4-1), never assumed low.
    expect(run(ANALOG, 71, 1_050_000_000n).kind).toBe('zero');
  });

  it('the attach-time duty 0 is replaced before the first cycle: it never takes effect', () => {
    // 'on 0 0 0' at 889 255 136 and 'on 0 0 64' at 889 272 256 latch at the same overflow
    // (890 244 128); before it the channel keeps its previous state (idle 0).
    expect(run(ANALOG, 71, 890_000_000n)).toEqual({ kind: 'static', level: 0 });
    expect(run(ANALOG, 71, 890_244_128n).kind).toBe('wave');
  });

  it('a new duty waits for the cycle boundary, not the write', () => {
    // 128 written at 939 762 315: the cycle in progress (started 939 244 128) keeps 64.
    expect(wave(run(ANALOG, 71, 939_900_000n)).high).toBe(250_000);
    expect(wave(run(ANALOG, 71, 940_244_128n)).high).toBe(500_000);
  });

  it('servo: APB 80 MHz / 24.4140625 / 65536 = 50.000 Hz; 3277/4915/6554 -> 1000.061/1499.939/2000.122 us', () => {
    const at = [950_000_000n, 1_050_000_000n, 1_150_000_000n];
    const highs = at.map((t) => wave(run(SERVO, 71, t)));
    expect(highs[0]!.period).toBe(20_000_000);
    // Exact rationals: 3277 * 6250 / 256 / 80 MHz.
    const h = highs[0]!.w.highNs;
    expect(h.n * (256n * 80_000_000n)).toBe(h.d * (3277n * 6250n * 1_000_000_000n));
    expect(highs[0]!.high).toBeCloseTo(1_000_061.03515625, 6);
    expect(highs[1]!.high).toBeCloseTo(1_499_938.96484375, 6);
    expect(highs[2]!.high).toBeCloseTo(2_000_122.0703125, 6);
  });

  it('5 kHz / 12 bit on APB; a second channel on timer 1 at 1 kHz', () => {
    const lines = [
      'P 889240456 0 run 80000000 1000 12',
      'P 889243776 0 reset',
      'P 889243832 0 run 80000000 1000 12',
      'W 889254840 71 on 0 0 0',
      'W 939762002 71 on 0 0 1024',
      'W 989762002 71 on 0 0 2048',
      'W 1039762018 71 on 0 0 4096',
      'P 1089799930 1 run 1000000 1000 8',
      'P 1089803250 1 reset',
      'P 1089803306 1 run 1000000 1000 8',
      'W 1089814314 72 on 0 0 0',
      'W 1089816026 72 on 1 0 0',
      'W 1089831442 72 on 1 0 64',
    ];
    const a = wave(run(lines, 71, 950_000_000n));
    expect(a.period).toBe(200_000);
    expect(a.high).toBe(50_000);
    expect(wave(run(lines, 71, 1_000_000_000n)).high).toBe(100_000);
    expect(run(lines, 71, 1_050_000_000n)).toEqual({ kind: 'static', level: 1 });
    const b = wave(run(lines, 72, 1_100_000_000n));
    expect(b.period).toBe(1_000_000);
    expect(b.high).toBe(250_000);
    expect(b.w.risingNs).toEqual(ns(1_089_803_306n));
  });

  it('a timer change takes effect at its next overflow; the new period sequence starts there', () => {
    const lines = [
      'P 1000 0 reset',
      'P 2000 0 run 1000000 1000 8', // 1 ms from 2000 ns
      'W 3000 71 on 0 0 128',
      'P 1500000 0 run 1000000 500 8', // 500 us periods from the overflow at 2 002 000
    ];
    expect(wave(run(lines, 71, 1_900_000n)).period).toBe(1_000_000);
    const w = wave(run(lines, 71, 2_002_000n));
    expect(w.period).toBe(500_000);
    expect(w.high).toBe(250_000);
    expect(w.w.risingNs).toEqual(ns(2_002_000n));
    // Changing back before the overflow cancels the change.
    expect(wave(run([...lines, 'P 1600000 0 run 1000000 1000 8'], 71, 2_500_000n)).period).toBe(
      1_000_000,
    );
  });

  it('disabling the output gives the idle level at once', () => {
    expect(run([...ANALOG.slice(0, 5), 'W 950000000 71 idle 1'], 71, 950_000_000n)).toEqual({
      kind: 'static',
      level: 1,
    });
  });

  it('refusals: held timer, runtime refusals, hpoint reaching the period end', () => {
    expect(run([...ANALOG.slice(0, 5), 'P 950000000 0 reset'], 71, 960_000_000n)).toEqual({
      kind: 'unsupported',
      why: 'timer-reset',
    });
    expect(run([...ANALOG.slice(0, 5), 'P 950000000 0 paused'], 71, 960_000_000n)).toEqual({
      kind: 'unsupported',
      why: 'timer-paused',
    });
    expect(run(['W 5 79 unsupported low-speed'], 79, 10n)).toEqual({
      kind: 'unsupported',
      why: 'low-speed',
    });
    expect(run([...ANALOG.slice(0, 3), 'W 900000000 71 on 0 10 246'], 71, 902_000_000n)).toEqual({
      kind: 'unsupported',
      why: 'hpoint',
    });
  });

  it('edges: whole pulses of each segment, in order, exact to the floored nanosecond', () => {
    const w = run(SERVO, 71, 950_000_000n);
    if (w.kind !== 'wave') throw new Error('wave expected');
    const seg = ns(890_243_888n + 20_000_000n);
    // (from, to]: the rising edge exactly at the segment start belongs to a window that starts
    // before it. Periods start at 910.24, 930.24 and 950.24 ms; the last pulse ends at 951.24.
    const e = edgesIn(w, seg, ns(910_000_000n), ns(952_000_000n), 0);
    expect(e.length).toBe(6);
    expect(e.map((x) => x.level)).toEqual([1, 0, 1, 0, 1, 0]);
    expect(ratFloorNs(e[1]!.at) - ratFloorNs(e[0]!.at)).toBe(1_000_061n);
    // A static level gives one edge, only when it differs from the level before.
    expect(edgesIn({ kind: 'static', level: 1 }, ns(5n), ns(0n), ns(10n), 0)).toEqual([
      { at: ns(5n), level: 1 },
    ]);
    expect(edgesIn({ kind: 'static', level: 0 }, ns(5n), ns(0n), ns(10n), 0)).toEqual([]);
  });

  it('is a pure function of the frames', () => {
    const a = JSON.stringify(run(SERVO, 71, 1_234_567_891n), (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    const b = JSON.stringify(run(SERVO, 71, 1_234_567_891n), (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(a).toBe(b);
  });

  it('a pause freezes the counter: resuming with the same configuration shifts the phase (review M1)', () => {
    const lines = [
      'P 1000 0 reset',
      'P 2000 0 run 1000000 1000 8', // 1 ms periods from 2000 ns
      'W 3000 71 on 0 0 128',
      'P 1500000 0 paused',
      'P 1800000 0 run 1000000 1000 8', // paused for 300 us
    ];
    const w = run(lines, 71, 1_900_000n);
    expect(wave(w).w.risingNs).toEqual(ns(2000n + 300_000n));
  });

  it('a wave whose first period starts low falls at its segment start after a high level (review M9)', () => {
    const w = run(
      ['P 1000 0 reset', 'P 2000 0 run 1000000 1000 8', 'W 3000 71 on 0 10 100'],
      71,
      1_100_000n,
    );
    if (w.kind !== 'wave') throw new Error('wave expected');
    const seg = ns(1_002_000n);
    const e = edgesIn(w, seg, ns(1_001_000n), ns(1_100_000n), 1);
    expect(e[0]).toEqual({ at: seg, level: 0 });
    expect(e[1]!.level).toBe(1);
  });

  it('P and W frames are parsed strictly (review M10)', () => {
    const bad = (line: string) => expect(() => parseFrame(line), line).toThrow(ProtocolError);
    bad('P 5 4 reset'); // timer 4 is low speed: never published
    bad('P 5 0 run 1000000 255 8'); // divider below 1.0
    bad('P 5 0 run 1000000 1000 21'); // resolution above 20
    bad('P 5 0 run 1000000 1000 0');
    bad('P 5 0 run 123 1000 8'); // unknown clock
    bad('P 5 0 unsupported weird');
    bad('W 5 70 idle 0'); // signal 70 is not LEDC
    bad('W 5 87 idle 0');
    bad('W 5 71 idle 2');
    bad('W 5 71 on 4 0 1');
    bad('W 5 71 on 0 0 1048577'); // duty above 2^20
    bad('W 5 71 unsupported weird');
    bad('W 5 71 on 0 01 1'); // leading zero
    expect(parseFrame('W 5 86 unsupported low-speed')).toMatchObject({ type: 'W', signal: 86 });
    expect(parseFrame('P 5 3 run 40000000 6250 16')).toMatchObject({ type: 'P', timer: 3 });
  });
});
