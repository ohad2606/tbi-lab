/**
 * Circuits whose parts are placed acceptably in 2D but whose real bodies are larger in 3D
 * (Sprint 10 owner review, visual-only separation). Shared by separation.test.ts and the
 * cross-view agreement test (semantics.test.ts).
 */
import {
  addWire,
  autoRouteVertices,
  rotateComponents,
  routeObstacles,
  terminalPosition,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { componentBoxes } from '../src/ui/routing.js';
import { place } from '../../packages/domain/tests/circuits.js';
import { must, newDoc } from '../../packages/domain/tests/helpers.js';

/** A wire as the editor draws it: auto-routed around the parts' 2D boxes. */
function wire(doc: ProjectDocument, a: [string, string], b: [string, string]): ProjectDocument {
  const pa = terminalPosition(doc, a[0], a[1])!;
  const pb = terminalPosition(doc, b[0], b[1])!;
  return must(
    addWire(
      doc,
      { kind: 'terminal', component: a[0], terminal: a[1] },
      { kind: 'terminal', component: b[0], terminal: b[1] },
      autoRouteVertices([pa, pb], routeObstacles(doc, componentBoxes(doc))),
    ),
  ).doc;
}

/**
 * The owner-review arrangement: an 8x8 LED matrix and a PIR module side by side, one grid step
 * apart in 2D (the symbols do not touch), wired up. In 3D the matrix is 32 x 32 mm and the PIR
 * board 32 x 24 mm: their bodies would cut ~7 mm into each other.
 */
export function pirMatrixCircuit(): ProjectDocument {
  let doc = place(newDoc(), 'display.led_matrix_8x8', 300, 0).doc; // DS1
  doc = place(doc, 'sensor.pir_hc_sr501', 460, 0).doc; // U1
  doc = place(doc, 'component.resistor', 300, 260).doc; // R1
  doc = wire(doc, ['PSU1', 'positive'], ['U1', 'vcc']);
  doc = wire(doc, ['U1', 'gnd'], ['GND1', 'ref']);
  doc = wire(doc, ['U1', 'out'], ['R1', 'a']);
  doc = wire(doc, ['R1', 'b'], ['DS1', 'c1']);
  doc = wire(doc, ['DS1', 'r1'], ['GND1', 'ref']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}

/** A PIR module beside the ESP32 board: clear in 2D, its 3D board would reach under the DevKit. */
export function esp32ModuleCircuit(): ProjectDocument {
  let doc = place(newDoc(), 'board.esp32_devkitc_wroom32', 400, 0).doc; // U1
  doc = place(doc, 'sensor.pir_hc_sr501', 260, 0).doc; // U2
  doc = wire(doc, ['U2', 'out'], ['U1', 'gpio4']);
  doc = wire(doc, ['U2', 'gnd'], ['U1', 'gnd']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}

/**
 * Ordinary close passives: resistors in rows two grid steps apart, an LED and a diode in line
 * with them one step beyond their leads. Nothing here may move.
 */
export function passivesCircuit(): ProjectDocument {
  let doc = newDoc();
  for (const y of [0, 40, 80]) doc = place(doc, 'component.resistor', 100, y).doc; // R1..R3
  doc = place(doc, 'component.led', 200, 0).doc; // D1
  doc = place(doc, 'component.diode', 200, 80).doc; // D2
  doc = place(doc, 'component.led', 200, 160).doc; // D3
  doc = place(doc, 'component.resistor', 100, 160).doc; // R4
  doc = wire(doc, ['PSU1', 'positive'], ['R1', 'a']);
  doc = wire(doc, ['R1', 'b'], ['D1', 'anode']);
  doc = wire(doc, ['D1', 'cathode'], ['GND1', 'ref']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}

/**
 * A direct contact whose bodies overlap: R2 stands across the end of R1, its lead on R1's lead
 * (the edit made the contact). Their footprints overlap by ~1.5 mm on both axes.
 */
export function contactOverlapCircuit(): ProjectDocument {
  let doc = place(newDoc(), 'component.resistor', 100, 200).doc; // R1
  doc = place(doc, 'component.resistor', 140, 240).doc; // R2
  doc = must(rotateComponents(doc, ['R2'])).doc; // R2.a on R1.b
  doc = wire(doc, ['PSU1', 'positive'], ['R1', 'a']);
  doc = wire(doc, ['R2', 'b'], ['GND1', 'ref']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}

/**
 * A dense mixed bench: the ESP32 with a PIR module and a relay close beside it, the LED matrix
 * next to a buzzer and an electrolytic capacitor, passives in tight rows. Every 2D symbol is
 * clear of the others; several real bodies are not.
 */
export function denseMixedCircuit(): ProjectDocument {
  let doc = place(newDoc(), 'board.esp32_devkitc_wroom32', 300, 0).doc; // U1
  doc = place(doc, 'sensor.pir_hc_sr501', 160, -120).doc; // U2
  doc = place(doc, 'component.relay', 460, -140).doc; // K1
  doc = place(doc, 'display.led_matrix_8x8', 640, 120).doc; // DS1
  doc = place(doc, 'component.buzzer', 780, -40).doc; // BZ1
  doc = place(doc, 'component.capacitor', 780, 60).doc; // C1
  for (const [x, y] of [
    [140, 60],
    [140, 100],
    [140, 140],
  ] as const)
    doc = place(doc, 'component.resistor', x, y).doc; // R1..R3
  doc = place(doc, 'component.led', 460, 120).doc; // D1
  doc = place(doc, 'component.led', 460, 200).doc; // D2
  doc = wire(doc, ['U2', 'out'], ['U1', 'gpio4']);
  doc = wire(doc, ['U2', 'gnd'], ['U1', 'gnd']);
  doc = wire(doc, ['R1', 'b'], ['U1', 'gpio16']);
  doc = wire(doc, ['K1', 'coil1'], ['U1', 'gpio17']);
  doc = wire(doc, ['D1', 'anode'], ['U1', 'gpio18']);
  doc = wire(doc, ['DS1', 'c1'], ['U1', 'gpio19']);
  doc = wire(doc, ['BZ1', 'positive'], ['U1', 'gpio21']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}

/**
 * The owner's relay -> LED case, as the editor draws it: a relay with an LED close beside it, the
 * relay's NO contact wired straight to the LED (auto-routed wires).
 */
export function relayLedCircuit(): ProjectDocument {
  let doc = place(newDoc(), 'component.relay', 300, 0).doc; // K1
  doc = place(doc, 'component.led', 420, 0).doc; // D1
  doc = wire(doc, ['K1', 'no'], ['D1', 'anode']);
  doc = wire(doc, ['D1', 'cathode'], ['GND1', 'ref']);
  doc = wire(doc, ['K1', 'com'], ['PSU1', 'positive']);
  doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
  return doc;
}
