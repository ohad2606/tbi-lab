/**
 * Wire routing integrity (rt2): incremental canonical routing (domain `routeAutoWiresIncremental`,
 * used by the store's `routeAutomatic`) is IDENTICAL to full canonical routing: the same document,
 * bit for bit, whatever the edit history and whatever document it last routed. Determinism is the
 * requirement (same document => same routes); speed is only the reason.
 *
 * 1. Golden routes: seeded benches routed by fae6a3c's router (before any rt2 change) are
 *    reproduced by the full router and by the incremental one.
 * 2. Random edit sequences (moves, rotations, segment drags, "route automatically", wires added
 *    and deleted): after every step the incremental result equals the full one.
 * 3. A reference from an unrelated project is harmless (only correctness of the reuse test
 *    matters, never where the reference came from).
 * 4. It actually saves work where it should: moving one part re-routes a minority of wires.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  emptySelection,
  incrementalStats,
  moveSelection,
  routeAutoWiresIncremental,
  type ProjectDocument,
  type RoutingMemo,
} from '@tbi-lab/domain';
import { componentBoxes, routeAutomatic, routeAutomaticFull } from '../src/ui/routing.js';
import { randomBench, rng } from './support/routingBench.js';
import { GOLDEN_CASES, caseKey, goldenDocs, routesHash } from './support/routingGolden.js';
import { randomEdit } from './support/editSequence.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/rt2-canonical-routes.json', import.meta.url), 'utf8'),
) as Record<string, { open: string; moved: string }>;
const json = (d: ProjectDocument) => JSON.stringify(d);
/** Incremental routing against an explicit memo (no module state). */
const incremental = (prev: RoutingMemo | null, doc: ProjectDocument) =>
  routeAutoWiresIncremental(prev, doc, componentBoxes(doc));

describe('incremental canonical routing (rt2)', () => {
  it('1: reproduces the golden routes of fae6a3c — full router (up to 20 wires) and incremental (all)', () => {
    expect(Object.keys(golden).length).toBe(GOLDEN_CASES.length);
    for (const c of GOLDEN_CASES) {
      const want = golden[caseKey(c)]!;
      if (c.wires <= 20) {
        const full = goldenDocs(c, routeAutomaticFull);
        expect([routesHash(full.open), routesHash(full.moved)], caseKey(c)).toEqual([
          want.open,
          want.moved,
        ]);
      }
      const inc = goldenDocs(c, routeAutomatic);
      expect([routesHash(inc.open), routesHash(inc.moved)], caseKey(c)).toEqual([
        want.open,
        want.moved,
      ]);
    }
  });

  it('2: random edit sequences — after every step the incremental result IS the full result', () => {
    let steps = 0;
    let reused = 0;
    for (const [wires, seed, dense, board] of [
      [12, 1, false, false],
      [16, 2, true, false],
      [20, 3, true, true],
      [10, 4, true, false],
      [24, 5, false, true],
    ] as const) {
      const R = rng(seed * 104729);
      let doc = routeAutomaticFull(randomBench(wires, seed, { dense, board }).doc);
      let memo = incremental(null, doc).memo;
      for (let k = 0; k < 10; k++) {
        // The edit and the manual-wire repair, unrouted; then both routers on the same input.
        const step = randomEdit(doc, R, (d) => d, [
          'move',
          'move',
          'move',
          'rotate',
          'segment',
          'automatic',
          'addWire',
          'deleteWire',
        ]);
        if (!step) continue;
        const full = routeAutomaticFull(step.doc);
        const inc = incremental(memo, step.doc);
        reused += incrementalStats.reused;
        expect(json(inc.doc), `${wires}/${seed} step ${k} (${step.kind})`).toBe(json(full));
        doc = full;
        memo = inc.memo;
        steps++;
      }
    }
    expect(steps).toBeGreaterThan(30);
    expect(reused).toBeGreaterThan(0); // the reuse path is exercised, not only the fallback
  });

  it('3: a reference from another project (or a stale one) never changes the result', () => {
    const a = incremental(null, randomBench(16, 11, { dense: true }).doc).memo;
    const b = randomBench(16, 12, { dense: true }).doc;
    const out = incremental(a, b);
    expect(json(out.doc)).toBe(json(routeAutomaticFull(b)));
    // A memo whose routes were NOT canonical is outside the contract (the store only ever passes
    // its own output). Its own output, routed again, is unchanged and fully reused (idempotence).
    const again = incremental(out.memo, out.doc);
    expect(json(again.doc)).toBe(json(out.doc));
    expect(incrementalStats.routed).toBe(0);
  });

  it('4: moving one part of a sparse 40-wire bench reuses the routes it cannot affect', () => {
    const doc = routeAutomaticFull(randomBench(40, 1).doc);
    const part = doc.components.find((c) => c.id !== 'PSU1' && c.id !== 'GND1')!.id;
    const m = moveSelection(doc, { ...emptySelection(), components: [part] }, { x: 40, y: 0 });
    if (!m.ok) throw new Error(m.error);
    const inc = incremental(incremental(null, doc).memo, m.doc);
    expect(json(inc.doc)).toBe(json(routeAutomaticFull(m.doc)));
    const { routed, reused } = incrementalStats;
    console.log(`40-wire bench, one part moved: ${routed} wires re-routed, ${reused} reused`);
    expect(routed + reused).toBe(40);
    expect(reused).toBeGreaterThan(0); // measured reuse: rt2-ab-incremental.txt
  });
});
