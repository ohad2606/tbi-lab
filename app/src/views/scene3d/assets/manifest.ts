/**
 * The 3D visual descriptors and asset manifest (Sprint 10; realism pass): for every scene model
 * key, how its visual is produced and what it may and may not depend on.
 *
 * Architecture (kept separate on purpose):
 *   component type (domain) -> model key (scene.ts MODEL_FOR) -> visual descriptor (this file)
 *     -> procedural factory (models.ts / assets/*.ts), or a glTF/GLB asset (library.ts), or a
 *        hybrid: an asset finished at runtime (textures drawn once per viewer, parts that depend
 *        on the project such as jumper housings) -> renderer (three.js)
 * Electrical identity never comes from here: a descriptor, an asset or a builder never decides
 * connectivity, values or state. `live` names the presentation hooks the renderer may drive from
 * SOLVED results while a simulation runs (an LED's glow from its current), nothing else.
 *
 * Licensing gate: every visual that ships says where its geometry, textures and dimensions come
 * from and under what licence. All current visuals are original to this project (procedural code
 * or a glTF authored from code in this repository); reference images used while modelling are
 * not shipped (docs/sprints/SPRINT-10.md, Part H). A third-party asset may only be added with
 * `thirdParty` filled in (source, author, licence, modification, attribution), and the test in
 * app/tests/assets3d.test.ts refuses one without it.
 *
 * Dimensional rule: the 2D layout gives each part's PLACEMENT (centre, rotation); the visual
 * gives its real-world SIZE. Anchors are the visual's electrical attach points; wires end on them.
 */
import { LED_PACKAGES, ESP32_DEVKITC, ESP32_PIN_TOP } from '../physical.js';
import { RESISTOR_HIFI } from './resistorAxial.js';
import type { ModelKey } from '../scene.js';

export interface AssetRecord {
  model: ModelKey;
  /** How the visual is produced. */
  source: 'gltf' | 'procedural' | 'hybrid';
  /** Bundled file (glTF and hybrid visuals), relative to this folder. */
  file?: string;
  /** Authoring source (the code that produces the geometry or the glTF). */
  authoring: string;
  /** Overall real-world envelope, mm (x, y, z in the asset frame), where stated. */
  dimensionsMm?: { x: number; y: number; z: number };
  /** Orientation convention of the asset frame. */
  orientation: string;
  /** Electrical anchors, asset frame, mm (terminal id -> point), or how they are derived. */
  anchors: string;
  materials: string;
  levelOfDetail: string;
  /** Live presentation hooks driven from solved results (never electrical inputs). */
  live: ('ledGlow' | 'rgbGlow' | 'matrixDots' | 'lcdFace')[];
  /** Sources of the dimensions and of any reference used while modelling. */
  provenance: string;
  license: string;
  /** Required for any third-party geometry or texture (none so far). */
  thirdParty?: {
    source: string;
    author: string;
    license: string;
    modified: string;
    attribution: string;
  };
}

const led = LED_PACKAGES.t1_34;
const ORIGINAL = 'project source (original geometry and textures; no third-party asset)';
const procedural = (
  model: ModelKey,
  authoring: string,
  provenance: string,
  extra: Partial<AssetRecord> = {},
): AssetRecord => ({
  model,
  source: 'procedural',
  authoring,
  orientation: 'part local frame (models.ts): +X along the layout x axis at rotation 0, +Y up',
  anchors: 'lead/pin ends at the terminals’ attach points (scene.ts localAttach)',
  materials: 'models.ts createMaterials (shared PBR set) and part-specific materials',
  levelOfDetail: 'single LOD, shared geometry per shape key',
  live: [],
  provenance,
  license: ORIGINAL,
  ...extra,
});

export const ASSETS: Record<ModelKey, AssetRecord> = {
  'board.esp32_devkitc': {
    model: 'board.esp32_devkitc',
    source: 'hybrid',
    file: 'esp32-devkitc-v4.glb',
    authoring:
      'geometry: assets/esp32DevkitC.author.ts -> scripts/build-3d-assets.ts (deterministic GLB); runtime: assets/esp32DevkitC.ts (surface textures esp32Textures.ts, jumper housings dupont.ts)',
    dimensionsMm: {
      x: ESP32_DEVKITC.pcbWidthMm,
      y: ESP32_PIN_TOP,
      z: ESP32_DEVKITC.pcbLengthMm + ESP32_DEVKITC.moduleOverhangMm,
    },
    orientation:
      'origin = board centre on the bench; +X towards header J3, +Z towards the USB end (pin 1 / antenna at -Z), +Y up; stands on its male header pins',
    anchors:
      'each header pin top stub (x = +-12.7, z = (position - 10) x 2.54, y = PCB top + 1.5); a wired pin gets a 2.54 x 2.54 x 14 mm jumper housing whose top is its anchor (scene.ts ESP32_ATTACH_HEIGHT)',
    materials:
      'PBR: FR-4 edge, satin LPI mask (runtime map + bump: mask over copper pour and traces, tented vias, tinned pads, stroke-font silkscreen in off-white ink), ENIG gold pads, tin solder joints, gold-flash pins, PBT housings, brushed nickel-silver RF can (runtime roughness), drawn-steel micro-USB B shell (flared mouth, dark cavity, insert tongue with gold contacts, latch windows, runtime roughness grain), IC mould compound; one marking atlas for the can and ICs',
    levelOfDetail:
      'single LOD, ~23k vertices; repeated features merged per material; board textures drawn once per viewer (full ~36 px/mm, reduced half)',
    live: [],
    provenance:
      'authored in this repository from [ESP-DIM] Espressif ESP32-DevKitC V4 dimension drawing (board 27.94 x 48.26 mm) and [WROOM] ESP32-WROOM-32 outline; part positions measured on the board photograph of the Espressif ESP32-DevKitC V4 user guide (reference only, not shipped); package outlines [PKG] (assets/esp32Layout.ts). No external model geometry.',
    license: ORIGINAL,
  },
  'resistor.axial': procedural(
    'resistor.axial',
    'assets/resistorAxial.ts',
    '[CFR25] Yageo CFR-25 / MFR-25 class: body 6.0 +- 0.5 x 2.3 +- 0.3 mm, lead 0.54 mm; band layout per IEC 60062',
    {
      dimensionsMm: {
        x: RESISTOR_HIFI.bodyLengthMm,
        y: RESISTOR_HIFI.capDiameterMm,
        z: RESISTOR_HIFI.capDiameterMm,
      },
      materials:
        'lacquer: physical material (clearcoat) with a painted band texture following the body curvature; beige carbon-film (4 bands) or blue metal-film (5 bands); tinned copper leads',
    },
  ),
  'led.radial': procedural(
    'led.radial',
    'assets/led5mm.ts',
    '[V83012] Vishay TLHR540x (5 mm), [V83009] Vishay TLHG4900 (3 mm) package drawings',
    {
      dimensionsMm: {
        x: led.flangeDiameterMm,
        y: led.standoffMm + led.heightMm,
        z: led.flangeDiameterMm,
      },
      anchors: `leg tips at x = -+${(led.leadPitchMm / 2).toFixed(2)} (2.54 mm pitch), z = 0, on the bench`,
      materials:
        'epoxy: full tier transmissive (IOR 1.5; tinted-diffused = frosted, translucent: transmission 0.82, roughness 0.4, the tint by absorption, the frame visible inside; water-clear = clear), reduced tier translucent; lead frame and legs tinned (satin); lit: the die emissive, a glow core round it, the lens glowing most at the die',
      live: ['ledGlow'],
    },
  ),
  'diode.axial': procedural(
    'diode.axial',
    'assets/diodeDo35.ts',
    '[V81857] Vishay 1N4148 datasheet, DO-35 package: body 3.4 x 1.75 mm used, leads 0.5 mm',
    {
      materials:
        'glass: full tier clear transmissive with a light amber cast (IOR 1.5), reduced tier translucent; real-size DUMET slugs (~0.55 mm) and the silicon die visible inside; painted cathode band',
    },
  ),
  'switch.tactile': procedural(
    'switch.tactile',
    'assets/benchParts.ts buildTactile',
    '[REP] 6 x 6 mm through-hole tactile switch class (physical.ts TACTILE): flat stamped 0.7 x 0.3 mm legs; the actuator cap travels 0.45 mm when pressed',
  ),
  'switch.toggle': procedural(
    'switch.toggle',
    'assets/benchParts.ts buildToggle',
    '[REP] sub-miniature SPST toggle switch class (physical.ts TOGGLE); lever in the persisted position',
  ),
  'ground.post': procedural(
    'ground.post',
    'assets/benchParts.ts buildGround',
    '[REP] binding post on a plated plate: an abstract reference point (not an earth rod)',
  ),
  'instrument.psu': procedural(
    'instrument.psu',
    'assets/benchParts.ts buildPsu',
    'REDUCED, SYMBOLIC scale by design (physical.ts PSU): a compact bench supply; displays show the design setpoints',
  ),
  'led.rgb': procedural(
    'led.rgb',
    'models.ts buildRgbLed',
    '[KB-RGB] Kingbright WP154A4SUREQBFZGC package drawing',
    {
      live: ['rgbGlow'],
    },
  ),
  'ldr.disc': procedural(
    'ldr.disc',
    'models.ts buildPhotoresistor',
    '[SENBA] Senba GL55 series manual p.3 (GL5528 cell)',
  ),
  'buzzer.can': procedural(
    'buzzer.can',
    'models.ts buildBuzzer',
    '[CEM] Same Sky CEM-1205-IC mechanical drawing p.2',
  ),
  'relay.cube': procedural(
    'relay.cube',
    'models.ts buildRelay',
    '[SRD] Songle SRD datasheet, dimension and drilling drawing p.1',
  ),
  'transistor.to92': procedural(
    'transistor.to92',
    'models.ts buildTo92',
    '[TO92] onsemi Case 29-11 (TO-92, straight leads)',
  ),
  'sensor.pir': procedural(
    'sensor.pir',
    'models.ts buildPir',
    'HC-SR501 module sheet p.1/p.3, part layout [REP]',
  ),
  'display.matrix': procedural(
    'display.matrix',
    'models.ts buildLedMatrix',
    '[VMP502] 1088AS 8x8 matrix sheet, 32 x 32 x 8 mm',
    {
      live: ['matrixDots'],
    },
  ),
  'sensor.ultrasonic': procedural(
    'sensor.ultrasonic',
    'models.ts buildUltrasonic',
    'HC-SR04 Elecfreaks sheet p.2 (45 x 20 x 15 mm, pin order); transducers [REP]',
  ),
  'sensor.dht22': procedural(
    'sensor.dht22',
    'models.ts buildDht22',
    'AM2302 sheet p.2 drawing (15.1 x 25.1 x 7.7 mm, 2.54 mm pins)',
  ),
  'display.lcd1602': procedural(
    'display.lcd1602',
    'models.ts buildLcd1602',
    'JHD 16x2 LCD specification p.5/p.15 (80 x 36 mm, viewing area 64.5 x 14.5 mm); backpack [REP]',
    {
      live: ['lcdFace'],
    },
  ),
  'capacitor.radial': procedural(
    'capacitor.radial',
    'models.ts buildCapacitor',
    '[REP] disc ceramic / radial electrolytic classes',
  ),
  generic: procedural('generic', 'models.ts generic', 'a neutral block for types without a model'),
};

/**
 * Visual elements that are not components (wires, jumper housings, contacts, the bench): the same
 * provenance rule.
 */
export const SCENE_VISUALS = {
  wire: {
    authoring: 'wires.ts',
    provenance:
      '[REP] 22 AWG solid hook-up wire: 1.3 mm jacket, 0.64 mm tinned conductor; colours by electrical node',
    license: ORIGINAL,
  },
  dupontHousing: {
    authoring: 'assets/dupont.ts',
    provenance: '[REP] 1-way 2.54 mm female crimp housing, 2.54 x 2.54 x 14 mm',
    license: ORIGINAL,
  },
  contact: {
    authoring: 'wires.ts buildJoint',
    provenance: 'a twisted tinned link (a mechanical connection, deliberately not drawn as solder)',
    license: ORIGINAL,
  },
  stage: {
    authoring: 'stage.ts',
    provenance:
      'three.js RoomEnvironment (procedural, MIT, part of the three dependency); bench grain and backdrop drawn in code',
    license: ORIGINAL,
  },
} as const;
