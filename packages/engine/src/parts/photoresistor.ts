/**
 * Photoresistor (LDR), Senba GL5528 (Sprint 10). A linear resistor whose value follows the light
 * on the cell, the part's SIMULATED ENVIRONMENT (a live parameter, `illuminance` in lux):
 *
 *   R(E) = R10 * (E / 10 lx)^(-gamma)
 *
 * Source: Senba Optical & Electronic, "GL55 Series CdS Photoresistor Manual" (5 pages), retrieved
 * 2026-10-06 (SHA-256 02b4172e…aa301c8). Page 2 table, GL5528 row (the second row of the Φ5
 * series table, which lists the series in the page 1 order): light resistance at 10 lx 10-20 kOhm,
 * dark resistance 1 MOhm, gamma = lg(R10/R100) = 0.6; page 1: 150 V, 100 mW maximum.
 *
 * Assumptions (documented): R10 = 14.14 kOhm, the geometric centre of the 10-20 kOhm class (a
 * typical part, not a measured one); gamma 0.6 from the manufacturer (a generic GL5528 sheet gives
 * 0.7 and 8-20 kOhm: CONFLICT recorded in PROVENANCE.md). The illuminance curves (page 4-5) span
 * 1-100 lx: outside that span the law is extrapolated and the result says so. The response time
 * (20-30 ms) and temperature dependence are not modelled (DC, 25 degC).
 */
import { Resistor } from '../devices.js';
import { registerPart, validateCard, type PartModel } from '../parts.js';

export const GL5528 = {
  r10Ohm: Math.sqrt(10e3 * 20e3),
  gamma: 0.6,
  validLux: [1, 100] as const,
  maxPowerW: 0.1,
  maxVoltageV: 150,
};

export function ldrResistance(lux: number): number {
  return GL5528.r10Ohm * (lux / 10) ** -GL5528.gamma;
}

const cards = { 'model.ldr.senba_gl5528': { partNumber: 'GL5528' } };

export const PHOTORESISTOR: PartModel = {
  terminals: ['a', 'b'],
  cards,
  liveParams: ['illuminance'],
  validate: (ctx) => {
    const bad = validateCard(ctx, cards);
    if (bad) return bad;
    const e = ctx.quantity('illuminance');
    return e !== undefined && e > 0 && Number.isFinite(e)
      ? null
      : { code: 'invalid_parameter', components: [ctx.component.id], param: 'illuminance' };
  },
  elements: (ctx) => {
    const key = ctx.component.id;
    const nodes: [string, string] = [ctx.node('a'), ctx.node('b')];
    const r = ldrResistance(ctx.quantity('illuminance')!);
    return [{ kind: 'device', key, nodes, make: () => new Resistor(key, nodes[0], nodes[1], r) }];
  },
  report: (ctx, _s, sol) => {
    const a = sol.potential('a');
    const b = sol.potential('b');
    const lux = ctx.quantity('illuminance')!;
    return {
      current: sol.deviceCurrent(ctx.component.id),
      voltage: a !== null && b !== null ? a - b : null,
      terminals: { a, b },
      state: { resistance: ldrResistance(lux) },
      outsideModelRange: lux < GL5528.validLux[0] || lux > GL5528.validLux[1],
    };
  },
  ratings: (_p, r) => {
    const out: ReturnType<NonNullable<PartModel['ratings']>> = [];
    if (r.voltage !== null && r.current !== null) {
      const p = Math.abs(r.voltage * r.current);
      if (p > GL5528.maxPowerW) out.push({ code: 'power', value: p, limit: GL5528.maxPowerW });
      if (Math.abs(r.voltage) > GL5528.maxVoltageV)
        out.push({ code: 'voltage', value: Math.abs(r.voltage), limit: GL5528.maxVoltageV });
    }
    return out;
  },
};

registerPart('component.photoresistor', PHOTORESISTOR);
