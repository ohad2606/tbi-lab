/**
 * Sprint 11 (R1), slice 6: the 8x8 LED matrix (1088AS: rows = dot cathodes, columns = dot
 * anodes) driven by ESP32 pads as a STATIC pattern. Reference: one dot as a series circuit of the
 * two pads' Thevenin resistances, the column resistor and the matrix's own dot card.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { boardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};

import { ESP32_DEVKITC_WROOM32 } from '@tbi-lab/domain';
import { R_DRIVE_HIGH_OHM, R_DRIVE_LOW_OHM, VDD_V } from '../src/index.js';
import { Bench } from './build.js';

/** Columns c1..c<n> from GPIO 4/16/27/25/32/33/18/19 through 220 Ω; row r1 from GPIO 23 (LOW). */
const COL_PADS = [4, 16, 27, 25, 32, 33, 18, 19];
function matrixOnPads(cols: number, ohms = 220) {
  return boardBench((b, u) => {
    const m = b.add('display.led_matrix_8x8');
    b.psu(3.3, 0.1);
    for (let j = 0; j < cols; j++) {
      const r = b.add('component.resistor');
      b.ohms(r, ohms)
        .wire(`${u}.gpio${COL_PADS[j]}`, `${r}.a`)
        .wire(`${r}.b`, `${m}.c${j + 1}`);
    }
    b.wire(`${u}.gpio23`, `${m}.r1`);
  });
}

function oneDotReference(): number {
  const b = new Bench();
  const m = b.add('display.led_matrix_8x8');
  const r = b.add('component.resistor');
  b.psu(VDD_V, 0.1).ohms(r, R_DRIVE_HIGH_OHM + 220 + R_DRIVE_LOW_OHM);
  b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${m}.c1`).wire(`${m}.r1`, 'GND1.ref');
  b.wire('PSU1.negative', 'GND1.ref');
  return ok(new EngineSession(b.snapshot()).solve()).components[m]!.array!.currents[0]!;
}

describe('8x8 matrix on ESP32 pads, static patterns (slice 6)', () => {
  it('one dot (column 1 HIGH, row 1 LOW): its current equals the series reference; every other dot is dark', () => {
    const bb = matrixOnPads(1);
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    s.setPinMode(23, 'output-low');
    const out = ok(s.solve());
    const a = out.components.DS1!.array!;
    expect(a.currents[0]!).toBeCloseTo(oneDotReference(), 9);
    expect(a.currents[0]!).toBeGreaterThan(3e-3);
    expect(a.currents.slice(1).every((c) => Math.abs(c) < 1e-9)).toBe(true);
    expect(out.components.DS1!.state).toEqual({ lit: 1 });
  });

  it('a full row (8 columns HIGH, row 1 LOW): 8 dots lit; the shared row pad limits them; 100 Ω columns over-load it', () => {
    const row = (ohms: number) => {
      const bb = matrixOnPads(8, ohms);
      const s = new EngineSession(bb.projected, { pins: bb.pins });
      for (const g of COL_PADS) s.setPinMode(g, 'output-high');
      s.setPinMode(23, 'output-low');
      const out = ok(s.solve());
      expect(out.components.DS1!.state).toEqual({ lit: 8 });
      const sink = -out.pins!.find((p) => p.gpio === 23)!.current;
      const sum = out.components.DS1!.array!.currents.slice(0, 8).reduce((x, y) => x + y, 0);
      expect(sink).toBeCloseTo(sum, 9); // the row pad carries the whole row
      return { sink, warned: ratingWarnings(bb.full, out).filter((x) => x.gpio === 23) };
    };
    // 220 Ω: about 2.9 mA a dot, 23 mA for the row: within the pad's 28 mA sink rating.
    const a = row(220);
    expect(a.sink).toBeGreaterThan(0.02);
    expect(a.sink).toBeLessThan(0.028);
    expect(a.warned).toEqual([]);
    // 100 Ω: about 33 mA for the row: the sink warning, with the solved value.
    const b = row(100);
    expect(b.sink).toBeGreaterThan(0.028);
    expect(b.warned.map((x) => x.code)).toEqual(['gpio_sink_current']);
    expect(b.warned[0]!.value).toBeCloseTo(b.sink, 9);
  });

  it('pins: the board offers enough output-capable pads for 16 lines (20 digital-io)', () => {
    const outputs = ESP32_DEVKITC_WROOM32.pins.filter((p) => p.simulatorSupport === 'digital-io');
    expect(outputs.length).toBeGreaterThanOrEqual(16);
  });
});
