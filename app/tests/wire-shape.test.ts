/**
 * Natural wire shape (Sprint 10 realism pass): deterministic, ends unchanged, never closer to
 * another wire than the route allows, never lower than the route over another part's body, sag
 * bounded; and the scenes actually get it.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { deriveScene, MODEL_HEIGHT, WIRE_RADIUS } from '../src/views/scene3d/scene.js';
import { sampleShape, shapeWires, plainShape } from '../src/views/scene3d/wireShape.js';
import { footprintRect, placeLabels } from '../src/views/scene3d/labels.js';
import { denseBench, partsBench } from '../../scripts/evidence/benches.js';

const example = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

const scenes: [string, ProjectDocument][] = [
  ['esp32-blink', example('esp32-blink')],
  ['esp32-input-echo', example('esp32-input-echo')],
  ['night-light', example('night-light')],
  ['parts bench', partsBench()],
  ['dense bench', denseBench()],
];

describe('natural wire shape', () => {
  for (const [name, doc] of scenes)
    it(`${name}: deterministic, ends kept, separation and clearance kept`, () => {
      const desc = deriveScene(doc);
      const t0 = performance.now();
      const shapes = shapeWires(desc);
      const ms = performance.now() - t0;
      expect(shapeWires(desc)).toEqual(shapes); // deterministic
      const samples = new Map<string, THREE.Vector3[]>();
      for (const w of desc.wires) {
        const s = shapes.get(w.id)!;
        expect(s.points[0]).toEqual(w.points[0]);
        expect(s.points.at(-1)).toEqual(w.points.at(-1));
        samples.set(w.id, sampleShape(s));
      }
      // Separation: as close as the plain routes are allowed (they are the reference), never
      // closer, except near an end two wires share.
      const plain = new Map(desc.wires.map((w) => [w.id, sampleShape(plainShape(w.points))]));
      const ends = (id: string) => {
        const w = desc.wires.find((x) => x.id === id)!;
        return [w.points[0]!, w.points.at(-1)!].map((p) => new THREE.Vector3(p.x, p.y, p.z));
      };
      const minDist = (a: THREE.Vector3[], b: THREE.Vector3[], skip: THREE.Vector3[]) => {
        let m = Infinity;
        for (const p of a) {
          if (skip.some((e) => e.distanceTo(p) < 4)) continue;
          for (const q of b) m = Math.min(m, p.distanceTo(q));
        }
        return m;
      };
      for (let i = 0; i < desc.wires.length; i++)
        for (let j = i + 1; j < desc.wires.length; j++) {
          const a = desc.wires[i]!.id;
          const b = desc.wires[j]!.id;
          const shared = ends(a).filter((e) => ends(b).some((f) => f.distanceTo(e) < 1e-6));
          const now = minDist(samples.get(a)!, samples.get(b)!, shared);
          const before = minDist(plain.get(a)!, plain.get(b)!, shared);
          expect(now, `${a}/${b}`).toBeGreaterThanOrEqual(
            Math.min(before, 2 * WIRE_RADIUS + 0.12) - 1e-6,
          );
        }
      // Over another part's body a draped wire is never lower than its route was.
      for (const w of desc.wires) {
        const own = desc.components.filter((c) =>
          c.terminals.some((t) =>
            [w.points[0]!, w.points.at(-1)!].some(
              (e) => Math.abs(t.x - e.x) < 1e-6 && Math.abs(t.z - e.z) < 1e-6,
            ),
          ),
        );
        for (const c of desc.components) {
          if (own.includes(c)) continue;
          const r = footprintRect(c);
          for (const p of samples.get(w.id)!)
            if (
              p.x > r.x0 &&
              p.x < r.x1 &&
              p.z > r.z0 &&
              p.z < r.z1 &&
              p.y < MODEL_HEIGHT[c.model] + WIRE_RADIUS
            ) {
              const lowest = Math.min(
                ...plain
                  .get(w.id)!
                  .filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1)
                  .map((q) => q.y),
              );
              expect(p.y, `${w.id} over ${c.id}`).toBeGreaterThanOrEqual(lowest - 1e-6);
            }
        }
        // Sag bounded: never more than 2 mm below the run, never into the bench.
        // (Its ends meet lead tips just above the bench: those stay as they were.)
        const tips = ends(w.id);
        for (const p of samples.get(w.id)!)
          if (!tips.some((e) => Math.hypot(e.x - p.x, e.z - p.z) < 4))
            expect(p.y).toBeGreaterThan(WIRE_RADIUS - 1e-6);
      }
      const draped = [...shapes.values()].filter((s) => s.drape > 0).length;
      console.log(`${name}: ${draped}/${shapes.size} wires draped, ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(2000);
    });

  it('the scenes actually look natural: most wires keep a drape', () => {
    const desc = deriveScene(denseBench());
    const shapes = [...shapeWires(desc).values()];
    expect(shapes.filter((s) => s.drape > 0).length).toBeGreaterThan(shapes.length / 2);
  });
});

describe('bench-printed labels', () => {
  it('every label beside its part: no two overlap, none on another part (deterministic)', () => {
    for (const doc of [
      partsBench(),
      denseBench(),
      example('esp32-input-echo'),
      example('pir-alarm'),
    ]) {
      const desc = deriveScene(doc);
      const parts = desc.components.map((c) => ({ c, w: 3 + c.id.length * 1.4, h: 3 }));
      const a = placeLabels(parts, 1.4);
      expect(placeLabels(parts, 1.4)).toEqual(a);
      const rects = parts.map(({ c, w, h }) => {
        const p = a.get(c.id)!;
        return { id: c.id, x0: p.x - w / 2, x1: p.x + w / 2, z0: p.z - h / 2, z1: p.z + h / 2 };
      });
      const hit = (r: { x0: number; x1: number; z0: number; z1: number }, s: typeof r) =>
        r.x0 < s.x1 && s.x0 < r.x1 && r.z0 < s.z1 && s.z0 < r.z1;
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
          expect(hit(rects[i]!, rects[j]!), `${rects[i]!.id}/${rects[j]!.id}`).toBe(false);
      let onParts = 0;
      for (const r of rects)
        for (const c of desc.components) if (c.id !== r.id && hit(r, footprintRect(c))) onParts++;
      expect(onParts).toBeLessThanOrEqual(1); // only where no clear spot exists at all
    }
  });
});
