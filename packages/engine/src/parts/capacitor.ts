/**
 * Capacitor (Sprint 10, Tier 5): exposed because time-stepped simulation now runs honestly in the
 * session. An IDEAL capacitor C between its terminals (no ESR, no leakage, no dielectric
 * absorption, non-polarised), integrated by the session's fixed backward-Euler step:
 *
 *   i_n = (C / dt) (v_n - v_{n-1})          (the engine's companion model, devices.ts)
 *
 * Every run starts discharged at t = 0 (deterministic reset). The user-set rated voltage is a
 * design value like a resistance: exceeding it is a rating warning, never a change in physics.
 * At DC (no time step) a capacitor is an open circuit.
 */
import { Capacitor } from '../devices.js';
import { registerPart, type PartModel } from '../parts.js';

export const CAPACITOR: PartModel = {
  terminals: ['a', 'b'],
  cards: {},
  timeDependent: true,
  validate: (ctx) => {
    const c = ctx.quantity('capacitance');
    if (!(c !== undefined && c > 0 && Number.isFinite(c)))
      return { code: 'invalid_parameter', components: [ctx.component.id], param: 'capacitance' };
    const v = ctx.quantity('ratedVoltage');
    if (!(v !== undefined && v > 0 && Number.isFinite(v)))
      return { code: 'invalid_parameter', components: [ctx.component.id], param: 'ratedVoltage' };
    return null;
  },
  elements: (ctx) => {
    const key = ctx.component.id;
    const nodes: [string, string] = [ctx.node('a'), ctx.node('b')];
    const h = ctx.history();
    const history = h ? { v: Number(h.v), i: Number(h.i) } : undefined;
    const c = ctx.quantity('capacitance')!;
    return [
      {
        kind: 'device',
        key,
        nodes,
        make: () => new Capacitor(key, nodes[0], nodes[1], c, history),
      },
    ];
  },
  history: (ctx, sol) => {
    const a = sol.potential('a') ?? 0;
    const b = sol.potential('b') ?? 0;
    return { v: a - b, i: sol.deviceCurrent(ctx.component.id) };
  },
  report: (ctx, _s, sol) => {
    const a = sol.potential('a');
    const b = sol.potential('b');
    const v = a !== null && b !== null ? a - b : null;
    const c = ctx.quantity('capacitance')!;
    return {
      current: sol.deviceCurrent(ctx.component.id),
      voltage: v,
      terminals: { a, b },
      ...(v !== null ? { state: { charge: c * v, energy: 0.5 * c * v * v } } : {}),
    };
  },
  ratings: (params, r) => {
    const rated = params.ratedVoltage as { value: number } | undefined;
    return rated && r.voltage !== null && Math.abs(r.voltage) > rated.value
      ? [{ code: 'voltage', value: Math.abs(r.voltage), limit: rated.value }]
      : [];
  },
};

registerPart('component.capacitor', CAPACITOR);
