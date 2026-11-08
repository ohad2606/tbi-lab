/**
 * Sprint 29: the editor's floating-island check joins EVERY terminal of a part (as possibly
 * conducting), not only its first two — a logic gate whose inputs are driven only by other gates'
 * outputs is not floating; a part that reaches no reference through any terminal still is.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  checkCircuit,
  createProject,
  type ProjectDocument,
  type WireTarget,
} from '../src/index.js';

const T = (component: string, terminal: string): WireTarget => ({
  kind: 'terminal',
  component,
  terminal,
});

function build(
  steps: (d: { add: (t: string) => string; wire: (a: WireTarget, b: WireTarget) => void }) => void,
) {
  let doc: ProjectDocument = createProject({
    projectId: 'prj_s29checks',
    deviceId: 'dev_s29',
    name: 's29',
    appVersion: '0.2.0',
    clock: { now: () => new Date(0) },
  });
  let x = 0;
  steps({
    add: (type) => {
      const r = addComponent(doc, type as never, { x: (x += 200), y: 0 });
      if (!r.ok) throw new Error(JSON.stringify(r));
      doc = r.doc;
      return r.id;
    },
    wire: (a, b) => {
      const r = addWire(doc, a, b, []);
      if (!r.ok) throw new Error(JSON.stringify(r));
      doc = r.doc;
    },
  });
  return doc;
}

describe('floating_island over multi-terminal parts (Sprint 29)', () => {
  it('a gate whose two inputs come only from other gates’ outputs is not floating', () => {
    const doc = build(({ add, wire }) => {
      wire(T('PSU1', 'negative'), T('GND1', 'ref'));
      const g1 = add('logic.gate_and');
      const g2 = add('logic.gate_and');
      const g3 = add('logic.gate_or');
      for (const g of [g1, g2, g3]) {
        wire(T(g, 'vcc'), T('PSU1', 'positive'));
        wire(T(g, 'gnd'), T('GND1', 'ref'));
      }
      for (const g of [g1, g2]) {
        wire(T(g, 'a'), T('PSU1', 'positive'));
        wire(T(g, 'b'), T('GND1', 'ref'));
      }
      wire(T(g1, 'y'), T(g3, 'a'));
      wire(T(g2, 'y'), T(g3, 'b'));
      const led = add('component.led');
      wire(T(g3, 'y'), T(led, 'anode'));
      wire(T(led, 'cathode'), T('GND1', 'ref'));
    });
    expect(checkCircuit(doc).filter((i) => i.code === 'floating_island')).toEqual([]);
  });

  it('a gate wired only to a resistor (no terminal reaches GND or a supply) is still floating', () => {
    const doc = build(({ add, wire }) => {
      wire(T('PSU1', 'negative'), T('GND1', 'ref'));
      const r0 = add('component.resistor');
      wire(T(r0, 'a'), T('PSU1', 'positive'));
      wire(T(r0, 'b'), T('GND1', 'ref'));
      const g = add('logic.gate_and');
      const r = add('component.resistor');
      wire(T(g, 'y'), T(r, 'a'));
      wire(T(r, 'b'), T(g, 'a'));
    });
    const f = checkCircuit(doc).find((i) => i.code === 'floating_island');
    expect(f?.components).toEqual(expect.arrayContaining(['U1']));
  });
});
