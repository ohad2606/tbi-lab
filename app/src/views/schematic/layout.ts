/**
 * Automatic schematic layout (Sprint 9, D-S9-2). A pure, deterministic function of the project's
 * CONNECTIVITY (never of its 2D drawing): the same circuit always gives the same schematic, and
 * moving parts in the circuit editor changes nothing here.
 *
 * Conventions (educational DC circuits, not a general autorouter):
 * - a connection to the reference node is a ground symbol at the pin; a connection to a supply
 *   rail is a rail label at the pin (no wires drawn to either);
 * - each MCU module is a block; each of its connected pins anchors a horizontal TRACK running
 *   outward (left-side pins to the left, right-side pins to the right);
 * - along a node's track, two-pin parts whose other end is ground, a rail or open hang vertically
 *   ("shunts": to ground below, to a rail above, one of each per column); a part whose other end
 *   is a new node continues the track in series; a second series part opens a branch row below;
 * - nodes no MCU pin reaches start their own tracks below; parts between rails/ground (the lab
 *   supply itself, a load straight across it) stand in a column of their own on the far left;
 * - wherever a tree drawing cannot reach a node without crossing (cycles, a node on two MCU pins)
 *   the connection is made by NET LABELS of the same name — exact topology, no crossings.
 *
 * Coordinates are schematic units (y down); two-pin symbols are 80 units pin to pin.
 */

import {
  connectivity,
  type ComponentInstance,
  type Connectivity,
  type ElectricalNode,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  schematicSymbol,
  type ModulePin,
  type ModuleSymbol,
  type SchematicSymbolKey,
  type TwoPinSymbol,
} from './symbols.js';

export interface Point {
  x: number;
  y: number;
}

/** A placed two-pin part. Vertical parts are rotated 90° (pin `a` on top unless mirrored). */
export interface SchPart {
  component: string;
  key: SchematicSymbolKey;
  /** Symbol centre. */
  x: number;
  y: number;
  vertical: boolean;
  /** Pin `a` and `b` swapped along the symbol axis. */
  mirror: boolean;
  /** Project terminal → absolute pin point. */
  pins: Record<string, Point>;
}

export interface SchModulePin extends ModulePin {
  /** Outer end of the pin line (where wires attach). */
  at: Point;
  /** Where the pin line meets the block. */
  inner: Point;
}

export interface SchModule {
  component: string;
  partName: string;
  /** Block rectangle. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Shown pins (the connected ones). */
  pins: SchModulePin[];
}

export type MarkKind = 'ground' | 'rail' | 'net';
export type Direction = 'up' | 'down' | 'left' | 'right';

/** A connection drawn as a symbol instead of a wire. */
export interface SchMark {
  kind: MarkKind;
  at: Point;
  /** Which way the mark extends from its connection point. */
  dir: Direction;
  /** Electrical node it stands for. */
  node: string;
  /** Net label text (net labels only). */
  name?: string;
  /** Rail labels: the supply that drives the rail. */
  supply?: string;
}

export interface SchWire {
  node: string;
  points: Point[];
}

export interface SchematicLayout {
  parts: SchPart[];
  modules: SchModule[];
  marks: SchMark[];
  wires: SchWire[];
  /** Points where three or more connections meet. */
  junctions: Point[];
  /** Parts with no connection at all (drawn apart, open pins). */
  unconnected: string[];
  /** Ground components (drawn as the ground marks of what they ground). */
  references: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

// Geometry (schematic units).
const HALF = 40; // two-pin symbol: pin to centre
const LEAD = 20;
const COL = 100; // column pitch for vertical parts (room for their labels)
const SHUNT_EXT = 2 * HALF + 40; // part + mark
const LABEL_ABOVE = 34;
const LABEL_BELOW = 34;
const ROW_GAP = 30;
const PIN_LEN = 30;
const PIN_PITCH = 40;
const MODULE_W = 140;
const MARK_EXT = 40;
const NET_LABEL_LEN = 70;
const GROUP_GAP = 80;
/** Groups the MCU does not reach share a row up to this width before a new row starts. */
const ROW_WIDTH = 900;
/** Between groups in a row: their nearest columns end up 1.5 column pitches apart. */
const ROW_GROUP_GAP = COL / 2 - LEAD;

type End = 'ground' | 'rail' | 'open' | 'label';

interface Shunt {
  comp: ComponentInstance;
  sym: TwoPinSymbol;
  near: string;
  far: string;
  end: End;
  farNode: string | null;
}
interface Series {
  comp: ComponentInstance;
  sym: TwoPinSymbol;
  near: string;
  far: string;
  next: Run;
}
interface Run {
  node: string;
  ups: Shunt[];
  downs: Shunt[];
  series: Series[];
  size?: { up: number; down: number; len: number; mainDown: number };
}

interface PinItem {
  pin: ModulePin;
  node: string;
  mode: 'ground' | 'rail' | 'label' | 'run';
  run?: Run;
  up: number;
  down: number;
  len: number;
}

export function schematicLayout(doc: ProjectDocument): SchematicLayout {
  const g = connectivity(doc);
  return new Builder(doc, g).build();
}

class Builder {
  private readonly nodes: Map<string, ElectricalNode>;
  private readonly claimed = new Set<string>();
  private readonly placedNodes = new Set<string>();
  private readonly needLabel = new Set<string>();
  /** Where a node's net label goes if it turns out to need one: its first drawn point. */
  private readonly home = new Map<string, { at: Point; dir: Direction }>();
  private readonly out: SchematicLayout = {
    parts: [],
    modules: [],
    marks: [],
    wires: [],
    junctions: [],
    unconnected: [],
    references: [],
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
  private readonly pinNames = new Map<string, string>();

  constructor(
    private readonly doc: ProjectDocument,
    private readonly g: Connectivity,
  ) {
    this.nodes = new Map(g.nodes.map((n) => [n.id, n]));
  }

  private nodeOf(c: string, t: string): string | null {
    return this.g.nodeOf.get(`${c}:${t}`) ?? null;
  }
  private kindOf(node: string | null) {
    if (node === null) return 'open' as const;
    return this.nodes.get(node)?.kind ?? 'signal';
  }

  build(): SchematicLayout {
    const comps = this.doc.components;
    const modules = comps.filter((c) => schematicSymbol(c).kind === 'module');
    // Readable names for module-pin nodes (used by net labels when the user named nothing).
    for (const m of modules)
      for (const p of (schematicSymbol(m) as ModuleSymbol).pins) {
        const n = this.nodeOf(m.id, p.terminal);
        if (n && !this.pinNames.has(n)) this.pinNames.set(n, p.name);
      }

    // 1. Parts standing between rails and ground (the supply itself, loads across it).
    const sources = comps.filter((c) => {
      const s = schematicSymbol(c);
      if (s.kind !== 'two-pin') return false;
      const ka = this.kindOf(this.nodeOf(c.id, s.a));
      const kb = this.kindOf(this.nodeOf(c.id, s.b));
      const railish = (k: string) => k === 'ground' || k === 'supply';
      return railish(ka) && railish(kb);
    });
    for (const c of sources) this.claimed.add(c.id);

    // Tracks start at y = 0; a supply column stands to their left with its rail label level
    // with the tracks' rail labels (both one part length above the track).
    const top = 0;
    sources.forEach((c, i) => this.placeSourceColumn(c, i * COL, top - HALF));
    const originX = sources.length ? sources.length * COL + GROUP_GAP / 2 : 0;
    let cursorY = top;

    // 2. MCU modules, each with its pin tracks.
    for (const m of modules) {
      this.claimed.add(m.id);
      cursorY = this.placeModule(m, originX, cursorY - 40) + GROUP_GAP;
    }
    let firstFree = modules.length === 0;

    // 3. Nodes no module reaches: their own tracks, side by side in rows (each row's tracks at
    // one height, so rail labels line up), wrapping at ROW_WIDTH. Without a module the first
    // group continues the supply column's pitch; below a module the rows start under it.
    const runs: { run: Run; size: NonNullable<Run['size']> }[] = [];
    for (const n of this.g.nodes) {
      if (n.kind !== 'signal' || this.placedNodes.has(n.id)) continue;
      const hasPart = n.pins.some((p) => !this.claimed.has(p.component));
      if (!hasPart) continue;
      const run = this.buildRun(n.id);
      runs.push({ run, size: this.measure(run) });
    }
    const rowX0 =
      modules.length === 0 && sources.length ? sources.length * COL - COL / 2 - LEAD : originX;
    for (let i = 0; i < runs.length;) {
      const row: typeof runs = [];
      let width = 0;
      while (i < runs.length && (row.length === 0 || width + runs[i]!.size.len <= ROW_WIDTH)) {
        width += runs[i]!.size.len + ROW_GROUP_GAP;
        row.push(runs[i++]!);
      }
      const up = Math.max(...row.map((r) => r.size.up));
      const y = firstFree ? cursorY : cursorY + up;
      firstFree = false;
      let x = rowX0;
      for (const r of row) {
        this.placeRun(r.run, x, y, 1, false);
        x += r.size.len + ROW_GROUP_GAP;
      }
      cursorY = y + Math.max(...row.map((r) => r.size.down)) + GROUP_GAP;
    }

    // 4. Ground parts are drawn as the marks of what they ground; parts no track reached (unwired,
    // or wired only at one end) stand apart.
    let x = originX;
    for (const c of comps) {
      if (this.claimed.has(c.id)) continue;
      const s = schematicSymbol(c);
      if (s.kind === 'ground') {
        this.out.references.push(c.id);
        if (this.nodeOf(c.id, s.terminal) === null) {
          this.out.unconnected.push(c.id);
          this.out.marks.push({ kind: 'ground', at: { x, y: cursorY }, dir: 'down', node: '' });
          x += COL;
        }
        continue;
      }
      if (s.kind === 'two-pin') {
        // A part no track reached may still have a pin on ground or a rail (its other pin
        // open): that pin carries its mark, so the connection is drawn, not lost.
        const na = this.nodeOf(c.id, s.a);
        const nb = this.nodeOf(c.id, s.b);
        if (na === null && nb === null) this.out.unconnected.push(c.id);
        const part = this.addPart(c, s, { x: x + HALF, y: cursorY + LABEL_ABOVE }, false, false);
        this.endMark(na, part.pins[s.a]!, 'left');
        this.endMark(nb, part.pins[s.b]!, 'right');
        x += 2 * HALF + COL / 2;
      }
    }

    this.addNetLabels();
    this.out.junctions = junctions(this.out);
    this.out.bounds = bounds(this.out);
    return this.out;
  }

  // ---------------------------------------------------------------------------------------------

  private placeSourceColumn(c: ComponentInstance, x: number, y: number) {
    const s = schematicSymbol(c) as TwoPinSymbol;
    const na = this.nodeOf(c.id, s.a);
    const nb = this.nodeOf(c.id, s.b);
    // The rail end goes on top (a supply's + is its `a` end).
    const aTop = !(this.kindOf(nb) === 'supply' && this.kindOf(na) !== 'supply');
    const part = this.addPart(c, s, { x, y }, true, !aTop);
    const topT = aTop ? s.a : s.b;
    const botT = aTop ? s.b : s.a;
    this.endMark(this.nodeOf(c.id, topT), part.pins[topT]!, 'up');
    this.endMark(this.nodeOf(c.id, botT), part.pins[botT]!, 'down');
  }

  /** The mark at a part end that has no wire: ground, rail, or nothing (open). */
  private endMark(node: string | null, at: Point, dir: Direction) {
    if (node === null) return;
    const kind = this.kindOf(node);
    if (kind === 'ground') this.out.marks.push({ kind: 'ground', at, dir: 'down', node });
    else if (kind === 'supply')
      this.out.marks.push({
        kind: 'rail',
        at,
        dir: 'up',
        node,
        supply: this.nodes.get(node)!.supply!,
      });
    else this.netLabel(node, at, dir);
  }

  private netLabel(node: string, at: Point, dir: Direction) {
    this.needLabel.add(node);
    this.out.marks.push({ kind: 'net', at, dir, node, name: this.nameOf(node) });
  }

  private nameOf(node: string): string {
    const n = this.nodes.get(node);
    return n?.userName ?? this.pinNames.get(node) ?? node;
  }

  /** Returns the bottom y of the module group. */
  private placeModule(m: ComponentInstance, originX: number, top: number): number {
    const sym = schematicSymbol(m) as ModuleSymbol;
    const items: PinItem[] = [];
    for (const side of ['left', 'right'] as const) {
      for (const pin of sym.pins.filter((p) => p.side === side).sort((a, b) => a.order - b.order)) {
        const node = this.nodeOf(m.id, pin.terminal);
        if (node === null) continue;
        const kind = this.kindOf(node);
        if (kind === 'ground' || kind === 'supply') {
          items.push({
            pin,
            node,
            mode: kind === 'ground' ? 'ground' : 'rail',
            up: kind === 'supply' ? MARK_EXT : 10,
            down: kind === 'ground' ? MARK_EXT : 10,
            len: 20,
          });
        } else if (this.placedNodes.has(node)) {
          items.push({ pin, node, mode: 'label', up: 10, down: 10, len: NET_LABEL_LEN });
        } else {
          const run = this.buildRun(node);
          const size = this.measure(run);
          items.push({
            pin,
            node,
            mode: 'run',
            run,
            up: size.up,
            down: size.down,
            len: size.len,
          });
        }
      }
    }
    // Stack each side's pins; the block spans both sides.
    const ys = new Map<PinItem, number>();
    let maxBottom = top + 60;
    let minTop = Infinity;
    for (const side of ['left', 'right'] as const) {
      let cursor = top + 40; // room for the block title
      let prev: number | null = null;
      for (const it of items.filter((i) => i.pin.side === side)) {
        let y = cursor + it.up;
        if (prev !== null) y = Math.max(y, prev + PIN_PITCH);
        y = Math.ceil(y / 10) * 10;
        ys.set(it, y);
        prev = y;
        minTop = Math.min(minTop, y);
        cursor = y + it.down + ROW_GAP;
        maxBottom = Math.max(maxBottom, y + it.down);
      }
    }
    const leftLen = Math.max(40, ...items.filter((i) => i.pin.side === 'left').map((i) => i.len));
    const blockX = originX + leftLen + PIN_LEN;
    const pinYs = [...ys.values()];
    const blockTop = pinYs.length ? Math.min(...pinYs) - 30 : top + 40;
    const blockBottom = pinYs.length ? Math.max(...pinYs) + 30 : top + 140;
    const mod: SchModule = {
      component: m.id,
      partName: sym.partName,
      x: blockX,
      y: blockTop,
      width: MODULE_W,
      height: Math.max(80, blockBottom - blockTop),
      pins: [],
    };
    this.out.modules.push(mod);
    for (const it of items) {
      const y = ys.get(it)!;
      const left = it.pin.side === 'left';
      const innerX = left ? blockX : blockX + MODULE_W;
      const at = { x: left ? innerX - PIN_LEN : innerX + PIN_LEN, y };
      mod.pins.push({ ...it.pin, at, inner: { x: innerX, y } });
      const dir = left ? -1 : 1;
      if (it.mode === 'ground')
        this.out.marks.push({ kind: 'ground', at, dir: 'down', node: it.node });
      else if (it.mode === 'rail')
        this.out.marks.push({
          kind: 'rail',
          at,
          dir: 'up',
          node: it.node,
          supply: this.nodes.get(it.node)!.supply!,
        });
      else if (it.mode === 'label') this.netLabel(it.node, at, left ? 'left' : 'right');
      else this.placeRun(it.run!, at.x, y, dir, true);
    }
    return Math.max(maxBottom, blockBottom) + (minTop === Infinity ? 0 : 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Tracks

  private buildRun(node: string): Run {
    this.placedNodes.add(node);
    const run: Run = { node, ups: [], downs: [], series: [] };
    for (const c of this.doc.components) {
      if (this.claimed.has(c.id)) continue;
      const s = schematicSymbol(c);
      if (s.kind !== 'two-pin') continue;
      const na = this.nodeOf(c.id, s.a);
      const nb = this.nodeOf(c.id, s.b);
      if (na !== node && nb !== node) continue;
      this.claimed.add(c.id);
      const near = na === node ? s.a : s.b;
      const far = near === s.a ? s.b : s.a;
      const farNode = near === s.a ? nb : na;
      const kind = this.kindOf(farNode);
      const shunt = (end: End): Shunt => ({ comp: c, sym: s, near, far, end, farNode });
      if (kind === 'ground') run.downs.push(shunt('ground'));
      else if (kind === 'open') run.downs.push(shunt('open'));
      else if (kind === 'supply') run.ups.push(shunt('rail'));
      else if (farNode === node || this.placedNodes.has(farNode!)) run.downs.push(shunt('label'));
      else run.series.push({ comp: c, sym: s, near, far, next: this.buildRun(farNode!) });
    }
    return run;
  }

  private measure(run: Run): NonNullable<Run['size']> {
    const cols = Math.max(run.ups.length, run.downs.length);
    let up = run.ups.length ? SHUNT_EXT : 10;
    let down = run.downs.length ? SHUNT_EXT : 10;
    const attach = LEAD + cols * COL;
    let len = attach;
    const series = run.series.map((s) => {
      const n = this.measure(s.next);
      return { up: Math.max(LABEL_ABOVE, n.up), down: Math.max(LABEL_BELOW, n.down), len: n.len };
    });
    if (series[0]) {
      up = Math.max(up, series[0].up);
      down = Math.max(down, series[0].down);
    }
    const mainDown = down;
    series.forEach((s, i) => {
      len = Math.max(len, attach + (i > 0 ? LEAD : 0) + 2 * HALF + s.len);
      if (i > 0) down += ROW_GAP + s.up + s.down;
    });
    run.size = { up, down, len, mainDown };
    return run.size;
  }

  /**
   * Lay a node's track out from `x0` along `dir` (−1 left, +1 right) at height `y`. `anchored`:
   * something (a module pin, a previous part) already connects at (x0, y).
   */
  private placeRun(run: Run, x0: number, y: number, dir: 1 | -1, anchored: boolean) {
    const size = run.size ?? this.measure(run);
    const xs: number[] = anchored ? [x0] : [];
    const cols = Math.max(run.ups.length, run.downs.length);
    const colX = (i: number) => x0 + dir * (LEAD + COL * i + COL / 2);
    run.ups.forEach((s, i) => {
      xs.push(colX(i));
      this.placeShunt(s, colX(i), y, 'up');
    });
    run.downs.forEach((s, i) => {
      xs.push(colX(i));
      this.placeShunt(s, colX(i), y, 'down');
    });
    const xb = cols ? x0 + dir * (LEAD + cols * COL) : anchored ? x0 + dir * LEAD : x0;
    let rowY = y + size.mainDown;
    run.series.forEach((s, i) => {
      if (i === 0) {
        xs.push(xb);
        this.placeSeries(s, xb, y, dir);
        return;
      }
      const n = s.next.size!;
      const branchUp = Math.max(LABEL_ABOVE, n.up);
      const yRow = rowY + ROW_GAP + branchUp;
      rowY = yRow + Math.max(LABEL_BELOW, n.down);
      xs.push(xb);
      this.out.wires.push({
        node: run.node,
        points: [
          { x: xb, y },
          { x: xb, y: yRow },
          { x: xb + dir * LEAD, y: yRow },
        ],
      });
      this.placeSeries(s, xb + dir * LEAD, yRow, dir);
    });
    if (!xs.length) return;
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (hi > lo)
      this.out.wires.push({
        node: run.node,
        points: [
          { x: lo, y },
          { x: hi, y },
        ],
      });
    // A net label for this node, if one is needed, sits where its track begins.
    if (!this.home.has(run.node))
      this.home.set(run.node, { at: { x: anchored ? x0 : lo, y }, dir: 'up' });
  }

  private placeSeries(s: Series, xn: number, y: number, dir: 1 | -1) {
    const mirror = (dir === 1) !== (s.near === s.sym.a);
    const part = this.addPart(s.comp, s.sym, { x: xn + dir * HALF, y }, false, mirror);
    const far = part.pins[s.far]!;
    this.placeRun(s.next, far.x, y, dir, true);
  }

  private placeShunt(s: Shunt, xc: number, y: number, way: 'up' | 'down') {
    // Vertical: pin `a` on top unless mirrored.
    const nearTop = way === 'down';
    const mirror = nearTop !== (s.near === s.sym.a);
    const cy = way === 'down' ? y + HALF : y - HALF;
    const part = this.addPart(s.comp, s.sym, { x: xc, y: cy }, true, mirror);
    const far = part.pins[s.far]!;
    if (s.end === 'ground')
      this.out.marks.push({ kind: 'ground', at: far, dir: 'down', node: s.farNode! });
    else if (s.end === 'rail')
      this.out.marks.push({
        kind: 'rail',
        at: far,
        dir: 'up',
        node: s.farNode!,
        supply: this.nodes.get(s.farNode!)!.supply!,
      });
    else if (s.end === 'label') this.netLabel(s.farNode!, far, way);
  }

  private addPart(
    c: ComponentInstance,
    s: TwoPinSymbol,
    at: Point,
    vertical: boolean,
    mirror: boolean,
  ): SchPart {
    const sa = mirror ? HALF : -HALF;
    const pa = vertical ? { x: at.x, y: at.y + sa } : { x: at.x + sa, y: at.y };
    const pb = vertical ? { x: at.x, y: at.y - sa } : { x: at.x - sa, y: at.y };
    const part: SchPart = {
      component: c.id,
      key: s.key,
      x: at.x,
      y: at.y,
      vertical,
      mirror,
      pins: { [s.a]: pa, [s.b]: pb },
    };
    this.out.parts.push(part);
    return part;
  }

  /** Every node that is joined by name somewhere also carries its name at its home track. */
  private addNetLabels() {
    for (const node of this.needLabel) {
      const home = this.home.get(node);
      if (!home) continue;
      const already = this.out.marks.some(
        (m) => m.kind === 'net' && m.node === node && m.at.x === home.at.x && m.at.y === home.at.y,
      );
      if (!already)
        this.out.marks.push({
          kind: 'net',
          at: home.at,
          dir: 'up',
          node,
          name: this.nameOf(node),
        });
    }
  }
}

// -------------------------------------------------------------------------------------------------

const key = (p: Point) => `${p.x},${p.y}`;

/** Points where three or more connections (wire ends, wire pass-throughs, pins) meet. */
function junctions(l: SchematicLayout): Point[] {
  const ends = new Map<string, number>();
  const bump = (p: Point, n = 1) => ends.set(key(p), (ends.get(key(p)) ?? 0) + n);
  const segments: [Point, Point][] = [];
  for (const w of l.wires)
    for (let i = 1; i < w.points.length; i++) segments.push([w.points[i - 1]!, w.points[i]!]);
  const candidates = new Map<string, Point>();
  for (const w of l.wires) {
    bump(w.points[0]!);
    bump(w.points[w.points.length - 1]!);
    for (const p of w.points) candidates.set(key(p), p);
  }
  // Interior bends of one polyline join two of its own segments: two arms.
  for (const w of l.wires) for (const p of w.points.slice(1, -1)) bump(p, 2);
  const pinPoints: Point[] = [
    ...l.parts.flatMap((p) => Object.values(p.pins)),
    ...l.modules.flatMap((m) => m.pins.map((p) => p.at)),
  ];
  for (const p of pinPoints) {
    bump(p);
    candidates.set(key(p), p);
  }
  const out: Point[] = [];
  for (const [k, p] of candidates) {
    let arms = ends.get(k) ?? 0;
    for (const [a, b] of segments) if (strictlyInside(p, a, b)) arms += 2;
    if (arms >= 3) out.push(p);
  }
  return out.sort((a, b) => a.x - b.x || a.y - b.y);
}

export function strictlyInside(p: Point, a: Point, b: Point): boolean {
  if (a.x === b.x && p.x === a.x) return p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y);
  if (a.y === b.y && p.y === a.y) return p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x);
  return false;
}

function bounds(l: SchematicLayout) {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: number, y: number, pad = 0) => {
    xs.push(x - pad, x + pad);
    ys.push(y - pad, y + pad);
  };
  for (const p of l.parts) add(p.x, p.y, 50);
  for (const m of l.modules) {
    add(m.x - PIN_LEN - 10, m.y - 30);
    add(m.x + m.width + PIN_LEN + 10, m.y + m.height + 20);
  }
  for (const m of l.marks) add(m.at.x, m.at.y, m.kind === 'net' ? NET_LABEL_LEN : 40);
  for (const w of l.wires) for (const p of w.points) add(p.x, p.y);
  if (!xs.length) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}
