/**
 * I2C character LCD 16x2 (Sprint 12, R3): an HD44780-compatible module (JHD659 specification,
 * arduino.cc copy) behind a PCF8574 I2C backpack. The display CONTENT is driven over I2C by the
 * MCU runtime host (peripherals/hd44780.ts, I2cLcd), which adds it to the part's result; this model
 * is the module's DC electrical behaviour:
 *
 * - Supply: VCC to GND, 4.5-5.5 V operating (JHD659 p.6; the PCF8574 alone runs from 2.5 V, NXP
 *   p.16). Below 4.5 V the module is unpowered: it does not acknowledge on the bus. Above 5.5 V a
 *   rating warning (logic absolute maximum 7.0 V, p.6).
 *   The PCF8574 reads SDA/SCL with V_IH = 0.7 VDD (NXP p.16): at 5 V the idle lines must be
 *   above 3.5 V, which 3.3 V pull-ups do not reach and 5 V pull-ups reach only by exceeding the
 *   ESP32 pads' 3.6 V maximum. From a 4.5 V supply 3.3 V pull-ups meet it (0.7 x 4.5 V = 3.15 V).
 * - Backlight: the LED (V_f 5.0 V typ at I_f 20 mA, JHD659 p.7) switched by the backpack's port
 *   bit P3. ASSUMPTION (A-R3-1): the backpack schematic was not found (Sprint 10 FACTS 10b); the
 *   backlight is modelled as its datasheet 20 mA from VCC while on. The host sets `backlight`.
 * - SDA/SCL: PCF8574 inputs, leakage +-1 uA (NXP p.16), modelled as no load. The backpack is
 *   modelled WITHOUT on-board pull-ups (PM D-4: external I2C pull-ups are required); the I2C
 *   bus works only through pull-ups present in the circuit. Line levels during a transaction
 *   (a target pulling SDA low) are not part of the DC result: I2C is transaction-level.
 */
import { ConstantSink } from '../sources.js';
import {
  registerPart,
  supplyAcross,
  supplyLimits,
  supplyOutsideModel,
  validateCard,
  type PartModel,
  type PartState,
} from '../parts.js';

export const LCD1602_DC = {
  minSupplyV: 4.5,
  maxSupplyV: 5.5,
  /** JHD659 p.6, absolute maximum ratings: logic supply 7.0 V. */
  absoluteMaxSupplyV: 7.0,
  logicA: 0.35e-3 + 40e-6,
  backlightA: 0.02,
};

const cards = { 'model.lcd.lcd1602_pcf8574': { partNumber: 'LCD1602 + PCF8574' } };
const powered = (s: PartState) => s.powered === true;

export const LCD1602_I2C: PartModel = {
  terminals: ['gnd', 'vcc', 'sda', 'scl'],
  cards,
  runtimeInputs: { backlight: ['off', 'on'] },
  validate: (ctx) => validateCard(ctx, cards),
  initialState: () => ({ powered: false }),
  elements: (ctx, state) => {
    if (!powered(state)) return [];
    const id = ctx.component.id;
    const vcc = ctx.node('vcc');
    const gnd = ctx.node('gnd');
    const amps =
      LCD1602_DC.logicA + (ctx.runtime('backlight') === 'on' ? LCD1602_DC.backlightA : 0);
    return [
      {
        kind: 'device',
        key: `${id}/iq`,
        nodes: [vcc, gnd],
        make: () => new ConstantSink(`${id}/iq`, vcc, gnd, amps),
      },
    ];
  },
  nextState: (_ctx, _state, sol) => {
    const v = sol.potential('vcc');
    const g = sol.potential('gnd');
    return { powered: v !== null && g !== null && v - g >= LCD1602_DC.minSupplyV };
  },
  report: (ctx, state, sol) => {
    const on = powered(state);
    const light = on && ctx.runtime('backlight') === 'on';
    return {
      current: null,
      voltage: null,
      terminals: {
        gnd: sol.potential('gnd'),
        vcc: sol.potential('vcc'),
        sda: sol.potential('sda'),
        scl: sol.potential('scl'),
      },
      currents: {
        supply: on ? LCD1602_DC.logicA + (light ? LCD1602_DC.backlightA : 0) : 0,
      },
      state: { powered: on, backlight: light },
      outsideModelRange: supplyOutsideModel(
        supplyAcross({ vcc: sol.potential('vcc'), gnd: sol.potential('gnd') }, 'vcc'),
        {
          minV: LCD1602_DC.minSupplyV,
          maxV: LCD1602_DC.maxSupplyV,
        },
      ),
    };
  },
  // Sprint 13 H2: 4.5-5.5 V operating; 7.0 V is the logic supply's absolute maximum (JHD659 p.6).
  ratings: (_p, r) =>
    supplyLimits(supplyAcross(r.terminals, 'vcc'), {
      maxOperatingV: LCD1602_DC.maxSupplyV,
      absoluteMaxV: LCD1602_DC.absoluteMaxSupplyV,
    }),
};

/** PCF8574 input thresholds as fractions of its supply (NXP p.16: V_IH 0.7 VDD, V_IL 0.3 VDD). */
export const PCF8574_VIH_FRACTION = 0.7;
export const PCF8574_VIL_FRACTION = 0.3;

registerPart('display.lcd1602_i2c', LCD1602_I2C);
