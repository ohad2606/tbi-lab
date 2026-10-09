/**
 * Ultrasonic ranging module HC-SR04 (Sprint 12, R2). The SIMULATED ENVIRONMENT is the distance to
 * a flat target and the air temperature (`distance`, `airTemperature`, live parameters). The echo
 * TIMING comes from peripherals/hcsr04.ts and is applied by the MCU runtime host as scheduled
 * input edges; this model is the module's DC electrical behaviour, solved for each output state:
 *
 * - Supply: VCC to GND, 4.5 / 5.0 / 5.5 V min/typ/max (Cytron user's manual; Elecfreaks: "DC 5 V").
 *   Below 4.5 V the module is unpowered: no response, ECHO not driven. Powered, it draws the
 *   15 mA working current (Elecfreaks; Cytron 10/15/20 mA) from VCC.
 * - TRIG: a TTL input (Elecfreaks: "10 us TTL pulse"). Its level is read with the standard TTL
 *   thresholds V_IH = 2.0 V, V_IL = 0.8 V (holding in between); it presents no modelled load.
 * - ECHO: a push-pull output to VCC (high) or GND (low), idle low, behind R_out.
 *   ASSUMPTION (A-R2-6): none of the three documents gives an output impedance; R_out = 100 ohm
 *   stands for a 5 V CMOS microcontroller pin. The logic level the ESP32 reads is insensitive to it
 *   in the supported wirings (tests/ultrasonic.test.ts sweeps 10 ohm - 1 kOhm).
 *
 * The runtime host sets `echo` (`low` | `high`) with EngineSession.setPartRuntime; outside a
 * runtime session the output is low.
 */
import { Resistor } from '../devices.js';
import { ConstantSink } from '../sources.js';
import { registerPart, validateCard, type PartModel, type PartState } from '../parts.js';

export const HC_SR04_DC = {
  minSupplyV: 4.5,
  maxSupplyV: 5.5,
  workingA: 0.015,
  outputOhm: 100,
  trigHighV: 2.0,
  trigLowV: 0.8,
};

const cards = { 'model.ultrasonic.hc_sr04': { partNumber: 'HC-SR04' } };
const powered = (s: PartState) => s.powered === true;

export const ULTRASONIC: PartModel = {
  terminals: ['vcc', 'trig', 'echo', 'gnd'],
  cards,
  liveParams: ['distance', 'airTemperature'],
  runtimeInputs: { echo: ['low', 'high'] },
  validate: (ctx) => validateCard(ctx, cards),
  initialState: () => ({ powered: false }),
  elements: (ctx, state) => {
    const id = ctx.component.id;
    const vcc = ctx.node('vcc');
    const gnd = ctx.node('gnd');
    const echo = ctx.node('echo');
    const drv = `${id}#drv`;
    // Unpowered, the output stage is not driven: nothing is attached to ECHO.
    if (!powered(state)) return [];
    const high = ctx.runtime('echo') === 'high';
    const els: ReturnType<PartModel['elements']> = [
      {
        kind: 'device',
        key: `${id}/rout`,
        nodes: [drv, echo],
        make: () => new Resistor(`${id}/rout`, drv, echo, HC_SR04_DC.outputOhm),
      },
      { kind: 'contact', key: `${id}/hs`, nodes: [vcc, drv], closed: high },
      { kind: 'contact', key: `${id}/ls`, nodes: [drv, gnd], closed: !high },
      {
        kind: 'device',
        key: `${id}/iq`,
        nodes: [vcc, gnd],
        make: () => new ConstantSink(`${id}/iq`, vcc, gnd, HC_SR04_DC.workingA),
      },
    ];
    return els;
  },
  nextState: (_ctx, _state, sol) => {
    const v = sol.potential('vcc');
    const g = sol.potential('gnd');
    return { powered: v !== null && g !== null && v - g >= HC_SR04_DC.minSupplyV };
  },
  report: (ctx, state, sol) => {
    const id = ctx.component.id;
    const terminals = {
      vcc: sol.potential('vcc'),
      trig: sol.potential('trig'),
      echo: sol.potential('echo'),
      gnd: sol.potential('gnd'),
    };
    const on = powered(state);
    const high = on && ctx.runtime('echo') === 'high';
    const out = on ? sol.deviceCurrent(`${id}/rout`) : 0; // drv -> echo: out of the ECHO pin
    return {
      current: null,
      voltage: null,
      terminals,
      currents: {
        supply: on ? HC_SR04_DC.workingA + (high ? out : 0) : 0,
        output: out,
      },
      state: { powered: on, output: on ? (high ? 'high' : 'low') : 'off' },
    };
  },
  ratings: (_p, r) => {
    const v = r.terminals.vcc;
    const g = r.terminals.gnd;
    return v != null && g != null && v - g > HC_SR04_DC.maxSupplyV
      ? [{ code: 'voltage', value: v - g, limit: HC_SR04_DC.maxSupplyV, channel: 'supply' }]
      : [];
  },
};

/** TRIG as the module reads it (TTL thresholds, holding inside the band). */
export function hcsr04TrigLevel(trigMinusGnd: number | null, previous: 0 | 1): 0 | 1 {
  if (trigMinusGnd === null) return 0;
  if (trigMinusGnd >= HC_SR04_DC.trigHighV) return 1;
  if (trigMinusGnd <= HC_SR04_DC.trigLowV) return 0;
  return previous;
}

registerPart('sensor.hc_sr04', ULTRASONIC);
