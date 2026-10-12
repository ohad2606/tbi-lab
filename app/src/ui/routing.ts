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
import { LCD_WINDOW, SYMBOLS } from './symbols.js';
import {
  LCD1602_MODULE,
  LED_MATRIX_1088AS,
  MM_PER_LAYOUT_UNIT,
} from '../views/scene3d/physical.js';

type Rect = [minX: number, minY: number, maxX: number, maxY: number];
const unite = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
/** A physical face (centre and size, mm) in layout units. */
const physicalFace = (cx: number, cz: number, w: number, h: number): Rect => {
  const u = MM_PER_LAYOUT_UNIT;
  return [(cx - w / 2) / u, (cz - h / 2) / u, (cx + w / 2) / u, (cz + h / 2) / u];
};

/**
 * Sprint 13 OS-05: the display faces a wire must not cover, in the part's own frame (layout
 * units): the union of the face as the Circuit view draws it and the real face as the 3D view
 * shows it (the LCD module is twice its symbol's width), so a route clear of it in 2D is clear of
 * it in 3D too.
 */
const L = LCD1602_MODULE;
const M = LED_MATRIX_1088AS;
export const DISPLAY_FACES: Readonly<Partial<Record<string, Rect>>> = {
  'display.lcd1602_i2c': unite(
    [LCD_WINDOW.x, LCD_WINDOW.y, LCD_WINDOW.x + LCD_WINDOW.w, LCD_WINDOW.y + LCD_WINDOW.h],
    physicalFace(L.pcbLeftXMm + L.pcbXMm / 2, L.pcbCentreZMm, L.bezelXMm, L.bezelZMm),
  ),
  'display.led_matrix_8x8': unite([-100, -100, 80, 100], physicalFace(0, 0, M.sizeMm, M.sizeMm)),
};

/** World-space display faces of the placed parts (route obstacles marked `display`). */
export function displayBoxes(doc: ProjectDocument): RouteBox[] {
  return doc.components.flatMap((c) => {
    const face = DISPLAY_FACES[c.type];
    const p = doc.layout.components[c.id];
    if (!face || !p) return [];
    const corners = [
      { x: face[0], y: face[1] },
      { x: face[2], y: face[1] },
      { x: face[0], y: face[3] },
      { x: face[2], y: face[3] },
    ].map((q) => rotatePoint(q, p.rotation));
    const xs = corners.map((q) => q.x + p.x);
    const ys = corners.map((q) => q.y + p.y);
    return [
      {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
        display: true,
      },
    ];
  });
}

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

/** Component bodies plus display faces (OS-05): everything the router keeps wires off. */
export const componentBoxes = (doc: ProjectDocument): RouteBox[] => [
  ...doc.components.map((c) => componentBox(doc, c)),
  ...displayBoxes(doc),
];

function routed(r: EditResult, components: string[], rigidWires: string[]): EditResult {
  if (!r.ok) return r;
  const wires = attachedWires(r.doc, components, rigidWires);
  return wires.length ? { ...r, doc: rerouteWires(r.doc, wires, componentBoxes(r.doc)) } : r;
}

export const moveRouted = (doc: ProjectDocument, sel: Selection, delta: Point): EditResult =>
  routed(moveSelection(doc, sel, delta), sel.components, sel.wires);

export const rotateRouted = (doc: ProjectDocument, ids: string[]): EditResult =>
  routed(rotateComponents(doc, ids), ids, []);
