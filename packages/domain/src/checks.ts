/**
 * Editor-time circuit checks (Sprint 4 validation layer). Pure and language-neutral: each issue
 * is a code with component/terminal/net ids; the app localizes it.
 *
 * These checks never change the circuit. They make visible what the drawing means
 * electrically, before Run: connections come only from explicit wire endpoints (terminals
 * and junction dots), never from geometry. The electrical engine still has the final word at
 * Run (it knows supply outputs and switch states); these checks warn early and conservatively.
 */

import { CATALOG } from './catalog.js';
import { terminalPosition, wireRoute, pointOnSegment } from './layout.js';
import { nodeKey, wireGroups } from './nets.js';
import type { ProjectDocument } from './schema.js';

export type CheckCode =
  | 'not_connected'
  | 'partially_wired'
  | 'wire_over_terminal'
  | 'floating_island'
  | 'no_ground'
  | 'psu_shorted_by_wire';

export interface CheckIssue {
  code: CheckCode;
  /** Info: shown, does not block Run. Warning: likely a mistake; Run may refuse it. */
  severity: 'info' | 'warning';
  components: string[];
  /** Terminal ids of the (first) component the issue is about. */
  terminals?: string[];
  wire?: string;
}

const REF = '\u0000GND';

export function checkCircuit(doc: ProjectDocument): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const netOf = new Map(doc.connections.map((c) => [`${c.component}\u0000${c.terminal}`, c.net]));
  const groundNets = new Set(doc.nets.filter((n) => n.role === 'ground').map((n) => n.id));

  // Not connected / partially wired.
  const wiredParts: string[] = [];
  for (const c of doc.components) {
    const terms = CATALOG[c.type].terminals.map((t) => t.id);
    const unwired = terms.filter((t) => !netOf.has(`${c.id}\u0000${t}`));
    if (c.type === 'component.ground') continue;
    if (unwired.length === terms.length) {
      issues.push({ code: 'not_connected', severity: 'info', components: [c.id] });
      continue;
    }
    wiredParts.push(c.id);
    // A board with unused pins is normal (Sprint 6): only wired pins take part in the circuit.
    if (unwired.length && c.type !== 'board.esp32_devkitc_wroom32') {
      issues.push({
        code: 'partially_wired',
        severity: 'warning',
        components: [c.id],
        terminals: unwired,
      });
    }
  }

  // A supply whose own terminals share a net: shorted by a wire.
  for (const c of doc.components) {
    if (c.type !== 'instrument.lab_psu') continue;
    const p = netOf.get(`${c.id}\u0000positive`);
    if (p !== undefined && p === netOf.get(`${c.id}\u0000negative`)) {
      issues.push({ code: 'psu_shorted_by_wire', severity: 'warning', components: [c.id] });
    }
  }

  // Reference analysis over the drawn topology. Every two-terminal part is treated as
  // possibly conducting (a switch may be closed, a supply switched on): an island that cannot
  // reach GND even then is certainly floating.
  // A wired ground terminal is the circuit reference: the GND symbol, or the GND pin of an
  // MCU board, whose pads the runtime drives against it (Sprint 6).
  const hasGround = doc.components.some((c) => {
    const g = CATALOG[c.type].groundTerminal;
    return g !== undefined && netOf.has(`${c.id}\u0000${g}`);
  });
  if (wiredParts.length && !hasGround) {
    issues.push({ code: 'no_ground', severity: 'warning', components: wiredParts });
  } else if (wiredParts.length) {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      const p = parent.get(k)!;
      if (p === k) return k;
      const r = find(p);
      parent.set(k, r);
      return r;
    };
    const node = (c: string, t: string) => {
      const n = netOf.get(`${c}\u0000${t}`);
      return n === undefined ? `~${c}.${t}` : groundNets.has(n) ? REF : n;
    };
    const isBoard = (c: { type: string }) => c.type === 'board.esp32_devkitc_wroom32';
    // A wired MCU pad is referenced to GND through the MCU (its driver or input leakage), as in
    // the engine's reference analysis.
    for (const c of doc.components.filter(isBoard)) {
      for (const t of CATALOG[c.type].terminals) {
        if (netOf.has(`${c.id}\u0000${t.id}`)) parent.set(find(node(c.id, t.id)), find(REF));
      }
    }
    const two = doc.components.filter((c) => wiredParts.includes(c.id) && !isBoard(c));
    for (const c of two) {
      const [t0, t1] = CATALOG[c.type].terminals.map((t) => t.id) as [string, string];
      parent.set(find(node(c.id, t0)), find(node(c.id, t1)));
    }
    const floating = two
      .filter((c) => find(node(c.id, CATALOG[c.type].terminals[0]!.id)) !== find(REF))
      .map((c) => c.id);
    if (floating.length)
      issues.push({ code: 'floating_island', severity: 'warning', components: floating });
  }

  // Visual ambiguity: a wire drawn across a terminal it is NOT connected to. Terminal
  // positions are computed once, and each wire is tested only against terminals inside its
  // route's bounding box, so the cost stays near-linear for V1-sized workspaces.
  const groupOf = new Map<string, number>();
  wireGroups(doc).forEach((g, i) => g.forEach((k) => groupOf.set(k, i)));
  const terminals: { component: string; terminal: string; key: string; x: number; y: number }[] =
    [];
  for (const c of doc.components) {
    for (const t of CATALOG[c.type].terminals) {
      const p = terminalPosition(doc, c.id, t.id);
      if (p) {
        const key = nodeKey({ kind: 'terminal', component: c.id, terminal: t.id });
        terminals.push({ component: c.id, terminal: t.id, key, x: p.x, y: p.y });
      }
    }
  }
  for (const w of doc.layout.wires) {
    const route = wireRoute(doc, w);
    if (!route) continue;
    const group = groupOf.get(nodeKey(w.from));
    const xs = route.map((p) => p.x);
    const ys = route.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (const term of terminals) {
      if (term.x < x0 || term.x > x1 || term.y < y0 || term.y > y1) continue;
      if (group !== undefined && groupOf.get(term.key) === group) continue; // same net: consistent
      const touches = route.some(
        (a, i) => i < route.length - 1 && pointOnSegment(term, a, route[i + 1]!),
      );
      if (touches) {
        issues.push({
          code: 'wire_over_terminal',
          severity: 'warning',
          components: [term.component],
          terminals: [term.terminal],
          wire: w.id,
        });
      }
    }
  }
  return issues;
}
