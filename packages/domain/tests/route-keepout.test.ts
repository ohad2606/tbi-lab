/**
 * Terminal keep-out (Sprint 10 owner blocker): a new wire is never routed through an unrelated
 * terminal, board pin, junction or pin lead-in, because a wire drawn through a pin reads as
 * connected to it. Connectivity still comes only from explicit endpoints: a route that passes a
 * pin never joins it, and the tests check that from the netlist, not only from geometry.
 */
import { describe, expect, it } from 'vitest';
import {
  ESP32_DEVKITC_WROOM32,
  TERMINAL_KEEP_OUT,
  addComponent,
  addWire,
  autoRoute,
  autoRouteVertices,
  boardTerminalId,
  checkCircuit,
  connectivity,
  createPackage,
  orthogonalRoute,
  parsePackage,
  rotatePoint,
  routeObstacles,
  serializePackage,
  terminalPosition,
  wireRoute,
  type Point,
  type ProjectDocument,
  type RouteBox,
  type RouteObstacles,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

// Symbol bodies as the app draws them (app/src/ui/symbols.tsx `bbox`).
const BBOX: Record<string, [number, number, number, number]> = {
  'board.esp32_devkitc_wroom32': [-80, -196, 80, 196],
  'component.resistor': [-40, -10, 40, 10],
  'component.led': [-40, -26, 40, 14],
  'component.ground': [-16, -20, 16, 12],
  'instrument.lab_psu': [-40, -40, 40, 40],
};
function boxes(doc: ProjectDocument): RouteBox[] {
  return doc.components.map((c) => {
    const p = doc.layout.components[c.id]!;
    const [x0, y0, x1, y1] = BBOX[c.type]!;
    const pts = [
      { x: x0, y: y0 },
      { x: x1, y: y1 },
    ].map((q) => rotatePoint(q, p.rotation));
    return {
      minX: Math.min(...pts.map((q) => q.x)) + p.x,
      maxX: Math.max(...pts.map((q) => q.x)) + p.x,
      minY: Math.min(...pts.map((q) => q.y)) + p.y,
      maxY: Math.max(...pts.map((q) => q.y)) + p.y,
    };
  });
}
const obstacles = (doc: ProjectDocument) => routeObstacles(doc, boxes(doc));

/** Distance from p to segment ab (independent of the router's own helper). */
function dist(p: Point, a: Point, b: Point): number {
  const x = Math.max(Math.min(a.x, b.x), Math.min(p.x, Math.max(a.x, b.x)));
  const y = Math.max(Math.min(a.y, b.y), Math.min(p.y, Math.max(a.y, b.y)));
  return Math.hypot(p.x - x, p.y - y);
}
/** The obstacle points (terminals, pins, junctions) a route enters, its own two ends excepted. */
function entered(route: Point[], obs: RouteObstacles): Point[] {
  const a = route[0]!;
  const b = route.at(-1)!;
  return obs.points.filter(
    (p) =>
      !(p.x === a.x && p.y === a.y) &&
      !(p.x === b.x && p.y === b.y) &&
      route.slice(1).some((q, i) => dist(p, route[i]!, q) < TERMINAL_KEEP_OUT),
  );
}
/** Pin lead-ins (board stubs) a route touches, its own ends' leads excepted. */
function leadsTouched(route: Point[], obs: RouteObstacles): number {
  const ends = [route[0]!, route.at(-1)!];
  return (obs.leads ?? []).filter(
    ([t, e]) =>
      !ends.some((q) => q.x === t.x && q.y === t.y) &&
      route
        .slice(1)
        .some(
          (q, i) =>
            Math.min(
              dist(t, route[i]!, q),
              dist(e, route[i]!, q),
              dist(route[i]!, t, e),
              dist(q, t, e),
            ) < TERMINAL_KEEP_OUT,
        ),
  ).length;
}
function throughBodies(r: Point[], bx: readonly RouteBox[]): number {
  let n = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const [a, b] = [r[i]!, r[i + 1]!];
    for (const q of bx) {
      if (a.y === b.y && a.y > q.minY && a.y < q.maxY)
        n += Math.max(
          0,
          Math.min(Math.max(a.x, b.x), q.maxX) - Math.max(Math.min(a.x, b.x), q.minX),
        );
      if (a.x === b.x && a.x > q.minX && a.x < q.maxX)
        n += Math.max(
          0,
          Math.min(Math.max(a.y, b.y), q.maxY) - Math.max(Math.min(a.y, b.y), q.minY),
        );
    }
  }
  return n;
}
const length = (r: Point[]) =>
  r.slice(1).reduce((n, q, i) => n + Math.abs(q.x - r[i]!.x) + Math.abs(q.y - r[i]!.y), 0);

const BOARD = 'board.esp32_devkitc_wroom32';
const T = (component: string, terminal: string) =>
  ({ kind: 'terminal', component, terminal }) as const;

/**
 * The owner's case, as in the ESP32 blink example: the board at (60, 0), its GND pin (J3 top,
 * (140, -180)) already wired out to the right to a ground, an LED branch on GPIO2, and a NEW
 * ground placed below-left of the board, at (-20, 240), to be wired to the same GND pin.
 */
function esp32GndCase() {
  let doc = newDoc();
  const u = must(addComponent(doc, BOARD, { x: 60, y: 0 }));
  doc = u.doc;
  const g1 = must(addComponent(doc, 'component.ground', { x: 200, y: -120 }));
  doc = g1.doc;
  const r = must(addComponent(doc, 'component.resistor', { x: 240, y: 100 }));
  doc = r.doc;
  const wireRouted = (from: ReturnType<typeof T>, to: ReturnType<typeof T>) => {
    const a = terminalPosition(doc, from.component, from.terminal)!;
    const b = terminalPosition(doc, to.component, to.terminal)!;
    doc = must(addWire(doc, from, to, autoRouteVertices([a, b], obstacles(doc)))).doc;
  };
  wireRouted(T(u.id, 'gnd'), T(g1.id, 'ref'));
  wireRouted(T(u.id, 'gpio2'), T(r.id, 'a'));
  const g2 = must(addComponent(doc, 'component.ground', { x: -20, y: 240 }));
  doc = g2.doc;
  return { doc, board: u.id, ground: g2.id };
}

describe('terminal keep-out: the ESP32 GND case (owner blocker)', () => {
  it('the new GND wire goes around the board, entering no unrelated pin, lead-in or body', () => {
    const { doc, board, ground } = esp32GndCase();
    const a = terminalPosition(doc, board, 'gnd')!;
    const b = terminalPosition(doc, ground, 'ref')!;
    expect(a).toEqual({ x: 140, y: -180 });
    expect(b).toEqual({ x: -20, y: 220 });
    const obs = obstacles(doc);
    // Root cause, reproduced: the route the old ranking chose here ran straight down the J3 pin
    // column (it preferred passing pins to running 20 units along the existing GND wire).
    const old = orthogonalRoute([a, { x: a.x, y: b.y }, b]);
    expect(entered(old, obs).length).toBe(18);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const route = autoRoute([from, to], obs);
      expect(entered(route, obs)).toEqual([]);
      expect(leadsTouched(route, obs)).toBe(0);
      expect(throughBodies(route, obs.boxes)).toBe(0);
      // Visible clearance around the pin field: no unrelated header pin within two grid steps
      // of the route, except the GND pin's own neighbours (every way out passes them).
      const hugged = (obs.field ?? []).filter(
        (p) =>
          Math.hypot(p.x - a.x, p.y - a.y) > 20 &&
          route.slice(1).some((q, i) => dist(p, route[i]!, q) <= 20),
      );
      expect(hugged).toEqual([]);
      expect(route).toEqual(
        from === a
          ? [a, { x: 140, y: -220 }, { x: -60, y: -220 }, { x: -60, y: 220 }, b]
          : autoRoute([b, a], obs),
      );
    }
  });

  it('committed: only the selected GND pin joins the ground net; every other pin keeps its own net', () => {
    const { doc, board, ground } = esp32GndCase();
    const a = terminalPosition(doc, board, 'gnd')!;
    const b = terminalPosition(doc, ground, 'ref')!;
    const before = connectivity(doc);
    const w = must(
      addWire(doc, T(board, 'gnd'), T(ground, 'ref'), autoRouteVertices([a, b], obstacles(doc))),
    );
    const g = connectivity(w.doc);
    const gnd = g.nodeOf.get(`${board}:gnd`);
    expect(gnd).toBeDefined();
    expect(g.nodeOf.get(`${ground}:ref`)).toBe(gnd);
    for (const pin of ESP32_DEVKITC_WROOM32.pins) {
      const t = boardTerminalId(pin);
      if (!t || t === 'gnd') continue;
      // Not in the ground net, and exactly the node it had before the wire was drawn.
      expect(g.nodeOf.get(`${board}:${t}`), t).not.toBe(gnd);
      expect(g.nodeOf.get(`${board}:${t}`), t).toBe(before.nodeOf.get(`${board}:${t}`));
    }
    expect(checkCircuit(w.doc).filter((i) => i.code === 'wire_over_terminal')).toEqual([]);
    expect(
      wireRoute(
        w.doc,
        w.doc.layout.wires.find((x) => x.id === w.id)!,
      ),
    ).toEqual(autoRoute([a, b], obstacles(doc)));
  });

  it('even a wire stored along the header (an old project) connects nothing it crosses, and is flagged', () => {
    const { doc, board, ground } = esp32GndCase();
    const a = terminalPosition(doc, board, 'gnd')!;
    const b = terminalPosition(doc, ground, 'ref')!;
    const old = must(addWire(doc, T(board, 'gnd'), T(ground, 'ref'), [{ x: a.x, y: b.y }]));
    const route = wireRoute(
      old.doc,
      old.doc.layout.wires.find((x) => x.id === old.id)!,
    )!;
    const crossed = ESP32_DEVKITC_WROOM32.pins
      .map((p) => boardTerminalId(p))
      .filter((t): t is string => !!t && t !== 'gnd')
      .filter((t) => {
        const p = terminalPosition(old.doc, board, t)!;
        return route.slice(1).some((q, i) => dist(p, route[i]!, q) === 0);
      });
    expect(crossed.length).toBeGreaterThan(5);
    const g = connectivity(old.doc);
    const gnd = g.nodeOf.get(`${board}:gnd`);
    for (const t of crossed) expect(g.nodeOf.get(`${board}:${t}`) ?? null, t).not.toBe(gnd);
    const flagged = checkCircuit(old.doc)
      .filter((i) => i.code === 'wire_over_terminal')
      .flatMap((i) => (i.code === 'wire_over_terminal' ? i.terminals : []));
    expect(flagged.sort()).toEqual([...crossed].sort());
  });

  it('every ground position around the board: no GND route enters an unrelated pin (both directions)', () => {
    const { doc: base, board } = esp32GndCase();
    let routes = 0;
    for (let x = -400; x <= 600; x += 40)
      for (let y = -400; y <= 480; y += 40) {
        const g = addComponent(base, 'component.ground', { x, y });
        if (!g.ok) continue;
        const doc = g.doc;
        const bx = boxes(doc);
        const mine = bx.at(-1)!;
        if (
          bx
            .slice(0, -1)
            .some(
              (q) =>
                mine.maxX > q.minX - 20 &&
                mine.minX < q.maxX + 20 &&
                mine.maxY > q.minY - 20 &&
                mine.minY < q.maxY + 20,
            )
        )
          continue; // overlapping another part
        const obs = routeObstacles(doc, bx);
        const a = terminalPosition(doc, board, 'gnd')!;
        const b = terminalPosition(doc, g.id, 'ref')!;
        for (const [p, q] of [
          [a, b],
          [b, a],
        ] as const) {
          const r = autoRoute([p, q], obs);
          routes++;
          expect(entered(r, obs), `ground at ${x},${y}`).toEqual([]);
          expect(leadsTouched(r, obs), `ground at ${x},${y}`).toBe(0);
        }
      }
    expect(routes).toBeGreaterThan(900);
  });
});

describe('terminal keep-out: generic cases', () => {
  it('a wire between two terminals does not pass through a third, unrelated terminal', () => {
    let doc = newDoc();
    const r1 = must(addComponent(doc, 'component.resistor', { x: 0, y: 400 }));
    doc = r1.doc;
    const r2 = must(addComponent(doc, 'component.resistor', { x: 280, y: 400 }));
    doc = r2.doc;
    // R3 stands vertically with its upper lead exactly on the straight line between them.
    const r3 = must(addComponent(doc, 'component.resistor', { x: 140, y: 440 }));
    doc = r3.doc;
    doc = {
      ...doc,
      layout: {
        ...doc.layout,
        components: { ...doc.layout.components, [r3.id]: { x: 140, y: 440, rotation: 90 } },
      },
    };
    const a = terminalPosition(doc, r1.id, 'b')!;
    const b = terminalPosition(doc, r2.id, 'a')!;
    const r3a = terminalPosition(doc, r3.id, 'a')!;
    expect(a.y).toBe(b.y);
    expect(r3a).toEqual({ x: 140, y: 400 }); // on the straight path
    const obs = obstacles(doc);
    const route = autoRoute([a, b], obs);
    expect(entered(route, obs)).toEqual([]);
    expect(throughBodies(route, obs.boxes)).toBe(0);
    const w = must(addWire(doc, T(r1.id, 'b'), T(r2.id, 'a'), autoRouteVertices([a, b], obs)));
    const g = connectivity(w.doc);
    expect(g.nodeOf.get(`${r1.id}:b`)).toBe(g.nodeOf.get(`${r2.id}:a`));
    expect(g.nodeOf.get(`${r3.id}:a`)).toBeUndefined();
    expect(g.nodeOf.get(`${r3.id}:b`)).toBeUndefined();
  });

  it('dense pins: the router takes a longer safe path instead of crossing terminal zones', () => {
    // A 900-unit column of pins at a 20-unit pitch between the ends: every short shape (L or
    // three-segment channel up to 8 grid steps out) enters it; the search goes around its end.
    const column: Point[] = [];
    for (let y = -440; y <= 440; y += 20) column.push({ x: 100, y });
    const obs: RouteObstacles = { segments: [], boxes: [], points: column };
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 0 };
    const route = autoRoute([a, b], obs);
    expect(entered(route, obs)).toEqual([]);
    expect(length(route)).toBeGreaterThan(2 * 440);
    expect(route[0]).toEqual(a);
    expect(route.at(-1)).toEqual(b);
    // Orthogonal throughout.
    for (let i = 0; i < route.length - 1; i++)
      expect(route[i]!.x === route[i + 1]!.x || route[i]!.y === route[i + 1]!.y).toBe(true);
  });

  it('a pin boxed in on three sides leaves along its own wire, never into a neighbour pin', () => {
    const { doc, board } = esp32GndCase();
    // GPIO2 is wired out to the right; its neighbours above and below are pins, the board is
    // behind it. A new wire from GPIO2 to a far-left ground must not run down the header.
    const g = must(addComponent(doc, 'component.ground', { x: -300, y: 300 }));
    const obs = obstacles(g.doc);
    const a = terminalPosition(g.doc, board, 'gpio2')!;
    const b = terminalPosition(g.doc, g.id, 'ref')!;
    const route = autoRoute([a, b], obs);
    expect(entered(route, obs)).toEqual([]);
    expect(leadsTouched(route, obs)).toBe(0);
    expect(throughBodies(route, obs.boxes)).toBe(0);
  });

  it('save and load: the routed GND wire is identical, still clean, and joins the same nets', () => {
    const { doc, board, ground } = esp32GndCase();
    const a = terminalPosition(doc, board, 'gnd')!;
    const b = terminalPosition(doc, ground, 'ref')!;
    const w = must(
      addWire(doc, T(board, 'gnd'), T(ground, 'ref'), autoRouteVertices([a, b], obstacles(doc))),
    );
    const text = serializePackage(
      createPackage(w.doc, { appVersion: '0.1.0', exportedAt: '2026-10-06T00:00:00.000Z' }),
    );
    const back = parsePackage(text);
    if (!back.ok) throw new Error(JSON.stringify(back.error));
    const route = (d: ProjectDocument) =>
      wireRoute(
        d,
        d.layout.wires.find((x) => x.id === w.id)!,
      )!;
    expect(route(back.doc)).toEqual(route(w.doc));
    const obs = routeObstacles(back.doc, boxes(back.doc), new Set([w.id]));
    expect(entered(route(back.doc), obs)).toEqual([]);
    expect([...connectivity(back.doc).nodeOf.entries()]).toEqual([
      ...connectivity(w.doc).nodeOf.entries(),
    ]);
  });
});
