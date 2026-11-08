/**
 * Sprint 10 parts (PM-6 revision), engine level: RGB LED, photoresistor, buzzer, relay. Each is
 * checked against its datasheet source (closed form or ngspice on the same model card), for
 * isolation/topology semantics, live environment controls, discrete state and ratings.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from 'eecircuit-engine';
import {
  EngineSession,
  RGB_WP154A4SUREQBFZGC,
  ratingWarnings,
  thermalVoltageForTests,
  type SolveOutcome,
  type SolveSuccess,
} from './partsHelpers.js';
import { Bench } from './build.js';
import { ldrResistance, GL5528 } from '../src/parts/photoresistor.js';
import { CEM_1205_IC } from '../src/parts/buzzer.js';
import { SRD_05VDC_SL_C } from '../src/parts/relay.js';
import { WP154A4SUREQBFZGC_DATA } from '../src/models.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${JSON.stringify(o.error)}`);
  return o;
};

/** Model V_F at a forward current: I*R_S + N*Vt*ln(I/I_S + 1). */
const vf = (card: (typeof RGB_WP154A4SUREQBFZGC)['red'], i: number) =>
  i * card.seriesResistanceOhm +
  card.emissionCoefficient * thermalVoltageForTests() * Math.log(i / card.saturationCurrentA + 1);

describe('RGB LED (Kingbright WP154A4SUREQBFZGC, common cathode)', () => {
  it('each channel card reproduces its datasheet typical V_F at 20 mA exactly, and the graph within 30 mV', () => {
    for (const ch of ['red', 'green', 'blue'] as const) {
      const card = RGB_WP154A4SUREQBFZGC[ch];
      const [ia, va] = WP154A4SUREQBFZGC_DATA.anchors[ch];
      expect(vf(card, ia)).toBeCloseTo(va, 7);
      for (const [i, v] of WP154A4SUREQBFZGC_DATA.readings[ch])
        expect(Math.abs(vf(card, i) - v)).toBeLessThan(0.031);
    }
    // InGaN dice are strongly ohmic; the AlGaInP red die is not.
    expect(RGB_WP154A4SUREQBFZGC.blue.seriesResistanceOhm).toBeGreaterThan(10);
    expect(RGB_WP154A4SUREQBFZGC.red.seriesResistanceOhm).toBeLessThan(3);
  });

  /** PSU -> R1 -> red, R2 -> green, R3 -> blue; common cathode to GND. */
  function rgbBench(ohms: [number, number, number], volts = 5) {
    const b = new Bench();
    const d = b.add('component.rgb_led');
    const rs = ['red', 'green', 'blue'].map((ch, k) => {
      const r = b.add('component.resistor');
      b.ohms(r, ohms[k]!).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${d}.${ch}`);
      return r;
    });
    b.wire(`${d}.cathode`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(volts, 1);
    return { b, d, rs };
  }

  it('channels are independent: each current is set by its own resistor and card', () => {
    const { b, d } = rgbBench([150, 82, 82]);
    const r = ok(new EngineSession(b.snapshot()).solve()).components[d]!;
    expect(r.currents!.red).toBeGreaterThan(0.015);
    expect(r.currents!.green).toBeGreaterThan(0.015);
    // KCL at the common cathode: its current is the sum of the channels.
    const sum = r.currents!.red! + r.currents!.green! + r.currents!.blue!;
    expect(sum).toBeGreaterThan(0.045);
    expect(r.terminals.cathode).toBe(0);
    // An unwired anode carries nothing; the other channels are unchanged.
    const b2 = new Bench();
    const d2 = b2.add('component.rgb_led');
    const r1 = b2.add('component.resistor');
    b2.ohms(r1, 150).wire('PSU1.positive', `${r1}.a`).wire(`${r1}.b`, `${d2}.red`);
    b2.wire(`${d2}.cathode`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(5, 1);
    const only = ok(new EngineSession(b2.snapshot()).solve()).components[d2]!;
    expect(Math.abs(only.currents!.green!)).toBeLessThan(1e-12);
    expect(only.currents!.red).toBeCloseTo(r.currents!.red!, 12);
  });

  it('flags currents beyond the per-die maximum (green 25 mA) by channel, solved values unchanged', () => {
    const { b, d } = rgbBench([150, 47, 82]);
    const snap = b.snapshot();
    const o = ok(new EngineSession(snap).solve());
    const w = ratingWarnings(snap, o).filter((x) => x.component === d);
    expect(
      w.some((x) => x.channel === 'green' && x.code === 'forward_current' && x.limit === 0.025),
    ).toBe(true);
    expect(o.components[d]!.currents!.green).toBeGreaterThan(0.025);
  });
});

describe('RGB LED against ngspice (same cards, R_S included)', () => {
  let sim: Simulation;
  beforeAll(async () => {
    sim = new Simulation();
    await sim.start();
  }, 120_000);

  it('channel currents agree within 1e-6 relative', async () => {
    const ohms: [number, number, number] = [150, 82, 100];
    const b = new Bench();
    const d = b.add('component.rgb_led');
    ['red', 'green', 'blue'].forEach((ch, k) => {
      const r = b.add('component.resistor');
      b.ohms(r, ohms[k]!).wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${d}.${ch}`);
    });
    b.wire(`${d}.cathode`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref').psu(5, 1);
    const ours = ok(new EngineSession(b.snapshot()).solve()).components[d]!.currents!;
    const c = RGB_WP154A4SUREQBFZGC;
    const model = (n: string, m: (typeof c)['red']) =>
      `.model ${n} D(IS=${m.saturationCurrentA} N=${m.emissionCoefficient} RS=${m.seriesResistanceOhm})`;
    sim.setNetList(
      [
        'rgb',
        'V1 p 0 5',
        `R1 p ar ${ohms[0]}`,
        `R2 p ag ${ohms[1]}`,
        `R3 p ab ${ohms[2]}`,
        'DR ar 0 MR',
        'DG ag 0 MG',
        'DB ab 0 MB',
        model('MR', c.red),
        model('MG', c.green),
        model('MB', c.blue),
        '.options temp=25 tnom=25 reltol=1e-9 abstol=1e-15 vntol=1e-12',
        '.op',
        '.end',
      ].join('\n'),
    );
    const res = await sim.runSim();
    expect(sim.getError()).toEqual([]);
    const v = (n: string) =>
      (
        res.data.find((x: { name: string }) => x.name.toLowerCase() === `v(${n})`)!
          .values as number[]
      )[0]!;
    const spice = {
      red: (5 - v('ar')) / ohms[0],
      green: (5 - v('ag')) / ohms[1],
      blue: (5 - v('ab')) / ohms[2],
    };
    for (const ch of ['red', 'green', 'blue'] as const)
      expect(Math.abs(ours[ch]! - spice[ch]) / spice[ch]).toBeLessThan(1e-6);
  }, 120_000);
});

describe('photoresistor (Senba GL5528) and its simulated light', () => {
  it('R(E) = R10 (E/10)^-0.6 with R10 = 14.14 kOhm; a divider solves exactly; light is a live control', () => {
    expect(ldrResistance(10)).toBeCloseTo(Math.sqrt(2e8), 6);
    expect(ldrResistance(10) / ldrResistance(100)).toBeCloseTo(10 ** 0.6, 9);
    const b = new Bench();
    const l = b.add('component.photoresistor');
    const r = b.add('component.resistor');
    b.ohms(r, 10e3)
      .wire('PSU1.positive', `${l}.a`)
      .wire(`${l}.b`, `${r}.a`)
      .wire(`${r}.b`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .psu(5, 0.1)
      .set(l, 'illuminance', { value: 10, unit: 'lux' });
    const s = new EngineSession(b.snapshot());
    const at = (o: SolveSuccess) => o.components[r]!.terminals.a!;
    const dim = ok(s.solve());
    expect(at(dim)).toBeCloseTo((5 * 10e3) / (10e3 + ldrResistance(10)), 9);
    expect(dim.components[l]!.state!.resistance).toBeCloseTo(ldrResistance(10), 6);
    expect(dim.components[l]!.outsideModelRange).toBe(false);
    // Brighter: the browser persists the new light level, then mirrors it.
    expect(s.applyControl(l, { params: { illuminance: 100 } }, 2)).toBeNull();
    const bright = ok(s.solve());
    expect(at(bright)).toBeCloseTo((5 * 10e3) / (10e3 + ldrResistance(100)), 9);
    expect(bright.appliedRevision).toBe(2);
    // Beyond the characterised 1-100 lx the law is extrapolated, and the result says so.
    s.applyControl(l, { params: { illuminance: 1000 } }, 3);
    expect(ok(s.solve()).components[l]!.outsideModelRange).toBe(true);
    // Only declared live parameters are accepted; a non-positive light level is refused.
    expect(s.applyControl(l, { params: { model: 'x' } }, 4)?.code).toBe('unsupported_component');
    // Sprint 11: refused when the mirror applies (the domain's live-control range, 1-10 000 lx),
    // so an invalid value never reaches the circuit; the previous light level stays in effect.
    expect(s.applyControl(l, { params: { illuminance: 0 } }, 5)).toMatchObject({
      code: 'invalid_parameter',
      param: 'illuminance',
    });
    expect(ok(s.solve()).components[l]!.outsideModelRange).toBe(true);
    expect(GL5528.validLux).toEqual([1, 100]);
  });
});

describe('active buzzer (CEM-1205-IC)', () => {
  function bz(volts: number, reversed = false) {
    const b = new Bench();
    const z = b.add('component.buzzer');
    const [p, n] = reversed ? ['negative', 'positive'] : ['positive', 'negative'];
    b.wire('PSU1.positive', `${z}.${p}`)
      .wire(`${z}.${n}`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .psu(volts, 0.5);
    const snap = b.snapshot();
    const o = ok(new EngineSession(snap).solve());
    return { r: o.components[z]!, w: ratingWarnings(snap, o) };
  }
  it('draws the datasheet curve current and sounds inside 3-6 V', () => {
    expect(bz(5).r.current).toBeCloseTo(0.0276, 10); // plus gmin * V
    expect(bz(5).r.state).toEqual({ sounding: true });
    expect(bz(4.5).r.current).toBeCloseTo((0.0225 + 0.0276) / 2, 10);
    expect(bz(3).r.outsideModelRange).toBe(false);
  });
  it('below 3 V and reversed: not sounding, outside the model; above 6 V: a rating warning', () => {
    const low = bz(2);
    expect(low.r.state!.sounding).toBe(false);
    expect(low.r.outsideModelRange).toBe(true);
    const rev = bz(5, true);
    expect(rev.r.state!.sounding).toBe(false);
    expect(Math.abs(rev.r.current!)).toBeLessThan(1e-9);
    expect(rev.r.outsideModelRange).toBe(true);
    const high = bz(9);
    expect(high.r.state!.sounding).toBe(false);
    expect(high.w.map((x) => [x.code, x.limit])).toEqual([['voltage', CEM_1205_IC.maxVoltageV]]);
  });
  it('in series with a resistor it settles on the curve (KCL with the piecewise load)', () => {
    const b = new Bench();
    const z = b.add('component.buzzer');
    const r = b.add('component.resistor');
    b.ohms(r, 47)
      .wire('PSU1.positive', `${r}.a`)
      .wire(`${r}.b`, `${z}.positive`)
      .wire(`${z}.negative`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .psu(6, 0.5);
    const o = ok(new EngineSession(b.snapshot()).solve());
    const v = o.components[z]!.voltage!;
    // On the 4-5 V segment: I = 0.0225 + 0.0051 (V - 4) and I = (6 - V) / 47.
    const exact = (6 / 47 - 0.0225 + 0.0204) / (1 / 47 + 0.0051);
    expect(v).toBeCloseTo(exact, 9);
    expect(o.components[z]!.current).toBeCloseTo((6 - exact) / 47, 9);
  });
});

describe('relay (Songle SRD-05VDC-SL-C): separate coil and contact sides, hysteresis', () => {
  /** PSU -> coil -> GND; the contact side: PSU -> COM, NO -> R1 -> GND, NC -> R2 -> GND. */
  function relayBench() {
    const b = new Bench();
    const k = b.add('component.relay');
    const rNo = b.add('component.resistor');
    const rNc = b.add('component.resistor');
    b.wire('PSU1.positive', `${k}.coil1`)
      .wire(`${k}.coil2`, 'GND1.ref')
      .wire('PSU1.positive', `${k}.com`)
      .wire(`${k}.no`, `${rNo}.a`)
      .wire(`${rNo}.b`, 'GND1.ref')
      .wire(`${k}.nc`, `${rNc}.a`)
      .wire(`${rNc}.b`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .ohms(rNo, 1000)
      .ohms(rNc, 2000);
    return { b, k, rNo, rNc };
  }

  it('picks up at the guaranteed pull-in voltage, holds down to the drop-out voltage (hysteresis)', () => {
    const { b, k, rNo, rNc } = relayBench();
    b.psu(3, 1);
    const s = new EngineSession(b.snapshot());
    const step = (v: number, rev: number) => {
      expect(s.applyControl('PSU1', { setpointVoltage: v }, rev)).toBeNull();
      return ok(s.solve());
    };
    let o = ok(s.solve());
    expect(o.components[k]!.state).toEqual({ energized: false, contact: 'nc' });
    expect(o.components[rNc]!.current).toBeCloseTo(3 / 2000, 12);
    expect(o.components[rNo]!.current).toBe(0);
    o = step(SRD_05VDC_SL_C.pullInV, 2); // 3.75 V: guaranteed to pick up
    expect(o.components[k]!.state!.energized).toBe(true);
    expect(o.components[rNo]!.current).toBeCloseTo(3.75 / 1000, 12);
    expect(o.components[k]!.currents!.coil).toBeCloseTo(3.75 / 70, 12);
    expect(o.components[k]!.currents!.contact).toBeCloseTo(3.75 / 1000, 12);
    o = step(2, 3); // between drop-out and pull-in: stays energized
    expect(o.components[k]!.state!.energized).toBe(true);
    o = step(0.5, 4); // at the drop-out voltage: released
    expect(o.components[k]!.state!.energized).toBe(false);
    o = step(2, 5); // and stays released below pull-in
    expect(o.components[k]!.state!.energized).toBe(false);
    // A new session starts at rest: 2 V never picks it up.
    expect(ok(new EngineSession(b.snapshot()).solve()).components[k]!.state!.energized).toBe(false);
  });

  it('coil and contacts are galvanically separate: a contact side with no reference is floating', () => {
    const b = new Bench();
    const k = b.add('component.relay');
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${k}.coil1`)
      .wire(`${k}.coil2`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .wire(`${k}.com`, `${r}.a`)
      .wire(`${r}.b`, `${k}.nc`)
      .psu(5, 1);
    const o = new EngineSession(b.snapshot()).solve();
    // Energized, COM-NO open: the resistor hangs between COM and NC with nothing referencing them.
    expect(o.ok ? 'ok' : o.error.code).toBe('floating_circuit');
  });

  it('a relay that interrupts its own coil (coil fed through NC) has no steady state', () => {
    const b = new Bench();
    const k = b.add('component.relay');
    b.wire('PSU1.positive', `${k}.com`)
      .wire(`${k}.nc`, `${k}.coil1`)
      .wire(`${k}.coil2`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .psu(5, 1);
    const o = new EngineSession(b.snapshot()).solve();
    expect(o.ok).toBe(false);
    if (!o.ok) {
      expect(o.error.code).toBe('no_steady_state');
      expect(o.error.components).toEqual([k]);
    }
  });

  it('coil over-voltage (120 % of nominal) is a rating warning', () => {
    const { b, k } = relayBench();
    b.psu(7, 1);
    const snap = b.snapshot();
    const w = ratingWarnings(snap, ok(new EngineSession(snap).solve()));
    expect(w).toContainEqual(
      expect.objectContaining({ component: k, code: 'voltage', channel: 'coil', limit: 6 }),
    );
  });
});
