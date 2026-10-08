/**
 * Sprint 11 (R1), slice 2 (buzzer): the Sprint 10 parts driven by / feeding ESP32 pads, solved by the one engine with
 * the pads attached exactly as the Session Host attaches them (build.ts boardBench). Each result is
 * checked against an INDEPENDENT reference: the same circuit with every pad replaced by its
 * datasheet-derived Thevenin equivalent (3.3 V behind 16.5 Ω for HIGH), built from ordinary parts.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  R_DRIVE_HIGH_OHM,
  VDD_V,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench, boardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-15, Math.abs(b));

// ---------------------------------------------------------------------------------------------
// Slice 2 — active buzzer (CUI CEM-1205-IC), on/off.

describe('buzzer on ESP32 pads (slice 2)', () => {
  /** Reference: a 3.3 V supply behind 16.5 Ω (the HIGH pad's Thevenin equivalent) into the buzzer. */
  function buzzerReference(): SolveSuccess['components'][string] {
    const b = new Bench();
    const bz = b.add('component.buzzer');
    const r = b.add('component.resistor');
    b.psu(VDD_V, 0.1).ohms(r, R_DRIVE_HIGH_OHM);
    b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${bz}.positive`);
    b.wire(`${bz}.negative`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
    return ok(new EngineSession(b.snapshot()).solve()).components[bz]!;
  }

  it('straight on a HIGH pad: sounds just above its 3.0 V threshold (≈3.07 V, ≈13.9 mA), equal to the reference', () => {
    const bb = boardBench((b, u) => {
      const bz = b.add('component.buzzer');
      b.psu(3.3, 0.1).wire(`${u}.gpio4`, `${bz}.positive`).wire(`${bz}.negative`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    const on = ok(s.solve()).components.BZ1!;
    const ref = buzzerReference();
    expect(rel(on.voltage!, ref.voltage!)).toBeLessThan(1e-9);
    expect(rel(on.current!, ref.current!)).toBeLessThan(1e-9);
    expect(on.voltage!).toBeGreaterThan(3.0);
    expect(on.voltage!).toBeLessThan(3.1);
    expect(on.current!).toBeGreaterThan(0.013);
    expect(on.current!).toBeLessThan(0.0145);
    expect(on.state).toEqual({ sounding: true });
    // Below the pad's 40 mA drive rating: no pad warning.
    expect(ratingWarnings(bb.full, ok(s.solve()))).toEqual([]);
    s.setPinMode(4, 'output-low');
    const off = ok(s.solve()).components.BZ1!;
    expect(off.state).toEqual({ sounding: false });
    expect(Math.abs(off.current!)).toBeLessThan(1e-9);
  });

  it('through a 2N3904 low-side switch from 5 V (the recommended wiring): sounds when the pad is HIGH', () => {
    const bb = boardBench((b, u) => {
      const bz = b.add('component.buzzer');
      const q = b.add('component.bjt_npn');
      const rb = b.add('component.resistor');
      b.psu(5, 0.2).ohms(rb, 1000);
      b.wire(`${u}.gpio4`, `${rb}.a`).wire(`${rb}.b`, `${q}.base`).wire(`${q}.emitter`, 'GND1.ref');
      b.wire('PSU1.positive', `${bz}.positive`).wire(`${bz}.negative`, `${q}.collector`);
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    const on = ok(s.solve());
    expect(on.components.BZ1!.state).toEqual({ sounding: true });
    expect(on.components.BZ1!.voltage!).toBeGreaterThan(4.5);
    expect(on.components.Q1!.state).toMatchObject({ region: 'saturation' });
    expect(ratingWarnings(bb.full, on)).toEqual([]);
    s.setPinMode(4, 'output-low');
    const off = ok(s.solve());
    expect(off.components.BZ1!.state).toEqual({ sounding: false });
    expect(off.components.Q1!.state).toMatchObject({ region: 'cutoff' });
  });
});
