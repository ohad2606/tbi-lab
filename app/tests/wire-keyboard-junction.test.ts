// Keyboard wiring slice 5 (A11Y-002, docs/a11y/keyboard-wiring-design.md sec 2.1 / 7.5):
// junction and wire-body (T-connection) targets in the candidate cycle.
import { describe, expect, it } from 'vitest';
import {
  GRID,
  addComponent,
  addWire,
  connectivity,
  createProject,
  locateOnWire,
  snapPoint,
  type PinRef,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  candidateTargets,
  pinsOf,
  reconnectCandidates,
  reduceWireKeyboard,
  type Candidate,
  type WireKbState,
} from '../src/ui/wireKeyboard.js';

const pin = (component: string, terminal: string): PinRef => ({ component, terminal });
const term = (p: PinRef) => ({ kind: 'terminal' as const, ...p });

/** LED D1 and resistor R1 joined by one wire W1 (a long horizontal run), plus the default
 *  PSU1/GND1 of a new project. */
function tDoc(): ProjectDocument {
  let doc = createProject({ projectId: 'p', deviceId: 'd', name: 'T', appVersion: 't' });
  for (const [type, x, y] of [
    ['component.led', 0, 200],
    ['component.resistor', 400, 200],
  ] as const) {
    const r = addComponent(doc, type, { x, y });
    if (!r.ok) throw new Error(type);
    doc = r.doc;
  }
  const r = addWire(doc, term(pin('D1', 'cathode')), term(pin('R1', 'a')));
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const key = (c: Candidate) =>
  c.target.kind === 'terminal'
    ? `${c.target.component}.${c.target.terminal}`
    : c.target.kind === 'junction'
      ? `junction:${c.target.junction}`
      : `wire:${c.target.wire}`;
const netlist = (doc: ProjectDocument) => JSON.stringify(connectivity(doc).nodes);
const run = (doc: ProjectDocument, running = false) => ({ doc, running });

/** Starts keyboard wiring from `from` and cycles to the first candidate matching `pick`. */
function startAt(doc: ProjectDocument, from: PinRef, pick: (c: Candidate) => boolean) {
  let r = reduceWireKeyboard(
    { mode: 'idle' },
    { type: 'enterPins', component: from.component },
    run(doc),
  );
  const at = pinsOf(doc, from.component).findIndex((p) => p.terminal === from.terminal);
  r = reduceWireKeyboard(r.state, { type: 'movePin', delta: at }, run(doc));
  r = reduceWireKeyboard(r.state, { type: 'start' }, run(doc));
  const wiring = r.state as Extract<WireKbState, { mode: 'wiring' }>;
  expect(wiring.mode).toBe('wiring');
  const i = wiring.candidates.findIndex(pick);
  expect(i).toBeGreaterThanOrEqual(0);
  r = reduceWireKeyboard(r.state, { type: 'cycle', delta: i }, run(doc));
  return { state: r.state, event: r.event, candidate: wiring.candidates[i]! };
}

describe('candidateTargets: wire-body and junction targets (slice 5)', () => {
  it('offers a point on another wire, on the grid, strictly inside its route', () => {
    const doc = tDoc();
    const list = candidateTargets(doc, pin('PSU1', 'positive'));
    const onWire = list.filter((c) => c.target.kind === 'wire');
    expect(onWire).toHaveLength(1); // one per wire, the nearest point
    const c = onWire[0]!;
    if (c.target.kind !== 'wire') throw new Error('kind');
    expect(c.target.wire).toBe('W1');
    expect(snapPoint(c.target.at)).toEqual(c.target.at);
    expect(c.pos).toEqual(c.target.at);
    const w = doc.layout.wires[0]!;
    expect(locateOnWire(doc, w, c.target.at)).toBeDefined();
    // Never a wire end (that is the pin/junction itself, offered on its own).
    for (const p of [pin('D1', 'cathode'), pin('R1', 'a')]) {
      const end = list.find((x) => key(x) === `${p.component}.${p.terminal}`)!;
      expect(end.pos).not.toEqual(c.target.at);
    }
  });

  it('does not offer the wires or junctions already on the source node', () => {
    const doc = tDoc();
    for (const from of [pin('D1', 'cathode'), pin('R1', 'a')]) {
      const list = candidateTargets(doc, from);
      expect(list.some((c) => c.target.kind === 'wire')).toBe(false);
    }
  });

  it('offers an existing junction, and not one on the source node', () => {
    // Split W1 with a T from PSU1.positive: a junction J1 now exists on the D1/R1/PSU1 node.
    const doc0 = tDoc();
    const at = candidateTargets(doc0, pin('PSU1', 'positive')).find(
      (c) => c.target.kind === 'wire',
    )!.pos;
    const r = addWire(doc0, term(pin('PSU1', 'positive')), { kind: 'wire', wire: 'W1', at });
    if (!r.ok) throw new Error(r.error);
    const doc = r.doc;
    expect(doc.layout.junctions).toHaveLength(1);
    const j = doc.layout.junctions[0]!.id;
    expect(candidateTargets(doc, pin('D1', 'anode')).map(key)).toContain(`junction:${j}`);
    expect(candidateTargets(doc, pin('PSU1', 'positive')).map(key)).not.toContain(`junction:${j}`);
  });

  it('ranks all kinds by distance, then pins, junctions, wires, then id; deterministic', () => {
    const doc = tDoc();
    const a = candidateTargets(doc, pin('PSU1', 'positive'));
    const b = candidateTargets(structuredClone(doc), pin('PSU1', 'positive'));
    expect(a).toEqual(b);
    const rank = { terminal: 0, junction: 1, wire: 2 } as const;
    for (let i = 1; i < a.length; i++) {
      const p = a[i - 1]!;
      const q = a[i]!;
      expect(q.distance).toBeGreaterThanOrEqual(p.distance);
      if (q.distance === p.distance)
        expect(rank[q.target.kind]).toBeGreaterThanOrEqual(rank[p.target.kind]);
    }
    expect(a.every((c) => c.distance > 0)).toBe(true);
  });

  it('attaches the same hint to a wire on the supply node as to its pins', () => {
    let doc = tDoc();
    for (const [x, y] of [
      [pin('PSU1', 'negative'), pin('GND1', 'ref')],
      [pin('PSU1', 'positive'), pin('D1', 'anode')],
    ] as const) {
      const r = addWire(doc, term(x), term(y));
      if (!r.ok) throw new Error(r.error);
      doc = r.doc;
    }
    // From ground: the PSU1.positive -> D1.anode wire is on the supply node.
    const list = candidateTargets(doc, pin('GND1', 'ref'));
    const supplyWire = list.find((c) => c.target.kind === 'wire' && c.target.wire === 'W3');
    expect(supplyWire?.hint).toBe('ground_supply');
  });

  it('pinsOnly keeps the pin-only list (used by re-pick)', () => {
    const doc = tDoc();
    const list = candidateTargets(doc, pin('PSU1', 'positive'), { pinsOnly: true });
    expect(list.every((c) => c.target.kind === 'terminal' && c.pin)).toBe(true);
    expect(reconnectCandidates(doc, 'W1', 'to')!.every((c) => c.target.kind === 'terminal')).toBe(
      true,
    );
  });
});

describe('keyboard reducer: T-connections (slice 5)', () => {
  it('ending on a wire body gives the same connectivity as the pointer addWire call', () => {
    const doc = tDoc();
    const { state, candidate } = startAt(
      doc,
      pin('PSU1', 'positive'),
      (c) => c.target.kind === 'wire',
    );
    const done = reduceWireKeyboard(state, { type: 'commit' }, run(doc));
    expect(done.event?.kind).toBe('done');
    expect(done.event).toMatchObject({ to: candidate.target });
    // Pointer path: addWire(from, {kind:'wire', wire, at}) at the clicked point on the route.
    if (candidate.target.kind !== 'wire') throw new Error('kind');
    const pointer = addWire(doc, term(pin('PSU1', 'positive')), {
      kind: 'wire',
      wire: 'W1',
      at: { x: candidate.target.at.x + GRID, y: candidate.target.at.y },
    });
    if (!pointer.ok) throw new Error(pointer.error);
    expect(netlist(done.doc!)).toBe(netlist(pointer.doc));
    expect(JSON.stringify(done.doc!.connections)).toBe(JSON.stringify(pointer.doc.connections));
    // A T: one new junction, W1 split in two, plus the new wire.
    expect(done.doc!.layout.junctions).toHaveLength(1);
    expect(done.doc!.layout.wires).toHaveLength(3);
  });

  it('ending on a junction gives the same connectivity as addWire to that junction', () => {
    const doc0 = tDoc();
    const at = candidateTargets(doc0, pin('PSU1', 'positive')).find(
      (c) => c.target.kind === 'wire',
    )!.pos;
    const r0 = addWire(doc0, term(pin('PSU1', 'positive')), { kind: 'wire', wire: 'W1', at });
    if (!r0.ok) throw new Error(r0.error);
    const doc = r0.doc;
    const j = doc.layout.junctions[0]!.id;
    const { state } = startAt(doc, pin('D1', 'anode'), (c) => c.target.kind === 'junction');
    const done = reduceWireKeyboard(state, { type: 'commit' }, run(doc));
    expect(done.event).toMatchObject({ kind: 'done', to: { kind: 'junction', junction: j } });
    const direct = addWire(doc, term(pin('D1', 'anode')), { kind: 'junction', junction: j });
    if (!direct.ok) throw new Error(direct.error);
    expect(netlist(done.doc!)).toBe(netlist(direct.doc));
    expect(done.doc!.layout.wires.at(-1)!.to).toEqual({ kind: 'junction', junction: j });
  });

  it('refuses while the simulation runs and leaves the document unchanged', () => {
    const doc = tDoc();
    const { state } = startAt(doc, pin('PSU1', 'positive'), (c) => c.target.kind === 'wire');
    const r = reduceWireKeyboard(state, { type: 'commit' }, run(doc, true));
    expect(r.event).toEqual({ kind: 'running' });
    expect(r.doc).toBeUndefined();
    expect(r.state).toEqual(state);
  });
});

describe('slice 5 i18n keys', () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it('exist in EN and HE with the same placeholders', () => {
    for (const k of ['kbwire.target.junction', 'kbwire.target.wire']) {
      const e = (en as Record<string, string>)[k];
      const h = (he as Record<string, string>)[k];
      expect(e, k).toBeTruthy();
      expect(h, k).toBeTruthy();
      expect(ph(h!), k).toEqual(ph(e!));
    }
  });
});
