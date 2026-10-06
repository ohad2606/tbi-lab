/**
 * ESP32-DevKitC V4 board layout (Sprint 10 realism pass): where each visible part sits on the PCB,
 * in the board frame (mm; x across towards J3, z along towards the USB end; physical.ts).
 *
 * One table drives both the asset's geometry (esp32DevkitC.author.ts) and the PCB surface texture
 * drawn at runtime (esp32Textures.ts: pads, silkscreen outlines, traces), so a part and its
 * footprint can never drift apart.
 *
 * Sources:
 *   [ESP-DIM]  Espressif ESP32-DevKitC V4 dimension drawing: board 27.94 x 48.26 mm, header rows
 *              25.40 mm apart, pin 1 1.30 mm from the antenna-end edge, last pin 1.29 mm from the
 *              USB-end edge, module overhang 6.04 mm, module 18.00 mm wide.
 *   [ESP-UG]   Espressif ESP32-DevKitC V4 user guide, "functional overview" board photograph
 *              (docs.espressif.com, esp-dev-kits, fetched 2026-10-06; reference only, not shipped):
 *              part positions measured on the photo, scaled by the header pitch (14.65 px/mm).
 *   [PKG]      JEDEC/EIA package outlines for the part classes (QFN-28 5x5, SOT-223, SOT-23,
 *              SOD-523, 0402/0603/0805 chips, micro-USB B receptacle, 4 x 3 mm SMD tact switch).
 * Positions are measured to about +-0.3 mm; sizes are the package nominal.
 */

export type ChipKind = 'r0402' | 'c0402' | 'r0603' | 'c0603' | 'c0805' | 'led0603' | 'sod523';

export interface Chip {
  kind: ChipKind;
  x: number;
  z: number;
  /** Long axis along z (true) or along x (false). */
  alongZ: boolean;
}

/** Chip packages: length, width, body height (mm) [PKG]. */
export const CHIP_SIZE: Record<ChipKind, [number, number, number]> = {
  r0402: [1.0, 0.5, 0.35],
  c0402: [1.0, 0.5, 0.5],
  r0603: [1.6, 0.8, 0.45],
  c0603: [1.6, 0.8, 0.8],
  c0805: [2.0, 1.25, 0.9],
  led0603: [1.6, 0.8, 0.6],
  sod523: [1.2, 0.8, 0.6],
};

/** The small parts [ESP-UG] (positions) [PKG] (sizes). */
export const CHIPS: Chip[] = [
  // Power LED and its series resistor, beside the EN button.
  { kind: 'led0603', x: -7.9, z: 11.05, alongZ: true },
  { kind: 'r0402', x: -7.9, z: 13.95, alongZ: true },
  // Regulator input/output capacitors and the resistor beside them (row by the J2 header).
  { kind: 'c0402', x: -7.9, z: 7.47, alongZ: false },
  { kind: 'r0402', x: -7.9, z: 6.45, alongZ: false },
  { kind: 'c0402', x: -7.9, z: 5.42, alongZ: false },
  { kind: 'c0805', x: -5.59, z: 6.62, alongZ: true },
  { kind: 'c0805', x: -7.9, z: 3.03, alongZ: true },
  { kind: 'c0805', x: -5.59, z: 3.03, alongZ: true },
  // The CP2102N's support parts, in a row above it.
  { kind: 'r0402', x: -5.18, z: 14.12, alongZ: false },
  { kind: 'r0402', x: -5.18, z: 12.93, alongZ: false },
  { kind: 'r0402', x: -5.18, z: 11.73, alongZ: false },
  { kind: 'c0402', x: -5.18, z: 10.37, alongZ: false },
  { kind: 'c0402', x: -5.18, z: 9.27, alongZ: false },
  // By the USB connector: a capacitor, a protection diode, and three ESD diodes on the data lines.
  { kind: 'c0603', x: -5.29, z: 17.54, alongZ: true },
  { kind: 'sod523', x: -5.39, z: 15.84, alongZ: false },
  { kind: 'sod523', x: -1.6, z: 16.0, alongZ: true },
  { kind: 'sod523', x: -0.24, z: 16.0, alongZ: true },
  { kind: 'sod523', x: 0.98, z: 16.0, alongZ: true },
  // The auto-reset transistors' base resistors, near BOOT.
  { kind: 'r0402', x: 4.18, z: 14.46, alongZ: false },
  { kind: 'r0402', x: 4.18, z: 13.61, alongZ: false },
  { kind: 'r0402', x: 4.42, z: 10.43, alongZ: false },
  { kind: 'r0402', x: 4.42, z: 9.58, alongZ: false },
  { kind: 'c0402', x: 5.27, z: 18.38, alongZ: false },
  { kind: 'c0402', x: 5.27, z: 17.36, alongZ: false },
];

/** Integrated parts and connectors [ESP-UG] [PKG]. */
export const LAYOUT = {
  /** EN (reset) and BOOT SMD tact switches: centre, body 2.9 (x) x 3.9 (z) x 1.5 mm. */
  en: { x: -8.07, z: 20.27 },
  boot: { x: 8.1, z: 20.27 },
  switchBody: { x: 2.9, z: 3.9, h: 1.5 },
  /** Micro-USB B receptacle: centre x, front face z (overhangs the edge), 7.5 x 2.6 shell. */
  usb: { x: -0.16, front: 25.56, width: 7.5, height: 2.6, depth: 5.6 },
  /** CP2102N USB-UART bridge, QFN-28 5 x 5 x 0.9. */
  bridge: { x: 0.1, z: 11.9, size: 5.0, h: 0.9 },
  /** 3.3 V regulator, SOT-223: body 3.5 (x) x 6.5 (z) x 1.6, leads to -x, tab to +x. */
  regulator: { x: 0.0, z: 5.08 },
  /** Auto-reset transistors, SOT-23 (two leads towards -z, one towards +z). */
  transistors: [
    { x: 7.59, z: 12.42 },
    { x: 7.25, z: 4.91 },
  ],
  /** Exposed ENIG test/ground pads beside the module (1.0 x 2.0 mm), z centres and x. */
  goldPads: { z: [-0.04, -1.24, -2.43, -3.63], x: [-8.41, 8.61], w: 1.0, l: 2.0 },
  /** Silkscreen outline around the module footprint. */
  moduleOutline: { x0: -9.94, x1: 10.14, z0: 0.98 },
  /** Silkscreen: button names. */
  enLabel: { x: -7.9, z: 16.68 },
  bootLabel: { x: 7.59, z: 16.0 },
  /** Pin labels: the text centre's distance from the board centre line (inside the pin rows). */
  pinLabelX: 11.0,
  pinLabelHeight: 0.95,
} as const;

/** The silkscreen name of a header pin, as printed on the board: "IO" dropped ([ESP-UG]). */
export function silkLabel(headerLabel: string): string {
  return headerLabel.startsWith('IO') ? headerLabel.slice(2) : headerLabel;
}

/**
 * The marking atlas: one runtime-drawn texture holding every printed/etched marking on the board's
 * parts (the RF can's laser marking, the bridge, regulator and transistor top marks), each part's
 * marking quad mapped to its region. Regions in px of a square atlas, about 40 px per mm.
 */
export const MARK_ATLAS = {
  size: 1024,
  /** [x, y, w, h] px; canvas x = part +x, canvas y = part +z (see the quads in the asset). */
  regions: {
    can: [0, 0, 640, 700],
    bridge: [660, 0, 200, 200],
    regulator: [660, 220, 260, 140],
    sot1: [660, 380, 116, 52],
    sot2: [660, 450, 116, 52],
  } as Record<'can' | 'bridge' | 'regulator' | 'sot1' | 'sot2', [number, number, number, number]>,
};
