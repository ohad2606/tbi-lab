/**
 * Terminal keep-out, cross-view (Sprint 10 owner blocker): for the ESP32 GND case, the schematic
 * and the 3D scene show exactly the connectivity of the netlist. They never invent a connection
 * from 2D geometry, not even for a wire an older project stored straight down the header.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  autoRouteVertices,
  connectivity,
  routeObstacles,
  terminalPosition,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { deriveScene } from '../src/views/scene3d/scene.js';
import { componentBoxes } from '../src/ui/routing.js';
import { expectFaithful } from './schematicReadback.js';
import { mixedCircuit } from '../../packages/domain/tests/circuits.js';

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** The owner's case on top of the shared fixture: a new ground below-left, wired to U1.gnd. */
function gndCase(route: 'auto' | 'header') {
  const { doc: base, ids } = mixedCircuit();
  const board = ids.u!;
  const g = must(addComponent(base, 'component.ground', { x: 20, y: 300 }));
  const a = terminalPosition(g.doc, board, 'gnd')!;
  const b = terminalPosition(g.doc, g.id, 'ref')!;
  const vertices =
    route === 'auto'
      ? autoRouteVertices([a, b], routeObstacles(g.doc, componentBoxes(g.doc)))
      : [{ x: a.x, y: b.y }]; // straight down the J3 header, as an old project could store it
  const w = must(
    addWire(
      g.doc,
      { kind: 'terminal', component: board, terminal: 'gnd' },
      { kind: 'terminal', component: g.id, terminal: 'ref' },
      vertices,
    ),
  );
  return { doc: w.doc as ProjectDocument, board, ground: g.id, wire: w.id };
}

describe('terminal keep-out: schematic and 3D follow connectivity, not 2D geometry', () => {
  for (const route of ['auto', 'header'] as const) {
    it(`${route} route: only U1.gnd joins the new ground in every view`, () => {
      const { doc, board, ground, wire } = gndCase(route);
      const g = connectivity(doc);
      const node = g.nodeOf.get(`${board}:gnd`)!;
      expect(g.nodeOf.get(`${ground}:ref`)).toBe(node);
      // Every other board pin keeps the node it had before the wire (from the fixture).
      const before = connectivity(mixedCircuit().doc);
      for (const c of g.components.filter((x) => x.id === board))
        for (const t of c.terminals)
          if (t.terminal !== 'gnd')
            expect(t.node, t.terminal).toBe(before.nodeOf.get(`${board}:${t.terminal}`) ?? null);
      // Schematic: drawn groups equal netlist nodes exactly (no merged pins).
      expectFaithful(doc);
      // 3D: the new wire carries U1.gnd's node; no joint ties an unrelated board pin to anything.
      const scene = deriveScene(doc);
      expect(scene.wires.find((w) => w.id === wire)!.node).toBe(node);
      for (const w of scene.wires) {
        const lw = doc.layout.wires.find((x) => x.id === w.id)!;
        const end = lw.from.kind === 'terminal' ? `${lw.from.component}:${lw.from.terminal}` : null;
        if (end) expect(w.node, w.id).toBe(g.nodeOf.get(end) ?? null);
      }
      for (const j of scene.joints)
        expect(
          j.terminals.filter((k) => k.startsWith(`${board}:`) && k !== `${board}:gnd`),
        ).toEqual([]);
    });
  }
});
