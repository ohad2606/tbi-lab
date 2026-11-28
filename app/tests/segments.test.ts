/** BETA-G3: the pure logic of the Inspector's segment move (orientation, choice, following). */
import { addComponent, addWire, createProject, wireRoute } from '@tbi-lab/domain';
import { describe, expect, it } from 'vitest';
import { moveRouted } from '../src/ui/routing.js';
import {
  clampSegment,
  followSegment,
  isHorizontalSegment,
  isWireUnmoved,
  segmentDirections,
} from '../src/ui/segments.js';

const p = (x: number, y: number) => ({ x, y });
const route = [p(0, 0), p(40, 0), p(40, 60), p(100, 60)];

describe('segment orientation and directions', () => {
  it('reads orientation from the route', () => {
    expect([0, 1, 2].map((i) => isHorizontalSegment(route, i))).toEqual([true, false, true]);
  });
  it('offers only the two perpendicular directions', () => {
    expect(segmentDirections(true)).toEqual(['up', 'down']);
    expect(segmentDirections(false)).toEqual(['left', 'right']);
  });
});

describe('clampSegment', () => {
  it('starts on the middle segment', () => {
    expect(clampSegment(undefined, 1)).toBe(0);
    expect(clampSegment(undefined, 3)).toBe(1);
    expect(clampSegment(undefined, 4)).toBe(1);
  });
  it('keeps a chosen index and clamps it when the route got shorter', () => {
    expect(clampSegment(2, 5)).toBe(2);
    expect(clampSegment(4, 3)).toBe(2);
    expect(clampSegment(-1, 3)).toBe(0);
  });
});

describe('followSegment', () => {
  it('follows the first segment past the jog added at the fixed end', () => {
    const after = [p(0, 0), p(0, -20), p(40, -20), p(40, 60), p(100, 60)];
    expect(followSegment(route, 0, p(0, -20), after)).toBe(1);
  });
  it('keeps the index of an inner segment', () => {
    const after = [p(0, 0), p(60, 0), p(60, 60), p(100, 60)];
    expect(followSegment(route, 1, p(20, 0), after)).toBe(1);
  });
  it('finds the segment it merged into', () => {
    // The middle segment of a U lands on the line of its neighbour: they become one.
    const before = [p(0, 0), p(0, 20), p(40, 20), p(40, 0), p(80, 0)];
    const after = [p(0, 0), p(80, 0)];
    expect(followSegment(before, 1, p(0, -20), after)).toBe(0);
  });
  it('falls back to a clamped index when nothing lies on the moved line', () => {
    expect(followSegment(route, 2, p(0, 20), [p(0, 0), p(10, 0)])).toBe(0);
  });
});

describe('isWireUnmoved', () => {
  const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as Extract<T, { ok: true }>;
  };
  // R1.b to R2.a: a straight wire with no stored bends and no automatic routing.
  const base = createProject({
    projectId: 'prj_g3unmoved',
    deviceId: 'device-test',
    name: 'unmoved',
    appVersion: '0.1.0',
    clock: { now: () => new Date('2026-11-27T00:00:00.000Z') },
  });
  const r1 = must(addComponent(base, 'component.resistor', p(0, -160))).doc;
  const r2 = must(addComponent(r1, 'component.resistor', p(140, -160))).doc;
  const pin = (component: string, terminal: string) =>
    ({ kind: 'terminal', component, terminal }) as const;
  const doc = must(addWire(r2, pin('R1', 'b'), pin('R2', 'a'), [])).doc;
  const wire = doc.layout.wires[0]!;
  wire.vertices = [];
  delete wire.auto;
  const move = (components: string[]) =>
    must(moveRouted(doc, { components, wires: [wire.id], junctions: [] }, p(0, 20))).doc;

  it.each([[['R1', 'R2']], [['R2']]])('is false when %j carry or stretch the wire', (parts) => {
    const after = move(parts);
    // The stored wire is the same; only the drawn route shows the move.
    expect(after.layout.wires[0]).toEqual(wire);
    expect(wireRoute(after, wire)).not.toEqual(wireRoute(doc, wire));
    expect(isWireUnmoved(doc, after, wire.id)).toBe(false);
  });
  it('is true for a wire alone, which has nothing of its own to move', () => {
    expect(isWireUnmoved(doc, move([]), wire.id)).toBe(true);
  });
  it('is false when only the stored bends changed', () => {
    const after = structuredClone(doc);
    after.layout.wires[0]!.vertices = [p(70, -160)];
    expect(isWireUnmoved(doc, after, wire.id)).toBe(false);
  });
});
