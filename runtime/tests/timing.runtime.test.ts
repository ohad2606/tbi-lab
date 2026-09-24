/**
 * R1.7: timing behaviour of the classic-ESP32 runtime (TbiTiming).
 *
 * GPIO2 edges are markers timestamped by the bridge in simulation time; the firmware prints its
 * own view of the same intervals (millis, esp_timer, CPU cycle counter, a 100 ms hardware timer).
 * The runtime is deterministic, not cycle-accurate: under -icount shift=3 every guest instruction
 * advances simulation time by 8 ns, so pure computation runs at a fixed 125 M instructions per
 * simulated second, while timer-driven waits (delay, esp_timer, hardware timers) follow the
 * simulated clocks. Real-chip expectations and the Sprint 1 figures are recorded next to each
 * measurement; only timer-driven behaviour is asserted against real-chip expectations.
 */
import { Circuit, GpioPin } from '@tbi-lab/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  runCircuitSession,
  serialLines,
  type CircuitSessionRecord,
} from '../harness/circuitSession.js';
import { QEMU, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';

let rec: CircuitSessionRecord;
let text: Map<string, string>;
let marks: bigint[];

const ms = (ns: bigint) => Number(ns) / 1e6;
const field = (line: string, key: string) => Number(new RegExp(`${key}=(-?\\d+)`).exec(line)![1]);

beforeAll(async () => {
  assertProvisioned();
  const fw = artifact('TbiTiming');
  const c = new Circuit();
  const pin = c.add(new GpioPin('IO2', 'io2', 'input'));
  rec = await runCircuitSession({
    qemu: QEMU,
    artifact: fw.path,
    artifactSha256: fw.sha256,
    circuit: c,
    pads: [{ pad: 2, pin, node: 'io2', input: false }],
    endNs: 4_000_000_000n,
  });
  const lines = serialLines(rec.serialTimeline).map((l) => l.text);
  text = new Map(lines.map((l) => [l.split(/[ =]/)[0]!, l]));
  // pinMode(OUTPUT) produces a drive=1 level=0 event first; markers are the level changes after it.
  marks = [];
  let lvl = -1;
  for (const e of rec.padEvents.filter((e) => e.pad === 2 && e.drive === 1)) {
    if (e.level !== lvl) marks.push(e.vns);
    lvl = e.level;
  }
}, 300_000);

describe('R1.7 timing', () => {
  it('runs to completion with all seven markers', () => {
    expect(rec.session.outcome).toBe('completed');
    expect(text.has('TBI-TIMING-DONE')).toBe(true);
    // marks[0] is the initial LOW of pinMode; M1..M7 follow as level changes 1,0,1,0,1,0,1.
    expect(marks.length).toBeGreaterThanOrEqual(8);
  });

  it('delay(1000): 1000 ms of simulation time and ~1000 ms by millis()/esp_timer (real chip: 1000 ms)', () => {
    const [, , m2, m3] = marks;
    const markerMs = ms(m3! - m2!);
    const d = text.get('DELAY1000')!;
    const res = {
      markerMs,
      millis: field(d, 'millis'),
      micros: field(d, 'micros'),
      cycles: field(d, 'cycles'),
    };
    recordEvidence('timing-delay', res);
    console.log('delay(1000)', res, 'Sprint 1: marker 999.902 ms');
    expect(markerMs).toBeGreaterThan(999);
    expect(markerMs).toBeLessThan(1001);
    expect(res.millis).toBeGreaterThanOrEqual(999);
    expect(res.millis).toBeLessThanOrEqual(1001);
    expect(Math.abs(res.micros - 1_000_000)).toBeLessThan(1000);
  });

  it('100 ms periodic hardware timer: 9-10 ticks in a 1 s window (real chip: 10; Sprint 1: 9)', () => {
    const ticks = field(text.get('TIMER100MS')!, 'ticks_in_1s');
    recordEvidence('timing-timer', { ticks, windowMs: ms(marks[7]! - marks[6]!) });
    expect([9, 10]).toContain(ticks);
  });

  it('busy loop runs at the fixed icount rate (deterministic, not cycle-accurate)', () => {
    const b = text.get('BUSY1M')!;
    const markerMs = ms(marks[5]! - marks[4]!);
    const cpu = text.get('CPU_MHZ')!;
    const res = {
      markerMs,
      micros: field(b, 'micros'),
      cycles: field(b, 'cycles'),
      cpuMhzReported: field(cpu, 'CPU_MHZ'),
      cyclesPerIteration: field(b, 'cycles') / 1e6,
      atSetup: text.get('AT_SETUP'),
    };
    recordEvidence('timing-busy', res);
    console.log('busy loop 1M', res, 'Sprint 1: 48.803 ms, 11.7 cycles/iteration');
    // The firmware's own clock and the bridge's simulation clock agree on the interval.
    expect(Math.abs(res.micros / 1000 - markerMs)).toBeLessThan(1);
    expect(res.markerMs).toBeGreaterThan(1);
  });

  it('boot reaches setup() at a fixed simulation time', () => {
    const setupMs = ms(marks[1]!);
    recordEvidence('timing-boot', { setupEnteredMs: setupMs });
    console.log('setup() entered at', setupMs, 'ms (Sprint 1: 379 ms)');
    expect(setupMs).toBeGreaterThan(50);
    expect(setupMs).toBeLessThan(2000);
  });
});
