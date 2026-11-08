/**
 * Sprint 24 (M2) finding, pinned as a test so any change is visible: an ESP32 input pad that
 * nothing drives (a push button to 3.3 V with no pull resistor, released) solves to exactly 0 V in
 * the engine, through the pad's input-leakage conductance to GND (esp32Gpio.ts G_INPUT_LEAKAGE_S =
 * 50 nA / 3.3 V, a numerical reference: the data sheet bounds |I_IL| at 50 nA but gives no
 * direction, so the LOW reading is NOT characterised), and the host's input interpretation reads
 * LOW. Arduino and MicroPython take the same path. The editor shows the non-blocking
 * `gpio_input_floating` check for it; the simulation itself is unchanged (owner decision pending).
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  checkCircuit,
  createProject,
  ESP32_MICROPYTHON_PROFILE,
  setParam,
  setProgramProfile,
  setProgramText,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EngineSession, G_INPUT_LEAKAGE_S, interpretDigitalInput } from '@tbi-lab/engine';
import { buildSessionRequest } from '../src/runtime/snapshot.js';

const must = <R extends { ok: boolean }>(r: R) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<R, { ok: true }>;
};
const T = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

function circuit(pullDown: boolean): ProjectDocument {
  let doc = createProject({ projectId: 'prj_s24float', deviceId: 'd', name: 'f', appVersion: '0' });
  doc = must(setParam(doc, 'PSU1', 'setpointVoltage', { value: 3.3, unit: 'volt' })).doc;
  doc = must(setParam(doc, 'PSU1', 'outputEnabled', true)).doc;
  doc = must(addWire(doc, T('PSU1', 'negative'), T('GND1', 'ref'))).doc;
  const u = must(addComponent(doc, 'board.esp32_devkitc_wroom32', { x: 300, y: 0 }));
  doc = u.doc;
  doc = must(setProgramProfile(doc, u.id, ESP32_MICROPYTHON_PROFILE.id)).doc;
  doc = must(
    setProgramText(doc, u.id, 'from machine import Pin\nb = Pin(34, Pin.IN)\nprint(b.value())\n'),
  ).doc;
  const b = must(addComponent(doc, 'component.push_button', { x: 0, y: -100 }));
  doc = b.doc;
  const r = must(addComponent(doc, 'component.resistor', { x: 100, y: -100 }));
  doc = must(setParam(r.doc, r.id, 'resistance', { value: 1000, unit: 'ohm' })).doc;
  doc = must(addWire(doc, T('PSU1', 'positive'), T(b.id, 'a'))).doc;
  doc = must(addWire(doc, T(b.id, 'b'), T(r.id, 'a'))).doc;
  doc = must(addWire(doc, T(r.id, 'b'), T(u.id, 'gpio34'))).doc;
  doc = must(addWire(doc, T(u.id, 'gnd'), T('GND1', 'ref'))).doc;
  if (pullDown) {
    const p = must(addComponent(doc, 'component.resistor', { x: 160, y: 0 }));
    doc = must(setParam(p.doc, p.id, 'resistance', { value: 10_000, unit: 'ohm' })).doc;
    doc = must(addWire(doc, T(p.id, 'a'), T(u.id, 'gpio34'))).doc;
    doc = must(addWire(doc, T(p.id, 'b'), T('GND1', 'ref'))).doc;
  }
  return doc;
}

function pad34(doc: ProjectDocument, held: boolean) {
  const plan = buildSessionRequest(doc, () => ({ sha256: '0'.repeat(64), origin: 'program' }));
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const { circuit: snap, attachments } = plan.plan.request;
  const e = new EngineSession(snap, { pins: attachments });
  if (held) e.setMomentary('SW1', true);
  const out = e.solve();
  if (!out.ok) throw new Error(JSON.stringify(out.error));
  return out.pins!.find((p) => p.gpio === 34)!.voltage;
}

describe('a floating ESP32 input (finding F-S24-M2-1)', () => {
  it('the leakage conductance is the data-sheet magnitude, modelled to GND', () => {
    expect(G_INPUT_LEAKAGE_S).toBeCloseTo(50e-9 / 3.3, 20);
  });

  it('released with no pull resistor: exactly 0 V, read LOW; the editor warns (non-blocking)', () => {
    const doc = circuit(false);
    const v = pad34(doc, false);
    expect(v).toBe(0);
    expect(interpretDigitalInput(v, 0)).toBe(0);
    expect(interpretDigitalInput(v, 1)).toBe(0);
    expect(checkCircuit(doc).map((i) => i.code)).toContain('gpio_input_floating');
  });

  it('held: the button drives it (3.0 V, HIGH); with the 10 kΩ pull-down: LOW by the circuit, no warning', () => {
    expect(interpretDigitalInput(pad34(circuit(false), true), 0)).toBe(1);
    const pulled = circuit(true);
    expect(pad34(pulled, false)).toBe(0);
    expect(interpretDigitalInput(pad34(pulled, true), 0)).toBe(1);
    expect(checkCircuit(pulled).map((i) => i.code)).not.toContain('gpio_input_floating');
  });
});
