/**
 * Sprint 9: the connectivity graph the generated views draw from. Topology only — the same
 * circuit drawn with different wire geometry gives the same graph.
 */
import { describe, expect, it } from 'vitest';
import { GROUND_NODE, connectivity, deleteSelection, moveSelection } from '../src/index.js';
import { mixedCircuit, place, wire } from './circuits.js';
import { must, newDoc } from './helpers.js';

describe('connectivity graph', () => {
  it('merges every ground net into one reference node and marks the supply rail', () => {
    const { doc, ids } = mixedCircuit();
    expect(doc.nets.filter((n) => n.role === 'ground').length).toBe(4);
    const g = connectivity(doc);
    const ground = g.nodes.filter((n) => n.kind === 'ground');
    expect(ground).toHaveLength(1);
    expect(ground[0]!.id).toBe(GROUND_NODE);
    expect(ground[0]!.nets).toHaveLength(4);
    const nodeOf = (c: string, t: string) => g.nodeOf.get(`${c}:${t}`);
    for (const [c, t] of [
      [ids.psu!, 'negative'],
      [ids.rpd!, 'b'],
      [ids.led!, 'cathode'],
      [ids.u!, 'gnd'],
    ])
      expect(nodeOf(c!, t!)).toBe(GROUND_NODE);
    const rail = g.nodes.find((n) => n.kind === 'supply')!;
    expect(rail.supply).toBe(ids.psu);
    expect(rail.pins).toEqual([
      { component: ids.psu, terminal: 'positive' },
      { component: ids.sw, terminal: 'a' },
    ]);
  });

  it('expresses the representative net relationships (button → resistor → GPIO34 with pull-down; GPIO4 → resistor → LED)', () => {
    const { doc, ids } = mixedCircuit();
    const g = connectivity(doc);
    const same = (a: [string, string], b: [string, string]) =>
      g.nodeOf.get(`${a[0]}:${a[1]}`) === g.nodeOf.get(`${b[0]}:${b[1]}`);
    expect(same([ids.sw!, 'b'], [ids.rin!, 'a'])).toBe(true);
    expect(same([ids.rin!, 'b'], [ids.u!, 'gpio34'])).toBe(true);
    expect(same([ids.rpd!, 'a'], [ids.u!, 'gpio34'])).toBe(true);
    expect(same([ids.u!, 'gpio4'], [ids.rled!, 'a'])).toBe(true);
    expect(same([ids.rled!, 'b'], [ids.led!, 'anode'])).toBe(true);
    expect(same([ids.u!, 'gpio4'], [ids.u!, 'gpio34'])).toBe(false);
    const io34 = g.nodes.find((n) => n.pins.some((p) => p.terminal === 'gpio34'))!;
    expect(io34.kind).toBe('signal');
    expect(io34.pins).toHaveLength(3);
    // Unwired terminals are explicit, never invented.
    const board = g.components.find((c) => c.id === ids.u)!;
    expect(board.terminals.find((t) => t.terminal === 'gpio2')!.node).toBeNull();
  });

  it('reads topology only: moving parts (wire geometry) changes nothing; deleting a part does', () => {
    const { doc, ids } = mixedCircuit();
    const before = connectivity(doc);
    const moved = must(
      moveSelection(
        doc,
        { components: [ids.led!, ids.rled!], wires: [], junctions: [] },
        {
          x: 200,
          y: 300,
        },
      ),
    ).doc;
    expect(connectivity(moved)).toEqual(before);
    const without = must(
      deleteSelection(doc, { components: [ids.rpd!], wires: [], junctions: [] }),
    ).doc;
    const after = connectivity(without);
    expect(after.components.some((c) => c.id === ids.rpd)).toBe(false);
    const io34 = after.nodes.find((n) => n.pins.some((p) => p.terminal === 'gpio34'))!;
    expect(io34.pins).toHaveLength(2);
  });

  it('a supply whose negative terminal is not grounded is not a rail', () => {
    let doc = newDoc();
    const p = place(doc, 'instrument.lab_psu', 0, 0);
    doc = p.doc;
    const r = place(doc, 'component.resistor', 200, 0);
    doc = r.doc;
    doc = wire(doc, [p.id, 'positive'], [r.id, 'a']);
    doc = wire(doc, [p.id, 'negative'], [r.id, 'b']);
    const g = connectivity(doc);
    expect(g.nodes.map((n) => n.kind)).toEqual(['signal', 'signal']);
  });

  it('is deterministic', () => {
    const { doc } = mixedCircuit();
    expect(JSON.stringify(connectivity(doc))).toBe(JSON.stringify(connectivity(doc)));
  });
});
