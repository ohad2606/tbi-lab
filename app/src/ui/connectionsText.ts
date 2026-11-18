/**
 * A11Y-028: the circuit's parts and connections as structured text, for assistive technology and
 * for anyone who cannot read the canvas. Derived on every call from the domain's `connectivity()`
 * (the canonical netlist); it stores and decides nothing, so it can never disagree with the
 * circuit. Pure: names are keys, translated by the panel.
 */
import {
  CATALOG,
  GROUND_NODE,
  connectivity,
  type ParamValue,
  type ProjectDocument,
  type Quantity,
} from '@tbi-lab/domain';

export interface PinText {
  /** Reference designator (`R1`): technical, language-neutral. */
  ref: string;
  /** Translation key of the terminal's name. */
  terminalKey: string;
}

export interface PartText {
  ref: string;
  typeNameKey: string;
  /** Quantity parameters in catalog order, formatted by the caller's formatter. */
  values: string[];
  /** Terminals not connected to any net. */
  unconnected: PinText[];
}

export interface NetText {
  /** Electrical node id (`GND` or the net id). */
  id: string;
  ground: boolean;
  /** 1-based position among the non-ground nets; 0 for ground. */
  index: number;
  /** User-authored net name, verbatim, or null. */
  userName: string | null;
  endpoints: PinText[];
}

export interface ConnectionsText {
  parts: PartText[];
  /** Ground first (when wired), then the others in netlist order. */
  nets: NetText[];
}

const isQuantity = (v: ParamValue | undefined): v is Quantity =>
  typeof v === 'object' && v !== null;

export function describeConnections(
  doc: ProjectDocument,
  formatQuantity: (q: Quantity) => string,
): ConnectionsText {
  const g = connectivity(doc);
  let index = 0;
  const nets: NetText[] = g.nodes.map((n) => ({
    id: n.id,
    ground: n.id === GROUND_NODE,
    index: n.id === GROUND_NODE ? 0 : ++index,
    userName: n.userName,
    endpoints: n.pins.map((p) => ({
      ref: p.component,
      terminalKey: CATALOG[doc.components.find((c) => c.id === p.component)!.type].terminals.find(
        (t) => t.id === p.terminal,
      )!.labelKey,
    })),
  }));
  const parts = doc.components.map((c, i) => {
    const def = CATALOG[c.type];
    const values: string[] = [];
    for (const p of def.params) {
      const v = c.params[p.key];
      if (p.kind === 'quantity' && isQuantity(v)) values.push(formatQuantity(v));
    }
    const labelOf = new Map(def.terminals.map((t) => [t.id, t.labelKey]));
    return {
      ref: c.id,
      typeNameKey: def.nameKey,
      values,
      unconnected: g.components[i]!.terminals.filter((t) => t.node === null).map((t) => ({
        ref: c.id,
        terminalKey: labelOf.get(t.terminal)!,
      })),
    };
  });
  return { parts, nets };
}
