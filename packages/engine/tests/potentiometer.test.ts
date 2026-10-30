/**
 * Sprint POT-UNITS: the potentiometer (Bourns PTV09A, linear taper) as two linear track segments,
 * checked against closed-form references:
 * - divider (A at V, B at GND, wiper open): V_W = V (1 - p), I = V / R at every position;
 * - loaded divider: the wiper into a load resistor (Thevenin of the two segments);
 * - rheostat (W-B) in series with a resistor and an LED: current monotonic in the position and
 *   bounded by the fixed resistor; no rating row at any position (0.05 W, 20 VDC);
 * - live position changes re-solve to the new divider value (applyControl);
 * - rating rows: over 0.05 W total and over 20 V, both `unrated`; refusals by name.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { PTV09A, potSegments } from '../src/parts/potentiometer.js';
import { Bench } from './build.js';

const REL = 1e-9;
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};
const near = (a: number | null | undefined, e: number, rel = REL) => {
  expect(a).not.toBeNull();
  expect(Math.abs((a as number) - e)).toBeLessThanOrEqual(Math.abs(e) * rel + 1e-12);
};

function divider(volts: number, ohms: number, position: number, load?: number) {
  const b = new Bench();
  const rv = b.add('component.potentiometer');
  b.psu(volts, 0.5)
    .wire('PSU1.negative', 'GND1.ref')
    .wire('PSU1.positive', `${rv}.a`)
    .wire(`${rv}.b`, 'GND1.ref')
    .set(rv, 'resistance', { value: ohms, unit: 'ohm' })
    .set(rv, 'position', { value: position, unit: 'percent' });
  if (load !== undefined) {
    const r = b.add('component.resistor');
    b.ohms(r, load).wire(`${rv}.wiper`, `${r}.a`).wire(`${r}.b`, 'GND1.ref');
  }
  return { b, rv };
}

describe('potentiometer: segments', () => {
  it('R_AW = R p, R_WB = R (1 - p)', () => {
    expect(potSegments(10_000, 0)).toEqual({ aw: 0, wb: 10_000 });
    expect(potSegments(10_000, 25)).toEqual({ aw: 2500, wb: 7500 });
    expect(potSegments(10_000, 100)).toEqual({ aw: 10_000, wb: 0 });
  });
});

describe('potentiometer: unloaded divider, V_W = V (1 - p)', () => {
  for (const pos of [0, 10, 25, 50, 75, 90, 100]) {
    it(`5 V across 10 kΩ at ${pos} %`, () => {
      const { b, rv } = divider(5, 10_000, pos);
      const r = ok(new EngineSession(b.snapshot()).solve());
      const c = r.components[rv]!;
      near(c.terminals.wiper, 5 * (1 - pos / 100));
      near(c.state!.wiperVoltage as number, 5 * (1 - pos / 100));
      near(c.voltage, 5);
      // The whole track carries V / R, whatever the position.
      near(c.currents!.wb, 5 / 10_000);
      near(c.current, 5 / 10_000);
      near(c.currents!.wiper ?? 0, 0, 1);
      near(c.state!.power as number, (5 * 5) / 10_000);
      expect(ratingWarnings(b.snapshot(), r)).toEqual([]);
    });
  }
});

describe('potentiometer: loaded divider (Thevenin)', () => {
  for (const pos of [0, 25, 50, 100]) {
    it(`9 V, 10 kΩ, 4.7 kΩ load at ${pos} %`, () => {
      const { b, rv } = divider(9, 10_000, pos, 4700);
      const r = ok(new EngineSession(b.snapshot()).solve());
      const { aw, wb } = potSegments(10_000, pos);
      const low = wb === 0 ? 0 : (wb * 4700) / (wb + 4700);
      const vw = (9 * low) / (aw + low);
      near(r.components[rv]!.terminals.wiper, vw);
      // Kirchhoff at the wiper: the load current leaves through the wiper terminal.
      near(-(r.components[rv]!.currents!.wiper as number), vw / 4700);
    });
  }
});

describe('potentiometer: rheostat LED dimmer, safe at every position', () => {
  function dimmer(position: number) {
    const b = new Bench();
    const rv = b.add('component.potentiometer');
    const r = b.add('component.resistor');
    const d = b.add('component.led');
    b.psu(5, 0.1)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${rv}.wiper`)
      .wire(`${rv}.b`, `${r}.a`)
      .wire(`${r}.b`, `${d}.anode`)
      .wire(`${d}.cathode`, 'GND1.ref')
      .ohms(r, 220)
      .set(rv, 'resistance', { value: 10_000, unit: 'ohm' })
      .set(rv, 'position', { value: position, unit: 'percent' });
    return { b, rv, r, d };
  }
  it('current rises with the position, the 220 Ω bounds it, no rating row anywhere', () => {
    let last = -1;
    for (let pos = 0; pos <= 100; pos += 5) {
      const { b, rv, r, d } = dimmer(pos);
      const s = ok(new EngineSession(b.snapshot()).solve());
      const i = s.components[d]!.current!;
      expect(i).toBeGreaterThan(last);
      last = i;
      // KVL: 5 V = I (R_WB + 220) + V_LED.
      const { wb } = potSegments(10_000, pos);
      near(i * (wb + 220) + s.components[d]!.voltage!, 5, 1e-9);
      near(s.components[r]!.current, i);
      // At most (5 V - V_F) / 220 Ω.
      expect(i).toBeLessThanOrEqual(5 / 220);
      expect(ratingWarnings(b.snapshot(), s)).toEqual([]);
      expect(s.components[rv]!.state!.power as number).toBeLessThan(PTV09A.ratedPowerW);
    }
    // At 100 % the pot is a 0 Ω contact: the LED-current example's operating point.
    near(last, 13.72e-3, 1e-3);
  });
});

describe('potentiometer: live position (applyControl)', () => {
  it('re-solves the divider at each new position without a restart', () => {
    const { b, rv } = divider(5, 10_000, 50);
    const s = new EngineSession(b.snapshot());
    near(ok(s.solve()).components[rv]!.terminals.wiper, 2.5);
    let rev = 1;
    for (const pos of [0, 20, 80, 100, 33.3]) {
      expect(s.applyControl(rv, { params: { position: pos } }, ++rev)).toBeNull();
      near(ok(s.solve()).components[rv]!.terminals.wiper, 5 * (1 - pos / 100));
    }
  });
});

describe('potentiometer: ratings and refusals', () => {
  it('more than 0.05 W in the track: an `unrated` power row', () => {
    // 20 V across 1 kΩ: 0.4 W.
    const { b, rv } = divider(20, 1000, 50);
    const s = ok(new EngineSession(b.snapshot()).solve());
    const rows = ratingWarnings(b.snapshot(), s).filter((w) => w.component === rv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'power', kind: 'unrated', limit: 0.05 });
    near(rows[0]!.value, 0.4);
  });
  it('more than 20 V across it: an `unrated` voltage row', () => {
    const { b, rv } = divider(24, 1e6, 50);
    const s = ok(new EngineSession(b.snapshot()).solve());
    const rows = ratingWarnings(b.snapshot(), s).filter((w) => w.component === rv);
    expect(rows.map((w) => [w.code, w.kind, w.limit])).toEqual([['voltage', 'unrated', 20]]);
  });
  it('a position outside 0 … 100 % is refused by name', () => {
    const { b, rv } = divider(5, 10_000, 50);
    const s = new EngineSession(b.snapshot());
    expect(s.applyControl(rv, { params: { position: 120 } }, 2)).not.toBeNull();
  });
});
