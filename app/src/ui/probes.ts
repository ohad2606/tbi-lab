/**
 * Probes (Sprint 4): pinned, OBSERVATIONAL readouts of values the electrical engine already
 * computed. A probe adds no element, resistance or load to the circuit; the engine never sees
 * it. Probe definitions are UI presentation state for the open project (not persisted: V1
 * keeps schema v2 unchanged for them).
 *
 * - `terminal`: potential of a terminal relative to GND (volts).
 * - `net`: potential of a net relative to GND (volts), placed where the wire was clicked.
 * - `current`: current of a component's defined branch (amperes), e.g. resistor a -> b,
 *   LED/diode anode -> cathode, closed switch a -> b, PSU delivered current. There is no
 *   "current in an arbitrary wire": a wire is not a branch the engine defines.
 */

import { terminalPosition, type Point, type ProjectDocument } from '@tbi-lab/domain';
import type { SolveSuccess } from '@tbi-lab/engine';

export type Probe =
  | { id: string; kind: 'terminal'; component: string; terminal: string }
  | { id: string; kind: 'net'; net: string; at: Point }
  | { id: string; kind: 'current'; component: string };

export type ProbeInput =
  | { kind: 'terminal'; component: string; terminal: string }
  | { kind: 'net'; net: string; at: Point }
  | { kind: 'current'; component: string };

export interface ProbeReading {
  quantity: 'volt' | 'ampere';
  /** null: not running, not simulated, or not defined for this point. */
  value: number | null;
}

/** Same probe target (so adding it twice is a no-op). */
export function sameTarget(a: ProbeInput, b: ProbeInput): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'terminal' && b.kind === 'terminal')
    return a.component === b.component && a.terminal === b.terminal;
  if (a.kind === 'net' && b.kind === 'net') return a.net === b.net;
  return a.kind === 'current' && b.kind === 'current' && a.component === b.component;
}

/** Whether the probe still refers to something in the document. */
export function probeExists(p: Probe, doc: ProjectDocument): boolean {
  if (p.kind === 'net') return doc.nets.some((n) => n.id === p.net);
  return doc.components.some((c) => c.id === p.component);
}

export function readProbe(
  p: Probe,
  doc: ProjectDocument,
  outcome: SolveSuccess | null,
): ProbeReading {
  if (p.kind === 'current') {
    return { quantity: 'ampere', value: outcome?.components[p.component]?.current ?? null };
  }
  if (!outcome) return { quantity: 'volt', value: null };
  if (p.kind === 'net') return { quantity: 'volt', value: outcome.netVoltages[p.net] ?? null };
  const result = outcome.components[p.component];
  const fromResult = result?.terminals[p.terminal];
  if (fromResult !== undefined && fromResult !== null)
    return { quantity: 'volt', value: fromResult };
  // A terminal of a part the engine does not report (GND symbol): read its net.
  const net = doc.connections.find(
    (c) => c.component === p.component && c.terminal === p.terminal,
  )?.net;
  return { quantity: 'volt', value: net !== undefined ? (outcome.netVoltages[net] ?? null) : null };
}

/** Where the probe pin is drawn, in schematic units. */
export function probeAnchor(p: Probe, doc: ProjectDocument): Point | undefined {
  if (p.kind === 'net') return p.at;
  if (p.kind === 'terminal') return terminalPosition(doc, p.component, p.terminal);
  const placement = doc.layout.components[p.component];
  return placement ? { x: placement.x, y: placement.y } : undefined;
}

/** Language-neutral point name: `R1.a`, `N_3`, `R1`. */
export function probeTargetName(p: Probe): string {
  if (p.kind === 'terminal') return `${p.component}.${p.terminal}`;
  if (p.kind === 'net') return p.net;
  return p.component;
}
