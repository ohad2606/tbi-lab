/**
 * Phase 3 (owner report 2026-10-30, 3D wire edge cases). The owner's screenshots are not in the
 * repository; these fixtures are EQUIVALENT circuits built through the domain edit ops (wires
 * drawn as the Circuit view draws them), not exact reproductions.
 *
 * 1. Two wires on one LED leg (owner: two orange wires leaving an LED's leg, one to a capacitor,
 *    one to a resistor, twisted round each other like a knot). Both leave the leg by exit lanes on
 *    one line (the LED's leads are under its body); the wire with the shorter lane was routed
 *    first, hopped over the other's lane, and the other then rose at its own lane end straight up
 *    through it. Fixed by routing the longer lane first (scene.ts sameLaneOrder).
 * 2. Two wires on one ground post (owner: two black wires ending on a GND post, one stripped end
 *    hooking through the other). Their last runs lie on one line into the post (the 2D router
 *    lets wires of one node share a run); separatePlans cannot step the later one aside (a single
 *    run between two fixed ends, or a neighbour run starting inside its own far part), so it rides
 *    over the earlier one and comes down onto its stripped end. NOT fixed (deferred, medium
 *    risk: a prototype that stepped such runs aside at posts and fanned the stripped ends cut
 *    this only from 12 to 10 of 45 clear post layouts, and added same-node crossings on 11 of
 *    108 random benches; the rest needs separatePlans reworked). Pinned as a known limitation, so that a change either way is seen.
 * Checks are on the cables AS DRAWN (wireShape.ts), as the renderer builds them.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  createProject,
  type ComponentTypeId,
  type Point,
  type ProjectDocument,
} from '@tbi-lab/domain';
import * as THREE from 'three';
import { deriveScene, type SceneDescription } from '../src/views/scene3d/scene.js';
import { sampleShape, shapeWires } from '../src/views/scene3d/wireShape.js';
import { measure3d } from './support/wire3dMetrics.js';
import { T } from './support/ownerBench.js';
import { draw } from './support/wireScenario.js';

function bench(parts: [ComponentTypeId, Point][]): { doc: ProjectDocument; ids: string[] } {
  let doc = createProject({ projectId: 'p3', deviceId: 'd', name: 'p3', appVersion: '0' });
  const ids = parts.map(([type, at]) => {
    const r = addComponent(doc, type, at);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    return r.id;
  });
  return { doc, ids };
}

/** LED at the origin; capacitor and resistor; two wires from one LED leg. */
function ledLegBench(o: {
  cap: Point;
  res: Point;
  leg: 'anode' | 'cathode';
  capT: 'a' | 'b';
}): ProjectDocument {
  const b = bench([
    ['component.led', { x: 0, y: 0 }],
    ['component.capacitor', o.cap],
    ['component.resistor', o.res],
  ]);
  const [led, cap, res] = b.ids as [string, string, string];
  let doc = draw(b.doc, T(led, o.leg), T(cap, o.capT));
  doc = draw(doc, T(led, o.leg), T(res, 'a'));
  return doc;
}

/** A ground post below two resistors, each wired to it. */
function groundPostBench(r1: Point, r2: Point): ProjectDocument {
  const b = bench([
    ['component.ground', { x: 0, y: 100 }],
    ['component.resistor', r1],
    ['component.resistor', r2],
  ]);
  const [g, a, c] = b.ids as [string, string, string];
  let doc = draw(b.doc, T(a, 'b'), T(g, 'ref'));
  doc = draw(doc, T(c, 'a'), T(g, 'ref'));
  return doc;
}

/** The owner-equivalent LED case (the knot). */
const OWNER_LED = {
  cap: { x: 80, y: 40 },
  res: { x: 240, y: 0 },
  leg: 'cathode',
  capT: 'b',
} as const;
/** The owner-equivalent ground post case (one stripped end coming down onto the other). */
const OWNER_GND: [Point, Point] = [
  { x: 0, y: 0 },
  { x: 120, y: -40 },
];

/** The stripped stretch (2 mm, wires.ts STRIP) of each of two wires at the end they share. */
function sharedStrips(scene: SceneDescription) {
  const shapes = shapeWires(scene);
  const all = scene.wires.map((w) => sampleShape(shapes.get(w.id)!, 0.1));
  let at: THREE.Vector3 | null = null;
  for (const e of [all[0]![0]!, all[0]![all[0]!.length - 1]!])
    for (const f of [all[1]![0]!, all[1]![all[1]!.length - 1]!]) if (e.distanceTo(f) < 1e-3) at = e;
  if (!at) throw new Error('no shared end');
  const tip = at;
  return {
    at: tip,
    strips: all.map((pts) => {
      const o = pts[0]!.distanceTo(tip) < 1e-3 ? pts : [...pts].reverse();
      const strip = [o[0]!];
      let acc = 0;
      for (let i = 1; i < o.length && acc < 2; i++) {
        acc += o[i]!.distanceTo(o[i - 1]!);
        strip.push(o[i]!);
      }
      return strip;
    }),
  };
}

describe('3D wires sharing an end (Phase 3, owner report 2026-10-30)', () => {
  it('two wires on one LED leg: no knot (owner-equivalent case)', () => {
    const doc = ledLegBench(OWNER_LED);
    const s = deriveScene(doc);
    const m = measure3d(doc, s);
    // Before: the second wire rose through the first 6 mm from the leg (axis gap 0.03 mm).
    expect(m.ownPenetrations).toEqual([]);
    expect(measure3d(doc, s, 'route').ownPenetrations).toEqual([]);
    expect(m.foreignPenetrations).toEqual([]);
    expect(m.badEnds).toEqual([]);
    expect(m.loops).toEqual([]);
    expect(s.routeLimits ?? []).toEqual([]);
  });

  it('two wires on one LED leg: 144 layouts, only the known remainder interpenetrates', () => {
    // Before: 31 of 144 layouts had the two wires' tubes through each other away from the leg.
    // Known remainder (each already so before; not the lane order: the two wires share their
    // whole 2D route, past the capacitor's 3D can, which is larger than its 2D symbol, or the
    // parts' terminals coincide in 2D): listed so that a change either way is seen.
    const known = ['80,40,160,40,anode,a', '160,40,160,0,anode,b', '160,40,240,0,anode,b'];
    const hits: string[] = [];
    for (const cx of [80, 160])
      for (const cy of [-80, -40, 40])
        for (const rx of [160, 240])
          for (const ry of [-40, 0, 40])
            for (const leg of ['anode', 'cathode'] as const)
              for (const capT of ['a', 'b'] as const) {
                const doc = ledLegBench({
                  cap: { x: cx, y: cy },
                  res: { x: rx, y: ry },
                  leg,
                  capT,
                });
                const m = measure3d(doc, deriveScene(doc));
                expect(m.foreignPenetrations).toEqual([]);
                if (m.ownPenetrations.length) hits.push([cx, cy, rx, ry, leg, capT].join(','));
              }
    expect(hits).toEqual(known);
  });

  it('two wires on one ground post: KNOWN LIMITATION, one stripped end comes down onto the other (pinned)', () => {
    const doc = groundPostBench(...OWNER_GND);
    const s = deriveScene(doc);
    const { at, strips } = sharedStrips(s);
    const tops = strips.map((st) => Math.max(...st.map((p) => p.y)) - at.y);
    // Both reach the post along one line; one stripped end lies on the bench into the post, the
    // other rides over it and comes down onto it from 1.8 mm above the post's lug (its jacket
    // ends in the air), about a conductor's diameter (0.64 mm) over the other.
    expect(Math.min(...tops)).toBeLessThan(0.05);
    expect(Math.max(...tops)).toBeGreaterThan(1.5);
    const m = measure3d(doc, s);
    expect(m.ownPenetrations).toEqual([]);
    expect(m.foreignPenetrations).toEqual([]);
    expect(m.badEnds).toEqual([]);
  });
});
