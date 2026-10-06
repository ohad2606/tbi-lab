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
  setProgramText,
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
};
