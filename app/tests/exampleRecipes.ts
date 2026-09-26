/**
 * Authoring recipes for the six curated examples (Sprint 5).
 *
 * The SHIPPED examples are the JSON project documents in app/src/examples/data/. This file is
 * how they were made: each recipe builds its circuit through the ordinary domain editing
 * operations, exactly as a user would, so the result is a normal valid project. Regenerate with
 * `npx vite-node scripts/build-examples.ts`; tests/examples.test.ts checks that the committed
 * JSON still equals these recipes.
 */
import {
  addComponent,
  addWire,
  createProject,
  deleteSelection,
  moveSelection,
  rotateComponents,
  setParam,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
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
  set(id: string, key: string, value: number | boolean, unit?: 'ohm' | 'volt' | 'ampere') {
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
   * Sprint 6. Classic ESP32 running the prebuilt TbiGpioProof firmware: GPIO2 drives a red LED
   * through 220 Ω (blinking in an 800 ms pattern). The board GND is the circuit reference.
   */
  'esp32-blink': () => {
    const r = new Recipe('esp32-blink', 'ESP32: blink an LED');
    r.remove('PSU1', 'GND1');
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.choose(U1, 'firmware', '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af');
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
   * Sprint 6. Classic ESP32 running the prebuilt TbiBanks firmware, which copies GPIO34 to GPIO4.
   * A toggle switch (persistent) and a push button (transient) in parallel feed 3.3 V through
   * 1 kΩ into the input-only GPIO34, pulled down by 10 kΩ (the pad has no internal pull). GPIO4
   * drives a red LED through 220 Ω: switch closed or button held -> the firmware lights the LED.
   */
  'esp32-input-echo': () => {
    const r = new Recipe('esp32-input-echo', 'ESP32: switch input to LED output');
    r.supply(3.3, 0.05);
    const U1 = r.place('board.esp32_devkitc_wroom32', 300, 0);
    r.choose(U1, 'firmware', '9ca3a5cea66e46a2b54f14f38e0b065f36bc8cf70398cc88fae421028930a03d');
    const SW = r.place('component.toggle_switch', 0, -100);
    const PB = r.place('component.push_button', 0, -160);
    const R2 = r.place('component.resistor', 140, -100);
    const R3 = r.place('component.resistor', 200, -40, 1);
    const G2 = r.place('component.ground', 200, 60);
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
    r.wire({ kind: 'wire', wire: w, at: { x: 200, y: -100 } }, T(R3, 'a'));
    r.wire(T(R3, 'b'), T(G2, 'ref'));
    r.wire(T(U1, 'gpio4'), T(R1, 'a'));
    r.wire(T(R1, 'b'), T(D1, 'anode'));
    r.wire(T(D1, 'cathode'), T(G3, 'ref'));
    r.wire(T(U1, 'gnd'), T(G4, 'ref'));
    return r.centre(-240);
  },
};
