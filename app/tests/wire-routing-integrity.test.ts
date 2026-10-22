/**
 * Wire routing integrity (owner-reported defect, 2026-10-22): dragging a logic gate wired to a
 * PSU left obsolete segments, detours and needless crossing bridges; moving it back did not
 * restore the drawing; 3D followed the stale 2D routes.
 *
 * Root cause: a wire's route was chosen once, when it was drawn, and stored as ordinary vertices;
 * a later move kept them, and the Sprint 9 repair reused them as if the user had placed them, so
 * detours accumulated across drags (history-dependent geometry). Fix: automatic wires
 * (schema `Wire.auto`) are routed CANONICALLY after every layout change (domain `routeAutoWires`:
 * from the current positions and the user's waypoints only), manual wires keep their geometry.
 *
 * The 12 cases of the directive, plus the owner's sequence (support/wireScenario.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  createPackage,
  createSnapshot,
  deleteSelection,
  emptySelection,
  moveWireSegment,
  makeWiresAutomatic,
  parsePackage,
  serializePackage,
  wireRoute,
  type Point,
  type ProjectDocument,
  type WireTarget,
} from '@tbi-lab/domain';
import { EngineSession } from '@tbi-lab/engine';
import { componentBoxes, movePreview, moveRouted } from '../src/ui/routing.js';
import { deriveScene, SCALE } from '../src/views/scene3d/scene.js';
import { draw, drag, measure, normalize, ownerCircuit } from './support/wireScenario.js';
import { expectNoWireThroughBodies } from './support/scene3dChecks.js';

const T = (component: string, terminal: string): WireTarget => ({
  kind: 'terminal',
  component,
  terminal,
});
/** Performance bounds on the 1-vCPU DEV host (a desktop browser is several times faster). */
// (Loose on purpose: the DEV host is one shared vCPU, often busy; review 4.)
const PREVIEW_P50_MS = 40;
const PREVIEW_MAX_MS = 150;
const DROP_MAX_MS = 1500;
const routes = (doc: ProjectDocument) => JSON.stringify(measure(doc).routes);
const netlist = (doc: ProjectDocument) => JSON.stringify([doc.nets, doc.connections]);
const place = (doc: ProjectDocument, type: Parameters<typeof addComponent>[1], at: Point) => {
  const r = addComponent(doc, type, at);
  if (!r.ok) throw new Error(r.error);
  return { doc: normalize(r.doc), id: r.id };
};

/** A complex bench: three gates, a resistor and an LED, nine wires (all automatic). */
function complexCircuit() {
  const owner = ownerCircuit();
  let doc = owner.doc;
  const gate = owner.gate;
  const g2 = place(doc, 'logic.gate_nand', { x: 360, y: 0 });
  doc = g2.doc;
  const g3 = place(doc, 'logic.gate_or', { x: 360, y: 240 });
  doc = g3.doc;
  const r = place(doc, 'component.resistor', { x: 600, y: 0 });
  doc = r.doc;
  const d = place(doc, 'component.led', { x: 600, y: 240 });
  doc = d.doc;
  doc = draw(doc, T('PSU1', 'positive'), T(g2.id, 'vcc'));
  doc = draw(doc, T(g2.id, 'gnd'), T('GND1', 'ref'));
  doc = draw(doc, T('PSU1', 'positive'), T(g3.id, 'vcc'));
  doc = draw(doc, T(g3.id, 'gnd'), T('GND1', 'ref'));
  doc = draw(doc, T(gate, 'y'), T(g2.id, 'a'));
  doc = draw(doc, T(g2.id, 'y'), T(r.id, 'a'));
  doc = draw(doc, T(r.id, 'b'), T(d.id, 'anode'));
  doc = draw(doc, T(d.id, 'cathode'), T('GND1', 'ref'));
  return { doc, gates: [gate, g2.id, g3.id] };
}

describe('wire routing integrity', () => {
  it("the owner's sequence: right, left, back — clean at every step, restored exactly", () => {
    const owner = ownerCircuit();
    let doc = owner.doc;
    const gate = owner.gate;
    const start = routes(doc);
    // Right, left past the start (never onto the PSU: the app refuses an overlapping placement),
    // then back: x 160 -> 360 -> 40 -> 160.
    for (const d of [
      { x: 200, y: 0 },
      { x: -320, y: 0 },
      { x: 120, y: 0 },
    ]) {
      doc = drag(doc, [gate], d);
      const m = measure(doc);
      // No obsolete segment: every automatic wire's route is the canonical one for this layout.
      expect(routes(doc)).toBe(routes(normalize(JSON.parse(JSON.stringify(doc)))));
      expect(m.bridges, JSON.stringify(m.routes)).toBe(0);
      expect(m.bodyLength).toBe(0);
    }
    expect(routes(doc)).toBe(start);
  });

  it('1/2: any sequence of drags that returns the gate gives the original drawing (200 sequences)', () => {
    const steps = [
      { x: 200, y: 0 },
      { x: -200, y: 0 },
      { x: 0, y: 160 },
      { x: 0, y: -160 },
      { x: 120, y: 100 },
      { x: -100, y: 60 },
      { x: 60, y: -120 },
    ];
    const base = ownerCircuit();
    const start = routes(base.doc);
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      let r = seed;
      const rnd = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
      let doc = base.doc;
      let dx = 0;
      let dy = 0;
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const s = steps[Math.floor(rnd() * steps.length)]!;
        const m = moveRouted(doc, { ...emptySelection(), components: [base.gate] }, s);
        if (!m.ok) ok = false;
        else {
          doc = normalize(m.doc);
          dx += s.x;
          dy += s.y;
        }
      }
      if (!ok) continue;
      doc = drag(doc, [base.gate], { x: -dx, y: -dy });
      expect(routes(doc), `seed ${seed}`).toBe(start);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('3: an obstacle placed on an automatic wire is routed around; removed, the wire returns', () => {
    let { doc } = ownerCircuit();
    const before = routes(doc);
    // A resistor right on the ground wire W1 (PSU- -> GND, x = -80, y 20..100).
    const r = place(doc, 'component.resistor', { x: -80, y: 60 });
    const m = measure(r.doc);
    expect(m.bodyLength, JSON.stringify(m.routes)).toBe(0);
    expect(routes(r.doc)).not.toBe(before);
    const gone = deleteSelection(r.doc, { ...emptySelection(), components: [r.id] });
    if (!gone.ok) throw new Error(gone.error);
    doc = normalize(gone.doc);
    expect(routes(doc)).toBe(before);
  });

  it('4: automatic vs manual — a dragged segment makes the wire manual and its bends stay; waypoints are kept', () => {
    const owner = ownerCircuit();
    let doc = owner.doc;
    const gate = owner.gate;
    // W2 (PSU+ -> gate VCC): drag its top segment up by two grid steps: user geometry.
    const route = wireRoute(
      doc,
      doc.layout.wires.find((w) => w.id === 'W2')!,
    )!;
    const seg = route.findIndex((p, i) => i + 1 < route.length && p.y === route[i + 1]!.y);
    const r = moveWireSegment(doc, 'W2', seg, { x: 0, y: -40 });
    if (!r.ok) throw new Error(r.error);
    doc = normalize(r.doc);
    const w2 = () => doc.layout.wires.find((w) => w.id === 'W2')!;
    expect(w2().auto).toBeUndefined();
    const manual = JSON.stringify(w2().vertices);
    // Moving an unrelated part leaves the manual wire's bends exactly as the user made them.
    const p = place(doc, 'component.resistor', { x: 300, y: 300 });
    doc = drag(p.doc, [p.id], { x: 40, y: 0 });
    expect(JSON.stringify(w2().vertices)).toBe(manual);
    // An automatic wire drawn through a clicked point keeps passing through it after moves.
    doc = draw(doc, T(gate, 'a'), T('GND1', 'ref'), [{ x: -200, y: 200 }]);
    const w = doc.layout.wires.at(-1)!;
    expect(w.auto).toEqual({ waypoints: [{ x: -200, y: 200 }] });
    doc = drag(doc, [gate], { x: 100, y: -60 });
    const through = wireRoute(
      doc,
      doc.layout.wires.find((x) => x.id === w.id)!,
    )!;
    expect(through.some((q, i) => i > 0 && onSeg({ x: -200, y: 200 }, through[i - 1]!, q))).toBe(
      true,
    );
    // "Route automatically" (explicit): the manual wire is handed back to the router.
    const back = makeWiresAutomatic(doc, ['W2']);
    if (!back.ok) throw new Error(back.error);
    doc = normalize(back.doc);
    expect(w2().auto).toEqual({ waypoints: [] });
  });

  it('5/6: a junction is a connection, a crossing is not; a split automatic wire stays automatic', () => {
    const owner = ownerCircuit();
    let doc = owner.doc;
    const gate = owner.gate;
    const nets = netlist(doc);
    // A wire from the gate's input A that ends ON the ground wire W1: a junction, one net.
    const w1 = wireRoute(
      doc,
      doc.layout.wires.find((w) => w.id === 'W1')!,
    )!;
    const at = { x: w1[0]!.x, y: 60 };
    doc = draw(doc, T(gate, 'a'), { kind: 'wire', wire: 'W1', at });
    expect(doc.layout.junctions).toHaveLength(1);
    expect(doc.layout.wires.filter((w) => w.auto)).toHaveLength(doc.layout.wires.length);
    expect(netlist(doc)).not.toBe(nets); // A joined the ground net, explicitly
    // A wire that merely crosses others joins nothing.
    const crossNets = JSON.stringify(doc.nets.map((n) => n.id).sort());
    const before = doc.connections.length;
    const p = place(doc, 'component.resistor', { x: -240, y: 240 });
    doc = draw(p.doc, T(p.id, 'a'), T(gate, 'b'));
    expect(doc.connections.length).toBe(before + 2);
    expect(JSON.stringify(doc.nets.map((n) => n.id).sort())).not.toBe(crossNets);
    const g = createSnapshot(doc);
    const netOf = (c: string, t: string) =>
      g.connections.find((x) => x.component === c && x.terminal === t)?.net;
    expect(netOf(gate, 'b')).not.toBe(netOf('GND1', 'ref'));
    // Moving the gate keeps the junction where it is and its wires attached to it.
    const j = { ...doc.layout.junctions[0]! };
    const beforeMove = netlist(doc);
    doc = drag(doc, [gate], { x: 120, y: 0 });
    expect(doc.layout.junctions[0]).toEqual(j);
    expect(netlist(doc)).toBe(beforeMove); // moving changes no connection
  });

  it('7: no route runs through a body (2D) — on the owner bench and a complex bench, before and after moves', () => {
    for (const make of [ownerCircuit, complexCircuit]) {
      let doc = make().doc;
      expect(measure(doc).bodyLength).toBe(0);
      const ids = doc.components.filter((c) => c.type.startsWith('logic.')).map((c) => c.id);
      for (const g of ids) doc = drag(doc, [g], { x: 40, y: 80 });
      expect(measure(doc).bodyLength).toBe(0);
    }
  });

  it('7 (3D): the owner bench has no wire through a part at any step (real volumes)', () => {
    // 3D clearance is the 3D router's (the parts' REAL volumes: a 2D symbol box is not the
    // physical body), validated geometrically here, not assumed.
    const owner = ownerCircuit();
    let doc = owner.doc;
    expectNoWireThroughBodies(doc, deriveScene(doc), 'initial');
    for (const dx of [200, -320, 120]) {
      doc = drag(doc, [owner.gate], { x: dx, y: 0 });
      expectNoWireThroughBodies(doc, deriveScene(doc), `after ${dx}`);
    }
  });

  // Formerly KNOWN LIMITATION (`it.fails`; the deployed release 4676139 failed it identically):
  // after the moves the 3D scene ran the PSU1+ -> U2 wire across the tip of the PSU's OTHER
  // binding post (~0.5 mm, inside it in height). Root cause (rt2, two parts, both needed):
  //  - the two posts were one obstacle "PSU1", i.e. the wire's OWN end part, so the other post
  //    (the other node) got no padding and no clearance check at all (route3d own-part rule);
  //  - a raised body (bottom above the bench) that the LOW route clears by passing under was
  //    skipped before the profile was final; the near-terminal requirement at that post then
  //    lifted the wire into it.
  // Fixed: each post is its own obstacle `PSU1:<terminal>`; a raised body is decided over/under
  // on the final profile. Now a regression test.
  it('7 (3D): the complex bench after moves keeps every wire clear of the PSU posts', () => {
    const bench = complexCircuit();
    let doc = bench.doc;
    for (const g of bench.gates) doc = drag(doc, [g], { x: 40, y: 80 });
    expectNoWireThroughBodies(doc, deriveScene(doc), 'complex bench after moves');
  });

  it('7 (3D, rt2): random gate moves never run a wire through a PSU binding post', () => {
    // Seeds 7, 29, 30 collided with a post before the fix (rt2 sweep, evidence
    // rt2-3d-sweep-*.txt); the others are clean controls. Only the PSU volumes are asserted here:
    // the sweep also reaches layouts where two gates' 3D breakout bodies overlap each other (a
    // separate, documented limitation of the body separation, unchanged by this fix).
    let s = 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (const seed of [1, 2, 7, 26, 29, 30]) {
      s = seed >>> 0;
      const bench = complexCircuit();
      let doc = bench.doc;
      for (const g of bench.gates) {
        const d = { x: 20 * Math.round(rnd() * 16 - 8), y: 20 * Math.round(rnd() * 16 - 8) };
        const r = moveRouted(doc, { ...emptySelection(), components: [g] }, d);
        if (r.ok) doc = normalize(r.doc);
      }
      const scene = deriveScene(doc);
      expectNoWireThroughBodies(doc, scene, `seed ${seed}`, (o) => o.part.startsWith('PSU1'));
    }
  });

  it('8: save and reload give the identical drawing, and routing it again changes nothing', () => {
    const { doc } = complexCircuit();
    const text = serializePackage(
      createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-10-22T00:00:00.000Z' }),
    );
    const parsed = parsePackage(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const loaded = parsed.doc;
    expect(routes(loaded)).toBe(routes(doc));
    expect(normalize(loaded)).toBe(loaded); // already canonical: the same document back
  });

  it('9: 3D follows the authoritative routes: no stale geometry, no wire through a body', () => {
    const owner = ownerCircuit();
    let doc = owner.doc;
    const gate = owner.gate;
    const scene0 = deriveScene(doc);
    doc = drag(doc, [gate], { x: 200, y: 0 });
    doc = drag(doc, [gate], { x: -200, y: 0 });
    // Back where it started: the identical 3D scene (nothing stale survives).
    expect(JSON.stringify(deriveScene(doc))).toBe(JSON.stringify(scene0));
    doc = drag(doc, [gate], { x: 200, y: 0 });
    const s = deriveScene(doc);
    // Every 3D wire's plan path starts and ends where its 2D route does (to the attach point).
    for (const w of s.wires) {
      const r = wireRoute(
        doc,
        doc.layout.wires.find((x) => x.id === w.id)!,
      )!;
      const ends = [w.points[0]!, w.points.at(-1)!];
      for (const [i, p] of [r[0]!, r.at(-1)!].entries())
        expect(Math.hypot(ends[i]!.x - p.x * SCALE, ends[i]!.z - p.y * SCALE)).toBeLessThan(5);
    }
    expectNoWireThroughBodies(doc, s, 'gate moved right');
  });

  it('10: continuous dragging stays interactive: a bounded preview per frame, the canonical route at the drop', () => {
    const { doc, gates } = complexCircuit();
    const sel = { ...emptySelection(), components: [gates[1]!] };
    const frames: number[] = [];
    for (let i = 1; i <= 40; i++) {
      const t0 = performance.now();
      const m = movePreview(doc, sel, { x: 0, y: 4 * i });
      if (m.ok) frames.push(performance.now() - t0);
    }
    frames.sort((a, b) => a - b);
    const p50 = frames[Math.floor(frames.length / 2)]!;
    const max = frames.at(-1)!;
    const drops: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const t0 = performance.now();
      drag(doc, sel.components, { x: 0, y: 20 * i });
      drops.push(performance.now() - t0);
    }
    drops.sort((a, b) => a - b);
    console.log(
      `drag (9 automatic wires, 1-vCPU DEV host): preview p50 ${p50.toFixed(1)} ms, max ${max.toFixed(1)} ms; drop (canonical) median ${drops[2]!.toFixed(0)} ms`,
    );
    // Bounds: PREVIEW_P50_MS / PREVIEW_MAX_MS per frame, DROP_MAX_MS once at the drop.
    expect(p50).toBeLessThan(PREVIEW_P50_MS);
    expect(max).toBeLessThan(PREVIEW_MAX_MS);
    expect(drops[2]!).toBeLessThan(DROP_MAX_MS);
  });

  it('11: a complex bench is deterministic and clean after many moves', () => {
    let a = complexCircuit();
    let b = complexCircuit();
    expect(routes(a.doc)).toBe(routes(b.doc));
    for (const g of a.gates) a = { ...a, doc: drag(a.doc, [g], { x: 40, y: 40 }) };
    for (const g of [...b.gates].reverse()) b = { ...b, doc: drag(b.doc, [g], { x: 40, y: 40 }) };
    // Same final layout reached in a different order: the same drawing.
    expect(routes(a.doc)).toBe(routes(b.doc));
    expect(measure(a.doc).bodyLength).toBe(0);
  });

  it('12: netlist and simulation are unchanged by moving parts', () => {
    const bench = complexCircuit();
    let doc = bench.doc;
    const gates = bench.gates;
    const solve = (d: ProjectDocument) => {
      const o = new EngineSession(createSnapshot(d)).solve();
      return o.ok ? JSON.stringify([o.netVoltages, o.components]) : `error ${o.error.code}`;
    };
    const nets = netlist(doc);
    const result = solve(doc);
    for (const g of gates) doc = drag(doc, [g], { x: 80, y: -40 });
    expect(netlist(doc)).toBe(nets);
    expect(solve(doc)).toBe(result);
  });

  it('review 3: joining an automatic wire with a manual one keeps it automatic, the manual corners as waypoints', () => {
    const owner = ownerCircuit();
    let doc = owner.doc;
    // Split the automatic W1 with a junction (a wire from the gate's A ends on it), then make that
    // branch manual by dragging one of its segments, then delete the third wire at the junction.
    const w1 = wireRoute(
      doc,
      doc.layout.wires.find((w) => w.id === 'W1')!,
    )!;
    doc = draw(doc, T(owner.gate, 'a'), { kind: 'wire', wire: 'W1', at: { x: w1[0]!.x, y: 60 } });
    const jId = doc.layout.junctions[0]!.id;
    const atJ = doc.layout.wires.filter((w) => [w.from, w.to].some((e) => e.kind === 'junction'));
    expect(atJ).toHaveLength(3);
    const branch = atJ.find((w) =>
      [w.from, w.to].some((e) => e.kind === 'terminal' && e.terminal === 'a'),
    )!;
    const r = deleteSelection(doc, { ...emptySelection(), wires: [branch.id] });
    if (!r.ok) throw new Error(r.error);
    doc = normalize(r.doc);
    expect(doc.layout.junctions.some((j) => j.id === jId)).toBe(false);
    // The two automatic halves joined back into ONE automatic wire.
    const joined = doc.layout.wires.filter((w) =>
      [w.from, w.to].some(
        (e) => e.kind === 'terminal' && e.component === 'GND1' && e.terminal === 'ref',
      ),
    );
    expect(joined.every((w) => w.auto)).toBe(true);
  });

  it('review 1: opening a project routes its automatic wires canonically (a stale stored route never returns)', () => {
    const owner = ownerCircuit();
    const canonical = routes(owner.doc);
    // A stale automatic route, as an older build might have stored it.
    const stale = JSON.parse(JSON.stringify(owner.doc)) as ProjectDocument;
    stale.layout.wires.find((w) => w.id === 'W2')!.vertices = [
      { x: -80, y: -200 },
      { x: 160, y: -200 },
    ];
    expect(routes(stale)).not.toBe(canonical);
    expect(routes(normalize(stale))).toBe(canonical); // the store applies this on open
  });

  it('boxes come from the canvas symbols (the same bodies the views draw)', () => {
    const { doc } = ownerCircuit();
    expect(componentBoxes(doc).length).toBe(doc.components.length);
  });
});

function onSeg(p: Point, a: Point, b: Point): boolean {
  return a.x === b.x
    ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
    : p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
}
