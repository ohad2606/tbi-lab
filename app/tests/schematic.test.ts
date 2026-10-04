/**
 * Sprint 9: the generated professional schematic. The central invariant: reading the DRAWING
 * back (wires and their ends, pins on wires, ground symbols, rail labels, net labels of the same
 * name) gives exactly the project's electrical nodes — the schematic can neither lose, add nor
 * merge a connection, and it holds no state of its own.
 */
import { describe, expect, it } from 'vitest';
import {
  GROUND_NODE,
  connectivity,
  deleteSelection,
  moveSelection,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { mixedCircuit, place, wire } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import { EXAMPLES } from '../src/examples/catalog.js';
import {
  schematicLayout,
  strictlyInside,
  type Point,
  type SchematicLayout,
} from '../src/views/schematic/layout.js';
import { SCHEMATIC_SYMBOLS } from '../src/views/schematic/symbols.js';

class UF {
  private p = new Map<string, string>();
  find(k: string): string {
    if (!this.p.has(k)) this.p.set(k, k);
    let r = k;
    while (this.p.get(r) !== r) r = this.p.get(r)!;
    this.p.set(k, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

const on = (p: Point, pts: Point[]) =>
  pts.some((q) => q.x === p.x && q.y === p.y) ||
  pts.slice(1).some((b, i) => strictlyInside(p, pts[i]!, b));

/** Electrical groups as the drawing shows them: pin key → group root. */
function readBack(l: SchematicLayout): Map<string, string> {
  const uf = new UF();
  const pins: [string, Point][] = [
    ...l.parts.flatMap((p) =>
      Object.entries(p.pins).map(([t, at]) => [`${p.component}:${t}`, at] as [string, Point]),
    ),
    ...l.modules.flatMap((m) =>
      m.pins.map((p) => [`${m.component}:${p.terminal}`, p.at] as [string, Point]),
    ),
  ];
  const points: [string, Point][] = [
    ...pins,
    ...l.marks.map((m, i) => [`mark${i}`, m.at] as [string, Point]),
  ];
  l.wires.forEach((w, i) => {
    for (const [k, p] of points) if (on(p, w.points)) uf.union(k, `wire${i}`);
    l.wires.forEach((v, j) => {
      if (i !== j && (on(w.points[0]!, v.points) || on(w.points.at(-1)!, v.points)))
        uf.union(`wire${i}`, `wire${j}`);
    });
  });
  for (const [k, p] of points)
    for (const [k2, p2] of points) if (k !== k2 && p.x === p2.x && p.y === p2.y) uf.union(k, k2);
  l.marks.forEach((m, i) => {
    if (m.kind === 'ground' && m.node !== '') uf.union(`mark${i}`, 'GROUND');
    if (m.kind === 'rail') uf.union(`mark${i}`, `rail:${m.supply}`);
    if (m.kind === 'net') uf.union(`mark${i}`, `net:${m.name}`);
  });
  return new Map(pins.map(([k]) => [k, uf.find(k)]));
}

function expectFaithful(doc: ProjectDocument) {
  const l = schematicLayout(doc);
  const g = connectivity(doc);
  const drawn = readBack(l);
  const byNode = new Map<string, Set<string>>();
  for (const c of g.components) {
    const sym = SCHEMATIC_SYMBOLS[c.type];
    if (sym.kind === 'ground') {
      // References are drawn as the ground marks of what they ground.
      expect(l.references).toContain(c.id);
      continue;
    }
    for (const t of c.terminals) {
      const k = `${c.id}:${t.terminal}`;
      if (sym.kind === 'module' && t.node === null) {
        expect(drawn.has(k), `${k} unconnected module pins are not drawn`).toBe(false);
        continue;
      }
      expect(drawn.has(k), `${k} is drawn`).toBe(true);
      const group = drawn.get(k)!;
      if (t.node === null) {
        // An open pin touches nothing.
        const others = [...drawn.entries()].filter(([o, gr]) => o !== k && gr === group);
        expect(others, `${k} is open`).toEqual([]);
        continue;
      }
      if (!byNode.has(t.node)) byNode.set(t.node, new Set());
      byNode.get(t.node)!.add(group);
    }
  }
  // One drawn group per node, and distinct nodes never share a drawn group.
  const seen = new Map<string, string>();
  for (const [node, groups] of byNode) {
    expect([...groups], `node ${node} is one drawn connection`).toHaveLength(1);
    const gr = [...groups][0]!;
    expect(seen.get(gr), `node ${node} is not merged with another`).toBeUndefined();
    seen.set(gr, node);
  }
  return l;
}

/** Proper crossings between wires of DIFFERENT nodes (touching ends are connections). */
function crossings(l: SchematicLayout): number {
  const segs = l.wires.flatMap((w) =>
    w.points.slice(1).map((b, i) => ({ node: w.node, a: w.points[i]!, b })),
  );
  let n = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.node === t.node) continue;
      const sh = s.a.y === s.b.y;
      const th = t.a.y === t.b.y;
      if (sh === th) continue;
      const h = sh ? s : t;
      const v = sh ? t : s;
      const x = v.a.x;
      const y = h.a.y;
      if (
        x > Math.min(h.a.x, h.b.x) &&
        x < Math.max(h.a.x, h.b.x) &&
        y > Math.min(v.a.y, v.b.y) &&
        y < Math.max(v.a.y, v.b.y)
      )
        n++;
    }
  return n;
}

describe('generated schematic', () => {
  it('the representative ESP32 + LED + resistor + button + supply circuit is drawn faithfully', () => {
    const { doc, ids } = mixedCircuit();
    const l = expectFaithful(doc);
    expect(crossings(l)).toBe(0);
    // ESP32 is a module block with exactly its connected pins, by name, on their header sides.
    expect(l.modules).toHaveLength(1);
    const pins = l.modules[0]!.pins.map((p) => `${p.side}:${p.name}`);
    expect(pins.sort()).toEqual(['left:IO34', 'right:GND', 'right:IO4']);
    // Ground connections are ground symbols (one per grounded end), the supply a rail label.
    const grounds = l.marks.filter((m) => m.kind === 'ground');
    expect(grounds.length).toBe(4); // PSU −, pull-down, LED cathode, board GND
    expect(grounds.every((m) => m.node === GROUND_NODE)).toBe(true);
    const rails = l.marks.filter((m) => m.kind === 'rail');
    expect(rails.map((m) => m.supply)).toEqual([ids.psu, ids.psu]);
    // Signal flow: the LED branch runs right from IO4, the input chain left from IO34.
    const part = (id: string) => l.parts.find((p) => p.component === id)!;
    const io4 = l.modules[0]!.pins.find((p) => p.name === 'IO4')!;
    expect(part(ids.rled!).x).toBeGreaterThan(io4.at.x);
    expect(part(ids.led!).x).toBeGreaterThan(part(ids.rled!).x);
    const io34 = l.modules[0]!.pins.find((p) => p.name === 'IO34')!;
    expect(part(ids.rin!).x).toBeLessThan(io34.at.x);
    // The LED hangs to ground with its anode up (cathode on the ground side).
    const led = part(ids.led!);
    expect(led.vertical).toBe(true);
    expect(led.pins.anode!.y).toBeLessThan(led.pins.cathode!.y);
  });

  it('every curated example is drawn faithfully and without wire crossings', () => {
    for (const e of EXAMPLES) {
      const l = expectFaithful(e.document);
      expect(crossings(l), e.id).toBe(0);
    }
  });

  it('cycles and a node on two MCU pins are joined by net labels of the same name', () => {
    const fixture = mixedCircuit();
    const ids = fixture.ids;
    let doc = fixture.doc;
    // A second path IO34 ↔ IO4 node via a resistor (a cycle through the board), and a second
    // pin on the IO4 node.
    const r = place(doc, 'component.resistor', 0, 400);
    doc = r.doc;
    doc = wire(doc, [r.id, 'a'], [ids.rin!, 'a']);
    doc = wire(doc, [r.id, 'b'], [ids.led!, 'anode']);
    doc = wire(doc, [ids.u!, 'gpio2'], [ids.rled!, 'a']);
    const l = expectFaithful(doc);
    expect(l.marks.some((m) => m.kind === 'net')).toBe(true);
    expect(crossings(l)).toBe(0);
  });

  it('parallel parts, a floating supply, open pins and unconnected parts', () => {
    let doc = newDoc();
    const p = place(doc, 'instrument.lab_psu', 0, 0);
    doc = p.doc;
    const r1 = place(doc, 'component.resistor', 200, 0);
    doc = r1.doc;
    const r2 = place(doc, 'component.resistor', 200, 100);
    doc = r2.doc;
    const d = place(doc, 'component.diode', 400, 0);
    doc = d.doc;
    const lone = place(doc, 'component.led', 600, 300);
    doc = lone.doc;
    doc = wire(doc, [p.id, 'positive'], [r1.id, 'a']);
    doc = wire(doc, [p.id, 'negative'], [r1.id, 'b']);
    doc = wire(doc, [r2.id, 'a'], [r1.id, 'a']);
    doc = wire(doc, [r2.id, 'b'], [r1.id, 'b']);
    doc = wire(doc, [d.id, 'anode'], [r1.id, 'a']);
    const l = expectFaithful(doc);
    // The new project's own supply and ground stay unwired here.
    expect(l.unconnected).toEqual(['PSU1', 'GND1', lone.id]);
    expect(crossings(l)).toBe(0);
  });

  it('is deterministic and ignores the 2D drawing; edits in the model show up', () => {
    const { doc, ids } = mixedCircuit();
    const a = schematicLayout(doc);
    expect(JSON.stringify(schematicLayout(doc))).toBe(JSON.stringify(a));
    const moved = must(
      moveSelection(
        doc,
        { components: doc.components.map((c) => c.id), wires: [], junctions: [] },
        {
          x: 300,
          y: -200,
        },
      ),
    ).doc;
    expect(schematicLayout(moved)).toEqual(a);
    // A design value is not topology: same geometry.
    const valued = must(setParam(doc, ids.rled!, 'resistance', { value: 330, unit: 'ohm' })).doc;
    expect(schematicLayout(valued)).toEqual(a);
    // Removing a part removes it; the rest stays faithful.
    const without = must(
      deleteSelection(doc, { components: [ids.rpd!], wires: [], junctions: [] }),
    ).doc;
    const b = expectFaithful(without);
    expect(b.parts.some((p) => p.component === ids.rpd)).toBe(false);
    // Reconnecting: the LED's cathode moves from ground to a new resistor.
    const r = place(without, 'component.resistor', 600, 200);
    let rewired = r.doc;
    rewired = must(
      deleteSelection(rewired, {
        components: [],
        wires: rewired.layout.wires
          .filter((w) =>
            [w.from, w.to].some(
              (e) => e.kind === 'terminal' && e.component === ids.led && e.terminal === 'cathode',
            ),
          )
          .map((w) => w.id),
        junctions: [],
      }),
    ).doc;
    rewired = wire(rewired, [ids.led!, 'cathode'], [r.id, 'a']);
    const c = expectFaithful(rewired);
    const led = c.parts.find((p) => p.component === ids.led)!;
    expect(led.vertical).toBe(false); // now in series towards the new resistor
  });

  it('every component type has a schematic symbol', () => {
    for (const e of EXAMPLES)
      for (const comp of e.document.components)
        expect(SCHEMATIC_SYMBOLS[comp.type], comp.type).toBeDefined();
  });
});
