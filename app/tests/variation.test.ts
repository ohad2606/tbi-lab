/**
 * Deterministic material variation (realism pass 8, variation.ts): same part, same look, every
 * time; small ranges; nothing that carries meaning is varied; no material per part.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import {
  FAMILIES,
  familyOf,
  hash32,
  pieceIndex,
  pieceOffsets,
  variationAttribute,
  variedMaterial,
} from '../src/views/scene3d/variation.js';
import { createMaterials } from '../src/views/scene3d/models.js';
import { authorEsp32DevkitC } from '../src/views/scene3d/assets/esp32DevkitC.author.js';

const attr = (seed: string, family = FAMILIES.blackPlastic!) => {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  return Array.from(variationAttribute(family, geo, geo.toNonIndexed(), seed).array);
};

describe('deterministic material variation', () => {
  it('the same component id gives the same finish, on every build (no runtime randomness)', () => {
    expect(hash32('R1/body/1')).toBe(hash32('R1/body/1'));
    expect(attr('R1/body/1')).toEqual(attr('R1/body/1'));
    // Fresh geometries (a reload): identical.
    const a = attr('U1/header_housing/3');
    const b = attr('U1/header_housing/3');
    expect(a).toEqual(b);
  });

  it('different ids may differ, within the family range', () => {
    const f = FAMILIES.blackPlastic!;
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const [r, v, d] = pieceOffsets(f, `R${i}/body/1`);
      expect(Math.abs(r)).toBeLessThanOrEqual(f.rough);
      expect(Math.abs(v)).toBeLessThanOrEqual(f.value);
      expect(d).toBe(f.detail);
      seen.add(`${r.toFixed(4)},${v.toFixed(4)}`);
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it('ranges are restrained: roughness <= 0.08, brightness <= 3 %', () => {
    for (const f of Object.values(FAMILIES)) {
      expect(f.rough).toBeLessThanOrEqual(0.08);
      expect(f.value).toBeLessThanOrEqual(0.03);
      expect(f.detail).toBeLessThanOrEqual(1.5);
    }
  });

  it('never varies what carries meaning: colour bands, LEDs, the PCB, net colours, metal value', () => {
    const lib = createMaterials();
    for (const k of ['pcb', 'pcbEdge', 'moduleBoard', 'glass', 'cathodeBand', 'smdLed', 'generic'])
      expect(familyOf(lib[k as keyof typeof lib])).toBeNull();
    // Colour that must match between parts: finish only.
    expect(FAMILIES.resistorBody!.value).toBe(0);
    expect(FAMILIES.wire_jacket!.value).toBe(0);
    expect(FAMILIES.led_body!.value).toBe(0);
    expect(FAMILIES.red!.value).toBe(0);
    // No LED lens, band, marking or board-face family.
    for (const name of Object.keys(FAMILIES))
      expect(name).not.toMatch(/lens|band|mark|pcb_|silk|module_top/);
    // The asset: its board faces, markings and LED lens are not varied.
    const names = new Set<string>();
    authorEsp32DevkitC().traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && familyOf(m)) names.add(m.name);
    });
    for (const n of ['pcb_top', 'pcb_bottom', 'module_top', 'markings', 'power_led_lens'])
      expect(names.has(n)).toBe(false);
    expect(names.has('header_pbt')).toBe(true);
    expect(names.has('ic_mould')).toBe(true);
    expect(names.has('chip_substrate')).toBe(true);
  });

  it('a piece is a connected part: two merged boxes are two pieces; a hard-edged box is one', () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    expect(new Set(pieceIndex(box.attributes.position!.array, box.index!.array)).size).toBe(1);
    const two = mergeGeometries([box.clone(), box.clone().translate(3, 0, 0)])!;
    expect(new Set(pieceIndex(two.attributes.position!.array, two.index!.array)).size).toBe(2);
  });

  it('header pins vary pin by pin; a header strip is one moulding (one finish per side)', () => {
    const root = authorEsp32DevkitC();
    const housing = root.getObjectByName('header_housing') as THREE.Mesh;
    const pins = root.getObjectByName('header_pins') as THREE.Mesh;
    const distinct = (mesh: THREE.Mesh) => {
      const f = familyOf(mesh.material as THREE.Material)!;
      const a = variationAttribute(f, mesh.geometry, mesh.geometry.toNonIndexed(), 'U1/x/1');
      const s = new Set<string>();
      for (let i = 0; i < a.count; i++) s.add(`${a.getX(i)},${a.getY(i)}`);
      return s.size;
    };
    expect(distinct(housing)).toBe(2);
    expect(distinct(pins)).toBe(38);
  });

  it('one varied material per family and one shader program for all of them', () => {
    const lib = createMaterials();
    const a = variedMaterial(lib.blackPlastic);
    const b = variedMaterial(lib.lead);
    expect(a).not.toBe(lib.blackPlastic);
    expect(a.color.getHexString()).toBe(lib.blackPlastic.color.getHexString());
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(a.userData.varied).toBe(true);
    // The original (shared, maybe a glTF template) is never modified.
    expect(lib.blackPlastic.userData.varied).toBeUndefined();
  });
});
