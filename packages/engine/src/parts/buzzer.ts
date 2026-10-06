/**
 * Active (internally driven) magnetic buzzer, CUI Devices / Same Sky CEM-1205-IC (Sprint 10).
 *
 * ELECTRICAL MODEL (separate from any sound presentation): its DC current is the average its own
 * oscillator and coil draw, given by the datasheet's voltage-vs-current curve, modelled as a
 * piecewise-linear load (pwl.ts) through the graph readings. It SOUNDS when the forward voltage is
 * inside the specified operating range (3.0-6.0 V); the tone is the rated 2400 Hz.
 *
 * Source: Same Sky (CUI Devices) CEM-1205-IC datasheet dated 09/11/2024, retrieved 2026-10-06
 * (SHA-256 a4a26a0f…aab3320). Page 1: rated 5.0 V, operating 3.0-6.0 V, 30 mA max at rated
 * voltage, 2400 Hz, 92 dBA at 10 cm. Page 2 voltage-vs-current curve, GRAPH READINGS (+-0.5 mA):
 * 3 V 13.3 mA, 4 V 22.5 mA, 5 V 27.6 mA, 6 V 30.0 mA.
 *
 * Limits (documented): below 3 V the curve is not given (the model interpolates to 0 A at 0 V and
 * says it is outside its model; the part is not guaranteed to sound there); above 6 V the last
 * segment is extrapolated and the maximum is exceeded (a rating warning); reverse polarity is not
 * specified: the model does not conduct and does not sound, and says so.
 */
import { PwlLoad } from '../pwl.js';
import { registerPart, validateCard, type PartModel } from '../parts.js';

export const CEM_1205_IC = {
  curve: [
    [3, 0.0133],
    [4, 0.0225],
    [5, 0.0276],
    [6, 0.03],
  ] as const,
  operatingV: [3, 6] as const,
  maxVoltageV: 6,
  frequencyHz: 2400,
};

const cards = { 'model.buzzer.cui_cem_1205_ic': { partNumber: 'CEM-1205-IC' } };

export const BUZZER: PartModel = {
  terminals: ['positive', 'negative'],
  cards,
  validate: (ctx) => validateCard(ctx, cards),
  elements: (ctx) => {
    const key = ctx.component.id;
    const nodes: [string, string] = [ctx.node('positive'), ctx.node('negative')];
    return [
      {
        kind: 'device',
        key,
        nodes,
        make: () => new PwlLoad(key, nodes[0], nodes[1], CEM_1205_IC.curve),
      },
    ];
  },
  report: (ctx, _s, sol) => {
    const p = sol.potential('positive');
    const n = sol.potential('negative');
    const v = p !== null && n !== null ? p - n : null;
    const [lo, hi] = CEM_1205_IC.operatingV;
    const sounding = v !== null && v >= lo && v <= hi;
    return {
      current: sol.deviceCurrent(ctx.component.id),
      voltage: v,
      terminals: { positive: p, negative: n },
      state: { sounding },
      // Any noticeable bias outside 3-6 V forward is outside the datasheet's curve.
      outsideModelRange: v !== null && Math.abs(v) > 1e-3 && (v < lo || v > hi),
    };
  },
  ratings: (_p, r) =>
    r.voltage !== null && r.voltage > CEM_1205_IC.maxVoltageV
      ? [{ code: 'voltage', value: r.voltage, limit: CEM_1205_IC.maxVoltageV }]
      : [],
};

registerPart('component.buzzer', BUZZER);
