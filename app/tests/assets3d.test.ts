/**
 * Bundled 3D assets (Sprint 10 high-fidelity proof set): reproducible from their authoring source,
 * local, and consistent with the scene's anchors.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportGlb } from '../src/views/scene3d/assets/exportGlb.js';
import {
  authorEsp32DevkitC,
  esp32PinAnchors,
} from '../src/views/scene3d/assets/esp32DevkitC.author.js';
import { ASSETS } from '../src/views/scene3d/assets/manifest.js';
import { ledAnchors } from '../src/views/scene3d/assets/led5mm.js';
import { LED_PACKAGES } from '../src/views/scene3d/physical.js';
import { realPinZ } from '../src/views/scene3d/scene.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('bundled 3D assets', () => {
  it('the committed ESP32 glTF is exactly what its authoring source produces (deterministic)', async () => {
    const committed = readFileSync(
      new URL('../src/views/scene3d/assets/esp32-devkitc-v4.glb', import.meta.url),
    );
    const built = await exportGlb(authorEsp32DevkitC());
    expect(sha(built)).toBe(sha(committed));
    // A size budget for the asset (raw; it is served compressed). Realism pass: the board's
    // parts at package level (castellations, chip passives, connector internals) ~720 KB.
    expect(committed.byteLength).toBeLessThan(800_000);
  });

  it('the manifest names every proof-set model, with provenance and anchors', () => {
    for (const r of Object.values(ASSETS)) {
      expect(r.provenance.length).toBeGreaterThan(20);
      expect(r.anchors.length).toBeGreaterThan(10);
      expect(r.license).toBeTruthy();
    }
    expect(ASSETS['board.esp32_devkitc'].file).toBe('esp32-devkitc-v4.glb');
  });

  it("anchors: the asset's pin stubs and the LED legs are where the scene puts its terminals", () => {
    const a = esp32PinAnchors();
    expect(a['J3.1']).toMatchObject({ x: 12.7 });
    expect(a['J3.1']!.z).toBeCloseTo(realPinZ(1), 9);
    expect(a['J2.19']!.x).toBeCloseTo(-12.7, 9);
    expect(ledAnchors(LED_PACKAGES.t1_34)).toMatchObject({
      anode: { x: -1.27, z: 0 },
      cathode: { x: 1.27, z: 0 },
    });
  });
});
