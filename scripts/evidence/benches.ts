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

/**
 * A dense bench for performance: an ESP32 driving ten LEDs through ten resistors (each LED to its
 * own ground), plus six diodes and four push buttons placed beside them.
 */
export function denseBench(): ProjectDocument {
  let doc = newDoc();
  doc.name = 'Realism bench: dense';
  const u = place(doc, 'board.esp32_devkitc_wroom32', 0, 0);
  doc = u.doc;
  const pins = [23, 22, 21, 19, 18, 5, 17, 16, 4, 2];
  pins.forEach((gpio, i) => {
    const y = -180 + i * 40;
    const r = place(doc, 'component.resistor', 300, y);
    doc = r.doc;
    const d = place(doc, 'component.led', 440, y);
    doc = d.doc;
    const g = place(doc, 'component.ground', 520, y + 20);
    doc = g.doc;
    doc = wire(doc, [u.id, `gpio${gpio}`], [r.id, 'a']);
    doc = wire(doc, [r.id, 'b'], [d.id, 'anode']);
    doc = wire(doc, [d.id, 'cathode'], [g.id, 'ref']);
  });
  for (let i = 0; i < 6; i++) doc = place(doc, 'component.diode', -300, -160 + i * 60).doc;
  for (let i = 0; i < 4; i++) doc = place(doc, 'component.push_button', -460, -120 + i * 80).doc;
  return doc;
}

/**
 * The header bench (jumper exit geometry, Sprint 10): neighbouring wired pins on both ESP32
 * headers (three adjacent pins on J2 to resistors on the left, three on J3 to resistors on the
 * right) and one jumper from header to header across the board.
 */
export function headerBench(): ProjectDocument {
  let doc = newDoc();
  doc.name = 'Realism bench: header jumpers';
  // The new document's supply and ground, out of the board's way.
  doc.layout.components.PSU1 = { x: -260, y: 220, rotation: 0 };
  doc.layout.components.GND1 = { x: -140, y: 260, rotation: 0 };
  const u = place(doc, 'board.esp32_devkitc_wroom32', 0, 0);
  doc = u.doc;
  for (const [side, pins] of [
    [-1, [32, 33, 25]],
    [1, [19, 18, 5]],
  ] as const)
    pins.forEach((gpio, i) => {
      const r = place(doc, 'component.resistor', side * 260, -60 + i * 60);
      doc = r.doc;
      doc = wire(doc, [u.id, `gpio${gpio}`], [r.id, side < 0 ? 'b' : 'a']);
    });
  doc = wire(doc, [u.id, 'gpio26'], [u.id, 'gpio21']);
  return doc;
}
