/**
 * Placement edits with routing (Sprint 9): a move or rotation, then the wires it drags along are
 * re-routed where their stored route now runs along a header, through a body or over unrelated
 * terminals (domain `rerouteWires`). Endpoints never change, so connectivity cannot either; the
 * symbol bodies the router avoids are the canvas symbols' boxes.
 */
import {
  attachedWires,
  moveSelection,
  rerouteWires,
  rotateComponents,
  rotatePoint,
  type ComponentInstance,
  type EditResult,
  type Point,
  type ProjectDocument,
  type RouteBox,
  type Selection,
} from '@tbi-lab/domain';
import { SYMBOLS } from './symbols.js';

/** World-space bounding box of a placed component (rotation applied). */
export function componentBox(doc: ProjectDocument, c: ComponentInstance): RouteBox {
  const p = doc.layout.components[c.id]!;
  const [x0, y0, x1, y1] = SYMBOLS[c.type].bbox;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
  ].map((q) => rotatePoint(q, p.rotation));
  const xs = corners.map((q) => q.x + p.x);
  const ys = corners.map((q) => q.y + p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export const componentBoxes = (doc: ProjectDocument): RouteBox[] =>
  doc.components.map((c) => componentBox(doc, c));

function routed(r: EditResult, components: string[], rigidWires: string[]): EditResult {
  if (!r.ok) return r;
  const wires = attachedWires(r.doc, components, rigidWires);
  return wires.length ? { ...r, doc: rerouteWires(r.doc, wires, componentBoxes(r.doc)) } : r;
}

export const moveRouted = (doc: ProjectDocument, sel: Selection, delta: Point): EditResult =>
  routed(moveSelection(doc, sel, delta), sel.components, sel.wires);

export const rotateRouted = (doc: ProjectDocument, ids: string[]): EditResult =>
  routed(rotateComponents(doc, ids), ids, []);
