/**
 * High-fidelity pass 3 (Sprint 10): the part geometry and materials this pass changed, checked
 * against the real parts' dimensions (never pixels).
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { DIODE_DO35, ESP32_PCB_TOP, LED_PACKAGES, TACTILE } from '../src/views/scene3d/physical.js';
import { OwnedResources, ribbon } from '../src/views/scene3d/kit.js';
import { buildDo35 } from '../src/views/scene3d/assets/diodeDo35.js';
import { buildLedHiFi } from '../src/views/scene3d/assets/led5mm.js';

function fakeCanvas() {
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'createLinearGradient' || k === 'createRadialGradient'
          ? () => ({ addColorStop() {} })
          : k === 'measureText'
            ? () => ({ width: 10 })
            : () => undefined,
      set: () => true,
    },
  );
  return { width: 0, height: 0, getContext: () => ctx, style: {} };
}
beforeAll(() => {
  (globalThis as { document?: unknown }).document ??= {
    createElement: () => fakeCanvas(),
    createElementNS: () => fakeCanvas(),
  };
});

const box = (o: THREE.Object3D) => {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
};

describe('high-fidelity pass 3: geometry from the real parts', () => {
  it('ESP32 header joints are low solder menisci (~0.45 mm), not tall cones', async () => {
    const bytes = readFileSync(
      new URL('../src/views/scene3d/assets/esp32-devkitc-v4.glb', import.meta.url),
    );
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    );
    const joints = gltf.scene.getObjectByName('solder_joints')!;
    expect(joints).toBeDefined();
    const b = box(joints);
    expect(b.max.y - ESP32_PCB_TOP).toBeLessThanOrEqual(0.5);
    expect(b.max.y - ESP32_PCB_TOP).toBeGreaterThan(0.3);
    // A satin solder, not a mirror.
    const mat = (joints as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat.roughness).toBeGreaterThanOrEqual(0.3);
  });

  it('1N4148: real-size DUMET slugs inside clear glass, the die between them', () => {
    const own = new OwnedResources(null, 'full');
    const metal = new THREE.MeshStandardMaterial();
    const g = buildDo35(own, 2, metal);
    const glass = g.children.find((c) => c.userData.glass) as THREE.Mesh;
    const gm = glass.material as THREE.MeshPhysicalMaterial;
    expect(gm.transmission).toBe(1);
    // Light amber: the glass's own colour is near white.
    expect(gm.color.r).toBeGreaterThan(0.9);
    expect(gm.color.g).toBeGreaterThan(0.85);
    const R = DIODE_DO35.bodyDiameterMm / 2;
    const slugs = g.children.filter(
      (c) =>
        (c as THREE.Mesh).isMesh &&
        ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).metalness === 1 &&
        c !== glass &&
        c.position.x !== 0,
    );
    for (const s of slugs) {
      const b = box(s);
      // ~0.55 mm across in a 1.75 mm envelope.
      expect(b.max.z - b.min.z).toBeLessThan(R * 0.8);
    }
  });

  it('LED: translucent frosted epoxy (full tier), and the light starts at the die (glow core)', () => {
    const own = new OwnedResources(null, 'full');
    const m = { lead: new THREE.MeshStandardMaterial(), frame: new THREE.MeshStandardMaterial() };
    const led = buildLedHiFi(
      own,
      't1_34:red',
      LED_PACKAGES.t1_34,
      { color: '#e53935', clear: false },
      m,
    );
    const lens = led.lens as unknown as THREE.MeshPhysicalMaterial;
    expect(lens.transmission).toBeGreaterThanOrEqual(0.75);
    expect(lens.roughness).toBeLessThanOrEqual(0.45);
    const core = led.group.children.find((c) => c.userData.ledCore) as THREE.Sprite;
    expect(core).toBeDefined();
    expect(core.visible).toBe(false); // off until lit
    expect(led.core.opacity).toBe(0);
    // At the die: inside the lens, near the frame's top, on the cathode anvil's cup.
    const die = led.group.children.find((c) => c.userData.ledDie) as THREE.Mesh;
    expect(core.position.distanceTo(die.position)).toBeLessThan(0.5);
    expect(core.position.y).toBeLessThan(led.top);
  });

  it('push-button legs are flat stamped strips (0.7 x 0.3 mm), not round wire', () => {
    const own = new OwnedResources(null, 'full');
    const leg = ribbon(
      own,
      [
        [0, 3, 0],
        [0, 0.9, 0],
        [5, 0.9, 0],
      ],
      TACTILE.legWidthMm,
      0.3,
      new THREE.MeshStandardMaterial(),
    );
    const b = box(leg);
    // Width across z, thickness along the bend's normal (x on the vertical run).
    expect(b.max.z - b.min.z).toBeCloseTo(TACTILE.legWidthMm, 3);
    const vertical = b.min.x;
    expect(vertical).toBeCloseTo(-0.15, 2);
  });
});
