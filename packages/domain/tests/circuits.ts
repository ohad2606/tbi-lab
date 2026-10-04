/**
 * Circuit fixtures built through the real editing operations (Sprint 9: shared by the domain
 * connectivity tests and the app's schematic and 3D view tests).
 */
import { addComponent, addWire, type ComponentTypeId, type ProjectDocument } from '../src/index.js';
import { must, newDoc } from './helpers.js';

export function place(doc: ProjectDocument, type: ComponentTypeId, x: number, y: number) {
  const r = must(addComponent(doc, type, { x, y }));
  return { doc: r.doc, id: r.id };
}
export function wire(doc: ProjectDocument, a: [string, string], b: [string, string]) {
  return must(
    addWire(
      doc,
      { kind: 'terminal', component: a[0], terminal: a[1] },
      { kind: 'terminal', component: b[0], terminal: b[1] },
    ),
  ).doc;
}

/**
 * ESP32 + button input (to the supply) and LED output, every part grounded separately: the
 * representative mixed circuit (ESP32, LED, resistors, push button, supply, ground).
 */
export function mixedCircuit() {
  let doc = newDoc();
  // A new project already holds its lab supply and a ground (PSU1, GND1).
  const ids: Record<string, string> = { psu: 'PSU1', g1: 'GND1' };
  for (const [k, type, x, y] of [
    ['u', 'board.esp32_devkitc_wroom32', 100, 0],
    ['sw', 'component.push_button', -240, -100],
    ['rin', 'component.resistor', -100, -100],
    ['rpd', 'component.resistor', -100, 40],
    ['g2', 'component.ground', -100, 140],
    ['rled', 'component.resistor', 300, 60],
    ['led', 'component.led', 420, 60],
    ['g3', 'component.ground', 500, 140],
    ['g4', 'component.ground', 260, -140],
  ] as const) {
    const r = place(doc, type, x, y);
    doc = r.doc;
    ids[k] = r.id;
  }
  doc = wire(doc, [ids.psu!, 'negative'], [ids.g1!, 'ref']);
  doc = wire(doc, [ids.psu!, 'positive'], [ids.sw!, 'a']);
  doc = wire(doc, [ids.sw!, 'b'], [ids.rin!, 'a']);
  doc = wire(doc, [ids.rin!, 'b'], [ids.u!, 'gpio34']);
  doc = wire(doc, [ids.rpd!, 'a'], [ids.u!, 'gpio34']);
  doc = wire(doc, [ids.rpd!, 'b'], [ids.g2!, 'ref']);
  doc = wire(doc, [ids.u!, 'gpio4'], [ids.rled!, 'a']);
  doc = wire(doc, [ids.rled!, 'b'], [ids.led!, 'anode']);
  doc = wire(doc, [ids.led!, 'cathode'], [ids.g3!, 'ref']);
  doc = wire(doc, [ids.u!, 'gnd'], [ids.g4!, 'ref']);
  return { doc, ids };
}
