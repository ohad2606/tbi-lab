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
import { potSegments, ratedTrackCurrentA } from '../src/parts/potentiometer.js';
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

describe('potentiometer: rheostat LED dimmer (1 kΩ + 470 Ω), within the rated condition', () => {
  function dimmer(position: number, series = 470) {
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
      .ohms(r, series)
      .set(rv, 'resistance', { value: 1000, unit: 'ohm' })
      .set(rv, 'position', { value: position, unit: 'percent' });
    return { b, rv, r, d };
  }
  const positions = [...Array.from({ length: 101 }, (_, i) => i), 0.01, 99.9, 99.99].sort(
    (x, y) => x - y,
  );
  it('current rises with the position, stays below sqrt(0.05 W / 1 kΩ), no rating row anywhere', () => {
    let last = -1;
    for (const pos of positions) {
      const { b, r, d } = dimmer(pos);
      const s = ok(new EngineSession(b.snapshot()).solve());
      const i = s.components[d]!.current!;
      expect(i).toBeGreaterThan(last);
      last = i;
      const { wb } = potSegments(1000, pos);
      near(i * (wb + 470) + s.components[d]!.voltage!, 5, 1e-9);
      near(s.components[r]!.current, i);
      expect(i).toBeLessThan(ratedTrackCurrentA(1000));
      expect(ratingWarnings(b.snapshot(), s)).toEqual([]);
    }
  });
  it('the same dimmer with 430 Ω exceeds the rated condition at the wiper near 100 %', () => {
    const { b, rv } = dimmer(100, 430);
    const s = ok(new EngineSession(b.snapshot()).solve());
    const rows = ratingWarnings(b.snapshot(), s).filter((w) => w.component === rv);
    expect(rows.map((w) => [w.code, w.kind, w.channel])).toEqual([
      ['track_current', 'unrated', 'wiper'],
    ]);
    near(rows[0]!.limit, Math.sqrt(0.05 / 1000));
  });
});

describe('potentiometer: rated-condition track current (review H1 scenarios)', () => {
  it('5 V through 100 Ω into a 1 kΩ rheostat at 2 % (A-W, B open): track-current rows, no power row', () => {
    const b = new Bench();
    const rv = b.add('component.potentiometer');
    const r = b.add('component.resistor');
    b.psu(5, 0.5)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${r}.a`)
      .wire(`${r}.b`, `${rv}.a`)
      .wire(`${rv}.wiper`, 'GND1.ref')
      .ohms(r, 100)
      .set(rv, 'resistance', { value: 1000, unit: 'ohm' })
      .set(rv, 'position', { value: 2, unit: 'percent' });
    const s = ok(new EngineSession(b.snapshot()).solve());
    const i = 5 / 120; // 41.7 mA through 100 Ω + 20 Ω
    near(s.components[rv]!.currents!.aw, i);
    near(s.components[rv]!.state!.power as number, i * i * 20);
    const rows = ratingWarnings(b.snapshot(), s).filter((w) => w.component === rv);
    // 34.7 mW is below 0.05 W: only the derived rows (segment A-W and the wiper) fire.
    expect(rows.map((w) => [w.code, w.kind, w.channel])).toEqual([
      ['track_current', 'unrated', 'aw'],
      ['track_current', 'unrated', 'wiper'],
    ]);
    for (const w of rows) {
      near(w.value, i);
      near(w.limit, Math.sqrt(0.05 / 1000));
    }
  });
  it('1 kΩ with +5 V on A, wiper at 2 % to GND: power and track-current rows', () => {
    const b = new Bench();
    const rv = b.add('component.potentiometer');
    b.psu(5, 0.5)
      .wire('PSU1.negative', 'GND1.ref')
      .wire('PSU1.positive', `${rv}.a`)
      .wire(`${rv}.wiper`, 'GND1.ref')
      .set(rv, 'resistance', { value: 1000, unit: 'ohm' })
      .set(rv, 'position', { value: 2, unit: 'percent' });
    const s = ok(new EngineSession(b.snapshot()).solve());
    const rows = ratingWarnings(b.snapshot(), s).filter((w) => w.component === rv);
    const codes = rows.map((w) => `${w.code}:${w.channel ?? ''}`).sort();
    expect(codes).toEqual(['power:', 'track_current:aw', 'track_current:wiper'].sort());
    for (const w of rows) expect(w.kind).toBe('unrated');
  });
  it('an unloaded divider at any position stays inside the rated condition (5 V, 1 kΩ: 5 mA < 7.07 mA)', () => {
    for (const pos of [0, 0.01, 50, 99.99, 100]) {
      const { b } = divider(5, 1000, pos);
      const s = ok(new EngineSession(b.snapshot()).solve());
      expect(ratingWarnings(b.snapshot(), s)).toEqual([]);
    }
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
    const rows = ratingWarnings(b.snapshot(), s).filter(
      (w) => w.component === rv && w.code === 'power',
    );
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
  it('a position outside 0 … 100 % or off the 0.01 % grid is refused', () => {
    const { b, rv } = divider(5, 10_000, 50);
    const s = new EngineSession(b.snapshot());
    expect(s.applyControl(rv, { params: { position: 120 } }, 2)).not.toBeNull();
    expect(s.applyControl(rv, { params: { position: 1e-13 } }, 3)).not.toBeNull();
    expect(s.applyControl(rv, { params: { position: 99.999 } }, 4)).not.toBeNull();
    expect(s.applyControl(rv, { params: { position: 99.99 } }, 5)).toBeNull();
  });
});
