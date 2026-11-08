/**
 * s20r4 (review B5): the electrical node of every wire, computed INDEPENDENTLY of the domain's
 * `wireNodes` (which `wireCrossings` uses), so a test of "hops only between different nodes" is
 * not a tautology: the wire graph is walked here from scratch (breadth-first over shared ends),
 * and each group takes the node that `connectivity` (the netlist) gives a terminal in it.
 */
import { connectivity, type ProjectDocument, type WireEnd } from '@tbi-lab/domain';

const key = (e: WireEnd) =>
  e.kind === 'terminal' ? `t:${e.component}:${e.terminal}` : `j:${e.junction}`;

export function independentWireNodes(doc: ProjectDocument): Map<string, string> {
  const nodeOf = connectivity(doc).nodeOf;
  const byEnd = new Map<string, string[]>();
  for (const w of doc.layout.wires)
    for (const e of [w.from, w.to]) byEnd.set(key(e), [...(byEnd.get(key(e)) ?? []), w.id]);
  const wires = new Map(doc.layout.wires.map((w) => [w.id, w]));
  const out = new Map<string, string>();
  for (const start of doc.layout.wires) {
    if (out.has(start.id)) continue;
    const group: string[] = [];
    const queue = [start.id];
    const seen = new Set(queue);
    let node: string | undefined;
    while (queue.length) {
      const id = queue.shift()!;
      group.push(id);
      const w = wires.get(id)!;
      for (const e of [w.from, w.to]) {
        if (e.kind === 'terminal') node ??= nodeOf.get(`${e.component}:${e.terminal}`);
        for (const other of byEnd.get(key(e)) ?? [])
          if (!seen.has(other)) {
            seen.add(other);
            queue.push(other);
          }
      }
    }
    for (const id of group) out.set(id, node ?? `group:${start.id}`);
  }
  return out;
}
