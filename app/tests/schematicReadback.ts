/**
 * Reading a generated schematic DRAWING back into electrical groups (Sprint 9): wires and their
 * ends, pins on wires, ground symbols, rail labels and net labels of the same name. Shared by the
 * schematic tests and the cross-view semantics invariant.
 */
import { expect } from 'vitest';
import { connectivity, type ProjectDocument } from '@tbi-lab/domain';
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
export function readBack(l: SchematicLayout): Map<string, string> {
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

export function expectFaithful(doc: ProjectDocument) {
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
export function crossings(l: SchematicLayout): number {
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
