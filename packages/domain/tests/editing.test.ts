import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  deleteSelection,
  emptySelection,
  moveSelection,
  renameNet,
  rotateComponents,
  setParam,
  terminalPosition,
  validateProject,
  wireRoute,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

function netOf(doc: ProjectDocument, component: string, terminal: string): string | undefined {
  return doc.connections.find((c) => c.component === component && c.terminal === terminal)?.net;
}

/** PSU1 at (-120,0), GND1 at (-80,120) from createProject; R1 at (0,0), R2 at (0,100). */
function bench(): ProjectDocument {
  let doc = newDoc();
  doc = must(addComponent(doc, 'component.resistor', { x: 0, y: 0 })).doc;
  doc = must(addComponent(doc, 'component.resistor', { x: 0, y: 100 })).doc;
  return doc;
}

describe('wiring and nets', () => {
  it('connects terminal to terminal into one net; a ground terminal makes a ground net', () => {
    let doc = bench();
    doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
    doc = must(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(doc.nets).toEqual([
      { id: 'N_1', role: null, userName: null },
      { id: 'N_2', role: 'ground', userName: null },
    ]);
    expect(doc.connections).toEqual([
      { component: 'PSU1', terminal: 'positive', net: 'N_1' },
      { component: 'PSU1', terminal: 'negative', net: 'N_2' },
      { component: 'GND1', terminal: 'ref', net: 'N_2' },
      { component: 'R1', terminal: 'a', net: 'N_1' },
    ]);
  });

  it('routes orthogonally, horizontal leg first', () => {
    const doc = must(addWire(bench(), t('PSU1', 'positive'), t('R1', 'a'))).doc;
    expect(wireRoute(doc, doc.layout.wires[0]!)).toEqual([
      { x: -80, y: -20 },
      { x: -40, y: -20 },
      { x: -40, y: 0 },
    ]);
  });

  it('ending a wire on another wire creates a junction and joins the nets', () => {
    let doc = must(addWire(bench(), t('PSU1', 'positive'), t('R1', 'a'))).doc;
    const before = wireRoute(doc, doc.layout.wires[0]!);
    doc = must(
      addWire(doc, t('R2', 'a'), { kind: 'wire', wire: 'W1', at: { x: -60, y: -20 } }),
    ).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(doc.layout.junctions).toEqual([{ id: 'J1', x: -60, y: -20 }]);
    expect(doc.layout.wires).toHaveLength(3);
    expect(
      new Set([netOf(doc, 'PSU1', 'positive'), netOf(doc, 'R1', 'a'), netOf(doc, 'R2', 'a')]),
    ).toEqual(new Set(['N_1']));
    // The split wire is drawn exactly where the original was.
    const halves = doc.layout.wires
      .filter((w) => !(w.from.kind === 'terminal' && w.from.component === 'R2'))
      .map((w) => wireRoute(doc, w)!);
    const joined = [...halves[0]!, ...halves[1]!.slice(1)];
    expect(
      joined.filter((p, i) => i === 0 || p.x !== joined[i - 1]!.x || p.y !== joined[i - 1]!.y),
    ).toEqual([before![0], { x: -60, y: -20 }, ...before!.slice(1)]);
  });

  it('a crossing without a shared junction is NOT a connection', () => {
    let doc = bench();
    doc = must(addComponent(doc, 'component.resistor', { x: 140, y: 60 })).doc; // R3: a=(100,60)
    doc = must(addComponent(doc, 'component.resistor', { x: -40, y: 60 })).doc; // R4: b=(0,60)
    doc = must(addWire(doc, t('R1', 'b'), t('R2', 'b'))).doc; // vertical x=40, y 0..100
    doc = must(addWire(doc, t('R4', 'b'), t('R3', 'a'))).doc; // horizontal y=60, x 0..100
    const vertical = wireRoute(doc, doc.layout.wires[0]!)!;
    const horizontal = wireRoute(doc, doc.layout.wires[1]!)!;
    expect(vertical).toEqual([
      { x: 40, y: 0 },
      { x: 40, y: 100 },
    ]);
    expect(horizontal).toEqual([
      { x: 0, y: 60 },
      { x: 100, y: 60 },
    ]); // geometrically crosses
    expect(validateProject(doc)).toEqual([]);
    expect(doc.layout.junctions).toEqual([]);
    expect(netOf(doc, 'R1', 'b')).not.toBe(netOf(doc, 'R4', 'b'));
    expect(doc.nets).toHaveLength(2);
  });

  it('refuses a wire from a terminal to itself and unknown targets', () => {
    const doc = bench();
    expect(addWire(doc, t('R1', 'a'), t('R1', 'a'))).toEqual({ ok: false, error: 'same_endpoint' });
    expect(addWire(doc, t('R1', 'z'), t('R2', 'a'))).toEqual({
      ok: false,
      error: 'unknown_terminal',
    });
    expect(addWire(doc, t('R9', 'a'), t('R2', 'a'))).toEqual({
      ok: false,
      error: 'unknown_component',
    });
    const wired = must(addWire(doc, t('R1', 'b'), t('R2', 'b'))).doc;
    expect(
      addWire(wired, t('R1', 'a'), { kind: 'wire', wire: 'W1', at: { x: 500, y: 500 } }),
    ).toEqual({ ok: false, error: 'not_on_wire' });
  });
});

describe('deletion settles nets with no dangling reference', () => {
  function tee(): ProjectDocument {
    const doc = must(addWire(bench(), t('PSU1', 'positive'), t('R1', 'a'))).doc;
    return must(addWire(doc, t('R2', 'a'), { kind: 'wire', wire: 'W1', at: { x: -60, y: -20 } }))
      .doc;
  }

  it('deleting a component removes its wires and dissolves a two-wire junction', () => {
    const original = must(addWire(bench(), t('PSU1', 'positive'), t('R1', 'a'))).doc;
    const route = wireRoute(original, original.layout.wires[0]!);
    const doc = must(deleteSelection(tee(), { ...emptySelection(), components: ['R2'] })).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(doc.layout.junctions).toEqual([]);
    expect(doc.layout.wires).toHaveLength(1);
    expect(wireRoute(doc, doc.layout.wires[0]!)).toEqual(route);
    expect(doc.connections.some((c) => c.component === 'R2')).toBe(false);
    expect(netOf(doc, 'R1', 'a')).toBe('N_1');
  });

  it('deleting the component a net ends on removes the net entirely', () => {
    let doc = must(addWire(bench(), t('R1', 'b'), t('R2', 'b'))).doc;
    doc = must(deleteSelection(doc, { ...emptySelection(), components: ['R2'] })).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(doc.nets).toEqual([]);
    expect(doc.connections).toEqual([]);
    expect(doc.layout.wires).toEqual([]);
  });

  it('deleting a junction removes its wires', () => {
    const doc = must(deleteSelection(tee(), { ...emptySelection(), junctions: ['J1'] })).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(doc.layout.wires).toEqual([]);
    expect(doc.nets).toEqual([]);
  });

  it('deleting the middle wire splits a net; one side keeps the id, the other gets a new one', () => {
    let doc = bench();
    doc = must(addComponent(doc, 'component.resistor', { x: 200, y: 0 })).doc; // R3
    doc = must(addWire(doc, t('R1', 'a'), t('R2', 'a'))).doc; // W1
    doc = must(addWire(doc, t('R1', 'b'), t('R3', 'a'))).doc; // W2 (separate net N_2)
    doc = must(addWire(doc, t('R2', 'a'), t('R2', 'b'))).doc; // W3: joins R2.b into N_1
    doc = must(addWire(doc, t('R2', 'b'), t('R3', 'b'))).doc; // W4
    const ids = new Set(doc.nets.map((n) => n.id));
    doc = must(deleteSelection(doc, { ...emptySelection(), wires: ['W3'] })).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(netOf(doc, 'R1', 'a')).toBe(netOf(doc, 'R2', 'a'));
    expect(netOf(doc, 'R2', 'b')).toBe(netOf(doc, 'R3', 'b'));
    expect(netOf(doc, 'R1', 'a')).not.toBe(netOf(doc, 'R2', 'b'));
    const after = doc.nets.map((n) => n.id);
    expect(after.filter((id) => ids.has(id)).length).toBeGreaterThanOrEqual(2);
    expect(doc.idCounters.N).toBeGreaterThanOrEqual(after.length);
  });

  it('removing the ground clears the ground role', () => {
    let doc = must(addWire(bench(), t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
    doc = must(addWire(doc, t('PSU1', 'negative'), t('R1', 'b'))).doc;
    expect(doc.nets[0]!.role).toBe('ground');
    doc = must(deleteSelection(doc, { ...emptySelection(), components: ['GND1'] })).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(doc.nets).toEqual([{ id: 'N_1', role: null, userName: null }]);
  });
});

describe('net identity and user names', () => {
  it('merging keeps the majority id and a user-authored name, verbatim', () => {
    let doc = bench();
    doc = must(addComponent(doc, 'component.resistor', { x: 200, y: 0 })).doc; // R3
    doc = must(addWire(doc, t('R1', 'a'), t('R2', 'a'))).doc; // N_1
    doc = must(addWire(doc, t('R2', 'a'), t('R3', 'a'))).doc; // N_1 grows
    doc = must(addWire(doc, t('R1', 'b'), t('R2', 'b'))).doc; // N_2
    doc = must(renameNet(doc, 'N_2', 'קו הזנה')).doc;
    doc = must(addWire(doc, t('R3', 'a'), t('R1', 'b'))).doc; // merge
    expect(validateProject(doc)).toEqual([]);
    expect(doc.nets).toEqual([{ id: 'N_1', role: null, userName: 'קו הזנה' }]);
  });
});

describe('move and rotate keep wires attached', () => {
  it('moving a component carries wire endpoints with it', () => {
    let doc = must(addWire(bench(), t('PSU1', 'positive'), t('R1', 'a'))).doc;
    doc = must(
      moveSelection(doc, { ...emptySelection(), components: ['R1'] }, { x: 40, y: 60 }),
    ).doc;
    expect(validateProject(doc)).toEqual([]);
    expect(doc.layout.components.R1).toEqual({ x: 40, y: 60, rotation: 0 });
    const route = wireRoute(doc, doc.layout.wires[0]!)!;
    expect(route[route.length - 1]).toEqual(terminalPosition(doc, 'R1', 'a'));
    expect(netOf(doc, 'R1', 'a')).toBe('N_1');
  });

  it('moves snap to the grid', () => {
    const doc = must(
      moveSelection(bench(), { ...emptySelection(), components: ['R1'] }, { x: 13, y: 29 }),
    ).doc;
    expect(doc.layout.components.R1).toEqual({ x: 20, y: 20, rotation: 0 });
  });

  it('rotation steps 90° clockwise about the origin and terminals follow', () => {
    let doc = must(addWire(bench(), t('PSU1', 'positive'), t('R1', 'a'))).doc;
    doc = must(rotateComponents(doc, ['R1'])).doc;
    expect(doc.layout.components.R1!.rotation).toBe(90);
    expect(terminalPosition(doc, 'R1', 'a')).toEqual({ x: 0, y: -40 });
    expect(terminalPosition(doc, 'R1', 'b')).toEqual({ x: 0, y: 40 });
    for (let i = 0; i < 3; i++) doc = must(rotateComponents(doc, ['R1'])).doc;
    expect(doc.layout.components.R1!.rotation).toBe(0);
    expect(validateProject(doc)).toEqual([]);
  });
});

describe('parameters', () => {
  it('stores canonical SI values and refuses out-of-range or mistyped values', () => {
    const doc = bench();
    const r = must(setParam(doc, 'R1', 'resistance', { value: 4700, unit: 'ohm' })).doc;
    expect(r.components.find((c) => c.id === 'R1')!.params.resistance).toEqual({
      value: 4700,
      unit: 'ohm',
    });
    expect(setParam(doc, 'R1', 'resistance', { value: 0, unit: 'ohm' })).toEqual({
      ok: false,
      error: 'out_of_range',
    });
    expect(setParam(doc, 'R1', 'resistance', { value: 5, unit: 'volt' })).toEqual({
      ok: false,
      error: 'param_type',
    });
    expect(setParam(doc, 'R1', 'colour', true)).toEqual({ ok: false, error: 'unknown_param' });
    expect(setParam(doc, 'PSU1', 'setpointVoltage', { value: 31, unit: 'volt' })).toEqual({
      ok: false,
      error: 'out_of_range',
    });
    const psu = must(setParam(doc, 'PSU1', 'outputEnabled', true)).doc;
    expect(psu.components[0]!.params.outputEnabled).toBe(true);
  });

  it('never mutates its input', () => {
    const doc = bench();
    const snapshot = JSON.stringify(doc);
    setParam(doc, 'R1', 'resistance', { value: 10, unit: 'ohm' });
    addWire(doc, t('R1', 'a'), t('R2', 'a'));
    deleteSelection(doc, { ...emptySelection(), components: ['R1'] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
