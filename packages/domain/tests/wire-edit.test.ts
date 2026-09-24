/**
 * Sprint 5 pre-push: dragging a wire segment moves only geometry. Endpoints, connectivity and
 * nets never change; the result is always a valid document and a `layout` edit.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  classifyEdit,
  moveWireSegment,
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

/** PSU+ (-80,-20) -> R1.a (20,-20): one straight horizontal segment. */
function straight(): ProjectDocument {
  let doc = must(addComponent(newDoc(), 'component.resistor', { x: 60, y: -20 })).doc;
  doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
  return doc;
}

const route = (doc: ProjectDocument, id = 'W1') =>
  wireRoute(
    doc,
    doc.layout.wires.find((w) => w.id === id)!,
  )!;

function expectSameCircuit(before: ProjectDocument, after: ProjectDocument) {
  expect(validateProject(after)).toEqual([]);
  expect(after.nets).toEqual(before.nets);
  expect(after.connections).toEqual(before.connections);
  expect(after.components).toEqual(before.components);
  expect(after.layout.components).toEqual(before.layout.components);
  const [b, a] = [route(before), route(after)];
  expect(a[0]).toEqual(b[0]); // the ends never move
  expect(a.at(-1)).toEqual(b.at(-1));
  expect(classifyEdit(before, after)).toBe('layout');
}

describe('moveWireSegment', () => {
  it('a straight wire dragged sideways becomes a U with both ends fixed', () => {
    const before = straight();
    const after = must(moveWireSegment(before, 'W1', 0, { x: 13, y: 40 })).doc;
    expect(route(after)).toEqual([
      { x: -80, y: -20 },
      { x: -80, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: -20 },
    ]);
    expectSameCircuit(before, after);
  });

  it('a middle segment moves perpendicular to itself; the others stretch', () => {
    let doc = straight();
    doc = must(moveWireSegment(doc, 'W1', 0, { x: 0, y: 40 })).doc; // U: 3 segments
    const before = doc;
    const after = must(moveWireSegment(before, 'W1', 0, { x: -40, y: 0 })).doc; // first leg
    expect(route(after)).toEqual([
      { x: -80, y: -20 },
      { x: -120, y: -20 },
      { x: -120, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: -20 },
    ]);
    expectSameCircuit(before, after);
    const across = must(moveWireSegment(after, 'W1', 2, { x: 0, y: 20 })).doc; // bottom run
    expect(route(across)[2]).toEqual({ x: -120, y: 40 });
    expect(route(across)[3]).toEqual({ x: 20, y: 40 });
    expectSameCircuit(after, across);
  });

  it('dragging back restores the original straight wire with no stored bends', () => {
    const before = straight();
    const out = must(moveWireSegment(before, 'W1', 0, { x: 0, y: 60 })).doc;
    const back = must(moveWireSegment(out, 'W1', 1, { x: 0, y: -60 })).doc;
    expect(route(back)).toEqual(route(before));
    expect(back.layout.wires[0]!.vertices).toEqual([]);
  });

  it('snaps to the grid; movement along the segment itself changes nothing', () => {
    const before = straight();
    const snapped = must(moveWireSegment(before, 'W1', 0, { x: 0, y: 29 })).doc;
    expect(route(snapped)[1]).toEqual({ x: -80, y: 0 }); // 29 snaps to 20 (grid 20)
    const along = must(moveWireSegment(before, 'W1', 0, { x: 200, y: 0 })).doc;
    expect(along.layout).toEqual(before.layout);
  });

  it('works on wires ending at a junction, and keeps the junction net intact', () => {
    let doc = must(addComponent(newDoc(), 'component.resistor', { x: 60, y: -20 })).doc;
    doc = must(addComponent(doc, 'component.resistor', { x: 60, y: 100 })).doc;
    doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
    // Tap the first wire at (-40,-20): a junction, and a wire from it to R2.a.
    doc = must(
      addWire(doc, { kind: 'wire', wire: 'W1', at: { x: -40, y: -20 } }, t('R2', 'a'), [
        { x: -40, y: 100 },
      ]),
    ).doc;
    const tap = doc.layout.wires.find((w) => w.to.kind === 'terminal' && w.to.component === 'R2')!;
    expect(tap.from.kind).toBe('junction');
    const before = doc;
    const r = route(before, tap.id);
    const after = must(moveWireSegment(before, tap.id, r.length - 2, { x: 0, y: 20 })).doc;
    expect(validateProject(after)).toEqual([]);
    expect(after.nets).toEqual(before.nets);
    expect(after.connections).toEqual(before.connections);
    expect(after.layout.junctions).toEqual(before.layout.junctions);
  });

  it('refuses unknown wires and segments', () => {
    const doc = straight();
    expect(moveWireSegment(doc, 'W9', 0, { x: 0, y: 20 })).toEqual({
      ok: false,
      error: 'unknown_wire',
    });
    expect(moveWireSegment(doc, 'W1', 1, { x: 0, y: 20 })).toEqual({
      ok: false,
      error: 'not_on_wire',
    });
    expect(moveWireSegment(doc, 'W1', -1, { x: 0, y: 20 })).toEqual({
      ok: false,
      error: 'not_on_wire',
    });
  });
});
