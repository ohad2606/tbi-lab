/**
 * Wire colours (Sprint 10, owner-approved): ONE resolution, shared by the Circuit view and the 3D
 * view, so both always show the same colour for a wire.
 *
 *   wire + connectivity graph -> resolved colour
 *
 * Automatic colour comes from the wire's ELECTRICAL NODE (topology only, never current flow or
 * the order wires were drawn in):
 * - a node directly on the positive terminal of one or more voltage sources (the bench supply),
 *   and on no negative one: RED;
 * - a node directly on the negative terminal of one or more voltage sources, or the circuit
 *   reference (ground), and on no positive one: BLACK;
 * - a node on both (a supply shorted, or a source's + tied to another's -): no colour is chosen;
 *   it stays NEUTRAL grey, and the circuit checks keep reporting the fault;
 * - every other node: the next colour of the signal palette, in the graph's stable node order.
 * The colour stops at every component: PSU+ -> resistor -> LED makes only the PSU+ -> resistor
 * node red; the node after the resistor is another node.
 * A wire the user coloured (`wire.color`) shows that colour, and only that wire; Auto (no colour
 * stored) is the automatic one. Colour is presentation only: it never changes a net.
 */
import {
  GROUND_NODE,
  connectivity,
  nodeKey,
  wireGroups,
  type ComponentTypeId,
  type Connectivity,
  type ProjectDocument,
  type WireColor,
} from '@tbi-lab/domain';

/** The palette (the same in 2D and 3D). */
export const WIRE_COLOR_HEX: Record<WireColor, string> = {
  red: '#d32f2f',
  black: '#202326',
  orange: '#ef7d17',
  blue: '#1e88e5',
  green: '#43a047',
  purple: '#8e24aa',
  yellow: '#f9a825',
  teal: '#00897b',
  brown: '#6d4c41',
};
/** Neither red nor black can be decided (a conflict), or the wire reaches no terminal. */
export const NEUTRAL_HEX = '#9aa3ad';
/** Automatic colours of ordinary nodes, in order (no red or black: those mean + and -). */
const SIGNAL: WireColor[] = ['orange', 'blue', 'green', 'purple', 'yellow', 'teal', 'brown'];

/** Voltage sources and their terminals. */
const SOURCES: Partial<Record<ComponentTypeId, { positive: string; negative: string }>> = {
  'instrument.lab_psu': { positive: 'positive', negative: 'negative' },
};

export type ColorSource = 'manual' | 'positive' | 'negative' | 'net' | 'conflict' | 'unconnected';

export interface ResolvedWireColor {
  hex: string;
  /** The colour shown, or null when neutral. */
  color: WireColor | null;
  /** Why: the user's choice, or the automatic rule that gave it. */
  source: ColorSource;
  /** What Auto would give this wire (for the property control). */
  auto: WireColor | null;
  node: string | null;
}

/** The automatic colour of every electrical node. */
export function nodeColors(
  doc: ProjectDocument,
  g: Connectivity = connectivity(doc),
): Map<string, { color: WireColor | null; source: ColorSource }> {
  const out = new Map<string, { color: WireColor | null; source: ColorSource }>();
  const type = new Map(doc.components.map((c) => [c.id, c.type]));
  let next = 0;
  for (const n of g.nodes) {
    let pos = false;
    let neg = n.id === GROUND_NODE;
    for (const p of n.pins) {
      const s = SOURCES[type.get(p.component)!];
      if (!s) continue;
      if (p.terminal === s.positive) pos = true;
      if (p.terminal === s.negative) neg = true;
    }
    if (pos && neg) out.set(n.id, { color: null, source: 'conflict' });
    else if (pos) out.set(n.id, { color: 'red', source: 'positive' });
    else if (neg) out.set(n.id, { color: 'black', source: 'negative' });
    else out.set(n.id, { color: SIGNAL[next++ % SIGNAL.length]!, source: 'net' });
  }
  return out;
}

/** The resolved colour of every wire of the project (by wire id). */
export function resolveWireColors(
  doc: ProjectDocument,
  g: Connectivity = connectivity(doc),
): Map<string, ResolvedWireColor> {
  const byNode = nodeColors(doc, g);
  // A wire belongs to the node of the wire group it is part of (a junction carries it on).
  const groupNode = new Map<string, string | null>();
  for (const group of wireGroups(doc)) {
    const t = group.find((k) => k.startsWith('t:'));
    const [, comp, term] = t ? t.split(':') : [];
    const node = t ? (g.nodeOf.get(`${comp}:${term}`) ?? null) : null;
    for (const k of group) groupNode.set(k, node);
  }
  const out = new Map<string, ResolvedWireColor>();
  for (const w of doc.layout.wires) {
    const node = groupNode.get(nodeKey(w.from)) ?? null;
    const auto = node ? byNode.get(node) : undefined;
    const autoColor = auto?.color ?? null;
    if (w.color && w.color in WIRE_COLOR_HEX)
      out.set(w.id, {
        hex: WIRE_COLOR_HEX[w.color],
        color: w.color,
        source: 'manual',
        auto: autoColor,
        node,
      });
    else
      out.set(w.id, {
        hex: autoColor ? WIRE_COLOR_HEX[autoColor] : NEUTRAL_HEX,
        color: autoColor,
        source: auto?.source ?? 'unconnected',
        auto: autoColor,
        node,
      });
  }
  return out;
}

/** Terminal ids of a source type (tests, documentation). */
export const sourceTerminals = (type: ComponentTypeId) => SOURCES[type];
