/**
 * ESP32-DevKitC V4 at runtime (Sprint 10; realism pass): an instance of the bundled glTF asset
 * (esp32DevkitC.author.ts -> esp32-devkitc-v4.glb), finished with what the glTF does not carry:
 * - the board's surface: solder mask over copper, pads and silkscreen on both PCB faces, the
 *   module's antenna area, and the marking atlas of the can and the ICs (esp32Textures.ts), drawn
 *   once per viewer and shared by every board in it;
 * - brushed-metal anisotropy on the RF can (full tier);
 * - a jumper wire's female housing (dupont.ts) on every header pin that carries a wire; its top is
 *   that pin's electrical anchor (scene.ts ESP32_ATTACH_HEIGHT).
 * Materials are cloned once per viewer (the shared glTF template is never modified).
 * Returns null when the asset is not loaded; the caller then builds the procedural board.
 */
import * as THREE from 'three';
import { ESP32_DEVKITC_WROOM32, boardPinPosition, boardTerminalId } from '@tbi-lab/domain';
import { ESP32_DEVKITC as D, ESP32_PCB_TOP } from '../physical.js';
import type { OwnedResources } from '../kit.js';
import { instantiate } from './library.js';
import { esp32Textures } from './esp32Textures.js';
import { buildDupont, dupontMaterials } from './dupont.js';

const pinZ = (position: number) => (position - (D.headerPins + 1) / 2) * D.pinPitchMm;

/** The viewer's finished material for a template material (textures applied once). */
function finish(own: OwnedResources, name: string, original: THREE.Material): THREE.Material {
  return own.lastingMat(`esp32:${name}:${original.uuid}`, () => {
    const tex = esp32Textures(own);
    const m = original.clone() as THREE.MeshPhysicalMaterial;
    const full = own.tier === 'full';
    switch (name) {
      case 'pcb_top':
      case 'pcb_bottom': {
        const t = name === 'pcb_top' ? tex.top : tex.bottom;
        m.map = t.map;
        if (full) {
          m.bumpMap = t.bump;
          m.bumpScale = 1.6;
        }
        // Coplanar with the PCB's own faces: always win the depth test.
        m.polygonOffset = true;
        m.polygonOffsetFactor = -1;
        m.polygonOffsetUnits = -2;
        break;
      }
      case 'module_top':
        m.map = tex.moduleTop.map;
        if (full) {
          m.bumpMap = tex.moduleTop.bump;
          m.bumpScale = 1.4;
        }
        m.polygonOffset = true;
        m.polygonOffsetFactor = -1;
        m.polygonOffsetUnits = -2;
        break;
      case 'markings':
        m.map = tex.marks;
        m.transparent = false;
        // Crisp printed edges without sorting: alpha-to-coverage with the stage's multisampling
        // (full), a plain alpha test otherwise.
        m.alphaTest = 0.4;
        m.alphaToCoverage = full;
        m.polygonOffset = true;
        m.polygonOffsetFactor = -2;
        m.polygonOffsetUnits = -4;
        break;
      case 'shield_can':
        m.roughnessMap = tex.brushed;
        if (full) {
          m.anisotropy = 0.55;
          m.anisotropyRotation = 0;
        }
        break;
    }
    m.needsUpdate = true;
    return m;
  });
}

export function buildEsp32Asset(
  own: OwnedResources,
  wiredPins: readonly string[],
): THREE.Object3D | null {
  const root = instantiate('board.esp32_devkitc');
  if (!root) return null;
  const finished = new Set(['pcb_top', 'pcb_bottom', 'module_top', 'markings', 'shield_can']);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const skin = o.name === 'pcb_top' || o.name === 'pcb_bottom' || o.name === 'module_top';
    mesh.castShadow = !skin && o.name !== 'markings';
    mesh.receiveShadow = true;
    if (finished.has(o.name)) mesh.material = finish(own, o.name, mesh.material as THREE.Material);
  });
  root.userData.asset = 'esp32-devkitc-v4.glb';
  // Jumper housings on the wired pins: the wire leaves each housing's top.
  const wired = new Set(wiredPins);
  const dm = dupontMaterials(own);
  for (const pin of ESP32_DEVKITC_WROOM32.pins) {
    const id = boardTerminalId(pin);
    if (!id || !wired.has(id)) continue;
    const local = boardPinPosition(pin);
    const h = buildDupont(own, D.dupontSizeMm, D.dupontHeightMm, dm);
    // The latch window faces outward, away from the board's centre line.
    h.rotation.y = local.x < 0 ? -Math.PI / 2 : Math.PI / 2;
    h.position.set(
      Math.sign(local.x) * (D.headerRowSpacingMm / 2),
      ESP32_PCB_TOP + D.dupontSeatMm,
      pinZ(pin.position),
    );
    h.userData.jumper = id;
    root.add(h);
  }
  // Every header pin is drawn by the asset (one merged mesh of 38).
  const pins = root.getObjectByName('header_pins');
  if (pins) pins.userData.headerPins = ESP32_DEVKITC_WROOM32.pins.length;
  return root;
}
