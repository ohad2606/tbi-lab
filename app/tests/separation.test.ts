/**
 * Visual-only separation of physical bodies (Sprint 10 owner review; separation.ts): parts placed
 * acceptably in 2D whose real 3D bodies overlap are moved apart in the derived scene only. The
 * project (coordinates, rotations, connections) never changes; terminals, wires, contacts and
 * labels follow the final 3D position.
 */
import { describe, expect, it } from 'vitest';
import {
  connectivity,
  contacts,
  createPackage,
  parsePackage,
  serializePackage,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  collisionBodies,
  deriveScene,
  SCALE,
  touchingNodes,
  type SceneDescription,
} from '../src/views/scene3d/scene.js';
import {
  bodiesCollide,
  GAP,
  MAX_CAP,
  separateBodies,
  worldBoxes,
  type Body,
} from '../src/views/scene3d/separation.js';
import { shapeWires } from '../src/views/scene3d/wireShape.js';
import { footprintRect, placeLabels } from '../src/views/scene3d/labels.js';
import { componentBox } from '../src/ui/routing.js';
import { EXAMPLE_DOCUMENTS } from '../src/examples/documents.js';
import {
  contactOverlapCircuit,
  denseMixedCircuit,
  esp32ModuleCircuit,
  passivesCircuit,
  pirMatrixCircuit,
} from './separationFixtures.js';

/** Bodies at the 2D-derived (base) transform. */
const bases = (doc: ProjectDocument) => collisionBodies(doc);
/** Bodies at the final scene transform. */
const finals = (doc: ProjectDocument, s: SceneDescription): Body[] =>
  collisionBodies(doc).map((b) => {
    const c = s.components.find((x) => x.id === b.id)!;
    return { ...b, x: c.x, z: c.z };
  });
const overlapping = (bodies: Body[], groups: string[][] = []) => {
  const together = (a: string, b: string) => groups.some((g) => g.includes(a) && g.includes(b));
  const out: string[] = [];
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++)
      if (!together(bodies[i]!.id, bodies[j]!.id) && bodiesCollide(bodies[i]!, bodies[j]!))
        out.push([bodies[i]!.id, bodies[j]!.id].sort().join('+'));
  return out;
};
const boxesOverlap2D = (doc: ProjectDocument, a: string, b: string) => {
  const p = componentBox(
    doc,
    doc.components.find((c) => c.id === a)!,
  );
  const q = componentBox(
    doc,
    doc.components.find((c) => c.id === b)!,
  );
  return p.minX < q.maxX && q.minX < p.maxX && p.minY < q.maxY && q.minY < p.maxY;
};

/** The scene's terminals follow their part: base attach point + the part's offset, same node. */
function expectTerminalsFollow(doc: ProjectDocument, s: SceneDescription) {
  const g = connectivity(doc);
  for (const c of s.components) {
    const p = doc.layout.components[c.id]!;
    const dx = c.x - p.x * SCALE;
    const dz = c.z - p.y * SCALE;
    const moved = s.separation.moved.find((m) => m.id === c.id);
    expect(dx).toBeCloseTo(moved?.dx ?? 0, 9);
    expect(dz).toBeCloseTo(moved?.dz ?? 0, 9);
    for (const t of c.terminals) expect(t.node).toBe(g.nodeOf.get(`${c.id}:${t.id}`) ?? null);
  }
  // Every wire ends exactly on its terminals' final attach points (never the pre-separation one).
  for (const w of doc.layout.wires) {
    const sw = s.wires.find((x) => x.id === w.id)!;
    ([w.from, w.to] as const).forEach((e, k) => {
      if (e.kind !== 'terminal') return;
      const t = s.components
        .find((c) => c.id === e.component)!
        .terminals.find((x) => x.id === e.terminal)!;
      const end = k === 0 ? sw.points[0]! : sw.points.at(-1)!;
      expect(end, `${w.id} end ${k}`).toEqual({ x: t.x, y: t.y, z: t.z });
    });
  }
  // The natural wire shape (sag, bends) is computed from the final scene and keeps the ends.
  const shapes = shapeWires(s);
  for (const w of s.wires) {
    const sh = shapes.get(w.id)!;
    expect(sh.points[0]).toEqual(w.points[0]);
    expect(sh.points.at(-1)).toEqual(w.points.at(-1));
  }
}

describe('3D bodies: visual-only separation', () => {
  it('A. PIR + LED matrix: apart in 3D, unchanged in 2D, wires on the moved pins', () => {
    const doc = pirMatrixCircuit();
    const before = structuredClone(doc);
    expect(boxesOverlap2D(doc, 'DS1', 'U1')).toBe(false); // acceptable in the Circuit view
    const s = deriveScene(doc);
    expect(doc).toEqual(before); // the project is never touched
    expect(overlapping(bases(doc))).toContain('DS1+U1'); // the real bodies would intersect
    expect(overlapping(finals(doc, s))).toEqual([]);
    expect(s.separation.unresolved).toEqual([]);
    // One module moves (the smaller PIR board), the matrix stays: not both.
    expect(s.separation.moved.map((m) => m.id)).toEqual(['U1']);
    const m = s.separation.moved[0]!;
    expect(m.dz).toBe(0); // along one plan axis, away from the matrix
    expect(m.dx).toBeGreaterThan(0);
    // The smallest clearing move: the bodies end GAP apart.
    const f = finals(doc, s);
    const ds1 = worldBoxes(f.find((b) => b.id === 'DS1')!)[0]!;
    const u1 = Math.min(...worldBoxes(f.find((b) => b.id === 'U1')!).map((b) => b.x0));
    expect(u1 - ds1.x1).toBeCloseTo(GAP, 6);
    // No wire or terminal of one node touches another node in the moved scene.
    expect(touchingNodes(s)).toEqual([]);
    // Orientation and height kept.
    const c = s.components.find((x) => x.id === 'U1')!;
    expect(c.rotation).toBe(doc.layout.components.U1!.rotation);
    expectTerminalsFollow(doc, s);
  });

  it('B. a large module beside the ESP32 never reaches into the board; the board stays', () => {
    const doc = esp32ModuleCircuit();
    expect(boxesOverlap2D(doc, 'U1', 'U2')).toBe(false);
    const s = deriveScene(doc);
    expect(overlapping(bases(doc))).toContain('U1+U2');
    expect(overlapping(finals(doc, s))).toEqual([]);
    expect(s.separation.moved.map((m) => m.id)).toEqual(['U2']);
    expect(s.separation.moved[0]!.dx).toBeLessThan(0); // outward, away from the board
    expectTerminalsFollow(doc, s);
  });

  it('a dense mixed bench: every body clear, small moves, the board and passives in place', () => {
    const doc = denseMixedCircuit();
    const s = deriveScene(doc);
    expect(overlapping(bases(doc)).length).toBeGreaterThan(0);
    expect(overlapping(finals(doc, s))).toEqual([]);
    expect(s.separation.unresolved).toEqual([]);
    expect(touchingNodes(s)).toEqual([]);
    for (const m of s.separation.moved) expect(Math.hypot(m.dx, m.dz)).toBeLessThan(10);
    const moved = s.separation.moved.map((m) => m.id);
    for (const id of ['U1', 'R1', 'R2', 'R3', 'D1', 'D2']) expect(moved).not.toContain(id);
    expectTerminalsFollow(doc, s);
  });

  it('C. ordinary close passives (resistors, LEDs, a diode) are not separated', () => {
    const doc = passivesCircuit();
    const s = deriveScene(doc);
    expect(s.separation).toEqual({ moved: [], unresolved: [] });
    // Nor any curated example but the PIR alarm (whose PIR board reaches over a ground post).
    for (const [id, d] of Object.entries(EXAMPLE_DOCUMENTS)) {
      const sep = deriveScene(d).separation;
      expect(sep.unresolved, id).toEqual([]);
      if (id !== 'pir-alarm') expect(sep.moved, id).toEqual([]);
    }
  });

  it('D. parts joined by a direct contact touch on purpose and are never pushed apart', () => {
    const doc = contactOverlapCircuit();
    expect(contacts(doc)).toHaveLength(1);
    const s = deriveScene(doc);
    expect(overlapping(bases(doc))).toContain('R1+R2'); // they do overlap...
    expect(s.separation).toEqual({ moved: [], unresolved: [] }); // ...and stay
    const joint = s.joints.find((j) => j.kind === 'contact')!;
    expect(joint.terminals).toEqual(['R1:b', 'R2:a']);
    // A contact cluster moves as one: shifted together, the joint still joins both leads.
    const matrix = collisionBodies(pirMatrixCircuit()).find((b) => b.id === 'DS1')!;
    const r = separateBodies(
      [...bases(doc), { ...matrix, id: 'X', x: 15.9 + 20, z: 31.75 }],
      [['R1', 'R2']],
    );
    const a = r.offsets.get('R1');
    const b = r.offsets.get('R2');
    expect(a).toEqual(b);
  });

  it('E. deterministic: the same project gives identical final transforms every time', () => {
    for (const make of [
      pirMatrixCircuit,
      esp32ModuleCircuit,
      contactOverlapCircuit,
      denseMixedCircuit,
    ]) {
      const one = deriveScene(make());
      for (let i = 0; i < 3; i++) expect(deriveScene(make())).toEqual(one);
    }
  });

  it('F. save/load: the separation never reaches the saved project', () => {
    const doc = pirMatrixCircuit();
    const text = serializePackage(
      createPackage(doc, { appVersion: 'test', exportedAt: '2026-10-07T00:00:00Z' }),
    );
    const s1 = deriveScene(doc);
    expect(s1.separation.moved).toHaveLength(1);
    const after = serializePackage(
      createPackage(doc, { appVersion: 'test', exportedAt: '2026-10-07T00:00:00Z' }),
    );
    expect(after).toBe(text);
    const loaded = parsePackage(after);
    if (!loaded.ok) throw new Error('parse');
    expect(loaded.doc.layout).toEqual(doc.layout);
    expect(loaded.doc.layout.components.U1).toEqual({ x: 460, y: 0, rotation: 0 });
    // Re-derived from the loaded project: the same 3D scene.
    expect(deriveScene(loaded.doc)).toEqual(s1);
  });

  it('caps the displacement: a part laid on another is not flung away; the overlap is reported', () => {
    let doc = pirMatrixCircuit();
    doc = structuredClone(doc);
    doc.layout.components.U1 = { x: 320, y: 0, rotation: 0 }; // on top of the matrix
    const s = deriveScene(doc);
    for (const m of s.separation.moved) expect(Math.hypot(m.dx, m.dz)).toBeLessThanOrEqual(MAX_CAP);
    expect(s.separation.unresolved).toEqual([['DS1', 'U1']]);
    expectTerminalsFollow(doc, s);
  });

  it('labels follow the moved part and never land on it or on another label', () => {
    const s = deriveScene(pirMatrixCircuit());
    const parts = s.components.map((c) => ({ c, w: 6, h: 2.2 }));
    const at = placeLabels(parts, 1.4);
    const u1 = s.components.find((c) => c.id === 'U1')!;
    const f = footprintRect(u1);
    const l = at.get('U1')!;
    // Beside its final footprint (within a label's reach), not on any part.
    expect(Math.max(f.x0 - l.x, l.x - f.x1, f.z0 - l.z, l.z - f.z1)).toBeLessThan(6);
    for (const c of s.components) {
      const g = footprintRect(c);
      const p = at.get(c.id)!;
      for (const o of s.components) {
        const q = footprintRect(o);
        const inside = p.x > q.x0 && p.x < q.x1 && p.z > q.z0 && p.z < q.z1;
        expect(inside, `${c.id} label on ${o.id}`).toBe(false);
      }
      expect(g).toBeDefined();
    }
  });

  it('is cheap: the dense bench-size input resolves in well under a frame', () => {
    const kinds = collisionBodies(pirMatrixCircuit());
    const pick = (id: string) => kinds.find((b) => b.id === id)!;
    const bodies: Body[] = [];
    for (let i = 0; i < 70; i++)
      bodies.push({
        ...pick(i % 7 === 0 ? 'U1' : i % 5 === 0 ? 'DS1' : 'R1'),
        id: `P${i}`,
        x: (i % 10) * 30,
        z: Math.floor(i / 10) * 28,
      });
    const t = performance.now();
    separateBodies(bodies);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
