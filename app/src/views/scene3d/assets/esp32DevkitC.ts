/**
 * ESP32-DevKitC V4 at runtime (Sprint 10 high-fidelity proof set): an instance of the bundled glTF
 * asset (esp32DevkitC.author.ts -> esp32-devkitc-v4.glb), with the parts that depend on the
 * project added here:
 * - the silkscreen and the module's laser marking, drawn on canvases into the asset's two named
 *   planes (presentation only);
 * - a jumper (Dupont) housing on every header pin that carries a wire; its top is that pin's
 *   electrical anchor (scene.ts ESP32_ATTACH_HEIGHT).
 * Returns null when the asset is not loaded; the caller then builds the procedural board.
 */
import * as THREE from 'three';
import { ESP32_DEVKITC_WROOM32, boardPinPosition, boardTerminalId } from '@tbi-lab/domain';
import { ESP32_DEVKITC as D, ESP32_PCB_TOP } from '../physical.js';
import { OwnedResources, box, canvasTexture } from '../kit.js';
import { instantiate } from './library.js';

const pinZ = (position: number) => (position - (D.headerPins + 1) / 2) * D.pinPitchMm;

/** White silkscreen ink on a transparent layer, in PCB coordinates (u across, v along). */
function silkscreen(own: OwnedResources): THREE.Texture {
  const W = 560;
  const H = Math.round((W * D.pcbLengthMm) / D.pcbWidthMm);
  return canvasTexture(own, W, H, (ctx) => {
    const k = W / D.pcbWidthMm;
    const zTop = D.pcbCentreZMm - D.pcbLengthMm / 2;
    const X = (mm: number) => (mm + D.pcbWidthMm / 2) * k;
    const Z = (mm: number) => (mm - zTop) * k;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#eef0f2';
    ctx.strokeStyle = '#eef0f2';
    ctx.lineWidth = 0.18 * k;
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(1.05 * k)}px ui-sans-serif, Arial, sans-serif`;
    const rowX = D.headerRowSpacingMm / 2;
    for (const pin of ESP32_DEVKITC_WROOM32.pins) {
      const left = boardPinPosition(pin).x < 0;
      const x = left ? -rowX : rowX;
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillText(pin.headerLabel, X(left ? x + 1.7 : x - 1.7), Z(pinZ(pin.position)));
    }
    // Header outlines (the silkscreen box around each row) and pin-1 marks.
    for (const sx of [-1, 1]) {
      ctx.strokeRect(
        X(sx * rowX - 1.35),
        Z(pinZ(1) - 1.35),
        2.7 * k,
        (pinZ(D.headerPins) - pinZ(1) + 2.7) * k,
      );
    }
    // Button labels, board name, and the outline of the module footprint.
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(0.95 * k)}px ui-sans-serif, Arial, sans-serif`;
    const zBottom = D.pcbCentreZMm + D.pcbLengthMm / 2;
    ctx.fillText('EN', X(-8.2), Z(zBottom - 8.0));
    ctx.fillText('BOOT', X(8.2), Z(zBottom - 8.0));
    ctx.save();
    ctx.translate(X(-5.2), Z(D.pcbCentreZMm + 6));
    ctx.rotate(-Math.PI / 2);
    ctx.font = `bold ${Math.round(0.9 * k)}px ui-sans-serif, Arial, sans-serif`;
    ctx.fillText('ESP32-DevKitC V4', 0, 0);
    ctx.restore();
  });
}

/** The RF can's laser marking: etched, slightly darker than the can. */
function moduleMarking(own: OwnedResources): THREE.Texture {
  return canvasTexture(own, 512, 560, (ctx) => {
    ctx.fillStyle = '#c8ccd0';
    ctx.fillRect(0, 0, 512, 560);
    ctx.fillStyle = '#6b7076';
    ctx.textAlign = 'center';
    ctx.font = 'bold 44px ui-sans-serif, Arial, sans-serif';
    ctx.fillText('ESP32-WROOM-32', 256, 150);
    ctx.font = '30px ui-sans-serif, Arial, sans-serif';
    ctx.fillText('ESPRESSIF', 256, 210);
    // The data-matrix square (a pattern, not real data).
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++)
        if (x === 0 || y === 11 || rnd() > 0.55) ctx.fillRect(196 + x * 10, 390 + y * 10, 10, 10);
  });
}

export function buildEsp32Asset(
  own: OwnedResources,
  wiredPins: readonly string[],
  housing: THREE.Material,
): THREE.Object3D | null {
  const root = instantiate('board.esp32_devkitc');
  if (!root) return null;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = o.name !== 'silkscreen' && o.name !== 'module_label';
    mesh.receiveShadow = true;
    if (o.name === 'silkscreen' || o.name === 'module_label') {
      // Per-instance copy of the plane's material with its drawn map.
      const mat = (mesh.material as THREE.MeshPhysicalMaterial).clone();
      mat.map = o.name === 'silkscreen' ? silkscreen(own) : moduleMarking(own);
      mat.needsUpdate = true;
      mesh.material = own.mat(mat);
    }
  });
  root.userData.asset = 'esp32-devkitc-v4.glb';
  // Jumper housings on the wired pins: the wire leaves each housing's top.
  const wired = new Set(wiredPins);
  const top = ESP32_PCB_TOP;
  for (const pin of ESP32_DEVKITC_WROOM32.pins) {
    const id = boardTerminalId(pin);
    if (!id || !wired.has(id)) continue;
    const local = boardPinPosition(pin);
    const h = box(own, D.dupontSizeMm, D.dupontHeightMm, D.dupontSizeMm, housing, [
      Math.sign(local.x) * (D.headerRowSpacingMm / 2),
      top + 0.3 + D.dupontHeightMm / 2,
      pinZ(pin.position),
    ]);
    h.userData.jumper = id;
    root.add(h);
  }
  // Every header pin is drawn by the asset (one merged mesh of 38).
  const pins = root.getObjectByName('header_pins');
  if (pins) pins.userData.headerPins = ESP32_DEVKITC_WROOM32.pins.length;
  return root;
}
