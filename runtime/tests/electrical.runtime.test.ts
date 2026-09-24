/**
 * R1.9: electrical model regression through the real firmware loop (TbiGpioProof, gate circuit).
 *
 *   GPIO2 -> 220 ohm -> red LED -> GND;  GPIO2 -> 10 k -> GPIO5 <- 10 k <- VEXT (lab PSU)
 *
 * Every solve in the loop is checked against the approved pin model (Sprint 1 Gate C: 3.3 V behind
 * 16.5 ohm high, 17.679 ohm low; V_IL 0.825 V, V_IH 2.475 V, hold in between) with exact circuit
 * equations, and the digital consequences are checked against what the firmware reports.
 */
import { R_DRIVE_HIGH_OHM, R_DRIVE_LOW_OHM, V_IH_V, V_IL_V, VDD_V } from '@tbi-lab/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { serialLines } from '../harness/circuitSession.js';
import { runClosedLoop, type ClosedLoopRecord } from '../harness/closedLoop.js';
import { QEMU, artifact, assertProvisioned } from '../harness/env.js';

interface V {
  vns: bigint;
  cause: string;
  io2: number;
  io5: number;
  iLed: number;
  vext: number;
}

let rec: ClosedLoopRecord;
let solves: V[];
/** GPIO2 state (drive, level) in force at each solve. */
const gpio2At = new Map<V, { drive: number; level: number }>();

beforeAll(async () => {
  assertProvisioned();
  const fw = artifact('TbiGpioProof');
  rec = await runClosedLoop({
    qemu: QEMU,
    artifact: fw.path,
    artifactSha256: fw.sha256,
    endNs: 15_500_000_000n,
    tickUs: 1000,
  });
  expect(rec.session.outcome).toBe('completed');
  solves = [];
  let g2 = { drive: 0, level: 0 };
  for (const line of rec.timeline) {
    let m = /^G (\d+) gpio2 drive=(\d) level=(\d)$/.exec(line);
    if (m) g2 = { drive: Number(m[2]), level: Number(m[3]) };
    m = /^V (\d+) (\S+) io2=(\S+) io5=(\S+) iLED=(\S+) vext=(\S+) /.exec(line);
    if (m) {
      const v = {
        vns: BigInt(m[1]!),
        cause: m[2]!,
        io2: +m[3]!,
        io5: +m[4]!,
        iLed: +m[5]!,
        vext: +m[6]!,
      };
      solves.push(v);
      gpio2At.set(v, { ...g2 });
    }
  }
}, 300_000);

const R2 = 10_000;
const R3 = 10_000;

describe('R1.9 electrical regression in the closed loop', () => {
  it('HIGH output drives the resistor + LED through 16.5 ohm from 3.3 V (exact KCL at the pin)', () => {
    const high = solves.filter((v) => gpio2At.get(v)!.drive === 1 && gpio2At.get(v)!.level === 1);
    expect(high.length).toBeGreaterThan(10);
    for (const v of high) {
      const iPin = v.iLed + (v.io2 - v.io5) / R2; // current leaving the pin into the circuit
      expect(Math.abs(VDD_V - R_DRIVE_HIGH_OHM * iPin - v.io2)).toBeLessThan(1e-9);
      expect(v.iLed).toBeGreaterThan(4e-3); // a lit red LED at ~5-6 mA through 220 ohm
      expect(v.iLed).toBeLessThan(7e-3);
    }
  });

  it('LOW output sinks through 17.679 ohm and the LED is off', () => {
    const low = solves.filter((v) => gpio2At.get(v)!.drive === 1 && gpio2At.get(v)!.level === 0);
    expect(low.length).toBeGreaterThan(10);
    for (const v of low) {
      const iInto = (v.io5 - v.io2) / R2 - v.iLed; // current flowing into the pin
      expect(Math.abs(R_DRIVE_LOW_OHM * iInto - v.io2)).toBeLessThan(1e-9);
      expect(v.iLed).toBeLessThan(1e-9);
    }
  });

  it('external HIGH and external LOW on the input pin are recognised', () => {
    const extHigh = solves.find((v) => v.vext === 3.3 && gpio2At.get(v)!.level === 1)!;
    expect(extHigh.io5).toBeGreaterThan(V_IH_V);
    expect(rec.timeline.some((l) => /^I \d+ gpio5<=1$/.test(l))).toBe(true);
    const extLow = solves.find(
      (v) => v.vext === 0 && gpio2At.get(v)!.drive === 1 && gpio2At.get(v)!.level === 0,
    )!;
    expect(extLow.io5).toBeLessThan(V_IL_V);
    expect(rec.timeline.some((l) => /^I \d+ gpio5<=0$/.test(l))).toBe(true);
  });

  it('inside the undefined band the input holds its previous level (no injection)', () => {
    const band = solves.filter((v) => v.io5 > V_IL_V && v.io5 < V_IH_V);
    expect(band.length).toBeGreaterThan(5);
    for (const v of band) {
      const i = rec.timeline.findIndex((l) => l.startsWith(`V ${v.vns} ${v.cause} `));
      expect(rec.timeline[i + 1] ?? '', `hold at ${v.vns}`).not.toMatch(/^I /);
    }
  });

  it('is event-driven: feedback is applied at the pad event time, not quantised to the 1 ms tick', () => {
    const offTick = solves.filter((v) => v.cause === 'gpio2' && v.vns % 1_000_000n !== 0n);
    expect(offTick.length).toBeGreaterThan(10);
    // Every injection happens at the same simulation time as the solve that caused it.
    for (let i = 0; i < rec.timeline.length; i++) {
      const m = /^I (\d+) /.exec(rec.timeline[i]!);
      if (!m) continue;
      let j = i - 1;
      while (!rec.timeline[j]!.startsWith('V ')) j--;
      expect(rec.timeline[j]!.split(' ')[1]).toBe(m[1]);
    }
  });

  it('two-way feedback: the firmware reads back what the circuit forced (serial IN= follows the injection)', () => {
    const lines = serialLines(
      rec.serialTimeline.map((s) => {
        const [vns, hex] = s.split(' ');
        return { vns: BigInt(vns!), bytes: Buffer.from(hex!, 'hex') };
      }),
    )
      .filter((l) => l.text.startsWith('IN='))
      .map((l) => ({ vns: l.vns, v: Number(l.text.slice(3)) }));
    const inj = rec.timeline
      .filter((l) => l.startsWith('I '))
      .map((l) => ({ vns: BigInt(l.split(' ')[1]!), v: Number(l.slice(-1)) }));
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) {
      const last = inj.filter((x) => x.vns < l.vns).at(-1)!;
      expect(l.v, `IN= at ${l.vns}`).toBe(last.v);
    }
    expect(new Set(lines.map((l) => l.v))).toEqual(new Set([0, 1]));
  });

  it('the external source current stays within the PSU limit (CV mode throughout)', () => {
    expect(rec.timeline.filter((l) => l.startsWith('V ')).every((l) => l.endsWith('mode=CV'))).toBe(
      true,
    );
    for (const v of solves) expect(Math.abs((v.vext - v.io5) / R3)).toBeLessThan(0.1);
  });
});
