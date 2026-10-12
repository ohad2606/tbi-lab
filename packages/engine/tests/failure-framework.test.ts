/**
 * Sprint 13 H2, Component Failure Framework: limits are classified by what the datasheet
 * publishes. Above a specified OPERATING maximum only → `operating` (no damage claim); above a
 * published ABSOLUTE maximum → `absolute`. Supplied but outside the operating range → the result
 * is marked unreliable (`outsideModelRange`); a part simply switched off (0 V) is not. No solved
 * value changes because of any of this.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentTypeId } from '@tbi-lab/domain';
import { EngineSession, ratingWarnings, type SolveSuccess } from '../src/index.js';
import { Bench } from './build.js';

function supplied(type: ComponentTypeId, plus: string, volts: number) {
  const b = new Bench();
  const u = b.add(type);
  b.wire('PSU1.positive', `${u}.${plus}`)
    .wire(`${u}.gnd`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .psu(volts, 0.5);
  const snap = b.snapshot();
  const o = new EngineSession(snap).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  const out = o as SolveSuccess;
  return {
    result: out.components[u]!,
    warnings: ratingWarnings(snap, out).filter((w) => w.component === u),
  };
}

const MODULES: [ComponentTypeId, string, { min: number; max: number; absMax?: number }][] = [
  ['sensor.hc_sr04', 'vcc', { min: 4.5, max: 5.5 }],
  ['sensor.dht22', 'vdd', { min: 3.3, max: 6 }],
  ['sensor.pir_hc_sr501', 'vcc', { min: 4.5, max: 20 }],
  ['display.lcd1602_i2c', 'vcc', { min: 4.5, max: 5.5, absMax: 7.0 }],
];

describe('supply limits: operating vs absolute', () => {
  for (const [type, plus, spec] of MODULES) {
    it(`${type}: switched off, below, inside, above the operating range`, () => {
      const off = supplied(type, plus, 0);
      expect(off.result.outsideModelRange).toBe(false);
      expect(off.warnings).toEqual([]);

      const below = supplied(type, plus, spec.min - 0.5);
      expect(below.result.outsideModelRange).toBe(true); // modelled as unpowered: unreliable
      expect(below.result.state!.powered).toBe(false);
      expect(below.warnings).toEqual([]); // no damage, no operating row below the minimum

      const nominal = supplied(type, plus, (spec.min + Math.min(spec.max, spec.min + 1)) / 2);
      expect(nominal.result.outsideModelRange).toBe(false);
      expect(nominal.warnings).toEqual([]);

      const above = supplied(type, plus, spec.max + 0.5);
      expect(above.result.outsideModelRange).toBe(true);
      // Published absolute maximum (LCD): `operating`; none published: `unrated` (risk unknown).
      expect(above.warnings).toEqual([
        expect.objectContaining({
          kind: spec.absMax !== undefined ? 'operating' : 'unrated',
          code: 'voltage',
          limit: spec.max,
          channel: 'supply',
        }),
      ]);
    });
  }

  it('LCD1602: above the 7.0 V logic absolute maximum is a damage risk, reported once', () => {
    const r = supplied('display.lcd1602_i2c', 'vcc', 7.5);
    expect(r.warnings).toEqual([
      expect.objectContaining({ kind: 'absolute', code: 'voltage', limit: 7.0, value: 7.5 }),
    ]);
  });

  it('buzzer CEM-1205: above its 3-6 V operating range, no absolute maximum published: unrated', () => {
    const b = new Bench();
    const z = b.add('component.buzzer');
    b.wire('PSU1.positive', `${z}.positive`)
      .wire(`${z}.negative`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .psu(7, 0.5);
    const snap = b.snapshot();
    const o = new EngineSession(snap).solve() as SolveSuccess;
    expect(ratingWarnings(snap, o)).toEqual([
      expect.objectContaining({ component: z, kind: 'unrated', code: 'voltage', limit: 6 }),
    ]);
    expect(o.components[z]!.outsideModelRange).toBe(true);
  });

  it('published absolute maximums stay damage risks (an LED past 30 mA)', () => {
    const b = new Bench();
    const r = b.add('component.resistor');
    const d = b.add('component.led');
    b.wire('PSU1.positive', `${r}.a`)
      .wire(`${r}.b`, `${d}.anode`)
      .wire(`${d}.cathode`, 'GND1.ref')
      .wire('PSU1.negative', 'GND1.ref')
      .ohms(r, 47)
      .psu(5, 0.5);
    const snap = b.snapshot();
    const o = new EngineSession(snap).solve() as SolveSuccess;
    const w = ratingWarnings(snap, o);
    expect(w.length).toBeGreaterThan(0);
    for (const x of w) expect(x.kind).toBe('absolute');
  });
});
