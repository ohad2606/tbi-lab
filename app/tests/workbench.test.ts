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
import { CONTACT_LEVELS, contactShadows, matGeometry, MAT_T } from '../src/views/scene3d/stage.js';
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

  it('contact shadows: one soft 9-slice quad per part, under it, on the mat, one mesh, no extra program', () => {
    const desc = deriveScene(example('esp32-bench'));
    const geo = contactShadows(desc, 1)!;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    expect(pos.count).toBe(16 * desc.components.length);
    // No per-vertex colour: the strength lives in the texture atlas (no extra shader variant).
    expect(geo.getAttribute('color')).toBeUndefined();
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeGreaterThan(0);
      expect(pos.getY(i)).toBeLessThan(0.05);
    }
    // Each part's quad stays inside one strength band of the atlas (faint: at most 0.45).
    const B = CONTACT_LEVELS.length;
    expect(Math.max(...CONTACT_LEVELS)).toBeLessThanOrEqual(0.5);
    desc.components.forEach((c, k) => {
      const vs = Array.from({ length: 16 }, (_, i) => uv.getY(16 * k + i));
      const band = Math.floor(Math.min(...vs) * B + 1e-6);
      expect(Math.max(...vs), c.id).toBeLessThanOrEqual((band + 1) / B + 1e-6);
    });
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

describe('depth of field (realism pass 7)', () => {
  it('is shallow close up, nearly absent over the whole bench, and capped', async () => {
    const { circleOfConfusion, DOF_MAX } = await import('../src/views/scene3d/dof.js');
    // In the focus plane: sharp.
    expect(circleOfConfusion(40, 40)).toBe(0);
    // A part twice as far as a 40 mm close-up focus: clearly soft (over 0.4 % of the frame).
    expect(circleOfConfusion(80, 40)).toBeGreaterThan(0.004);
    // The same relative depth over the whole bench (focus 250 mm): under a third of that.
    expect(circleOfConfusion(500, 250)).toBeLessThan(circleOfConfusion(80, 40) / 3);
    // Never more than the cap, however far.
    expect(circleOfConfusion(1e6, 30)).toBeLessThanOrEqual(DOF_MAX);
  });
  it('autofocuses on what is at the centre, never beyond the orbit target', async () => {
    const { autofocus, DOF_FOCUS_RANGE } = await import('../src/views/scene3d/dof.js');
    // Something nearer than the target at the centre (zooming towards it): in focus.
    expect(autofocus(70, 100)).toBe(70);
    // Mat or backdrop behind the subject at the centre: the target stays in focus.
    expect(autofocus(140, 100)).toBe(100);
    expect(autofocus(5000, 100)).toBe(100);
    // A lead passing close to the lens does not throw the bench out of focus.
    expect(autofocus(2, 100)).toBe(100 / DOF_FOCUS_RANGE);
  });
});
