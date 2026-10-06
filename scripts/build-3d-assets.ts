/**
 * Build the bundled 3D assets (Sprint 10 high-fidelity proof set): runs each asset's authoring
 * source (pure three.js, no DOM) and writes it as a binary glTF next to it. Deterministic: the same
 * source gives the same bytes (app/tests/assets3d.test.ts checks the committed files).
 *
 *   npx vite-node scripts/build-3d-assets.ts
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exportGlb } from '../app/src/views/scene3d/assets/exportGlb.js';
import { authorEsp32DevkitC } from '../app/src/views/scene3d/assets/esp32DevkitC.author.js';

const out = new URL('../app/src/views/scene3d/assets/esp32-devkitc-v4.glb', import.meta.url);
const bytes = await exportGlb(authorEsp32DevkitC());
writeFileSync(out, bytes);
console.log(
  `esp32-devkitc-v4.glb ${bytes.byteLength} bytes sha256 ${createHash('sha256').update(bytes).digest('hex')}`,
);
