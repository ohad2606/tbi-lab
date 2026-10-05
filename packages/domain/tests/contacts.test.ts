/**
 * Sprint 9 owner review, issue 2: direct terminal-to-terminal contact. A part's terminal placed
 * exactly on another part's terminal (grid snap: within half a grid step of the pointer) makes a
 * real connection, stored as a zero-length wire (contacts.ts); pulling them apart breaks it.
 * Nothing is ever inferred when a document is read.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  checkCircuit,
  contacts,
  createPackage,
  createSnapshot,
  deleteSelection,
  isContact,
  moveSelection,
  parsePackage,
  rotateComponents,
  serializePackage,
  settleNets,
  touchingUnconnected,
  validateProject,
  type Point,
  type ProjectDocument,
} from '../src/index.js';
import { place, wire } from './circuits.js';
import { must, newDoc } from './helpers.js';

const netOf = (doc: ProjectDocument, c: string, t: string) =>
  doc.connections.find((x) => x.component === c && x.terminal === t)?.net;
const sel = (...components: string[]) => ({ components, wires: [], junctions: [] });
const move = (doc: ProjectDocument, id: string, delta: Point) =>
  must(moveSelection(doc, sel(id), delta)).doc;

/** R1 at the origin (terminals at ±40) and an LED D1 whose anode is `gap` units right of R1.b. */
function pair(gap: number) {
  let doc = newDoc();
  doc = place(doc, 'component.resistor', 0, 0).doc;
  doc = place(doc, 'component.led', 80 + gap, 0).doc;
  return doc;
}

describe('direct terminal contact', () => {
  it('a resistor terminal placed on an LED terminal is connected: one net, no visible wire', () => {
    const doc = pair(0);
    expect(contacts(doc)).toHaveLength(1);
    const w = contacts(doc)[0]!;
    expect(w.vertices).toEqual([]);
    expect([w.from, w.to]).toEqual([
      { kind: 'terminal', component: 'D1', terminal: 'anode' },
      { kind: 'terminal', component: 'R1', terminal: 'b' },
    ]);
    expect(netOf(doc, 'R1', 'b')).toBeDefined();
    expect(netOf(doc, 'R1', 'b')).toBe(netOf(doc, 'D1', 'anode'));
    expect(netOf(doc, 'R1', 'a')).toBeUndefined();
    expect(validateProject(doc)).toEqual([]);
    expect(checkCircuit(doc).map((i) => i.code)).not.toContain('terminals_touching');
  });

  it('moving one part away breaks the contact cleanly; moving it back makes it again', () => {
    const joined = pair(0);
    const apart = move(joined, 'D1', { x: 60, y: 0 });
    expect(contacts(apart)).toEqual([]);
    expect(apart.layout.wires).toEqual([]); // not stretched into a wire
    expect(netOf(apart, 'R1', 'b')).toBeUndefined();
    expect(netOf(apart, 'D1', 'anode')).toBeUndefined();
    const back = move(apart, 'D1', { x: -60, y: 0 });
    expect(contacts(back)).toHaveLength(1);
    expect(netOf(back, 'R1', 'b')).toBe(netOf(back, 'D1', 'anode'));
    // Moving both together keeps the contact (and its id).
    const both = must(moveSelection(joined, sel('R1', 'D1'), { x: 100, y: 40 })).doc;
    expect(contacts(both).map((w) => w.id)).toEqual(contacts(joined).map((w) => w.id));
    // Rotating one part takes its terminal away: separated.
    expect(contacts(must(rotateComponents(joined, ['D1'])).doc)).toEqual([]);
  });

  it('the pointer snaps within half a grid step; terminals a grid step apart stay separate', () => {
    const near = pair(20); // one grid step apart
    expect(contacts(near)).toEqual([]);
    expect(netOf(near, 'R1', 'b')).toBeUndefined();
    expect(touchingUnconnected(near)).toEqual([]);
    expect(contacts(move(near, 'D1', { x: -9, y: 0 }))).toEqual([]); // snaps to no move
    expect(contacts(move(near, 'D1', { x: -11, y: 3 }))).toHaveLength(1); // snaps onto R1.b
    // A body over a terminal, or a part merely near, never connects: only terminals do.
    let doc = newDoc();
    doc = place(doc, 'component.resistor', 0, 0).doc;
    doc = place(doc, 'component.resistor', 0, 20).doc; // parallel, bodies side by side
    expect(contacts(doc)).toEqual([]);
    expect(doc.nets).toEqual([]);
  });

  it('survives save/load and export/import exactly, and older readers see a plain wire', () => {
    const doc = pair(0);
    const text = serializePackage(
      createPackage(doc, { appVersion: 't', exportedAt: '2026-10-05T00:00:00Z' }),
    );
    const r = parsePackage(text);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.doc).toEqual(doc);
    expect(contacts(r.doc)).toHaveLength(1);
    // Stored as an ordinary wire: same schema, nothing new for a reader to understand.
    const stored = JSON.parse(text).project.layout.wires[0];
    expect(Object.keys(stored).sort()).toEqual(['from', 'id', 'to', 'vertices']);
  });

  it('the simulation snapshot carries the shared net', () => {
    let doc = pair(0);
    doc = wire(doc, ['PSU1', 'positive'], ['R1', 'a']);
    doc = wire(doc, ['D1', 'cathode'], ['GND1', 'ref']);
    doc = wire(doc, ['PSU1', 'negative'], ['GND1', 'ref']);
    const snap = createSnapshot(doc);
    const net = (c: string, t: string) =>
      snap.connections.find((x) => x.component === c && x.terminal === t)?.net;
    expect(net('R1', 'b')).toBe(net('D1', 'anode'));
    expect(new Set(snap.connections.map((c) => c.net)).size).toBe(3);
  });

  it('nothing is inferred on read: touching terminals of an imported document stay separate and are flagged', () => {
    // As if made elsewhere: D1 laid on R1.b by editing the layout directly, no contact.
    const doc = pair(60);
    doc.layout.components.D1!.x = 80;
    settleNets(doc, new Map());
    expect(validateProject(doc)).toEqual([]);
    expect(contacts(doc)).toEqual([]);
    expect(netOf(doc, 'R1', 'b')).toBeUndefined();
    expect(touchingUnconnected(doc)).toEqual([
      {
        x: 40,
        y: 0,
        terminals: [
          { kind: 'terminal', component: 'R1', terminal: 'b' },
          { kind: 'terminal', component: 'D1', terminal: 'anode' },
        ],
      },
    ]);
    const issue = checkCircuit(doc).find((i) => i.code === 'terminals_touching');
    expect(issue).toMatchObject({ components: ['R1', 'D1'], terminals: ['b', 'anode'] });
    // Editing something else leaves it alone; placing either part again joins them.
    const other = must(addComponent(doc, 'component.resistor', { x: 0, y: 300 })).doc;
    expect(contacts(other)).toEqual([]);
    const joined = move(move(doc, 'D1', { x: 20, y: 0 }), 'D1', { x: -20, y: 0 });
    expect(contacts(joined)).toHaveLength(1);
  });

  it('a contact goes with its part, and is only ever between different parts', () => {
    const doc = pair(0);
    const gone = must(deleteSelection(doc, sel('D1'))).doc;
    expect(gone.layout.wires).toEqual([]);
    expect(gone.nets).toEqual([]);
    for (const w of doc.layout.wires) expect(isContact(doc, w)).toBe(true);
  });
});
