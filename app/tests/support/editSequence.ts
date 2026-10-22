/**
 * Wire routing integrity (rt2): random edit sequences as the Circuit view commits them (the edit,
 * then the Sprint 9 manual-wire repair where it applies, then the store's canonical routing via
 * the given `route`). Used by the incremental-routing equivalence proof and the netlist property.
 */
import {
  addWire,
  deleteSelection,
  emptySelection,
  getTypeDef,
  makeWiresAutomatic,
  moveWireSegment,
  wireRoute,
  type ProjectDocument,
  type WireTarget,
} from '@tbi-lab/domain';
import { moveRouted, rotateRouted } from '../../src/ui/routing.js';

export type EditKind = 'move' | 'rotate' | 'segment' | 'automatic' | 'addWire' | 'deleteWire';

export interface Step {
  kind: EditKind;
  /** Whether the edit can change connectivity (adding or deleting a wire does, explicitly). */
  electrical: boolean;
  doc: ProjectDocument;
}

/** One random edit (or null when the drawn one is not applicable to this document). */
export function randomEdit(
  doc: ProjectDocument,
  R: () => number,
  route: (d: ProjectDocument) => ProjectDocument,
  kinds: readonly EditKind[] = ['move', 'move', 'move', 'rotate', 'segment', 'automatic'],
): Step | null {
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(R() * xs.length)];
  const kind = pick(kinds)!;
  const parts = doc.components.map((c) => c.id);
  const wires = doc.layout.wires;
  const done = (r: { ok: boolean; doc?: ProjectDocument }, electrical = false): Step | null =>
    r.ok && r.doc ? { kind, electrical, doc: route(r.doc) } : null;
  switch (kind) {
    case 'move': {
      const part = pick(parts)!;
      const d = { x: 20 * Math.round(R() * 10 - 5), y: 20 * Math.round(R() * 10 - 5) };
      return done(moveRouted(doc, { ...emptySelection(), components: [part] }, d));
    }
    case 'rotate':
      return done(rotateRouted(doc, [pick(parts)!]));
    case 'segment': {
      const w = pick(wires);
      const r = w && wireRoute(doc, w);
      if (!w || !r || r.length < 2) return null;
      const seg = Math.floor(R() * (r.length - 1));
      const d = { x: 20 * Math.round(R() * 6 - 3), y: 20 * Math.round(R() * 6 - 3) };
      return done(moveWireSegment(doc, w.id, seg, d));
    }
    case 'automatic': {
      const manual = wires.filter((w) => !w.auto);
      const w = pick(manual);
      return w ? done(makeWiresAutomatic(doc, [w.id])) : null;
    }
    case 'deleteWire': {
      const w = pick(wires);
      return w ? done(deleteSelection(doc, { ...emptySelection(), wires: [w.id] }), true) : null;
    }
    case 'addWire': {
      const ends = doc.components.flatMap((c) =>
        (getTypeDef(c.type)?.terminals ?? []).map((t): WireTarget => ({
          kind: 'terminal',
          component: c.id,
          terminal: t.id,
        })),
      );
      const a = pick(ends)!;
      const b = pick(ends)!;
      return done(addWire(doc, a, b, [], { waypoints: [] }), true);
    }
  }
}
