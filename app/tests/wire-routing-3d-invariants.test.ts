/**
 * Sprint 20 (s20r) routing invariants, as automated checks on the 3D cables AS DRAWN and on the
 * project through the real store:
 *  - curated examples: every wire ends at its terminal, no wire touches a wire of another node,
 *    no wire passes through a body, every crossing of independent wires passes over by at least
 *    a wire diameter, the scene is deterministic, and nothing is flagged as a routing limitation;
 *  - where a safe route cannot be made (bodies the separation cannot pull apart), the scene says
 *    so (`routeLimits`, shown by the 3D view) for exactly the wires that are not safe;
 *  - the netlist is unchanged by drags, undo/redo and reopening, and undo restores the identical
 *    3D scene (store with the app's routing).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  connectivity,
  emptySelection,
  sameNodeCrossings,
  wireCrossings,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import { moveRouted, routeAutomatic } from '../src/ui/routing.js';
import { deriveScene, touchingNodes, WIRE_RADIUS } from '../src/views/scene3d/scene.js';
import { independentWireNodes } from './support/independentNodes.js';
import { bodyHits, measure3d, routeSamples } from './support/wire3dMetrics.js';
import { ownerBench } from './support/ownerBench.js';
import { rng } from './support/routingBench.js';
import { normalize } from './support/wireScenario.js';
import { complexBench } from './support/complexBench.js';
import { GOLDEN_CASES, caseKey, goldenDocs } from './support/routingGolden.js';

const examples = () => {
  const dir = new URL('../src/examples/data/', import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [f, normalize(JSON.parse(readFileSync(new URL(f, dir), 'utf8')))] as const);
};
const nets = (doc: ProjectDocument) => {
  const g = connectivity(doc);
  const by = new Map<string, string[]>();
  for (const [k, n] of g.nodeOf) by.set(n, [...(by.get(n) ?? []), k]);
  return JSON.stringify([...by.values()].map((n) => [...n].sort()).sort());
};

describe('3D routing invariants (s20r)', () => {
  it('curated examples: drawn cables end at their terminals, never touch another node, never pass through a body; crossings pass over', () => {
    for (const [name, doc] of examples()) {
      const s = deriveScene(doc);
      const m = measure3d(doc, s, 'drawn');
      expect(m.badEnds, name).toEqual([]);
      expect(m.foreignPenetrations, name).toEqual([]);
      expect(m.bodyHits, name).toEqual([]);
      for (const c of m.crossings.filter((x) => !x.sameNode))
        expect(c.dy, `${name} ${c.a}x${c.b}`).toBeGreaterThanOrEqual(2 * WIRE_RADIUS);
      expect(s.routeLimits, name).toEqual([]);
      expect(JSON.stringify(deriveScene(doc)), name).toBe(JSON.stringify(s));
    }
  });

  it('where no safe route exists the scene says so, for exactly the unsafe wires', () => {
    // rt2 sweep recipe, seed 30: two gates moved so close that their 3D boards cannot be pulled
    // apart (separation.unresolved), so wires to them must pass through a neighbouring board.
    const R = rng(30);
    const b = complexBench();
    let doc = b.doc;
    for (const g of b.gates) {
      const d = { x: 20 * Math.round(R() * 16 - 8), y: 20 * Math.round(R() * 16 - 8) };
      const r = moveRouted(doc, { ...emptySelection(), components: [g] }, d);
      if (r.ok) doc = normalize(r.doc);
    }
    const s = deriveScene(doc);
    expect(s.separation.unresolved.length).toBeGreaterThan(0);
    const unsafe = new Set([
      ...bodyHits(doc, s, routeSamples(s)).map((h) => h.split('>')[0]!),
      ...touchingNodes(s).flatMap((k) =>
        k.startsWith('w:') ? k.slice(2).split('|') : [k.slice(2).split('|')[0]!],
      ),
    ]);
    expect(unsafe.size).toBeGreaterThan(0);
    expect(new Set(s.routeLimits)).toEqual(unsafe);
  });

  it('netlist unchanged by drags, undo/redo and reopening; undo restores the identical 3D scene', async () => {
    const storage = await ProjectStore.open(new IDBFactory());
    const prefs = (): Preferences => {
      const d: Record<string, string> = {};
      return { get: (k) => d[k] ?? null, set: (k, v) => void (d[k] = v) };
    };
    const app = new AppStore({
      storage,
      prefs: prefs(),
      languages: ['en'],
      newId: () => 's20r',
      autosaveDebounceMs: 1,
      routeLayout: routeAutomatic,
    });
    await app.init();
    const bench = ownerBench({ side: 'right', rotation: 180 });
    await app.newProject('Owner');
    // The owner bench's content into the store's project (same parts, wires and parameters).
    expect(
      app.apply({
        ok: true,
        doc: { ...app.state.doc!, ...bench.doc, projectId: app.state.doc!.projectId },
      }),
    ).toBe(true);
    const doc = () => app.state.doc!;
    const n0 = nets(doc());
    const s0 = JSON.stringify(deriveScene(doc()));
    const sel = { ...emptySelection(), components: [bench.gate] };
    expect(app.apply(moveRouted(doc(), sel, { x: 120, y: 60 }))).toBe(true);
    expect(nets(doc())).toBe(n0);
    const s1 = JSON.stringify(deriveScene(doc()));
    app.undo();
    expect(nets(doc())).toBe(n0);
    expect(JSON.stringify(deriveScene(doc()))).toBe(s0);
    app.redo();
    expect(JSON.stringify(deriveScene(doc()))).toBe(s1);
    app.undo();
    await new Promise((r) => setTimeout(r, 100)); // the autosave lands
    const id = doc().projectId;
    await app.openProject(id);
    expect(nets(doc())).toBe(n0);
    expect(JSON.stringify(deriveScene(doc()))).toBe(s0);
  });

  it('hops are drawn only between different nodes; same-node crossings stay rare (s20r round 2)', () => {
    const check = (doc: ProjectDocument, label: string) => {
      const nodes = independentWireNodes(doc); // s20r4 B5: not the domain's own map
      for (const c of wireCrossings(doc))
        expect(nodes.get(c.over), label).not.toBe(nodes.get(c.under));
      return sameNodeCrossings(doc).length;
    };
    // Curated examples: the two crossings left are between MANUAL wires, kept as authored.
    let n = 0;
    for (const [name, doc] of examples()) n += check(doc, name);
    expect(n).toBe(2);
    // The golden random benches (5..80 automatic wires): 609 same-node crossings before round 2
    // (opened and moved), 37 after (s20r-golden-metrics.txt).
    let g = 0;
    for (const c of GOLDEN_CASES) {
      const { open, moved } = goldenDocs(c, routeAutomatic);
      g += check(open, JSON.stringify(c)) + check(moved, JSON.stringify(c));
    }
    expect(g).toBeLessThanOrEqual(37);
  });

  it('golden random benches up to 20 wires: 3D invariants, pinned (s20r4, review B6)', () => {
    // Every exception is listed and must stay exactly as it is (a change either way is seen); a
    // contact of two nodes is always flagged by the scene's routeLimits (the 3D view's note).
    const known: Record<string, { foreign?: string[]; loops?: string[] }> = {
      '20-2-dense': { foreign: ['W3-W10'] },
      '20-2-dense-board': { loops: ['W20'] },
    };
    for (const c of GOLDEN_CASES.filter((g) => g.wires <= 20)) {
      const { open } = goldenDocs(c, routeAutomatic);
      const s = deriveScene(open);
      const m = measure3d(open, s);
      const k = caseKey(c);
      const foreign = m.foreignPenetrations.map((p) => `${p.a}-${p.b}`);
      expect(foreign, k).toEqual(known[k]?.foreign ?? []);
      expect(m.bodyHits, k).toEqual([]);
      expect(m.badEnds, k).toEqual([]);
      expect(m.loops, k).toEqual(known[k]?.loops ?? []);
      for (const f of foreign)
        for (const id of f.split('-')) expect(s.routeLimits, k).toContain(id);
    }
  });
});
