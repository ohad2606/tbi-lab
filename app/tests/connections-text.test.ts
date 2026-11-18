import { describe, expect, it } from 'vitest';
import { newDoc } from '../../packages/domain/tests/helpers.js';
import { place, wire } from '../../packages/domain/tests/circuits.js';
import { describeConnections } from '../src/ui/connectionsText.js';

const fmt = (q: { value: number; unit: string }) => `${q.value} ${q.unit}`;

function circuit() {
  let doc = newDoc();
  // A new project starts with the supply PSU1 and the ground GND1.
  let n = 0;
  const ids: Record<string, string> = { psu: 'PSU1', g: 'GND1' };
  for (const [k, type] of [
    ['r1', 'component.resistor'],
    ['r2', 'component.resistor'],
  ] as const) {
    // Far apart: touching terminals would join nets by themselves.
    const r = place(doc, type, 400 + 300 * n++, 400);
    doc = r.doc;
    ids[k] = r.id;
  }
  doc = wire(doc, [ids.psu!, 'negative'], [ids.g!, 'ref']);
  doc = wire(doc, [ids.psu!, 'positive'], [ids.r1!, 'a']);
  doc = wire(doc, [ids.r1!, 'b'], [ids.r2!, 'a']);
  // r2.b is left unconnected.
  return { doc, ids };
}

describe('describeConnections (A11Y-028)', () => {
  it('lists parts with ref, type, value and unconnected pins', () => {
    const { doc, ids } = circuit();
    const d = describeConnections(doc, (q) => fmt(q as never));
    expect(d.parts.map((p) => p.ref)).toEqual(doc.components.map((c) => c.id));
    const r2 = d.parts.find((p) => p.ref === ids.r2)!;
    expect(r2.typeNameKey).toBe('component.component.resistor.name');
    expect(r2.values).toHaveLength(1);
    expect(r2.unconnected.map((u) => u.terminalKey)).toHaveLength(1);
    expect(d.parts.find((p) => p.ref === ids.r1)!.unconnected).toEqual([]);
  });

  it('lists one entry per net with its endpoints; ground first, others numbered from 1', () => {
    const { doc, ids } = circuit();
    const d = describeConnections(doc, (q) => fmt(q as never));
    expect(d.nets.map((n) => [n.ground, n.index])).toEqual([
      [true, 0],
      [false, 1],
      [false, 2],
    ]);
    const refs = (i: number) => d.nets[i]!.endpoints.map((e) => e.ref).sort();
    expect(refs(0)).toEqual([ids.g, ids.psu].sort());
    expect(refs(1)).toEqual([ids.psu, ids.r1].sort());
    expect(refs(2)).toEqual([ids.r1, ids.r2].sort());
  });

  it('a new project lists its parts and no nets', () => {
    const d = describeConnections(newDoc(), (q) => fmt(q as never));
    expect(d.nets).toEqual([]);
    expect(d.parts.map((p) => p.ref)).toEqual(['PSU1', 'GND1']);
  });
});
