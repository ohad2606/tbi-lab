/**
 * Visual-only separation of physical bodies (Sprint 10, owner review): the 2D circuit places each
 * part by its SYMBOL, but in 3D a part has its REAL size, which can be much larger (an HC-SR501
 * board is 32 x 24 mm, its 2D symbol 17.5 x 12.7 mm). Two parts placed acceptably in 2D can
 * then cut into each other in 3D. This pass moves bodies apart in the derived scene only:
 *
 *   2D project position -> base 3D transform -> physical collision check
 *     -> minimal visual-only separation -> final 3D transform
 *
 * The project is never touched: no coordinate, rotation, terminal or connection changes. Only the
 * scene's plan position of a part moves; its terminals, wire ends, contacts and label follow it
 * (scene.ts derives them from the final transform, and keeps the 2D-derived placement if a move
 * would make wires of different nets touch).
 *
 * Collision volumes (scene.ts collisionBoxes): each part is a few axis-aligned boxes in its own
 * frame, each with a height range above the bench: by default its physical footprint from the
 * bench to its top (conservative for irregular parts); a module raised on a pin header (the PIR
 * board) is its board at its real height plus the header below it, so a low part may sit under
 * its edge as on a real bench. A wired pin UNDER a body adds the strip its wire leaves by at pin
 * level (tagged with the pin's node): it may touch parts that have a terminal on that node, never
 * others. Wires are not obstacles here; they are re-routed and re-shaped from the final positions.
 *
 * Allowed to touch (never separated): parts joined by a direct terminal-to-terminal contact, and
 * parts whose terminals touch in 2D without a connection (drawn as an open joint). Each such
 * cluster is one rigid unit: it moves as a whole, and its members are not tested against each
 * other. A jumper housing belongs to the board it is plugged into.
 *
 * Resolution (deterministic, no randomness; units in document order):
 * - an overlap counts only when it is deeper than TOLERANCE on both plan axes and the heights
 *   overlap (parts that merely touch, as close passives do, stay where 2D put them);
 * - of an overlapping pair, the LESS anchored unit moves: class (board > supply > ground > large
 *   module > small part), then larger plan area, then earlier in the document stays;
 * - it moves along one plan axis (never rotated, never lifted) by the smallest distance that
 *   clears the other unit by GAP; of the four directions the one that creates no new overlap
 *   wins, shorter first (ties: +x, -x, +z, -z);
 * - the cap: a part may drift at most half its larger plan dimension, between MIN_CAP and MAX_CAP
 *   (a 32 mm module up to 16 mm, a resistor 6.7 mm); if the mover cannot clear within its cap the
 *   other unit is tried (never the board: the MCU stays where 2D put it); if neither can, the
 *   pair keeps its position and is reported as UNRESOLVED (the 3D view shows a non-blocking
 *   notice) instead of scattering the circuit;
 * - repeated until no overlap is left or ROUNDS passes (a move may uncover another overlap).
 * Pure: no WebGL (unit-tested, app/tests/separation.test.ts).
 */
import { rotatePoint, type Rotation } from '@tbi-lab/domain';
import type { ModelKey } from './scene.js';

/** A collision box in the part's frame (rotation 0), mm; `node`: a wired pin's approach strip. */
export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
  node?: string;
}

/** A part as placed by the 2D layout (base transform), scene mm. */
export interface Body {
  id: string;
  model: ModelKey;
  x: number;
  z: number;
  rotation: Rotation;
  boxes: Box[];
  /** Nodes of the part's terminals (an approach strip of one of them may touch it). */
  nodes: readonly string[];
}

export interface SeparationResult {
  /** Visual offset of each part that moved (scene mm, plan only). */
  offsets: Map<string, { dx: number; dz: number }>;
  /** Pairs of parts that still overlap after the capped resolution (ids, sorted). */
  unresolved: [string, string][];
}

/** Overlap depth below which bodies count as touching, not colliding (mm). */
export const TOLERANCE = 0.4;
/** Clearance left between separated bodies (mm): two risers at facing lead ends stay apart. */
export const GAP = 1.0;
export const MIN_CAP = 4;
export const MAX_CAP = 16;
const ROUNDS = 48;
const BOARD = 5;

/** How anchored a part is (higher stays closer to its 2D position). */
const CLASS: Partial<Record<ModelKey, number>> = {
  'board.esp32_devkitc': BOARD,
  'instrument.psu': 4,
  'ground.post': 3,
  'sensor.pir': 2,
  'display.matrix': 2,
  'relay.cube': 2,
  'buzzer.can': 2,
};

export interface Placed extends Box {
  owner: Body;
}

/** A body's boxes in world space at a plan offset. */
export function worldBoxes(b: Body, dx = 0, dz = 0): Placed[] {
  return b.boxes.map((box) => {
    const r: Placed = {
      ...box,
      x0: Infinity,
      x1: -Infinity,
      z0: Infinity,
      z1: -Infinity,
      owner: b,
    };
    for (const [x, z] of [
      [box.x0, box.z0],
      [box.x1, box.z0],
      [box.x0, box.z1],
      [box.x1, box.z1],
    ] as const) {
      const p = rotatePoint({ x, y: z }, b.rotation);
      r.x0 = Math.min(r.x0, b.x + dx + p.x);
      r.x1 = Math.max(r.x1, b.x + dx + p.x);
      r.z0 = Math.min(r.z0, b.z + dz + p.y);
      r.z1 = Math.max(r.z1, b.z + dz + p.y);
    }
    return r;
  });
}

/** Whether two placed boxes collide (an approach strip may touch a part on its node). */
export function collide(a: Placed, b: Placed): boolean {
  if (a.node && (a.node === b.node || b.owner.nodes.includes(a.node))) return false;
  if (b.node && a.owner.nodes.includes(b.node)) return false;
  return (
    Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > TOLERANCE &&
    Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > TOLERANCE &&
    Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0
  );
}

/** Whether two bodies collide at the given offsets. */
export function bodiesCollide(a: Body, b: Body, oa = { dx: 0, dz: 0 }, ob = { dx: 0, dz: 0 }) {
  const pa = worldBoxes(a, oa.dx, oa.dz);
  const pb = worldBoxes(b, ob.dx, ob.dz);
  return pa.some((p) => pb.some((q) => collide(p, q)));
}

interface Unit {
  index: number;
  members: Body[];
  dx: number;
  dz: number;
  rank: [number, number];
  cap: number;
}

/**
 * Separate overlapping bodies. `groups`: clusters of part ids that may touch (direct contacts,
 * touching terminals); every other part is its own unit.
 */
export function separateBodies(
  bodies: readonly Body[],
  groups: readonly (readonly string[])[] = [],
  rounds = ROUNDS,
): SeparationResult {
  // Rigid units (union of the given clusters), in document order of their first member.
  const parent = new Map(bodies.map((b) => [b.id, b.id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const g of groups)
    for (let i = 1; i < g.length; i++) {
      if (!parent.has(g[0]!) || !parent.has(g[i]!)) continue;
      const a = find(g[0]!);
      const b = find(g[i]!);
      if (a !== b) parent.set(b, a);
    }
  const byRoot = new Map<string, Body[]>();
  for (const b of bodies) {
    const r = find(b.id);
    byRoot.set(r, [...(byRoot.get(r) ?? []), b]);
  }
  const units: Unit[] = [...byRoot.values()].map((members, index) => {
    const rects = members.flatMap((m) => worldBoxes(m).filter((b) => !b.node));
    const area = rects.reduce((s, r) => s + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
    const span = Math.max(0, ...rects.map((r) => Math.max(r.x1 - r.x0, r.z1 - r.z0)));
    return {
      index,
      members,
      dx: 0,
      dz: 0,
      rank: [Math.max(...members.map((m) => CLASS[m.model] ?? 1)), area],
      cap: Math.min(MAX_CAP, Math.max(MIN_CAP, span / 2)),
    };
  });
  // Each unit's boxes at its current offset, kept up to date as it moves.
  const current = new Map<Unit, Placed[]>();
  const boxesOf = (u: Unit, dx = u.dx, dz = u.dz) => {
    if (dx === u.dx && dz === u.dz) {
      let b = current.get(u);
      if (!b) current.set(u, (b = u.members.flatMap((m) => worldBoxes(m, dx, dz))));
      return b;
    }
    return u.members.flatMap((m) => worldBoxes(m, dx, dz));
  };
  const hits = (a: Placed[], b: Placed[]) => a.some((p) => b.some((q) => collide(p, q)));
  // The less anchored of two units (it moves first).
  const weaker = (a: Unit, b: Unit): [Unit, Unit] => {
    if (a.rank[0] !== b.rank[0]) return a.rank[0] < b.rank[0] ? [a, b] : [b, a];
    if (Math.abs(a.rank[1] - b.rank[1]) > 1e-6) return a.rank[1] < b.rank[1] ? [a, b] : [b, a];
    return a.index > b.index ? [a, b] : [b, a];
  };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  /** The best move of `u` clearing `other`, or null when none fits its cap. */
  const move = (u: Unit, other: Unit): { dx: number; dz: number } | null => {
    const mine = boxesOf(u);
    const theirs = boxesOf(other);
    const need = { px: 0, nx: 0, pz: 0, nz: 0 };
    for (const p of mine)
      for (const q of theirs) {
        if (!collide(p, q)) continue;
        need.px = Math.max(need.px, q.x1 - p.x0 + GAP);
        need.nx = Math.max(need.nx, p.x1 - q.x0 + GAP);
        need.pz = Math.max(need.pz, q.z1 - p.z0 + GAP);
        need.nz = Math.max(need.nz, p.z1 - q.z0 + GAP);
      }
    const candidates = [
      { dx: u.dx + need.px, dz: u.dz },
      { dx: u.dx - need.nx, dz: u.dz },
      { dx: u.dx, dz: u.dz + need.pz },
      { dx: u.dx, dz: u.dz - need.nz },
    ]
      .map((c, k) => ({ dx: r3(c.dx), dz: r3(c.dz), k, len: Math.hypot(c.dx, c.dz) }))
      .filter((c) => c.len <= u.cap + 1e-9)
      .map((c) => {
        // New overlaps only: one the unit already has is resolved in its own turn.
        const at = boxesOf(u, c.dx, c.dz);
        const fresh = units.filter(
          (o) => o !== u && o !== other && hits(at, boxesOf(o)) && !hits(mine, boxesOf(o)),
        ).length;
        const still = hits(at, theirs) ? 1 : 0;
        return { ...c, fresh: fresh + still };
      })
      .sort((a, b) => a.fresh - b.fresh || a.len - b.len || a.k - b.k);
    return candidates[0] ?? null;
  };

  const stuck = new Set<string>();
  const pairKey = (a: Unit, b: Unit) =>
    `${Math.min(a.index, b.index)}:${Math.max(a.index, b.index)}`;
  for (let round = 0; round < rounds; round++) {
    let pair: [Unit, Unit] | null = null;
    for (let i = 0; i < units.length && !pair; i++)
      for (let j = i + 1; j < units.length && !pair; j++) {
        const a = units[i]!;
        const b = units[j]!;
        if (stuck.has(pairKey(a, b))) continue;
        if (hits(boxesOf(a), boxesOf(b))) pair = [a, b];
      }
    if (!pair) break;
    const [mover, anchor] = weaker(pair[0], pair[1]);
    // The less anchored unit moves; failing that, the other one (never the board itself).
    let target = mover;
    let m = move(mover, anchor);
    if (!m && anchor.rank[0] < BOARD) {
      target = anchor;
      m = move(anchor, mover);
    }
    if (!m) {
      stuck.add(pairKey(mover, anchor));
      continue;
    }
    target.dx = m.dx;
    target.dz = m.dz;
    current.delete(target);
  }

  const offsets = new Map<string, { dx: number; dz: number }>();
  for (const u of units)
    if (u.dx !== 0 || u.dz !== 0)
      for (const m of u.members) offsets.set(m.id, { dx: u.dx, dz: u.dz });
  const unresolved: [string, string][] = [];
  for (let i = 0; i < units.length; i++)
    for (let j = i + 1; j < units.length; j++)
      for (const p of units[i]!.members)
        for (const q of units[j]!.members)
          if (bodiesCollide(p, q, units[i]!, units[j]!))
            unresolved.push([p.id, q.id].sort() as [string, string]);
  return { offsets, unresolved };
}
