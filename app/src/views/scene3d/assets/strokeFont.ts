/**
 * A single-line (stroke) font for printed markings on 3D parts (Sprint 10 realism pass).
 *
 * PCB silkscreen and part markings are plotted with vector stroke fonts, not typeset: uniform line
 * weight, round pen ends, simple geometric letterforms. Drawing them with the browser's text
 * fonts gives the sterile "UI label" look and depends on the fonts installed on each computer;
 * this font is the same everywhere, original to this project, and covers what the models print
 * (upper case, digits, a few lower-case letters and symbols).
 *
 * Glyphs: polylines on a grid 4 units wide (some narrower), cap height 6, baseline 0, y up.
 */

type Stroke = [number, number][];
interface Glyph {
  w: number;
  s: Stroke[];
}

const g = (s: Stroke[], w = 4): Glyph => ({ w, s });
const O: Stroke = [
  [1, 0],
  [3, 0],
  [4, 1],
  [4, 5],
  [3, 6],
  [1, 6],
  [0, 5],
  [0, 1],
  [1, 0],
];

const GLYPHS: Record<string, Glyph> = {
  ' ': g([], 2.5),
  '0': g([O]),
  '1': g([
    [
      [1, 5],
      [2, 6],
      [2, 0],
    ],
    [
      [1, 0],
      [3, 0],
    ],
  ]),
  '2': g([
    [
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [0, 0],
      [4, 0],
    ],
  ]),
  '3': g([
    [
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
      [1.5, 3],
    ],
    [
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ]),
  '4': g([
    [
      [3, 0],
      [3, 6],
      [0, 2],
      [4, 2],
    ],
  ]),
  '5': g([
    [
      [4, 6],
      [0, 6],
      [0, 3.5],
      [3, 3.5],
      [4, 2.5],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ]),
  '6': g([
    [
      [3.8, 5.4],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 2.5],
      [3, 3.5],
      [1, 3.5],
      [0, 2.5],
    ],
  ]),
  '7': g([
    [
      [0, 6],
      [4, 6],
      [1.5, 0],
    ],
  ]),
  '8': g([
    [
      [1, 3],
      [0, 4],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
      [1, 3],
      [0, 2],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 2],
      [3, 3],
    ],
  ]),
  '9': g([
    [
      [0.2, 0.6],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 3.5],
      [1, 2.5],
      [3, 2.5],
      [4, 3.5],
    ],
  ]),
  A: g([
    [
      [0, 0],
      [2, 6],
      [4, 0],
    ],
    [
      [0.7, 2],
      [3.3, 2],
    ],
  ]),
  B: g([
    [
      [0, 0],
      [0, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
      [0, 3],
    ],
    [
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [0, 0],
    ],
  ]),
  C: g([
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
    ],
  ]),
  D: g([
    [
      [0, 0],
      [0, 6],
      [2.5, 6],
      [4, 4.5],
      [4, 1.5],
      [2.5, 0],
      [0, 0],
    ],
  ]),
  E: g([
    [
      [4, 6],
      [0, 6],
      [0, 0],
      [4, 0],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ]),
  F: g([
    [
      [4, 6],
      [0, 6],
      [0, 0],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ]),
  G: g([
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 3],
      [2.5, 3],
    ],
  ]),
  H: g([
    [
      [0, 0],
      [0, 6],
    ],
    [
      [4, 0],
      [4, 6],
    ],
    [
      [0, 3],
      [4, 3],
    ],
  ]),
  I: g(
    [
      [
        [1, 0],
        [1, 6],
      ],
      [
        [0, 0],
        [2, 0],
      ],
      [
        [0, 6],
        [2, 6],
      ],
    ],
    2,
  ),
  J: g([
    [
      [4, 6],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ]),
  K: g([
    [
      [0, 0],
      [0, 6],
    ],
    [
      [4, 6],
      [0, 2],
    ],
    [
      [1.3, 3.3],
      [4, 0],
    ],
  ]),
  L: g([
    [
      [0, 6],
      [0, 0],
      [4, 0],
    ],
  ]),
  M: g(
    [
      [
        [0, 0],
        [0, 6],
        [2.25, 2.5],
        [4.5, 6],
        [4.5, 0],
      ],
    ],
    4.5,
  ),
  N: g([
    [
      [0, 0],
      [0, 6],
      [4, 0],
      [4, 6],
    ],
  ]),
  O: g([O]),
  P: g([
    [
      [0, 0],
      [0, 6],
      [3, 6],
      [4, 5],
      [4, 3.5],
      [3, 2.5],
      [0, 2.5],
    ],
  ]),
  Q: g([
    O,
    [
      [2.5, 1.5],
      [4, 0],
    ],
  ]),
  R: g([
    [
      [0, 0],
      [0, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
      [0, 3],
    ],
    [
      [2, 3],
      [4, 0],
    ],
  ]),
  S: g([
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 4],
      [1, 3],
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ]),
  T: g([
    [
      [0, 6],
      [4, 6],
    ],
    [
      [2, 6],
      [2, 0],
    ],
  ]),
  U: g([
    [
      [0, 6],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 6],
    ],
  ]),
  V: g([
    [
      [0, 6],
      [2, 0],
      [4, 6],
    ],
  ]),
  W: g(
    [
      [
        [0, 6],
        [1.1, 0],
        [2.5, 4],
        [3.9, 0],
        [5, 6],
      ],
    ],
    5,
  ),
  X: g([
    [
      [0, 0],
      [4, 6],
    ],
    [
      [0, 6],
      [4, 0],
    ],
  ]),
  Y: g([
    [
      [0, 6],
      [2, 3],
      [4, 6],
    ],
    [
      [2, 3],
      [2, 0],
    ],
  ]),
  Z: g([
    [
      [0, 6],
      [4, 6],
      [0, 0],
      [4, 0],
    ],
  ]),
  o: g([
    [
      [1, 0],
      [3, 0],
      [4, 1],
      [4, 3],
      [3, 4],
      [1, 4],
      [0, 3],
      [0, 1],
      [1, 0],
    ],
  ]),
  t: g(
    [
      [
        [1.2, 5.5],
        [1.2, 1],
        [2.2, 0],
        [3, 0],
      ],
      [
        [0, 4],
        [3, 4],
      ],
    ],
    3,
  ),
  '-': g([
    [
      [0.5, 3],
      [3.5, 3],
    ],
  ]),
  '+': g([
    [
      [0.5, 3],
      [3.5, 3],
    ],
    [
      [2, 1.5],
      [2, 4.5],
    ],
  ]),
  '.': g(
    [
      [
        [0.6, 0],
        [0.6, 0.05],
      ],
    ],
    1.2,
  ),
  ':': g(
    [
      [
        [0.6, 0.6],
        [0.6, 0.65],
      ],
      [
        [0.6, 4],
        [0.6, 4.05],
      ],
    ],
    1.2,
  ),
  '/': g([
    [
      [0, 0],
      [4, 6],
    ],
  ]),
  '(': g(
    [
      [
        [2, 6.3],
        [1, 5],
        [1, 1],
        [2, -0.3],
      ],
    ],
    2.5,
  ),
  ')': g(
    [
      [
        [0.5, 6.3],
        [1.5, 5],
        [1.5, 1],
        [0.5, -0.3],
      ],
    ],
    2.5,
  ),
};

/** Space between glyphs, in grid units. */
const GAP = 1.6;

/** Width of `text` in grid units (cap height 6). */
export function strokeWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += (GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS[' ']!).w + GAP;
  return Math.max(0, w - GAP);
}

export interface StrokeOptions {
  /** Cap height, px. */
  height: number;
  align?: 'left' | 'center' | 'right';
  /** Rotation about (x, y), radians, counter-clockwise on screen is negative (canvas convention). */
  rotate?: number;
  /** Pen width as a fraction of the cap height (silkscreen ~0.15, laser marking ~0.09). */
  weight?: number;
  /** Vertical anchor: the text's middle (default) or its baseline. */
  baseline?: 'middle' | 'bottom';
}

/** Plot `text` with the current strokeStyle; (x, y) is the anchor (see options). */
export function strokeText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  o: StrokeOptions,
): void {
  const k = o.height / 6;
  const width = strokeWidth(text) * k;
  ctx.save();
  ctx.translate(x, y);
  if (o.rotate) ctx.rotate(o.rotate);
  const x0 = o.align === 'center' ? -width / 2 : o.align === 'right' ? -width : 0;
  const y0 = o.baseline === 'bottom' ? 0 : o.height / 2;
  ctx.lineWidth = Math.max(0.5, (o.weight ?? 0.15) * o.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let cx = x0;
  for (const ch of text) {
    const glyph = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS[' ']!;
    for (const s of glyph.s) {
      s.forEach(([gx, gy], i) => {
        const px = cx + gx * k;
        const py = y0 - gy * k;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
    }
    cx += (glyph.w + GAP) * k;
  }
  ctx.stroke();
  ctx.restore();
}

/** Characters the font draws (tests: every marking the models print is covered). */
export const STROKE_CHARACTERS = new Set(Object.keys(GLYPHS));
