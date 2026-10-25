import { describe, expect, it } from 'vitest';
import { createSnapshot, deleteSelection, emptySelection } from '@tbi-lab/domain';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';
import { LED_TLHR5400, thermalVoltage } from '../src/models.js';
import golden from './gate-a-golden.json';
import { Bench, ledLoop, resistorLoop } from './build.js';

const REL = 1e-9;
const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const rel = (a: number | null, e: number, label: string) =>
  expect(
    a === null ? Infinity : Math.abs(a - e) / Math.abs(e),
    `${label}: ${a} vs ${e}`,
  ).toBeLessThanOrEqual(REL);
const bits = (x: number | null) =>
  [...new Uint8Array(new Float64Array([x ?? NaN]).buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

function ledReference(supplyV: number, r: number) {
  const nVt = LED_TLHR5400.emissionCoefficient * thermalVoltage(LED_TLHR5400.temperatureK);
  const i = (vj: number) => LED_TLHR5400.saturationCurrentA * (Math.exp(vj / nVt) - 1);
  let lo = 0;
  let hi = supplyV;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (supplyV - mid - r * i(mid) > 0) lo = mid;
    else hi = mid;
  }
  const vj = 0.5 * (lo + hi);
  return { vj, current: i(vj) };
}

describe('product path: project document -> snapshot -> engine', () => {
  it('A4: 5 V PSU -> 1 kΩ -> GND gives 5 mA, PSU in CV', () => {
    const r = ok(new EngineSession(resistorLoop(5, 0.1, 1000).snapshot()).solve());
    rel(r.components.R1!.current, 5e-3, 'I(R1)');
    rel(r.components.R1!.voltage!, 5, 'V(R1)');
    expect(r.components.PSU1!.mode).toBe('cv');
    rel(r.components.PSU1!.current, 5e-3, 'I(PSU1)');
    rel(r.components.PSU1!.voltage!, 5, 'V(PSU1)');
    expect(r.stats.maxKclResidualA).toBeLessThanOrEqual(1e-12);
  });

  it('A5: 5 V -> 220 Ω -> LED -> GND matches the proven model, bit-identical to Gate A', () => {
    const r = ok(new EngineSession(ledLoop(5, 0.1, 220).snapshot()).solve());
    const ref = ledReference(5, 220);
    rel(r.components.D1!.current, ref.current, 'I(D1)');
    rel(r.components.D1!.voltage!, ref.vj, 'Vf(D1)');
    expect(r.components.PSU1!.mode).toBe('cv');
    // Same circuit, same device order as the Gate A LED-through-PSU case: identical bits.
    const g = (golden as unknown as Record<string, Record<string, string>>).case7psu!;
    expect(bits(r.components.D1!.current)).toBe(g.iD1);
    expect(bits(r.components.D1!.terminals.anode!)).toBe(g.vAnode);
    expect(r.components.D1!.current).toBeGreaterThan(0.01);
    expect(r.components.D1!.current).toBeLessThan(0.02);
    expect(r.components.D1!.outsideModelRange).toBe(false);
  });

  it('flags an LED driven beyond its documented 1-20 mA model range, without changing numbers', () => {
    const r = ok(new EngineSession(ledLoop(12, 1, 47).snapshot()).solve());
    expect(r.components.D1!.current).toBeGreaterThan(0.1);
    expect(r.components.D1!.outsideModelRange).toBe(true);
    const dim = ok(new EngineSession(ledLoop(2.5, 1, 100_000).snapshot()).solve());
    expect(dim.components.D1!.outsideModelRange).toBe(true);
    const off = ok(new EngineSession(ledLoop(5, 0.1, 220, false).snapshot()).solve());
    expect(off.components.D1!.outsideModelRange).toBeUndefined();
  });

  it('A6: 5 V / 100 mA into 10 Ω enters CC at 100 mA, 1 V', () => {
    const r = ok(new EngineSession(resistorLoop(5, 0.1, 10).snapshot()).solve());
    expect(r.components.PSU1!.mode).toBe('cc');
    rel(r.components.PSU1!.current, 0.1, 'I(PSU1)');
    rel(r.components.PSU1!.voltage!, 1, 'V(PSU1)');
    rel(r.components.R1!.current, 0.1, 'I(R1)');
  });

  it('reproduces the remaining Gate A cases through lab PSUs with ample limits', () => {
    const b = new Bench();
    const r1 = b.add('component.resistor');
    const r2 = b.add('component.resistor');
    b.wire('PSU1.positive', `${r1}.a`)
      .wire(`${r1}.b`, `${r2}.a`)
      .wire(`${r2}.b`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref');
    b.psu(12, 1).ohms(r1, 10_000).ohms(r2, 10_000);
    let r = ok(new EngineSession(b.snapshot()).solve());
    rel(r.components[r2]!.terminals.a!, 6, 'divider midpoint');
    b.psu(9, 1).ohms(r1, 1000).ohms(r2, 2000);
    r = ok(new EngineSession(b.snapshot()).solve());
    rel(r.components[r1]!.current, 3e-3, 'series current');
    // Open circuit: R3 hangs off the supply with one unwired terminal.
    const r3 = b.add('component.resistor');
    b.wire('PSU1.positive', `${r3}.a`);
    r = ok(new EngineSession(b.snapshot()).solve());
    expect(Math.abs(r.components[r3]!.current!)).toBeLessThanOrEqual(1e-12);
    rel(r.components[r3]!.terminals.b!, 9, 'open end sits at the supply potential');
    // Current-limited short: 1 mΩ.
    r = ok(new EngineSession(resistorLoop(5, 0.1, 1e-3).snapshot()).solve());
    expect(r.components.PSU1!.mode).toBe('cc');
    rel(r.components.PSU1!.voltage!, 1e-4, 'V at the limit into 1 mΩ');
  });
});

describe('A7: PSU output OFF is an open circuit, not a 0 V source', () => {
  it('OFF: exactly zero source current; the same circuit ON solves normally', () => {
    const off = ok(new EngineSession(ledLoop(5, 0.1, 220, false).snapshot()).solve());
    expect(off.components.PSU1!.mode).toBe('off');
    expect(off.components.PSU1!.current).toBe(0);
    expect(off.components.R1!.current).toBe(0);
    expect(Math.abs(off.components.D1!.current!)).toBe(0);
    expect(off.components.D1!.voltage).toBe(0);
    const on = ok(new EngineSession(ledLoop(5, 0.1, 220, true).snapshot()).solve());
    rel(on.components.D1!.current, ledReference(5, 220).current, 'I(D1) once enabled');
  });

  it('differs from an enabled 0 V supply: OFF is high impedance, 0 V ON is a stiff source', () => {
    // A second, enabled 5 V supply (PSU2) drives the same node the first one sits on.
    const build = (psu1Enabled: boolean, psu1Volts: number) => {
      const b = new Bench();
      const r = b.add('component.resistor');
      const p2 = b.add('instrument.lab_psu');
      b.wire(`${p2}.positive`, `${r}.a`).wire(`${r}.b`, 'PSU1.positive');
      b.wire(`${p2}.negative`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
      b.psu(psu1Volts, 0.1, psu1Enabled).ohms(r, 1000);
      b.set(p2, 'setpointVoltage', { value: 5, unit: 'volt' }).set(p2, 'outputEnabled', true);
      return ok(new EngineSession(b.snapshot()).solve());
    };
    const off = build(false, 5);
    // OFF: nothing flows, so PSU1's terminal floats up to PSU2's 5 V through R1.
    expect(off.components.PSU1!.mode).toBe('off');
    expect(off.components.R1!.current).toBe(0);
    rel(off.components.PSU1!.voltage!, 5, 'OFF terminal voltage');
    // Enabled at 0 V: it would have to SINK 5 mA. This lab-PSU model cannot sink (documented
    // idealisation), so it is not the same as OFF: the solver finds CC at the limit instead of
    // an open circuit, and the terminal is no longer the open-circuit 5 V.
    // Sprint 22 review 3: refused by name (psu_sinking), never shown as a negative current.
    const b0 = new Bench();
    const r0 = b0.add('component.resistor');
    const q2 = b0.add('instrument.lab_psu');
    b0.wire(`${q2}.positive`, `${r0}.a`).wire(`${r0}.b`, 'PSU1.positive');
    b0.wire(`${q2}.negative`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
    b0.psu(0, 0.1, true).ohms(r0, 1000);
    b0.set(q2, 'setpointVoltage', { value: 5, unit: 'volt' }).set(q2, 'outputEnabled', true);
    expect(new EngineSession(b0.snapshot()).solve()).toMatchObject({
      ok: false,
      error: {
        code: 'psu_sinking',
        components: ['PSU1'],
        detail: { value: expect.closeTo(0.005, 12) },
      },
    });
  });

  it('a live output-enable change re-solves the same snapshot', () => {
    const s = new EngineSession(ledLoop(5, 0.1, 220, false).snapshot());
    expect(ok(s.solve()).components.PSU1!.mode).toBe('off');
    expect(s.applyPsuControl('PSU1', { outputEnabled: true }, 99)).toBeNull();
    const r = ok(s.solve());
    expect(r.components.PSU1!.mode).toBe('cv');
    expect(r.appliedRevision).toBe(99);
    expect(r.components.D1!.current).toBeGreaterThan(0.01);
  });
});

describe('A10: live PSU controls are runtime copies of browser-persisted values', () => {
  it('setpoint and limit changes re-solve without a new snapshot', () => {
    const snap = resistorLoop(5, 1, 10).snapshot();
    const s = new EngineSession(snap);
    rel(ok(s.solve()).components.R1!.current, 0.5, 'CV 5 V / 10 Ω');
    s.applyPsuControl('PSU1', { currentLimit: 0.1 }, snap.projectRevision + 1);
    let r = ok(s.solve());
    expect(r.components.PSU1!.mode).toBe('cc');
    rel(r.components.R1!.current, 0.1, 'CC at the new limit');
    s.applyPsuControl('PSU1', { setpointVoltage: 0.5 }, snap.projectRevision + 2);
    r = ok(s.solve());
    expect(r.components.PSU1!.mode).toBe('cv');
    rel(r.components.R1!.current, 0.05, 'CV at the new setpoint');
    expect(r.snapshotId).toBe(snap.snapshotId);
    expect(r.snapshotRevision).toBe(snap.projectRevision);
    expect(r.appliedRevision).toBe(snap.projectRevision + 2);
    // The snapshot itself is never mutated by a live control.
    expect(snap.components[0]!.params.setpointVoltage).toEqual({ value: 5, unit: 'volt' });
  });

  it('refuses controls for non-PSU components and invalid values', () => {
    const s = new EngineSession(resistorLoop(5, 1, 10).snapshot());
    expect(s.applyPsuControl('R1', { setpointVoltage: 1 }, 5)?.code).toBe('unsupported_component');
    expect(s.applyPsuControl('PSU1', { currentLimit: 0 }, 5)?.code).toBe('invalid_parameter');
    expect(s.applyPsuControl('PSU1', { setpointVoltage: Number.NaN }, 5)?.code).toBe(
      'invalid_parameter',
    );
  });
});

describe('A8: topology diagnostics instead of cryptic solver failures', () => {
  it('a floating island names its components and nets', () => {
    const b = resistorLoop(5, 0.1, 1000);
    const r2 = b.add('component.resistor');
    const d = b.add('component.led');
    b.wire(`${r2}.b`, `${d}.anode`).wire(`${d}.cathode`, `${r2}.a`); // a closed loop with no GND
    const o = new EngineSession(b.snapshot()).solve();
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.error.code).toBe('floating_circuit');
    expect(o.error.components).toEqual([r2, d]);
    expect(o.error.nets!.length).toBe(2);
    expect(o.error.outputOffSupplies).toBeUndefined();
  });

  it('says when an island floats only because a PSU output is off', () => {
    // R1 hangs off PSU1+ with its other end open: it reaches GND only through the supply.
    const b = new Bench();
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${r}.a`).wire('PSU1.negative', 'GND1.ref');
    const off = new EngineSession(b.psu(5, 0.1, false).snapshot()).solve();
    expect(off.ok).toBe(false);
    if (!off.ok) {
      expect(off.error.code).toBe('floating_circuit');
      expect(off.error.outputOffSupplies).toEqual(['PSU1']);
    }
    expect(new EngineSession(b.psu(5, 0.1, true).snapshot()).solve().ok).toBe(true);
  });

  it('a circuit with no wired GND is refused, never grounded silently', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, 'PSU1.negative').psu(5, 0.1);
    const o = new EngineSession(b.snapshot()).solve();
    expect(!o.ok && o.error.code).toBe('no_ground');
  });

  it('components with nothing wired are reported as not connected and not simulated', () => {
    const b = resistorLoop(5, 0.1, 1000);
    const spare = b.add('component.led');
    const r = ok(new EngineSession(b.snapshot()).solve());
    expect(r.notConnected).toEqual([spare]);
    expect(r.components[spare]).toBeUndefined();
  });

  it('a new project (nothing wired) has nothing to simulate', () => {
    const o = new EngineSession(new Bench().snapshot()).solve();
    expect(!o.ok && o.error.code).toBe('empty_circuit');
  });

  it('an enabled PSU shorted by a wire is refused; the same PSU off is fine', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', 'PSU1.negative')
      .wire('PSU1.negative', 'GND1.ref')
      .wire(`${r}.a`, 'PSU1.positive')
      .wire(`${r}.b`, 'GND1.ref');
    const on = new EngineSession(b.psu(5, 0.1, true).snapshot()).solve();
    expect(!on.ok && on.error.code).toBe('psu_shorted');
    expect(new EngineSession(b.psu(5, 0.1, false).snapshot()).solve().ok).toBe(true);
  });

  it('contradictory directly-paralleled supplies are refused as an unsupported configuration', () => {
    const b = new Bench();
    const p2 = b.add('instrument.lab_psu');
    const r = b.add('component.resistor');
    b.wire('PSU1.positive', `${p2}.positive`)
      .wire('PSU1.negative', 'GND1.ref')
      .wire(`${p2}.negative`, 'GND1.ref');
    b.wire(`${r}.a`, 'PSU1.positive').wire(`${r}.b`, 'GND1.ref');
    b.psu(5, 1)
      .set(p2, 'setpointVoltage', { value: 3, unit: 'volt' })
      .set(p2, 'outputEnabled', true);
    const o = new EngineSession(b.snapshot()).solve();
    expect(o.ok).toBe(false);
    if (!o.ok)
      expect(o.error).toMatchObject({ code: 'psu_parallel', components: ['PSU1', 'PSU2'] });
  });

  it('never throws: malformed parameters become invalid_parameter', () => {
    const snap = resistorLoop(5, 0.1, 1000).snapshot();
    (snap.components.find((c) => c.id === 'R1')!.params as Record<string, unknown>).resistance = {
      value: -1,
      unit: 'ohm',
    };
    const o = new EngineSession(snap).solve();
    expect(!o.ok && o.error).toMatchObject({
      code: 'invalid_parameter',
      components: ['R1'],
      param: 'resistance',
    });
  });

  it('deleting the ground turns a working circuit into a no_ground refusal', () => {
    const b = resistorLoop(5, 0.1, 1000);
    const d = deleteSelection(b.doc, { ...emptySelection(), components: ['GND1'] });
    if (!d.ok) throw new Error();
    const o = new EngineSession(createSnapshot(d.doc)).solve();
    expect(!o.ok && o.error.code).toBe('no_ground');
  });
});

describe('snapshot', () => {
  it('excludes layout and user text; the same design gives the same snapshotId', () => {
    const a = resistorLoop(5, 0.1, 1000);
    const snap = a.snapshot();
    const json = JSON.stringify(snap);
    expect(json).not.toContain('layout');
    expect(json).not.toContain('Engine'); // project name
    expect(createSnapshot({ ...a.doc, name: 'שם אחר' }).snapshotId).toBe(snap.snapshotId);
    expect(resistorLoop(5, 0.1, 1001).snapshot().snapshotId).not.toBe(snap.snapshotId);
  });
});

describe('A14: multiple GND symbols are one global reference', () => {
  it('two GND symbols that are not wired to each other are the same electrical node', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    const g2 = b.add('component.ground');
    // PSU- goes to GND1, the resistor returns through a separate GND2 symbol.
    b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${g2}.ref`).wire('PSU1.negative', 'GND1.ref');
    b.psu(5, 0.1).ohms(r, 1000);
    const snap = b.snapshot();
    // The drawing has two separate ground-role nets ...
    expect(snap.nets.filter((n) => n.role === 'ground')).toHaveLength(2);
    // ... and the engine treats both as the single reference: the loop closes through GND.
    const res = ok(new EngineSession(snap).solve());
    rel(res.components[r]!.current, 5e-3, 'I(R) through GND1 and GND2');
    for (const n of snap.nets.filter((x) => x.role === 'ground'))
      expect(res.netVoltages[n.id]).toBe(0);
  });
});
