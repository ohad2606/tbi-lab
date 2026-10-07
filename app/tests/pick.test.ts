/**
 * 3D picking (Sprint 10, limited 3D interaction): a click resolves to a LOGICAL entity, never a
 * mesh: a part (any of its pieces: body, lead, post, jumper housing), a wire, or nothing (bench,
 * labels). Pure: on the scene description, the parts' volumes and the drawn wire shapes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { deriveScene, sceneObstacles } from '../src/views/scene3d/scene.js';
import { actuators, pick, type Ray } from '../src/views/scene3d/pick.js';
import { shapeWires, sampleShape } from '../src/views/scene3d/wireShape.js';
import { placeLabels } from '../src/views/scene3d/labels.js';

const example = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

/** A ray straight down onto a plan point, from high above. */
const down = (x: number, z: number): Ray => ({ origin: [x, 200, z], dir: [0, -1, 0] });
/** A slanted ray (as from a three-quarter camera) through a point. */
const slant = (x: number, y: number, z: number): Ray => ({
  origin: [x - 60, y + 90, z + 80],
  dir: [60, -90, -80],
});

describe('3D picking', () => {
  const doc = example('pir-alarm');
  const scene = deriveScene(doc);
  const obstacles = sceneObstacles(doc, scene);
  const shapes = shapeWires(scene);

  it('a click on a part selects that part, from any angle', () => {
    for (const c of scene.components) {
      if (c.model === 'ground.post') continue; // its post is off-centre; tested below
      expect(pick(down(c.x, c.z), scene, obstacles, shapes), c.id).toEqual({
        kind: 'component',
        id: c.id,
      });
    }
    const u1 = scene.components.find((c) => c.id === 'U1')!;
    expect(pick(slant(u1.x, 15, u1.z), scene, obstacles, shapes)).toEqual({
      kind: 'component',
      id: 'U1',
    });
  });

  it("a click on a part's child piece (a lead, the PIR's pin header) selects the part", () => {
    // The transistor's base lead, halfway out to its terminal.
    const q1 = scene.components.find((c) => c.id === 'Q1')!;
    const base = q1.terminals.find((t) => t.id === 'base')!;
    const mid = { x: (q1.x + base.x) / 2, z: (q1.z + base.z) / 2 };
    expect(pick(down(mid.x, mid.z), scene, obstacles, shapes)).toEqual({
      kind: 'component',
      id: 'Q1',
    });
    // The PIR's pin header, seen from the side under the board (along the header's row).
    const u1 = scene.components.find((c) => c.id === 'U1')!;
    const pin = u1.terminals[0]!;
    const side: Ray = { origin: [pin.x, 3, pin.z - 40], dir: [0, 0, 1] };
    expect(pick(side, scene, obstacles, shapes)).toEqual({ kind: 'component', id: 'U1' });
  });

  it('a click on a wire selects that wire', () => {
    for (const w of scene.wires) {
      const pts = sampleShape(shapes.get(w.id)!);
      const p = pts[Math.floor(pts.length / 2)]!;
      // Skip a midpoint that lies over a part (the part would be nearer from above).
      const hit = pick(
        { origin: [p.x, p.y + 100, p.z], dir: [0, -1, 0] },
        scene,
        obstacles,
        shapes,
      );
      if (hit?.kind === 'component') continue;
      expect(hit, w.id).toEqual({ kind: 'wire', id: w.id });
    }
  });

  it('the bench and the printed labels select nothing', () => {
    const far = scene.base;
    expect(pick(down(far.minX + 1, far.minZ + 1), scene, obstacles, shapes)).toBeNull();
    const at = placeLabels(
      scene.components.map((c) => ({ c, w: 3 + c.id.length * 1.4, h: 3 })),
      1.4,
    );
    let checked = 0;
    for (const c of scene.components) {
      const p = at.get(c.id)!;
      const hit = pick(down(p.x, p.z), scene, obstacles, shapes);
      // A label lies on the bench: it never selects a part (a wire may run across it).
      if (hit?.kind === 'component') expect(hit.id, `label ${c.id}`).not.toBe(c.id);
      checked++;
    }
    expect(checked).toBe(scene.components.length);
  });

  it('is deterministic and cheap', () => {
    const r = slant(0, 5, 10);
    expect(pick(r, scene, obstacles, shapes)).toEqual(pick(r, scene, obstacles, shapes));
    const t = performance.now();
    for (let i = 0; i < 20; i++) pick(slant(i, 3, i), scene, obstacles, shapes);
    expect((performance.now() - t) / 20).toBeLessThan(20);
  });
});

describe('3D picking: physical controls (operated during a simulation)', () => {
  const doc = example('esp32-input-echo'); // SW1 toggle switch, SW2 push button
  const scene = deriveScene(doc);
  const obstacles = sceneObstacles(doc, scene);
  const shapes = shapeWires(scene);
  const regions = actuators(scene);

  it('each toggle switch and push button has an actuator region from its real dimensions', () => {
    expect(regions.map((a) => [a.id, a.control])).toEqual([
      ['SW1', 'toggle'],
      ['SW2', 'momentary'],
    ]);
    const sw2 = regions.find((a) => a.id === 'SW2')!.box;
    // The cap only: ~4.5 mm across, above the switch body's cover.
    expect(sw2.x1 - sw2.x0).toBeLessThan(5);
    expect(sw2.bottom).toBeGreaterThan(3);
  });

  it('while running, the lever and the cap operate; the rest of the part selects it', () => {
    for (const a of regions) {
      const cx = (a.box.x0 + a.box.x1) / 2;
      const cz = (a.box.z0 + a.box.z1) / 2;
      expect(pick(down(cx, cz), scene, obstacles, shapes, true)).toEqual({
        kind: 'actuator',
        id: a.id,
        control: a.control,
      });
      // Stopped (no actuators): the same click selects the part.
      expect(pick(down(cx, cz), scene, obstacles, shapes, false)).toEqual({
        kind: 'component',
        id: a.id,
      });
    }
    // The toggle's body below the lever, from the side: the part, not its lever.
    const sw1 = scene.components.find((c) => c.id === 'SW1')!;
    const side: Ray = { origin: [sw1.x, 3, sw1.z + 40], dir: [0, 0, -1] };
    expect(pick(side, scene, obstacles, shapes, true)).toEqual({ kind: 'component', id: 'SW1' });
  });
});
