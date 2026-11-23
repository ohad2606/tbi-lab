// Keyboard wiring slice 4 (TBI-001): re-pick a wire endpoint. Pure logic, no DOM.
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  connectivity,
  createProject,
  deleteSelection,
  type PinRef,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  reconnectCandidates,
  repickIsStale,
  repickSwallowsKey,
  reduceWireKeyboard,
  type WireKbAction,
  type WireKbState,
} from '../src/ui/wireKeyboard.js';

const pin = (component: string, terminal: string): PinRef => ({ component, terminal });
const term = (p: PinRef) => ({ kind: 'terminal' as const, ...p });

/** D1 (0,-20), R1 (120,-20), R2 (240,-20); W1: D1.anode -> R1.a */
function bench(): ProjectDocument {
  let doc = createProject({ projectId: 'p', deviceId: 'd', name: 'T', appVersion: 't' });
  for (const [type, x] of [
    ['component.led', 0],
    ['component.resistor', 120],
    ['component.resistor', 240],
  ] as const) {
    const r = addComponent(doc, type, { x, y: -20 });
    if (!r.ok) throw new Error(type);
    doc = r.doc;
  }
  const w = addWire(doc, term(pin('D1', 'anode')), term(pin('R1', 'a')));
  if (!w.ok) throw new Error(w.error);
  return w.doc;
}
const keys = (c: { pin?: PinRef }[]) =>
  c.flatMap((x) => (x.pin ? [`${x.pin.component}.${x.pin.terminal}`] : []));
const groups = (doc: ProjectDocument) => {
  const g = connectivity(doc);
  const m = new Map<string, string[]>();
  for (const [p, n] of g.nodeOf) m.set(n, [...(m.get(n) ?? []), p]);
  return [...m.values()].map((v) => v.sort().join(',')).sort();
};
const ctx = (doc: ProjectDocument, running = false) => ({ doc, running });
const run = (doc: ProjectDocument, actions: WireKbAction[], running = false) => {
  let state: WireKbState = { mode: 'idle' };
  let last = reduceWireKeyboard(state, { type: 'cancel' }, ctx(doc, running));
  for (const a of actions) {
    last = reduceWireKeyboard(state, a, ctx(doc, running));
    state = last.state;
  }
  return last;
};

describe('reconnectCandidates', () => {
  it('is deterministic, orders by distance and never offers the current pin or the fixed pin', () => {
    const doc = bench();
    const a = reconnectCandidates(doc, 'W1', 'to')!;
    expect(keys(a)).toEqual(keys(reconnectCandidates(doc, 'W1', 'to')!));
    expect(keys(a)).not.toContain('R1.a'); // the end it already has
    expect(keys(a)).not.toContain('D1.anode'); // the fixed end
    for (let i = 1; i < a.length; i++)
      expect(a[i]!.distance).toBeGreaterThanOrEqual(a[i - 1]!.distance);
    const b = reconnectCandidates(doc, 'W1', 'from')!;
    expect(keys(b)).not.toContain('D1.anode');
    expect(keys(b)).not.toContain('R1.a');
  });

  it('offers a pin that is on the fixed net only through the wire being moved', () => {
    // R1.a is on D1.anode's net only through W1; moving the "from" end must still offer R1.b etc.
    const doc = bench();
    expect(reconnectCandidates(doc, 'W1', 'from')!.length).toBeGreaterThan(0);
  });

  it('skips a pin another wire already joins to the fixed end (would be a duplicate)', () => {
    const r = addWire(bench(), term(pin('D1', 'anode')), term(pin('R2', 'a')));
    if (!r.ok) throw new Error(r.error);
    expect(keys(reconnectCandidates(r.doc, 'W1', 'to')!)).not.toContain('R2.a');
  });

  it('is undefined for a missing wire', () => {
    expect(reconnectCandidates(bench(), 'W9', 'to')).toBeUndefined();
  });
});

describe('reduceWireKeyboard: re-pick', () => {
  it('start -> toggle -> choose -> cycle -> commit moves one end in one edit', () => {
    const doc = bench();
    const first = run(doc, [{ type: 'repickStart', wire: 'W1' }]);
    expect(first.state).toEqual({ mode: 'ends', wire: 'W1', side: 'from' });
    expect(first.event?.kind).toBe('repickEnds');

    let s = first.state;
    let r = reduceWireKeyboard(s, { type: 'repickToggle' }, ctx(doc));
    expect(r.state).toMatchObject({ mode: 'ends', side: 'to' });
    expect(r.event).toMatchObject({ kind: 'repickSide', side: 'to' });
    s = r.state;
    r = reduceWireKeyboard(s, { type: 'repickChoose' }, ctx(doc));
    expect(r.state).toMatchObject({ mode: 'repick', side: 'to', index: 0 });
    expect(r.event?.kind).toBe('repickStart');
    s = r.state;
    r = reduceWireKeyboard(s, { type: 'cycle', delta: 1 }, ctx(doc));
    expect(r.event).toMatchObject({ kind: 'candidate', n: 2 });
    const target = (r.state as Extract<WireKbState, { mode: 'repick' }>).candidates[1]!.pin!;
    s = r.state;
    r = reduceWireKeyboard(s, { type: 'commit' }, ctx(doc));
    expect(r.state).toEqual({ mode: 'idle' });
    expect(r.event).toMatchObject({ kind: 'repickDone', wire: 'W1' });
    const w = r.doc!.layout.wires;
    expect(w).toHaveLength(1);
    expect(w[0]!.id).toBe('W1');
    expect(w[0]!.to).toEqual(term(target));
    expect(w[0]!.from).toEqual(term(pin('D1', 'anode')));

    // Same electrics as deleting the wire and drawing the new one.
    const del = deleteSelection(doc, { components: [], wires: ['W1'], junctions: [] });
    if (!del.ok) throw new Error('delete');
    const add = addWire(del.doc, term(pin('D1', 'anode')), term(target));
    if (!add.ok) throw new Error('add');
    expect(groups(r.doc!)).toEqual(groups(add.doc));
  });

  it('keys 1/2 choose an end directly', () => {
    const doc = bench();
    const r = run(doc, [
      { type: 'repickStart', wire: 'W1' },
      { type: 'repickChoose', side: 'to' },
    ]);
    expect(r.state).toMatchObject({ mode: 'repick', side: 'to' });
  });

  it('cancel leaves no change and says which wire', () => {
    const doc = bench();
    const r = run(doc, [{ type: 'repickStart', wire: 'W1' }, { type: 'cancel' }]);
    expect(r.state).toEqual({ mode: 'idle' });
    expect(r.event).toEqual({ kind: 'repickCancel', wire: 'W1' });
    expect(r.doc).toBeUndefined();
  });

  it('is refused while the simulation runs, and never changes state', () => {
    const r = run(bench(), [{ type: 'repickStart', wire: 'W1' }], true);
    expect(r.state).toEqual({ mode: 'idle' });
    expect(r.event).toEqual({ kind: 'running' });
  });

  it('a refused commit reports the domain reason, keeps the mode and the document', () => {
    const doc = bench();
    let r = run(doc, [
      { type: 'repickStart', wire: 'W1' },
      { type: 'repickChoose', side: 'to' },
    ]);
    // The document changed under the mode: the chosen target now duplicates another wire.
    const cand = (r.state as Extract<WireKbState, { mode: 'repick' }>).candidates[0]!.pin!;
    const dup = addWire(doc, term(pin('D1', 'anode')), term(cand));
    if (!dup.ok) throw new Error(dup.error);
    r = reduceWireKeyboard(r.state, { type: 'commit' }, ctx(dup.doc));
    expect(r.event).toEqual({ kind: 'refused', reason: 'duplicate_wire' });
    expect(r.state.mode).toBe('repick');
    expect(r.doc).toBeUndefined();
  });

  it('a wire that vanished ends the mode without an edit', () => {
    const doc = bench();
    const r = run(doc, [{ type: 'repickStart', wire: 'W1' }]);
    const gone = deleteSelection(doc, { components: [], wires: ['W1'], junctions: [] });
    if (!gone.ok) throw new Error('delete');
    const next = reduceWireKeyboard(r.state, { type: 'repickChoose', side: 'to' }, ctx(gone.doc));
    expect(next.state).toEqual({ mode: 'idle' });
    expect(next.doc).toBeUndefined();
  });
});

describe('re-pick texts (en/he parity)', () => {
  const keysOf = (m: Record<string, string>) =>
    Object.keys(m).filter((k) => k.startsWith('kbwire.repick') || k.startsWith('kbwire.reason.'));
  it('both catalogues have the same repick/reason keys with the same placeholders', () => {
    const E = en as Record<string, string>;
    const H = he as Record<string, string>;
    expect(keysOf(H).sort()).toEqual(keysOf(E).sort());
    expect(keysOf(E).length).toBeGreaterThan(8);
    for (const k of keysOf(E)) {
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      expect(ph(H[k]!), k).toEqual(ph(E[k]!));
      expect(H[k]!.trim(), k).toBeTruthy();
    }
  });
});

describe('re-pick: stale state and swallowed keys (review fixes)', () => {
  const ev = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...extra,
  });
  const sel = (wires: string[]) => ({
    wires,
    components: [] as string[],
    junctions: [] as string[],
  });

  it('swallows [ ] W E Delete Backspace but not Ctrl+Z or Escape', () => {
    for (const k of ['[', ']', 'w', 'e', 'Delete', 'Backspace'])
      expect(repickSwallowsKey(ev(k)), k).toBe(true);
    expect(repickSwallowsKey({ ...ev('z'), ctrlKey: true })).toBe(false);
    expect(repickSwallowsKey(ev('Escape'))).toBe(false);
    expect(repickSwallowsKey(ev('1'))).toBe(false);
  });

  it('is stale after undo/redo/edit, selection change, wire removal or running', () => {
    const doc = bench();
    const id = doc.layout.wires[0]!.id;
    expect(repickIsStale(id, doc, doc, false, sel([id]))).toBe(false);
    expect(repickIsStale(id, { ...doc }, doc, false, sel([id]))).toBe(true);
    expect(repickIsStale(id, doc, doc, false, sel([]))).toBe(true);
    expect(repickIsStale(id, doc, doc, false, sel(['W9']))).toBe(true);
    expect(repickIsStale(id, doc, doc, true, sel([id]))).toBe(true);
    const gone = { ...doc, layout: { ...doc.layout, wires: [] } };
    expect(repickIsStale(id, gone, gone, false, sel([id]))).toBe(true);
  });
});
