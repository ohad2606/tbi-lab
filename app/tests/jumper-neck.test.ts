/**
 * Jumper exit geometry (Sprint 10, owner review of the ESP32 header jumpers): out of a jumper
 * housing plugged on a header pin the wire leaves the housing's top face along its axis, runs
 * straight (strain relief), turns in one wide bend, never enters its own housing or a
 * neighbour's, deterministically; derived from the final 3D cable (wireShape.ts -> bentPath).
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { deriveScene, WIRE_RADIUS, type SceneDescription } from '../src/views/scene3d/scene.js';
import {
  boxDistance,
  jumperNeck,
  NECK_RADII,
  NECK_RADIUS,
  NECK_STRAIGHT,
  shapeWires,
  type NeckBox,
  type WireShape,
} from '../src/views/scene3d/wireShape.js';
import { bentPath } from '../src/views/scene3d/wires.js';
import { ESP32_ATTACH_HEIGHT, ESP32_DEVKITC } from '../src/views/scene3d/physical.js';
import { denseBench, headerBench } from '../../scripts/evidence/benches.js';

const example = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

const HALF = ESP32_DEVKITC.dupontSizeMm / 2;
const housingAt = (e: { x: number; y: number; z: number }): NeckBox => ({
  x0: e.x - HALF,
  x1: e.x + HALF,
  z0: e.z - HALF,
  z1: e.z + HALF,
  y0: 0,
  y1: e.y,
});

interface End {
  wire: string;
  color: string;
  /** The final cable from the housing's top outward, sampled every 0.25 mm. */
  path: THREE.Vector3[];
  step: number;
  housing: NeckBox;
  /** The housings of the wire's other end and of every other jumper. */
  others: NeckBox[];
}

/** Every jumper end of a scene, its cable traced out of the housing. */
function jumperEnds(desc: SceneDescription, shapes: Map<string, WireShape>): End[] {
  const all = desc.wires.flatMap((w) =>
    ([0, 1] as const)
      .filter((k) => w.ends[k] === 'jumper')
      .map((k) => ({ w, k, box: housingAt(k ? w.points.at(-1)! : w.points[0]!) })),
  );
  return all.map(({ w, k, box }) => {
    const s = shapes.get(w.id)!;
    const pts = k ? [...s.points].reverse() : s.points;
    const radii = k ? [...s.radii].reverse() : s.radii;
    const arms =
      s.arms && (k ? s.arms.map(([a, b]) => [b, a] as [number, number]).reverse() : s.arms);
    const path = bentPath(pts, radii, arms);
    const L = path.getLength();
    const n = Math.ceil(L / 0.25);
    return {
      wire: w.id,
      color: w.color,
      path: Array.from({ length: n + 1 }, (_, i) => path.getPointAt(i / n)),
      step: L / n,
      housing: box,
      others: all.filter((o) => o.box !== box).map((o) => o.box),
    };
  });
}

/** Smallest radius of curvature over the first `upTo` mm (circle through points 1 mm apart). */
function minRadius(e: End, upTo: number): number {
  const k = Math.round(1 / e.step);
  let m = Infinity;
  for (let i = k; i + k < e.path.length && i * e.step < upTo; i++) {
    const a = e.path[i - k]!;
    const b = e.path[i]!;
    const c = e.path[i + k]!;
    const area =
      new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
    if (area > 1e-9)
      m = Math.min(m, (a.distanceTo(b) * b.distanceTo(c) * c.distanceTo(a)) / (4 * area));
  }
  return m;
}

const scenes: [string, () => ProjectDocument][] = [
  ['esp32-blink', () => example('esp32-blink')],
  ['esp32-input-echo', () => example('esp32-input-echo')],
  ['esp32-bench', () => example('esp32-bench')],
  ['dense bench (ten neighbouring pins)', denseBench],
  ['header bench (both headers, header to header)', headerBench],
];

describe('jumper exit geometry', () => {
  for (const [name, make] of scenes)
    it(`${name}: exit on the housing's top, straight relief, one wide bend, no clipping`, () => {
      const desc = deriveScene(make());
      const shapes = shapeWires(desc);
      const ends = jumperEnds(desc, shapes);
      expect(ends.length).toBeGreaterThan(0);
      for (const e of ends) {
        const tag = `${name} ${e.wire}`;
        const E = e.path[0]!;
        // The exit anchor: the centre of the housing's top face (its wire opening), on the
        // housing's surface, not inside its body.
        expect(E.y, tag).toBeCloseTo(ESP32_ATTACH_HEIGHT, 6);
        expect(E.y, tag).toBeCloseTo(e.housing.y1, 6);
        expect(boxDistance(E, e.housing), tag).toBeLessThan(1e-6);
        // Strain relief: straight up the housing's axis for NECK_STRAIGHT (less the start of the
        // bend's blend).
        for (const p of e.path.filter((_, i) => i * e.step <= NECK_STRAIGHT - 0.6)) {
          expect(Math.hypot(p.x - E.x, p.z - E.z), tag).toBeLessThan(1e-3);
          expect(p.y, tag).toBeGreaterThanOrEqual(E.y - 1e-6);
        }
        // The first bend is wide: no tighter than the neck's smallest radius anywhere along the
        // first 25 mm (the route's corners: 2-3 mm; the old neck folded at about 0.5 mm).
        expect(minRadius(e, 25), tag).toBeGreaterThanOrEqual(0.95 * Math.min(...NECK_RADII));
        // No sharp immediate fold: within the first 2 mm past the straight it has turned < 30 deg.
        const i0 = Math.round(NECK_STRAIGHT / e.step);
        const i1 = Math.round((NECK_STRAIGHT + 2) / e.step);
        const t0 = e.path[i0 + 1]!.clone().sub(e.path[i0]!).normalize();
        const t1 = e.path[i1 + 1]!.clone().sub(e.path[i1]!).normalize();
        expect((t0.angleTo(t1) * 180) / Math.PI, tag).toBeLessThan(30);
        // No clipping: past the opening the jacket's surface stays clear of its own housing, and
        // all along of every other housing (the wire's other end excepted at that end).
        e.path.forEach((p, i) => {
          if (i * e.step > NECK_STRAIGHT)
            expect(boxDistance(p, e.housing) - WIRE_RADIUS, `${tag} own @${i}`).toBeGreaterThan(
              0.2,
            );
        });
        const L = e.path.length;
        for (const h of e.others)
          e.path.forEach((p, i) => {
            // A header-to-header jumper enters the far housing at its own other end.
            if ((L - 1 - i) * e.step < NECK_STRAIGHT + 1 && boxDistance(e.path[L - 1]!, h) < 1e-6)
              return;
            expect(boxDistance(p, h) - WIRE_RADIUS, `${tag} other @${i}`).toBeGreaterThan(0.2);
          });
      }
    });

  it('ESP32 blink (owner-reviewed): the orange and black jumpers both get a neck', () => {
    const desc = deriveScene(example('esp32-blink'));
    const shapes = shapeWires(desc);
    const ends = jumperEnds(desc, shapes);
    for (const color of ['#ef7d17', '#202326']) {
      const e = ends.find((x) => x.color.toLowerCase() === color)!;
      const radius = shapes.get(e.wire)!.necks![0]!;
      expect(NECK_RADII).toContain(radius);
      expect(minRadius(e, 25)).toBeGreaterThanOrEqual(0.95 * radius);
      // The neck rises from the housing before it turns down (it never folds back past it).
      const top = Math.max(...e.path.slice(0, Math.round(25 / e.step)).map((p) => p.y));
      expect(top).toBeGreaterThan(e.path[0]!.y + NECK_STRAIGHT + 0.5 * radius);
    }
  });

  it('every jumper end of the fixtures gets a neck; the widest bend where there is room', () => {
    for (const [name, make] of scenes) {
      const desc = deriveScene(make());
      const shapes = shapeWires(desc);
      for (const w of desc.wires)
        ([0, 1] as const).forEach((k) => {
          if (w.ends[k] !== 'jumper') return;
          expect(shapes.get(w.id)!.necks?.[k], `${name} ${w.id}`).toBeGreaterThanOrEqual(
            Math.min(...NECK_RADII),
          );
        });
    }
    // Ten neighbouring pins running to parts well away from the board: all of them 6 mm.
    const dense = shapeWires(deriveScene(denseBench()));
    for (const s of dense.values()) if (s.necks?.[0]) expect(s.necks[0]).toBe(NECK_RADIUS);
  });

  it('is deterministic: the same scene gives the same cables, every time', () => {
    for (const [, make] of scenes) {
      const a = shapeWires(deriveScene(make()));
      const b = shapeWires(deriveScene(make()));
      expect(b).toEqual(a);
    }
  });

  it('keeps the route when no wide bend fits (no neck is forced through anything)', () => {
    const E = { x: 0, y: 24.6, z: 0 };
    const route = [
      E,
      { x: 0, y: 27.1, z: 0 },
      { x: 0, y: 24, z: 3 },
      { x: 0, y: 0.5, z: 8 },
      { x: 0, y: 0.5, z: 40 },
    ];
    const housings = [
      housingAt(E),
      housingAt({ x: 0, y: 24.6, z: 2.54 }),
      housingAt({ x: 0, y: 24.6, z: 5.08 }),
    ];
    // A wall of housings ahead, as tall as the drop: nothing clears it.
    const wall = { x0: -30, x1: 30, z0: 1.5, z1: 30, y0: 0, y1: 60 };
    expect(jumperNeck(route, { housings: [...housings, wall], boards: [] }, 40)).toBeNull();
    const r = jumperNeck(route, { housings, boards: [] }, 40);
    expect(r).not.toBeNull();
    expect(r!.neck[1]).toMatchObject({ x: 0, y: E.y + NECK_STRAIGHT, z: 0 });
  });
});
