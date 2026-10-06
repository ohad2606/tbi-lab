/**
 * Runtime library of the bundled glTF assets (Sprint 10 high-fidelity proof set).
 *
 * - Local, bundled, fingerprinted files (Vite `?url`): no CDN, no network beyond the app's origin.
 * - LAZY: nothing loads at app start-up. The 3D view calls `loadAssets()` when it opens (inside its
 *   own lazily loaded chunk); the parsed templates are then kept for the page's lifetime, so
 *   re-entering the view never fetches or parses again.
 * - Deterministic mapping: one asset per model key (manifest.ts). A model with no asset, or an asset
 *   that failed to load, falls back to its procedural builder (the view never breaks).
 * - Templates are cloned per part (`instantiate`): clones share the template's geometry and
 *   materials, so ten boards cost one set of buffers. The view never disposes templates.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import esp32Url from './esp32-devkitc-v4.glb?url';
import type { ModelKey } from '../scene.js';

const SOURCES: Partial<Record<ModelKey, string>> = {
  'board.esp32_devkitc': esp32Url,
};

const templates = new Map<ModelKey, THREE.Object3D>();
let loading: Promise<void> | null = null;

/** What loading cost (measured once per page, for the performance report and tests). */
export interface AssetLoadStats {
  /** Wall time of fetch + parse of all assets, ms. */
  ms: number;
  /** Bytes fetched per asset. */
  bytes: Partial<Record<ModelKey, number>>;
  failed: ModelKey[];
}
let lastStats: AssetLoadStats | null = null;
export const assetLoadStats = () => lastStats;

/** Load (once) every bundled asset. Never rejects: a failed asset is reported and skipped. */
export function loadAssets(): Promise<void> {
  loading ??= (async () => {
    const t0 = performance.now();
    const loader = new GLTFLoader();
    const stats: AssetLoadStats = { ms: 0, bytes: {}, failed: [] };
    await Promise.all(
      (Object.entries(SOURCES) as [ModelKey, string][]).map(async ([key, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`${res.status}`);
          const buf = await res.arrayBuffer();
          stats.bytes[key] = buf.byteLength;
          const gltf = await loader.parseAsync(buf, '');
          templates.set(key, gltf.scene);
        } catch {
          stats.failed.push(key);
        }
      }),
    );
    stats.ms = Math.round(performance.now() - t0);
    lastStats = stats;
  })();
  return loading;
}

/** A new instance of a model's asset (shared geometry and materials), or null if none is loaded. */
export function instantiate(key: ModelKey): THREE.Object3D | null {
  const t = templates.get(key);
  return t ? t.clone(true) : null;
}

/** Unit tests: register a template parsed outside the browser (the committed asset file). */
export function registerTemplateForTests(key: ModelKey, root: THREE.Object3D): void {
  templates.set(key, root);
}
