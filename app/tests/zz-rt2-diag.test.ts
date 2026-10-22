// rt2 diagnostic: which wire hits which 3D obstacle on the complex bench after moves.
// Copied temporarily into app/tests/ to run (vitest include pattern), then removed.
import { it } from 'vitest';
import { addComponent, wireRoute, type Point, type ProjectDocument, type WireTarget } from '@tbi-lab/domain';
import { deriveScene, sceneObstacles, WIRE_RADIUS } from '../src/views/scene3d/scene.js';
import { ownerCircuit, drag, draw, normalize } from './support/wireScenario.js';
import { samples } from './support/scene3dChecks.js';
const T = (component: string, terminal: string): WireTarget => ({ kind: 'terminal', component, terminal });
const place = (doc: ProjectDocument, type: Parameters<typeof addComponent>[1], at: Point) => {
  const r = addComponent(doc, type, at); if (!r.ok) throw new Error(r.error); return { doc: normalize(r.doc), id: r.id };
};
function complexCircuit() {
  const owner = ownerCircuit(); let doc = owner.doc; const gate = owner.gate;
  const g2 = place(doc, 'logic.gate_nand', { x: 360, y: 0 }); doc = g2.doc;
  const g3 = place(doc, 'logic.gate_or', { x: 360, y: 240 }); doc = g3.doc;
  const r = place(doc, 'component.resistor', { x: 600, y: 0 }); doc = r.doc;
  const d = place(doc, 'component.led', { x: 600, y: 240 }); doc = d.doc;
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
it('diag', () => {
  const bench = complexCircuit(); let doc = bench.doc;
  for (const g of bench.gates) doc = drag(doc, [g], { x: 40, y: 80 });
  const s = deriveScene(doc);
  const obstacles = sceneObstacles(doc, s);
  const m = WIRE_RADIUS * 0.8;
  for (const w of s.wires) {
    const src = doc.layout.wires.find((x) => x.id === w.id)!;
    const own = [src.from, src.to].flatMap((e) => e.kind === 'terminal' ? [e.component, `${e.component}:${e.terminal}`] : []);
    const ends = [w.points[0]!, w.points.at(-1)!];
    let hit = null as null | object;
    // also: minimal true 3D clearance (axis to box) of this wire to every non-own-fitting obstacle
    let minClear = Infinity; let minAt = '';
    for (const p of samples(w, 0.25)) for (const o of obstacles) {
      const isOwn = own.includes(o.part) || own.some((x) => o.part.startsWith(`${x}:`));
      if (o.part === own[1] || o.part === own[3]) continue;
      if (!(isOwn && o.bottom < 2)) {
        const dx = Math.max(o.x0 - p.x, 0, p.x - o.x1), dz = Math.max(o.z0 - p.z, 0, p.z - o.z1), dy = Math.max(o.bottom - p.y, 0, p.y - o.top);
        const d = Math.hypot(dx, dy, dz);
        if (d < minClear && !ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) < 3)) { minClear = d; minAt = o.part; }
      }
      if (isOwn && o.bottom < 2) continue;
      if (isOwn && ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) < 3)) continue;
      const inside = p.x > o.x0 - m && p.x < o.x1 + m && p.z > o.z0 - m && p.z < o.z1 + m && p.y > o.bottom - m && p.y < o.top + m;
      if (inside && !hit) hit = { p, o, isOwn };
    }
    console.log('WIRE', w.id, 'minAxisClear', minClear.toFixed(3), minAt);
    if (hit) {
      console.log('HIT', w.id, JSON.stringify(src), JSON.stringify(hit));
      console.log(' route2d', JSON.stringify(wireRoute(doc, src)));
      console.log(' pts3d', JSON.stringify(w.points.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)])));
    }
  }
});
