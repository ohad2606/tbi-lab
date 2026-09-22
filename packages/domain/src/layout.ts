/**
 * Schematic geometry: grid, rotation, terminal positions and wire routes.
 *
 * All persisted coordinates are integer schematic units. The canvas is a technical, LTR
 * coordinate space; nothing here depends on locale or text direction.
 */

import { getTypeDef } from './catalog.js';
import type { Point, ProjectDocument, Rotation, Wire, WireEnd } from './schema.js';

/** Editor grid pitch in schematic units. Placements and wire points snap to it. */
export const GRID = 20;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

export function snap(value: number): number {
  // `+ 0` normalises -0, which would otherwise survive into the persisted document.
  return Math.round(value / GRID) * GRID + 0;
}

export function snapPoint(p: Point): Point {
  return { x: snap(p.x), y: snap(p.y) };
}

/** Rotate a point clockwise (screen coordinates, y down) about the origin. */
export function rotatePoint(p: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: -p.y + 0, y: p.x + 0 };
    case 180:
      return { x: -p.x + 0, y: -p.y + 0 };
    case 270:
      return { x: p.y + 0, y: -p.x + 0 };
  }
}

export function nextRotation(rotation: Rotation): Rotation {
  return ROTATIONS[(ROTATIONS.indexOf(rotation) + 1) % ROTATIONS.length]!;
}

/** Absolute position of a component terminal, or undefined if it does not exist. */
export function terminalPosition(
  doc: ProjectDocument,
  componentId: string,
  terminalId: string,
): Point | undefined {
  const component = doc.components.find((c) => c.id === componentId);
  const placement = doc.layout.components[componentId];
  if (!component || !placement) return undefined;
  const terminal = getTypeDef(component.type)?.terminals.find((t) => t.id === terminalId);
  if (!terminal) return undefined;
  const r = rotatePoint(terminal.offset, placement.rotation);
  return { x: placement.x + r.x, y: placement.y + r.y };
}

export function endPosition(doc: ProjectDocument, end: WireEnd): Point | undefined {
  if (end.kind === 'terminal') return terminalPosition(doc, end.component, end.terminal);
  const j = doc.layout.junctions.find((jn) => jn.id === end.junction);
  return j ? { x: j.x, y: j.y } : undefined;
}

/**
 * Orthogonal route through the given points: each hop is drawn horizontal leg first, then
 * vertical. Consecutive duplicate points are removed. Splitting a wire at any point on this
 * route and routing both halves the same way reproduces the identical path.
 */
export function orthogonalRoute(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  const push = (p: Point) => {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push({ x: p.x, y: p.y });
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) {
      const prev = points[i - 1]!;
      push({ x: p.x, y: prev.y });
    }
    push(p);
  }
  // Drop collinear middle points so the route is a minimal polyline.
  const minimal: Point[] = [];
  for (const p of out) {
    const a = minimal[minimal.length - 2];
    const b = minimal[minimal.length - 1];
    if (a && b && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) {
      minimal[minimal.length - 1] = p;
    } else {
      minimal.push(p);
    }
  }
  return minimal;
}

/** The drawn polyline of a wire, or undefined if an endpoint no longer resolves. */
export function wireRoute(doc: ProjectDocument, wire: Wire): Point[] | undefined {
  const a = endPosition(doc, wire.from);
  const b = endPosition(doc, wire.to);
  if (!a || !b) return undefined;
  return orthogonalRoute([a, ...wire.vertices, b]);
}

/** Axis-aligned segment containment (inclusive of both ends). */
export function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  if (a.x === b.x) {
    return p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  }
  if (a.y === b.y) {
    return p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
  }
  return false;
}

/**
 * Where `p` lies on a wire's route: the index of the waypoint hop it belongs to (0 = between
 * `from` and the first vertex). Returns undefined if `p` is not on the route.
 */
export function locateOnWire(
  doc: ProjectDocument,
  wire: Wire,
  p: Point,
): { hop: number } | undefined {
  const a = endPosition(doc, wire.from);
  const b = endPosition(doc, wire.to);
  if (!a || !b) return undefined;
  const waypoints = [a, ...wire.vertices, b];
  for (let hop = 0; hop < waypoints.length - 1; hop++) {
    const seg = orthogonalRoute([waypoints[hop]!, waypoints[hop + 1]!]);
    for (let i = 0; i < seg.length - 1; i++) {
      if (pointOnSegment(p, seg[i]!, seg[i + 1]!)) return { hop };
    }
    if (seg.length === 1 && seg[0]!.x === p.x && seg[0]!.y === p.y) return { hop };
  }
  return undefined;
}
