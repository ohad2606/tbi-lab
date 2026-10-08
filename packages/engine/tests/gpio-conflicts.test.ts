/**
 * Sprint 10: the approved classic-ESP32 pad model (esp32Gpio.ts) in the invalid and edge cases a
 * student can wire, solved exactly as drawn. The engine neither hides nor "fixes" them:
 * - two outputs fighting on one node (one HIGH, one LOW): the contention current through both
 *   drivers' datasheet-derived resistances, and the node between them;
 * - an output wired straight to GND (HIGH) or to the supply (LOW): the short-circuit current the
 *   driver model gives;
 * - an input with nothing driving it: its datasheet leakage holds it at 0 V, so it reads LOW,
 *   deterministically (no random floating input).
 * The numbers are the closed-form solutions of the documented driver model (Thevenin 3.3 V
 * behind 16.5 Ω high / 17.679 Ω low; input leakage 50 nA at 3.3 V).
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  G_INPUT_LEAKAGE_S,
  R_DRIVE_HIGH_OHM,
  R_DRIVE_LOW_OHM,
  VDD_V,
  interpretDigitalInput,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench, boardBench as sharedBoardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};
const close = (a: number, b: number, rel = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1e-12, Math.abs(b)));

/** A tiny resistor joins two pads' nodes (a wire is not a device; 1 mΩ is far below the drivers). */
function twoPads(link: number) {
  const b = new Bench();
  const r = b.add('component.resistor');
  b.ohms(r, link).wire('PSU1.negative', 'GND1.ref').psu(5, 0.1, false);
  return { b, r };
}

describe('ESP32 pads: contention and edge cases, solved as drawn', () => {
  it('two outputs fighting (HIGH vs LOW) carry the contention current of the driver model', () => {
    const link = 1e-3;
    const { b, r } = twoPads(link);
    const s = new EngineSession(b.snapshot(), {
      pins: [
        { gpio: 2, component: r, terminal: 'a' },
        { gpio: 4, component: r, terminal: 'b' },
      ],
    });
    expect(s.setPinMode(2, 'output-high')).toBeNull();
    expect(s.setPinMode(4, 'output-low')).toBeNull();
    const out = ok(s.solve());
    const i = VDD_V / (R_DRIVE_HIGH_OHM + link + R_DRIVE_LOW_OHM);
    const high = out.pins!.find((p) => p.gpio === 2)!;
    const low = out.pins!.find((p) => p.gpio === 4)!;
    close(high.current, i);
    close(low.current, -i);
    close(high.voltage, VDD_V - i * R_DRIVE_HIGH_OHM);
    // About 97 mA: far beyond what a pad should carry; the solved value is shown, never hidden.
    expect(i).toBeGreaterThan(0.09);
    expect(i).toBeLessThan(0.1);
    // Both pads together: same mode -> no current between them.
    expect(s.setPinMode(4, 'output-high')).toBeNull();
    const same = ok(s.solve());
    expect(Math.abs(same.pins!.find((p) => p.gpio === 2)!.current)).toBeLessThan(1e-12);
  });

  it('an output HIGH wired straight to GND delivers the driver-limited short-circuit current', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.ohms(r, 1e-3).wire(`${r}.b`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(5, 0.1, false);
    const s = new EngineSession(b.snapshot(), { pins: [{ gpio: 2, component: r, terminal: 'a' }] });
    expect(s.setPinMode(2, 'output-high')).toBeNull();
    const pin = ok(s.solve()).pins![0]!;
    close(pin.current, VDD_V / (R_DRIVE_HIGH_OHM + 1e-3));
    expect(pin.current).toBeCloseTo(0.2, 2); // 3.3 V / 16.5 Ω
  });

  it('an output LOW wired to a 3.3 V supply sinks the driver-limited current', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.ohms(r, 1e-3)
      .wire('PSU1.positive', `${r}.b`)
      .wire('PSU1.negative', 'GND1.ref')
      .psu(3.3, 1, true);
    const s = new EngineSession(b.snapshot(), { pins: [{ gpio: 4, component: r, terminal: 'a' }] });
    expect(s.setPinMode(4, 'output-low')).toBeNull();
    const pin = ok(s.solve()).pins![0]!;
    close(pin.current, -3.3 / (R_DRIVE_LOW_OHM + 1e-3), 1e-6);
  });

  it('an input with nothing driving it sits at 0 V through its leakage and reads LOW, every time', () => {
    const { b, r } = twoPads(1000);
    const s = new EngineSession(b.snapshot(), { pins: [{ gpio: 5, component: r, terminal: 'a' }] });
    expect(s.setPinMode(5, 'input')).toBeNull();
    for (let k = 0; k < 3; k++) {
      const pin = ok(s.solve()).pins![0]!;
      expect(Math.abs(pin.voltage)).toBeLessThan(1e-9);
      expect(Math.abs(pin.current)).toBeLessThan(1e-15);
      expect(interpretDigitalInput(pin.voltage, 0)).toBe(0);
    }
    expect(G_INPUT_LEAKAGE_S).toBeCloseTo(50e-9 / 3.3, 20);
  });
});

/**
 * Sprint 10: the same configurations produce visible circuit diagnostics. The browser holds the
 * project (with the board); the session solved the projection without it (as the Session Host
 * does). The diagnostics classify the solved pad currents; they never change them.
 */
describe('ESP32 pad diagnostics (ratingWarnings)', () => {
  /** A board wired by its terminals, plus the session over the board-less projection. */
  function boardBench(build: (b: Bench, u: string) => void) {
    const { full, projected, pins, u } = sharedBoardBench(build);
    return { full, session: new EngineSession(projected, { pins }), u };
  }

  it('two pads driving opposite levels on one net: contention on both, with the solved current', () => {
    const { full, session, u } = boardBench((b, u) => {
      const r = b.add('component.resistor');
      b.ohms(r, 1e-3).wire(`${u}.gpio2`, `${r}.a`).wire(`${u}.gpio4`, `${r}.a`);
      b.wire(`${r}.b`, 'GND1.ref').ohms(r, 1e6);
    });
    session.setPinMode(2, 'output-high');
    session.setPinMode(4, 'output-low');
    const out = ok(session.solve());
    const w = ratingWarnings(full, out);
    const i = VDD_V / (R_DRIVE_HIGH_OHM + R_DRIVE_LOW_OHM);
    expect(w.map((x) => [x.code, x.gpio, x.otherGpio])).toEqual([
      ['gpio_contention', 2, 4],
      ['gpio_contention', 4, 2],
    ]);
    expect(w[0]!.component).toBe(u);
    expect(w[0]!.value).toBeCloseTo(i, 4);
    // The solved values are untouched by the classification.
    expect(out.pins!.find((p) => p.gpio === 2)!.current).toBeCloseTo(i, 4);
  });

  it('an output-HIGH pad on the GND net is a short to ground; output-LOW on a supply + is a short to the supply', () => {
    const g = boardBench((b, u) => b.wire(`${u}.gpio2`, 'GND1.ref'));
    g.session.setPinMode(2, 'output-high');
    expect(ratingWarnings(g.full, ok(g.session.solve())).map((x) => x.code)).toEqual([
      'gpio_short_ground',
    ]);
    const s = boardBench((b, u) => b.wire(`${u}.gpio4`, 'PSU1.positive').psu(3.3, 1));
    s.session.setPinMode(4, 'output-low');
    const w = ratingWarnings(s.full, ok(s.session.solve()));
    expect(w.map((x) => x.code)).toEqual(['gpio_short_supply']);
    expect(w[0]!.value).toBeCloseTo(3.3 / R_DRIVE_LOW_OHM, 3);
  });

  it('a pad loaded past its drive specification (but not shorted) is flagged; a normal LED load is not', () => {
    const heavy = boardBench((b, u) => {
      const r = b.add('component.resistor');
      b.ohms(r, 22).wire(`${u}.gpio5`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
    });
    heavy.session.setPinMode(5, 'output-high');
    const w = ratingWarnings(heavy.full, ok(heavy.session.solve()));
    expect(w.map((x) => [x.code, x.limit])).toEqual([['gpio_source_current', 0.04]]);
    expect(w[0]!.value).toBeCloseTo(VDD_V / (R_DRIVE_HIGH_OHM + 22), 6);

    const normal = boardBench((b, u) => {
      const r = b.add('component.resistor');
      const d = b.add('component.led');
      b.ohms(r, 220)
        .wire(`${u}.gpio5`, `${r}.a`)
        .wire(`${r}.b`, `${d}.anode`)
        .wire(`${d}.cathode`, 'GND1.ref');
    });
    normal.session.setPinMode(5, 'output-high');
    expect(ratingWarnings(normal.full, ok(normal.session.solve()))).toEqual([]);
  });
});
