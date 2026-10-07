/**
 * Wire colours (Sprint 10, owner-approved): one resolution for the Circuit and 3D views, from
 * the electrical node (topology only): + supply node red, - supply / reference node black, a
 * conflict neutral, other nodes the signal palette; a manual colour overrides one wire; Auto
 * restores; saved and round-tripped; never an electrical change.
 */
import { describe, expect, it } from 'vitest';
import {
  addWire,
  connectivity,
  createPackage,
  parsePackage,
  serializePackage,
  setWireColor,
  validateProject,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { place, wire } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';
import { NEUTRAL_HEX, WIRE_COLOR_HEX, resolveWireColors } from '../src/views/wireColors.js';
import { deriveScene } from '../src/views/scene3d/scene.js';

const wireOf = (doc: ProjectDocument, a: string, b: string) =>
  doc.layout.wires.find((w) => {
    const k = (e: (typeof w)['from']) =>
      e.kind === 'terminal' ? `${e.component}:${e.terminal}` : `J:${e.junction}`;
    return (k(w.from) === a && k(w.to) === b) || (k(w.from) === b && k(w.to) === a);
  })!;
/** The 3D scene's colour of a wire (it must equal the shared resolution, i.e. the Circuit's). */
const color3d = (doc: ProjectDocument, id: string) =>
  deriveScene(doc).wires.find((w) => w.id === id)!.color;

/** PSU+ -> junction -> R1 and R2; R1 -> D1 (an LED) -> ground; R2 -> ground. */
function supplyCircuit() {
  let doc = place(newDoc(), 'component.resistor', 100, -100).doc; // R1
  doc = place(doc, 'component.resistor', 100, 100).doc; // R2
  doc = place(doc, 'component.led', 260, -100).doc; // D1
  doc = wire(doc, ['PSU1', 'positive'], ['R1', 'a']);
  const first = doc.layout.wires.at(-1)!;
  // A second wire from the first one (a junction on it) to R2.a: the same node.
  doc = must(
    addWire(
      doc,
      { kind: 'terminal', component: 'R2', terminal: 'a' },
      { kind: 'wire', wire: first.id, at: { x: 0, y: -20 } },
    ),
  ).doc;
  doc = wire(doc, ['R1', 'b'], ['D1', 'anode']);
  doc = wire(doc, ['D1', 'cathode'], ['GND1', 'ref']);
  doc = wire(doc, ['R2', 'b'], ['GND1', 'ref']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}

describe('wire colours from the electrical net', () => {
  it('A. positive source: every wire of the PSU+ node (through a junction) is red', () => {
    const doc = supplyCircuit();
    expect(doc.layout.junctions.length).toBe(1);
    const g = connectivity(doc);
    const node = g.nodeOf.get('PSU1:positive')!;
    const colors = resolveWireColors(doc);
    const onNode = doc.layout.wires.filter((w) => colors.get(w.id)!.node === node);
    expect(onNode.length).toBeGreaterThanOrEqual(3); // PSU -> J, J -> R1, J -> R2
    for (const w of onNode) {
      expect(colors.get(w.id)).toMatchObject({ color: 'red', source: 'positive' });
      expect(color3d(doc, w.id)).toBe(WIRE_COLOR_HEX.red);
    }
  });

  it('B. negative source / reference: the PSU- and ground wires are black', () => {
    const doc = supplyCircuit();
    const colors = resolveWireColors(doc);
    for (const [a, b] of [
      ['PSU1:negative', 'GND1:ref'],
      ['D1:cathode', 'GND1:ref'],
      ['R2:b', 'GND1:ref'],
    ] as const) {
      const w = wireOf(doc, a, b);
      expect(colors.get(w.id)).toMatchObject({ color: 'black', source: 'negative' });
      expect(color3d(doc, w.id)).toBe(WIRE_COLOR_HEX.black);
    }
    // A negative terminal NOT on ground is black too (it is the source's negative node).
    let floating = place(newDoc(), 'component.resistor', 100, 0).doc;
    floating = wire(floating, ['PSU1', 'negative'], ['R1', 'b']);
    floating = wire(floating, ['PSU1', 'positive'], ['R1', 'a']);
    const c = resolveWireColors(floating);
    expect(c.get(wireOf(floating, 'PSU1:negative', 'R1:b').id)!.color).toBe('black');
    expect(c.get(wireOf(floating, 'PSU1:positive', 'R1:a').id)!.color).toBe('red');
  });

  it('C. the colour stops at a component: after the resistor the node is a signal node', () => {
    const doc = supplyCircuit();
    const colors = resolveWireColors(doc);
    const after = colors.get(wireOf(doc, 'R1:b', 'D1:anode').id)!;
    expect(after.source).toBe('net');
    expect(after.color).not.toBe('red');
    expect(after.color).not.toBe('black');
  });

  it('D/E. a manual colour overrides one wire in 2D and 3D; Auto restores; nets unchanged', () => {
    const doc = supplyCircuit();
    const w =
      wireOf(doc, 'PSU1:positive', 'J:' + doc.layout.junctions[0]!.id) ?? doc.layout.wires[0]!;
    const before = connectivity(doc);
    const blue = must(setWireColor(doc, w.id, 'blue')).doc;
    const colors = resolveWireColors(blue);
    expect(colors.get(w.id)).toMatchObject({ color: 'blue', source: 'manual', auto: 'red' });
    expect(color3d(blue, w.id)).toBe(WIRE_COLOR_HEX.blue);
    // Only that wire: the rest of its node stays automatic red.
    const node = colors.get(w.id)!.node;
    for (const x of blue.layout.wires)
      if (x.id !== w.id && colors.get(x.id)!.node === node)
        expect(colors.get(x.id)!.color).toBe('red');
    // Electrically nothing changed.
    expect(blue.nets).toEqual(doc.nets);
    expect(blue.connections).toEqual(doc.connections);
    expect(connectivity(blue).nodeOf).toEqual(before.nodeOf);
    expect(validateProject(blue)).toEqual([]);
    // Auto again: the stored colour goes, the net colour returns.
    const auto = must(setWireColor(blue, w.id, null)).doc;
    expect(auto.layout.wires.find((x) => x.id === w.id)!.color).toBeUndefined();
    expect(resolveWireColors(auto).get(w.id)).toMatchObject({ color: 'red', source: 'positive' });
    expect(auto).toEqual(doc);
  });

  it('F. the manual colour is saved and round-trips through export/import', () => {
    const doc = must(setWireColor(supplyCircuit(), 'W1', 'purple')).doc;
    const text = serializePackage(
      createPackage(doc, { appVersion: 't', exportedAt: '2026-10-07T00:00:00Z' }),
    );
    const back = parsePackage(text);
    if (!back.ok) throw new Error(JSON.stringify(back.error));
    expect(back.doc.layout.wires.find((w) => w.id === 'W1')!.color).toBe('purple');
    expect(resolveWireColors(back.doc).get('W1')!.color).toBe('purple');
    // Older projects (no colour) stay Auto; an unknown colour is refused.
    const old = supplyCircuit();
    expect(old.layout.wires.every((w) => w.color === undefined)).toBe(true);
    const bad = structuredClone(doc) as unknown as { layout: { wires: { color: string }[] } };
    bad.layout.wires[0]!.color = 'pink';
    expect(validateProject(bad as unknown as ProjectDocument).map((i) => i.code)).toContain(
      'bad_field',
    );
    expect(setWireColor(doc, 'W1', 'pink' as never).ok).toBe(false);
  });

  it('G. a node on both a + and a - source terminal is not coloured (neutral), and stays flagged', () => {
    // A second supply whose negative is tied to the first's positive... and to its own positive
    // through a wire: one node on PSU1+, PSU2+ and PSU2- (a shorted source).
    let doc = place(newDoc(), 'instrument.lab_psu', -120, 200).doc; // PSU2
    doc = wire(doc, ['PSU1', 'positive'], ['PSU2', 'positive']);
    doc = wire(doc, ['PSU2', 'positive'], ['PSU2', 'negative']);
    const colors = resolveWireColors(doc);
    const w = wireOf(doc, 'PSU2:positive', 'PSU2:negative');
    expect(colors.get(w.id)).toMatchObject({ color: null, source: 'conflict', hex: NEUTRAL_HEX });
    expect(color3d(doc, w.id)).toBe(NEUTRAL_HEX);
    // Two supplies' positives together, and nothing negative: still red.
    let two = place(newDoc(), 'instrument.lab_psu', -120, 200).doc;
    two = wire(two, ['PSU1', 'positive'], ['PSU2', 'positive']);
    expect(resolveWireColors(two).get(two.layout.wires.at(-1)!.id)!.color).toBe('red');
  });

  it('is deterministic and the same in 2D and 3D for every curated example', async () => {
    const { EXAMPLE_DOCUMENTS } = await import('../src/examples/documents.js');
    for (const [id, d] of Object.entries(EXAMPLE_DOCUMENTS)) {
      const a = resolveWireColors(d);
      expect(resolveWireColors(d), id).toEqual(a);
      for (const w of deriveScene(d).wires) expect(w.color, `${id} ${w.id}`).toBe(a.get(w.id)!.hex);
    }
  });
});
