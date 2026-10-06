/**
 * High-fidelity 3D asset manifest (Sprint 10 proof set): one record per model, the deterministic
 * mapping from a scene model key to its visual asset, with the facts each asset must state.
 *
 * Architecture (kept separate on purpose):
 *   circuit model (domain) -> 3D scene description (scene.ts: placement, anchors, nodes)
 *     -> component visual asset/model (this folder: geometry, materials) -> renderer (three.js)
 * No product logic lives in an asset: a glTF node or a builder never decides connectivity, values
 * or state; it only draws what the scene description gives it.
 *
 * Dimensional rule: the 2D layout gives each part's PLACEMENT (centre, rotation); the asset gives
 * its real-world SIZE. Anchors are the asset's electrical attach points; wires end on them.
 */
import { LED_PACKAGES, ESP32_DEVKITC, ESP32_PIN_TOP } from '../physical.js';
import { RESISTOR_HIFI } from './resistorAxial.js';
import type { ModelKey } from '../scene.js';

export interface AssetRecord {
  model: ModelKey;
  /** How the geometry is produced. */
  source: 'gltf' | 'procedural';
  /** Bundled file (glTF assets), relative to this folder. */
  file?: string;
  /** Authoring source (the code that produces the geometry or the glTF). */
  authoring: string;
  /** Overall real-world envelope, mm (x, y, z in the asset frame). */
  dimensionsMm: { x: number; y: number; z: number };
  /** Orientation convention of the asset frame. */
  orientation: string;
  /** Electrical anchors, asset frame, mm (terminal id -> point), or how they are derived. */
  anchors: string;
  materials: string;
  levelOfDetail: string;
  /** Sources of the dimensions; external reference geometry (none so far) with its licence. */
  provenance: string;
  license: string;
}

const led = LED_PACKAGES.t1_34;

export const ASSETS: Record<'board.esp32_devkitc' | 'resistor.axial' | 'led.radial', AssetRecord> =
  {
    'board.esp32_devkitc': {
      model: 'board.esp32_devkitc',
      source: 'gltf',
      file: 'esp32-devkitc-v4.glb',
      authoring: 'assets/esp32DevkitC.author.ts -> scripts/build-3d-assets.ts (deterministic GLB)',
      dimensionsMm: {
        x: ESP32_DEVKITC.pcbWidthMm,
        y: ESP32_PIN_TOP,
        z: ESP32_DEVKITC.pcbLengthMm + ESP32_DEVKITC.moduleOverhangMm,
      },
      orientation:
        'origin = board centre on the bench; +X towards header J3, +Z towards the USB end (pin 1 / antenna at -Z), +Y up; stands on its male header pins',
      anchors:
        'each header pin top stub (x = +-12.7, z = (position - 10) x 2.54, y = PCB top + 1.5); a wired pin gets a jumper housing whose top is its anchor (scene.ts ESP32_ATTACH_HEIGHT)',
      materials:
        'PBR: soldermask with clearcoat, ENIG gold pads, tin solder fillets, gold-flash pins, PBT housings, nickel-silver RF can, nickel USB shell, IC mould compound; silkscreen and can marking drawn at runtime on two named planes',
      levelOfDetail:
        'single LOD, 17k vertices / 15k triangles, repeated features merged per material (38 pins, pads, fillets, housings, castellations)',
      provenance:
        'authored in this repository from [ESP-DIM] Espressif ESP32-DevKitC V4 dimension drawing and [WROOM] ESP32-WROOM-32 datasheet outline; small parts (switches, regulator, bridge, passives) at representative package sizes [REP]. No external model geometry.',
      license: 'project source (no third-party asset)',
    },
    'resistor.axial': {
      model: 'resistor.axial',
      source: 'procedural',
      authoring: 'assets/resistorAxial.ts',
      dimensionsMm: {
        x: RESISTOR_HIFI.bodyLengthMm,
        y: RESISTOR_HIFI.capDiameterMm,
        z: RESISTOR_HIFI.capDiameterMm,
      },
      orientation:
        'axis along +X (terminal a at -X, b at +X), body centred on the origin, lying 1.0 mm above the bench; leads formed down to the terminals',
      anchors:
        'each lead end at its 2D terminal position on the bench (0.5 in = 12.7 mm lead spacing)',
      materials:
        'lacquer: physical material (clearcoat) with a painted band texture following the body curvature; beige carbon-film (4 bands) or blue metal-film (5 bands); tinned copper leads',
      levelOfDetail: 'lathe 48 x 96 profile points; leads 12-sided tubes, finely sampled bends',
      provenance:
        '[CFR25] Yageo CFR-25 / MFR-25 class: body 6.0 +- 0.5 x 2.3 +- 0.3 mm, lead 0.54 mm; band layout per IEC 60062',
      license: 'project source',
    },
    'led.radial': {
      model: 'led.radial',
      source: 'procedural',
      authoring: 'assets/led5mm.ts',
      dimensionsMm: {
        x: led.flangeDiameterMm,
        y: led.standoffMm + led.heightMm,
        z: led.flangeDiameterMm,
      },
      orientation:
        'axis along +Y, legs in the XZ plane along X: anode at -X, cathode (flange flat) at +X; seating plane 3.0 mm above the bench',
      anchors: `leg tips at x = -+${(led.leadPitchMm / 2).toFixed(2)} (2.54 mm pitch), z = 0, on the bench`,
      materials:
        'epoxy: physical material, clearcoat skin over a tinted-diffused or water-clear body, emissive for the live glow; lead frame and legs tinned steel',
      levelOfDetail: 'lathe 48 segments; frame extrusions; 0.5 mm square legs',
      provenance:
        '[V83012] Vishay TLHR540x (5 mm), [V83009] Vishay TLHG4900 (3 mm) package drawings',
      license: 'project source',
    },
  };
