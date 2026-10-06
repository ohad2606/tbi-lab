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
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { EXAMPLES } from '../src/examples/catalog.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { RECIPES } from './exampleRecipes.js';

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
  it('has the eleven DC examples and the two ESP32 examples, each titled in English and Hebrew', () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual([
      'ohms-law',
      'voltage-divider',
      'led-current',
      'led-colours',
      'rgb-mixer',
      'light-sensor',
      'night-light',
      'relay-load',
      'diode-polarity',
      'push-button',
      'cc-mode',
      'esp32-blink',
      'esp32-input-echo',
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
});
