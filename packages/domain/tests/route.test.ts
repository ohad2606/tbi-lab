/**
 * Wire auto-routing (Product Alpha maintenance): a new wire gets a visually independent route.
 * Existing wire segments are obstacles for coincident geometry; crossings stay allowed; bodies
 * are avoided; connectivity never follows from where a route happens to pass.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  autoRoute,
  autoRouteVertices,
  createPackage,
  moveWireSegment,
  orthogonalRoute,
  parsePackage,
  rotatePoint,
  routeObstacles,
  serializePackage,
  terminalPosition,
  wireCrossings,
  wireRoute,
  type Point,
  type ProjectDocument,
  type RouteBox,
  type RouteObstacles,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

// Symbol bodies as the app draws them (app/src/ui/symbols.tsx `bbox`).
const BBOX: Record<string, [number, number, number, number]> = {
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

type Seg = [Point, Point];
const segs = (r: Point[]): Seg[] => r.slice(1).map((p, i) => [r[i]!, p]);
function overlap(r: Point[], others: readonly (readonly [Point, Point])[]): number {
  let n = 0;
  for (const [a, b] of segs(r))
    for (const [c, d] of others) {
      if (a.y === b.y && c.y === d.y && a.y === c.y && a.x !== b.x && c.x !== d.x)
        n += Math.max(
          0,
          Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
            Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)),
        );
      if (a.x === b.x && c.x === d.x && a.x === c.x && a.y !== b.y && c.y !== d.y)
        n += Math.max(
          0,
          Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) -
            Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)),
        );
    }
  return n;
}
function throughBodies(r: Point[], bx: readonly RouteBox[]): number {
  let n = 0;
  for (const [a, b] of segs(r))
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
  return n;
}
const undirected = (r: Point[]) =>
  segs(r)
    .map(([a, b]) =>
      [a, b]
        .map((p) => `${p.x},${p.y}`)
        .sort()
        .join('|'),
    )
    .sort();

/** The reproduced circuit: PSU+ -> LED -> resistor, all on one row (y = -20). */
function loopCircuit() {
  let doc = newDoc();
  const led = must(addComponent(doc, 'component.led', { x: 0, y: -20 }));
  doc = led.doc;
  const r = must(addComponent(doc, 'component.resistor', { x: 120, y: -20 }));
  doc = r.doc;
  doc = must(
    addWire(
      doc,
      { kind: 'terminal', component: 'PSU1', terminal: 'positive' },
      { kind: 'terminal', component: led.id, terminal: 'anode' },
    ),
  ).doc;
  doc = must(
    addWire(
      doc,
      { kind: 'terminal', component: led.id, terminal: 'cathode' },
      { kind: 'terminal', component: r.id, terminal: 'a' },
    ),
  ).doc;
  return { doc, led: led.id, res: r.id };
}

describe('auto-routing a new wire', () => {
  it('1. the reproduced PSU+ -> LED -> R -> PSU- return gets its own channel below the circuit', () => {
    const { doc, res } = loopCircuit();
    const from = terminalPosition(doc, res, 'b')!; // (160,-20), on the circuit's row
    const to = terminalPosition(doc, 'PSU1', 'negative')!; // (-80,20)
    const obs = obstacles(doc);
    // Root cause: the fixed horizontal-first rule runs straight back over the upper wires.
    const old = orthogonalRoute([from, to]);
    expect(overlap(old, obs.segments)).toBeGreaterThan(0);
    // The router: down from the resistor, left below the circuit, into PSU- orthogonally.
    const route = autoRoute([from, to], obs);
    expect(route).toEqual([from, { x: 160, y: 20 }, to]);
    expect(overlap(route, obs.segments)).toBe(0);
    expect(throughBodies(route, obs.boxes)).toBe(0);
    expect(route[1]!.x).toBe(from.x); // leaves vertically
    expect(route[1]!.y).toBeGreaterThan(from.y); // downward, below the upper wire
    expect(route.at(-2)!.y).toBe(to.y); // arrives horizontally at PSU-
    // Committed as ordinary vertices: the stored wire draws exactly this route.
    const w = must(
      addWire(
        doc,
        { kind: 'terminal', component: res, terminal: 'b' },
        { kind: 'terminal', component: 'PSU1', terminal: 'negative' },
        autoRouteVertices([from, to], obs),
      ),
    );
    const wire = w.doc.layout.wires.find((x) => x.id === w.id)!;
    expect(wireRoute(w.doc, wire)).toEqual(route);
  });

  it('2. drawing the same return in the reverse direction gives the same geometry', () => {
    const { doc, res } = loopCircuit();
    const a = terminalPosition(doc, res, 'b')!;
    const b = terminalPosition(doc, 'PSU1', 'negative')!;
    const fwd = autoRoute([a, b], obstacles(doc));
    const rev = autoRoute([b, a], obstacles(doc));
    expect(undirected(rev)).toEqual(undirected(fwd));
    expect(overlap(rev, obstacles(doc).segments)).toBe(0);
  });

  it('3. an existing horizontal wire: the return goes vertical first instead of along it', () => {
    const obs: RouteObstacles = {
      segments: [
        [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
      ],
      boxes: [],
      points: [],
    };
    const r = autoRoute(
      [
        { x: 200, y: 0 },
        { x: 0, y: 100 },
      ],
      obs,
    );
    expect(overlap(r, obs.segments)).toBe(0);
    expect(r).toEqual([
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ]);
  });

  it('4. an existing vertical wire: the route runs horizontally elsewhere instead of along it', () => {
    const obs: RouteObstacles = {
      segments: [
        [
          { x: 0, y: 0 },
          { x: 0, y: 200 },
        ],
      ],
      boxes: [],
      points: [],
    };
    const r = autoRoute(
      [
        { x: 100, y: 200 },
        { x: 0, y: 0 },
      ],
      obs,
    );
    expect(overlap(r, obs.segments)).toBe(0);
    expect(r).toEqual([
      { x: 100, y: 200 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it('5. an unavoidable crossing is allowed; a coincident run is not', () => {
    const wall: RouteObstacles = {
      segments: [
        [
          { x: 100, y: -1000 },
          { x: 100, y: 1000 },
        ],
      ],
      boxes: [],
      points: [],
    };
    const crossing = autoRoute(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      wall,
    );
    expect(crossing).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]); // straight across, bridged
    // A collinear obstacle in the way: the straight route would overlap it, so it detours.
    const collinear: RouteObstacles = {
      segments: [
        [
          { x: 40, y: 0 },
          { x: 160, y: 0 },
        ],
      ],
      boxes: [],
      points: [],
    };
    const detour = autoRoute(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      collinear,
    );
    expect(overlap(detour, collinear.segments)).toBe(0);
    expect(detour.length).toBe(4); // one clean U channel
  });

  it('6. explicitly attaching to an existing wire still works and joins exactly that net', () => {
    const { doc, led, res } = loopCircuit();
    const upper = doc.layout.wires[1]!; // LED cathode -> R.a, y = -20 from x 40 to 80
    const at = { x: 60, y: -20 };
    const from = terminalPosition(doc, 'PSU1', 'negative')!;
    const obs = obstacles(doc);
    const verts = autoRouteVertices([from, at], obs);
    const route = autoRoute([from, at], obs);
    expect(overlap(route, obs.segments)).toBe(0); // arrives across the wire, not along it
    const r = must(
      addWire(
        doc,
        { kind: 'terminal', component: 'PSU1', terminal: 'negative' },
        { kind: 'wire', wire: upper.id, at },
        verts,
      ),
    );
    expect(r.doc.layout.junctions).toHaveLength(1);
    const byConn = (c: string, t: string) =>
      r.doc.connections.find((x) => x.component === c && x.terminal === t)?.net;
    expect(byConn('PSU1', 'negative')).toBe(byConn(led, 'cathode'));
    expect(byConn(res, 'a')).toBe(byConn(led, 'cathode'));
  });

  it('7. parallel returns get distinct channels', () => {
    const first: RouteObstacles = { segments: [], boxes: [], points: [] };
    const w1 = autoRoute(
      [
        { x: 200, y: 0 },
        { x: 0, y: 100 },
      ],
      first,
    );
    const second: RouteObstacles = { segments: segs(w1), boxes: [], points: [] };
    const w2 = autoRoute(
      [
        { x: 200, y: 40 },
        { x: 0, y: 140 },
      ],
      second,
    );
    expect(overlap(w2, segs(w1))).toBe(0);
  });

  it('8. the chosen route is stored geometry: identical after save and reload', () => {
    const { doc, res } = loopCircuit();
    const from = terminalPosition(doc, res, 'b')!;
    const to = terminalPosition(doc, 'PSU1', 'negative')!;
    const w = must(
      addWire(
        doc,
        { kind: 'terminal', component: res, terminal: 'b' },
        { kind: 'terminal', component: 'PSU1', terminal: 'negative' },
        autoRouteVertices([from, to], obstacles(doc)),
      ),
    );
    const text = serializePackage(
      createPackage(w.doc, { appVersion: '0.1.0', exportedAt: '2026-09-26T00:00:00.000Z' }),
    );
    const back = parsePackage(text);
    if (!back.ok) throw new Error(JSON.stringify(back.error));
    const before = wireRoute(
      w.doc,
      w.doc.layout.wires.find((x) => x.id === w.id)!,
    );
    const after = wireRoute(
      back.doc,
      back.doc.layout.wires.find((x) => x.id === w.id)!,
    );
    expect(after).toEqual(before);
  });

  it('10. an auto-routed segment can still be dragged; its endpoints stay put', () => {
    const { doc, res } = loopCircuit();
    const from = terminalPosition(doc, res, 'b')!;
    const to = terminalPosition(doc, 'PSU1', 'negative')!;
    const w = must(
      addWire(
        doc,
        { kind: 'terminal', component: res, terminal: 'b' },
        { kind: 'terminal', component: 'PSU1', terminal: 'negative' },
        autoRouteVertices([from, to], obstacles(doc)),
      ),
    );
    const wire = w.doc.layout.wires.find((x) => x.id === w.id)!;
    const route = wireRoute(w.doc, wire)!;
    const horiz = route.findIndex((p, i) => i < route.length - 1 && p.y === route[i + 1]!.y);
    const moved = must(moveWireSegment(w.doc, w.id, horiz, { x: 0, y: 40 }));
    const r2 = wireRoute(
      moved.doc,
      moved.doc.layout.wires.find((x) => x.id === w.id)!,
    )!;
    expect(r2[0]).toEqual(from);
    expect(r2.at(-1)).toEqual(to);
    expect(r2.some((p) => p.y === 60)).toBe(true);
  });

  it('a route that crosses or passes wires never changes connectivity; only its endpoints do', () => {
    const { doc, res } = loopCircuit();
    const from = terminalPosition(doc, res, 'b')!;
    const to = terminalPosition(doc, 'PSU1', 'negative')!;
    // Even the old overlapping geometry, stored explicitly, adds no connection.
    const overlapping = must(
      addWire(
        doc,
        { kind: 'terminal', component: res, terminal: 'b' },
        { kind: 'terminal', component: 'PSU1', terminal: 'negative' },
        orthogonalRoute([from, to]).slice(1, -1),
      ),
    ).doc;
    const net = (d: ProjectDocument, c: string, t: string) =>
      d.connections.find((x) => x.component === c && x.terminal === t)?.net;
    // R.b and PSU- are joined (the wire's explicit endpoints) ...
    expect(net(overlapping, res, 'b')).toBe(net(overlapping, 'PSU1', 'negative'));
    // ... and the upper nets it ran over are still separate from it.
    expect(net(overlapping, 'PSU1', 'positive')).not.toBe(net(overlapping, 'PSU1', 'negative'));
    expect(net(overlapping, res, 'a')).not.toBe(net(overlapping, res, 'b'));
    expect(overlapping.layout.junctions).toHaveLength(0);
  });

  it('is deterministic and grid-aligned; unrelated crossings stay bridged (no junction)', () => {
    const { doc, res } = loopCircuit();
    const a = terminalPosition(doc, res, 'b')!;
    const b = terminalPosition(doc, 'PSU1', 'negative')!;
    const runs = Array.from({ length: 5 }, () => JSON.stringify(autoRoute([a, b], obstacles(doc))));
    expect(new Set(runs).size).toBe(1);
    for (const p of autoRoute([a, b], obstacles(doc))) {
      expect(Math.abs(p.x % 20)).toBe(0);
      expect(Math.abs(p.y % 20)).toBe(0);
    }
    // A vertical wire drawn through the finished loop crosses it: bridged, not joined.
    const w = must(
      addWire(
        doc,
        { kind: 'terminal', component: res, terminal: 'b' },
        { kind: 'terminal', component: 'PSU1', terminal: 'negative' },
        autoRouteVertices([a, b], obstacles(doc)),
      ),
    ).doc;
    const g = must(addComponent(w, 'component.ground', { x: 100, y: 120 }));
    const cross = must(
      addWire(
        g.doc,
        { kind: 'terminal', component: g.id, terminal: 'ref' },
        { kind: 'terminal', component: res, terminal: 'a' },
        autoRouteVertices(
          [terminalPosition(g.doc, g.id, 'ref')!, terminalPosition(g.doc, res, 'a')!],
          obstacles(g.doc),
        ),
      ),
    ).doc;
    expect(cross.layout.junctions).toHaveLength(0);
    // Every crossing it makes is an unconnected, bridged crossing (none is at a junction).
    for (const c of wireCrossings(cross))
      expect(cross.layout.junctions.some((j) => j.x === c.x && j.y === c.y)).toBe(false);
  });
});
