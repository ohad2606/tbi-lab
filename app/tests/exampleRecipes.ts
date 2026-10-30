/**
 * Authoring recipes for the six curated examples (Sprint 5).
 *
 * The SHIPPED examples are the JSON project documents in app/src/examples/data/. This file is
 * how they were made: each recipe builds its circuit through the ordinary domain editing
 * operations, exactly as a user would, so the result is a normal valid project. Regenerate with
 * `npx vite-node scripts/build-examples.ts`; tests/examples.test.ts checks that the committed
 * JSON still equals these recipes.
 */
import { readFileSync } from 'node:fs';
import {
  addComponent,
  addWire,
  createProject,
  deleteSelection,
  moveSelection,
  rotateComponents,
  setParam,
  setProgramProfile,
  setProgramText,
  ESP32_MICROPYTHON_PROFILE,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
  type UnitId,
  type WireTarget,
} from '@tbi-lab/domain';

const T = (component: string, terminal: string): WireTarget => ({
  kind: 'terminal',
  component,
  terminal,
});

class Recipe {
  doc: ProjectDocument;
  constructor(id: string, name: string) {
    this.doc = createProject({
      projectId: `prj_example${id.replace(/[^a-z0-9]/gi, '')}`,
      deviceId: 'dev_tbilab_examples',
      name,
      appVersion: '0.2.0',
      clock: { now: () => new Date('2026-09-23T00:00:00.000Z') },
    });
  }
  private ok<R extends { ok: boolean }>(r: R): Extract<R, { ok: true }> {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as Extract<R, { ok: true }>;
  }
  place(type: ComponentTypeId, x: number, y: number, quarterTurns = 0): string {
    const r = this.ok(addComponent(this.doc, type, { x, y }));
    this.doc = r.doc;
    for (let i = 0; i < quarterTurns; i++)
      this.doc = this.ok(rotateComponents(this.doc, [r.id])).doc;
    return r.id;
  }
  wire(from: WireTarget, to: WireTarget, vertices: { x: number; y: number }[] = []): string {
    const r = this.ok(addWire(this.doc, from, to, vertices));
    this.doc = r.doc;
    return r.id;
  }
  set(id: string, key: string, value: number | boolean, unit?: UnitId) {
    const v: ParamValue = unit ? { value: value as number, unit } : (value as boolean);
    this.doc = this.ok(setParam(this.doc, id, key, v)).doc;
  }
  /** Move the whole drawing (every part, junction and wire bend) so it sits centred in view. */
  centre(dx: number) {
    const sel = {
      components: this.doc.components.map((c) => c.id),
      wires: this.doc.layout.wires.map((w) => w.id),
      junctions: this.doc.layout.junctions.map((j) => j.id),
    };
    this.doc = this.ok(moveSelection(this.doc, sel, { x: dx, y: 0 })).doc;
    return this.doc;
  }
  /** Set a language-neutral enum parameter (e.g. the firmware artifact identity). */
  choose(id: string, key: string, value: string) {
    this.doc = this.ok(setParam(this.doc, id, key, value)).doc;
  }
  /** The board's program: the Arduino/C++ source of a sketch in runtime/firmware/arduino (S7). */
  program(id: string, sketch: string) {
    const url = new URL(`../../runtime/firmware/arduino/${sketch}/${sketch}.ino`, import.meta.url);
    this.doc = this.ok(setProgramText(this.doc, id, readFileSync(url, 'utf8'))).doc;
  }
  /**
   * Sprint 12: the board's program from a sketch authored with the examples
   * (app/tests/exampleSketches): library-free Arduino/C++, Wire only for I2C.
   */
  sketch(id: string, file: string) {
    const url = new URL(`./exampleSketches/${file}`, import.meta.url);
    this.doc = this.ok(setProgramText(this.doc, id, readFileSync(url, 'utf8'))).doc;
  }
  /**
   * Sprint 24 (M1): the board's program in MicroPython (the genuine interpreter's main.py), from
   * a program authored with the examples (app/tests/exampleSketches/*.py).
   */
  python(id: string, file: string) {
    this.doc = this.ok(setProgramProfile(this.doc, id, ESP32_MICROPYTHON_PROFILE.id)).doc;
    const url = new URL(`./exampleSketches/${file}`, import.meta.url);
    this.doc = this.ok(setProgramText(this.doc, id, readFileSync(url, 'utf8'))).doc;
  }
  /** Remove parts placed with every new project (an ESP32 example may not need the supply). */
  remove(...ids: string[]) {
    this.doc = this.ok(
      deleteSelection(this.doc, { components: ids, wires: [], junctions: [] }),
    ).doc;
  }
  /** PSU setpoint/limit, output ON, and PSU- to the GND symbol placed with every project. */
  supply(volts: number, limit: number) {
    this.set('PSU1', 'setpointVoltage', volts, 'volt');
    this.set('PSU1', 'currentLimit', limit, 'ampere');
    this.set('PSU1', 'outputEnabled', true);
    this.wire(T('PSU1', 'negative'), T('GND1', 'ref'));
  }
  /** Sprint 12: one more bench supply (setpoint, limit, output ON); its own GND wiring is the caller's. */
  extraSupply(x: number, y: number, volts: number, limit: number): string {
    const id = this.place('instrument.lab_psu', x, y);
    this.set(id, 'setpointVoltage', volts, 'volt');
    this.set(id, 'currentLimit', limit, 'ampere');
    this.set(id, 'outputEnabled', true);
    return id;
  }
}

export const RECIPES: Record<string, () => ProjectDocument> = {
  /** 5 V across 1 kΩ: I = V / R = 5 mA. */
  'ohms-law': () => {
    const r = new Recipe('ohms-law', "Ohm's law");
    r.supply(5, 0.1);
    const R1 = r.place('component.resistor', 60, -20);
    r.set(R1, 'resistance', 1000, 'ohm');
    const G = r.place('component.ground', 180, 100);
    r.wire(T('PSU1', 'positive'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(G, 'ref'));
    return r.centre(-60);
  },
  /** 9 V over 10 kΩ + 20 kΩ: Vout = 9 V × 20 / 30 = 6 V, I = 0.3 mA. */
  'voltage-divider': () => {
    const r = new Recipe('voltage-divider', 'Voltage divider');
    r.supply(9, 0.1);
    const R1 = r.place('component.resistor', 60, -20);
    const R2 = r.place('component.resistor', 140, 40, 1);
    const G = r.place('component.ground', 140, 140);
    r.set(R1, 'resistance', 10_000, 'ohm');
    r.set(R2, 'resistance', 20_000, 'ohm');
    r.wire(T('PSU1', 'positive'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(R2, 'a'));
    r.wire(T(R2, 'b'), T(G, 'ref'));
    return r.centre(-60);
  },
  /** 5 V, 220 Ω, red LED: the LED settles near 2 V; the resistor sets about 14 mA. */
  'led-current': () => {
    const r = new Recipe('led-current', 'LED current limiting');
    r.supply(5, 0.1);
    const R1 = r.place('component.resistor', 60, -20);
    const D1 = r.place('component.led', 140, 40, 1);
    const G = r.place('component.ground', 140, 140);
    r.set(R1, 'resistance', 220, 'ohm');
    r.wire(T('PSU1', 'positive'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G, 'ref'));
    return r.centre(-60);
  },
  /**
   * Sprint 10: the three approved LED colour cards side by side. 5 V through 180 Ω each into a red
   * (TLHR5400), a yellow (TLHY5400) and a green (TLHG4900) LED: the same resistor sets a different
   * current because each colour has its own forward voltage (datasheet V_F at 20 mA: 2.0 V red,
   * 2.4 V yellow and green).
   */
  'led-colours': () => {
    const r = new Recipe('led-colours', 'LED colours');
    r.supply(5, 0.1);
    const branch = (i: number, model: string) => {
      const R = r.place('component.resistor', 60 + 160 * i, -20);
      const D = r.place('component.led', 140 + 160 * i, 40, 1);
      const G = r.place('component.ground', 140 + 160 * i, 140);
      r.set(R, 'resistance', 180, 'ohm');
      r.choose(D, 'model', model);
      r.wire(T(R, 'b'), T(D, 'anode'));
      r.wire(T(D, 'cathode'), T(G, 'ref'));
      return R;
    };
    const R1 = branch(0, 'model.led.vishay_tlhr5400');
    const R2 = branch(1, 'model.led.vishay_tlhy5400');
    const R3 = branch(2, 'model.led.vishay_tlhg4900');
    // One supply rail along y = -80, with a junction above each resistor (right to left, so
    // each split lands on the part of the rail still running from the supply).
    const rail = r.wire(T('PSU1', 'positive'), T(R3, 'a'), [
      { x: -40, y: -80 },
      { x: 340, y: -80 },
    ]);
    r.wire({ kind: 'wire', wire: rail, at: { x: 180, y: -80 } }, T(R2, 'a'));
    r.wire({ kind: 'wire', wire: rail, at: { x: 20, y: -80 } }, T(R1, 'a'));
    return r.centre(-200);
  },
  /**
   * Sprint 10. RGB LED (common cathode): each channel through its own toggle and resistor, so the
   * colour is what the switches let the circuit drive (red and green on: about 17 and 15 mA).
   */
  'rgb-mixer': () => {
    const r = new Recipe('rgb-mixer', 'RGB colour mixer');
    r.supply(5, 0.2);
    const ch = (y: number, ohms: number, closed: boolean) => {
      const S = r.place('component.toggle_switch', 140, y);
      const R = r.place('component.resistor', 260, y);
      r.set(R, 'resistance', ohms, 'ohm');
      r.set(S, 'closed', closed);
      r.wire(T(S, 'b'), T(R, 'a'));
      return { S, R };
    };
    const red = ch(-100, 180, true);
    const green = ch(0, 120, true);
    const blue = ch(100, 120, false);
    const D = r.place('component.rgb_led', 400, 0);
    const G = r.place('component.ground', 480, 100);
    r.wire(T(red.R, 'b'), T(D, 'red'), [
      { x: 320, y: -100 },
      { x: 320, y: -20 },
    ]);
    r.wire(T(green.R, 'b'), T(D, 'green'));
    r.wire(T(blue.R, 'b'), T(D, 'blue'), [
      { x: 320, y: 100 },
      { x: 320, y: 20 },
    ]);
    r.wire(T(D, 'cathode'), T(G, 'ref'), [{ x: 480, y: 0 }]);
    const rail = r.wire(T('PSU1', 'positive'), T(red.S, 'a'), [
      { x: 70, y: -20 },
      { x: 70, y: -100 },
    ]);
    const mid = r.wire({ kind: 'wire', wire: rail, at: { x: 70, y: -20 } }, T(green.S, 'a'), [
      { x: 70, y: 0 },
    ]);
    r.wire({ kind: 'wire', wire: mid, at: { x: 70, y: 0 } }, T(blue.S, 'a'), [{ x: 70, y: 100 }]);
    return r.centre(-200);
  },
  /**
   * Sprint 10. Photoresistor (GL5528) over 10 kΩ from 9 V: the divider voltage follows the light
   * (10 lx: R = 14.1 kΩ, 3.73 V; 100 lx: 3.55 kΩ, 6.64 V).
   */
  'light-sensor': () => {
    const r = new Recipe('light-sensor', 'Light sensor');
    r.supply(9, 0.1);
    const L = r.place('component.photoresistor', 140, -20);
    const R = r.place('component.resistor', 220, 40, 1);
    const G = r.place('component.ground', 220, 140);
    r.set(R, 'resistance', 10_000, 'ohm');
    r.set(L, 'illuminance', 10, 'lux');
    r.wire(T('PSU1', 'positive'), T(L, 'a'));
    r.wire(T(L, 'b'), T(R, 'a'));
    r.wire(T(R, 'b'), T(G, 'ref'));
    return r.centre(-100);
  },
  /**
   * Sprint 10. A push button energizes a relay coil (70 Ω, 71 mA at 5 V); its contacts switch a
   * separate load circuit: NC feeds a buzzer at rest, NO lights an LED while the coil is energized.
   */
  'relay-load': () => {
    const r = new Recipe('relay-load', 'Relay switching a load');
    r.supply(5, 0.3);
    const S = r.place('component.push_button', 140, -20);
    const K = r.place('component.relay', 360, 0);
    const G2 = r.place('component.ground', 300, 120);
    const R = r.place('component.resistor', 500, 0);
    const D = r.place('component.led', 580, 60, 1);
    const G4 = r.place('component.ground', 580, 160);
    const B = r.place('component.buzzer', 520, -100);
    const G5 = r.place('component.ground', 640, -20);
    r.set(R, 'resistance', 220, 'ohm');
    const feed = r.wire(T('PSU1', 'positive'), T(S, 'a'));
    r.wire(T(S, 'b'), T(K, 'coil1'));
    r.wire(T(K, 'coil2'), T(G2, 'ref'));
    // The contact side from the same supply, by its own route (a junction on the supply wire).
    r.wire({ kind: 'wire', wire: feed, at: { x: 70, y: -20 } }, T(K, 'com'), [
      { x: 70, y: 200 },
      { x: 380, y: 200 },
    ]);
    r.wire(T(K, 'no'), T(R, 'a'));
    r.wire(T(R, 'b'), T(D, 'anode'), [{ x: 580, y: 0 }]);
    r.wire(T(D, 'cathode'), T(G4, 'ref'));
    r.wire(T(K, 'nc'), T(B, 'positive'), [
      { x: 440, y: -20 },
      { x: 440, y: -100 },
    ]);
    r.wire(T(B, 'negative'), T(G5, 'ref'), [{ x: 640, y: -100 }]);
    return r.centre(-240);
  },
  /**
   * Sprint 10. Night light: 47 kΩ over a GL5528 photoresistor biases a 2N3904's base; the LED and
   * 220 Ω sit in its collector. In the dark the divider turns the transistor on (the LED lights);
   * in bright light the base falls below conduction and the LED goes out.
   */
  'night-light': () => {
    const r = new Recipe('night-light', 'Night light');
    r.supply(5, 0.1);
    const R1 = r.place('component.resistor', 160, 20, 1);
    const L = r.place('component.photoresistor', 160, 140, 1);
    const G2 = r.place('component.ground', 160, 240);
    const Q = r.place('component.bjt_npn', 280, 60);
    const G3 = r.place('component.ground', 300, 180);
    const D = r.place('component.led', 300, -60, 1);
    const R2 = r.place('component.resistor', 240, -140);
    r.set(R1, 'resistance', 47_000, 'ohm');
    r.set(R2, 'resistance', 220, 'ohm');
    r.set(L, 'illuminance', 5, 'lux');
    const feed = r.wire(T('PSU1', 'positive'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(L, 'a'));
    r.wire(T(L, 'b'), T(G2, 'ref'));
    r.wire(T(R1, 'b'), T(Q, 'base'));
    r.wire(T(Q, 'emitter'), T(G3, 'ref'));
    r.wire(T(D, 'cathode'), T(Q, 'collector'));
    r.wire({ kind: 'wire', wire: feed, at: { x: 100, y: -20 } }, T(R2, 'a'), [{ x: 100, y: -140 }]);
    r.wire(T(R2, 'b'), T(D, 'anode'), [{ x: 300, y: -140 }]);
    return r.centre(-120);
  },
  /**
   * Sprint 10. PIR alarm: an HC-SR501 drives a 2N3904 through 1 kΩ; the buzzer is the collector
   * load. Motion (the sensor's simulated environment) turns the transistor on and the buzzer sounds.
   */
  'pir-alarm': () => {
    const r = new Recipe('pir-alarm', 'PIR alarm');
    r.supply(5, 0.2);
    const U = r.place('sensor.pir_hc_sr501', 140, 60, 2);
    const G2 = r.place('component.ground', 220, 140);
    const R1 = r.place('component.resistor', 280, 60);
    const Q = r.place('component.bjt_npn', 380, 60);
    const G3 = r.place('component.ground', 400, 180);
    const B = r.place('component.buzzer', 400, -40, 1);
    r.set(R1, 'resistance', 1000, 'ohm');
    const feed = r.wire(T('PSU1', 'positive'), T(U, 'vcc'), [
      { x: 220, y: -20 },
      { x: 220, y: 40 },
    ]);
    r.wire(T(U, 'gnd'), T(G2, 'ref'), [{ x: 220, y: 80 }]);
    r.wire(T(U, 'out'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(Q, 'base'));
    r.wire(T(Q, 'emitter'), T(G3, 'ref'));
    r.wire(T(B, 'negative'), T(Q, 'collector'));
    r.wire({ kind: 'wire', wire: feed, at: { x: 120, y: -20 } }, T(B, 'positive'), [
      { x: 120, y: -80 },
    ]);
    return r.centre(-160);
  },
  /**
   * Sprint 10. LED matrix: columns 2 and 7 driven from 5 V through 220 Ω each; rows 2 and 7 to
   * GND through switches. A dot lights only where a driven column meets a grounded row (the
   * principle of row/column scanning); dots on one column share its resistor.
   */
  'led-matrix': () => {
    const r = new Recipe('led-matrix', 'LED matrix');
    r.supply(5, 0.2);
    // Pins (1088AS map): r2 = pin 14 and c7 = pin 15 on the rear edge, r7 = pin 2 and c2 = pin 3
    // on the front edge.
    const M = r.place('display.led_matrix_8x8', 420, 0);
    const S2 = r.place('component.toggle_switch', 460, -200);
    const S7 = r.place('component.toggle_switch', 280, 200);
    const G2 = r.place('component.ground', 540, -140);
    const G3 = r.place('component.ground', 200, 260);
    const Rc7 = r.place('component.resistor', 360, -200, 1);
    const Rc2 = r.place('component.resistor', 380, 220, 1);
    r.set(Rc7, 'resistance', 220, 'ohm');
    r.set(Rc2, 'resistance', 220, 'ohm');
    r.set(S2, 'closed', true);
    r.wire(T(M, 'r2'), T(S2, 'a'), [{ x: 380, y: -200 }]);
    r.wire(T(S2, 'b'), T(G2, 'ref'), [{ x: 540, y: -200 }]);
    r.wire(T(M, 'r7'), T(S7, 'b'), [{ x: 360, y: 200 }]);
    r.wire(T(S7, 'a'), T(G3, 'ref'), [{ x: 200, y: 200 }]);
    r.wire(T(Rc7, 'b'), T(M, 'c7'));
    r.wire(T(M, 'c2'), T(Rc2, 'a'));
    const rail = r.wire(T('PSU1', 'positive'), T(Rc7, 'a'), [
      { x: 100, y: -20 },
      { x: 100, y: -240 },
    ]);
    r.wire({ kind: 'wire', wire: rail, at: { x: 70, y: -20 } }, T(Rc2, 'b'), [
      { x: 70, y: 300 },
      { x: 380, y: 300 },
    ]);
    return r.centre(-240);
  },
  /**
   * Sprint 10 (time-stepped). RC fade: 9 V through a switch and 1 kΩ charges 2200 µF; an LED with
   * 470 Ω across the capacitor. Run with the switch closed: the LED fades in as C charges; open it:
   * C discharges through the LED, which fades out.
   */
  'rc-fade': () => {
    const r = new Recipe('rc-fade', 'RC fade');
    r.supply(9, 0.2);
    const S = r.place('component.toggle_switch', 140, -20);
    const R1 = r.place('component.resistor', 260, -20);
    const C = r.place('component.capacitor', 340, 40, 1);
    const G2 = r.place('component.ground', 340, 140);
    const R2 = r.place('component.resistor', 440, -20);
    const D = r.place('component.led', 520, 40, 1);
    const G3 = r.place('component.ground', 520, 140);
    r.set(R1, 'resistance', 1000, 'ohm');
    r.set(R2, 'resistance', 470, 'ohm');
    r.set(C, 'capacitance', 2200e-6, 'farad');
    r.set(S, 'closed', true);
    r.wire(T('PSU1', 'positive'), T(S, 'a'));
    r.wire(T(S, 'b'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(C, 'a'), [{ x: 300, y: 0 }]);
    r.wire(T(C, 'b'), T(G2, 'ref'));
    r.wire(T(R1, 'b'), T(R2, 'a'));
    r.wire(T(R2, 'b'), T(D, 'anode'), [{ x: 520, y: -20 }]);
    r.wire(T(D, 'cathode'), T(G3, 'ref'));
    return r.centre(-200);
  },
  /** Two identical 1 kΩ + 1N4148 branches; D1 forward conducts ~4.3 mA, D2 reversed blocks (nA). */
  'diode-polarity': () => {
    const r = new Recipe('diode-polarity', 'Diode polarity');
    r.supply(5, 0.1);
    const R1 = r.place('component.resistor', 60, -20);
    const D1 = r.place('component.diode', 180, -20);
    const G2 = r.place('component.ground', 260, 40);
    const R2 = r.place('component.resistor', 60, -180);
    const D2 = r.place('component.diode', 180, -180, 2); // reversed: cathode faces the supply
    const G3 = r.place('component.ground', 300, -100);
    r.set(R1, 'resistance', 1000, 'ohm');
    r.set(R2, 'resistance', 1000, 'ohm');
    const w = r.wire(T('PSU1', 'positive'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G2, 'ref'));
    r.wire({ kind: 'wire', wire: w, at: { x: -40, y: -20 } }, T(R2, 'a'), [{ x: -40, y: -180 }]);
    r.wire(T(R2, 'b'), T(D2, 'cathode'));
    r.wire(T(D2, 'anode'), T(G3, 'ref'));
    return r.centre(-60);
  },
  /** A normally-open button in series with 330 Ω and an LED: the LED lights only while held. */
  'push-button': () => {
    const r = new Recipe('push-button', 'Momentary push button');
    r.supply(5, 0.1);
    const SW = r.place('component.push_button', 0, -20);
    const R1 = r.place('component.resistor', 120, -20);
    const D1 = r.place('component.led', 200, 40, 1);
    const G = r.place('component.ground', 200, 140);
    r.set(R1, 'resistance', 330, 'ohm');
    r.wire(T('PSU1', 'positive'), T(SW, 'a'));
    r.wire(T(SW, 'b'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G, 'ref'));
    return r.centre(-60);
  },
  /**
   * 5 V / 100 mA supply. With SW1 open, 100 Ω draws 50 mA (CV). Closing SW1 adds 10 Ω in
   * parallel: 550 mA would be needed, so the supply limits at 100 mA and its voltage falls to
   * 0.1 A × (100 Ω ∥ 10 Ω) ≈ 0.909 V (CC), which is normal supply behaviour, not a fault.
   */
  'cc-mode': () => {
    const r = new Recipe('cc-mode', 'Current limit (CC mode)');
    r.supply(5, 0.1);
    const R1 = r.place('component.resistor', 20, 40, 1);
    const G2 = r.place('component.ground', 20, 140);
    const SW = r.place('component.toggle_switch', 100, -20);
    const R2 = r.place('component.resistor', 180, 40, 1);
    const G3 = r.place('component.ground', 180, 140);
    r.set(R1, 'resistance', 100, 'ohm');
    r.set(R2, 'resistance', 10, 'ohm');
    const w = r.wire(T('PSU1', 'positive'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(G2, 'ref'));
    r.wire({ kind: 'wire', wire: w, at: { x: 20, y: -20 } }, T(SW, 'a'));
    r.wire(T(SW, 'b'), T(R2, 'a'));
    r.wire(T(R2, 'b'), T(G3, 'ref'));
    return r.centre(-60);
  },
  /**
   * Sprint 6, Arduino source since Sprint 7. Classic ESP32 running the TbiGpioProof sketch
   * (visible, editable; Build then Run): GPIO2 drives a red LED through 220 Ω (blinking in an
   * 800 ms pattern). The board GND is the circuit reference.
   */
  'esp32-blink': () => {
    const r = new Recipe('esp32-blink', 'ESP32: blink an LED');
    r.remove('PSU1', 'GND1');
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.program(U1, 'TbiGpioProof');
    const R1 = r.place('component.resistor', 480, 100);
    const D1 = r.place('component.led', 600, 100);
    const G2 = r.place('component.ground', 680, 180);
    const G3 = r.place('component.ground', 440, -120);
    r.set(R1, 'resistance', 220, 'ohm');
    r.wire(T(U1, 'gpio2'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G2, 'ref'));
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    return r.centre(-240);
  },
  /**
   * Sprint 6, Arduino source since Sprint 7. Classic ESP32 running the TbiBanks sketch (visible,
   * editable; Build then Run), which copies GPIO34 to GPIO4.
   * A toggle switch (persistent) and a push button (transient) in parallel feed 3.3 V through
   * 1 kΩ into the input-only GPIO34, pulled down by 10 kΩ (the pad has no internal pull). GPIO4
   * drives a red LED through 220 Ω: switch closed or button held -> the firmware lights the LED.
   */
  'esp32-input-echo': () => {
    const r = new Recipe('esp32-input-echo', 'ESP32: switch input to LED output');
    r.supply(3.3, 0.05);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.program(U1, 'TbiBanks');
    const SW = r.place('component.toggle_switch', 0, -100);
    const PB = r.place('component.push_button', 0, -160);
    // The pull-down branch stands three grid steps clear of the J2 header row (Sprint 10: no
    // wire runs beside a header row).
    const R2 = r.place('component.resistor', 100, -100);
    const R3 = r.place('component.resistor', 160, -40, 1);
    const G2 = r.place('component.ground', 160, 60);
    const R1 = r.place('component.resistor', 480, 60);
    const D1 = r.place('component.led', 600, 60);
    const G3 = r.place('component.ground', 680, 140);
    const G4 = r.place('component.ground', 440, -120);
    r.set(R2, 'resistance', 1000, 'ohm');
    r.set(R3, 'resistance', 10_000, 'ohm');
    r.set(R1, 'resistance', 220, 'ohm');
    r.wire(T('PSU1', 'positive'), T(SW, 'a'));
    r.wire(T(SW, 'a'), T(PB, 'a'));
    r.wire(T(SW, 'b'), T(R2, 'a'));
    r.wire(T(PB, 'b'), T(R2, 'a'));
    const w = r.wire(T(R2, 'b'), T(U1, 'gpio34'));
    r.wire({ kind: 'wire', wire: w, at: { x: 160, y: -100 } }, T(R3, 'a'));
    r.wire(T(R3, 'b'), T(G2, 'ref'));
    r.wire(T(U1, 'gpio4'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'));
    r.wire(T(U1, 'gnd'), T(G4, 'ref'));
    return r.centre(-240);
  },
  /**
   * Sprint 10 (realism benchmark): the ESP32 input echo on a fuller bench, one scene with every
   * part family the 3D view is judged on. Same firmware (TbiBanks: GPIO34 copied to GPIO4) and
   * input chain as esp32-input-echo; GPIO4 drives the red LED through 220 Ω. Two indicators run
   * straight off the 3.3 V supply: a yellow LED behind a 1N4148 (3.3 V less ~0.7 V and ~2.3 V
   * over 33 Ω, about 7 mA) and a green LED through 68 Ω, its feed a long run across the bench.
   */
  'esp32-bench': () => {
    const r = new Recipe('esp32-bench', 'ESP32 bench: inputs and indicators');
    r.supply(3.3, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.program(U1, 'TbiBanks');
    const SW = r.place('component.toggle_switch', 0, -100);
    const PB = r.place('component.push_button', 0, -160);
    const R2 = r.place('component.resistor', 100, -100);
    const R3 = r.place('component.resistor', 160, -40, 1);
    const G2 = r.place('component.ground', 160, 60);
    const R1 = r.place('component.resistor', 480, 60);
    const D1 = r.place('component.led', 600, 60);
    const G3 = r.place('component.ground', 680, 140);
    const G4 = r.place('component.ground', 440, -120);
    // The supply-fed indicators below the board.
    const R4 = r.place('component.resistor', 0, 280);
    const D4 = r.place('component.diode', 120, 280);
    const D2 = r.place('component.led', 240, 280);
    // Its ground sits beyond the long feed: the two wires cross (not connected).
    const G5 = r.place('component.ground', 320, 460);
    const R5 = r.place('component.resistor', 480, 280);
    const D3 = r.place('component.led', 600, 280);
    const G6 = r.place('component.ground', 680, 360);
    r.set(R2, 'resistance', 1000, 'ohm');
    r.set(R3, 'resistance', 10_000, 'ohm');
    r.set(R1, 'resistance', 220, 'ohm');
    r.set(R4, 'resistance', 33, 'ohm');
    r.set(R5, 'resistance', 68, 'ohm');
    r.choose(D2, 'model', 'model.led.vishay_tlhy5400');
    r.choose(D3, 'model', 'model.led.vishay_tlhg4900');
    r.wire(T('PSU1', 'positive'), T(SW, 'a'));
    r.wire(T(SW, 'a'), T(PB, 'a'));
    r.wire(T(SW, 'b'), T(R2, 'a'));
    r.wire(T(PB, 'b'), T(R2, 'a'));
    const w = r.wire(T(R2, 'b'), T(U1, 'gpio34'));
    r.wire({ kind: 'wire', wire: w, at: { x: 160, y: -100 } }, T(R3, 'a'));
    r.wire(T(R3, 'b'), T(G2, 'ref'));
    r.wire(T(U1, 'gpio4'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'));
    r.wire(T(U1, 'gnd'), T(G4, 'ref'));
    // The long feed: down the left, along the front and up into the green branch; the yellow
    // branch taps it on the way down.
    const low = r.wire(T('PSU1', 'positive'), T(R5, 'a'), [
      { x: -60, y: 400 },
      { x: 420, y: 400 },
      { x: 420, y: 280 },
    ]);
    r.wire({ kind: 'wire', wire: low, at: { x: -60, y: 280 } }, T(R4, 'a'));
    r.wire(T(R4, 'b'), T(D4, 'anode'));
    r.wire(T(D4, 'cathode'), T(D2, 'anode'));
    r.wire(T(D2, 'cathode'), T(G5, 'ref'));
    r.wire(T(R5, 'b'), T(D3, 'anode'));
    r.wire(T(D3, 'cathode'), T(G6, 'ref'));
    return r.centre(-240);
  },
  /**
   * Sprint 11 (R1): a motion alarm through a relay — the Sprint 10 parts with the ESP32. Same
   * firmware as esp32-input-echo (TbiBanks: GPIO34 copied to GPIO4), so the build is a shared,
   * curated one. 5 V supply: the PIR (powered from >= 4.5 V) sends a 3.3 V level to GPIO34; GPIO4
   * drives a 2N3904 through 1 kΩ, which switches the relay coil (with a 1N4148 flyback diode);
   * the relay's contact switches an alarm LED (330 Ω) and the buzzer from 5 V. Click the sensor's
   * dome while running to put motion in front of it.
   */
  'esp32-motion-relay': () => {
    const r = new Recipe('esp32-motion-relay', 'ESP32: motion alarm through a relay');
    r.supply(5, 0.5);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.program(U1, 'TbiBanks');
    const PIR = r.place('sensor.pir_hc_sr501', 60, -100, 2);
    const G2 = r.place('component.ground', 120, -20);
    const RB = r.place('component.resistor', 460, 60);
    const Q1 = r.place('component.bjt_npn', 580, 60);
    const G3 = r.place('component.ground', 600, 160);
    const K1 = r.place('component.relay', 720, -60);
    const DF = r.place('component.diode', 620, -60, 3);
    const RL = r.place('component.resistor', 860, -60);
    const D2 = r.place('component.led', 980, -60);
    const G4 = r.place('component.ground', 1020, 0);
    const BZ = r.place('component.buzzer', 860, 80);
    const G5 = r.place('component.ground', 900, 200);
    const G6 = r.place('component.ground', 440, -120);
    r.set(RB, 'resistance', 1000, 'ohm');
    r.set(RL, 'resistance', 330, 'ohm');
    // Explicit bends: the supply runs clear of the sensor's own pins and of the board.
    r.wire(T('PSU1', 'positive'), T(PIR, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -160 },
      { x: 140, y: -160 },
      { x: 140, y: -120 },
    ]);
    r.wire(T(PIR, 'gnd'), T(G2, 'ref'));
    r.wire(T(PIR, 'out'), T(U1, 'gpio34'));
    r.wire(T(U1, 'gnd'), T(G6, 'ref'));
    r.wire(T(U1, 'gpio4'), T(RB, 'a'));
    r.wire(T(RB, 'b'), T(Q1, 'base'));
    r.wire(T(Q1, 'emitter'), T(G3, 'ref'));
    r.wire(T(Q1, 'collector'), T(K1, 'coil2'));
    // The 5 V rail to the coil runs above the board.
    r.wire(T('PSU1', 'positive'), T(K1, 'coil1'), [
      { x: -60, y: -20 },
      { x: -60, y: -240 },
      { x: 640, y: -240 },
      { x: 640, y: -80 },
    ]);
    r.wire(T(DF, 'cathode'), T(K1, 'coil1'));
    r.wire(T(DF, 'anode'), T(K1, 'coil2'));
    r.wire(T(K1, 'coil1'), T(K1, 'com'));
    r.wire(T(K1, 'no'), T(RL, 'a'));
    r.wire(T(RL, 'b'), T(D2, 'anode'));
    r.wire(T(D2, 'cathode'), T(G4, 'ref'));
    r.wire(T(K1, 'no'), T(BZ, 'positive'));
    r.wire(T(BZ, 'negative'), T(G5, 'ref'));
    return r.centre(-240);
  },
  /**
   * Sprint 11 (R1): an RGB night light with a light sensor — a digital input only (no ADC).
   * Same firmware as esp32-input-echo (TbiBanks: GPIO34 copied to GPIO4). 3.3 V supply: 10 kΩ
   * from 3.3 V to GPIO34 with the photoresistor to GND, so darkness pulls GPIO34 HIGH (below about
   * 3 lx; above about 110 lx it reads LOW; in between it keeps its previous level — the ESP32's
   * own input thresholds). GPIO4 lights all three channels (220/100/100 Ω): white.
   */
  'esp32-night-light': () => {
    const r = new Recipe('esp32-night-light', 'ESP32: RGB night light with a light sensor');
    r.supply(3.3, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.program(U1, 'TbiBanks');
    const R1 = r.place('component.resistor', 40, -100);
    const LDR = r.place('component.photoresistor', 80, -40, 1);
    const G2 = r.place('component.ground', 80, 60);
    const RR = r.place('component.resistor', 500, 20);
    const RG = r.place('component.resistor', 500, 80);
    const RB = r.place('component.resistor', 500, 140);
    const D1 = r.place('component.rgb_led', 640, 80);
    const G3 = r.place('component.ground', 680, 140);
    const G4 = r.place('component.ground', 440, -120);
    r.set(R1, 'resistance', 10_000, 'ohm');
    r.set(RR, 'resistance', 220, 'ohm');
    r.set(RG, 'resistance', 100, 'ohm');
    r.set(RB, 'resistance', 100, 'ohm');
    r.set(LDR, 'illuminance', 300, 'lux');
    r.wire(T('PSU1', 'positive'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(U1, 'gpio34'));
    r.wire(T(R1, 'b'), T(LDR, 'a'));
    r.wire(T(LDR, 'b'), T(G2, 'ref'));
    r.wire(T(U1, 'gnd'), T(G4, 'ref'));
    r.wire(T(U1, 'gpio4'), T(RR, 'a'));
    r.wire(T(U1, 'gpio4'), T(RG, 'a'));
    r.wire(T(U1, 'gpio4'), T(RB, 'a'));
    r.wire(T(RR, 'b'), T(D1, 'red'));
    r.wire(T(RG, 'b'), T(D1, 'green'));
    r.wire(T(RB, 'b'), T(D1, 'blue'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'));
    return r.centre(-240);
  },

  /**
   * Sprint 12 (R2): an ESP32 distance alarm with the HC-SR04. 5 V supply (0.1 A limit) to the
   * module; GPIO5 drives TRIG directly (3.3 V is above the module's 2.0 V TTL threshold); ECHO, a
   * 5 V output, reaches GPIO18 through a 1 kΩ / 2 kΩ divider (5 V × 2/3 = 3.3 V open-circuit,
   * within the pad's range); GPIO2 lights a red LED through 220 Ω when the target is nearer than
   * 20 cm. The target distance is the module's simulated environment (default 0.5 m).
   */
  'esp32-distance-alarm': () => {
    const r = new Recipe('esp32-distance-alarm', 'ESP32: ultrasonic distance alarm');
    r.supply(5, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'DistanceAlarm.ino');
    const US = r.place('sensor.hc_sr04', 680, 20);
    const R1 = r.place('component.resistor', 520, 20);
    const R2 = r.place('component.resistor', 480, 100, 1);
    const G2 = r.place('component.ground', 480, 200);
    const G3 = r.place('component.ground', 600, 120);
    const R3 = r.place('component.resistor', 520, 260);
    const D1 = r.place('component.led', 640, 260);
    const G4 = r.place('component.ground', 720, 340);
    const G5 = r.place('component.ground', 440, -120);
    r.set(R1, 'resistance', 1000, 'ohm');
    r.set(R2, 'resistance', 2000, 'ohm');
    r.set(R3, 'resistance', 220, 'ohm');
    // The 5 V feed runs above the board to the module's VCC.
    r.wire(T('PSU1', 'positive'), T(US, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -240 },
      { x: 580, y: -240 },
      { x: 580, y: -20 },
    ]);
    r.wire(T(US, 'gnd'), T(G3, 'ref'), [
      { x: 600, y: 40 },
      { x: 600, y: 100 },
    ]);
    r.wire(T(U1, 'gnd'), T(G5, 'ref'));
    r.wire(T(U1, 'gpio5'), T(US, 'trig'));
    r.wire(T(US, 'echo'), T(R1, 'b'));
    r.wire(T(R1, 'a'), T(R2, 'a'));
    r.wire(T(R2, 'b'), T(G2, 'ref'));
    r.wire(T(U1, 'gpio18'), T(R1, 'a'), [
      { x: 430, y: -20 },
      { x: 430, y: 20 },
    ]);
    r.wire(T(U1, 'gpio2'), T(R3, 'a'), [
      { x: 410, y: 100 },
      { x: 410, y: 260 },
    ]);
    r.wire(T(R3, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G4, 'ref'));
    return r.centre(-300);
  },
  /**
   * Sprint 12 (R2): an ESP32 thermo-hygrometer with the DHT22 / AM2302, read without a library.
   * 3.3 V supply (the sensor's minimum) to VDD; DATA to GPIO4 with the 10 kΩ pull-up to 3.3 V the
   * single-wire bus needs (the ESP32's internal pulls are not used); pin 3 (NC) left open. The
   * temperature and humidity are the sensor's simulated environment.
   */
  'esp32-thermo-hygrometer': () => {
    const r = new Recipe('esp32-thermo-hygrometer', 'ESP32: temperature and humidity');
    r.supply(3.3, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'ThermoHygrometer.ino');
    const DHT = r.place('sensor.dht22', 680, 80);
    const R1 = r.place('component.resistor', 520, 0, 1);
    const G2 = r.place('component.ground', 600, 200);
    const G3 = r.place('component.ground', 440, -120);
    r.set(R1, 'resistance', 10_000, 'ohm');
    // The 3.3 V feed runs above the board to the sensor's VDD; the pull-up taps it.
    const feed = r.wire(T('PSU1', 'positive'), T(DHT, 'vdd'), [
      { x: -40, y: -20 },
      { x: -40, y: -240 },
      { x: 580, y: -240 },
      { x: 580, y: 40 },
    ]);
    const data = r.wire(T(U1, 'gpio4'), T(DHT, 'data'));
    r.wire(T(R1, 'a'), { kind: 'wire', wire: feed, at: { x: 580, y: -40 } });
    r.wire(T(R1, 'b'), { kind: 'wire', wire: data, at: { x: 520, y: 60 } });
    r.wire(T(DHT, 'gnd'), T(G2, 'ref'), [
      { x: 600, y: 100 },
      { x: 600, y: 180 },
    ]);
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    return r.centre(-300);
  },
  /**
   * Sprint 12 (R3): "Hello" on the 16x2 I2C LCD, driven by raw Wire writes to its PCF8574
   * backpack (no LCD library). PSU1 at 4.5 V powers the module (its datasheet minimum): the
   * PCF8574 then reads SDA/SCL HIGH from 0.7 × 4.5 V = 3.15 V, which the 3.3 V pull-ups reach (at
   * 5 V they would not, and the simulator refuses it). PSU2 at 3.3 V feeds the two 4.7 kΩ bus
   * pull-ups (the backpack is modelled without its own). SDA = GPIO21, SCL = GPIO22; address 0x27.
   */
  'esp32-lcd-hello': () => {
    const r = new Recipe('esp32-lcd-hello', 'ESP32: hello on an I2C LCD');
    r.supply(4.5, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'LcdHello.ino');
    const LCD = r.place('display.lcd1602_i2c', 780, -80);
    const PSU2 = r.extraSupply(440, -320, 3.3, 0.1);
    const R1 = r.place('component.resistor', 540, -180, 1);
    const R2 = r.place('component.resistor', 620, -180, 1);
    const G2 = r.place('component.ground', 720, -200);
    const G3 = r.place('component.ground', 440, -200);
    const G4 = r.place('component.ground', 480, -220);
    r.set(R1, 'resistance', 4700, 'ohm');
    r.set(R2, 'resistance', 4700, 'ohm');
    // The 4.5 V module supply runs above everything to the LCD's VCC.
    r.wire(T('PSU1', 'positive'), T(LCD, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -400 },
      { x: 680, y: -400 },
      { x: 680, y: -100 },
    ]);
    r.wire(T(LCD, 'gnd'), T(G2, 'ref'), [
      { x: 690, y: -120 },
      { x: 690, y: -240 },
      { x: 720, y: -240 },
    ]);
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    // The bus: SDA and SCL swap order between the board and the backpack (one crossing).
    const sda = r.wire(T(U1, 'gpio21'), T(LCD, 'sda'));
    const scl = r.wire(T(U1, 'gpio22'), T(LCD, 'scl'), [
      { x: 480, y: -140 },
      { x: 480, y: -60 },
    ]);
    // The 3.3 V pull-ups from PSU2.
    r.wire(T(PSU2, 'negative'), T(G4, 'ref'));
    const rail = r.wire(T(PSU2, 'positive'), T(R2, 'a'), [{ x: 620, y: -340 }]);
    r.wire(T(R1, 'a'), { kind: 'wire', wire: rail, at: { x: 540, y: -340 } });
    r.wire(T(R1, 'b'), { kind: 'wire', wire: sda, at: { x: 540, y: -80 } });
    r.wire(T(R2, 'b'), { kind: 'wire', wire: scl, at: { x: 620, y: -60 } });
    return r.centre(-300);
  },
  /**
   * Sprint 15 (R4): an LED faded with PWM. analogWrite on GPIO18 (1 kHz LEDC), 220 Ω, red LED;
   * the fade runs between duty 1 and 255 (duty 0 driving a load is refused until its hardware
   * level is verified, O-R4-1). The board GND is the circuit reference.
   */
  'esp32-led-fade': () => {
    const r = new Recipe('esp32-led-fade', 'ESP32: fade an LED with PWM');
    r.remove('PSU1', 'GND1');
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'LedFade.ino');
    const R1 = r.place('component.resistor', 520, 20);
    const D1 = r.place('component.led', 640, 20);
    const G2 = r.place('component.ground', 720, 100);
    const G3 = r.place('component.ground', 440, -120);
    r.set(R1, 'resistance', 220, 'ohm');
    r.wire(T(U1, 'gpio18'), T(R1, 'a'), [
      { x: 430, y: -20 },
      { x: 430, y: 20 },
    ]);
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G2, 'ref'));
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    return r.centre(-300);
  },
  /**
   * Sprint 19B (Exploration Foundation X1): ESP32 GPIO18 (10 kΩ pull-down, Sprint 20) and a push
   * button (10 kΩ pull-down) into an SN74LVC1G08 AND gate powered at 3.0 V from the bench supply (where its output is
   * characterized for real loads); the gate drives an LED through 220 Ω and is read back on GPIO4.
   * Sprint 22 (owner decision Q1, strict): REFUSED in every state, by name
   * (logic_supply_current_uncharacterized, the supply's current limit): an ESP32 output is never at 5.5 V or exactly GND,
   * and the 10 kΩ pull-down leaves A ~50 mV off GND before setup() (SCES217AA §5.5 I_CC condition).
   * Kept unchanged as a documented limit (its text says so); no truth table is claimed.
   */
  'esp32-logic-and': () => {
    const r = new Recipe('esp32-logic-and', 'ESP32: an AND gate with read-back');
    r.supply(3, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'LogicAndReadback.ino');
    const U2 = r.place('logic.gate_and', 600, 0);
    const R1 = r.place('component.resistor', 720, 0);
    const D1 = r.place('component.led', 840, 0);
    const S1 = r.place('component.push_button', 500, 200);
    const R2 = r.place('component.resistor', 560, 120, 1);
    const G2 = r.place('component.ground', 600, 100);
    const G3 = r.place('component.ground', 920, 60);
    const G4 = r.place('component.ground', 560, 200);
    const G5 = r.place('component.ground', 440, -140);
    r.set(R1, 'resistance', 220, 'ohm');
    r.set(R2, 'resistance', 10_000, 'ohm');
    r.wire(T(U1, 'gnd'), T(G5, 'ref'));
    // The 3.0 V rail: over the board to the gate's V_CC, and down to the button.
    const rail = r.wire(T('PSU1', 'positive'), T(U2, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -260 },
      { x: 600, y: -260 },
    ]);
    r.wire(T(S1, 'a'), { kind: 'wire', wire: rail, at: { x: 460, y: -260 } });
    r.wire(T(U2, 'gnd'), T(G2, 'ref'));
    const a = r.wire(T(U1, 'gpio18'), T(U2, 'a'));
    // Sprint 20: a 10 kΩ pull-down on A (SCES217AA §7.3.3: "If a system does not always drive an
    // input, consider adding a pull-up or pull-down resistor … a 10kΩ resistor … is recommended").
    // Until setup() makes GPIO18 an output the pad is an input: without it A would float.
    // Drawn above the A wire (review round 2): below it, R3 sat on GPIO4's straight exit line.
    const R3 = r.place('component.resistor', 500, -80, 3);
    const G6 = r.place('component.ground', 580, -120);
    r.set(R3, 'resistance', 10_000, 'ohm');
    r.wire(T(R3, 'a'), { kind: 'wire', wire: a, at: { x: 500, y: -20 } });
    r.wire(T(R3, 'b'), T(G6, 'ref'), [{ x: 500, y: -140 }]);
    r.wire(T(S1, 'b'), T(R2, 'a'), [{ x: 540, y: 80 }]);
    r.wire(T(R2, 'a'), T(U2, 'b'), [{ x: 560, y: 20 }]);
    r.wire(T(R2, 'b'), T(G4, 'ref'));
    r.wire(T(U2, 'y'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'), [{ x: 920, y: 0 }]);
    r.wire(T(U1, 'gpio4'), T(R1, 'a'), [
      { x: 400, y: 60 },
      { x: 400, y: 300 },
      { x: 680, y: 300 },
    ]);
    return r.centre(-300);
  },
  /**
   * Exploration Foundation L3 interop: ESP32 GPIO18/GPIO19 into gate 1 of an SN74LVC08A (quad
   * 2-input AND, one shared supply) at 3.0 V from the bench supply, each input with a 10 kΩ
   * pull-down (Sprint 20: defined before setup() runs); 1Y lights D1 through 220 Ω and
   * feeds 2A; the push button (10 kΩ pull-down) drives 2B, so D2 (220 Ω) lights only while it is
   * held. The unused gates' inputs are tied to GND (SCAS283W: unused inputs at V_CC or GND).
   * Sprint 22 (owner decision Q1, strict): REFUSED in every state, by name
   * (logic_supply_current_uncharacterized, the supply's current limit): the SN74LVC08A bounds I_CC (and I_I) only at
   * V_CC = 3.6 V with every input at V_CC or GND (SCAS283W §5.7); here V_CC = 3.0 V.
   * Kept unchanged as a documented limit (its text says so); no truth table is claimed.
   */
  'esp32-logic-quad-and': () => {
    const r = new Recipe('esp32-logic-quad-and', 'ESP32: a quad AND gate IC driving LEDs');
    r.supply(3, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'LogicQuadAnd.ino');
    // Pins 1–7 at x = 700 (y −60…60), 14–8 at x = 820. Bends stay ≥ 120 units from the pin
    // columns: the breakout's header pins leave its board outward in 3D before they turn.
    const U2 = r.place('logic.quad_and', 760, 0);
    const R1 = r.place('component.resistor', 1100, -200);
    const D1 = r.place('component.led', 1240, -200);
    const R2 = r.place('component.resistor', 1100, 260);
    const D2 = r.place('component.led', 1240, 260);
    const S1 = r.place('component.push_button', 460, 320);
    const R3 = r.place('component.resistor', 640, 420, 1);
    const G2 = r.place('component.ground', 700, 140);
    const G3 = r.place('component.ground', 1320, -120);
    const G4 = r.place('component.ground', 640, 500);
    const G5 = r.place('component.ground', 440, -140);
    const G6 = r.place('component.ground', 1320, 340);
    const G7 = r.place('component.ground', 980, 120);
    r.set(R1, 'resistance', 220, 'ohm');
    r.set(R2, 'resistance', 220, 'ohm');
    r.set(R3, 'resistance', 10_000, 'ohm');
    r.wire(T(U1, 'gnd'), T(G5, 'ref'));
    // The 3.0 V rail: over the board to the IC's V_CC (pin 14), and down to the button.
    const rail = r.wire(T('PSU1', 'positive'), T(U2, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -280 },
      { x: 940, y: -280 },
      { x: 940, y: -60 },
    ]);
    r.wire(T(S1, 'a'), { kind: 'wire', wire: rail, at: { x: 420, y: -280 } }, [
      { x: 420, y: -280 },
    ]);
    r.wire(T(U2, 'gnd'), T(G2, 'ref'));
    // Gate 1 from the ESP32.
    const a1 = r.wire(T(U1, 'gpio18'), T(U2, 'a1'), [
      { x: 480, y: -20 },
      { x: 480, y: -60 },
    ]);
    const b1 = r.wire(T(U1, 'gpio19'), T(U2, 'b1'));
    // Sprint 20: 10 kΩ pull-downs on 1A and 1B. Until setup() makes GPIO18/19 outputs the pads
    // are inputs (high impedance): without them 1A/1B would float, which the datasheet forbids
    // (SCAS283W §5.4 note 1) and the simulator refuses. The value is TI's recommendation for a
    // not-always-driven CMOS input (SN74LVC1G08 sheet §7.3.3, "a 10kΩ resistor … is recommended").
    const R4 = r.place('component.resistor', 460, 60, 1);
    const R5 = r.place('component.resistor', 520, 60, 1);
    const G8 = r.place('component.ground', 460, 140);
    const G9 = r.place('component.ground', 520, 140);
    r.set(R4, 'resistance', 10_000, 'ohm');
    r.set(R5, 'resistance', 10_000, 'ohm');
    r.wire(T(R4, 'a'), { kind: 'wire', wire: a1, at: { x: 460, y: -20 } });
    r.wire(T(R5, 'a'), { kind: 'wire', wire: b1, at: { x: 520, y: -40 } });
    r.wire(T(R4, 'b'), T(G8, 'ref'));
    r.wire(T(R5, 'b'), T(G9, 'ref'));
    // 1Y → R1 → D1, and 1Y → 2A (a chain inside the package).
    const y1 = r.wire(T(U2, 'y1'), T(R1, 'a'), [
      { x: 580, y: -20 },
      { x: 580, y: -200 },
    ]);
    r.wire(T(U2, 'a2'), { kind: 'wire', wire: y1, at: { x: 580, y: -20 } }, [{ x: 580, y: 0 }]);
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'), [{ x: 1320, y: -200 }]);
    // 2B from the button with its 10 kΩ pull-down (R3).
    r.wire(T(S1, 'b'), T(R3, 'a'), [{ x: 640, y: 320 }]);
    r.wire(T(R3, 'a'), T(U2, 'b2'), [
      { x: 560, y: 380 },
      { x: 560, y: 20 },
    ]);
    r.wire(T(R3, 'b'), T(G4, 'ref'));
    // 2Y → R2 → D2.
    r.wire(T(U2, 'y2'), T(R2, 'a'), [
      { x: 540, y: 40 },
      { x: 540, y: 260 },
    ]);
    r.wire(T(R2, 'b'), T(D2, 'anode'));
    r.wire(T(D2, 'cathode'), T(G6, 'ref'), [{ x: 1320, y: 260 }]);
    // Unused gates 3 and 4: inputs to GND (their outputs stay open).
    const tie = r.wire(T(U2, 'b4'), T(G7, 'ref'), [{ x: 980, y: -40 }]);
    // From the ground end back: each split leaves `tie` as the part towards 4B.
    for (const [pin, y] of [
      ['a3', 40],
      ['b3', 20],
      ['a4', -20],
    ] as const)
      r.wire(T(U2, pin), { kind: 'wire', wire: tie, at: { x: 980, y } });
    return r.centre(-400);
  },
  /**
   * Sprint 20 example A (basic logic), redesigned in Sprint 22 (owner decision Q1, strict): an
   * SN74LVC1G08 AND gate at 3.0 V from PSU2 (the supply where its outputs are characterized for
   * real loads, SCES217AA §5.5); Y lights the LED through 220 Ω only when both switches are closed.
   * The gate's quiescent current I_CC is bounded only with every input at 5.5 V or GND (§5.5 I_CC,
   * "V_I = 5.5V or GND", V_CC 1.65–5.5 V), and the bench supply's current-limit check needs that
   * bound. So the switches take their HIGH from PSU1 set to 5.5 V (within the recommended V_I
   * 0–5.5 V, §5.3, at any V_CC), and each input's pull-down is 150 Ω: the input leakage
   * (I_I ±5 µA, §5.5) then moves an open input at most 0.75 mV from GND, inside the 1 mV the
   * simulator accepts as "at GND" (a 10 kΩ pull-down would move it 50 mV, off the I_CC condition).
   * A closed switch puts 5.5 V across its pull-down: 36.7 mA, 0.20 W (under the ¼ W rating).
   */
  'logic-and-switches': () => {
    const r = new Recipe('logic-and-switches', 'Logic: an AND gate with two switches');
    r.supply(5.5, 0.1);
    // Review round 2: the gate sits BELOW the input rows, so the readout the canvas draws under
    // a running part (its pin currents) crosses no other part or label.
    const SW1 = r.place('component.toggle_switch', 40, -200);
    const SW2 = r.place('component.toggle_switch', 40, -40);
    const R1 = r.place('component.resistor', 160, -160, 1);
    const R2 = r.place('component.resistor', 160, 0, 1);
    const G2 = r.place('component.ground', 160, -80);
    const G3 = r.place('component.ground', 160, 80);
    const U1 = r.place('logic.gate_and', 360, 100);
    const G4 = r.place('component.ground', 360, 220);
    const R3 = r.place('component.resistor', 480, 100);
    const D1 = r.place('component.led', 600, 100);
    const G5 = r.place('component.ground', 800, 180);
    // The gate's own 3.0 V supply, above the gate.
    const PSU2 = r.extraSupply(240, -320, 3, 0.1);
    // Right of PSU2's negative terminal, clear of its running readout (Sprint 22 acceptance).
    const G6 = r.place('component.ground', 300, -280);
    r.set(R1, 'resistance', 150, 'ohm');
    r.set(R2, 'resistance', 150, 'ohm');
    r.set(R3, 'resistance', 220, 'ohm');
    // A starts closed: toggling B alone switches the LED.
    r.set(SW1, 'closed', true);
    // The 5.5 V input rail (PSU1): up to switch A; switch B taps it.
    const rail = r.wire(T('PSU1', 'positive'), T(SW1, 'a'), [
      { x: -40, y: -20 },
      { x: -40, y: -200 },
    ]);
    r.wire(T(SW2, 'a'), { kind: 'wire', wire: rail, at: { x: -40, y: -40 } });
    // The 3.0 V gate supply (PSU2) to V_CC; its negative to GND.
    const vcc = r.wire(T(PSU2, 'positive'), T(U1, 'vcc'), [{ x: 360, y: -340 }]);
    r.wire(T(PSU2, 'negative'), T(G6, 'ref'));
    // Sprint 22 (owner decision Q10 (a)): a 10 kΩ bleeder across PSU2. The bench-supply model
    // cannot absorb current, and with Y LOW the inputs' leakage (±5 µA each, possibly returning
    // through the V_CC pin) could otherwise flow back into PSU2; the bleeder keeps PSU2 delivering
    // 3.0 V / 10 kΩ = 300 µA ≫ 10 µA (0.9 mW).
    // Right of the V_CC drop, clear of PSU2's running readout.
    const R4 = r.place('component.resistor', 440, -300);
    const G7 = r.place('component.ground', 520, -200);
    r.set(R4, 'resistance', 10_000, 'ohm');
    r.wire(T(R4, 'a'), { kind: 'wire', wire: vcc, at: { x: 360, y: -300 } });
    r.wire(T(R4, 'b'), T(G7, 'ref'), [{ x: 520, y: -300 }]);
    // Input A: SW1 → node (pull-down R1) → A.
    r.wire(T(SW1, 'b'), T(R1, 'a'));
    r.wire(T(R1, 'a'), T(U1, 'a'), [
      { x: 280, y: -200 },
      { x: 280, y: 80 },
    ]);
    r.wire(T(R1, 'b'), T(G2, 'ref'));
    // Input B: SW2 → node (pull-down R2) → B.
    r.wire(T(SW2, 'b'), T(R2, 'a'));
    r.wire(T(R2, 'a'), T(U1, 'b'), [
      { x: 240, y: -40 },
      { x: 240, y: 120 },
    ]);
    r.wire(T(R2, 'b'), T(G3, 'ref'));
    r.wire(T(U1, 'gnd'), T(G4, 'ref'));
    // Y → 220 Ω → LED → GND.
    r.wire(T(U1, 'y'), T(R3, 'a'));
    r.wire(T(R3, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G5, 'ref'), [{ x: 800, y: 100 }]);
    return r.centre(-240);
  },
  /**
   * Sprint 20 example B (cascaded gates): four switches with 10 kΩ pull-downs. Inside ONE
   * SN74LVC08A package, gate 1 forms A·B and feeds gate 2 (1Y → 2A), which forms (A·B)·C; across
   * packages, 2Y drives input A of an SN74LVC1G32 OR gate whose B is switch D (an override):
   * LED = (A·B·C) + D. Everything at 3.0 V; the package's outputs drive only gate inputs (no DC
   * load), the OR gate drives the LED. The unused gates 3 and 4 have their inputs tied to GND
   * (SCAS283W §5.4 note 1).
   * Sprint 22 (owner decision Q1, strict): REFUSED in every state, by name
   * (logic_supply_current_uncharacterized, the supply's current limit): at 3.0 V the SN74LVC08A's I_CC is unbounded
   * (SCAS283W §5.7: 3.6 V only), and the OR gate's input A is a gate output, never exactly at 5.5 V
   * or GND (SCES217AA §5.5) — a cascade cannot meet an I_CC test condition.
   * Kept unchanged as a documented limit (its text says so); no truth table is claimed.
   */
  'logic-cascade': () => {
    const r = new Recipe('logic-cascade', 'Logic: cascaded gates (A·B·C) + D');
    r.supply(3, 0.1);
    const rows = [-240, -80, 80, 240];
    const sw = rows.map((y) => r.place('component.toggle_switch', 40, y));
    const pd = rows.map((y) => r.place('component.resistor', 160, y + 40, 1));
    const pg = rows.map((y) => r.place('component.ground', 160, y + 120));
    for (const R of pd) r.set(R, 'resistance', 10_000, 'ohm');
    const U1 = r.place('logic.quad_and', 480, -80);
    const G6 = r.place('component.ground', 420, 40);
    const G7 = r.place('component.ground', 660, 20);
    const U2 = r.place('logic.gate_or', 780, 120);
    const G8 = r.place('component.ground', 780, 200);
    const R5 = r.place('component.resistor', 900, 120);
    const D1 = r.place('component.led', 980, 160, 1);
    const G9 = r.place('component.ground', 980, 240);
    r.set(R5, 'resistance', 220, 'ohm');
    // The 3.0 V rail along the top to the OR gate's V_CC; the package's V_CC (pin 14) taps it.
    const rail = r.wire(T('PSU1', 'positive'), T(U2, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -320 },
      { x: 780, y: -320 },
    ]);
    r.wire(T(U1, 'vcc'), { kind: 'wire', wire: rail, at: { x: 540, y: -320 } });
    r.wire(T(sw[0]!, 'a'), { kind: 'wire', wire: rail, at: { x: -40, y: -240 } });
    r.wire(T(sw[1]!, 'a'), { kind: 'wire', wire: rail, at: { x: -40, y: -80 } });
    const low = r.wire(T(sw[3]!, 'a'), { kind: 'wire', wire: rail, at: { x: -40, y: -20 } }, [
      { x: -40, y: 240 },
    ]);
    r.wire(T(sw[2]!, 'a'), { kind: 'wire', wire: low, at: { x: -40, y: 80 } });
    for (let i = 0; i < 4; i++) {
      r.wire(T(sw[i]!, 'b'), T(pd[i]!, 'a'));
      r.wire(T(pd[i]!, 'b'), T(pg[i]!, 'ref'));
    }
    // A → 1A, B → 1B, C → 2B; 1Y → 2A inside the package.
    r.wire(T(pd[0]!, 'a'), T(U1, 'a1'), [
      { x: 380, y: -240 },
      { x: 380, y: -140 },
    ]);
    r.wire(T(pd[1]!, 'a'), T(U1, 'b1'), [
      { x: 340, y: -80 },
      { x: 340, y: -120 },
    ]);
    r.wire(T(U1, 'y1'), T(U1, 'a2'), [
      { x: 380, y: -100 },
      { x: 380, y: -80 },
    ]);
    r.wire(T(pd[2]!, 'a'), T(U1, 'b2'), [
      { x: 360, y: 80 },
      { x: 360, y: -60 },
    ]);
    r.wire(T(U1, 'gnd'), T(G6, 'ref'));
    // Gates 3 and 4 unused: inputs to GND, outputs open. The tie column stays ≥ 120 units from
    // the pin column: the breakout's header pins leave its board outward in 3D before turning.
    const tie = r.wire(T(U1, 'b4'), T(G7, 'ref'), [{ x: 660, y: -120 }]);
    for (const [pin, y] of [
      ['a3', -40],
      ['b3', -60],
      ['a4', -100],
    ] as const)
      r.wire(T(U1, pin), { kind: 'wire', wire: tie, at: { x: 660, y } });
    // Across packages: 2Y → OR input A; switch D → OR input B.
    r.wire(T(U1, 'y2'), T(U2, 'a'), [
      { x: 380, y: -40 },
      { x: 380, y: 100 },
    ]);
    r.wire(T(pd[3]!, 'a'), T(U2, 'b'), [
      { x: 700, y: 240 },
      { x: 700, y: 140 },
    ]);
    r.wire(T(U2, 'gnd'), T(G8, 'ref'));
    r.wire(T(U2, 'y'), T(R5, 'a'));
    r.wire(T(R5, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G9, 'ref'));
    return r.centre(-320);
  },
  /**
   * Sprint 20 example D (ESP32, a manual input and logic together): an SN74LVC1G32 OR gate at
   * 3.0 V. Input A: ESP32 GPIO18 (10 kΩ pull-down, so A is defined before setup() runs); input
   * B: a toggle switch (10 kΩ pull-down), a manual override. Y lights the LED through 220 Ω and
   * is read back on GPIO19: the firmware blinks GPIO18 and reports what the gate's output really
   * is, including when the switch overrides it.
   * Sprint 22 (owner decision Q1, strict): REFUSED in every state, by name
   * (logic_supply_current_uncharacterized, the supply's current limit): an ESP32 output is never at 5.5 V or exactly GND,
   * and the 10 kΩ pull-downs leave an open input ~50 mV off GND (SCES217AA §5.5 I_CC condition).
   * Kept unchanged as a documented limit (its text says so); no truth table is claimed.
   */
  'esp32-logic-override': () => {
    const r = new Recipe('esp32-logic-override', 'ESP32: an OR gate with a manual override');
    r.supply(3, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'LogicOrOverride.ino');
    const U2 = r.place('logic.gate_or', 840, 0);
    const R1 = r.place('component.resistor', 960, 0);
    const D1 = r.place('component.led', 1080, 0);
    const R2 = r.place('component.resistor', 640, 100, 1);
    const R3 = r.place('component.resistor', 520, 40, 1);
    const SW1 = r.place('component.toggle_switch', 720, 120, 1);
    const G2 = r.place('component.ground', 840, 80);
    const G3 = r.place('component.ground', 1160, 60);
    const G4 = r.place('component.ground', 640, 180);
    const G5 = r.place('component.ground', 520, 120);
    // Well clear of the header (review round 2): the GND jumper drapes instead of necking up.
    const G6 = r.place('component.ground', 500, -80);
    r.set(R1, 'resistance', 220, 'ohm');
    r.set(R2, 'resistance', 10_000, 'ohm');
    r.set(R3, 'resistance', 10_000, 'ohm');
    r.wire(T(U1, 'gnd'), T(G6, 'ref'), [{ x: 500, y: -180 }]);
    // The 3.0 V rail: over the board to the gate's V_CC; under the board to the switch.
    r.wire(T('PSU1', 'positive'), T(U2, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -260 },
      { x: 840, y: -260 },
    ]);
    r.wire(T(SW1, 'b'), T('PSU1', 'positive'), [
      { x: 720, y: 260 },
      { x: -40, y: 260 },
      { x: -40, y: -20 },
    ]);
    // Input A from GPIO18, with its pull-down R3.
    const a = r.wire(T(U1, 'gpio18'), T(U2, 'a'));
    r.wire(T(R3, 'a'), { kind: 'wire', wire: a, at: { x: 520, y: -20 } });
    r.wire(T(R3, 'b'), T(G5, 'ref'));
    // Input B from the switch, with its pull-down R2.
    const b = r.wire(T(SW1, 'a'), T(U2, 'b'), [{ x: 720, y: 20 }]);
    r.wire(T(R2, 'a'), { kind: 'wire', wire: b, at: { x: 720, y: 60 } }, [{ x: 640, y: 60 }]);
    r.wire(T(R2, 'b'), T(G4, 'ref'));
    r.wire(T(U2, 'gnd'), T(G2, 'ref'));
    // Y → 220 Ω → LED → GND, and read back on GPIO19.
    const y = r.wire(T(U2, 'y'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'), [{ x: 1160, y: 0 }]);
    r.wire(T(U1, 'gpio19'), { kind: 'wire', wire: y, at: { x: 900, y: 0 } }, [
      { x: 420, y: -40 },
      { x: 420, y: -120 },
      { x: 900, y: -120 },
    ]);
    return r.centre(-400);
  },
  /**
   * Sprint 24 (M1): MicroPython examples on the same circuits as their Arduino twins. Blink: GPIO2
   * drives a red LED through 220 Ω (as esp32-blink), on 500 ms, off 500 ms.
   */
  'mpy-blink': () => {
    const r = new Recipe('mpy-blink', 'MicroPython: blink an LED');
    r.remove('PSU1', 'GND1');
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.python(U1, 'mpy_blink.py');
    const R1 = r.place('component.resistor', 480, 100);
    const D1 = r.place('component.led', 600, 100);
    const G2 = r.place('component.ground', 680, 180);
    const G3 = r.place('component.ground', 440, -120);
    r.set(R1, 'resistance', 220, 'ohm');
    r.wire(T(U1, 'gpio2'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G2, 'ref'));
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    return r.centre(-240);
  },
  /**
   * Sprint 24 (M1/M2): a push button read with Pin.IN lights an LED. The input chain of
   * esp32-input-echo without its toggle switch: 3.3 V -> button -> 1 kΩ -> GPIO34 (input only, no
   * internal pull) with a 10 kΩ pull-down to GND; GPIO4 drives a red LED through 220 Ω.
   */
  'mpy-button': () => {
    const r = new Recipe('mpy-button', 'MicroPython: a button lights an LED');
    r.supply(3.3, 0.05);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.python(U1, 'mpy_button.py');
    const PB = r.place('component.push_button', 0, -100);
    const R2 = r.place('component.resistor', 100, -100);
    const R3 = r.place('component.resistor', 160, -40, 1);
    const G2 = r.place('component.ground', 160, 60);
    const R1 = r.place('component.resistor', 480, 60);
    const D1 = r.place('component.led', 600, 60);
    const G3 = r.place('component.ground', 680, 140);
    const G4 = r.place('component.ground', 440, -120);
    r.set(R2, 'resistance', 1000, 'ohm');
    r.set(R3, 'resistance', 10_000, 'ohm');
    r.set(R1, 'resistance', 220, 'ohm');
    r.wire(T('PSU1', 'positive'), T(PB, 'a'));
    r.wire(T(PB, 'b'), T(R2, 'a'));
    const w = r.wire(T(R2, 'b'), T(U1, 'gpio34'));
    r.wire({ kind: 'wire', wire: w, at: { x: 160, y: -100 } }, T(R3, 'a'));
    r.wire(T(R3, 'b'), T(G2, 'ref'));
    r.wire(T(U1, 'gpio4'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'));
    r.wire(T(U1, 'gnd'), T(G4, 'ref'));
    return r.centre(-240);
  },
  /**
   * Sprint 24 (M1): an LED faded with PWM from MicroPython (machine.PWM, 1 kHz, duty_u16 2048 to
   * 63488 and back, never 0), on the circuit of esp32-led-fade: GPIO18, 220 Ω, red LED.
   */
  'mpy-fade': () => {
    const r = new Recipe('mpy-fade', 'MicroPython: fade an LED with PWM');
    r.remove('PSU1', 'GND1');
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.python(U1, 'mpy_fade.py');
    const R1 = r.place('component.resistor', 520, 20);
    const D1 = r.place('component.led', 640, 20);
    const G2 = r.place('component.ground', 720, 100);
    const G3 = r.place('component.ground', 440, -120);
    r.set(R1, 'resistance', 220, 'ohm');
    r.wire(T(U1, 'gpio18'), T(R1, 'a'), [
      { x: 430, y: -20 },
      { x: 430, y: 20 },
    ]);
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G2, 'ref'));
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    return r.centre(-300);
  },
  /**
   * Sprint 24 (M3): "Hello" on the 16x2 I2C LCD from MicroPython: hardware machine.I2C bus 0
   * (SCL GPIO22, SDA GPIO21, freq=100000, the PCF8574's rated clock) and a small pure-Python
   * HD44780-over-PCF8574 driver in main.py. The circuit of esp32-lcd-hello: PSU1 4.5 V powers the
   * module, PSU2 3.3 V feeds the two 4.7 kΩ bus pull-ups; address 0x27.
   */
  'mpy-lcd-hello': () => {
    const r = new Recipe('mpy-lcd-hello', 'MicroPython: hello on an I2C LCD');
    r.supply(4.5, 0.1);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.python(U1, 'mpy_lcd_hello.py');
    const LCD = r.place('display.lcd1602_i2c', 780, -80);
    const PSU2 = r.extraSupply(440, -320, 3.3, 0.1);
    const R1 = r.place('component.resistor', 540, -180, 1);
    const R2 = r.place('component.resistor', 620, -180, 1);
    const G2 = r.place('component.ground', 720, -200);
    const G3 = r.place('component.ground', 440, -200);
    const G4 = r.place('component.ground', 480, -220);
    r.set(R1, 'resistance', 4700, 'ohm');
    r.set(R2, 'resistance', 4700, 'ohm');
    r.wire(T('PSU1', 'positive'), T(LCD, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -400 },
      { x: 680, y: -400 },
      { x: 680, y: -100 },
    ]);
    r.wire(T(LCD, 'gnd'), T(G2, 'ref'), [
      { x: 690, y: -120 },
      { x: 690, y: -240 },
      { x: 720, y: -240 },
    ]);
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    const sda = r.wire(T(U1, 'gpio21'), T(LCD, 'sda'));
    const scl = r.wire(T(U1, 'gpio22'), T(LCD, 'scl'), [
      { x: 480, y: -140 },
      { x: 480, y: -60 },
    ]);
    r.wire(T(PSU2, 'negative'), T(G4, 'ref'));
    const rail = r.wire(T(PSU2, 'positive'), T(R2, 'a'), [{ x: 620, y: -340 }]);
    r.wire(T(R1, 'a'), { kind: 'wire', wire: rail, at: { x: 540, y: -340 } });
    r.wire(T(R1, 'b'), { kind: 'wire', wire: sda, at: { x: 540, y: -80 } });
    r.wire(T(R2, 'b'), { kind: 'wire', wire: scl, at: { x: 620, y: -60 } });
    return r.centre(-300);
  },
  /**
   * Sprint 15 (R4): an SG90 servo swept by LEDC PWM (50 Hz, 16 bit) on GPIO18: 1.0, 2.0 and 1.5 ms
   * pulses, one second each. The servo runs from the 5 V bench supply; ground shared with the board.
   */
  'esp32-servo-sweep': () => {
    const r = new Recipe('esp32-servo-sweep', 'ESP32: sweep a servo with PWM');
    r.supply(5, 0.5);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.sketch(U1, 'ServoSweep.ino');
    const M1 = r.place('component.servo_sg90', 640, 40);
    const G2 = r.place('component.ground', 560, 140);
    const G3 = r.place('component.ground', 440, -120);
    r.wire(T('PSU1', 'positive'), T(M1, 'vcc'), [
      { x: -40, y: -20 },
      { x: -40, y: -240 },
      { x: 540, y: -240 },
      { x: 540, y: 40 },
    ]);
    r.wire(T(M1, 'gnd'), T(G2, 'ref'), [{ x: 560, y: 20 }]);
    r.wire(T(U1, 'gpio18'), T(M1, 'signal'), [
      { x: 430, y: -20 },
      { x: 430, y: 60 },
    ]);
    r.wire(T(U1, 'gnd'), T(G3, 'ref'));
    return r.centre(-300);
  },
};
