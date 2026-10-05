/**
 * Direct terminal-to-terminal contact (Sprint 9): a resistor lead touching an LED lead with no
 * wire drawn between them.
 *
 * Representation: a CONTACT is an ordinary wire whose two ends are terminals of different
 * components, with no vertices, whose terminals sit at the same position. It is stored in
 * `layout.wires` like any wire, so the netlist (nets.ts), validation, simulation snapshots,
 * import/export and every generated view treat it exactly as a connection; older readers load it
 * as the zero-length wire it is. No schema change.
 *
 * Contacts are made and broken only by placement edits (add, move, rotate), never inferred when
 * a document is read:
 * - make: a terminal of a component that was placed, moved or rotated, landing EXACTLY on a
 *   terminal of another component, gets a contact with it. Placement snaps to the grid (and every
 *   terminal offset is a grid multiple), so "within snap tolerance" means: the pointer released
 *   within half a grid step of the exact spot. Terminals a grid step or more apart never touch.
 * - break: a contact whose terminals no longer coincide after the edit is removed (pulling the
 *   parts apart separates them; it does not stretch into a wire).
 * Only terminals take part: bodies, wires, junctions and drawn-but-unconnectable board pins never
 * make a contact. And at least one of the two must be a LEAD (`LEADED_TYPES`): a resistor lead can
 * touch an LED lead, a header pin or a supply's binding post, but a header pin laid on a binding
 * post is not a physical contact (that takes a wire).
 */

import { CATALOG } from './catalog.js';
import { allocateId } from './project.js';
import { terminalPosition } from './layout.js';
import type { ComponentTypeId, ProjectDocument, Wire } from './schema.js';

type TerminalEnd = { kind: 'terminal'; component: string; terminal: string };

/** Parts whose terminals are wire leads, which can touch another terminal directly. */
export const LEADED_TYPES: ReadonlySet<ComponentTypeId> = new Set<ComponentTypeId>([
  'component.resistor',
  'component.led',
  'component.diode',
  'component.push_button',
  'component.toggle_switch',
]);

const same = (a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined) =>
  !!a && !!b && a.x === b.x && a.y === b.y;

/** Whether `w` is a direct contact in `doc` (see the module comment). */
export function isContact(doc: ProjectDocument, w: Wire): boolean {
  if (w.from.kind !== 'terminal' || w.to.kind !== 'terminal' || w.vertices.length) return false;
  if (w.from.component === w.to.component) return false;
  return same(
    terminalPosition(doc, w.from.component, w.from.terminal),
    terminalPosition(doc, w.to.component, w.to.terminal),
  );
}

/** The direct contacts of a document, in wire order. */
export function contacts(doc: ProjectDocument): Wire[] {
  return doc.layout.wires.filter((w) => isContact(doc, w));
}

const pairKey = (a: TerminalEnd, b: TerminalEnd) =>
  [`${a.component}:${a.terminal}`, `${b.component}:${b.terminal}`].sort().join('|');

/**
 * Break and make contacts after a placement edit, mutating `draft`. `before` is the document the
 * edit started from; `placed` the components the edit added, moved or rotated.
 */
export function settleContacts(
  before: ProjectDocument,
  draft: ProjectDocument,
  placed: Iterable<string>,
): void {
  // Break: what was a contact before and no longer touches.
  const was = new Set(before.layout.wires.filter((w) => isContact(before, w)).map((w) => w.id));
  draft.layout.wires = draft.layout.wires.filter((w) => !was.has(w.id) || isContact(draft, w));

  // Make: every terminal of a placed component that lands on another component's terminal.
  const moved = new Set(placed);
  if (!moved.size) return;
  const at = new Map<string, TerminalEnd[]>();
  for (const c of draft.components) {
    for (const t of CATALOG[c.type].terminals) {
      const p = terminalPosition(draft, c.id, t.id);
      if (!p) continue;
      const k = `${p.x},${p.y}`;
      const list = at.get(k) ?? [];
      list.push({ kind: 'terminal', component: c.id, terminal: t.id });
      at.set(k, list);
    }
  }
  const leaded = new Set(draft.components.filter((c) => LEADED_TYPES.has(c.type)).map((c) => c.id));
  const existing = new Set(
    contacts(draft).map((w) => pairKey(w.from as TerminalEnd, w.to as TerminalEnd)),
  );
  for (const group of at.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      if (!moved.has(a.component)) continue;
      for (const b of group) {
        if (b.component === a.component) continue;
        if (!leaded.has(a.component) && !leaded.has(b.component)) continue;
        const k = pairKey(a, b);
        if (existing.has(k)) continue;
        existing.add(k);
        draft.layout.wires.push({ id: allocateId(draft, 'W'), from: a, to: b, vertices: [] });
      }
    }
  }
}

/**
 * Terminals of different components that sit at the same position WITHOUT a contact between
 * them, nor any other connection (different nets, or unwired). Possible only in a document made
 * elsewhere (an import, an older project): editing never leaves touching terminals separate. The
 * views mark these as NOT connected instead of letting touching leads imply a connection.
 */
export function touchingUnconnected(
  doc: ProjectDocument,
): { x: number; y: number; terminals: TerminalEnd[] }[] {
  const netOf = new Map(doc.connections.map((c) => [`${c.component}:${c.terminal}`, c.net]));
  const at = new Map<string, { x: number; y: number; terminals: TerminalEnd[] }>();
  for (const c of doc.components) {
    for (const t of CATALOG[c.type].terminals) {
      const p = terminalPosition(doc, c.id, t.id);
      if (!p) continue;
      const k = `${p.x},${p.y}`;
      const e = at.get(k) ?? { x: p.x, y: p.y, terminals: [] };
      e.terminals.push({ kind: 'terminal', component: c.id, terminal: t.id });
      at.set(k, e);
    }
  }
  const out: { x: number; y: number; terminals: TerminalEnd[] }[] = [];
  for (const e of at.values()) {
    if (new Set(e.terminals.map((t) => t.component)).size < 2) continue;
    const nets = e.terminals.map((t) => netOf.get(`${t.component}:${t.terminal}`));
    const connected = nets[0] !== undefined && nets.every((n) => n === nets[0]);
    if (!connected) out.push(e);
  }
  return out.sort((p, q) => p.x - q.x || p.y - q.y);
}
