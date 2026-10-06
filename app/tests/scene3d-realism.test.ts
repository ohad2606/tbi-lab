/**
 * 3D realism pass (Sprint 10): the architecture, not the pixels.
 * - Every model key has a visual descriptor with provenance and licence; no third-party asset
 *   without its record (the licensing gate).
 * - Physical dimensions: the DevKitC board is its drawing's 27.94 x 48.26 mm, pin 1 1.30 mm from
 *   the antenna-end edge; the authored asset matches.
 * - Every marking the models print is drawable by the stroke font.
 * - Wire ends know what they meet (jumper housing, lead, post); presentation only.
 * - Quality tiers: software rasterisers get `reduced`, GPUs `full`, the override wins; the pixel
 *   ratio is clamped.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ESP32_DEVKITC_WROOM32, type ProjectDocument } from '@tbi-lab/domain';
import { ASSETS, SCENE_VISUALS } from '../src/views/scene3d/assets/manifest.js';
import { MODEL_FOR, deriveScene } from '../src/views/scene3d/scene.js';
import { ESP32_DEVKITC } from '../src/views/scene3d/physical.js';
import { authorEsp32DevkitC } from '../src/views/scene3d/assets/esp32DevkitC.author.js';
import { STROKE_CHARACTERS } from '../src/views/scene3d/assets/strokeFont.js';
import { silkLabel } from '../src/views/scene3d/assets/esp32Layout.js';
import { chooseQuality } from '../src/views/scene3d/renderer.js';
import { stagePixelRatio } from '../src/views/scene3d/stage.js';

describe('visual descriptors and the licensing gate', () => {
  it('every model key a component can use has a descriptor with provenance and licence', () => {
    const keys = new Set([...Object.values(MODEL_FOR), 'generic' as const]);
    for (const k of keys) {
      const r = ASSETS[k];
      expect(r, k).toBeDefined();
      expect(r.model).toBe(k);
      expect(r.provenance.length, k).toBeGreaterThan(10);
      expect(r.license.length, k).toBeGreaterThan(10);
      if (r.source !== 'procedural') expect(r.file, k).toMatch(/\.glb$/);
    }
    for (const v of Object.values(SCENE_VISUALS)) expect(v.license.length).toBeGreaterThan(10);
  });

  it('no third-party asset ships without source, author, licence, modification and attribution', () => {
    for (const r of Object.values(ASSETS))
      if (r.thirdParty)
        for (const f of ['source', 'author', 'license', 'modified', 'attribution'] as const)
          expect(r.thirdParty[f].length, `${r.model}.${f}`).toBeGreaterThan(0);
      else expect(r.license).toMatch(/project source/);
  });

  it('glTF and hybrid visuals are bundled files next to the manifest', () => {
    for (const r of Object.values(ASSETS))
      if (r.file)
        expect(
          readFileSync(new URL(`../src/views/scene3d/assets/${r.file}`, import.meta.url))
            .byteLength,
        ).toBeGreaterThan(1000);
  });
});

describe('physical dimensions', () => {
  it('the DevKitC board is its drawing: 27.94 x 48.26 mm, pin 1 1.30 mm from the antenna edge', () => {
    expect(ESP32_DEVKITC.pcbWidthMm).toBeCloseTo(27.94, 6);
    expect(ESP32_DEVKITC.pcbLengthMm).toBeCloseTo(48.26, 6);
    const antennaEdge = ESP32_DEVKITC.pcbCentreZMm - ESP32_DEVKITC.pcbLengthMm / 2;
    const pin1 = (1 - 10) * ESP32_DEVKITC.pinPitchMm;
    expect(pin1 - antennaEdge).toBeCloseTo(1.3, 6);
    const usbEdge = ESP32_DEVKITC.pcbCentreZMm + ESP32_DEVKITC.pcbLengthMm / 2;
    expect(usbEdge - -pin1).toBeCloseTo(1.24, 2); // drawn 1.29: the drawing's rounding
  });

  it('the authored asset matches: PCB envelope, 38 pins, the module overhang', () => {
    const root = authorEsp32DevkitC();
    const box = new THREE.Box3().setFromObject(root.getObjectByName('pcb')!);
    expect(box.max.x - box.min.x).toBeCloseTo(27.94, 2);
    expect(box.max.z - box.min.z).toBeCloseTo(48.26, 2);
    expect(box.max.y - box.min.y).toBeCloseTo(ESP32_DEVKITC.pcbThicknessMm, 2);
    const mod = new THREE.Box3().setFromObject(root.getObjectByName('module_substrate')!);
    expect(box.min.z - mod.min.z).toBeCloseTo(ESP32_DEVKITC.moduleOverhangMm, 2);
    expect(mod.max.x - mod.min.x).toBeCloseTo(18.0, 2);
    const pins = root.getObjectByName('header_pins') as THREE.Mesh;
    pins.geometry.computeBoundingBox();
    expect(pins.geometry.boundingBox!.max.x).toBeCloseTo(12.7 + ESP32_DEVKITC.pinSizeMm / 2, 3);
  });
});

describe('printed markings', () => {
  it('the stroke font draws every character the models print', () => {
    const printed = [
      ...ESP32_DEVKITC_WROOM32.pins.map((p) => silkLabel(p.headerLabel)),
      'EN',
      'Boot',
      'ESP32-DevKitC V4',
      'ESPRESSIF',
      'ESP32-WROOM-32',
      'FCC ID:2AC7Z-ESPWROOM32',
      'IC:21098-ESPWROOM32',
      'MGN4',
      'CP2102N',
      'A02853',
      '2441 A',
      'MN4',
      'S214C',
      '1YC',
      'DC POWER SUPPLY',
      'VOLTAGE',
      'CURRENT',
      'OUTPUT',
      'GND',
      '0.123456789',
    ];
    const missing = new Set<string>();
    for (const t of printed)
      for (const ch of t)
        if (!STROKE_CHARACTERS.has(ch) && !STROKE_CHARACTERS.has(ch.toUpperCase())) missing.add(ch);
    expect([...missing]).toEqual([]);
  });

  it('pin labels are printed as on the board: "IO" dropped, names kept', () => {
    expect(silkLabel('IO34')).toBe('34');
    expect(silkLabel('GND')).toBe('GND');
    expect(silkLabel('CLK')).toBe('CLK');
  });
});

describe('wire ends (presentation)', () => {
  it('an ESP32 end enters a jumper housing; a resistor end is a lead; a ground end a post', () => {
    const doc = JSON.parse(
      readFileSync(new URL('../src/examples/data/esp32-blink.json', import.meta.url), 'utf8'),
    ) as ProjectDocument;
    const s = deriveScene(doc);
    const kinds = new Set(s.wires.flatMap((w) => w.ends));
    expect(kinds).toEqual(new Set(['jumper', 'lead', 'post']));
    for (const w of s.wires)
      for (const [k, end] of w.ends.entries()) {
        const e =
          k === 0
            ? doc.layout.wires.find((x) => x.id === w.id)!.from
            : doc.layout.wires.find((x) => x.id === w.id)!.to;
        if (e.kind === 'terminal' && e.component.startsWith('U')) expect(end).toBe('jumper');
      }
    // Deterministic: the same document, the same description.
    expect(deriveScene(doc)).toEqual(s);
  });
});

describe('quality tiers', () => {
  it('software rasterisers get reduced, real GPUs full, the override wins', () => {
    expect(chooseQuality('Google SwiftShader', null)).toBe('reduced');
    expect(
      chooseQuality('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)', null),
    ).toBe('reduced');
    expect(chooseQuality('llvmpipe (LLVM 17.0.6, 256 bits)', null)).toBe('reduced');
    expect(chooseQuality('Microsoft Basic Render Driver', null)).toBe('reduced');
    expect(
      chooseQuality('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)', null),
    ).toBe('full');
    expect(chooseQuality('Apple M2', null)).toBe('full');
    expect(chooseQuality('Apple M2', 'reduced')).toBe('reduced');
    expect(chooseQuality('Google SwiftShader', 'full')).toBe('full');
    expect(chooseQuality('Apple M2', 'bogus')).toBe('full');
  });

  it('the pixel ratio is clamped: full up to 2, reduced 1', () => {
    expect(stagePixelRatio('full', 3)).toBe(2);
    expect(stagePixelRatio('full', 1.5)).toBe(1.5);
    expect(stagePixelRatio('full', 0)).toBe(1);
    expect(stagePixelRatio('reduced', 2)).toBe(1);
  });
});
