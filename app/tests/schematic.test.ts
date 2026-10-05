/**
 * Sprint 9: the generated professional schematic. The central invariant: reading the DRAWING
 * back (wires and their ends, pins on wires, ground symbols, rail labels, net labels of the same
 * name) gives exactly the project's electrical nodes — the schematic can neither lose, add nor
 * merge a connection, and it holds no state of its own.
 */
import { describe, expect, it } from 'vitest';
import { GROUND_NODE, deleteSelection, moveSelection, setParam } from '@tbi-lab/domain';
import { mixedCircuit, place, wire } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import { EXAMPLES } from '../src/examples/catalog.js';
import { schematicLayout } from '../src/views/schematic/layout.js';
import { SCHEMATIC_SYMBOLS } from '../src/views/schematic/symbols.js';
import { crossings, expectFaithful } from './schematicReadback.js';

describe('generated schematic', () => {
  it('the representative ESP32 + LED + resistor + button + supply circuit is drawn faithfully', () => {
    const { doc, ids } = mixedCircuit();
    const l = expectFaithful(doc);
    expect(crossings(l)).toBe(0);
    // ESP32 is a module block with exactly its connected pins, by name, on their header sides.
    expect(l.modules).toHaveLength(1);
    const pins = l.modules[0]!.pins.map((p) => `${p.side}:${p.name}`);
    expect(pins.sort()).toEqual(['left:IO34', 'right:GND', 'right:IO4']);
    // Ground connections are ground symbols (one per grounded end), the supply a rail label.
    const grounds = l.marks.filter((m) => m.kind === 'ground');
    expect(grounds.length).toBe(4); // PSU −, pull-down, LED cathode, board GND
    expect(grounds.every((m) => m.node === GROUND_NODE)).toBe(true);
    const rails = l.marks.filter((m) => m.kind === 'rail');
    expect(rails.map((m) => m.supply)).toEqual([ids.psu, ids.psu]);
    // Signal flow: the LED branch runs right from IO4, the input chain left from IO34.
    const part = (id: string) => l.parts.find((p) => p.component === id)!;
    const io4 = l.modules[0]!.pins.find((p) => p.name === 'IO4')!;
    expect(part(ids.rled!).x).toBeGreaterThan(io4.at.x);
    expect(part(ids.led!).x).toBeGreaterThan(part(ids.rled!).x);
    const io34 = l.modules[0]!.pins.find((p) => p.name === 'IO34')!;
    expect(part(ids.rin!).x).toBeLessThan(io34.at.x);
    // The LED hangs to ground with its anode up (cathode on the ground side).
    const led = part(ids.led!);
    expect(led.vertical).toBe(true);
    expect(led.pins.anode!.y).toBeLessThan(led.pins.cathode!.y);
  });

  it('every curated example is drawn faithfully and without wire crossings', () => {
    for (const e of EXAMPLES) {
      const l = expectFaithful(e.document);
      expect(crossings(l), e.id).toBe(0);
    }
  });

  it('independent groups stand side by side with their rails level, wrapping into rows', () => {
    // Diode polarity: two rail-to-ground branches beside the supply, not one below the other.
    const dp = EXAMPLES.find((e) => e.id === 'diode-polarity')!.document;
    const l = expectFaithful(dp);
    const at = (id: string) => l.parts.find((p) => p.component === id)!;
    expect(at('R1').y).toBe(at('R2').y);
    expect(at('D1').y).toBe(at('D2').y);
    expect(new Set(l.marks.filter((m) => m.kind === 'rail').map((m) => m.at.y)).size).toBe(1);
    expect(l.bounds.maxY - l.bounds.minY).toBeLessThanOrEqual(260);

    // Twelve LED branches off one rail: rows of groups, never one tall column, never too wide.
    let doc = newDoc();
    doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
    for (let i = 0; i < 12; i++) {
      const r = place(doc, 'component.resistor', 200 + i * 120, 100);
      const d = place(r.doc, 'component.led', 200 + i * 120, 300);
      const g = place(d.doc, 'component.ground', 200 + i * 120, 500);
      doc = wire(g.doc, ['PSU1', 'positive'], [r.id, 'a']);
      doc = wire(doc, [r.id, 'b'], [d.id, 'anode']);
      doc = wire(doc, [d.id, 'cathode'], [g.id, 'ref']);
    }
    const many = expectFaithful(doc);
    expect(crossings(many)).toBe(0);
    const ys = new Set(many.parts.filter((p) => p.key === 'resistor').map((p) => p.y));
    expect(ys.size).toBeGreaterThan(1); // wrapped
    expect(ys.size).toBeLessThan(12); // but rows, not a column
    expect(many.bounds.maxX - many.bounds.minX).toBeLessThanOrEqual(1100);
  });

  it('cycles and a node on two MCU pins are joined by net labels of the same name', () => {
    const fixture = mixedCircuit();
    const ids = fixture.ids;
    let doc = fixture.doc;
    // A second path IO34 ↔ IO4 node via a resistor (a cycle through the board), and a second
    // pin on the IO4 node.
    const r = place(doc, 'component.resistor', 0, 400);
    doc = r.doc;
    doc = wire(doc, [r.id, 'a'], [ids.rin!, 'a']);
    doc = wire(doc, [r.id, 'b'], [ids.led!, 'anode']);
    doc = wire(doc, [ids.u!, 'gpio2'], [ids.rled!, 'a']);
    const l = expectFaithful(doc);
    expect(l.marks.some((m) => m.kind === 'net')).toBe(true);
    expect(crossings(l)).toBe(0);
  });

  it('parallel parts, a floating supply, open pins and unconnected parts', () => {
    let doc = newDoc();
    const p = place(doc, 'instrument.lab_psu', 0, 0);
    doc = p.doc;
    const r1 = place(doc, 'component.resistor', 200, 0);
    doc = r1.doc;
    const r2 = place(doc, 'component.resistor', 200, 100);
    doc = r2.doc;
    const d = place(doc, 'component.diode', 400, 0);
    doc = d.doc;
    const lone = place(doc, 'component.led', 600, 300);
    doc = lone.doc;
    doc = wire(doc, [p.id, 'positive'], [r1.id, 'a']);
    doc = wire(doc, [p.id, 'negative'], [r1.id, 'b']);
    doc = wire(doc, [r2.id, 'a'], [r1.id, 'a']);
    doc = wire(doc, [r2.id, 'b'], [r1.id, 'b']);
    doc = wire(doc, [d.id, 'anode'], [r1.id, 'a']);
    const l = expectFaithful(doc);
    // The new project's own supply and ground stay unwired here.
    expect(l.unconnected).toEqual(['PSU1', 'GND1', lone.id]);
    expect(crossings(l)).toBe(0);
  });

  it('is deterministic and ignores the 2D drawing; edits in the model show up', () => {
    const { doc, ids } = mixedCircuit();
    const a = schematicLayout(doc);
    expect(JSON.stringify(schematicLayout(doc))).toBe(JSON.stringify(a));
    const moved = must(
      moveSelection(
        doc,
        { components: doc.components.map((c) => c.id), wires: [], junctions: [] },
        {
          x: 300,
          y: -200,
        },
      ),
    ).doc;
    expect(schematicLayout(moved)).toEqual(a);
    // A design value is not topology: same geometry.
    const valued = must(setParam(doc, ids.rled!, 'resistance', { value: 330, unit: 'ohm' })).doc;
    expect(schematicLayout(valued)).toEqual(a);
    // Removing a part removes it; the rest stays faithful.
    const without = must(
      deleteSelection(doc, { components: [ids.rpd!], wires: [], junctions: [] }),
    ).doc;
    const b = expectFaithful(without);
    expect(b.parts.some((p) => p.component === ids.rpd)).toBe(false);
    // Reconnecting: the LED's cathode moves from ground to a new resistor.
    const r = place(without, 'component.resistor', 600, 200);
    let rewired = r.doc;
    rewired = must(
      deleteSelection(rewired, {
        components: [],
        wires: rewired.layout.wires
          .filter((w) =>
            [w.from, w.to].some(
              (e) => e.kind === 'terminal' && e.component === ids.led && e.terminal === 'cathode',
            ),
          )
          .map((w) => w.id),
        junctions: [],
      }),
    ).doc;
    rewired = wire(rewired, [ids.led!, 'cathode'], [r.id, 'a']);
    const c = expectFaithful(rewired);
    const led = c.parts.find((p) => p.component === ids.led)!;
    expect(led.vertical).toBe(false); // now in series towards the new resistor
  });

  it('every component type has a schematic symbol', () => {
    for (const e of EXAMPLES)
      for (const comp of e.document.components)
        expect(SCHEMATIC_SYMBOLS[comp.type], comp.type).toBeDefined();
  });
});
