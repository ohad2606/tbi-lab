/**
 * Evidence benches for the 3D realism pass (Sprint 10): fixed projects whose parts and cameras
 * stay the same from one capture to the next, so before/after renders compare like for like.
 * Built through the real editing operations (no hand-written documents).
 */
import {
  addComponent,
  addWire,
  type ComponentTypeId,
  type ProjectDocument,
} from '../../packages/domain/src/index.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';

function place(doc: ProjectDocument, type: ComponentTypeId, x: number, y: number, rotation = 0) {
  const r = must(addComponent(doc, type, { x, y }));
  if (rotation) r.doc.layout.components[r.id]!.rotation = rotation as 0 | 90 | 180 | 270;
  return { doc: r.doc, id: r.id };
}
function wire(doc: ProjectDocument, a: [string, string], b: [string, string]) {
  return must(
    addWire(
      doc,
      { kind: 'terminal', component: a[0], terminal: a[1] },
      { kind: 'terminal', component: b[0], terminal: b[1] },
    ),
  ).doc;
}

/**
 * The parts bench: supply -> toggle (closed) -> push button bypass -> 470 R -> red 5 mm LED ->
 * 1N4148 -> ground, and a resistor whose lead touches a second LED's anode directly (a direct
 * contact, powered as well). Running it lights both LEDs from their solved currents.
 */
export function partsBench(): ProjectDocument {
  let doc = newDoc();
  doc.name = 'Realism bench: parts';
  const ids: Record<string, string> = { psu: 'PSU1', g1: 'GND1' };
  doc.layout.components.PSU1 = { x: -260, y: 0, rotation: 0 };
  doc.layout.components.GND1 = { x: -220, y: 140, rotation: 0 };
  for (const [k, type, x, y, rot] of [
    ['sw', 'component.toggle_switch', -100, -80, 0],
    ['pb', 'component.push_button', -100, 60, 0],
    ['r', 'component.resistor', 40, -80, 0],
    ['led', 'component.led', 160, -20, 90],
    ['d', 'component.diode', 160, 120, 90],
    ['g2', 'component.ground', 160, 220, 0],
    ['rc', 'component.resistor', 40, 220, 0],
    ['ledc', 'component.led', 120, 220, 0],
  ] as const) {
    const r = place(doc, type, x, y, rot);
    doc = r.doc;
    ids[k] = r.id;
  }
  const sw = doc.components.find((c) => c.id === ids.sw)!;
  sw.params.closed = true;
  // 150 R and 220 R: the LEDs run near their datasheet test current (~16 mA and ~10 mA).
  doc.components.find((c) => c.id === ids.r)!.params.resistance = { value: 150, unit: 'ohm' };
  doc.components.find((c) => c.id === ids.rc)!.params.resistance = { value: 220, unit: 'ohm' };
  doc = wire(doc, [ids.psu!, 'negative'], [ids.g1!, 'ref']);
  doc = wire(doc, [ids.psu!, 'positive'], [ids.sw!, 'a']);
  doc = wire(doc, [ids.sw!, 'b'], [ids.r!, 'a']);
  doc = wire(doc, [ids.psu!, 'positive'], [ids.pb!, 'a']);
  doc = wire(doc, [ids.pb!, 'b'], [ids.r!, 'a']);
  doc = wire(doc, [ids.r!, 'b'], [ids.led!, 'anode']);
  doc = wire(doc, [ids.led!, 'cathode'], [ids.d!, 'anode']);
  doc = wire(doc, [ids.d!, 'cathode'], [ids.g2!, 'ref']);
  // The direct-contact pair, powered too (a floating part is refused by Run, correctly).
  doc = wire(doc, [ids.pb!, 'a'], [ids.rc!, 'a']);
  doc = wire(doc, [ids.ledc!, 'cathode'], [ids.g2!, 'ref']);
  return doc;
}
