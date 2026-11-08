/**
 * Sprint 28: the R2 gate workload (runtime/tests/r2-support.ts gateProject) is physically valid
 * under the product's own rules, checked with the product engine at every state the R2 tests
 * visit: VEXT low/high x GPIO2 low/high. The pre-Sprint-28 workload is kept here as the control:
 * the engine refuses it (`psu_sinking`), which is why seven R2 runtime tests could not pass.
 */
import { createSnapshot, setParam, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, V_IH_V, V_IL_V, type RuntimePinMode } from '@tbi-lab/engine';
import { describe, expect, it } from 'vitest';
import { Doc, GATE_V2, gateProject } from '../../tests/r2-support.js';

function solve(doc: ProjectDocument, r1: string, r2: string, vext: number, io2: RuntimePinMode) {
  const set = setParam(doc, 'PSU1', 'setpointVoltage', { value: vext, unit: 'volt' });
  if (!set.ok) throw new Error(set.error);
  const s = new EngineSession(createSnapshot(set.doc), {
    pins: [
      { gpio: 2, component: r1, terminal: 'a' },
      { gpio: 5, component: r2, terminal: 'b' },
    ],
  });
  s.setPinMode(2, io2);
  return s.solve();
}

describe('R2 gate workload v2 (Sprint 28)', () => {
  const { d, r1, r2 } = gateProject();
  for (const vext of [GATE_V2.vextLowV, GATE_V2.vextHighV])
    for (const io2 of ['output-low', 'output-high'] as const)
      it(`VEXT ${vext} V, GPIO2 ${io2}: solves, GPIO5 defined, the supply sources`, () => {
        const o = solve(d.doc, r1, r2, vext, io2);
        expect(o.ok, JSON.stringify(!o.ok && o.error)).toBe(true);
        if (!o.ok) return;
        const v5 = o.pins!.find((p) => p.gpio === 5)!.voltage;
        if (vext === GATE_V2.vextLowV) expect(v5).toBeLessThan(V_IL_V - 0.3);
        else expect(v5).toBeGreaterThan(V_IH_V + 0.4);
        const psu = o.components.PSU1!.current!;
        expect(psu).toBeGreaterThan(40e-6); // delivered out of + (never sinking)
        // the hand calculation in r2-support.ts, to 1 mV
        const expected =
          (vext / GATE_V2.r3Ohm +
            (io2 === 'output-high' ? o.pins!.find((p) => p.gpio === 2)!.voltage : 0) /
              GATE_V2.r2Ohm) /
          (1 / GATE_V2.r2Ohm + 1 / GATE_V2.r3Ohm + 1 / GATE_V2.r4Ohm);
        expect(Math.abs(v5 - expected)).toBeLessThan(1e-3);
      });

  it('control: the pre-Sprint-28 workload (10 k / 10 k, VEXT 0 V, no bleeder) is refused as psu_sinking', () => {
    const d = new Doc();
    const r1 = d.add('component.resistor');
    const d1 = d.add('component.led');
    const r2 = d.add('component.resistor');
    const r3 = d.add('component.resistor');
    d.wire(`${r1}.b`, `${d1}.anode`).wire(`${d1}.cathode`, 'GND1.ref');
    d.wire(`${r2}.a`, `${r1}.a`).wire(`${r3}.b`, `${r2}.b`);
    d.wire('PSU1.positive', `${r3}.a`).wire('PSU1.negative', 'GND1.ref');
    d.set(r1, 'resistance', { value: 220, unit: 'ohm' });
    d.set(r2, 'resistance', { value: 10_000, unit: 'ohm' });
    d.set(r3, 'resistance', { value: 10_000, unit: 'ohm' });
    d.set('PSU1', 'currentLimit', { value: 0.1, unit: 'ampere' });
    d.set('PSU1', 'outputEnabled', true);
    const o = solve(d.doc, r1, r2, 0, 'output-high');
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.error.code).toBe('psu_sinking');
  });
});
