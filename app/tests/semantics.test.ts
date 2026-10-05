/**
 * Sprint 9 owner review: one electrical truth, four views. For representative circuits, reading
 * each view's DRAWING back by geometry alone — what touches what — gives exactly the project's
 * connectivity:
 *
 *   domain connectivity == schematic read-back == 3D read-back
 *
 * and the circuit canvas marks every place where geometry alone would suggest a connection the
 * project does not have (a bridge, a wire-over-terminal or a touching-terminals marker). No view
 * may visually imply a connection absent from the domain model, nor hide one it has.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  ESP32_DEVKITC_WROOM32,
  addWire,
  boardPinPosition,
  checkCircuit,
  contacts,
  moveSelection,
  rotatePoint,
  settleNets,
  terminalPosition,
  wireCrossings,
  wireRoute,
  type Point,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { mixedCircuit, place, wire } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import { EXAMPLES } from '../src/examples/catalog.js';
import {
  TERMINAL_HEIGHT,
  WIRE_RADIUS,
  deriveScene,
  type SceneDescription,
} from '../src/views/scene3d/scene.js';
import { componentBoxes, moveRouted, rotateRouted } from '../src/ui/routing.js';
import { expectFaithful } from './schematicReadback.js';

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

/** Domain truth: pin key → net (unwired pins are absent). */
const domainNets = (doc: ProjectDocument) =>
  new Map(doc.connections.map((c) => [`${c.component}:${c.terminal}`, c.net]));

/** Partition of the domain's wired pins, as sorted groups. */
function partition(keys: string[], groupOf: (k: string) => string): string[][] {
  const m = new Map<string, string[]>();
  for (const k of keys) m.set(groupOf(k), [...(m.get(groupOf(k)) ?? []), k]);
  return [...m.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

type P3 = { x: number; y: number; z: number };
const sub = (a: P3, b: P3): P3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Shortest distance between segments ab and cd (closest points on two segments). */
function segDistance(a: P3, b: P3, c: P3, d: P3): number {
  const u = sub(b, a);
  const v = sub(d, c);
  const w = sub(a, c);
  const A = dot(u, u);
  const B = dot(u, v);
  const C = dot(v, v);
  const D = dot(u, w);
  const E = dot(v, w);
  const den = A * C - B * B;
  let sc = A < 1e-12 ? 0 : den < 1e-12 ? 0 : clamp01((B * E - C * D) / den);
  let tc = C < 1e-12 ? 0 : clamp01((A < 1e-12 ? E : B * sc + E) / C);
  if (A >= 1e-12) sc = clamp01((tc * B - D) / A);
  if (C >= 1e-12) tc = clamp01((sc * B + E) / C);
  const p = { x: a.x + u.x * sc, y: a.y + u.y * sc, z: a.z + u.z * sc };
  const q = { x: c.x + v.x * tc, y: c.y + v.y * tc, z: c.z + v.z * tc };
  return Math.sqrt(dot(sub(p, q), sub(p, q)));
}
/** Visual contact: tubes (wire radius, lead radius 0.08) closer than their radii plus a hair. */
const WIRE_TOUCH = 2 * WIRE_RADIUS + 0.05;
const LEAD_TOUCH = WIRE_RADIUS + 0.08 + 0.05;

/**
 * The 3D drawing read back by geometry: wires are conductors; a wire touching a terminal's lead
 * end (or another wire) joins it; terminals whose lead ends meet join, unless the scene marks the
 * spot as an open (not connected) joint, where the leads stop short; a solder joint joins.
 */
function sceneGroups(scene: SceneDescription): Map<string, string> {
  const uf = new UF();
  const terms = scene.components.flatMap((c) =>
    c.terminals.map((t) => ({
      key: `${c.id}:${t.id}`,
      open: !!t.open,
      at: { x: t.x, y: TERMINAL_HEIGHT[c.model], z: t.z },
    })),
  );
  for (const t of terms) uf.find(t.key);
  scene.wires.forEach((w, i) => {
    const segs = w.points.slice(1).map((b, k) => [w.points[k]!, b] as const);
    for (const t of terms)
      if (!t.open && segs.some(([a, b]) => segDistance(a, b, t.at, t.at) < LEAD_TOUCH)) {
        uf.union(`w${i}`, t.key);
      }
    scene.wires.forEach((v, j) => {
      if (j <= i) return;
      const vs = v.points.slice(1).map((b, k) => [v.points[k]!, b] as const);
      if (segs.some(([a, b]) => vs.some(([c, d]) => segDistance(a, b, c, d) < WIRE_TOUCH))) {
        uf.union(`w${i}`, `w${j}`);
      }
    });
  });
  for (const a of terms)
    for (const b of terms)
      if (a.key < b.key && !a.open && !b.open && segDistance(a.at, a.at, b.at, b.at) < 0.2)
        uf.union(a.key, b.key);
  for (const j of scene.joints)
    if (j.kind === 'contact') for (const k of j.terminals) uf.union(j.terminals[0]!, k);
  return new Map(terms.map((t) => [t.key, uf.find(t.key)]));
}

/**
 * Every place where the circuit canvas's geometry alone suggests a connection the project does
 * not have must carry a marker that says "not connected".
 */
function expectCanvasHonest(doc: ProjectDocument) {
  const nets = domainNets(doc);
  const issues = checkCircuit(doc);
  const flagged = (code: string, c: string, t: string) =>
    issues.some(
      (i) =>
        i.code === code &&
        i.components.some(
          (x, n) => x === c && i.terminals?.[i.code === 'terminals_touching' ? n : 0] === t,
        ),
    );
  const pins: { key: string; c: string; t: string; at: Point }[] = doc.components.flatMap((c) =>
    CATALOG[c.type].terminals.map(({ id: t }) => ({
      key: `${c.id}:${t}`,
      c: c.id,
      t,
      at: terminalPosition(doc, c.id, t)!,
    })),
  );
  // Touching terminals: a contact (dot), the same net, or a not-connected marker.
  const contactPairs = new Set(
    contacts(doc).flatMap((w) =>
      w.from.kind === 'terminal' && w.to.kind === 'terminal'
        ? [`${w.from.component}:${w.from.terminal}|${w.to.component}:${w.to.terminal}`]
        : [],
    ),
  );
  for (const a of pins)
    for (const b of pins) {
      if (a.c >= b.c || a.at.x !== b.at.x || a.at.y !== b.at.y) continue;
      const same = nets.get(a.key) !== undefined && nets.get(a.key) === nets.get(b.key);
      const contact =
        contactPairs.has(`${a.key}|${b.key}`) || contactPairs.has(`${b.key}|${a.key}`);
      if (contact) expect(same, `${a.key}~${b.key} contact is a connection`).toBe(true);
      if (!same)
        expect(
          flagged('terminals_touching', a.c, a.t) || flagged('terminals_touching', b.c, b.t),
          `${a.key} touches ${b.key} unconnected and is marked`,
        ).toBe(true);
    }
  // A wire over a terminal it does not end at: same net, or marked.
  for (const w of doc.layout.wires) {
    const r = wireRoute(doc, w)!;
    if (r.length < 2) continue;
    const ends = [w.from, w.to].flatMap((e) =>
      e.kind === 'terminal' ? [`${e.component}:${e.terminal}`] : [],
    );
    const wireNet = ends.map((k) => nets.get(k)).find((n) => n) ?? nets.get('');
    for (const p of pins) {
      if (ends.includes(p.key)) continue;
      const onRoute = r.slice(1).some((b, i) => {
        const a = r[i]!;
        return a.x === b.x
          ? p.at.x === a.x && p.at.y >= Math.min(a.y, b.y) && p.at.y <= Math.max(a.y, b.y)
          : p.at.y === a.y && p.at.x >= Math.min(a.x, b.x) && p.at.x <= Math.max(a.x, b.x);
      });
      if (!onRoute) continue;
      if (wireNet !== undefined && nets.get(p.key) === wireNet) continue;
      expect(
        flagged('wire_over_terminal', p.c, p.t) || flagged('terminals_touching', p.c, p.t),
        `${w.id} over ${p.key} is marked`,
      ).toBe(true);
    }
  }
  // Wire-to-wire: every crossing of different wires is a bridge (wireCrossings), never at a
  // terminal or junction.
  const spots = new Set([
    ...doc.layout.junctions.map((j) => `${j.x},${j.y}`),
    ...pins.map((p) => `${p.at.x},${p.at.y}`),
  ]);
  for (const c of wireCrossings(doc)) expect(spots.has(`${c.x},${c.y}`)).toBe(false);
}
function expectAllViewsAgree(doc: ProjectDocument, label: string) {
  const nets = domainNets(doc);
  const wired = [...nets.keys()];
  const domain = partition(wired, (k) => nets.get(k)!);
  // Schematic: its drawing read back is exactly the connectivity (nodes; grounds merge).
  expectFaithful(doc);
  // 3D: read back by geometry, the wired pins form exactly the project's nets, and no unwired pin
  // touches anything electrical.
  const scene = deriveScene(doc);
  const groups = sceneGroups(scene);
  expect(
    partition(wired, (k) => groups.get(k)!),
    `${label}: 3D == domain`,
  ).toEqual(domain);
  for (const [k, g] of groups) {
    if (nets.has(k)) continue;
    const others = [...groups].filter(([o, h]) => o !== k && h === g).map(([o]) => o);
    expect(others, `${label}: unwired ${k} touches nothing in 3D`).toEqual([]);
  }
  // Every 3D solder joint is a real connection; every open joint a real separation.
  for (const j of scene.joints) {
    const ns = new Set(j.terminals.map((k) => nets.get(k)));
    if (j.kind === 'contact') expect(ns.size, `${label}: contact joint`).toBe(1);
    else expect(ns.size > 1 || ns.has(undefined), `${label}: open joint`).toBe(true);
  }
  // Circuit canvas: every geometric suggestion of a non-existent connection is marked.
  expectCanvasHonest(doc);
}

// --- representative circuits ---------------------------------------------------------------

/** A wire laid straight down the ESP32 header (through every J3 pin) and two wires crossing. */
function crossingCircuit() {
  let doc = newDoc();
  doc = place(doc, 'board.esp32_devkitc_wroom32', 300, 0).doc;
  doc = place(doc, 'component.resistor', 600, 200).doc;
  doc = place(doc, 'component.resistor', 0, -300).doc;
  doc = place(doc, 'component.resistor', 200, -300).doc;
  doc = place(doc, 'component.resistor', 100, -400).doc;
  doc = place(doc, 'component.resistor', 100, -200).doc;
  doc = must(
    addWire(
      doc,
      { kind: 'terminal', component: 'U1', terminal: 'gnd' },
      { kind: 'terminal', component: 'R1', terminal: 'a' },
      [{ x: 380, y: 200 }],
    ),
  ).doc;
  doc = wire(doc, ['R2', 'b'], ['R3', 'a']);
  doc = wire(doc, ['R4', 'b'], ['R5', 'b']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}

/** The owner's case, joined: R1's lead on D1's lead (a direct contact) in a powered loop. */
function contactCircuit() {
  let doc = newDoc();
  doc = place(doc, 'component.resistor', 100, 200).doc;
  doc = place(doc, 'component.led', 180, 200).doc;
  doc = wire(doc, ['PSU1', 'positive'], ['R1', 'a']);
  doc = wire(doc, ['D1', 'cathode'], ['GND1', 'ref']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  expect(contacts(doc)).toHaveLength(1);
  return doc;
}

/** The owner's case as an older/imported document holds it: touching, NOT connected. */
function touchingCircuit() {
  let doc = newDoc();
  doc = place(doc, 'component.resistor', 100, 200).doc;
  doc = place(doc, 'component.led', 240, 200).doc;
  doc = wire(doc, ['PSU1', 'positive'], ['R1', 'a']);
  doc = wire(doc, ['D1', 'cathode'], ['GND1', 'ref']);
  doc.layout.components.D1!.x = 180; // laid on R1.b without an edit: no contact
  settleNets(doc, new Map());
  expect(contacts(doc)).toEqual([]);
  return doc;
}

/** A junction: three wires meeting at an explicit dot. */
function junctionCircuit() {
  let doc = newDoc();
  doc = place(doc, 'component.resistor', 100, 0).doc;
  doc = place(doc, 'component.resistor', 300, 0).doc;
  doc = place(doc, 'component.resistor', 200, 200).doc;
  doc = wire(doc, ['R1', 'b'], ['R2', 'a']);
  doc = must(
    addWire(
      doc,
      { kind: 'terminal', component: 'R3', terminal: 'a' },
      { kind: 'wire', wire: doc.layout.wires[0]!.id, at: { x: 160, y: 0 } },
    ),
  ).doc;
  expect(doc.layout.junctions).toHaveLength(1);
  return doc;
}

describe('one electrical truth across Circuit, Schematic and 3D', () => {
  it('holds for every curated example and the representative mixed circuit', () => {
    for (const e of EXAMPLES) expectAllViewsAgree(e.document, e.id);
    expectAllViewsAgree(mixedCircuit().doc, 'mixed');
  });

  it('holds for wires over a header, crossing wires, a junction, a contact and touching-but-separate terminals', () => {
    expectAllViewsAgree(crossingCircuit(), 'crossing');
    expectAllViewsAgree(junctionCircuit(), 'junction');
    expectAllViewsAgree(contactCircuit(), 'contact');
    expectAllViewsAgree(touchingCircuit(), 'touching');
  });

  it('holds after parts are moved into each other and apart (with routing), and rotated', () => {
    let doc = crossingCircuit();
    const sel = (...components: string[]) => ({ components, wires: [], junctions: [] });
    for (const [ids, delta] of [
      [['R1'], { x: -220, y: -100 }],
      [['U1'], { x: 40, y: 60 }],
      [['R3'], { x: -80, y: 0 }], // R3.a onto R2.b: they already share a net; a contact too
      [['R4'], { x: 0, y: 100 }],
    ] as const) {
      doc = must(moveRouted(doc, sel(...ids), delta)).doc;
      expectAllViewsAgree(doc, `after moving ${ids.join(',')}`);
    }
    doc = must(rotateRouted(doc, ['R2'])).doc;
    expectAllViewsAgree(doc, 'after rotating R2');
    let pair = contactCircuit();
    pair = must(moveSelection(pair, sel('D1'), { x: 0, y: 80 })).doc;
    expect(contacts(pair)).toEqual([]);
    expectAllViewsAgree(pair, 'contact pulled apart');
    expect(componentBoxes(pair)).toHaveLength(pair.components.length);
  });

  it('board header pins a wire runs over are lifted over in 3D, never touched', () => {
    const doc = crossingCircuit();
    const scene = deriveScene(doc);
    const w = scene.wires.find((x) => x.id === doc.layout.wires[0]!.id)!;
    const placement = doc.layout.components.U1!;
    const pins = ESP32_DEVKITC_WROOM32.pins.map((p) => {
      const q = rotatePoint(boardPinPosition(p), placement.rotation);
      return { x: (placement.x + q.x) / 10, z: (placement.y + q.y) / 10 };
    });
    const interior = w.points.slice(1, -1);
    expect(interior.every((p) => p.y >= 2.2)).toBe(true);
    expect(pins.length).toBeGreaterThan(30);
  });
});
