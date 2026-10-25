/**
 * Sprint 22 (P2): the provenance of every numerical bound the logic guarantee checks use
 * (logic/bounds.ts, logic/lvc1g.ts, logic/lvc08a.ts, the ESP32 pad figures in esp32Gpio.ts).
 *
 * Every row names the manufacturer document actually read (pinned with its SHA-256 in the sprint
 * evidence, `~/tbi-s22/logic/datasheets/SOURCES.txt`, downloaded from ti.com / espressif.com), the
 * exact table and row with its test conditions, the voltage / temperature / load range the figure
 * applies to, and its KIND: a guaranteed limit, a typical value, an absolute-maximum stress rating,
 * or a value derived from other rows (with the derivation). A test
 * (packages/engine/tests/logic-provenance.test.ts) requires a row for every bound the cards carry,
 * with the same value.
 */

export type BoundKind =
  | 'guaranteed-max'
  | 'guaranteed-min'
  | 'guaranteed-range'
  | 'typical'
  | 'absolute-max'
  | 'derived'
  /** A recommended operating condition (§5.3): the range in which the part is specified to
   *  operate, not a measured limit (Sprint 22 review). */
  | 'recommended'
  /** The condition a table's figures are measured at (e.g. "3.3 V, 25 °C"). */
  | 'test-condition'
  /** An engineering assumption of the engine, NOT a datasheet figure (owner decision S22-F3). */
  | 'assumption';

export interface ProvenanceRow {
  /** `<part>.<field>` (cards) or `ESP32.<constant>`. */
  id: string;
  value: number | string | readonly (number | string)[];
  unit: string;
  manufacturer: 'Texas Instruments' | 'Espressif Systems' | 'TBI LAB engine';
  /** Exact part / variant the figure is stated for. */
  part: string;
  /** Document number and revision. */
  document: string;
  /** Table / section, row, and the row's test conditions, as printed. */
  where: string;
  /** Supply, temperature and load range the figure applies to. */
  applies: string;
  kind: BoundKind;
  /** How the engine uses it (and, for `derived`, the derivation). */
  use: string;
}

const TI_1G = {
  SN74LVC1G08: 'SCES217AA (April 1999, revised August 2026)',
  SN74LVC1G00: 'SCES212AC (revised August 2026)',
  SN74LVC1G32: 'SCES219W (revised August 2026)',
  SN74LVC1G04: 'SCES214AF (revised October 2025)',
} as const;
const TA = '−40 °C to 85 °C column (SN74LVC1G…, T_A −40 to 85 °C)';

/** The rows the four SN74LVC1G sheets share (identical in each; checked per sheet in Sprint 20). */
function lvc1gRows(part: keyof typeof TI_1G): ProvenanceRow[] {
  const doc = TI_1G[part];
  const r = (
    field: string,
    value: number | string | readonly (number | string)[],
    unit: string,
    where: string,
    applies: string,
    kind: BoundKind,
    use: string,
  ): ProvenanceRow => ({
    id: `${part}.${field}`,
    value,
    unit,
    manufacturer: 'Texas Instruments',
    part,
    document: doc,
    where,
    applies,
    kind,
    use,
  });
  return [
    r(
      'vccOperating',
      [1.65, 5.5],
      'V',
      '§5.3 V_CC "Operating" min/max',
      TA,
      'recommended',
      'supply rows',
    ),
    r(
      'inputLeakageA',
      5e-6,
      'A',
      '§5.5 I_I, "V_I = 5.5V or GND", V_CC "0 to 5.5V", ±5 µA',
      `${TA}; tested at V_I = 5.5 V or GND (applied 0–5.5 V per §7.3.3 worst-case input resistance and §8.2.1.2 pull-resistor sizing)`,
      'guaranteed-max',
      'ii perturbation ±I_I',
    ),
    r(
      'iiVcc',
      [0, 5.5],
      'V',
      '§5.5 I_I row, V_CC column "0 to 5.5V"',
      TA,
      'test-condition',
      'where the I_I bound holds',
    ),
    r(
      'ioffA',
      10e-6,
      'A',
      '§5.5 I_off, "V_I or V_O = 5.5V", V_CC = 0, ±10 µA',
      `${TA}; tested at 5.5 V (applied at every pin voltage: owner question Q4)`,
      'guaranteed-max',
      'ioff perturbation of an unpowered gate',
    ),
    r(
      'iccMaxA',
      10e-6,
      'A',
      '§5.5 I_CC, "V_I = 5.5V or GND, I_O = 0", 10 µA',
      `${TA}; V_CC 1.65–5.5 V; ONLY with every input at 5.5 V or GND`,
      'guaranteed-max',
      'icc perturbation where its condition holds',
    ),
    r(
      'iccLoaded',
      'I_CC + I_O',
      'A',
      '§8.2.1.1 Power Considerations: "The positive voltage supply must be capable of sourcing current equal to the total current to be sourced by all outputs of the SN74LVC1G08 plus the maximum static supply current, ICC, listed in the Electrical Characteristics, and any transient current required for switching." (the same sentence in the 1G00/1G04/1G32 sheets, each naming its own part)',
      `${TA}; ONLY with every input at the I_CC test voltages (5.5 V or GND)`,
      'derived',
      'owner decision S22-F4: a LOADED output keeps the I_CC bound (I_O is in the solve); never a bound for inputs off the test voltages (S22-Q1)',
    ),
    r(
      'iccVcc',
      [1.65, 5.5],
      'V',
      '§5.5 I_CC row, V_CC column "1.65V to 5.5V"',
      TA,
      'test-condition',
      'I_CC supply condition',
    ),
    r(
      'iccInputHigh',
      5.5,
      'V',
      '§5.5 I_CC test condition "V_I = 5.5V or GND"',
      TA,
      'test-condition',
      'I_CC input condition',
    ),
    r(
      'deltaIccA',
      500e-6,
      'A',
      '§5.5 ΔI_CC, "One input at V_CC − 0.6V, Other inputs at V_CC or GND", 500 µA',
      `${TA}; V_CC 3–5.5 V; that input condition only`,
      'guaranteed-max',
      'reported only (not a bound at other input voltages: Q1)',
    ),
    r(
      'deltaIccVcc',
      [3.0, 5.5],
      'V',
      '§5.5 ΔI_CC row, V_CC "3V to 5.5V"',
      TA,
      'test-condition',
      'ΔI_CC supply condition',
    ),
    r(
      'inputRows',
      [1.65, 1.95, 0.65, 0.35, 2.3, 2.7, 1.7, 0.7, 3.0, 3.6, 2.0, 0.8, 4.5, 5.5, 0.7, 0.3],
      'V | ×V_CC',
      '§5.3 V_IH min / V_IL max per V_CC row (0.65/0.35 × V_CC; 1.7/0.7 V; 2/0.8 V; 0.7/0.3 × V_CC)',
      TA,
      'guaranteed-range',
      'input level thresholds; gaps between rows refused',
    ),
    r(
      'outputRows',
      [
        1.65, 4e-3, 1.2, 4e-3, 0.45, 2.3, 8e-3, 1.9, 8e-3, 0.3, 3.0, 16e-3, 2.4, 24e-3, 2.3, 16e-3,
        0.4, 24e-3, 0.55, 4.5, 32e-3, 3.8, 32e-3, 0.55,
      ],
      'V, A',
      '§5.5 V_OH min at I_OH / V_OL max at I_OL: 1.65 V −4/4 mA; 2.3 V −8/8 mA; 3 V −16/16, −24/24 mA; 4.5 V −32/32 mA',
      `${TA}; at exactly that V_CC (3 V points also over 3.0–3.6 V: owner decision PM-1)`,
      'guaranteed-min',
      'output characteristic test points and guarantee bands',
    ),
    r(
      'rangedOutput',
      [1.65, 5.5, 100e-6, 0.1, 0.1],
      'V, A',
      '§5.5 V_OH ≥ V_CC − 0.1 V at I_OH = −100 µA; V_OL ≤ 0.1 V at I_OL = 100 µA; V_CC 1.65–5.5 V',
      TA,
      'guaranteed-min',
      'light-load guarantee at every supply',
    ),
    r(
      'inputRecommended',
      [0, 5.5],
      'V',
      '§5.3 V_I min/max',
      TA,
      'recommended',
      'recommended input range (refused outside)',
    ),
    r(
      'outputRail',
      [0, 'V_CC'],
      'V',
      '§5.3 Recommended Operating Conditions V_O 0 to V_CC (a recommended condition, not a measured limit); §8.2.1.3 "The positive supply voltage is used to produce the output HIGH voltage … The ground voltage is used to produce the output LOW voltage"',
      TA,
      'recommended',
      'the stronger side of an output: Y at most at its own rail (Q5)',
    ),
  ];
}

/** Engine tolerances: engineering assumptions, not datasheet figures (owner decision S22-F3). */
const ENGINE_ROWS: ProvenanceRow[] = [
  [
    'RAIL_V',
    1e-3,
    'V',
    'an input counts as "at" an I_CC test voltage (5.5 V, V_CC or GND) within ±1 mV; also the 0–5.5 V input-range check tolerance',
    'assumption',
    'I_CC condition (logic/lvc1g.ts quiescentAt, bounds.ts icc-input checks); shown to users as "engine tolerance 1 mV"',
  ],
  [
    'UNPOWERED_V',
    1e-3,
    'V',
    '|V_CC − GND| ≤ 1 mV is treated as unpowered (V_CC = 0, the I_off row)',
    'assumption',
    'parts/logicGate.ts, parts/logicPackage.ts: unpowered gates (outputs off, I_off)',
  ],
  [
    'PSU_SINK_RESOLUTION_A',
    1e-9,
    'A',
    'a constant-voltage bench supply delivering less than −1 nA in the solve counts as sinking (psu_sinking); numerical resolution of the solved current, not a physical property of a supply',
    'assumption',
    'session.ts no-sinking rule (the bench-supply model cannot sink, devices.ts)',
  ],
  [
    'BOUNDS_CURRENT_RESOLUTION_A',
    1e-12,
    'A',
    'in the guarantee bounds a supply must deliver ≥ −1 pA (no sinking) and an SN74LVC08A output carry ≤ 1 pA (I_CC test condition I_O = 0) at every corner; also the current resolution of every bounds check (bounds.ts EPS.A)',
    'assumption',
    'bounds.ts psu-sink and icc-load checks, relevance threshold',
  ],
  [
    'WRONG_WAY_V',
    1e-3,
    'V',
    'an output driven more than 1 mV past its own rail (above V_CC while HIGH, below GND while LOW) counts as forced the wrong way (no characteristic: refused, its overdrive reported)',
    'assumption',
    'parts/logicGate.ts, parts/logicPackage.ts',
  ],
  [
    'ICC_READING',
    0,
    'A',
    'I_CC is read as a current INTO the V_CC pin, 0 … I_CC max (never negative); each input’s I_I is counted separately, returning through the GND or the V_CC pin (either sign). If I_CC as measured already contains the inputs’ leakage, that leakage is counted twice: a deliberate over-count that fails closed (review 3)',
    'assumption',
    'bounds.ts icc and ii/iiv perturbations',
  ],
  [
    'TABULATED_VCC_TOLERANCE_V',
    1e-6,
    'V',
    'a supply within ±1 µV of a tabulated V_CC (e.g. 3.0 V, 3.6 V) counts as that row',
    'assumption',
    'row selection (lvc1g.ts); numerical resolution of a setpoint, not a physical tolerance',
  ],
].map(([name, value, unit, where, kind, use]) => ({
  id: `ENGINE.${name as string}`,
  value: value as number,
  unit: unit as string,
  manufacturer: 'TBI LAB engine' as const,
  part: 'logic guarantee checks (all logic parts)',
  document: 'TBI LAB engine (packages/engine/src/logic), Sprint 22 owner decision F3',
  where: where as string,
  applies: 'every logic part, every supply',
  kind: kind as BoundKind,
  use: use as string,
}));

export const LOGIC_PROVENANCE: readonly ProvenanceRow[] = [
  ...ENGINE_ROWS,
  ...(['SN74LVC1G08', 'SN74LVC1G00', 'SN74LVC1G32', 'SN74LVC1G04'] as const).flatMap(lvc1gRows),
  // SN74LVC08A, SCAS283W (January 1993, revised July 2024), SN74LVC08A −40 to +85 °C column.
  ...((): ProvenanceRow[] => {
    const r = (
      field: string,
      value: number | string | readonly (number | string)[],
      unit: string,
      where: string,
      applies: string,
      kind: BoundKind,
      use: string,
    ): ProvenanceRow => ({
      id: `SN74LVC08A.${field}`,
      value,
      unit,
      manufacturer: 'Texas Instruments',
      part: 'SN74LVC08A',
      document: 'SCAS283W (January 1993, revised July 2024)',
      where,
      applies,
      kind,
      use,
    });
    const A = 'SN74LVC08A, T_A −40 °C to +85 °C';
    return [
      r(
        'vccOperating',
        [1.65, 3.6],
        'V',
        '§5.4 V_CC "Operating" 1.65–3.6 V',
        A,
        'recommended',
        'supply rows',
      ),
      r(
        'inputLeakageA',
        5e-6,
        'A',
        '§5.7 I_I, "V_I = 5.5 V or GND", V_CC 3.6V, ±5 µA',
        `${A}; ONLY at V_CC = 3.6 V (Q2)`,
        'guaranteed-max',
        'ii perturbation at 3.6 V only',
      ),
      r(
        'iiVcc',
        [3.6, 3.6],
        'V',
        '§5.7 I_I row, V_CC column "3.6V"',
        A,
        'test-condition',
        'where the I_I bound holds',
      ),
      r(
        'iccMaxA',
        10e-6,
        'A',
        '§5.7 I_CC, "V_I = V_CC or GND, I_O = 0", 3.6V, 10 µA',
        `${A}; ONLY at V_CC = 3.6 V with inputs at V_CC or GND`,
        'guaranteed-max',
        'icc perturbation where its condition holds',
      ),
      r(
        'iccLoaded',
        'I_O = 0 only',
        'A',
        '§5.7 I_CC test condition "V_I = V_CC or GND, I_O = 0" — SCAS283W contains no power-considerations rule for a loaded output (unlike the 1G §8.2.1.1)',
        `${A}; at V_CC = 3.6 V`,
        'test-condition',
        'Sprint 22 review 3: a loaded output (or a downstream input leakage) leaves the I_CC test condition → refused by name; owner question Q9 (may the 1G §8.2.1.1 I_CC + I_O rule be applied to the 08A?)',
      ),
      r(
        'iccVcc',
        [3.6, 3.6],
        'V',
        '§5.7 I_CC row, V_CC "3.6V"',
        A,
        'test-condition',
        'I_CC supply condition',
      ),
      r(
        'iccInputHigh',
        'V_CC',
        'V',
        '§5.7 I_CC test condition "V_I = V_CC or GND"',
        A,
        'test-condition',
        'I_CC input condition',
      ),
      r(
        'deltaIccA',
        500e-6,
        'A',
        '§5.7 ΔI_CC, "One input at V_CC − 0.6 V, Other inputs at V_CC or GND", 500 µA',
        `${A}; V_CC 2.7–3.6 V`,
        'guaranteed-max',
        'reported only',
      ),
      r(
        'deltaIccVcc',
        [2.7, 3.6],
        'V',
        '§5.7 ΔI_CC row, V_CC "2.7V to 3.6V"',
        A,
        'test-condition',
        'ΔI_CC supply condition',
      ),
      r(
        'inputRows',
        [1.65, 1.95, 0.65, 0.35, 2.3, 2.7, 1.7, 0.7, 2.7, 3.6, 2.0, 0.8],
        'V | ×V_CC',
        '§5.4 V_IH min / V_IL max per V_CC row',
        A,
        'guaranteed-range',
        'input level thresholds',
      ),
      r(
        'outputRows',
        [
          1.65, 4e-3, 1.2, 4e-3, 0.45, 2.3, 8e-3, 1.7, 8e-3, 0.7, 2.7, 12e-3, 2.2, 12e-3, 0.4, 3.0,
          12e-3, 2.4, 24e-3, 2.2, 24e-3, 0.55,
        ],
        'V, A',
        '§5.7 V_OH min / V_OL max: 1.65 V 4 mA; 2.3 V 8 mA; 2.7 V 12 mA; 3 V 12 mA (V_OH), 24 mA',
        `${A}; at exactly that V_CC (no PM-1 class: Q6)`,
        'guaranteed-min',
        'output test points',
      ),
      r(
        'rangedOutput',
        [1.65, 3.6, 100e-6, 0.2, 0.2],
        'V, A',
        '§5.7 V_OH ≥ V_CC − 0.2 V at −100 µA; V_OL ≤ 0.2 V at 100 µA; 1.65–3.6 V',
        A,
        'guaranteed-min',
        'light-load guarantee',
      ),
      r(
        'inputRecommended',
        [0, 5.5],
        'V',
        '§5.4 V_I 0–5.5 V',
        A,
        'recommended',
        'recommended input range',
      ),
      r(
        'outputRail',
        [0, 'V_CC'],
        'V',
        '§5.4 Recommended Operating Conditions V_O 0 to V_CC (a recommended condition)',
        A,
        'recommended',
        'the stronger side of an output (Q5)',
      ),
    ];
  })(),
  // ESP32 pads (the DevKitC carries an ESP32-WROOM-32E module: Espressif board user guide).
  ...((): ProvenanceRow[] => {
    const e = (
      id: string,
      value: number,
      unit: string,
      where: string,
      kind: BoundKind,
      use: string,
    ): ProvenanceRow => ({
      id: `ESP32.${id}`,
      value,
      unit,
      manufacturer: 'Espressif Systems',
      part: 'ESP32 (ESP32-D0WD-V3 in ESP32-WROOM-32E)',
      document:
        'ESP32 Series Datasheet v5.3, Table 5-3; same rows in ESP32-WROOM-32E/32UE Datasheet v2.1 Table 15 and ESP32-WROOM-32 v3.8 Table 14',
      where,
      applies:
        'VDD = 3.3 V, 25 °C only ("DC Characteristics (3.3 V, 25 °C)"); module VDD33 3.0–3.6 V operating (WROOM-32E Table 14) — the engine pins VDD = 3.3 V',
      kind,
      use,
    });
    return [
      e(
        'VDD_V',
        3.3,
        'V',
        'Table 5-3 title condition "DC Characteristics (3.3 V, 25 °C)" — the condition the figures are measured at',
        'test-condition',
        'pad supply in the approved pad model (every ESP32 figure valid at VDD = 3.3 V, 25 °C only)',
      ),
      e(
        'V_IH_FRACTION',
        0.75,
        '×VDD',
        'Table 5-3 V_IH min 0.75 × VDD',
        'guaranteed-min',
        'an input pad reads HIGH only above it',
      ),
      e(
        'V_IL_FRACTION',
        0.25,
        '×VDD',
        'Table 5-3 V_IL max 0.25 × VDD',
        'guaranteed-max',
        'an input pad reads LOW only below it',
      ),
      e(
        'V_OH_FRACTION',
        0.8,
        '×VDD',
        'Table 5-3 V_OH min 0.8 × VDD — NO test current stated',
        'guaranteed-min',
        'pad HIGH band; relied on only at leakage-level pad current (Q7)',
      ),
      e(
        'V_OL_FRACTION',
        0.1,
        '×VDD',
        'Table 5-3 V_OL max 0.1 × VDD — NO test current stated',
        'guaranteed-max',
        'pad LOW band; relied on only at leakage-level pad current (Q7)',
      ),
      e(
        'INPUT_LEAKAGE_A',
        50e-9,
        'A',
        'Table 5-3 I_IH / I_IL max 50 nA',
        'guaranteed-max',
        'padleak perturbation',
      ),
      e(
        'I_OH_A',
        0.04,
        'A',
        'Table 5-3 I_OH "VDD = 3.3 V, V_OH >= 2.64 V, output drive strength set to the maximum" TYP 40 mA (VDD3P3_CPU/RTC); 20 mA VDD_SDIO',
        'typical',
        'drive model only (R_DRIVE_HIGH = 0.66 V / 40 mA, approved V1 pad model) — never a guarantee',
      ),
      e(
        'I_OL_A',
        0.028,
        'A',
        'Table 5-3 I_OL "VDD = 3.3 V, V_OL = 0.495 V, maximum drive" TYP 28 mA',
        'typical',
        'drive model only (R_DRIVE_LOW = 0.495 V / 28 mA) — never a guarantee',
      ),
      e(
        'R_PULL_OHM',
        45_000,
        'Ω',
        'Table 5-3 R_PU / R_PD TYP 45 kΩ (no min, no max)',
        'typical',
        'not a bound: a level held by an internal pull is refused',
      ),
    ];
  })(),
];
