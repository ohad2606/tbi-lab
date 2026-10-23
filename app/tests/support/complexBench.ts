/**
 * The wire routing integrity "complex bench" (rt2): the owner's PSU + AND gate circuit plus a NAND
 * and an OR gate, a resistor and an LED, nine automatic wires. Shared by the integrity suite and
 * the s20r 3D invariants (the rt2 random-move sweep recipe).
 */
import { addComponent, type Point, type ProjectDocument, type WireTarget } from '@tbi-lab/domain';
import { draw, normalize, ownerCircuit } from './wireScenario.js';

const T = (component: string, terminal: string): WireTarget => ({
  kind: 'terminal',
  component,
  terminal,
});
const place = (doc: ProjectDocument, type: Parameters<typeof addComponent>[1], at: Point) => {
  const r = addComponent(doc, type, at);
  if (!r.ok) throw new Error(r.error);
  return { doc: normalize(r.doc), id: r.id };
};

/** A complex bench: three gates, a resistor and an LED, nine wires (all automatic). */
export function complexBench(): { doc: ProjectDocument; gates: string[] } {
  const owner = ownerCircuit();
  let doc = owner.doc;
  const gate = owner.gate;
  const g2 = place(doc, 'logic.gate_nand', { x: 360, y: 0 });
  doc = g2.doc;
  const g3 = place(doc, 'logic.gate_or', { x: 360, y: 240 });
  doc = g3.doc;
  const r = place(doc, 'component.resistor', { x: 600, y: 0 });
  doc = r.doc;
  const d = place(doc, 'component.led', { x: 600, y: 240 });
  doc = d.doc;
  doc = draw(doc, T('PSU1', 'positive'), T(g2.id, 'vcc'));
  doc = draw(doc, T(g2.id, 'gnd'), T('GND1', 'ref'));
  doc = draw(doc, T('PSU1', 'positive'), T(g3.id, 'vcc'));
  doc = draw(doc, T(g3.id, 'gnd'), T('GND1', 'ref'));
  doc = draw(doc, T(gate, 'y'), T(g2.id, 'a'));
  doc = draw(doc, T(g2.id, 'y'), T(r.id, 'a'));
  doc = draw(doc, T(r.id, 'b'), T(d.id, 'anode'));
  doc = draw(doc, T(d.id, 'cathode'), T('GND1', 'ref'));
  return { doc, gates: [gate, g2.id, g3.id] };
}
