/**
 * PIR motion sensor module HC-SR501 (Sprint 10, sensors). The SIMULATED ENVIRONMENT is whether
 * motion is in front of the sensor (`motion`, a live boolean parameter); the module's electrical
 * behaviour follows its published schematic:
 *
 * - Supply: VCC to GND, operating 4.5-20 V. Below 4.5 V the module is unpowered: no quiescent
 *   current and NO output drive (nothing attached to OUT; review round 3). Powered, it draws its quiescent current (< 50 uA; the model uses 50 uA, the
 *   stated bound) plus whatever its output delivers (the 7133 regulator feeds the BISS0001).
 * - Output: the BISS0001 output (3.3 V high / 0 V low) through R14 = 1 kOhm to the OUT pin. High
 *   while motion is detected; the output current comes from VCC (RegulatedOutput), low sinks to GND.
 * - Powered state is discrete state settled by the session's fixed point (parts.ts).
 *
 * Not modelled (DC steady state): the retrigger delay (5-300 s), the blocking time, the warm-up
 * minute, detection range/angle and sensitivity. With motion present the steady output is high (the
 * default repeatable-trigger mode); without motion it is low once the delay has expired.
 *
 * Sources (no single manufacturer): the HC-SR501 3-page sheet with schematic (alldatasheet copy via
 * digsys.upc.edu, SHA-256 955d333a…a2f86d): 4.5-20 V, < 50 uA, 3.3 V/0 V output, R14 1 kOhm, pins
 * GND/OUT/+V; Tayda and Handson Technology user guides for the same figures (conflicts recorded in
 * docs/sprints/s10-evidence/datasheets/FACTS.md: one sheet's "65 mA" consumption contradicts < 50 uA).
 */
import { Resistor, VoltageSource } from '../devices.js';
import { ConstantSink, RegulatedOutput } from '../sources.js';
import {
  registerPart,
  supplyAcross,
  supplyLimits,
  supplyOutsideModel,
  validateCard,
  type PartModel,
  type PartState,
} from '../parts.js';

export const HC_SR501 = {
  minSupplyV: 4.5,
  maxSupplyV: 20,
  quiescentA: 50e-6,
  outHighV: 3.3,
  outputOhm: 1000,
};

const cards = { 'model.pir.hc_sr501': { partNumber: 'HC-SR501' } };

const powered = (s: PartState) => s.powered === true;

export const PIR: PartModel = {
  terminals: ['gnd', 'out', 'vcc'],
  cards,
  liveParams: ['motion'],
  validate: (ctx) => validateCard(ctx, cards),
  initialState: () => ({ powered: false }),
  elements: (ctx, state) => {
    const id = ctx.component.id;
    const gnd = ctx.node('gnd');
    const vcc = ctx.node('vcc');
    const out = ctx.node('out');
    const drv = `${id}#drv`;
    // Review round 3 (A2): unpowered (V_CC below the 4.5 V minimum, or a pin open) the module's
    // output stage has no supply: nothing is attached to OUT (as for the HC-SR04 and DHT22). It
    // was an ideal 0 V source behind R14, which made an input on OUT a valid LOW.
    if (!powered(state)) return [];
    const high = ctx.value('motion') === true;
    const els: ReturnType<PartModel['elements']> = [
      {
        kind: 'device',
        key: `${id}/r14`,
        nodes: [drv, out],
        make: () => new Resistor(`${id}/r14`, drv, out, HC_SR501.outputOhm),
      },
      high
        ? {
            kind: 'device',
            key: `${id}/drv`,
            nodes: [vcc, drv, gnd],
            make: () => new RegulatedOutput(`${id}/drv`, vcc, drv, gnd, HC_SR501.outHighV),
          }
        : {
            kind: 'device',
            key: `${id}/drv`,
            nodes: [drv, gnd],
            make: () => new VoltageSource(`${id}/drv`, drv, gnd, 0),
          },
    ];
    els.push({
      kind: 'device',
      key: `${id}/iq`,
      nodes: [vcc, gnd],
      make: () => new ConstantSink(`${id}/iq`, vcc, gnd, HC_SR501.quiescentA),
    });
    return els;
  },
  nextState: (_ctx, _state, sol) => {
    const v = sol.potential('vcc');
    const g = sol.potential('gnd');
    return { powered: v !== null && g !== null && v - g >= HC_SR501.minSupplyV };
  },
  report: (ctx, state, sol) => {
    const id = ctx.component.id;
    const terminals = {
      gnd: sol.potential('gnd'),
      out: sol.potential('out'),
      vcc: sol.potential('vcc'),
    };
    const on = powered(state);
    const high = on && ctx.value('motion') === true;
    const out = on ? sol.deviceCurrent(`${id}/r14`) : 0; // into the OUT pin's load
    const supply = on ? HC_SR501.quiescentA + (high ? sol.deviceCurrent(`${id}/drv`) : 0) : 0;
    return {
      current: null,
      voltage: null,
      terminals,
      currents: { supply, output: out },
      state: { powered: on, output: high ? 'high' : 'low' },
      outsideModelRange: supplyOutsideModel(supplyAcross(terminals, 'vcc'), {
        minV: HC_SR501.minSupplyV,
        maxV: HC_SR501.maxSupplyV,
      }),
    };
  },
  // Sprint 13 H2: 4.5-20 V is the specified operating range; no absolute maximum is published.
  ratings: (_p, r) =>
    supplyLimits(supplyAcross(r.terminals, 'vcc'), { maxOperatingV: HC_SR501.maxSupplyV }),
};

registerPart('sensor.pir_hc_sr501', PIR);
