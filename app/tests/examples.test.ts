/**
 * Sprint 5 A10/A11: the six curated examples are valid product data, reproducible from their
 * recipes, and their engineering results are the production engine's (checked here against
 * independent hand calculations where the circuit is linear).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  checkCircuit,
  createSnapshot,
  setParam,
  validateProject,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EngineSession, ratingWarnings, type SolveSuccess } from '@tbi-lab/engine';
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../src/examples/documents.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { RECIPES } from './exampleRecipes.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';

const REL = 1e-9;
const solve = (doc: ProjectDocument): SolveSuccess => {
  const o = new EngineSession(createSnapshot(doc)).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const near = (a: number | null | undefined, e: number, rel = REL) => {
  expect(a).not.toBeNull();
  expect(Math.abs((a as number) - e)).toBeLessThanOrEqual(Math.abs(e) * rel + 1e-15);
};
const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.document;

describe('the example set', () => {
  it('has the eighteen local examples and the thirteen ESP32 examples, each titled in English and Hebrew', () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual([
      'ohms-law',
      'voltage-divider',
      'led-current',
      'led-colours',
      'rgb-mixer',
      'light-sensor',
      'night-light',
      'pir-alarm',
      'led-matrix',
      'rc-fade',
      'relay-load',
      'diode-polarity',
      'push-button',
      'cc-mode',
      // Sprint POT-UNITS: the potentiometer.
      'pot-divider',
      'pot-led-dimmer',
      'esp32-blink',
      'esp32-input-echo',
      'esp32-bench',
      'esp32-motion-relay',
      'esp32-night-light',
      'esp32-distance-alarm',
      'esp32-thermo-hygrometer',
      'esp32-lcd-hello',
      'esp32-led-fade',
      'esp32-servo-sweep',
      // Sprint 19B (Exploration Foundation X1).
      'esp32-logic-and',
      // Exploration Foundation L3 interop.
      'esp32-logic-quad-and',
      // Sprint 20 logic examples.
      'logic-and-switches',
      'logic-cascade',
      'esp32-logic-override',
    ]);
    for (const e of EXAMPLES) {
      for (const key of [e.titleKey, e.summaryKey]) {
        expect(en[key]).toBeTruthy();
        expect(he[key]).toBeTruthy();
        expect(he[key]).not.toBe(en[key]);
      }
    }
  });

  it('every example is a valid project with no circuit-check issue, using only V1 parts', () => {
    for (const e of EXAMPLES) {
      expect(validateProject(e.document), e.id).toEqual([]);
      expect(checkCircuit(e.document), e.id).toEqual([]);
      for (const c of e.document.components) expect(CATALOG[c.type], e.id).toBeDefined();
      // Suggested probes point at parts and terminals that exist.
      for (const p of e.probes) {
        const c = e.document.components.find((x) => x.id === p.component);
        expect(c, `${e.id} ${p.component}`).toBeDefined();
        if (p.kind === 'terminal') {
          expect(CATALOG[c!.type].terminals.some((t) => t.id === p.terminal)).toBe(true);
        }
      }
    }
  });

  it('the committed JSON is exactly what the recipes produce (reproducible product data)', () => {
    for (const [id, build] of Object.entries(RECIPES)) {
      const file = readFileSync(
        new URL(`../src/examples/data/${id}.json`, import.meta.url),
        'utf8',
      );
      expect(file, id).toBe(`${JSON.stringify(build(), null, 2)}\n`);
    }
  });

  it('carries no runtime state (no pressed button, no results, no probes)', () => {
    for (const e of EXAMPLES) {
      const text = JSON.stringify(e.document);
      for (const word of ['pressed', 'probe', 'result', 'outcome'])
        expect(text).not.toContain(word);
    }
  });
});

describe('expected engineering results (production engine)', () => {
  it("Ohm's law: 5 V / 1 kΩ = 5 mA, CV", () => {
    const r = solve(example('ohms-law'));
    near(r.components.R1!.current, 5e-3);
    expect(r.components.PSU1!.mode).toBe('cv');
  });

  it('voltage divider: 9 V × 20k / 30k = 6 V at R2.a; 0.3 mA', () => {
    const r = solve(example('voltage-divider'));
    near(r.components.R2!.terminals.a, 6);
    near(r.components.R1!.current, 0.3e-3);
  });

  it('LED current limiting: nonlinear operating point 1.982 V, 13.72 mA', () => {
    const r = solve(example('led-current'));
    near(r.components.D1!.voltage, 1.9816, 1e-4);
    near(r.components.D1!.current, 13.72e-3, 1e-3);
    // KVL: resistor drop + LED voltage = 5 V exactly (solver verification).
    near(r.components.R1!.voltage! + r.components.D1!.voltage!, 5);
  });

  it('RGB mixer (Sprint 10): red and green switched on, blue off; each channel its own current', () => {
    const doc = example('rgb-mixer');
    const r = solve(doc);
    const i = r.components.D1!.currents!;
    // KVL per channel: supply = resistor drop + that channel's forward voltage.
    for (const [ch, res] of [
      ['red', 'R1'],
      ['green', 'R2'],
    ] as const) {
      near(r.components[res]!.current, i[ch]!);
      expect(i[ch]!).toBeGreaterThan(0.012);
      expect(i[ch]!).toBeLessThan(0.02);
    }
    expect(Math.abs(i.blue!)).toBeLessThan(1e-9);
    expect(r.components.D1!.outsideModelRange).toBe(false);
    // Flipping the blue switch (a live control) adds the third channel.
    const all = solve({
      ...doc,
      components: doc.components.map((c) =>
        c.id === 'SW3' ? { ...c, params: { ...c.params, closed: true } } : c,
      ),
    });
    expect(all.components.D1!.currents!.blue).toBeGreaterThan(0.012);
  });

  it('light sensor (Sprint 10): 9 V x 10k / (10k + R_LDR(10 lx) = 14.14k) = 3.728 V', () => {
    const r = solve(example('light-sensor'));
    near(r.components.R1!.terminals.a, (9 * 10e3) / (10e3 + Math.sqrt(2e8)), 1e-9);
    expect(r.components.LDR1!.outsideModelRange).toBe(false);
  });

  it('night light (Sprint 10): dark (5 lx) lights the LED through the 2N3904; bright (100 lx) does not', () => {
    const doc = example('night-light');
    const dark = solve(doc);
    // 5 lx: the divider puts the 2N3904 well into conduction (forward active, about 9 mA).
    expect(dark.components.Q1!.state!.region).toBe('active');
    expect(dark.components.D1!.current).toBeGreaterThan(0.008);
    const bright = solve({
      ...doc,
      components: doc.components.map((c) =>
        c.id === 'LDR1'
          ? { ...c, params: { ...c.params, illuminance: { value: 100, unit: 'lux' } } }
          : c,
      ),
    });
    expect(bright.components.Q1!.state!.region).toBe('cutoff');
    expect(bright.components.D1!.current!).toBeLessThan(1e-5);
  });

  it('PIR alarm (Sprint 10): no motion, silent; motion drives the 2N3904 into saturation and the buzzer sounds', () => {
    const doc = example('pir-alarm');
    const quiet = solve(doc);
    expect(quiet.components.U1!.state).toEqual({ powered: true, output: 'low' });
    expect(quiet.components.BZ1!.state).toEqual({ sounding: false });
    const alarm = solve({
      ...doc,
      components: doc.components.map((c) =>
        c.id === 'U1' ? { ...c, params: { ...c.params, motion: true } } : c,
      ),
    });
    expect(alarm.components.U1!.state!.output).toBe('high');
    expect(alarm.components.Q1!.state!.region).toBe('saturation');
    expect(alarm.components.BZ1!.state).toEqual({ sounding: true });
    expect(alarm.components.BZ1!.current).toBeGreaterThan(0.025);
  });

  it('LED matrix (Sprint 10): row 2 grounded lights (2,2) and (2,7); closing row 7 adds (7,2) and (7,7)', () => {
    const doc = example('led-matrix');
    const lit = (o: SolveSuccess) =>
      o.components.DS1!.array!.currents.flatMap((i, k) =>
        i > 1e-6 ? [`${Math.floor(k / 8) + 1}.${(k % 8) + 1}`] : [],
      );
    expect(lit(solve(doc))).toEqual(['2.2', '2.7']);
    const both = solve({
      ...doc,
      components: doc.components.map((c) =>
        c.id === 'SW2' ? { ...c, params: { ...c.params, closed: true } } : c,
      ),
    });
    expect(lit(both)).toEqual(['2.2', '2.7', '7.2', '7.7']);
  });

  it('RC fade (Sprint 10, time-stepped): the LED fades in as C charges, and out when the switch opens', () => {
    const doc = example('rc-fade');
    const s = new EngineSession(createSnapshot(doc));
    expect(s.timeDependent).toBe(true);
    const led = (o: ReturnType<typeof s.advance>) => {
      if (!o.ok) throw new Error(o.error.code);
      return o.components.D1!.current!;
    };
    const early = led(s.advance(1e-3));
    let later = 0;
    for (let n = 0; n < 2000; n++) later = led(s.advance(1e-3));
    expect(early).toBeLessThan(1e-4);
    expect(later).toBeGreaterThan(0.004); // lit after 2 s
    expect(s.applyControl('SW1', { closed: false }, 2)).toBeNull();
    let off = later;
    for (let n = 0; n < 3000; n++) off = led(s.advance(1e-3));
    expect(off).toBeLessThan(later / 10); // faded out after 3 s
  });

  it('relay load (Sprint 10): at rest the buzzer sounds through NC and the LED is dark', () => {
    const r = solve(example('relay-load'));
    expect(r.components.K1!.state).toEqual({ energized: false, contact: 'nc' });
    expect(r.components.BZ1!.state).toEqual({ sounding: true });
    near(r.components.BZ1!.current, 0.0276, 1e-6);
    expect(Math.abs(r.components.D1!.current!)).toBeLessThan(1e-9);
    // Holding the button (transient input): the coil energizes, NO lights the LED, the buzzer stops.
    const s = new EngineSession(createSnapshot(example('relay-load')));
    expect(s.setMomentary('SW1', true)).toBeNull();
    const held = s.solve();
    if (!held.ok) throw new Error(held.error.code);
    expect(held.components.K1!.state).toEqual({ energized: true, contact: 'no' });
    near(held.components.K1!.currents!.coil, 5 / 70, 1e-9);
    expect(held.components.D1!.current).toBeGreaterThan(0.012);
    expect(held.components.BZ1!.state).toEqual({ sounding: false });
  });

  it('LED colours (Sprint 10): one resistor, three colour cards, three different currents', () => {
    const doc = example('led-colours');
    expect(
      doc.components.filter((c) => c.type === 'component.led').map((c) => c.params.model),
    ).toEqual([
      'model.led.vishay_tlhr5400',
      'model.led.vishay_tlhy5400',
      'model.led.vishay_tlhg4900',
    ]);
    const r = solve(doc);
    near(r.components.D1!.current, 16.72e-3, 1e-3);
    near(r.components.D2!.current, 14.53e-3, 1e-3);
    near(r.components.D3!.current, 14.53e-3, 1e-3);
    for (const [d, res] of [
      ['D1', 'R1'],
      ['D2', 'R2'],
      ['D3', 'R3'],
    ] as const) {
      // KVL on each branch, and inside each card's documented 1-20 mA range.
      near(r.components[res]!.voltage! + r.components[d]!.voltage!, 5);
      expect(r.components[d]!.current!).toBeGreaterThan(1e-3);
      expect(r.components[d]!.current!).toBeLessThan(20e-3);
    }
    // A higher forward voltage leaves less across the same resistor.
    expect(r.components.D2!.current!).toBeLessThan(r.components.D1!.current!);
  });

  it('diode polarity: D1 forward ~4.314 mA / 685.8 mV; D2 reversed blocks at nA', () => {
    const r = solve(example('diode-polarity'));
    near(r.components.D1!.current, 4.3142e-3, 1e-4);
    near(r.components.D1!.voltage, 0.68584, 1e-4);
    expect(r.components.D2!.current!).toBeLessThan(0);
    expect(Math.abs(r.components.D2!.current!)).toBeLessThan(10e-9);
  });

  it('push button: 0 A released; ~9.2 mA LED current while held; released again exactly', () => {
    const s = new EngineSession(createSnapshot(example('push-button')));
    const released = s.solve() as SolveSuccess;
    expect(released.components.D1!.current).toBe(0);
    s.setMomentary('SW1', true);
    const held = s.solve() as SolveSuccess;
    near(held.components.D1!.current, 9.2057e-3, 1e-4);
    s.setMomentary('SW1', false);
    expect(s.solve()).toEqual(released);
  });

  it('CC mode: SW1 open = 50 mA CV; SW1 closed = 100 mA CC at 0.1 A × (100 ∥ 10) Ω', () => {
    const open = solve(example('cc-mode'));
    expect(open.components.PSU1!.mode).toBe('cv');
    near(open.components.PSU1!.current, 50e-3);
    const r = setParam(example('cc-mode'), 'SW1', 'closed', true);
    if (!r.ok) throw new Error('edit');
    const closed = solve(r.doc);
    expect(closed.components.PSU1!.mode).toBe('cc');
    near(closed.components.PSU1!.current, 0.1);
    near(closed.components.PSU1!.voltage, 0.1 / (1 / 100 + 1 / 10));
  });

  // Sprint POT-UNITS.
  const atPosition = (id: string, position: number) => {
    const r = setParam(example(id), 'RV1', 'position', { value: position, unit: 'percent' });
    if (!r.ok) throw new Error('edit');
    return r.doc;
  };
  it('potentiometer divider: V_W = 5 V × (1 − p) at 0, 25, 50 and 100 %; I = 0.5 mA', () => {
    expect(example('pot-divider').components.find((c) => c.id === 'RV1')!.params.position).toEqual({
      value: 50,
      unit: 'percent',
    });
    for (const p of [0, 25, 50, 100]) {
      const r = solve(atPosition('pot-divider', p));
      near(r.components.RV1!.terminals.wiper, 5 * (1 - p / 100));
      near(r.components.PSU1!.current, 5 / 10_000);
      expect(ratingWarnings(createSnapshot(atPosition('pot-divider', p)), r)).toEqual([]);
    }
  });
  it('LED dimmer: the LED current rises with the position and stays safe at every position', () => {
    let last = 0;
    for (let p = 0; p <= 100; p += 10) {
      const doc = atPosition('pot-led-dimmer', p);
      const r = solve(doc);
      const i = r.components.D1!.current!;
      expect(i, `${p} %`).toBeGreaterThan(last);
      last = i;
      // KVL around the loop: 5 V = I × (10 kΩ × (1 − p) + 220 Ω) + V_LED.
      near(i * (10_000 * (1 - p / 100) + 220) + r.components.D1!.voltage!, 5);
      // No rating row anywhere (LED, resistor, potentiometer, supply).
      expect(ratingWarnings(createSnapshot(doc), r), `${p} %`).toEqual([]);
      expect(r.components.PSU1!.mode).toBe('cv');
    }
    // At 100 % only the 220 Ω limits it: the LED-current example's operating point.
    near(last, 13.72e-3, 1e-3);
  });
});

/**
 * Sprint 12 ESP32 examples: their circuits solved locally by the production engine with the board
 * pads attached exactly as the runtime host attaches them (the session request the app builds),
 * pads in the states the sketches set. The firmware itself runs only on the runtime service.
 */
describe('Sprint 12 ESP32 examples (local engine, board pads attached)', () => {
  const session = (id: string) => {
    const plan = buildSessionRequest(example(id), () => ({
      sha256: '0'.repeat(64),
      origin: 'program',
    }));
    if (!plan.ok) throw new Error(JSON.stringify(plan.error));
    const { circuit, attachments } = plan.plan.request;
    return new EngineSession(circuit, { pins: attachments });
  };
  const ok = (o: ReturnType<EngineSession['solve']>): SolveSuccess => {
    if (!o.ok) throw new Error(JSON.stringify(o.error));
    return o;
  };
  // ESP32 digital input thresholds (datasheet: V_IH 0.75 x VDD, V_IL 0.25 x VDD at 3.3 V).
  const V_IH = 0.75 * 3.3;
  const V_IL = 0.25 * 3.3;
  const pad = (o: SolveSuccess, gpio: number) => o.pins!.find((p) => p.gpio === gpio)!;
  const programOf = (id: string) => Object.values(example(id).programs)[0]!.text;

  it('the sketches use no third-party library, no internal pull, and only Wire for I2C', () => {
    for (const id of ['esp32-distance-alarm', 'esp32-thermo-hygrometer', 'esp32-lcd-hello']) {
      const text = programOf(id);
      expect(text, id).not.toMatch(/INPUT_PULL|gpio_pullup|gpio_pulldown|GPIO_PULL/);
      const includes = [...text.matchAll(/#include\s*<([^>]+)>/g)].map((m) => m[1]);
      expect(includes, id).toEqual(id === 'esp32-lcd-hello' ? ['Wire.h'] : []);
    }
    expect(programOf('esp32-distance-alarm')).toContain('pulseIn(18, HIGH, 30000)');
    expect(programOf('esp32-lcd-hello')).toContain('Wire.begin(21, 22, 100000)');
  });

  it('distance alarm: 5 V module powered; the echo divider gives GPIO18 3.2 V; GPIO2 lights the LED', () => {
    const doc = example('esp32-distance-alarm');
    const us = doc.components.find((c) => c.type === 'sensor.hc_sr04')!;
    expect(us.params.distance).toEqual({ value: 0.5, unit: 'metre' });
    const s = session('esp32-distance-alarm');
    expect(s.setPinMode(5, 'output-low')).toBeNull();
    expect(s.setPinMode(2, 'output-low')).toBeNull();
    let o = ok(s.solve());
    expect(o.components[us.id]!.state).toEqual({ powered: true, output: 'low' });
    expect(pad(o, 18).voltage).toBeLessThan(V_IL);
    expect(Math.abs(o.components.D1!.current!)).toBeLessThan(1e-6);
    // Echo HIGH (the module drives 5 V behind its output resistance): 5 V x 2k / (1k + 2k + R_out).
    expect(s.setPartRuntime(us.id, 'echo', 'high')).toBeNull();
    expect(s.setPinMode(5, 'output-high')).toBeNull();
    expect(s.setPinMode(2, 'output-high')).toBeNull();
    o = ok(s.solve());
    expect(o.components[us.id]!.state!.output).toBe('high');
    const v18 = o.components.R1!.terminals.a!;
    expect(v18).toBeGreaterThan(3.0);
    expect(v18).toBeLessThan(3.4);
    expect(pad(o, 18).voltage).toBeGreaterThan(V_IH);
    // TRIG is driven to 3.3 V: above the module's 2.0 V TTL threshold.
    expect(o.components[us.id]!.terminals.trig!).toBeGreaterThan(2.0);
    // The alarm LED: a few mA from the 3.3 V pad through 220 Ω.
    expect(o.components.D1!.current!).toBeGreaterThan(2e-3);
    expect(o.components.D1!.current!).toBeLessThan(10e-3);
    expect(o.components.PSU1!.mode).toBe('cv');
  });

  it('thermo-hygrometer: 3.3 V sensor powered; DATA idles HIGH through the pull-up, LOW when the sensor pulls it', () => {
    const doc = example('esp32-thermo-hygrometer');
    const dht = doc.components.find((c) => c.type === 'sensor.dht22')!;
    // Pin 3 (NC) is left unconnected.
    expect(doc.connections.some((c) => c.component === dht.id && c.terminal === 'nc')).toBe(false);
    const s = session('esp32-thermo-hygrometer');
    let o = ok(s.solve());
    expect(o.components[dht.id]!.state).toEqual({ powered: true, output: 'released' });
    near(o.components[dht.id]!.terminals.data, 3.3, 1e-3);
    expect(pad(o, 4).voltage).toBeGreaterThan(V_IH);
    expect(s.setPartRuntime(dht.id, 'data', 'low')).toBeNull();
    o = ok(s.solve());
    expect(o.components[dht.id]!.terminals.data!).toBeLessThan(0.1);
    expect(pad(o, 4).voltage).toBeLessThan(V_IL);
    // The host's start pulse: GPIO4 driven LOW pulls the line down too.
    expect(s.setPartRuntime(dht.id, 'data', 'released')).toBeNull();
    expect(s.setPinMode(4, 'output-low')).toBeNull();
    o = ok(s.solve());
    expect(o.components[dht.id]!.terminals.data!).toBeLessThan(0.1);
  });

  it('LCD hello: the module powered at 4.5 V; SDA and SCL idle at 3.3 V (above V_IH = 0.7 x 4.5 V)', () => {
    const doc = example('esp32-lcd-hello');
    const lcd = doc.components.find((c) => c.type === 'display.lcd1602_i2c')!;
    expect(lcd.params.address).toBe('i2c.0x27');
    const o = ok(session('esp32-lcd-hello').solve());
    expect(o.components[lcd.id]!.state!.powered).toBe(true);
    for (const line of ['sda', 'scl'] as const) {
      const v = o.components[lcd.id]!.terminals[line]!;
      expect(v, line).toBeGreaterThan(0.7 * 4.5);
      expect(v, line).toBeLessThanOrEqual(3.3 + 1e-9);
    }
    expect(pad(o, 21).voltage).toBeGreaterThan(V_IH);
    expect(pad(o, 22).voltage).toBeGreaterThan(V_IH);
    expect(o.components.PSU1!.voltage).toBeCloseTo(4.5, 9);
    expect(o.components.PSU2!.voltage).toBeCloseTo(3.3, 9);
  });
});
