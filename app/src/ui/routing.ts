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
  routeAutoWires,
  routeAutoWiresReport,
  repairWireRoutesReport,
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

/**
 * Sprint 20 (s20r4, review B1): the wires the bounded routing could not route with its full
 * search (a very large project), by layout object: the layout is carried unchanged into the
 * stored document (commit stamps only the revision), so the Circuit view can say so.
 */
// s20r5 (review r3, NOTE 6): keyed by the drawing's CONTENT (every wire's id, ends and bends),
// not by the layout object: an edit that does not move a wire (a rename, a value) or an undo makes
// a new layout object with the same drawing, and the note must stay. The key of a layout object
// is computed once (WeakMap); the last 16 drawings are remembered.
const keyOf = new WeakMap<object, string>();
const drawingKey = (layout: ProjectDocument['layout']): string => {
  let k = keyOf.get(layout);
  if (k === undefined) {
    k = JSON.stringify(layout.wires.map((w) => [w.id, w.from, w.to, w.vertices]));
    keyOf.set(layout, k);
  }
  return k;
};
const limitedByDrawing = new Map<string, string[]>();
/** Wires drawn with a simpler shape than the router would give, or left unrepaired (s20r4). */
export const routingLimited = (doc: ProjectDocument): readonly string[] =>
  limitedByDrawing.get(drawingKey(doc.layout)) ?? [];
const remember = (doc: ProjectDocument, ids: readonly string[], keep: readonly string[] = []) => {
  const all = [...new Set([...keep, ...ids])].sort();
  const k = drawingKey(doc.layout);
  limitedByDrawing.delete(k);
  if (all.length) {
    limitedByDrawing.set(k, all);
    while (limitedByDrawing.size > 16)
      limitedByDrawing.delete(limitedByDrawing.keys().next().value!);
  }
  return doc;
};

/** Wire routing integrity: the canonical routes of every automatic wire (domain `routeAutoWires`). */
export const routeAutomatic = (doc: ProjectDocument): ProjectDocument => {
  const r = routeAutoWiresReport(doc, componentBoxes(doc));
  // Manual wires left unrepaired at open keep their mark (their geometry is unchanged).
  const manual = routingLimited(doc).filter((id) =>
    r.doc.layout.wires.some((w) => w.id === id && !w.auto),
  );
  return remember(r.doc, r.degraded, manual);
};

/** The open-time repair of manual wires (domain `repairWireRoutes`), bounded (s20r4). */
export const repairManual = (doc: ProjectDocument): ProjectDocument => {
  const r = repairWireRoutesReport(doc, componentBoxes(doc));
  return remember(r.doc, r.unrepaired);
};

function routed(r: EditResult, components: string[], rigidWires: string[]): EditResult {
  if (!r.ok) return r;
  // Manual wires keep the Sprint 9 repair (re-routed only when their route now breaks a rule).
  // Automatic wires are routed canonically by the store when the edit is applied (routeLayout:
  // one place, every edit), so not here.
  const wires = attachedWires(r.doc, components, rigidWires);
  return wires.length ? { ...r, doc: rerouteWires(r.doc, wires, componentBoxes(r.doc)) } : r;
}

export const moveRouted = (doc: ProjectDocument, sel: Selection, delta: Point): EditResult =>
  routed(moveSelection(doc, sel, delta), sel.components, sel.wires);

/**
 * Wire routing integrity: the drag PREVIEW, bounded for interactive dragging. The selection moves;
 * only the automatic wires attached to it are re-routed, by the router's short shapes alone (no
 * grid search); every other wire keeps its route. Never committed: the drop applies `moveRouted`
 * and the canonical routing (store `routeLayout`).
 */
export function movePreview(source: ProjectDocument, sel: Selection, delta: Point): EditResult {
  const r = moveSelection(source, sel, delta);
  if (!r.ok) return r;
  const attached = attachedWires(r.doc, sel.components, sel.wires);
  // Manual wires: the same Sprint 9 repair as the drop (they are never recomputed canonically).
  const doc = attached.length ? rerouteWires(r.doc, attached, componentBoxes(r.doc)) : r.doc;
  const only = new Set([...attached, ...sel.wires]);
  return { ...r, doc: routeAutoWires(doc, componentBoxes(doc), { only }) };
}

export const rotateRouted = (doc: ProjectDocument, ids: string[]): EditResult =>
  routed(rotateComponents(doc, ids), ids, []);
