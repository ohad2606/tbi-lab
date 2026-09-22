/**
 * Net semantics — the correctness core of the editor.
 *
 * Connectivity comes only from explicit wire endpoint references (terminal or junction),
 * never from geometry: wires that cross without a shared junction are NOT connected. The
 * canonical netlist (`nets` + `connections`) is the set of connected groups of the wire graph.
 * It is re-derived after every edit by `settleNets`, which keeps net ids stable across edits.
 */

import { CATALOG, getTypeDef } from './catalog.js';
import { allocateId } from './project.js';
import type { Connection, Net, ProjectDocument, WireEnd } from './schema.js';

export function nodeKey(end: WireEnd): string {
  return end.kind === 'terminal' ? `t:${end.component}:${end.terminal}` : `j:${end.junction}`;
}

function terminalKey(component: string, terminal: string): string {
  return `t:${component}:${terminal}`;
}

class UnionFind {
  private parent = new Map<string, string>();
  add(k: string): void {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  find(k: string): string {
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = k;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  keys(): string[] {
    return [...this.parent.keys()];
  }
}

/** Connected groups of wire-graph nodes. Every node in a group is touched by a wire. */
export function wireGroups(doc: ProjectDocument): string[][] {
  const uf = new UnionFind();
  for (const w of doc.layout.wires) uf.union(nodeKey(w.from), nodeKey(w.to));
  const groups = new Map<string, string[]>();
  for (const k of uf.keys()) {
    const root = uf.find(k);
    const g = groups.get(root);
    if (g) g.push(k);
    else groups.set(root, [k]);
  }
  return [...groups.values()];
}

/**
 * Net of every wire-graph node (terminals and junctions) in a settled document. Taken from a
 * document BEFORE an edit, it lets `settleNets` keep net ids stable through the edit.
 */
export function nodeNets(doc: ProjectDocument): Map<string, string> {
  const byTerminal = new Map<string, string>();
  for (const c of doc.connections) byTerminal.set(terminalKey(c.component, c.terminal), c.net);
  const result = new Map<string, string>();
  for (const group of wireGroups(doc)) {
    const net = group.map((k) => byTerminal.get(k)).find((n) => n !== undefined);
    if (net === undefined) continue;
    for (const k of group) result.set(k, net);
  }
  return result;
}

function isGroundTerminal(doc: ProjectDocument, component: string, terminal: string): boolean {
  const c = doc.components.find((x) => x.id === component);
  return !!c && getTypeDef(c.type)?.groundTerminal === terminal;
}

function netNumber(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Re-derive `nets` and `connections` from the wire graph, mutating `doc`.
 *
 * Net identity is preserved: each new group keeps the previous net id held by most of its
 * nodes (a merge keeps the majority id; a split gives the larger part the old id and the
 * other part a fresh one). User net names travel with the surviving id; when nets merge and
 * only a merged-away net was named, that name is kept rather than silently dropped.
 */
export function settleNets(doc: ProjectDocument, previous: Map<string, string>): void {
  const oldNets = new Map(doc.nets.map((n) => [n.id, n]));
  const groups = wireGroups(doc).sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));

  const taken = new Set<string>();
  const nets: Net[] = [];
  const connections: Connection[] = [];

  for (const group of groups) {
    // A group of wires and junctions that reaches no terminal connects nothing: no net.
    if (!group.some((k) => k.startsWith('t:'))) continue;
    const votes = new Map<string, number>();
    for (const k of group) {
      const n = previous.get(k);
      if (n !== undefined && oldNets.has(n)) votes.set(n, (votes.get(n) ?? 0) + 1);
    }
    const ranked = [...votes.entries()]
      .filter(([id]) => !taken.has(id))
      .sort((a, b) => b[1] - a[1] || netNumber(a[0]) - netNumber(b[0]));
    const id = ranked[0]?.[0] ?? allocateId(doc, 'N', '_');
    taken.add(id);

    const named = [id, ...ranked.map(([n]) => n)]
      .map((n) => oldNets.get(n)?.userName ?? null)
      .find((name) => name !== null);

    let ground = false;
    for (const k of group) {
      if (!k.startsWith('t:')) continue;
      const [, component, terminal] = k.split(':') as [string, string, string];
      connections.push({ component, terminal, net: id });
      if (isGroundTerminal(doc, component, terminal)) ground = true;
    }
    nets.push({ id, role: ground ? 'ground' : null, userName: named ?? null });
  }

  doc.nets = nets.sort((a, b) => netNumber(a.id) - netNumber(b.id));
  doc.connections = canonicalConnections(doc, connections);
}

/** Canonical order: component order in the document, then terminal order of its type. */
export function canonicalConnections(doc: ProjectDocument, list: Connection[]): Connection[] {
  const compIndex = new Map(doc.components.map((c, i) => [c.id, i]));
  const termIndex = (c: Connection) => {
    const comp = doc.components.find((x) => x.id === c.component);
    const def = comp ? CATALOG[comp.type] : undefined;
    return def ? def.terminals.findIndex((t) => t.id === c.terminal) : -1;
  };
  return [...list].sort(
    (a, b) =>
      (compIndex.get(a.component) ?? 0) - (compIndex.get(b.component) ?? 0) ||
      termIndex(a) - termIndex(b),
  );
}
