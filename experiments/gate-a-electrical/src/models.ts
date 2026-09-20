/**
 * Physical constants and documented device model parameter sets.
 *
 * Every parameter here must be traceable to a citable source or to an explicitly
 * documented fit. Unexplained constants are not permitted (see CLAUDE.md:
 * "Physics Must Be Real").
 */

/** CODATA 2019 exact SI values. */
export const BOLTZMANN_J_PER_K = 1.380649e-23;
export const ELEMENTARY_CHARGE_C = 1.602176634e-19;

/** Datasheet reference temperature: 25 degC, expressed in kelvin. */
export const T_AMBIENT_K = 298.15;

/** Thermal voltage kT/q, in volts. ~25.693 mV at 25 degC. */
export function thermalVoltage(temperatureK: number = T_AMBIENT_K): number {
  return (BOLTZMANN_J_PER_K * temperatureK) / ELEMENTARY_CHARGE_C;
}

export interface DiodeModel {
  /** Model card name, also used for the ngspice cross-check netlist. */
  readonly name: string;
  /** Saturation current, amperes. */
  readonly saturationCurrentA: number;
  /** Emission (ideality) coefficient, dimensionless. */
  readonly emissionCoefficient: number;
  /** Ohmic series resistance, ohms. 0 means "not modelled". */
  readonly seriesResistanceOhm: number;
  /** Temperature at which the parameters apply, kelvin. */
  readonly temperatureK: number;
  /** Provenance of every parameter above. */
  readonly provenance: string;
}

/**
 * Emission coefficient assumed for a GaAsP-on-GaP red LED.
 *
 * APPROXIMATION - documented per the Sprint 0 brief. The Vishay TLHR5400 datasheet
 * (document 83012, rev. 2.7, 25-Jan-2024) publishes exactly one typical forward
 * operating point (V_F = 2 V at I_F = 20 mA) and a log-scale forward I-V figure whose
 * numeric data is not machine-readable. One anchor point cannot identify both I_S and N,
 * so N is fixed here and I_S is fitted to reproduce the datasheet anchor exactly.
 *
 * N = 1.9 sits mid-range for recombination-dominated II-V/GaAsP visible LEDs, which are
 * commonly reported in the range N ~ 1.8 to 2.5. The sensitivity of the Sprint 0 LED test
 * case to this choice is quantified in tests/led-model-sensitivity.test.ts rather than
 * hidden: the resulting operating point is reported across the full N range.
 *
 * This is a parameter-identification limitation, not a solver limitation. Gate A's
 * numerical claim is that our solver and ngspice agree on the SAME model card; fidelity
 * of the card to a physical part is tracked separately in the Sprint 0 backlog.
 */
export const RED_LED_EMISSION_COEFFICIENT = 1.9;

/** Datasheet anchor: Vishay TLHR5400, typical forward voltage at the specified test current. */
export const TLHR5400_ANCHOR = {
  forwardVoltageV: 2.0,
  forwardCurrentA: 0.020,
  source:
    'Vishay TLHR540./TLHY540. datasheet, document 83012, rev. 2.7 (25-Jan-2024), ' +
    'Optical and Electrical Characteristics table: V_F typ. 2 V at I_F = 20 mA, T_amb = 25 degC.',
} as const;

/**
 * Fit I_S so that the Shockley equation reproduces the datasheet anchor exactly at the
 * given emission coefficient:  I_S = I_F / (exp(V_F / (N * Vt)) - 1)
 */
export function fitSaturationCurrent(
  forwardVoltageV: number,
  forwardCurrentA: number,
  emissionCoefficient: number,
  temperatureK: number = T_AMBIENT_K,
): number {
  const nVt = emissionCoefficient * thermalVoltage(temperatureK);
  return forwardCurrentA / (Math.exp(forwardVoltageV / nVt) - 1);
}

/** Documented model card for the Sprint 0 LED reference case. */
export const LED_TLHR5400: DiodeModel = {
  name: 'TLHR5400',
  saturationCurrentA: fitSaturationCurrent(
    TLHR5400_ANCHOR.forwardVoltageV,
    TLHR5400_ANCHOR.forwardCurrentA,
    RED_LED_EMISSION_COEFFICIENT,
  ),
  emissionCoefficient: RED_LED_EMISSION_COEFFICIENT,
  // Series resistance is NOT identifiable from a single datasheet anchor and is therefore
  // not modelled. At the Sprint 0 test current (~14 mA, below the 20 mA anchor) the ohmic
  // drop of a 5 mm indicator LED is small compared with the junction drop. The model is
  // documented as valid only for the 1 mA - 20 mA range; it under-predicts V_F well above it.
  seriesResistanceOhm: 0,
  temperatureK: T_AMBIENT_K,
  provenance:
    `I_S fitted to ${TLHR5400_ANCHOR.source} ` +
    `N = ${RED_LED_EMISSION_COEFFICIENT} assumed (see RED_LED_EMISSION_COEFFICIENT). ` +
    'R_S not modelled (not identifiable from the available datasheet data).',
};
