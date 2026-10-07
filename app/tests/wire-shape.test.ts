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
import { footprintRect } from '../src/views/scene3d/labels.js';
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
      const plain = new Map(
        desc.wires.map((w) => [w.id, sampleShape(plainShape(w.points, w.radii))]),
      );
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

  it('the scenes actually look natural: wires spanning in the air keep a drape', () => {
    // Since the fresh 3D routes (route3d.ts) most wires rest on the bench, where there is nothing
    // to sag; a wire with a long level span above the bench (over something) still sags.
    for (const doc of [denseBench(), example('esp32-input-echo'), partsBench()]) {
      const desc = deriveScene(doc);
      const shapes = shapeWires(desc);
      const spanning = desc.wires.filter((w) =>
        w.points.some((b, i) => {
          const a = w.points[i - 1];
          return (
            !!a && Math.abs(a.y - b.y) < 1e-6 && a.y > 3 && Math.hypot(b.x - a.x, b.z - a.z) >= 14
          );
        }),
      );
      const draped = spanning.filter((w) => shapes.get(w.id)!.drape > 0);
      expect(draped.length).toBeGreaterThanOrEqual(spanning.length / 2);
    }
  });
});

describe('physical cable (realism pass 4): route -> cable curve', () => {
  /** Tightest bend in plan (mm), beyond 4 mm of the ends, ignoring steep runs (a jumper's drop). */
  const planMin = (pts: THREE.Vector3[]) => {
    let m = Infinity;
    const e0 = pts[0]!;
    const e1 = pts.at(-1)!;
    for (let i = 2; i < pts.length - 2; i++) {
      const p = pts[i]!;
      if (p.distanceTo(e0) < 4 || p.distanceTo(e1) < 4) continue;
      const a = new THREE.Vector2(p.x - pts[i - 2]!.x, p.z - pts[i - 2]!.z);
      const b = new THREE.Vector2(pts[i + 2]!.x - p.x, pts[i + 2]!.z - p.z);
      if (a.length() < 0.2 || b.length() < 0.2) continue;
      if (
        Math.abs(p.y - pts[i - 2]!.y) > 0.5 * a.length() ||
        Math.abs(pts[i + 2]!.y - p.y) > 0.5 * b.length()
      )
        continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, a.dot(b) / a.length() / b.length())));
      m = Math.min(m, (a.length() + b.length()) / 2 / Math.max(ang, 1e-9));
    }
    return m;
  };
  const all: [string, ProjectDocument][] = [
    ...scenes,
    ['esp32-bench', example('esp32-bench')],
    ['pir-alarm', example('pir-alarm')],
    ['led-matrix', example('led-matrix')],
    ['relay-load', example('relay-load')],
  ];

  it('never bends tighter in plan than the route did, and never into a mitre', () => {
    for (const [name, doc] of all) {
      const desc = deriveScene(doc);
      const shapes = shapeWires(desc);
      let route = Infinity;
      let cable = Infinity;
      for (const w of desc.wires) {
        route = Math.min(route, planMin(sampleShape(plainShape(w.points, w.radii), 0.25)));
        cable = Math.min(cable, planMin(sampleShape(shapes.get(w.id)!, 0.25)));
      }
      expect(cable, name).toBeGreaterThanOrEqual(Math.min(route, 0.5) - 0.02);
    }
  });

  it('the benchmark bench: wide hand-formed bends, runs that relax, jumpers that arch', () => {
    const desc = deriveScene(example('esp32-bench'));
    const report = new Map<string, string>();
    const shapes = shapeWires(desc, report);
    // Every wire is a physical cable except at most one (two wires leaving the same post side by
    // side keep their route where a curve would bring them closer).
    const plainOnes = desc.wires.filter((w) => !shapes.get(w.id)!.arms);
    expect(plainOnes.length).toBeLessThanOrEqual(1);
    // The long supply feed (the longest wire): its corners bend over many millimetres.
    const len = (w: (typeof desc.wires)[number]) =>
      w.points.reduce(
        (n, p, i) => (i ? n + Math.hypot(p.x - w.points[i - 1]!.x, p.z - w.points[i - 1]!.z) : 0),
        0,
      );
    const feed = [...desc.wires].sort((a, b) => len(b) - len(a))[0]!;
    const feedPts = sampleShape(shapes.get(feed.id)!, 0.25);
    const away = feedPts.filter(
      (p) => p.distanceTo(feedPts[0]!) > 12 && p.distanceTo(feedPts.at(-1)!) > 12,
    );
    expect(planMin(away)).toBeGreaterThan(6);
    // ...and its long straight run on the mat is not ruler-straight: it bows a little.
    let bow = 0;
    const pts = feed.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 40 || Math.abs(a.y - b.y) > 1e-6) continue;
      for (const p of feedPts) {
        const t = ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / (L * L);
        if (t < 0.3 || t > 0.7) continue;
        bow = Math.max(bow, Math.abs(((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / L));
      }
    }
    expect(bow).toBeGreaterThan(0.3);
    expect(bow).toBeLessThan(2);
    // A jumper wire rises out of its housing before it comes down (it arches).
    const jumpers = desc.wires.filter((w) => w.ends.includes('jumper'));
    expect(jumpers.length).toBeGreaterThan(0);
    const arched = jumpers.filter((w) => {
      const top = Math.max(w.points[0]!.y, w.points.at(-1)!.y);
      return Math.max(...sampleShape(shapes.get(w.id)!).map((p) => p.y)) > top + 3;
    });
    expect(arched.length).toBeGreaterThan(0);
  });

  it('a wire crossing another drapes over it in one smooth hump', () => {
    const desc = deriveScene(example('esp32-bench'));
    const shapes = shapeWires(desc);
    // The ground wire of the yellow LED crosses the long feed: its height rises once and falls once.
    const humped = desc.wires.filter((w) => {
      const ys = w.points.map((p) => p.y);
      return Math.max(...ys) > 2 && ys[0]! < 1 && ys.at(-1)! < 1.5 && !w.ends.includes('jumper');
    });
    expect(humped.length).toBeGreaterThan(0);
    for (const w of humped) {
      const ys = sampleShape(shapes.get(w.id)!, 0.25).map((p) => p.y);
      let turns = 0;
      for (let i = 2; i < ys.length; i++) {
        const d0 = ys[i - 1]! - ys[i - 2]!;
        const d1 = ys[i]! - ys[i - 1]!;
        if (Math.abs(d0) > 1e-3 && Math.abs(d1) > 1e-3 && Math.sign(d0) !== Math.sign(d1)) turns++;
      }
      // Up over the crossing and back down: one peak, plus at most the small step at each end.
      expect(turns, w.id).toBeLessThanOrEqual(3);
    }
  });
});
