/**
 * "Fit" for the 2D views (BETA-G3; WCAG 2.4.11): the whole drawing, with nothing under the view
 * controls or the message along the bottom. Items are world boxes; overlays are screen pixels
 * relative to the view. A large view, where nothing meets an overlay, is fitted as if there
 * were none. `extent` is what is centred and framed there (default: the box around the items); it
 * may be wider than the items (room for labels) or narrower (labels that only have to stay clear:
 * when room is made for the overlays, everything is kept in view).
 */
import type { Box } from './revealDelta.js';

export interface FitOptions {
  /** World units around the drawing when nothing is in the way (room for labels). */
  marginX: number;
  marginY: number;
  /** World units kept between the drawing and an overlay or edge that room was made for. */
  pad: number;
  min: number;
  max: number;
}

export interface Camera2d {
  x: number;
  y: number;
  scale: number;
}

type Insets = { left: number; right: number; top: number; bottom: number };

/** Screen pixels kept between an item and an overlay. */
const GAP = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The side of the view an overlay hangs on: the one that costs the least room to keep free. */
function insetFor(o: Box, size: { w: number; h: number }): Partial<Insets> {
  const sides: [keyof Insets, number][] = [
    ['left', o.right / size.w],
    ['right', (size.w - o.left) / size.w],
    ['top', o.bottom / size.h],
    ['bottom', (size.h - o.top) / size.h],
  ];
  const [side, share] = sides.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { [side]: share * (side === 'left' || side === 'right' ? size.w : size.h) + GAP };
}

/** The box around some boxes (at least one). */
export function boundsOf(boxes: readonly Box[]): Box {
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    right: Math.max(...boxes.map((b) => b.right)),
    top: Math.min(...boxes.map((b) => b.top)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/**
 * The world boxes of drawn elements (labels, net marks), which only the browser can measure. For
 * elements with no transform between them and the drawing; empty (hidden) ones are left out.
 */
export function drawnBoxes(svg: Element, selector: string): Box[] {
  return [...svg.querySelectorAll<SVGGraphicsElement>(selector)].flatMap((el) => {
    const r = el.getBBox();
    return r.width && r.height
      ? [{ left: r.x, right: r.x + r.width, top: r.y, bottom: r.y + r.height }]
      : [];
  });
}

export function fitCamera(
  items: readonly Box[],
  size: { w: number; h: number },
  overlays: readonly Box[],
  { marginX, marginY, pad, min, max }: FitOptions,
  extent?: Box,
): Camera2d {
  if (!items.length) return { x: -size.w / 2, y: -size.h / 2, scale: 1 };
  const frame = extent ?? boundsOf(items);
  const { left, right, top, bottom } = frame;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  // What must stay in view when room is made: the frame, and any item reaching beyond it.
  const all = boundsOf([frame, ...items]);
  const base = clamp(
    Math.min(size.w / (right - left + 2 * marginX), size.h / (bottom - top + 2 * marginY)),
    min,
    max,
  );

  const covered = (c: Camera2d) =>
    items.some((b) =>
      overlays.some(
        (o) =>
          (b.left - c.x) * c.scale < o.right + GAP / 2 &&
          o.left - GAP / 2 < (b.right - c.x) * c.scale &&
          (b.top - c.y) * c.scale < o.bottom + GAP / 2 &&
          o.top - GAP / 2 < (b.bottom - c.y) * c.scale,
      ),
    );

  /** Centred in the view, moved (and if need be shrunk) no more than the insets require. */
  const within = (insets: Insets): Camera2d => {
    const w = Math.max(1, size.w - insets.left - insets.right);
    const h = Math.max(1, size.h - insets.top - insets.bottom);
    const width = all.right - all.left;
    const height = all.bottom - all.top;
    const scale = clamp(Math.min(base, w / (width + 2 * pad), h / (height + 2 * pad)), min, max);
    // Screen position of the drawing's centre along one axis.
    const place = (view: number, lo: number, room: number, span: number) => {
      const half = (span / 2 + pad) * scale;
      return 2 * half > room ? lo + room / 2 : clamp(view / 2, lo + half, lo + room - half);
    };
    return {
      scale,
      x: (all.left + all.right) / 2 - place(size.w, insets.left, w, width) / scale,
      y: (all.top + all.bottom) / 2 - place(size.h, insets.top, h, height) / scale,
    };
  };

  const centred = { scale: base, x: cx - size.w / base / 2, y: cy - size.h / base / 2 };
  if (!covered(centred)) return centred;

  // Room for some or all of the overlays: the largest drawing that leaves everything clear.
  let choices: Insets[] = [{ left: 0, right: 0, top: 0, bottom: 0 }];
  for (const o of overlays) {
    const add = insetFor(o, size);
    choices = choices.flatMap((c) => {
      const next = { ...c };
      for (const [k, v] of Object.entries(add) as [keyof Insets, number][])
        next[k] = Math.max(next[k], v);
      return [c, next];
    });
  }
  let best: Camera2d | undefined;
  for (const choice of choices) {
    const camera = within(choice);
    if (!covered(camera) && (!best || camera.scale > best.scale + 1e-9)) best = camera;
  }
  // Nothing clears everything (a very small view): keep room for all of them.
  return best ?? within(choices[choices.length - 1]!);
}

/** The overlays of a view as screen boxes relative to its drawing (empty ones left out). */
export function overlayBoxes(view: Element, overlays: (Element | null)[]): Box[] {
  const at = view.getBoundingClientRect();
  return overlays.flatMap((el) => {
    const r = el?.getBoundingClientRect();
    return r && r.width && r.height
      ? [
          {
            left: r.left - at.left,
            right: r.right - at.left,
            top: r.top - at.top,
            bottom: r.bottom - at.top,
          },
        ]
      : [];
  });
}
