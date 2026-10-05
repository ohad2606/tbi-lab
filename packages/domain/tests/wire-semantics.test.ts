/**
 * Sprint 9 owner review, issue 1: a wire is electrically connected ONLY at its explicit endpoints
 * (terminals, junctions). Nothing geometric — a wire crossing a pin, several pins, another wire or
 * a body — ever connects, through edits, save and load. Routing keeps wires off headers, bodies
 * and unrelated terminals where it can, without ever changing connectivity.
 */
import { describe, expect, it } from 'vitest';
import {
  ESP32_DEVKITC_WROOM32,
  addWire,
  attachedWires,
  autoRouteVertices,
  boardPinPosition,
  checkCircuit,
  createPackage,
  moveSelection,
  parsePackage,
  rerouteWires,
  routeObstacles,
  serializePackage,
  terminalPosition,
  validateProject,
  wireCrossings,
  wireRoute,
  type Point,
  type ProjectDocument,
  type RouteBox,
} from '../src/index.js';
import { place, wire } from './circuits.js';
import { must, newDoc } from './helpers.js';

const netOf = (doc: ProjectDocument, c: string, t: string) =>
  doc.connections.find((x) => x.component === c && x.terminal === t)?.net;
const connected = (doc: ProjectDocument) =>
  doc.connections.map((c) => `${c.component}.${c.terminal}`).sort();
const roundTrip = (doc: ProjectDocument) => {
  const r = parsePackage(
    serializePackage(createPackage(doc, { appVersion: 't', exportedAt: '2026-10-05T00:00:00Z' })),
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.doc;
};
const on = (p: Point, route: Point[]) =>
  route.slice(1).some((b, i) => {
    const a = route[i]!;
    return a.x === b.x
      ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
      : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  });

/** Canvas symbol boxes for the parts used here (app symbols.tsx), as the router gets them. */
function boxes(doc: ProjectDocument): RouteBox[] {
  const bbox: Record<string, [number, number, number, number]> = {
    'board.esp32_devkitc_wroom32': [-80, -196, 80, 196],
    'component.resistor': [-40, -10, 40, 10],
    'component.ground': [-12, -20, 12, 14],
    'instrument.lab_psu': [-40, -40, 40, 40],
  };
  return doc.components.map((c) => {
    const p = doc.layout.components[c.id]!;
    const [x0, y0, x1, y1] = bbox[c.type] ?? [-20, -20, 20, 20];
    return { minX: p.x + x0, minY: p.y + y0, maxX: p.x + x1, maxY: p.y + y1 };
  });
}

/** An ESP32 at the origin (J3 header down x = 80) and a resistor to its right. */
function board() {
  let doc = newDoc();
  const u = place(doc, 'board.esp32_devkitc_wroom32', 0, 0);
  doc = u.doc;
  const r = place(doc, 'component.resistor', 300, 200);
  doc = r.doc;
  return { doc, u: u.id, r: r.id };
}

describe('wire semantics: only explicit endpoints connect', () => {
  it('a wire drawn straight down a header crosses its pins without connecting to any of them', () => {
    const { doc: d0, u, r } = board();
    // U1 GND (J3 top, at 80,-180) → R1.a, routed DOWN the J3 column through every pin on it.
    const doc = must(
      addWire(
        d0,
        { kind: 'terminal', component: u, terminal: 'gnd' },
        { kind: 'terminal', component: r, terminal: 'a' },
        [{ x: 80, y: 200 }],
      ),
    ).doc;
    const route = wireRoute(doc, doc.layout.wires.at(-1)!)!;
    const crossed = ESP32_DEVKITC_WROOM32.pins
      .map((p) => boardPinPosition(p))
      .filter((p) => p.x === 80 && p.y > -180 && on(p, route));
    expect(crossed.length).toBeGreaterThan(10);
    // Exactly the two endpoints are connected, on one net; no crossed pin joins it.
    expect(connected(doc)).toEqual([`${r}.a`, `${u}.gnd`]);
    expect(netOf(doc, u, 'gnd')).toBe(netOf(doc, r, 'a'));
    for (const t of ['gpio4', 'gpio5', 'gpio18', 'gpio19', 'gpio21', 'gpio22', 'gpio23'])
      expect(netOf(doc, u, t), t).toBeUndefined();
    // And the drawing says so: each connectable pin the wire runs over is flagged.
    const flagged = checkCircuit(doc)
      .filter((i) => i.code === 'wire_over_terminal')
      .map((i) => i.terminals![0]);
    expect(flagged).toEqual(expect.arrayContaining(['gpio4', 'gpio18', 'gpio23']));
    // Save and load keep exactly the explicit connectivity.
    const back = roundTrip(doc);
    expect(validateProject(back)).toEqual([]);
    expect(back.connections).toEqual(doc.connections);
    expect(back.nets).toEqual(doc.nets);
  });

  it('wires that cross without a junction are separate nets; an explicit junction joins them', () => {
    let doc = newDoc();
    for (const [type, x, y] of [
      ['component.resistor', 0, -100],
      ['component.resistor', 200, -100],
      ['component.resistor', 100, -200],
      ['component.resistor', 100, 0],
    ] as const)
      doc = place(doc, type, x, y).doc;
    // R1.b (40,-100) → R2.a (160,-100) horizontal; R3.b (140,-200) → R4.b (140,0) vertical.
    doc = wire(doc, ['R1', 'b'], ['R2', 'a']);
    doc = wire(doc, ['R3', 'b'], ['R4', 'b']);
    expect(wireCrossings(doc)).toHaveLength(1);
    expect(netOf(doc, 'R1', 'b')).not.toBe(netOf(doc, 'R3', 'b'));
    expect(doc.nets).toHaveLength(2);
    const back = roundTrip(doc);
    expect(netOf(back, 'R1', 'b')).not.toBe(netOf(back, 'R3', 'b'));
    // An explicit junction at the crossing: one net, drawn with a dot (no bridge).
    const w = doc.layout.wires.at(-2)!.id;
    const joined = must(
      addWire(
        doc,
        { kind: 'terminal', component: 'R4', terminal: 'a' },
        { kind: 'wire', wire: w, at: { x: 60, y: -100 } },
      ),
    ).doc;
    expect(joined.layout.junctions).toHaveLength(1);
    expect(netOf(joined, 'R4', 'a')).toBe(netOf(joined, 'R1', 'b'));
    expect(netOf(joined, 'R3', 'b')).not.toBe(netOf(joined, 'R1', 'b'));
    const again = roundTrip(joined);
    expect(again.connections).toEqual(joined.connections);
    expect(again.layout.junctions).toEqual(joined.layout.junctions);
  });

  it('every pin a board draws is a routing obstacle, its unconnectable header pins included', () => {
    const { doc } = board();
    const obs = routeObstacles(doc, []);
    for (const pin of ESP32_DEVKITC_WROOM32.pins) {
      const p = boardPinPosition(pin);
      expect(obs.points, `${pin.header}${pin.position}`).toContainEqual(p);
    }
  });
});

describe('routing after a move', () => {
  it('a wire dragged onto a header is re-routed off it; endpoints and nets never change', () => {
    let { doc } = board();
    const g = place(doc, 'component.ground', 300, 0);
    doc = wire(g.doc, ['U1', 'gnd'], [g.id, 'ref']);
    const id = doc.layout.wires.at(-1)!.id;
    const of = (d: ProjectDocument) =>
      wireRoute(
        d,
        d.layout.wires.find((w) => w.id === id)!,
      )!;
    const before = of(doc);
    // The ground moves straight below the GND pin: the stored route would run down the header.
    const moved = must(
      moveSelection(doc, { components: [g.id], wires: [], junctions: [] }, { x: -220, y: 220 }),
    ).doc;
    const naive = of(moved);
    const pinsOn = (route: Point[]) =>
      ESP32_DEVKITC_WROOM32.pins
        .map((p) => boardPinPosition(p))
        .filter((p) => !(p.x === 80 && p.y === -180) && on(p, route));
    expect(pinsOn(naive).length).toBeGreaterThan(0);
    const routed = rerouteWires(moved, attachedWires(moved, [g.id]), boxes(moved));
    const fixed = of(routed);
    expect(pinsOn(fixed)).toEqual([]);
    expect(fixed[0]).toEqual(naive[0]);
    expect(fixed.at(-1)).toEqual(naive.at(-1));
    expect(routed.connections).toEqual(moved.connections);
    expect(routed.nets).toEqual(moved.nets);
    expect(before).not.toEqual(fixed);
    expect(validateProject(routed)).toEqual([]);
  });

  it('a clean route is never touched, and a rigidly moved wire is not a candidate', () => {
    let { doc } = board();
    // Drawn as the canvas draws a new wire: through the router.
    const a = terminalPosition(doc, 'R1', 'a')!;
    const b = terminalPosition(doc, 'U1', 'gpio23')!;
    doc = must(
      addWire(
        doc,
        { kind: 'terminal', component: 'R1', terminal: 'a' },
        { kind: 'terminal', component: 'U1', terminal: 'gpio23' },
        autoRouteVertices([a, b], routeObstacles(doc, boxes(doc))),
      ),
    ).doc;
    const ids = attachedWires(doc, ['R1']);
    expect(ids).toEqual([doc.layout.wires.at(-1)!.id]);
    expect(rerouteWires(doc, ids, boxes(doc))).toBe(doc);
    expect(attachedWires(doc, ['R1'], ids)).toEqual([]);
  });
});
