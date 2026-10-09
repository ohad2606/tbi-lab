/**
 * Temperature and humidity sensor DHT22 / AM2302 (Sprint 12, R2). The SIMULATED ENVIRONMENT is
 * the temperature and relative humidity (`temperature`, `humidity`, live parameters). The frame
 * TIMING comes from peripherals/dht22.ts and is applied by the MCU runtime host as scheduled input
 * edges; this model is the sensor's DC electrical behaviour, solved for each DATA state:
 *
 * - Supply: VDD to GND, 3.3 / 5 / 6 V min/typ/max (AM2302 sheet p.5; DHT22 sheet p.9). Below
 *   3.3 V the sensor is unpowered: it never answers and does not drive DATA. Powered, it draws the
 *   stand-by current (40-50 uA; the model uses the 50 uA bound). The 1-1.5 mA measuring current
 *   flows for about 5 ms per 2 s read and is not part of the DC result (documented).
 * - DATA: the sensor pulls the line low or releases it; the line is high only through a pull-up
 *   (AM2302 p.2: 1 kOhm to VDD in the connection diagram; p.3: "RL pulls up" after the frame).
 *   There is no internal pull-up: without an external one the released line is not high.
 *   ASSUMPTION (A-R2-7): the sheets give no low-level output impedance; R_low = 100 ohm. With
 *   any pull-up from 1 kOhm up the level stays far below V_IL (tests/dht22-part.test.ts).
 * - Pin 3: GND (AM2302 p.2) or NC (DHT22 sheet). CONFLICT: modelled as not connected, so a
 *   circuit that grounds it is correct under both readings.
 *
 * The runtime host sets `data` (`released` | `low`) with EngineSession.setPartRuntime.
 */
import { Resistor } from '../devices.js';
import { ConstantSink } from '../sources.js';
import { registerPart, validateCard, type PartModel, type PartState } from '../parts.js';

export const DHT22_DC = {
  minSupplyV: 3.3,
  maxSupplyV: 6,
  standbyA: 50e-6,
  outputLowOhm: 100,
};

const cards = { 'model.humidity.am2302': { partNumber: 'AM2302' } };
const powered = (s: PartState) => s.powered === true;
/** Supply comparisons tolerate float noise around the exact 3.3 V minimum. */
const EPS_V = 1e-9;

export const DHT22: PartModel = {
  terminals: ['vdd', 'data', 'nc', 'gnd'],
  cards,
  liveParams: ['temperature', 'humidity'],
  runtimeInputs: { data: ['released', 'low'] },
  validate: (ctx) => validateCard(ctx, cards),
  initialState: () => ({ powered: false }),
  elements: (ctx, state) => {
    const id = ctx.component.id;
    const vdd = ctx.node('vdd');
    const gnd = ctx.node('gnd');
    if (!powered(state)) return [];
    const els: ReturnType<PartModel['elements']> = [
      {
        kind: 'device',
        key: `${id}/iq`,
        nodes: [vdd, gnd],
        make: () => new ConstantSink(`${id}/iq`, vdd, gnd, DHT22_DC.standbyA),
      },
    ];
    if (ctx.runtime('data') === 'low') {
      const data = ctx.node('data');
      const drv = `${id}#drv`;
      els.push(
        {
          kind: 'device',
          key: `${id}/rlow`,
          nodes: [data, drv],
          make: () => new Resistor(`${id}/rlow`, data, drv, DHT22_DC.outputLowOhm),
        },
        { kind: 'contact', key: `${id}/ls`, nodes: [drv, gnd], closed: true },
      );
    }
    return els;
  },
  nextState: (_ctx, _state, sol) => {
    const v = sol.potential('vdd');
    const g = sol.potential('gnd');
    return { powered: v !== null && g !== null && v - g >= DHT22_DC.minSupplyV - EPS_V };
  },
  report: (ctx, state, sol) => {
    const id = ctx.component.id;
    const on = powered(state);
    const low = on && ctx.runtime('data') === 'low';
    return {
      current: null,
      voltage: null,
      terminals: {
        vdd: sol.potential('vdd'),
        data: sol.potential('data'),
        nc: sol.potential('nc'),
        gnd: sol.potential('gnd'),
      },
      currents: {
        supply: on ? DHT22_DC.standbyA : 0,
        output: low ? sol.deviceCurrent(`${id}/rlow`) : 0,
      },
      state: { powered: on, output: on ? (low ? 'low' : 'released') : 'off' },
    };
  },
  ratings: (_p, r) => {
    const v = r.terminals.vdd;
    const g = r.terminals.gnd;
    return v != null && g != null && v - g > DHT22_DC.maxSupplyV
      ? [{ code: 'voltage', value: v - g, limit: DHT22_DC.maxSupplyV, channel: 'supply' }]
      : [];
  },
};

registerPart('sensor.dht22', DHT22);
