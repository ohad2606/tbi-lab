/**
 * Sprint 20 owner report (s20r): a PSU at 5 V / 100 mA, one AND gate and several wires between
 * them showed, in 3D, crossings, loops and entangled wires. The owner's screenshots were not
 * available; the fixtures are owner-EQUIVALENT circuits (support/ownerBench.ts), not an exact
 * reproduction.
 *
 * Reproduced and fixed (root causes in app/src/views/scene3d/scene.ts and route3d.ts):
 *  - a wire reaching a gate pin from the far side climbed 12 mm over the gate's own breakout board
 *    (an arch / loop next to the pin): above W2, rot90 W2, rot180 W4+W5, rot270 W3 (RC1);
 *  - two wires of one node stacked on one plan line for a whole run (rot90 W2/W4: RC2, RC3);
 *  - a same-node wire exempt as an obstacle along its whole length (RC4).
 * Every check is on the cable AS DRAWN (wireShape.ts), and the electrical netlist is checked
 * independently of the geometry.
 */
import { describe, expect, it } from 'vitest';
import {
  connectivity,
  createPackage,
  parsePackage,
  serializePackage,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { deriveScene, WIRE_RADIUS } from '../src/views/scene3d/scene.js';
import { awayAndBack, expectedNets, ownerBench, ownerVariants } from './support/ownerBench.js';
import { measure3d } from './support/wire3dMetrics.js';
import { expectNoWireThroughBodies } from './support/scene3dChecks.js';
import { e2eFixtures } from './support/s20rFixtures.js';
import { readFileSync } from 'node:fs';

const nets = (doc: ProjectDocument): string[][] => {
  const g = connectivity(doc);
  const by = new Map<string, string[]>();
  for (const [k, n] of g.nodeOf) by.set(n, [...(by.get(n) ?? []), k]);
  return [...by.values()]
    .filter((n) => n.length > 1)
    .map((n) => [...n].sort())
    .sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
};
const scene = (doc: ProjectDocument) => JSON.stringify(deriveScene(doc));

/**
 * Known, documented remainders (NOTES.md "open limitations"), asserted exactly so that a change
 * either way is noticed:
 *  - left / left-switched W3: the 2D route reaches the PSU's - post from outside the supply
 *    (along the front, back to the post): a hook of ~3 mm at the post;
 *  - below W4: its 2D route runs on the supply symbol's outline, 0.15 mm inside the deeper 3D
 *    case, so the 3D wire passes over the supply's case (clear of it) to reach the + post.
 */
const KNOWN: Record<string, { hairpins?: string[]; overOwnBody?: string[] }> = {
  left: { hairpins: ['W3'] },
  'left-switched': { hairpins: ['W3'] },
  below: { overOwnBody: ['W4>PSU1'] },
};

describe('owner report (s20r): one AND gate wired to a 5 V supply, in 3D', () => {
  for (const v of ownerVariants())
    it(`${v.name}: netlist as described; no loop, arch over its own part, tangle or collision`, () => {
      const b = ownerBench(v.options);
      expect(nets(b.doc)).toEqual(expectedNets(b, v.options));
      const s = deriveScene(b.doc);
      const m = measure3d(b.doc, s, 'drawn');
      expect(m.badEnds, 'every wire ends at its own terminal').toEqual([]);
      expect(m.foreignPenetrations, 'different nodes never touch').toEqual([]);
      expect(m.ownPenetrations, 'wires of one node never run into each other').toEqual([]);
      expect(m.bodyHits).toEqual([]);
      expect(m.loops).toEqual([]);
      expect(m.flatCrossings, 'every crossing passes over by a wire diameter').toEqual([]);
      for (const c of m.crossings) expect(c.dy).toBeGreaterThanOrEqual(2 * WIRE_RADIUS);
      expect(m.overOwnBody).toEqual(KNOWN[v.name]?.overOwnBody ?? []);
      expect(m.hairpins).toEqual(KNOWN[v.name]?.hairpins ?? []);
      expectNoWireThroughBodies(b.doc, s, v.name);
      // Deterministic: the same document gives the same scene.
      expect(scene(b.doc)).toBe(JSON.stringify(s));
    });

  it('moving the gate away and back restores the identical 3D scene; the netlist never changes', () => {
    // Paths over free bench only (onto another part would make a contact: a different circuit).
    for (const [side, steps] of [
      [
        'right',
        [
          { x: 200, y: 0 },
          { x: -160, y: 120 },
        ],
      ],
      [
        'above',
        [
          { x: -200, y: -100 },
          { x: 0, y: -80 },
        ],
      ],
      [
        'near',
        [
          { x: 200, y: 0 },
          { x: -160, y: 120 },
        ],
      ],
    ] as const) {
      const b = ownerBench({ side });
      const before = scene(b.doc);
      const n = nets(b.doc);
      const back = awayAndBack(b.doc, b.gate, [...steps]);
      expect(back.nets, 'no contact made on the way').toEqual(b.doc.nets);
      expect(nets(back)).toEqual(n);
      expect(scene(back), side).toBe(before);
    }
  });

  it('save and reload give the identical 3D scene', () => {
    const b = ownerBench({ side: 'right', rotation: 180 });
    const text = serializePackage(
      createPackage(b.doc, { appVersion: '0.1.0', exportedAt: '2026-10-23T00:00:00.000Z' }),
    );
    const parsed = parsePackage(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(scene(parsed.doc)).toBe(scene(b.doc));
    expect(nets(parsed.doc)).toEqual(nets(b.doc));
  });

  it('the reproduced arch over the gate is gone (regression: RC1)', () => {
    // Before the fix each of these wires rose to ~12.4 mm over the gate's own 15.2 mm board.
    for (const [opts, wires] of [
      [{ side: 'above' }, ['W2']],
      [{ side: 'right', rotation: 90 }, ['W2']],
      [{ side: 'right', rotation: 180 }, ['W4', 'W5']],
      [{ side: 'right', rotation: 270 }, ['W3']],
    ] as const) {
      const b = ownerBench(opts);
      const s = deriveScene(b.doc);
      for (const id of wires) {
        const w = s.wires.find((x) => x.id === id)!;
        expect(Math.max(...w.points.map((p) => p.y)), `${JSON.stringify(opts)} ${id}`).toBeLessThan(
          8,
        );
      }
    }
  });

  it('the browser fixtures are exactly these benches (app/e2e/fixtures/s20r)', () => {
    for (const [name, doc] of Object.entries(e2eFixtures())) {
      const file = readFileSync(
        new URL(`../e2e/fixtures/s20r/${name}.json`, import.meta.url),
        'utf8',
      );
      expect(file, name).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    }
  });
});
