/**
 * Sprint 19B (logic L1): topology analysis for logic parts, pure (no solve).
 *
 * - `unknownClosure`: which nodes an unknown-driven output (or the supply of an unknown gate)
 *   makes unknown. It spreads through every conducting element, but never across a FIXED node:
 *   GND and the outputs of enabled supplies hold their potential whatever the unknown current.
 *   At a fixed node the spread stops, and the supply that holds it gets an unknown current.
 * - `logicFeedback`: whether a logic output reaches an input of a logic part that (directly or
 *   through other logic parts) drives it, through EXTERNAL elements (wires, resistors, LEDs,
 *   contacts...; never through a logic part's own internal output stage, and never across a
 *   fixed node). Such a network is a latch or an oscillator: its behaviour is defined by
 *   propagation delay, which DC sessions do not simulate, so it is refused.
 */

export interface TopoElement {
  key: string;
  /** Component the element belongs to. */
  component: string;
  nodes: readonly string[];
  /** Whether it conducts in this topology (an open contact does not). */
  active: boolean;
}

export interface LogicPart {
  /**
   * The logic unit: a single gate's component id, or one gate of a package (`U1#2`). Cycles are
   * found between units, so gate 1 of a package feeding gate 2 of the SAME package is a chain,
   * not feedback (L3).
   */
  component: string;
  /** The component that owns the unit's internal output stage (default: `component`). */
  owner?: string;
  /** Nodes of its logic inputs and outputs. */
  inputs: readonly string[];
  outputs: readonly string[];
}

function adjacency(elements: readonly TopoElement[]) {
  const byNode = new Map<string, TopoElement[]>();
  for (const e of elements) {
    if (!e.active) continue;
    for (const n of e.nodes) byNode.set(n, [...(byNode.get(n) ?? []), e]);
  }
  return byNode;
}

export function unknownClosure(
  elements: readonly TopoElement[],
  seeds: Iterable<string>,
  fixed: ReadonlySet<string>,
): { nodes: Set<string>; elements: Set<string>; fixedReached: Set<string> } {
  const byNode = adjacency(elements);
  const nodes = new Set<string>();
  const touched = new Set<string>();
  const fixedReached = new Set<string>();
  const queue: string[] = [];
  for (const s of seeds) {
    if (fixed.has(s)) fixedReached.add(s);
    else if (!nodes.has(s)) {
      nodes.add(s);
      queue.push(s);
    }
  }
  while (queue.length) {
    const n = queue.shift()!;
    for (const e of byNode.get(n) ?? []) {
      touched.add(e.key);
      for (const m of e.nodes) {
        if (m === n) continue;
        if (fixed.has(m)) fixedReached.add(m);
        else if (!nodes.has(m)) {
          nodes.add(m);
          queue.push(m);
        }
      }
    }
  }
  return { nodes, elements: touched, fixedReached };
}

/** The logic parts on a combinational feedback cycle, in a stable order, or null. */
export function logicFeedback(
  elements: readonly TopoElement[],
  logic: readonly LogicPart[],
  fixed: ReadonlySet<string>,
): string[] | null {
  const own = new Set(logic.map((l) => l.component));
  const owners = new Set(logic.map((l) => l.owner ?? l.component));
  // External elements only: a logic part's own output stage joins its output to its supply,
  // which is not a signal path.
  const byNode = adjacency(elements.filter((e) => !owners.has(e.component)));
  const inputsAt = new Map<string, string[]>();
  for (const l of logic)
    for (const n of l.inputs) inputsAt.set(n, [...(inputsAt.get(n) ?? []), l.component]);
  // Edges: part -> every logic part with an input on a node its outputs reach.
  const edges = new Map<string, Set<string>>();
  for (const l of logic) {
    const reached = new Set<string>();
    const seen = new Set<string>();
    const queue = l.outputs.filter((n) => !fixed.has(n));
    for (const n of queue) seen.add(n);
    while (queue.length) {
      const n = queue.shift()!;
      for (const p of inputsAt.get(n) ?? []) reached.add(p);
      for (const e of byNode.get(n) ?? [])
        for (const m of e.nodes)
          if (!seen.has(m) && !fixed.has(m)) {
            seen.add(m);
            queue.push(m);
          }
    }
    edges.set(l.component, reached);
  }
  // Cycle detection (iterative DFS, colours).
  const colour = new Map<string, 0 | 1 | 2>();
  const ids = [...own].sort();
  for (const start of ids) {
    if (colour.get(start)) continue;
    const stack: { id: string; it: Iterator<string> }[] = [];
    const path: string[] = [];
    const push = (id: string) => {
      colour.set(id, 1);
      path.push(id);
      stack.push({ id, it: [...(edges.get(id) ?? [])].sort()[Symbol.iterator]() });
    };
    push(start);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const nx = top.it.next();
      if (nx.done) {
        colour.set(top.id, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const c = colour.get(nx.value) ?? 0;
      if (c === 1) return path.slice(path.indexOf(nx.value)).sort();
      if (c === 0) push(nx.value);
    }
  }
  return null;
}
