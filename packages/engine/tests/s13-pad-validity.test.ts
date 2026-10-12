/**
 * Sprint 13 P2/P3 (PM decision 2026-10-12): a pad wired straight to GND, and the validity region of
 * the linear pad-driver model.
 *
 * P3: a pad on the GND net has no unknown. Its model current was reported as 0 A, even for OUTPUT
 * HIGH (GpioPin.current() returned 0 when the node was the reference, and the no-unknowns path
 * never evaluated the pads). The model is now evaluated at V = 0.
 *
 * P2: the driver model is a chord from the rail to the datasheet's characterized point (Table 5-3:
 * V_OH >= 2.64 V at I_OH; V_OL = 0.495 V at I_OL). Beyond that point the value is an extrapolation
 * and the real current is unpublished (Table 5-1). Such a pad result carries `outsideModelRange`,
 * and every warning computed from it carries `unreliable`. No short-circuit current is invented:
 * the number stays the documented model's, marked as not physical.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  R_DRIVE_HIGH_OHM,
  R_DRIVE_LOW_OHM,
  V_OH_CHAR_V,
  V_OL_CHAR_V,
  VDD_V,
  outsideCharacterizedRegion,
  ratingWarnings,
  type PinResult,
  type RuntimePinMode,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench, boardBench as sharedBoardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};

function boardBench(build: (b: Bench, u: string) => void) {
  const { full, projected, pins, u } = sharedBoardBench(build);
  return { full, session: new EngineSession(projected, { pins }), u };
}

const TOPOLOGIES: Record<string, (b: Bench, u: string) => void> = {
  // The pad's terminal on the GND net itself (no device between them).
  direct: (b, u) => b.wire(`${u}.gpio5`, 'GND1.ref'),
  // A 1 mOhm link: the node is an unknown and the solve runs.
  'via 1 mOhm': (b, u) => {
    const r = b.add('component.resistor');
    b.ohms(r, 1e-3).wire(`${u}.gpio5`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  },
  // Direct, while an unrelated powered circuit gives the solve other unknowns.
  'direct, with another powered circuit': (b, u) => {
    b.wire(`${u}.gpio5`, 'GND1.ref').psu(5, 0.1);
    const r = b.add('component.resistor');
    b.ohms(r, 1000).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  },
};

const pin5 = (o: SolveSuccess): PinResult => o.pins!.find((p) => p.gpio === 5)!;

describe('P3: a pad wired to GND, in every drive mode and topology', () => {
  for (const [name, wire] of Object.entries(TOPOLOGIES)) {
    it(`${name}: OUTPUT HIGH reports the model current, marked outside the model range`, () => {
      const g = boardBench(wire);
      g.session.setPinMode(5, 'output-high');
      const p = pin5(ok(g.session.solve()));
      // The documented model at its own pad potential (0 V, or 0.2 mV across the 1 mOhm link).
      expect(p.current).toBeCloseTo((VDD_V - p.voltage) / R_DRIVE_HIGH_OHM, 6);
      expect(p.current).toBeGreaterThan(0.19);
      expect(p.outsideModelRange).toBe(true);
    });
    it(`${name}: OUTPUT LOW and INPUT carry 0 A, inside the model range`, () => {
      for (const mode of ['output-low', 'input'] as RuntimePinMode[]) {
        const g = boardBench(wire);
        g.session.setPinMode(5, mode);
        const p = pin5(ok(g.session.solve()));
        expect(Math.abs(p.current)).toBeLessThan(1e-9);
        expect(p.outsideModelRange).toBeUndefined();
      }
    });
  }

  it('a pad attached at the ground symbol itself (the browser projection of a board-only short) is valid', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    // Something else must exist for a snapshot; it is not on the pad's net.
    b.ohms(r, 1000).wire(`${r}.a`, 'GND1.ref');
    const s = new EngineSession(b.snapshot(), {
      pins: [{ gpio: 5, component: 'GND1', terminal: 'ref' }],
    });
    expect(s.setPinMode(5, 'output-high')).toBeNull();
    const p = pin5(ok(s.solve()));
    expect(p.voltage).toBe(0);
    expect(p.current).toBeCloseTo(VDD_V / R_DRIVE_HIGH_OHM, 12);
    expect(p.outsideModelRange).toBe(true);
  });

  it('a board-only circuit (one pad wired to GND, nothing else) is solved, not "empty"', () => {
    // The browser's projection of: board, ground symbol, board GND -> GND, GPIO5 -> GND.
    const g = sharedBoardBench((b, u) => b.wire(`${u}.gpio5`, 'GND1.ref'));
    const only = {
      ...g.projected,
      components: g.projected.components.filter((c) => c.type === 'component.ground'),
      connections: g.projected.connections.filter((c) => c.component.startsWith('GND')),
    };
    expect(only.components.map((c) => c.type)).toEqual(['component.ground']);
    // The only other terminal on the pad's net is the ground symbol: the pad attaches there.
    const s = new EngineSession(only, { pins: [{ gpio: 5, component: 'GND1', terminal: 'ref' }] });
    for (const [mode, flagged] of [
      ['output-high', true],
      ['output-low', false],
      ['input', false],
    ] as const) {
      expect(s.setPinMode(5, mode)).toBeNull();
      const p = pin5(ok(s.solve()));
      expect(p.current).toBeCloseTo(mode === 'output-high' ? VDD_V / R_DRIVE_HIGH_OHM : 0, 12);
      expect(p.outsideModelRange === true).toBe(flagged);
    }
  });

  it('the short-to-GND warning keeps the condition and marks its value unreliable', () => {
    const g = boardBench(TOPOLOGIES.direct!);
    g.session.setPinMode(5, 'output-high');
    expect(ratingWarnings(g.full, ok(g.session.solve()))).toEqual([
      expect.objectContaining({
        code: 'gpio_short_ground',
        kind: 'unrated',
        gpio: 5,
        value: expect.closeTo(VDD_V / R_DRIVE_HIGH_OHM, 12),
        unreliable: true,
      }),
    ]);
  });
});

describe('P2: the characterized region of the pad driver', () => {
  it('is bounded by the datasheet points 2.64 V (HIGH) and 0.495 V (LOW)', () => {
    expect(V_OH_CHAR_V).toBeCloseTo(2.64, 12);
    expect(V_OL_CHAR_V).toBe(0.495);
    expect(outsideCharacterizedRegion('output-high', 2.64)).toBe(false);
    expect(outsideCharacterizedRegion('output-high', 2.6399)).toBe(true);
    expect(outsideCharacterizedRegion('output-low', 0.495)).toBe(false);
    expect(outsideCharacterizedRegion('output-low', 0.4951)).toBe(true);
    expect(outsideCharacterizedRegion('input', -5)).toBe(false);
  });

  // HIGH into R to GND: V = VDD R / (R + R_high) = 2.64 V at R = 2.64 R_high / 0.66 = 66 Ohm.
  it('OUTPUT HIGH into a resistor: 66.5 Ohm is inside, 65.5 Ohm is outside', () => {
    for (const [ohms, outside] of [
      [66.5, false],
      [65.5, true],
    ] as const) {
      const g = boardBench((b, u) => {
        const r = b.add('component.resistor');
        b.ohms(r, ohms).wire(`${u}.gpio5`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
      });
      g.session.setPinMode(5, 'output-high');
      const out = ok(g.session.solve());
      const p = pin5(out);
      expect(p.voltage).toBeCloseTo((VDD_V * ohms) / (ohms + R_DRIVE_HIGH_OHM), 9);
      expect(p.outsideModelRange === true).toBe(outside);
      // The chord passes through (2.64 V, 40 mA): the region's edge is also the typical-drive
      // row's threshold. Inside: no row; outside: the row, marked unreliable.
      const row = ratingWarnings(g.full, out).find((w) => w.code === 'gpio_source_current');
      expect(row?.unreliable).toBe(outside ? true : undefined);
      expect(row === undefined).toBe(!outside);
    }
  });

  // LOW pulled up by R from 3.3 V: V = 3.3 R_low / (R + R_low) = 0.495 V at R = 100.18 Ohm.
  it('OUTPUT LOW sinking from 3.3 V through a resistor: 101 Ohm is inside, 99 Ohm is outside', () => {
    const crossover = (R_DRIVE_LOW_OHM * (3.3 - V_OL_CHAR_V)) / V_OL_CHAR_V;
    expect(crossover).toBeCloseTo(100.18, 2);
    for (const [ohms, outside] of [
      [101, false],
      [99, true],
    ] as const) {
      const g = boardBench((b, u) => {
        const r = b.add('component.resistor');
        b.psu(3.3, 1).ohms(r, ohms).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${u}.gpio5`);
      });
      g.session.setPinMode(5, 'output-low');
      const p = pin5(ok(g.session.solve()));
      expect(p.outsideModelRange === true).toBe(outside);
    }
  });

  it('a normal LED load stays inside: no flag, no warning', () => {
    const g = boardBench((b, u) => {
      const r = b.add('component.resistor');
      const d = b.add('component.led');
      b.ohms(r, 220)
        .wire(`${u}.gpio5`, `${r}.a`)
        .wire(`${r}.b`, `${d}.anode`)
        .wire(`${d}.cathode`, 'GND1.ref');
    });
    g.session.setPinMode(5, 'output-high');
    const out = ok(g.session.solve());
    expect(pin5(out).outsideModelRange).toBeUndefined();
    expect(ratingWarnings(g.full, out)).toEqual([]);
  });

  it('a cumulative total that includes extrapolated pad currents is marked unreliable', () => {
    const gpios = [2, 4, 5, 13, 14, 16, 18, 19];
    const g = boardBench((b, u) => {
      for (const n of gpios) b.wire(`${u}.gpio${n}`, 'GND1.ref');
    });
    for (const n of gpios) g.session.setPinMode(n, 'output-high');
    const w = ratingWarnings(g.full, ok(g.session.solve()));
    expect(w.find((x) => x.code === 'gpio_cumulative_current')).toEqual(
      expect.objectContaining({ kind: 'absolute', unreliable: true }),
    );
    for (const x of w) expect(x.unreliable).toBe(true);
  });
});
