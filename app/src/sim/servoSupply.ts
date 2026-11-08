/**
 * Sprint 17C: a supply reading that leaves something out says so. The SG90's supply current is not
 * modelled (decision R4-D3), so a bench supply wired straight to a servo's VCC reports only the
 * current of everything else. Which servos are on a supply's output, from the project's nets.
 */
import type { ProjectDocument } from '@tbi-lab/domain';

/** Servos whose VCC terminal is on the same net as supply `psuId`'s positive output. */
export function servosOnSupply(doc: ProjectDocument | null, psuId: string): string[] {
  if (!doc) return [];
  const net = (component: string, terminal: string) =>
    doc.connections.find((c) => c.component === component && c.terminal === terminal)?.net;
  const out = net(psuId, 'positive');
  if (out === undefined) return [];
  return doc.components
    .filter((c) => c.type === 'component.servo_sg90' && net(c.id, 'vcc') === out)
    .map((c) => c.id);
}
