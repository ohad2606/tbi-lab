/**
 * Electromechanical relay, Songle SRD-05VDC-SL-C (Sprint 10): 5 V, 0.36 W coil, form C (SPDT).
 *
 * The COIL SIDE and the CONTACT SIDE are separate circuits, exactly as in the part: the coil is a
 * resistor between A1 and A2; the contacts are ideal contacts COM-NC (at rest) or COM-NO
 * (energized). Nothing joins the two sides electrically; the engine's reference analysis treats
 * each side as its own island.
 *
 * The armature is DISCRETE STATE settled by the session's fixed point (parts.ts), with the
 * datasheet's guaranteed thresholds and real hysteresis:
 *   at rest:   it picks up when |V_coil| >= the pull-in voltage   (75 % of nominal max: 3.75 V)
 *   energized: it drops out when |V_coil| <= the drop-out voltage (10 % of nominal min: 0.5 V)
 * In between it keeps its position. A real part picks up somewhere at or below 3.75 V and drops
 * out somewhere at or above 0.5 V: the model uses the guaranteed limits and never claims more.
 * A relay that switches off its own coil has no DC steady state and is refused (no_steady_state).
 *
 * Source: Songle Relay SRD datasheet (ISO9002), retrieved 2026-10-06 via a third-party host
 * (circuitbasics.com; SHA-256 9967e9a6…c515e46). Coil data chart (at 20 degC), SRD-05 high
 * sensitivity (L, 0.36 W): 5 VDC nominal, 71.4 mA, 70 Ohm +-10 %, pull-in 75 % max, drop-out 10 %
 * min, max allowable 120 %. Contact rating form C 7 A 28 VDC / 10 A 125 VAC; contact resistance
 * 100 mOhm max (modelled as an ideal contact, like the switches); operate 10 ms / release 5 ms
 * (not modelled: DC steady state). Coil inductance (and so the flyback transient) is not modelled.
 */
import { Resistor } from '../devices.js';
import { registerPart, validateCard, type PartModel, type PartState } from '../parts.js';

export const SRD_05VDC_SL_C = {
  coilOhm: 70,
  nominalV: 5,
  pullInV: 0.75 * 5,
  dropOutV: 0.1 * 5,
  maxCoilV: 1.2 * 5,
  contactMaxA: 7,
};

const cards = { 'model.relay.songle_srd_05vdc_sl_c': { partNumber: 'SRD-05VDC-SL-C' } };

const energized = (s: PartState) => s.energized === true;

export const RELAY: PartModel = {
  terminals: ['coil1', 'coil2', 'com', 'no', 'nc'],
  cards,
  validate: (ctx) => validateCard(ctx, cards),
  initialState: () => ({ energized: false }),
  elements: (ctx, state) => {
    const id = ctx.component.id;
    const coil: [string, string] = [ctx.node('coil1'), ctx.node('coil2')];
    const on = energized(state);
    return [
      {
        kind: 'device',
        key: `${id}/coil`,
        nodes: coil,
        make: () => new Resistor(`${id}/coil`, coil[0], coil[1], SRD_05VDC_SL_C.coilOhm),
      },
      { kind: 'contact', key: `${id}/no`, nodes: [ctx.node('com'), ctx.node('no')], closed: on },
      { kind: 'contact', key: `${id}/nc`, nodes: [ctx.node('com'), ctx.node('nc')], closed: !on },
    ];
  },
  nextState: (_ctx, state, sol) => {
    const a = sol.potential('coil1');
    const b = sol.potential('coil2');
    const v = a !== null && b !== null ? Math.abs(a - b) : 0;
    const on = energized(state) ? v > SRD_05VDC_SL_C.dropOutV : v >= SRD_05VDC_SL_C.pullInV;
    return { energized: on };
  },
  report: (ctx, state, sol) => {
    const id = ctx.component.id;
    const on = energized(state);
    const terminals: Record<string, number | null> = {};
    for (const t of RELAY.terminals) terminals[t] = sol.potential(t);
    return {
      current: null,
      voltage: null,
      terminals,
      currents: {
        coil: sol.deviceCurrent(`${id}/coil`),
        contact: sol.contactCurrent(on ? `${id}/no` : `${id}/nc`),
      },
      state: { energized: on, contact: on ? 'no' : 'nc' },
    };
  },
  ratings: (_p, r) => {
    const out: ReturnType<NonNullable<PartModel['ratings']>> = [];
    const a = r.terminals.coil1;
    const b = r.terminals.coil2;
    if (a != null && b != null && Math.abs(a - b) > SRD_05VDC_SL_C.maxCoilV)
      out.push({
        code: 'voltage',
        value: Math.abs(a - b),
        limit: SRD_05VDC_SL_C.maxCoilV,
        channel: 'coil',
      });
    const ic = r.currents?.contact;
    if (ic != null && Math.abs(ic) > SRD_05VDC_SL_C.contactMaxA)
      out.push({
        code: 'current',
        value: Math.abs(ic),
        limit: SRD_05VDC_SL_C.contactMaxA,
        channel: 'contact',
      });
    return out;
  },
};

registerPart('component.relay', RELAY);
