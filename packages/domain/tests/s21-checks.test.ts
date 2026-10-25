/**
 * Sprint 21 (DEV-Lab acceptance of 4211aa1, the owner's as-drawn screenshot d855acf4): pre-run
 * circuit checks for a part whose own V_CC and GND share a net (it can never be powered), and for
 * a supply with nothing connected between its + and − (it supplies no current).
 */
import { describe, expect, it } from 'vitest';
import { addComponent, addWire, checkCircuit, type ProjectDocument } from '../src/index.js';
import { must, newDoc } from './helpers.js';

const T = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});
function wire(doc: ProjectDocument, a: string, b: string): ProjectDocument {
  const [ac, at] = a.split('.') as [string, string];
  const [bc, bt] = b.split('.') as [string, string];
  return must(addWire(doc, T(ac, at), T(bc, bt))).doc;
}

/** PSU1 − on GND1; U1 (SN74LVC1G08) V_CC, A, B on PSU+; U1.GND on `gnd`. */
function owner(gnd: string) {
  let doc = newDoc();
  const r = must(addComponent(doc, 'logic.gate_and', { x: -280, y: 0 }));
  doc = r.doc;
  doc = wire(doc, 'PSU1.negative', 'GND1.ref');
  for (const t of ['vcc', 'a', 'b']) doc = wire(doc, `${r.id}.${t}`, 'PSU1.positive');
  doc = wire(doc, `${r.id}.gnd`, gnd);
  return { doc, u: r.id };
}
const codes = (doc: ProjectDocument) => checkCircuit(doc).map((i) => i.code);

describe('pre-run checks for the owner circuit', () => {
  it('as drawn (U1 GND on the PSU+ net): supply pins shorted (warning) and the supply has no load', () => {
    const { doc, u } = owner('PSU1.positive');
    const issues = checkCircuit(doc);
    expect(issues).toContainEqual({
      code: 'supply_pins_shorted',
      severity: 'warning',
      components: [u],
      terminals: ['vcc', 'gnd'],
    });
    expect(issues).toContainEqual({
      code: 'psu_no_load',
      severity: 'warning',
      components: ['PSU1'],
    });
    // The existing note is kept: Y is still unwired.
    expect(codes(doc)).toContain('partially_wired');
  });

  it('intended (U1 GND on PSU−): neither check', () => {
    const c = codes(owner('PSU1.negative').doc);
    expect(c).not.toContain('supply_pins_shorted');
    expect(c).not.toContain('psu_no_load');
  });

  it('not noisy: a supply with any load across it, an unwired supply, a shorted supply', () => {
    // Fresh project: PSU1 and GND1 unwired → no psu_no_load (it is simply not connected).
    expect(codes(newDoc())).not.toContain('psu_no_load');
    // PSU1 + → R1 → GND, − on GND: a load across it.
    let doc = newDoc();
    const r = must(addComponent(doc, 'component.resistor', { x: 200, y: 0 }));
    doc = wire(r.doc, 'PSU1.negative', 'GND1.ref');
    doc = wire(doc, 'PSU1.positive', `${r.id}.a`);
    doc = wire(doc, `${r.id}.b`, 'GND1.ref');
    expect(codes(doc)).not.toContain('psu_no_load');
    expect(codes(doc)).not.toContain('supply_pins_shorted');
    // + and − joined by a wire: psu_shorted_by_wire only.
    const s = wire(newDoc(), 'PSU1.positive', 'PSU1.negative');
    expect(codes(s)).toContain('psu_shorted_by_wire');
    expect(codes(s)).not.toContain('psu_no_load');
  });
});

describe('review items 9 and 10 (probe noload)', () => {
  it('two unloaded supplies: BOTH are flagged (a fresh union per supply)', () => {
    let doc = newDoc();
    const p2 = must(addComponent(doc, 'instrument.lab_psu', { x: 400, y: 0 }));
    doc = p2.doc;
    const R: string[] = [];
    for (let k = 0; k < 4; k++) {
      const r = must(addComponent(doc, 'component.resistor', { x: 600 + 160 * k, y: 300 }));
      doc = r.doc;
      R.push(r.id);
    }
    doc = wire(doc, 'PSU1.positive', `${R[0]}.a`);
    doc = wire(doc, 'PSU1.negative', `${R[1]}.a`);
    doc = wire(doc, `${p2.id}.positive`, `${R[2]}.a`);
    doc = wire(doc, `${p2.id}.negative`, `${R[3]}.a`);
    const flagged = checkCircuit(doc)
      .filter((i) => i.code === 'psu_no_load')
      .map((i) => i.components[0])
      .sort();
    expect(flagged).toEqual(['PSU1', p2.id].sort());
  });

  it('a gate with V_CC on GND1 and GND on a second GND symbol: supply pins shorted (one reference)', () => {
    let doc = newDoc();
    const g = must(addComponent(doc, 'logic.gate_and', { x: -280, y: 0 }));
    doc = g.doc;
    const gnd2 = must(addComponent(doc, 'component.ground', { x: -280, y: 300 }));
    doc = gnd2.doc;
    doc = wire(doc, `${g.id}.vcc`, 'GND1.ref');
    doc = wire(doc, `${g.id}.gnd`, `${gnd2.id}.ref`);
    doc = wire(doc, 'PSU1.negative', 'GND1.ref');
    doc = wire(doc, 'PSU1.positive', `${g.id}.a`);
    expect(codes(doc)).toContain('supply_pins_shorted');
  });
});
