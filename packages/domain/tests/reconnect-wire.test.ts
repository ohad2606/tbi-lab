/**
 * TBI-001 slice 4: reconnectWire re-picks one end of a wire in ONE edit. The electrical result
 * equals deleting the wire and adding a new one; refusals leave the document untouched.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  connectivity,
  deleteSelection,
  reconnectWire,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

/** PSU1 + R1 + R2; W1: PSU1.positive -> R1.a */
function bench(): ProjectDocument {
  let doc = must(addComponent(newDoc(), 'component.resistor', { x: 60, y: -20 })).doc;
  doc = must(addComponent(doc, 'component.resistor', { x: 60, y: 60 })).doc;
  return must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'), [], { waypoints: [] })).doc;
}

/** Order-independent electrical summary: node groups of pins and the stored nets' members. */
const electrics = (doc: ProjectDocument) => {
  const g = connectivity(doc);
  const groups = new Map<string, string[]>();
  for (const [pin, node] of g.nodeOf) groups.set(node, [...(groups.get(node) ?? []), pin]);
  return {
    groups: [...groups.values()].map((p) => p.sort().join(',')).sort(),
    connections: doc.connections.map((c) => `${c.component}.${c.terminal}`).sort(),
  };
};

describe('reconnectWire', () => {
  it('moves the end, keeps the id and the other end, and the document stays valid', () => {
    const before = bench();
    const after = must(reconnectWire(before, 'W1', 'to', t('R2', 'a'))).doc;
    const w = after.layout.wires.find((x) => x.id === 'W1')!;
    expect(after.layout.wires).toHaveLength(1);
    expect(w.from).toEqual(t('PSU1', 'positive'));
    expect(w.to).toEqual(t('R2', 'a'));
    expect(w.auto).toEqual({ waypoints: [] });
    expect(validateProject(after)).toEqual([]);
    expect(before.layout.wires[0]!.to).toEqual(t('R1', 'a')); // input untouched
  });

  it('has the same electrical result as deleting the wire and adding a new one', () => {
    const before = bench();
    for (const [end, target, other] of [
      ['to', t('R2', 'a'), t('PSU1', 'positive')],
      ['from', t('R2', 'b'), t('R1', 'a')],
      ['to', t('PSU1', 'negative'), t('PSU1', 'positive')],
    ] as const) {
      const viaEdit = must(reconnectWire(before, 'W1', end, target)).doc;
      const del = must(
        deleteSelection(before, { components: [], wires: ['W1'], junctions: [] }),
      ).doc;
      const viaPair = must(addWire(del, other, target)).doc;
      expect(electrics(viaEdit)).toEqual(electrics(viaPair));
    }
  });

  it('refuses with a reason and never changes the document', () => {
    const before = bench();
    const snap = JSON.stringify(before);
    const cases = [
      ['to', t('PSU1', 'positive'), 'same_endpoint'], // the other end
      ['to', t('R1', 'a'), 'wire_unchanged'], // the end it already has
      ['to', t('R9', 'a'), 'unknown_component'],
      ['to', t('R2', 'zz'), 'unknown_terminal'],
      ['to', { kind: 'junction' as const, junction: 'J9' }, 'unknown_junction'],
      ['to', { kind: 'wire' as const, wire: 'W1', at: { x: 0, y: 0 } }, 'not_on_wire'],
    ] as const;
    for (const [end, target, error] of cases)
      expect(reconnectWire(before, 'W1', end, target), error).toEqual({ ok: false, error });
    expect(reconnectWire(before, 'W9', 'to', t('R2', 'a'))).toEqual({
      ok: false,
      error: 'unknown_wire',
    });
    expect(JSON.stringify(before)).toBe(snap);
  });

  it('refuses a duplicate of another wire (either direction)', () => {
    let doc = bench();
    doc = must(addWire(doc, t('R2', 'a'), t('PSU1', 'positive'))).doc; // W2
    expect(reconnectWire(doc, 'W1', 'to', t('R2', 'a'))).toEqual({
      ok: false,
      error: 'duplicate_wire',
    });
  });
});
