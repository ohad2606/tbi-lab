/**
 * The workbench (realism pass 4): a finite ESD work mat under the circuit (its top is the bench
 * plane every part stands on), and the soft contact shadows under the parts. Pure geometry: no
 * WebGL.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { deriveScene } from '../src/views/scene3d/scene.js';
import { contactShadows, matGeometry, MAT_T } from '../src/views/scene3d/stage.js';
import { footprintRect } from '../src/views/scene3d/labels.js';

const example = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

describe('workbench', () => {
  it('the mat: its top is the bench plane (y = 0), MAT_T thick, the size asked for', () => {
    const geo = matGeometry(300, 200);
    geo.computeBoundingBox();
    const b = geo.boundingBox!;
    expect(b.max.y).toBeCloseTo(0, 6);
    expect(b.min.y).toBeCloseTo(-MAT_T, 6);
    expect(b.max.x - b.min.x).toBeCloseTo(300, 3);
    expect(b.max.z - b.min.z).toBeCloseTo(200, 3);
    // Two material groups: the top/bottom and the edge.
    expect(new Set(geo.groups.map((g) => g.materialIndex))).toEqual(new Set([0, 1]));
  });

  it('contact shadows: one soft 9-slice quad per part, under it, on the mat, one mesh', () => {
    const desc = deriveScene(example('esp32-bench'));
    const geo = contactShadows(desc, 1)!;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    expect(pos.count).toBe(16 * desc.components.length);
    expect(col.itemSize).toBe(4);
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeGreaterThan(0);
      expect(pos.getY(i)).toBeLessThan(0.05);
      // Faint: never a black blob.
      expect(col.getW(i)).toBeGreaterThan(0);
      expect(col.getW(i)).toBeLessThanOrEqual(0.5);
    }
    // Each part's quad is centred on the part's body (within its footprint).
    desc.components.forEach((c, k) => {
      let x = 0;
      let z = 0;
      for (let i = 0; i < 16; i++) {
        x += pos.getX(16 * k + i) / 16;
        z += pos.getZ(16 * k + i) / 16;
      }
      const r = footprintRect(c);
      expect(x, c.id).toBeGreaterThanOrEqual(r.x0 - 1e-6);
      expect(x, c.id).toBeLessThanOrEqual(r.x1 + 1e-6);
      expect(z, c.id).toBeGreaterThanOrEqual(r.z0 - 1e-6);
      expect(z, c.id).toBeLessThanOrEqual(r.z1 + 1e-6);
    });
  });
});
