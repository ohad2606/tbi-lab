/**
 * Sprint 24 (M2): a GPIO the program reads as an input, with nothing holding its level while a
 * switch is open (no pull resistor), is a non-blocking circuit-check warning. The simulator's
 * floating pad reads LOW through its input-leakage model (esp32Gpio.ts, a numerical reference,
 * not a characterised behaviour), so the warning says so; Arduino and MicroPython alike.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  checkCircuit,
  ESP32_MICROPYTHON_PROFILE,
  programInputPins,
  setParam,
  setProgramProfile,
  setProgramText,
  type ProgramSource,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const T = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});
const wire = (doc: ProjectDocument, a: string, b: string) => {
  const [ac, at] = a.split('.') as [string, string];
  const [bc, bt] = b.split('.') as [string, string];
  return must(addWire(doc, T(ac, at), T(bc, bt))).doc;
};
const py = (text: string): ProgramSource => ({
  language: 'micropython',
  profile: 'esp32-micropython-1.29',
  fileName: 'main.py',
  text,
});
const ino = (text: string): ProgramSource => ({
  language: 'arduino-cpp',
  profile: 'esp32-arduino-3.3.12',
  fileName: 'sketch.ino',
  text,
});

describe('programInputPins', () => {
  it('MicroPython: Pin(n, Pin.IN) with literals or simple constants', () => {
    expect(programInputPins(py('from machine import Pin\nb = Pin(34, Pin.IN)\n'))).toEqual([34]);
    expect(
      programInputPins(py('import machine\nBTN = 5\nb = machine.Pin(BTN, mode=machine.Pin.IN)\n')),
    ).toEqual([5]);
    expect(programInputPins(py('from machine import Pin\nled = Pin(2, Pin.OUT)\n'))).toEqual([]);
    // Comments and strings do not count.
    expect(programInputPins(py('# Pin(4, Pin.IN)\nprint("Pin(4, Pin.IN)")\n'))).toEqual([]);
    // A pin computed at run time is not found (the check may miss it; it never invents one).
    expect(programInputPins(py('from machine import Pin\nb = Pin(30 + 4, Pin.IN)\n'))).toEqual([]);
  });
  it('Arduino: pinMode(n, INPUT) and digitalRead(n), literals or simple constants', () => {
    expect(
      programInputPins(
        ino(
          'const int IN_PIN = 5;\n#define B 34\nvoid setup(){ pinMode(IN_PIN, INPUT); }\nvoid loop(){ digitalRead(B); }\n',
        ),
      ),
    ).toEqual([5, 34]);
    expect(programInputPins(ino('void setup(){ pinMode(4, INPUT_PULLUP); }'))).toEqual([]);
  });
  it('review M4: a pin with an internal pull, or an output read back, is not floating', () => {
    expect(
      programInputPins(
        ino('void setup(){ pinMode(4, INPUT_PULLUP); }\nvoid loop(){ digitalRead(4); }'),
      ),
    ).toEqual([]);
    expect(
      programInputPins(
        ino(
          'void setup(){ pinMode(2, OUTPUT); }\nvoid loop(){ digitalWrite(2, !digitalRead(2)); }',
        ),
      ),
    ).toEqual([]);
    expect(
      programInputPins(py('from machine import Pin\nb = Pin(4, Pin.IN, Pin.PULL_UP)\n')),
    ).toEqual([]);
    expect(
      programInputPins(
        py('from machine import Pin\nb = Pin(4, mode=Pin.IN, pull=Pin.PULL_DOWN)\n'),
      ),
    ).toEqual([]);
    expect(programInputPins(py('from machine import Pin\nb = Pin(4, Pin.IN, None)\n'))).toEqual([
      4,
    ]);
  });
});

/** ESP32 + bench supply: 3.3 V -> button -> 1 kΩ -> GPIO34, optionally a 10 kΩ pull-down. */
function circuit(
  program: (doc: ProjectDocument, board: string) => ProjectDocument,
  pullDown: boolean,
) {
  let doc = newDoc();
  doc = must(setParam(doc, 'PSU1', 'outputEnabled', true)).doc;
  doc = wire(doc, 'PSU1.negative', 'GND1.ref');
  const u = must(addComponent(doc, 'board.esp32_devkitc_wroom32', { x: 300, y: 0 }));
  doc = u.doc;
  const b = must(addComponent(doc, 'component.push_button', { x: 0, y: -100 }));
  doc = b.doc;
  const r1 = must(addComponent(doc, 'component.resistor', { x: 100, y: -100 }));
  doc = r1.doc;
  doc = wire(doc, 'PSU1.positive', `${b.id}.a`);
  doc = wire(doc, `${b.id}.b`, `${r1.id}.a`);
  doc = wire(doc, `${r1.id}.b`, `${u.id}.gpio34`);
  doc = wire(doc, `${u.id}.gnd`, 'GND1.ref');
  if (pullDown) {
    const r2 = must(addComponent(doc, 'component.resistor', { x: 160, y: 0 }));
    doc = r2.doc;
    doc = wire(doc, `${r2.id}.a`, `${u.id}.gpio34`);
    doc = wire(doc, `${r2.id}.b`, 'GND1.ref');
  }
  return { doc: program(doc, u.id), board: u.id, button: b.id };
}
const mpy = (src: string) => (doc: ProjectDocument, board: string) =>
  must(
    setProgramText(
      must(setProgramProfile(doc, board, ESP32_MICROPYTHON_PROFILE.id)).doc,
      board,
      src,
    ),
  ).doc;
const arduino = (src: string) => (doc: ProjectDocument, board: string) =>
  must(setProgramText(doc, board, src)).doc;
const floating = (doc: ProjectDocument) =>
  checkCircuit(doc).filter((i) => i.code === 'gpio_input_floating');

describe('gpio_input_floating (non-blocking warning)', () => {
  const READ_PY = 'from machine import Pin\nb = Pin(34, Pin.IN)\nprint(b.value())\n';
  const READ_INO = 'void setup(){ pinMode(34, INPUT); }\nvoid loop(){ digitalRead(34); }\n';

  it('a button with no pull resistor: warned, naming the board pin and the button', () => {
    for (const program of [mpy(READ_PY), arduino(READ_INO)]) {
      const { doc, board, button } = circuit(program, false);
      expect(floating(doc)).toEqual([
        {
          code: 'gpio_input_floating',
          severity: 'warning',
          components: [board, button],
          terminals: ['gpio34'],
        },
      ]);
    }
  });

  it('with the pull-down resistor: no warning (the shipped mpy-button and input-echo circuits)', () => {
    for (const program of [mpy(READ_PY), arduino(READ_INO)])
      expect(floating(circuit(program, true).doc)).toEqual([]);
  });

  it('a pin the program does not read as an input: no warning', () => {
    const { doc } = circuit(mpy('from machine import Pin\nled = Pin(2, Pin.OUT)\n'), false);
    expect(floating(doc)).toEqual([]);
  });
});
