/**
 * Wire routing integrity (rt2): route geometry can never change electrical connectivity.
 *
 * Property, over many randomized sequences of geometry edits as the Circuit view commits them
 * (part moves and rotations with the manual-wire repair and the canonical routing, wire segment
 * drags, "route automatically", drag previews): the netlist (components, nets, connections: the
 * simulation snapshot id and topology key), every wire's endpoints and every junction are
 * unchanged; the ONLY things that differ are part positions/rotations (the edit itself) and wire
 * geometry (vertices, and automatic/manual). Electrical edits (a wire added or deleted) are made
 * explicitly in between; from each one the property holds again with its new netlist.
 *
 * Direct contacts (contacts.ts, Sprint 9) are PLACEMENT semantics, not routing: a moved lead that
 * lands exactly on another terminal touches it (and pulling it away breaks that). So the routing
 * claim is checked twice: (1) the canonical routing of every edited document changes nothing
 * electrical relative to the same document unrouted; (2) across a sequence, the netlist changes
 * only at an explicit wire edit or where the set of contacts changed (counted, not hidden).
 */
import { describe, expect, it } from 'vitest';
import {
  contacts,
  createSnapshot,
  emptySelection,
  moveSelection,
  nodeNets,
  topologyKey,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { movePreview, routeAutomatic } from '../src/ui/routing.js';
import { randomBench, rng } from './support/routingBench.js';
import { randomEdit } from './support/editSequence.js';

/** The electrical identity of a document: what routing must never change. */
const electrical = (d: ProjectDocument) =>
  JSON.stringify({
    snapshot: createSnapshot(d).snapshotId,
    topology: topologyKey(d),
    nets: d.nets,
    connections: d.connections,
    ends: d.layout.wires.map((w) => [w.id, w.from, w.to]),
    junctions: d.layout.junctions,
  });
/** Everything except positions, rotations, wire geometry and the revision. */
const nonGeometry = (d: ProjectDocument) =>
  JSON.stringify({
    ...d,
    revision: null,
    layout: {
      ...d.layout,
      components: Object.keys(d.layout.components),
      wires: d.layout.wires.map(({ vertices: _v, auto: _a, ...rest }) => rest),
    },
  });

describe('route geometry never changes connectivity (rt2 property)', () => {
  it('randomized move / rotate / segment drag / reroute / preview sequences keep the netlist', () => {
    let checked = 0;
    let electricalEdits = 0;
    let contactEvents = 0;
    for (const [wires, seed, dense, board] of [
      [8, 21, false, false],
      [14, 22, true, false],
      [18, 23, true, true],
      [12, 24, false, true],
    ] as const) {
      const R = rng(seed * 31337);
      let doc = routeAutomatic(randomBench(wires, seed, { dense, board }).doc);
      let want = electrical(doc);
      let rest = nonGeometry(doc);
      for (let k = 0; k < 16; k++) {
        if (k % 6 === 5) {
          // An explicit electrical edit: the netlist may change here, and only here.
          const e = randomEdit(doc, R, routeAutomatic, ['addWire', 'deleteWire']);
          if (e) {
            doc = e.doc;
            want = electrical(doc);
            rest = nonGeometry(doc);
            electricalEdits++;
          }
          continue;
        }
        // The edit as committed, unrouted; then the store's canonical routing of it.
        const step = randomEdit(doc, R, (d) => d);
        if (!step) continue;
        expect(step.electrical).toBe(false);
        const routed = routeAutomatic(step.doc);
        const label = `${wires}/${seed} step ${k} (${step.kind})`;
        // (1) Routing itself: nothing electrical, nothing but wire geometry changes.
        expect(electrical(routed), label).toBe(electrical(step.doc));
        expect(nonGeometry(routed), label).toBe(nonGeometry(step.doc));
        // (2) The sequence: unchanged, unless this placement made or broke a direct contact.
        const pairs = (d: ProjectDocument) =>
          JSON.stringify(contacts(d).map((w) => [w.from, w.to]));
        if (pairs(routed) !== pairs(doc)) {
          contactEvents++;
          want = electrical(routed);
          rest = nonGeometry(routed);
        }
        expect(electrical(routed), label).toBe(want);
        expect(nonGeometry(routed), label).toBe(rest);
        step.doc = routed;
        // The drag preview of a part (never committed): its routing changes nothing electrical
        // relative to the bare move it previews (which may itself make a contact).
        const part = step.doc.components[Math.floor(R() * step.doc.components.length)]!.id;
        const sel = { ...emptySelection(), components: [part] };
        const p = movePreview(step.doc, sel, { x: 20, y: 40 });
        const bare = moveSelection(step.doc, sel, { x: 20, y: 40 });
        expect(p.ok).toBe(bare.ok);
        if (p.ok && bare.ok) {
          expect(electrical(p.doc), `${label} preview`).toBe(electrical(bare.doc));
          expect(nonGeometry(p.doc), `${label} preview`).toBe(nonGeometry(bare.doc));
        }
        doc = step.doc;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(electricalEdits).toBeGreaterThan(0);
    console.log(
      `netlist property: ${checked} geometry steps, ${electricalEdits} wire edits, ${contactEvents} contact changes`,
    );
  });

  it('connectivity is a function of the wire endpoints only: stripping every route changes nothing', () => {
    const doc = routeAutomatic(randomBench(16, 31, { dense: true, board: true }).doc);
    const stripped: ProjectDocument = {
      ...doc,
      layout: { ...doc.layout, wires: doc.layout.wires.map((w) => ({ ...w, vertices: [] })) },
    };
    // The wire graph's groups (nets.ts, re-derived from the endpoints) are the same.
    const groups = (d: ProjectDocument) => JSON.stringify([...nodeNets(d)].sort());
    expect(groups(stripped)).toBe(groups(doc));
    expect(electrical(stripped)).toBe(electrical(doc));
    // And routing the stripped document gives back the same routes (canonical, history-free).
    expect(JSON.stringify(routeAutomatic(stripped).layout.wires)).toBe(
      JSON.stringify(doc.layout.wires),
    );
  });
});
