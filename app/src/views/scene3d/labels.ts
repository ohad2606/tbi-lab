/**
 * Where each reference label is printed on the bench (realism pass): beside its part, never on
 * another part's footprint or another label. Deterministic: candidates in a fixed order (in front
 * of the part, to its right, to its left, behind it, then further out in front), the first that is
 * clear wins; parts are handled in scene order. Pure: no WebGL (unit-tested).
 */
import { rotatePoint } from '@tbi-lab/domain';
import { FOOTPRINT, type SceneComponent } from './scene.js';

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** A part's footprint on the bench, world mm. */
export function footprintRect(c: SceneComponent): Rect {
  const [x0, x1, z0, z1] = FOOTPRINT[c.model];
  const r: Rect = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const [x, z] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ] as const) {
    const p = rotatePoint({ x, y: z }, c.rotation);
    r.x0 = Math.min(r.x0, c.x + p.x);
    r.x1 = Math.max(r.x1, c.x + p.x);
    r.z0 = Math.min(r.z0, c.z + p.y);
    r.z1 = Math.max(r.z1, c.z + p.y);
  }
  return r;
}

const overlaps = (a: Rect, b: Rect, pad: number) =>
  a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.z0 < b.z1 + pad && b.z0 < a.z1 + pad;

/**
 * Label centres for the parts, given each label's size (w along x, h along z), mm, and the gap
 * between a part's footprint and its label.
 */
export function placeLabels(
  parts: { c: SceneComponent; w: number; h: number }[],
  gap: number,
): Map<string, { x: number; z: number }> {
  const feet = parts.map((p) => footprintRect(p.c));
  const placed: Rect[] = [];
  const out = new Map<string, { x: number; z: number }>();
  parts.forEach(({ c, w, h }, i) => {
    const f = feet[i]!;
    const cx = (f.x0 + f.x1) / 2;
    const cz = (f.z0 + f.z1) / 2;
    const at = (x: number, z: number): Rect => ({
      x0: x - w / 2,
      x1: x + w / 2,
      z0: z - h / 2,
      z1: z + h / 2,
    });
    const candidates: [number, number][] = [
      [cx, f.z1 + gap + h / 2],
      [f.x1 + gap + w / 2, cz],
      [f.x0 - gap - w / 2, cz],
      [cx, f.z0 - gap - h / 2],
      [cx, f.z1 + gap + h * 1.6],
      [f.x1 + gap + w / 2, f.z1 + gap + h / 2],
    ];
    const clear = (r: Rect) =>
      feet.every((g, j) => j === i || !overlaps(r, g, 0.3)) &&
      placed.every((p) => !overlaps(r, p, 0.6));
    const [x, z] = candidates.find(([x, z]) => clear(at(x, z))) ?? candidates[0]!;
    placed.push(at(x, z));
    out.set(c.id, { x, z });
  });
  return out;
}
