/**
 * Packaged logic (Exploration Foundation L3): Texas Instruments SN74LVC08A, quadruple 2-input
 * positive-AND gate, 14-pin. The SAME gate model as the L1 single gates (logic/lvc1g.ts: input
 * rows, guaranteed output points through `outputStageAt`, static-CMOS evaluation), with the
 * package's own pin map and ONE shared supply (pins 14 V_CC and 7 GND) for all four gates.
 *
 * Source: Texas Instruments SCAS283W, "SNx4LVC08A Quadruple 2-Input Positive-AND Gates",
 * January 1993, revised July 2024 (pinned: sha256 5edd5cd664dac4f3774c9c6fc7ad8310c8f2ca3da7f0e369
 * aa69dfe2b1cc2ba4, ti.com/lit/ds/symlink/sn74lvc08a.pdf). Every figure is from the SN74LVC08A
 * −40 °C to +85 °C column (as for L1), cited per field below:
 *   §4 Table 4-1 Pin Functions; §5.1 Absolute Maximum Ratings; §5.4 Recommended Operating
 *   Conditions, SN74LVC08A; §5.7 Electrical Characteristics, SN74LVC08A; §5.9 Switching
 *   Characteristics, SN74LVC08A; §7.4 Table 7-1 Truth Table.
 *
 * Differences from the SN74LVC1G cards, each from this sheet:
 * - operating supply 1.65–3.6 V (§5.4), not 1.65–5.5 V; input rows 1.65–1.95 / 2.3–2.7 / 2.7–3.6 V;
 * - output test points at 1.65, 2.3, 2.7 and 3 V (§5.7); the ±100 µA row is V_CC − 0.2 V / 0.2 V;
 * - NO power-off leakage (I_off) specification: an unpowered device is refused, never "off";
 * - NO 3.3 V drive claim in the Features (the L1 sheets state "±24-mA output drive at 3.3 V"; this
 *   one states only "Max tpd of 4.1ns at 3.3V"), so owner decision PM-1 (the 3 V points as a
 *   bound over 3.0–3.6 V) is NOT applied: `classVcc` is absent. Between tabulated supplies only the
 *   ±100 µA row holds; a larger load is refused (`logic_output_uncharacterized`). Applying a class
 *   bound to this sheet needs its own owner decision.
 * - footnote (1) of §5.4: "All unused inputs of the device must be held at VCC or GND to ensure
 *   proper device operation." A floating input, of a used or an unused gate, is refused by name
 *   (`logic_input_floating`).
 */
import type { LogicCard } from './lvc1g.js';

/** One gate of a package: its input terminals in function order, and its output terminal. */
export interface LogicUnit {
  /** The datasheet's channel number ("Channel 1"…), language-neutral. */
  readonly unit: string;
  readonly inputs: readonly string[];
  readonly output: string;
}

export interface LogicPackageCard extends LogicCard {
  /** The gates, each with the electrical card above (one die, one shared supply). */
  readonly units: readonly LogicUnit[];
  /** Supply-current increment per input at V_CC − 0.6 V, max (A): carried, not solved. */
  readonly deltaIccA: number;
  /** Footnote (1) of the recommended operating conditions, verbatim. */
  readonly unusedInputs: string;
}

const SCAS283W =
  'Texas Instruments SCAS283W (January 1993, revised July 2024), §4 Table 4-1, §5.1 Absolute Maximum Ratings, §5.4 Recommended Operating Conditions SN74LVC08A, §5.7 Electrical Characteristics SN74LVC08A (−40 °C to +85 °C), §5.9 Switching Characteristics SN74LVC08A';

export const LVC08A_CARD: LogicPackageCard = {
  partNumber: 'SN74LVC08A',
  function: 'and',
  source: SCAS283W,
  // §4 Figure 4-1: D, DB, NS, PW (and J, W) share the 14-pin map. The breadboard part is the D
  // (SOIC-14) package on a breakout; the sheet has no through-hole (N, PDIP) package.
  pkg: 'SOIC-14 (D)',
  // Table 4-1, column "SOIC, SSOP, SOP, CDIP, TSSOP, VQFN, WQFN".
  pins: {
    a1: 1,
    b1: 2,
    y1: 3,
    a2: 4,
    b2: 5,
    y2: 6,
    gnd: 7,
    y3: 8,
    a3: 9,
    b3: 10,
    y4: 11,
    a4: 12,
    b4: 13,
    vcc: 14,
  },
  inputs: ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'],
  units: [
    { unit: '1', inputs: ['a1', 'b1'], output: 'y1' },
    { unit: '2', inputs: ['a2', 'b2'], output: 'y2' },
    { unit: '3', inputs: ['a3', 'b3'], output: 'y3' },
    { unit: '4', inputs: ['a4', 'b4'], output: 'y4' },
  ],
  // §5.4: "Operating 1.65 3.6" (data retention only from 1.5 V: not an operating condition).
  vccOperating: [1.65, 3.6],
  // §5.1: V_CC −0.5 to 6.5 V.
  vccAbsMax: 6.5,
  // §5.4 V_IH / V_IL rows.
  inputRows: [
    { vcc: [1.65, 1.95], vih: { k: 0.65 }, vil: { k: 0.35 } },
    { vcc: [2.3, 2.7], vih: { v: 1.7 }, vil: { v: 0.7 } },
    { vcc: [2.7, 3.6], vih: { v: 2.0 }, vil: { v: 0.8 } },
  ],
  // §5.7 V_OH / V_OL, −40 °C to +85 °C, at the tabulated supplies. No `classVcc` (see above).
  outputRows: [
    { vcc: 1.65, high: [{ amps: 4e-3, volts: 1.2 }], low: [{ amps: 4e-3, volts: 0.45 }] },
    { vcc: 2.3, high: [{ amps: 8e-3, volts: 1.7 }], low: [{ amps: 8e-3, volts: 0.7 }] },
    { vcc: 2.7, high: [{ amps: 12e-3, volts: 2.2 }], low: [{ amps: 12e-3, volts: 0.4 }] },
    {
      vcc: 3.0,
      high: [
        { amps: 12e-3, volts: 2.4 },
        { amps: 24e-3, volts: 2.2 },
      ],
      // The sheet tabulates V_OL at 3 V only at 24 mA.
      low: [{ amps: 24e-3, volts: 0.55 }],
    },
  ],
  // §5.7: I_OH = −100 µA → V_OH ≥ V_CC − 0.2 V; I_OL = 100 µA → V_OL ≤ 0.2 V; 1.65–3.6 V.
  rangedOutput: { vcc: [1.65, 3.6], amps: 100e-6, drop: 0.2, low: 0.2 },
  // §5.4 V_I 0–5.5 V ("Inputs accept voltages to 5.5V"); §5.1 V_I −0.5 to 6.5 V.
  inputRecommended: [0, 5.5],
  inputAbsolute: [-0.5, 6.5],
  // §5.1 V_O −0.5 to V_CC + 0.5 V.
  outputAbsAboveVcc: 0.5,
  // §5.1: I_O ±50 mA per output; continuous current through V_CC or GND ±100 mA (shared by all
  // four gates).
  outputAbsA: 50e-3,
  supplyPinAbsA: 100e-3,
  // §5.7: I_I ±5 µA (V_I = 5.5 V or GND, 3.6 V); I_CC 10 µA (V_I = V_CC or GND, I_O = 0, 3.6 V);
  // ΔI_CC 500 µA (one input at V_CC − 0.6 V). No I_off row.
  inputLeakageA: 5e-6,
  iccMaxA: 10e-6,
  deltaIccA: 500e-6,
  // §5.7: C_i 5 pF typical (V_I = V_CC or GND, 3.3 V, T_A = 25 °C). Carried, not used at DC.
  ciF: 5e-12,
  // §5.9: t_pd A or B → Y, 3.3 V ± 0.3 V, −40 °C to +85 °C: 1–4.1 ns. Not simulated.
  tpd33: [1e-9, 4.1e-9],
  unusedInputs:
    'All unused inputs of the device must be held at VCC or GND to ensure proper device operation.',
};

/** Packaged device cards by model id. */
export const LOGIC_PACKAGE_CARDS: Readonly<Record<string, LogicPackageCard>> = {
  'model.logic.sn74lvc08a': LVC08A_CARD,
};
