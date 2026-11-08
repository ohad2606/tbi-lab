/**
 * s20r4 (review B1): a LARGE project quickly: `tiles` copies of one seeded random bench side by
 * side (ids renumbered per copy, positions shifted), so routing and drawing can be measured and
 * bounded at 1 000 - 6 000 wires without building each wire through the editor (quadratic).
 * Every copy is a complete, independent circuit (its own supply and ground); the result is a
 * valid project (asserted by the tests that use it).
 */
import type { ProjectDocument } from '@tbi-lab/domain';
import { randomBench } from './routingBench.js';

export function largeBench(
  wiresPerTile: number,
  tiles: number,
  options: { dense?: boolean; board?: boolean } = { dense: true, board: true },
): ProjectDocument {
  const one = randomBench(wiresPerTile, 1, options).doc;
  const xs = Object.values(one.layout.components).map((p) => p.x);
  const width = Math.ceil((Math.max(...xs) - Math.min(...xs) + 600) / 20) * 20;
  const ren = (id: string, k: number) => id.replace(/(\d+)$/, (n) => String(Number(n) + k * 10000));
  const out: ProjectDocument = { ...structuredClone(one), projectId: 'prj_largebench' };
  out.components = [];
  out.nets = [];
  out.connections = [];
  out.layout = { ...one.layout, components: {}, wires: [], junctions: [] };
  for (let k = 0; k < tiles; k++) {
    const dx = k * width;
    const r = (id: string) => (k === 0 ? id : ren(id, k));
    for (const c of one.components) out.components.push({ ...structuredClone(c), id: r(c.id) });
    for (const n of one.nets) out.nets.push({ ...n, id: r(n.id) });
    for (const c of one.connections)
      out.connections.push({ ...c, component: r(c.component), net: r(c.net) });
    for (const [id, p] of Object.entries(one.layout.components))
      out.layout.components[r(id)] = { ...p, x: p.x + dx };
    for (const j of one.layout.junctions)
      out.layout.junctions.push({ ...j, id: r(j.id), x: j.x + dx });
    const end = (e: ProjectDocument['layout']['wires'][number]['from']) =>
      e.kind === 'terminal'
        ? { ...e, component: r(e.component) }
        : { ...e, junction: r(e.junction) };
    for (const w of one.layout.wires)
      out.layout.wires.push({
        ...structuredClone(w),
        id: r(w.id),
        from: end(w.from),
        to: end(w.to),
        vertices: w.vertices.map((p) => ({ x: p.x + dx, y: p.y })),
        ...(w.auto
          ? { auto: { waypoints: w.auto.waypoints.map((p) => ({ x: p.x + dx, y: p.y })) } }
          : {}),
      });
  }
  const counters: Record<string, number> = {};
  for (const [p, n] of Object.entries(one.idCounters)) counters[p] = n + (tiles - 1) * 10000;
  out.idCounters = counters;
  return out;
}
