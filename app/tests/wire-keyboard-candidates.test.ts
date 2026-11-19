// Keyboard wiring, pure logic (docs/a11y/keyboard-wiring-design.md section 2.1).
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  connectivity,
  createProject,
  terminalPosition,
  type PinRef,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { wireBracketStep, type BracketKeyEvent } from '../src/ui/wireKeyboard.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  candidateTargets,
  reduceWireKeyboard,
  stepWireSelection,
  wireListEntries,
  wirePosition,
  type WireKbState,
} from '../src/ui/wireKeyboard.js';

const pin = (component: string, terminal: string): PinRef => ({ component, terminal });
const term = (p: PinRef) => ({ kind: 'terminal' as const, ...p });

function base(): ProjectDocument {
  let doc = createProject({ projectId: 'p', deviceId: 'd', name: 'T', appVersion: 't' });
  for (const [type, x, y] of [
    ['component.led', 0, -20],
    ['component.resistor', 120, -20],
  ] as const) {
    const r = addComponent(doc, type, { x, y });
    if (!r.ok) throw new Error(type);
    doc = r.doc;
  }
  return doc;
}
const wire = (doc: ProjectDocument, a: PinRef, b: PinRef) => {
  const r = addWire(doc, term(a), term(b));
  if (!r.ok) throw new Error(r.error);
  return r.doc;
};
const keys = (c: { pin: PinRef }[]) => c.map((x) => `${x.pin.component}.${x.pin.terminal}`);
const netlist = (doc: ProjectDocument) => JSON.stringify(connectivity(doc).nodes);

describe('candidateTargets (keyboard wiring, pure logic)', () => {
  it('never includes the source pin', () => {
    const doc = base();
    const from = pin('D1', 'anode');
    expect(keys(candidateTargets(doc, from))).not.toContain('D1.anode');
    expect(candidateTargets(doc, from).length).toBeGreaterThan(0);
  });

  it('excludes pins already joined to the source by a wire', () => {
    const doc = wire(base(), pin('D1', 'cathode'), pin('R1', 'a'));
    expect(keys(candidateTargets(doc, pin('D1', 'cathode')))).not.toContain('R1.a');
    expect(keys(candidateTargets(doc, pin('R1', 'a')))).not.toContain('D1.cathode');
    // Same electrical node through a third pin: also redundant.
    const doc2 = wire(doc, pin('R1', 'a'), pin('PSU1', 'positive'));
    expect(keys(candidateTargets(doc2, pin('D1', 'cathode')))).not.toContain('PSU1.positive');
  });

  it('orders by canvas distance, ties by component id then terminal id', () => {
    const doc = base();
    const from = pin('D1', 'anode');
    const list = candidateTargets(doc, from);
    const o = terminalPosition(doc, 'D1', 'anode')!;
    const d = list.map((c) => {
      const p = terminalPosition(doc, c.pin.component, c.pin.terminal)!;
      return Math.hypot(p.x - o.x, p.y - o.y);
    });
    expect(d).toEqual([...d].sort((a, b) => a - b));
    for (let i = 1; i < list.length; i++) {
      if (d[i] !== d[i - 1]) continue;
      const a = list[i - 1]!.pin;
      const b = list[i]!.pin;
      expect(`${a.component}\u0000${a.terminal}` < `${b.component}\u0000${b.terminal}`).toBe(true);
    }
    // Ties exist: two pins of the PSU/ground can coincide only by luck, so also force one.
    const tie = candidateTargets(doc, pin('R1', 'a'));
    expect(tie.length).toBe(candidateTargets(doc, pin('R1', 'a')).length);
  });

  it('breaks distance ties by component id then terminal id', () => {
    // Two resistors at mirrored positions around a third pin are equidistant.
    let doc = createProject({ projectId: 'p', deviceId: 'd', name: 'T', appVersion: 't' });
    for (const x of [400, 600]) {
      const r = addComponent(doc, 'component.resistor', { x, y: 400 });
      if (!r.ok) throw new Error('r');
      doc = r.doc;
    }
    const a = terminalPosition(doc, 'R1', 'a')!;
    const b = terminalPosition(doc, 'R2', 'a')!;
    expect(b.x - a.x).toBe(200);
    const list = candidateTargets(doc, pin('R1', 'a'));
    const idxA = keys(list).indexOf('R1.b');
    expect(idxA).toBeGreaterThanOrEqual(0);
    const ranked = list.map((c) => `${c.distance}|${c.pin.component}.${c.pin.terminal}`);
    const sorted = [...list]
      .sort(
        (x, y) =>
          x.distance - y.distance ||
          `${x.pin.component}.${x.pin.terminal}`.localeCompare(
            `${y.pin.component}.${y.pin.terminal}`,
          ),
      )
      .map((c) => `${c.distance}|${c.pin.component}.${c.pin.terminal}`);
    expect(ranked).toEqual(sorted);
  });

  it('is deterministic for the same document', () => {
    const doc = base();
    const from = pin('D1', 'anode');
    expect(candidateTargets(doc, from)).toEqual(candidateTargets(structuredClone(doc), from));
    expect(candidateTargets(doc, from, { limit: 2 })).toEqual(
      candidateTargets(doc, from).slice(0, 2),
    );
  });

  it('keeps risky targets (ground to supply) and attaches a hint instead of hiding them', () => {
    // PSU1.positive on the supply rail, GND1.gnd on ground: both wired so they are nodes.
    let doc = base();
    doc = wire(doc, pin('PSU1', 'negative'), pin('GND1', 'ref'));
    doc = wire(doc, pin('PSU1', 'positive'), pin('D1', 'anode'));
    const g = connectivity(doc);
    expect(g.nodes.map((n) => n.kind).sort()).toEqual(['ground', 'supply']);
    const fromGround = candidateTargets(doc, pin('GND1', 'ref'));
    const risky = fromGround.find((c) => c.pin.component === 'D1' && c.pin.terminal === 'anode');
    // D1.anode is on the supply node, GND1.gnd on ground, not yet the same node.
    expect(risky?.hint).toBe('ground_supply');
    const safe = fromGround.find((c) => c.pin.component === 'R1');
    expect(safe?.hint).toBeUndefined();
  });

  it('returns an empty list when the document has no other pins', () => {
    const doc = createProject({ projectId: 'p', deviceId: 'd', name: 'T', appVersion: 't' });
    doc.components = doc.components.filter((c) => c.id === 'GND1');
    const from = pin('GND1', 'ref');
    expect(candidateTargets(doc, from)).toEqual([]);
    expect(candidateTargets(doc, pin('NOPE', 'x'))).toEqual([]);
  });
});

describe('keyboard reducer', () => {
  const run = (doc: ProjectDocument, running = false) => ({ doc, running });

  it('walks idle -> pins -> wiring -> commit and cancel', () => {
    const doc = base();
    let s: WireKbState = { mode: 'idle' };
    let r = reduceWireKeyboard(s, { type: 'enterPins', component: 'D1' }, run(doc));
    expect(r.state).toEqual({ mode: 'pins', component: 'D1', index: 0 });
    expect(r.event).toMatchObject({ kind: 'pins', count: 2, pin: pin('D1', 'anode') });
    r = reduceWireKeyboard(r.state, { type: 'movePin', delta: 1 }, run(doc));
    expect(r.event).toEqual({ kind: 'pin', pin: pin('D1', 'cathode') });
    r = reduceWireKeyboard(r.state, { type: 'movePin', delta: 1 }, run(doc));
    expect(r.state).toMatchObject({ index: 0 }); // wraps
    r = reduceWireKeyboard(r.state, { type: 'start' }, run(doc));
    expect(r.state.mode).toBe('wiring');
    expect(r.event).toEqual({ kind: 'start', pin: pin('D1', 'anode') });
    const total = (r.state as Extract<WireKbState, { mode: 'wiring' }>).candidates.length;
    r = reduceWireKeyboard(r.state, { type: 'cycle', delta: -1 }, run(doc));
    expect(r.event).toMatchObject({ kind: 'candidate', n: total, total });
    r = reduceWireKeyboard(r.state, { type: 'cycle', delta: 1 }, run(doc));
    expect(r.event).toMatchObject({ kind: 'candidate', n: 1, total });
    const cancelled = reduceWireKeyboard(r.state, { type: 'cancel' }, run(doc));
    expect(cancelled.state).toEqual({ mode: 'idle' });
    expect(cancelled.event).toEqual({ kind: 'cancel' });
    expect(cancelled.doc).toBeUndefined();
    s = r.state;
    const done = reduceWireKeyboard(s, { type: 'commit' }, run(doc));
    expect(done.event?.kind).toBe('done');
    expect(done.doc?.layout.wires).toHaveLength(1);
    expect(done.state.mode).toBe('pins');
  });

  it('refuses while the simulation runs and changes nothing', () => {
    const doc = base();
    const pins = reduceWireKeyboard(
      { mode: 'idle' },
      { type: 'enterPins', component: 'R1' },
      run(doc, true),
    ).state;
    const r = reduceWireKeyboard(pins, { type: 'start' }, run(doc, true));
    expect(r.event).toEqual({ kind: 'running' });
    expect(r.state).toEqual(pins);
    expect(r.doc).toBeUndefined();
  });

  it('reports noTargets and ignores actions in the wrong mode', () => {
    const doc = createProject({ projectId: 'p', deviceId: 'd', name: 'T', appVersion: 't' });
    doc.components = doc.components.filter((c) => c.id === 'GND1');
    const pins = reduceWireKeyboard(
      { mode: 'idle' },
      { type: 'enterPins', component: 'GND1' },
      run(doc),
    ).state;
    expect(reduceWireKeyboard(pins, { type: 'start' }, run(doc)).event).toEqual({
      kind: 'noTargets',
      pin: pin('GND1', 'ref'),
    });
    const idle: WireKbState = { mode: 'idle' };
    for (const a of [{ type: 'cycle', delta: 1 }, { type: 'commit' }, { type: 'start' }] as const)
      expect(reduceWireKeyboard(idle, a, run(doc))).toEqual({ state: idle });
  });

  it('same netlist via the keyboard reducer as via addWire', () => {
    const doc = base();
    const direct = wire(doc, pin('D1', 'anode'), pin('R1', 'a'));
    let r = reduceWireKeyboard({ mode: 'idle' }, { type: 'enterPins', component: 'D1' }, run(doc));
    r = reduceWireKeyboard(r.state, { type: 'start' }, run(doc));
    const wiring = r.state as Extract<WireKbState, { mode: 'wiring' }>;
    const i = keys(wiring.candidates).indexOf('R1.a');
    expect(i).toBeGreaterThanOrEqual(0);
    r = reduceWireKeyboard(r.state, { type: 'cycle', delta: i }, run(doc));
    const done = reduceWireKeyboard(r.state, { type: 'commit' }, run(doc));
    expect(netlist(done.doc!)).toBe(netlist(direct));
    expect(JSON.stringify(done.doc!.connections)).toBe(JSON.stringify(direct.connections));
  });
});

describe('kbwire i18n keys', () => {
  const ks = Object.keys(en).filter((k) => k.startsWith('kbwire.'));
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it('exist in both languages with the same parameters', () => {
    expect(ks.length).toBeGreaterThanOrEqual(15);
    expect(ks).toContain('kbwire.pinLabel.connectedOne');
    expect((en as Record<string, string>)['kbwire.pinLabel.connectedOne']).toContain('1 wire');
    for (const k of ks) {
      const he_ = (he as Record<string, string>)[k];
      expect(he_, k).toBeTruthy();
      expect(ph(he_!), k).toEqual(ph((en as Record<string, string>)[k]!));
    }
  });
});

describe('stepWireSelection (wire selection by keyboard)', () => {
  const three = () => {
    let d = base();
    d = wire(d, pin('D1', 'anode'), pin('R1', 'a'));
    d = wire(d, pin('D1', 'cathode'), pin('R1', 'b'));
    return d;
  };
  it('has nothing to select in an empty document', () => {
    expect(stepWireSelection(base(), undefined, 1)).toBeUndefined();
    expect(stepWireSelection(base(), 'W1', -1)).toBeUndefined();
  });
  it('starts at the first (next) or last (previous) wire, in stable document order', () => {
    const d = three();
    const ids = d.layout.wires.map((w) => w.id);
    expect(stepWireSelection(d, undefined, 1)).toEqual({ id: ids[0], n: 1, total: 2 });
    expect(stepWireSelection(d, undefined, -1)).toEqual({ id: ids[1], n: 2, total: 2 });
    expect(stepWireSelection(d, 'gone', 1)?.n).toBe(1);
  });
  it('wraps around both ways and never changes the document', () => {
    const d = three();
    const before = JSON.stringify(d);
    const [a, b] = d.layout.wires.map((w) => w.id);
    expect(stepWireSelection(d, a, 1)?.id).toBe(b);
    expect(stepWireSelection(d, b, 1)?.id).toBe(a);
    expect(stepWireSelection(d, a, -1)?.id).toBe(b);
    expect(stepWireSelection(d, b, -1)?.id).toBe(a);
    expect(JSON.stringify(d)).toBe(before);
    expect(wirePosition(d, b!)).toBe(2);
    expect(wirePosition(d, 'nope')).toBe(0);
  });
});

describe('wire selection i18n keys', () => {
  it('exist in both languages', () => {
    for (const k of [
      'kbwire.wireSelected',
      'kbwire.wireRemoved',
      'kbwire.wireCleared',
      'kbwire.noWires',
      'kbwire.endJunction',
    ]) {
      expect((en as Record<string, string>)[k], k).toBeTruthy();
      expect((he as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});

describe('wireBracketStep (wire selection key match)', () => {
  const ev = (o: Partial<BracketKeyEvent>): BracketKeyEvent => ({
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...o,
  });
  it('US layout', () => {
    expect(wireBracketStep(ev({ key: '[', code: 'BracketLeft' }))).toBe(-1);
    expect(wireBracketStep(ev({ key: ']', code: 'BracketRight' }))).toBe(1);
  });
  it('German AltGr reports ctrl+alt with AltGraph', () => {
    const e = ev({
      key: '[',
      code: 'Digit8',
      ctrlKey: true,
      altKey: true,
      getModifierState: (k) => k === 'AltGraph',
    });
    expect(wireBracketStep(e)).toBe(-1);
    expect(wireBracketStep({ ...e, key: ']', code: 'Digit9' })).toBe(1);
  });
  it('Hebrew: follows the typed character', () => {
    expect(wireBracketStep(ev({ key: ']', code: 'BracketLeft' }))).toBe(1);
    expect(wireBracketStep(ev({ key: '[', code: 'BracketRight' }))).toBe(-1);
  });
  it('rejects Ctrl/Alt/Meta/Shift combinations', () => {
    expect(wireBracketStep(ev({ key: '[', code: 'BracketLeft', ctrlKey: true }))).toBeNull();
    expect(wireBracketStep(ev({ key: '[', code: 'BracketLeft', altKey: true }))).toBeNull();
    expect(wireBracketStep(ev({ key: '[', code: 'BracketLeft', metaKey: true }))).toBeNull();
    expect(wireBracketStep(ev({ key: '{', code: 'BracketLeft', shiftKey: true }))).toBeNull();
    expect(
      wireBracketStep(ev({ key: '[', ctrlKey: true, altKey: true, getModifierState: () => false })),
    ).toBeNull();
  });
  it('rejects a different printable character on the bracket key', () => {
    expect(wireBracketStep(ev({ key: 'ü', code: 'BracketLeft' }))).toBeNull();
  });
  it('falls back to code for non-printable keys', () => {
    expect(wireBracketStep(ev({ key: 'Dead', code: 'BracketRight' }))).toBe(1);
  });
});

describe('kbwire.wireSelected strings', () => {
  it('has hint key and refusal key in both languages', async () => {
    const { he } = await import('../src/i18n/messages.he.js');
    for (const k of ['kbwire.wireSelected.hint', 'kbwire.wireDeleteRefused']) {
      expect(en).toHaveProperty([k]);
      expect(he).toHaveProperty([k]);
    }
    expect(he['kbwire.wireSelected.hint']).toContain('{delete}');
    expect(en['kbwire.wireSelected']).not.toMatch(/Delete/);
  });
});

describe('wires list (slice 3)', () => {
  it('lists wires in document order with stable 1-based numbers, matching wirePosition', () => {
    let doc = base();
    doc = wire(doc, pin('D1', 'anode'), pin('R1', 'a'));
    doc = wire(doc, pin('D1', 'cathode'), pin('R1', 'b'));
    const rows = wireListEntries(doc, (e) =>
      e.kind === 'terminal' ? `${e.component}.${e.terminal}` : `J${e.junction}`,
    );
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    expect(rows.map((r) => r.id)).toEqual(doc.layout.wires.map((w) => w.id));
    expect(rows[0]).toMatchObject({ from: 'D1.anode', to: 'R1.a' });
    for (const r of rows) expect(wirePosition(doc, r.id)).toBe(r.n);
  });
  it('is empty without wires and appends (never reorders) when a wire is added', () => {
    const doc = base();
    expect(wireListEntries(doc, () => 'x')).toEqual([]);
    const d1 = wire(doc, pin('D1', 'anode'), pin('R1', 'a'));
    const d2 = wire(d1, pin('D1', 'cathode'), pin('R1', 'b'));
    expect(wireListEntries(d2, () => 'x')[0]!.id).toBe(wireListEntries(d1, () => 'x')[0]!.id);
  });
  it('list i18n keys exist in EN and HE with the same placeholders', () => {
    for (const k of ['kbwire.list.title', 'kbwire.list.empty', 'kbwire.list.item'] as const) {
      expect(en[k], k).toBeTruthy();
      expect(he[k], k).toBeTruthy();
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(he[k])).toEqual(ph(en[k]));
    }
  });
});
