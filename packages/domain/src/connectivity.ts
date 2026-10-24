/**
 * Electrical connectivity of a project (Sprint 9): the derived graph the generated views draw
 * from. Pure and deterministic; it reads ONLY the canonical netlist (`components`, `nets`,
 * `connections`), never the layout, so it expresses topology and not where wires were drawn.
 *
 * Electrical nodes:
 * - every `role: ground` net is the circuit reference (the engine's node 0), so all of them form
 *   ONE node, `GND`;
 * - every other net is a node of its own, keyed by its net id.
 *
 * Node kinds (presentation semantics, not electrical inputs):
 * - `ground`  the reference node;
 * - `supply`  a node on a lab supply's positive terminal whose negative terminal is on ground —
 *             a rail, conventionally drawn as a supply label instead of a wire;
 * - `signal`  everything else.
 */

import { CATALOG } from './catalog.js';
import type { ComponentInstance, ComponentTypeId, ProjectDocument } from './schema.js';

export const GROUND_NODE = 'GND';

export type NodeKind = 'ground' | 'supply' | 'signal';

export interface PinRef {
  component: string;
  terminal: string;
}

export interface ElectricalNode {
  /** `GND` for the reference node, otherwise the net id. */
  id: string;
  kind: NodeKind;
  /** The project nets this node covers (several only for ground). */
  nets: string[];
  /** User-authored net name, verbatim (the first one, in net order), or null. */
  userName: string | null;
  /** Connected pins, in canonical connection order. */
  pins: PinRef[];
  /** For a supply node: the lab supply that drives it. */
  supply?: string;
}

export interface ComponentConnectivity {
  id: string;
  type: ComponentTypeId;
  /** Terminal id → node id, or null when the terminal is not wired. In catalog terminal order. */
  terminals: { terminal: string; node: string | null }[];
}

export interface Connectivity {
  /** Nodes in a stable order: GND first (if present), then by first net order in the document. */
  nodes: ElectricalNode[];
  components: ComponentConnectivity[];
  /** Pin key `component:terminal` → node id. */
  nodeOf: ReadonlyMap<string, string>;
}

export const pinKey = (component: string, terminal: string) => `${component}:${terminal}`;

export function connectivity(doc: ProjectDocument): Connectivity {
  const netNode = new Map<string, string>();
  for (const n of doc.nets) netNode.set(n.id, n.role === 'ground' ? GROUND_NODE : n.id);

  const nodeOf = new Map<string, string>();
  for (const c of doc.connections) {
    const node = netNode.get(c.net);
    if (node) nodeOf.set(pinKey(c.component, c.terminal), node);
  }

  // Rails: a supply's positive node, when its negative terminal is on the reference.
  const supplyOf = new Map<string, string>();
  for (const c of doc.components) {
    if (c.type !== 'instrument.lab_psu') continue;
    const pos = nodeOf.get(pinKey(c.id, 'positive'));
    const neg = nodeOf.get(pinKey(c.id, 'negative'));
    if (pos && pos !== GROUND_NODE && neg === GROUND_NODE && !supplyOf.has(pos))
      supplyOf.set(pos, c.id);
  }

  const nodes = new Map<string, ElectricalNode>();
  const order = [...doc.nets].sort((a, b) =>
    a.role === b.role ? 0 : a.role === 'ground' ? -1 : b.role === 'ground' ? 1 : 0,
  );
  for (const n of order) {
    const id = netNode.get(n.id)!;
    const existing = nodes.get(id);
    if (existing) {
      existing.nets.push(n.id);
      existing.userName ??= n.userName;
      continue;
    }
    const supply = supplyOf.get(id);
    nodes.set(id, {
      id,
      kind: id === GROUND_NODE ? 'ground' : supply ? 'supply' : 'signal',
      nets: [n.id],
      userName: n.userName,
      pins: [],
      ...(supply ? { supply } : {}),
    });
  }
  for (const c of doc.connections) {
    const node = nodes.get(netNode.get(c.net) ?? '');
    node?.pins.push({ component: c.component, terminal: c.terminal });
  }

  const components = doc.components.map((c: ComponentInstance) => ({
    id: c.id,
    type: c.type,
    terminals: CATALOG[c.type].terminals.map((t) => ({
      terminal: t.id,
      node: nodeOf.get(pinKey(c.id, t.id)) ?? null,
    })),
  }));

  return { nodes: [...nodes.values()].filter((n) => n.pins.length > 0), components, nodeOf };
}

/**
 * Sprint 20 (s20r): the electrical node each wire belongs to, by wire id: the node of a terminal
 * in its wire-graph group (wires joined at junctions or terminals), or, for a group that reaches
 * no terminal, an id of its own (`wires:<first key>`). Presentation uses it to tell a crossing of
 * two DIFFERENT nodes (drawn with a hop: not connected) from wires of one node, and the router to
 * keep wires of one node from crossing each other. Derived; never stored.
 */
export function wireNodes(
  doc: ProjectDocument,
  g: Connectivity = connectivity(doc),
): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const key = (e: ProjectDocument['layout']['wires'][number]['from']) =>
    e.kind === 'terminal' ? `t:${e.component}:${e.terminal}` : `j:${e.junction}`;
  for (const w of doc.layout.wires)
    for (const k of [key(w.from), key(w.to)]) if (!parent.has(k)) parent.set(k, k);
  for (const w of doc.layout.wires) {
    const a = find(key(w.from));
    const b = find(key(w.to));
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const groupNode = new Map<string, string>();
  for (const w of doc.layout.wires)
    for (const e of [w.from, w.to]) {
      if (e.kind !== 'terminal') continue;
      const node = g.nodeOf.get(pinKey(e.component, e.terminal));
      const root = find(key(e));
      if (node && !groupNode.has(root)) groupNode.set(root, node);
    }
  const out = new Map<string, string>();
  for (const w of doc.layout.wires) {
    const root = find(key(w.from));
    out.set(w.id, groupNode.get(root) ?? `wires:${root}`);
  }
  return out;
}
