/**
 * Sprint 13 OS-04 (Owner Smoke, P0): component bodies must not overlap, by ONE rule that holds in
 * the Circuit view and in the 3D view derived from it.
 *
 * A pair of parts overlaps when either
 * - their PHYSICAL bodies collide at the transform the 3D view derives from the 2D layout (the
 *   3D view's own collision volumes, scene.ts `collisionBodies`, and test, separation.ts
 *   `bodiesCollide`: real dimensions, deeper than 0.4 mm on both plan axes, heights overlapping);
 *   or
 * - their 2D symbols overlap by more than INSET_2D on both axes (a symbol drawn into another).
 * Parts meant to touch are exempt from the PHYSICAL test only, exactly as in the 3D view: parts
 * joined by a direct terminal-to-terminal contact, and parts whose terminals touch (one rigid
 * cluster each; a module on its header). Not from the symbol test: two parts joined end to end
 * meet only at a box edge (within INSET_2D), while a part dropped onto another also has touching
 * terminals and must still count.
 *
 * Pure (no WebGL). The edit gate (state/app.ts) refuses an edit that creates a new overlap for a
 * part it adds, moves or rotates; overlaps already present in an opened project are reported, not
 * removed (the 3D view's visual separation stays as the safety net for those).
 */
import { contacts, touchingUnconnected, type ProjectDocument } from '@tbi-lab/domain';
import { componentBox } from '../ui/routing.js';
import { collisionBodies } from '../views/scene3d/scene.js';
import { bodiesCollide } from '../views/scene3d/separation.js';

/** Layout units a symbol may reach into another's box (anti-aliasing and lead tips). */
export const INSET_2D = 2;

export interface Overlap {
  a: string;
  b: string;
  /** Which geometry overlaps: the symbols, the physical bodies, or both. */
  in: 'circuit' | '3d' | 'both';
}

/** Clusters of parts allowed to touch (direct contacts, touching terminals). */
function clusters(doc: ProjectDocument): (id: string) => string {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  for (const w of contacts(doc))
    if (w.from.kind === 'terminal' && w.to.kind === 'terminal')
      join(w.from.component, w.to.component);
  for (const t of touchingUnconnected(doc)) {
    const [first, ...rest] = t.terminals.map((e) => e.component);
    for (const r of rest) join(first!, r);
  }
  return find;
}

/**
 * Overlapping pairs, each once, in document order. With `only`, just the pairs with at least one
 * member in it (the parts an edit placed).
 */
export function bodyOverlaps(doc: ProjectDocument, only?: ReadonlySet<string>): Overlap[] {
  const cluster = clusters(doc);
  const bodies = new Map(collisionBodies(doc).map((b) => [b.id, b]));
  const placed = doc.components.filter((c) => doc.layout.components[c.id]);
  const boxes = new Map(placed.map((c) => [c.id, componentBox(doc, c)]));
  const out: Overlap[] = [];
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!.id;
      const b = placed[j]!.id;
      if (only && !only.has(a) && !only.has(b)) continue;
      const ba = boxes.get(a)!;
      const bb = boxes.get(b)!;
      const circuit =
        Math.min(ba.maxX, bb.maxX) - Math.max(ba.minX, bb.minX) > INSET_2D &&
        Math.min(ba.maxY, bb.maxY) - Math.max(ba.minY, bb.minY) > INSET_2D;
      const pa = bodies.get(a);
      const pb = bodies.get(b);
      const physical = !!pa && !!pb && cluster(a) !== cluster(b) && bodiesCollide(pa, pb);
      if (circuit || physical)
        out.push({ a, b, in: circuit && physical ? 'both' : circuit ? 'circuit' : '3d' });
    }
  return out;
}
