/*
 * PROMOTED (Sprint 3) from experiments/gate-a-electrical/src/models.ts at tag sprint-1-complete.
 * The numerical logic is unchanged; production edits are limited to those listed in
 * packages/engine/PROVENANCE.md. experiments/ keeps the original as frozen Gate A evidence.
 */
/**
 * Physical constants and documented device model parameter sets.
 *
 * Every parameter here must be traceable to a citable source or to an explicitly
 * documented fit. Unexplained constants are not permitted (see CLAUDE.md:
 * "Physics Must Be Real").
 */

export interface PhysicalConstants {
  readonly boltzmannJPerK: number;
  readonly elementaryChargeC: number;
  readonly source: string;
}

/** Default: the exact SI values fixed by the 2019 redefinition. */
export const CODATA_2019: PhysicalConstants = {
  boltzmannJPerK: 1.380649e-23,
  elementaryChargeC: 1.602176634e-19,
  source: 'CODATA 2019 / SI 2019 redefinition (exact by definition)',
};

/** Datasheet reference temperature: 25 degC, expressed in kelvin. */
export const T_AMBIENT_K = 298.15;

/** Thermal voltage kT/q, in volts. ~25.693 mV at 25 degC. */
export function thermalVoltage(
  temperatureK: number = T_AMBIENT_K,
  constants: PhysicalConstants = CODATA_2019,
): number {
  return (constants.boltzmannJPerK * temperatureK) / constants.elementaryChargeC;
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
  /** Physical constants used for kT/q. Defaults to CODATA 2019. */
  readonly constants?: PhysicalConstants;
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
  forwardCurrentA: 0.02,
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
  constants: PhysicalConstants = CODATA_2019,
): number {
  const nVt = emissionCoefficient * thermalVoltage(temperatureK, constants);
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

/**
 * Datasheet anchors for the Vishay 1N4148 small-signal switching diode (Sprint 4).
 *
 * Source: Vishay Semiconductors, "1N4148 Small Signal Fast Switching Diodes", Document
 * Number 81857, Rev. 1.6, 07-Nov-2024 (https://www.vishay.com/docs/81857/1n4148.pdf,
 * SHA-256 aefe8540…46a44b7). Fig. 1, "Typical Forward Voltage vs. Junction Temperature",
 * read at T_j = 25 degC. The figure's lines were read from the PDF's VECTOR path data and
 * calibrated against its own gridlines, not digitized from pixels:
 * packages/engine/tools/extract_1n4148.py reproduces every number below.
 */
export const VISHAY_1N4148_ANCHORS = {
  /** [forward current A, typical forward voltage V] at T_j = 25 degC. */
  typicalForward: [
    [1e-4, 0.499],
    [1e-3, 0.6105],
    [1e-2, 0.7306],
    [1e-1, 0.8775],
  ] as ReadonlyArray<readonly [number, number]>,
  /** Electrical Characteristics table limits (not used by the fit; checked by tests). */
  maxForwardVoltageAt10mA: 1.0,
  maxReverseCurrentAt20V: 25e-9,
  source:
    'Vishay 1N4148 datasheet, Document 81857, Rev. 1.6 (07-Nov-2024): Fig. 1 typical V_F at ' +
    'T_j = 25 degC for I_F = 0.1/1/10/100 mA (vector-extracted); Electrical Characteristics table.',
} as const;

/**
 * Shockley + series-resistance card for the 1N4148, fitted by least squares to the four
 * anchors above (V_F = N*Vt*ln(I/I_S + 1) + I*R_S, Vt from CODATA 2019 at 298.15 K). Every
 * anchor is reproduced within 1.8 mV. Three independent Fig. 2 points of the 25 degC curve
 * at 6-22 uA agree within 5.2 mV.
 *
 * ASSUMPTIONS AND LIMITS (documented, tested):
 *  - Typical (not worst-case) part at 25 degC; no temperature dependence is modelled.
 *  - Forward validity 0.1 mA .. 100 mA (the anchor span). Above it the card is extrapolated;
 *    the rated continuous current is 300 mA.
 *  - Reverse bias: the model's saturation current (about 4.2 nA) is its reverse current. That
 *    is within the datasheet's 25 nA maximum at 20 V, but real reverse leakage comes from
 *    mechanisms this DC card does not model; it is an order-of-magnitude stand-in only.
 *  - Reverse breakdown (V_(BR) >= 100 V) is NOT modelled. V1 supplies are at most 30 V each,
 *    below the 75 V reverse-voltage rating.
 */
export const DIODE_1N4148: DiodeModel = {
  name: '1N4148',
  // Exact least-squares fit of the recorded anchors (reproduced in tests/diode.test.ts).
  saturationCurrentA: 4.210299409142904e-9,
  emissionCoefficient: 1.924181620316481,
  seriesResistanceOhm: 0.3798725839542013,
  temperatureK: T_AMBIENT_K,
  provenance:
    `Least-squares Shockley + R_S fit to ${VISHAY_1N4148_ANCHORS.source} ` +
    'Reproduced by packages/engine/tools/extract_1n4148.py. Breakdown not modelled.',
};
