/**
 * Physical metadata of the 3D models (Sprint 10): real dimensions, in millimetres, and the ONE
 * world-scale convention. The renderer and the scene description read sizes only from here.
 *
 * World scale:
 *   1 scene unit = 1 mm.
 *   One 2D grid step (20 layout units) = 3.175 mm (1/8 in): MM_PER_LAYOUT_UNIT = 0.15875.
 * Why this step: the ESP32 symbol's two pin columns (160 layout units apart) then sit EXACTLY on
 * the real DevKitC header rows, 25.40 mm apart [ESP-DIM], and the symbol's outline contains the
 * real board (PCB plus module overhang). Parts placed beside the board in 2D stand beside it in
 * 3D instead of under it, which the earlier 2.54 mm step could not guarantee (the real board is
 * 7.6 mm wider than its 2D pin columns at that scale). Two-terminal parts' terminals (80 units)
 * are 12.7 mm (0.5 in) apart, a standard axial lead spacing. The one place 2D and the part
 * differ is along the ESP32 header: its real pin pitch is 2.54 mm, the grid 3.175 mm, so each
 * pin's 3D attach point is the real pin and the wire's 3D end follows it (scene.ts).
 *
 * Rule (unchanged since Sprint 9): the 2D Circuit layout gives each part's POSITION and rotation;
 * this file gives its SIZE and shape. Nothing here is stored in a project.
 *
 * Sources (each value below says which one applies):
 *   [V83012]   Vishay TLHR540./TLHY540. datasheet, doc. 83012 rev. 2.7, package dimensions (5 mm LED).
 *   [V83009]   Vishay TLHR4900/TLHG4900 datasheet, doc. 83009 rev. 2.7, package dimensions (3 mm LED).
 *   [V81857]   Vishay 1N4148 datasheet, doc. 81857 rev. 1.6, DO-35 package dimensions.
 *   [ESP-DIM]  Espressif ESP32-DevKitC V4 dimensions drawing (esp32_devkitc_v4_dimensions.pdf/.dxf).
 *   [WROOM]    ESP32-WROOM-32 module outline, 18.0 x 25.5 x 3.1 mm (Espressif module datasheet).
 *   [REP]      Representative dimensions of the common part class (no single datasheet; within
 *              the usual range for that package). Stated as such, never presented as exact.
 */

export const MM_PER_LAYOUT_UNIT = 3.175 / 20;

/** Layout units (2D) to millimetres (3D). */
export const toMm = (layoutUnits: number) => layoutUnits * MM_PER_LAYOUT_UNIT;

/** Axial two-lead body (resistor, diode), lying horizontally, leads bent down to the bench. */
export interface AxialPhysics {
  kind: 'axial';
  bodyLengthMm: number;
  bodyDiameterMm: number;
  leadDiameterMm: number;
  /** Gap between the bench and the bottom of the body. */
  standoffMm: number;
}

export interface LedPhysics {
  kind: 'led';
  /** Lens/body cylinder diameter. */
  bodyDiameterMm: number;
  flangeDiameterMm: number;
  flangeThicknessMm: number;
  /** Seating plane (flange bottom) to the top of the dome. */
  heightMm: number;
  domeRadiusMm: number;
  /** Lead pitch at the body. */
  leadPitchMm: number;
  /** Square lead cross-section. */
  leadSizeMm: number;
  /** Height of the seating plane above the bench (leads stand it off). */
  standoffMm: number;
}

/** Package geometry of each LED model card (the card decides the physical part). */
export const LED_PACKAGES = {
  /** T-1 3/4, 5 mm tinted diffused [V83012]. */
  t1_34: {
    kind: 'led',
    bodyDiameterMm: 5.0,
    flangeDiameterMm: 5.8,
    flangeThicknessMm: 1.1,
    heightMm: 8.7,
    domeRadiusMm: 2.49,
    leadPitchMm: 2.54,
    leadSizeMm: 0.5,
    standoffMm: 3.0,
  },
  /** T-1, 3 mm clear [V83009]; flange thickness [REP]. */
  t1: {
    kind: 'led',
    bodyDiameterMm: 2.9,
    flangeDiameterMm: 3.2,
    flangeThicknessMm: 0.9,
    heightMm: 4.4,
    domeRadiusMm: 1.4,
    leadPitchMm: 2.54,
    leadSizeMm: 0.5,
    standoffMm: 3.0,
  },
} as const satisfies Record<string, LedPhysics>;

/** 1/4 W carbon-film resistor [REP]: body 6.3 x 2.4 mm, leads 0.55 mm. */
export const RESISTOR: AxialPhysics = {
  kind: 'axial',
  bodyLengthMm: 6.3,
  bodyDiameterMm: 2.4,
  leadDiameterMm: 0.55,
  standoffMm: 1.0,
};

/** DO-35 glass diode [V81857]: body 3.4 mm max, diameter 1.5-1.75 mm, leads 0.55 mm max. */
export const DIODE_DO35: AxialPhysics = {
  kind: 'axial',
  bodyLengthMm: 3.4,
  bodyDiameterMm: 1.75,
  leadDiameterMm: 0.5,
  standoffMm: 1.0,
};

/** 6 x 6 mm through-hole tactile switch [REP]. */
export const TACTILE = {
  bodyMm: 6.0,
  bodyHeightMm: 3.5,
  actuatorDiameterMm: 3.5,
  actuatorHeightMm: 1.5,
  legPitchXMm: 6.5,
  legPitchZMm: 4.5,
  legWidthMm: 0.7,
  standoffMm: 0.5,
};

/** Sub-miniature SPST toggle switch [REP]. */
export const TOGGLE = {
  bodyXMm: 8.0,
  bodyZMm: 6.0,
  bodyHeightMm: 6.0,
  bushingDiameterMm: 5.0,
  bushingHeightMm: 3.5,
  leverLengthMm: 8.0,
  leverDiameterMm: 1.6,
  standoffMm: 1.0,
};

/**
 * Ground: a small black binding post standing just behind its terminal, with a tinned lug out to
 * the terminal point where the wire is soldered [REP].
 */
export const GROUND_POST = {
  plateMm: 4.4,
  plateThicknessMm: 0.5,
  postDiameterMm: 3.0,
  postHeightMm: 4.6,
  /** Post centre behind the terminal (2D: the symbol body is below its terminal). */
  postOffsetZMm: 3.4,
  /** The lug's ring at the terminal. */
  attachHeightMm: 0.9,
};

/**
 * Bench supply, drawn at REDUCED, SYMBOLIC scale: a real bench supply (~300 mm) cannot stand in a
 * circuit placed on the 2D grid. Its binding posts (4 mm, red/black) are at the 2D terminals.
 */
export const PSU = {
  bodyXMm: 10.4,
  bodyHeightMm: 11.0,
  bodyZMm: 12.6,
  /** Front panel plane, relative to the part origin (the posts' 2D terminals sit just in front). */
  frontXMm: 3.9,
  postDiameterMm: 2.2,
  postLengthMm: 2.0,
  attachHeightMm: 4.2,
};

/**
 * ESP32-DevKitC V4 [ESP-DIM]. The board's origin is its centre (the 2D symbol's origin). Its long
 * axis runs along the 2D y axis (scene z), header J2 on -x, J3 on +x, pin 1 (3V3 / GND) at -z, the
 * USB connector at +z.
 */
export const ESP32_DEVKITC = {
  pcbWidthMm: 27.94,
  /** Header span 48.26 + 1.30 + 1.29 to the board edges [ESP-DIM]. */
  pcbLengthMm: 48.26 + 1.3 + 1.29,
  pcbThicknessMm: 1.6,
  /** Centre z of the PCB (the header is centred on the origin; the edges are 1.30 / 1.29). */
  pcbCentreZMm: (1.29 - 1.3) / 2,
  headerRowSpacingMm: 25.4,
  pinPitchMm: 2.54,
  headerSpanMm: 48.26,
  headerPins: 19,
  /** Male header: plastic body, pins down (as on a breadboard), short stubs above the PCB [REP]. */
  headerPlasticHeightMm: 2.5,
  pinSizeMm: 0.64,
  pinBelowPlasticMm: 6.0,
  pinStubAboveMm: 1.5,
  /** Module [WROOM]; it overhangs the top PCB edge by 6.04 mm [ESP-DIM]. */
  moduleWidthMm: 18.0,
  moduleLengthMm: 25.5,
  moduleThicknessMm: 0.8,
  moduleOverhangMm: 6.04,
  shieldWidthMm: 16.0,
  shieldLengthMm: 17.5,
  shieldHeightMm: 2.3,
  /** Jumper (Dupont) housing over a connected pin; the wire leaves its top [REP]. */
  dupontSizeMm: 2.5,
  dupontHeightMm: 6.0,
} as const;

/** Bench height of the ESP32 PCB's bottom face: it stands on its header pins. */
export const ESP32_PCB_BOTTOM =
  ESP32_DEVKITC.pinBelowPlasticMm + ESP32_DEVKITC.headerPlasticHeightMm;
export const ESP32_PCB_TOP = ESP32_PCB_BOTTOM + ESP32_DEVKITC.pcbThicknessMm;
/** Top of a header pin's stub above the PCB. */
export const ESP32_PIN_TOP = ESP32_PCB_TOP + ESP32_DEVKITC.pinStubAboveMm;
/** Where a wire meets a connected header pin: the top of its jumper housing. */
export const ESP32_ATTACH_HEIGHT = ESP32_PCB_TOP + 0.3 + ESP32_DEVKITC.dupontHeightMm;

/** Where a lead's end meets the bench: wires clip onto it just above the bench. */
export const LEAD_ATTACH_HEIGHT = 0.5;

/** Hookup wire (insulated solid core, about 22 AWG) [REP]. */
export const WIRE = {
  radiusMm: 0.65,
  /** Lowest wire run above the bench. */
  baseHeightMm: 1.6,
  /** Vertical spacing between wire levels: more than a wire's diameter. */
  levelStepMm: 1.6,
  /** Clearance of a wire over whatever it passes above. */
  clearanceMm: 1.4,
  /** Bend radius of the drawn corners. */
  bendRadiusMm: 1.2,
};

// ---- Sprint 10 parts (PM-6 revision) --------------------------------------------------------
// Sources: [KB-RGB] Kingbright WP154A4SUREQBFZGC Rev V.11A package drawing; [SENBA] Senba GL55
// series manual p.3; [CEM] Same Sky CEM-1205-IC mechanical drawing (p.2); [SRD] Songle SRD
// datasheet dimension and drilling drawing (p.1). Fact sheet: docs/sprints/s10-evidence/datasheets.

/** RGB LED, T-1 3/4 water clear, 4 leads at 1.27 mm [KB-RGB]; standoff as the 5 mm LEDs [REP]. */
export const RGB_LED_5MM = {
  kind: 'led',
  bodyDiameterMm: 5.0,
  flangeDiameterMm: 5.9,
  flangeThicknessMm: 1.0,
  heightMm: 8.6,
  domeRadiusMm: 2.49,
  leadPitchMm: 1.27,
  leadSizeMm: 0.5,
  standoffMm: 3.0,
  /** Lead order along the row: pin 1 red, 2 common cathode (longest), 3 blue, 4 green. */
  pinOrder: ['red', 'cathode', 'blue', 'green'] as const,
} as const;

/** GL5528 CdS cell: Ø5.1 disc with two flats (4.3 mm), 2.1 mm thick, leads 3.0 mm apart [SENBA]. */
export const LDR_GL5528 = {
  diameterMm: 5.1,
  flatToFlatMm: 4.3,
  thicknessMm: 2.1,
  leadSpacingMm: 3.0,
  leadDiameterMm: 0.5,
  /** Cell face up, standing on its leads [REP]. */
  standoffMm: 4.0,
};

/** CEM-1205-IC: Ø12.0 x 9.5 mm black can, 2 pins Ø0.6 at 7.6 mm [CEM]. */
export const BUZZER_CEM1205 = {
  diameterMm: 12.0,
  heightMm: 9.5,
  pinSpacingMm: 7.6,
  pinDiameterMm: 0.6,
  /** Seated on its pins just above the bench [REP]. */
  standoffMm: 1.2,
  soundHoleDiameterMm: 2.0,
};

/**
 * SRD relay: 19.1 x 15.5 x 15.3 mm (max) case [SRD]. Pins (bottom face, x along the length,
 * centred): COM 1.4 mm from one end on the centre line; the coil pins 2.0 mm further in, 12.0 mm
 * apart; NO and NC 12.2 mm beyond the coil pins (NO opposite coil 1's side) [SRD drilling plan;
 * the drawing's view direction is not stated: the mirror image would swap NO/NC sides only].
 */
export const RELAY_SRD = {
  lengthMm: 19.1,
  widthMm: 15.5,
  heightMm: 15.3,
  /** Case raised on its pins so the pins (and the wires soldered to them) show [REP]. */
  standoffMm: 3.5,
  pinLengthMm: 5.0,
  /** Wires are soldered to the pin tips just above the bench. */
  attachHeightMm: 0.8,
  pins: {
    com: [-19.1 / 2 + 1.4, 0],
    coil1: [-19.1 / 2 + 3.4, -6],
    coil2: [-19.1 / 2 + 3.4, 6],
    no: [-19.1 / 2 + 15.6, -6],
    nc: [-19.1 / 2 + 15.6, 6],
  } as Record<string, readonly [number, number]>,
};

/**
 * TO-92 (onsemi Case 29-11, straight leads): body 4.45-5.20 wide (flat face), 4.32-5.33 high,
 * 3.18-4.19 deep; leads 0.41-0.53 wide at 1.15-1.39 mm pitch, E-B-C facing the flat side [TO92].
 * Mid-tolerance values; standoff [REP].
 */
export const TO92 = {
  widthMm: 4.8,
  heightMm: 4.8,
  depthMm: 3.7,
  leadPitchMm: 1.27,
  leadWidthMm: 0.46,
  standoffMm: 3.0,
  /** Lead order facing the flat face, left to right. */
  pinOrder: ['emitter', 'base', 'collector'] as const,
};
