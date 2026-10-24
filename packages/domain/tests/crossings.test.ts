/**
 * Sprint 5: wire bridges are drawn at unconnected crossings. `wireCrossings` is derived from
 * the drawing only; it never changes the document, and a crossing is never a connection.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  createSnapshot,
  deleteSelection,
  emptySelection,
  moveWireSegment,
  autoRoute,
  sameNodeBranches,
  sameNodeCrossings,
  wireCrossings,
  wireNodes,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

/** R1 (0,-100), R2 (0,100), R3 (200,-20). W1: PSU+ (-80,-20) -> R3.a (160,-20), horizontal. */
function base(): ProjectDocument {
  let doc = newDoc();
  doc = must(addComponent(doc, 'component.resistor', { x: 0, y: -100 })).doc;
  doc = must(addComponent(doc, 'component.resistor', { x: 0, y: 100 })).doc;
  doc = must(addComponent(doc, 'component.resistor', { x: 200, y: -20 })).doc;
  return must(addWire(doc, t('PSU1', 'positive'), t('R3', 'a'))).doc;
}

/** Plus W2: R1.b (40,-100) -> R2.b (40,100), vertical, drawn straight across W1. */
function crossing(): ProjectDocument {
  return must(addWire(base(), t('R1', 'b'), t('R2', 'b'))).doc;
}

/** The same geometry, but the vertical run is joined to W1 by an explicit junction at (40,-20). */
function joined(): ProjectDocument {
  let doc = must(
    addWire(base(), t('R1', 'b'), { kind: 'wire', wire: 'W1', at: { x: 40, y: -20 } }),
  ).doc;
  const j = doc.layout.junctions[0]!;
  doc = must(addWire(doc, { kind: 'junction', junction: j.id }, t('R2', 'b'))).doc;
  return doc;
}

const netOf = (doc: ProjectDocument, component: string, terminal: string) =>
  doc.connections.find((c) => c.component === component && c.terminal === terminal)?.net;

describe('wireCrossings', () => {
  it('an unconnected crossing yields one bridge, on the vertical wire; nets stay separate', () => {
    const doc = crossing();
    expect(wireCrossings(doc)).toEqual([{ x: 40, y: -20, over: 'W2', under: 'W1' }]);
    expect(netOf(doc, 'R1', 'b')).toBe(netOf(doc, 'R2', 'b'));
    expect(netOf(doc, 'R1', 'b')).not.toBe(netOf(doc, 'PSU1', 'positive'));
    expect(netOf(doc, 'R3', 'a')).toBe(netOf(doc, 'PSU1', 'positive'));
  });

  it('the same geometry with an explicit junction has no bridge, and the nets are joined', () => {
    const doc = joined();
    expect(doc.layout.junctions).toEqual([expect.objectContaining({ x: 40, y: -20 })]);
    expect(wireCrossings(doc)).toEqual([]);
    const net = netOf(doc, 'PSU1', 'positive');
    expect(netOf(doc, 'R1', 'b')).toBe(net);
    expect(netOf(doc, 'R2', 'b')).toBe(net);
    expect(netOf(doc, 'R3', 'a')).toBe(net);
  });

  it('no bridge where a wire only touches another at its end, a corner, or a terminal', () => {
    let doc = base();
    // A wire from R1.b bending at (40,-40) and ending at R2.a... passes nowhere across W1.
    doc = must(addWire(doc, t('R1', 'b'), t('R3', 'b'), [{ x: 40, y: -60 }])).doc;
    expect(wireCrossings(doc)).toEqual([]);
    // A T: a wire whose vertical run ENDS on W1's line (at a corner on it) is not a crossing.
    let t2 = base();
    t2 = must(addWire(t2, t('R2', 'b'), t('R1', 'a'), [{ x: 40, y: -20 }])).doc;
    const tee = t2.layout.wires.find((w) => w.id !== 'W1')!;
    expect(tee.vertices).toEqual([{ x: 40, y: -20 }]); // its bend sits exactly on W1's line
    expect(wireCrossings(t2)).toEqual([]);
  });

  it('is derived from the drawing only: document, snapshot and revision are untouched', () => {
    const doc = crossing();
    const before = JSON.stringify(doc);
    const snap = JSON.stringify(createSnapshot(doc));
    wireCrossings(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(JSON.stringify(createSnapshot(doc))).toBe(snap);
    // The solver input has no layout at all, so it cannot see bridges.
    expect(Object.keys(createSnapshot(doc))).not.toContain('layout');
  });

  it('follows a dragged segment, and disappears when the crossing is dragged away', () => {
    const doc = crossing();
    const moved = must(moveWireSegment(doc, 'W2', 0, { x: 60, y: 0 })).doc; // vertical run -> x=100
    expect(wireCrossings(moved)).toEqual([{ x: 100, y: -20, over: 'W2', under: 'W1' }]);
    expect(moved.connections).toEqual(doc.connections);
    // Drag W1's run below everything: no crossing remains.
    const away = must(moveWireSegment(doc, 'W1', 0, { x: 0, y: 200 })).doc;
    expect(wireCrossings(away)).toEqual([]);
    expect(away.connections).toEqual(doc.connections);
  });

  it('deleting one of the crossing wires removes the bridge', () => {
    const doc = crossing();
    const r = must(deleteSelection(doc, { ...emptySelection(), wires: ['W2'] })).doc;
    expect(wireCrossings(r)).toEqual([]);
  });
});

describe('crossings of wires of ONE node (s20r round 2)', () => {
  /** W1: PSU+ -> R3.a (horizontal at y=-20); W2: R1.b -> R2.b, vertical across it at x=40. */
  const sameNode = () => {
    // W2's ends joined to PSU+ by a third wire: W1 and W2 are on one node, crossing at (40,-20).
    let doc = crossing();
    doc = must(addWire(doc, t('R1', 'b'), t('PSU1', 'positive'), [{ x: 40, y: -140 }])).doc;
    return doc;
  };

  it('no hop between wires of one node (a hop says "not connected"); they are listed apart', () => {
    const doc = sameNode();
    const nodes = wireNodes(doc);
    expect(nodes.get('W1')).toBe(nodes.get('W2'));
    expect(wireCrossings(doc).filter((c) => c.x === 40 && c.y === -20)).toEqual([]);
    expect(sameNodeCrossings(doc)).toContainEqual({ x: 40, y: -20, over: 'W2', under: 'W1' });
    // Different nodes: the hop stays (the Sprint 5 case).
    expect(wireCrossings(crossing())).toEqual([{ x: 40, y: -20, over: 'W2', under: 'W1' }]);
    expect(sameNodeCrossings(crossing())).toEqual([]);
  });

  it('every hop drawn is between different nodes', () => {
    const doc = sameNode();
    const nodes = wireNodes(doc);
    for (const c of wireCrossings(doc)) expect(nodes.get(c.over)).not.toBe(nodes.get(c.under));
  });

  it('the router runs a wire along a wire of its own node instead of crossing it', () => {
    // An obstacle wire of node N from (0,-100) down to (0,100); a hop from (-60,0) to (60,0).
    const obs = {
      segments: [
        [
          { x: 0, y: -100 },
          { x: 0, y: 100 },
        ],
      ] as const,
      boxes: [],
      points: [],
      segmentNodes: ['N'],
    };
    const foreign = autoRoute(
      [
        { x: -60, y: 0 },
        { x: 60, y: 0 },
      ],
      { ...obs, segmentNodes: ['M'] },
      {
        node: 'N',
      },
    );
    expect(foreign).toEqual([
      { x: -60, y: 0 },
      { x: 60, y: 0 },
    ]); // a clean crossing (a hop)
    const own = autoRoute(
      [
        { x: -60, y: 0 },
        { x: 60, y: 0 },
      ],
      obs,
      { node: 'N' },
    );
    // Crossing a wire of its own node would cost three bends: it goes round the end instead.
    expect(own).not.toEqual([
      { x: -60, y: 0 },
      { x: 60, y: 0 },
    ]);
  });
});

describe('branch dots of wires of ONE node (s20r round 3)', () => {
  // R1 (0,-100), R2 (0,100), R3 (200,-20); W1: PSU+ (-80,-20) -> R3.a (160,-20), horizontal.
  it('a dot exactly where a wire of the node leaves a run it shares; none where nodes differ', () => {
    let doc = base();
    // W2: PSU+ -> R2.b (40,100), sharing W1's run to x=40, then down: a branch at (40,-20).
    doc = must(addWire(doc, t('PSU1', 'positive'), t('R2', 'b'), [{ x: 40, y: -20 }])).doc;
    expect(wireNodes(doc).get('W2')).toBe(wireNodes(doc).get('W1'));
    expect(sameNodeBranches(doc)).toEqual([{ x: 40, y: -20 }]);
    // W3 of ANOTHER node (R1.a -> R1.b's column... R1.b (40,-100) -> GND) meeting W1 in a T at
    // (100,-20): a T of different nodes is no branch, and gets no dot.
    doc = must(
      addWire(doc, t('R1', 'a'), t('GND1', 'ref'), [
        { x: 100, y: -100 },
        { x: 100, y: -20 },
      ]),
    ).doc;
    expect(wireNodes(doc).get('W3')).not.toBe(wireNodes(doc).get('W1'));
    expect(sameNodeBranches(doc)).toEqual([{ x: 40, y: -20 }]);
    // Presentation only: no junction object, the nets are those of the wire endpoints.
    expect(doc.layout.junctions).toEqual([]);
  });

  it('two wires of one node merely crossing, or running one over the other, get no dot', () => {
    expect(sameNodeBranches(crossing())).toEqual([]);
    let doc = base();
    doc = must(addWire(doc, t('PSU1', 'positive'), t('R3', 'a'))).doc; // the same run twice
    expect(sameNodeBranches(doc)).toEqual([]);
  });
});
