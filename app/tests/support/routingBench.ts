/**
 * Wire routing integrity (rt2): seeded random benches of a given number of automatic wires, for
 * the routing profile, the incremental-routing equivalence proof and the netlist property test.
 *
 * Parts (resistors, LEDs, logic gates; optionally an ESP32 DevKit) on a jittered grid (200 x 160
 * layout units, or 120 x 120 `dense`: crowded, many hops need the grid search); wires
 * between terminals of neighbouring parts, all AUTOMATIC (`auto`, no waypoints, as the Circuit
 * view draws a click-to-click wire), added WITHOUT routing: the canonical routes are a function
 * of the final document only, so the caller routes once (`routeAutomatic`).
 */
import {
  addComponent,
  addWire,
  createProject,
  type Point,
  type ProjectDocument,
  type WireTarget,
} from '@tbi-lab/domain';
import { getTypeDef } from '@tbi-lab/domain';

/** Deterministic PRNG (LCG; same constants everywhere in the rt2 evidence). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const TYPES = ['component.resistor', 'component.led', 'logic.gate_and', 'logic.gate_nand'] as const;

export interface Bench {
  doc: ProjectDocument;
  /** The movable parts (not the supply or ground). */
  parts: string[];
}

/** A bench with exactly `wires` automatic wires (unrouted: vertices empty). */
export function randomBench(
  wires: number,
  seed: number,
  options: { board?: boolean; dense?: boolean } = {},
): Bench {
  const R = rng(seed);
  let doc = createProject({
    projectId: `prj_bench_${wires}_${seed}`,
    deviceId: 'dev_bench',
    name: 'bench',
    appVersion: '0',
  });
  const parts: string[] = [];
  const nParts = Math.max(2, Math.ceil(wires / 2));
  const cols = Math.max(2, Math.ceil(Math.sqrt(nParts * 1.5)));
  // Grid cells 200 x 160 layout units, to the right of the supply; each part jittered by a step.
  let cell = 0;
  if (options.board) {
    const r = addComponent(doc, 'board.esp32_devkitc_wroom32', { x: 200, y: 600 });
    if (r.ok) {
      doc = r.doc;
      parts.push(r.id);
    }
  }
  while (parts.length < nParts + (options.board ? 1 : 0) && cell < nParts * 4) {
    const cx = cell % cols;
    const cy = Math.floor(cell / cols);
    cell++;
    const at: Point = {
      x: 200 + cx * (options.dense ? 120 : 200) + 20 * Math.round(R() * 2 - 1),
      y: -200 + cy * (options.dense ? 120 : 160) + 20 * Math.round(R() * 2 - 1),
    };
    const type = TYPES[Math.floor(R() * TYPES.length)]!;
    const r = addComponent(doc, type, at);
    if (!r.ok) continue;
    doc = r.doc;
    parts.push(r.id);
  }
  const terminals = (id: string): WireTarget[] => {
    const c = doc.components.find((x) => x.id === id)!;
    return (getTypeDef(c.type)?.terminals ?? []).map((t) => ({
      kind: 'terminal' as const,
      component: id,
      terminal: t.id,
    }));
  };
  const pos = (id: string) => doc.layout.components[id]!;
  const all = ['PSU1', 'GND1', ...parts];
  let guard = 0;
  while (doc.layout.wires.length < wires && guard++ < wires * 50) {
    const a = all[Math.floor(R() * all.length)]!;
    // A neighbour: among the 4 nearest other parts.
    const near = all
      .filter((x) => x !== a)
      .sort((x, y) => {
        const d = (q: string) => Math.abs(pos(q).x - pos(a).x) + Math.abs(pos(q).y - pos(a).y);
        return d(x) - d(y) || (x < y ? -1 : 1);
      })
      .slice(0, 4);
    const b = near[Math.floor(R() * near.length)]!;
    const ta = terminals(a);
    const tb = terminals(b);
    const from = ta[Math.floor(R() * ta.length)]!;
    const to = tb[Math.floor(R() * tb.length)]!;
    const r = addWire(doc, from, to, [], { waypoints: [] });
    if (r.ok) doc = r.doc;
  }
  return { doc, parts };
}
