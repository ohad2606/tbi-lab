/**
 * TowerPro SG90 micro servo (Sprint 15, R4): the electrical side of the part. Its POSITION is not
 * an electrical quantity: it follows the control pulses over time (peripherals/servo.ts), which
 * only the ESP32 runtime produces (an LEDC or GPIO waveform on the signal wire). A DC solve
 * therefore reports the servo at rest, with no pulses; the runtime host replaces the motion state.
 *
 * Electrical model, stated as limitations rather than invented numbers:
 * - Supply current (VCC - GND): NOT modelled (decision R4-D3). The SG90 sheets give no idle or
 *   moving current that a DC model could use honestly (TowerPro: none; vendor sheets: 100-250 mA
 *   running, ~650 mA stall, without conditions). The result reports it as unknown (null), never 0,
 *   and the inspector says so: a 3.3 V pin or a weak supply is not shown sagging.
 * - Signal input: draws no modelled current (high impedance). Its logic thresholds are not
 *   specified by the manufacturer; the model takes 2.0 V / 0.8 V (the TTL convention hobby-servo
 *   inputs that accept 3.3-5 V logic follow), relative to the servo's GND. ASSUMPTION.
 * - Supply range: 4.8-6.0 V (TowerPro: 4.8 V nominal; the R4 architecture's 4.8-6 V). Outside it
 *   the servo is not simulated as moving (it holds) and the result is flagged as outside the
 *   model; above 6.0 V an `unrated` supply warning (no absolute maximum is published).
 *
 * Source: TowerPro SG90 data sheet (wire colours: brown GND, red +4.8 V, orange PWM signal;
 * 50 Hz / 20 ms frame; 60 degrees per 0.1 s at 4.8 V), and the vendor sheets recorded in
 * peripherals/servo.ts.
 */
import {
  registerPart,
  supplyAcross,
  supplyLimits,
  supplyOutsideModel,
  validateCard,
  type PartModel,
} from '../parts.js';

export const SG90_ELECTRICAL = {
  minSupplyV: 4.8,
  maxSupplyV: 6.0,
  /** Signal thresholds relative to GND (assumption, see above). */
  inputHighV: 2.0,
  inputLowV: 0.8,
};

/** The signal's logic level from its potential above the servo's GND, or null in between. */
export function servoSignalLevel(volts: number | null): 0 | 1 | null {
  if (volts === null) return null;
  if (volts >= SG90_ELECTRICAL.inputHighV) return 1;
  if (volts <= SG90_ELECTRICAL.inputLowV) return 0;
  return null;
}

/** Whether the servo is supplied within its modelled range. */
export function servoPowered(supplyV: number | null): boolean {
  return (
    supplyV !== null &&
    supplyV >= SG90_ELECTRICAL.minSupplyV &&
    supplyV <= SG90_ELECTRICAL.maxSupplyV
  );
}

const cards = { 'model.servo.sg90': { partNumber: 'SG90' } };

export const SERVO: PartModel = {
  terminals: ['gnd', 'vcc', 'signal'],
  cards,
  validate: (ctx) => validateCard(ctx, cards),
  // No electrical element: no modelled current anywhere (see above).
  elements: () => [],
  report: (_ctx, _state, sol) => {
    const terminals = {
      gnd: sol.potential('gnd'),
      vcc: sol.potential('vcc'),
      signal: sol.potential('signal'),
    };
    const supply = supplyAcross(terminals, 'vcc');
    return {
      current: null,
      voltage: null,
      terminals,
      currents: { supply: null },
      // At rest: the runtime host replaces these with the pulse-driven motion.
      state: { powered: servoPowered(supply), angleDeg: 90, commandedDeg: 90, signal: 'none' },
      outsideModelRange: supplyOutsideModel(supply, {
        minV: SG90_ELECTRICAL.minSupplyV,
        maxV: SG90_ELECTRICAL.maxSupplyV,
      }),
    };
  },
  ratings: (_p, r) =>
    supplyLimits(supplyAcross(r.terminals, 'vcc'), { maxOperatingV: SG90_ELECTRICAL.maxSupplyV }),
};

registerPart('component.servo_sg90', SERVO);
