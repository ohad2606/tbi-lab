/**
 * Hook-up wires and terminal contacts in 3D (Sprint 10 realism pass). Presentation only: the
 * route, height and colour of every wire, and which terminals a contact joins, come from the scene
 * description (scene.ts), which comes from the project; nothing here infers a connection.
 *
 * Wires: solid-core hook-up wire, PVC jacket (soft matte plastic), coloured by electrical node
 * (the shared palette, shown in 3D as the jacket pigment of that colour).
 * - Corners are bent, not mitred: a 2 mm bend radius where the run turns in plan, 3 mm where it
 *   rises from or drops to an end (always limited to half of each adjoining straight run).
 * - Ends meet their terminal the way the real wire would: inside a jumper housing (`jumper`: the
 *   jacket enters the housing's top), or stripped (`lead`, `post`: the jacket stops 2 mm short and
 *   the tinned conductor runs on to the terminal).
 * Contacts (`contact` joints: two terminals the project connects directly, with no wire): the two
 * leads twisted together, a short tinned link with a wrap around each lead. Deliberately not a
 * solder blob: the project says "connected", not "soldered". `open` joints (touching, NOT
 * connected) keep their red not-connected ring, and their leads stop short (models.ts).
 */
import * as THREE from 'three';
import type { OwnedResources } from './kit.js';
import { WIRE_COLOR_HEX } from '../wireColors.js';
import { WIRE_RADIUS, type SceneJoint, type SceneWire, type Vec3 } from './scene.js';

/** Bend radius where the run turns in plan, and where it rises from or drops to an end (mm). */
const PLAN_BEND = 2.0;
const RISER_BEND = 3.0;
/** Stripped length at a lead or post end (mm), and the conductor's radius (22 AWG solid). */
const STRIP = 2.0;
const CONDUCTOR_R = 0.32;
/** Stripped length at a junction, where the conductors are twisted together (mm). */
const JUNCTION_STRIP = 2.6;
/** How far the jacket runs on into a jumper housing (hidden inside it). */
const INTO_HOUSING = 1.2;

export interface WireMaterials {
  jacket(color: string): THREE.Material;
  conductor: THREE.Material;
}

/**
 * The jacket's pigment for a palette colour (realism pass 4). The palette (wireColors.ts) is the
 * same in both views and stays a clear screen colour in the Circuit view; a real PVC jacket is
 * less saturated and a little darker, so 3D shows the insulation colour a jumper wire of that
 * name actually has. Red stays red, black stays black: the conventions read the same.
 */
const JACKET_PIGMENT: Record<string, string> = {
  [WIRE_COLOR_HEX.red]: '#b42a22',
  [WIRE_COLOR_HEX.black]: '#1b1c1e',
  [WIRE_COLOR_HEX.orange]: '#d06a1e',
  [WIRE_COLOR_HEX.blue]: '#2160a8',
  [WIRE_COLOR_HEX.green]: '#2f7b3c',
  [WIRE_COLOR_HEX.purple]: '#6a3486',
  [WIRE_COLOR_HEX.yellow]: '#d9ac2c',
  [WIRE_COLOR_HEX.teal]: '#20786e',
  [WIRE_COLOR_HEX.brown]: '#5e3e2e',
};
export const jacketPigment = (hex: string) => JACKET_PIGMENT[hex.toLowerCase()] ?? hex;

/**
 * Wire materials for one build (jackets per colour): soft PVC, matte with a faint satin sheen
 * where the light grazes it (no glossy toy-plastic clearcoat).
 */
export function wireMaterials(own: OwnedResources, conductor: THREE.Material): WireMaterials {
  const full = own.tier === 'full';
  return {
    jacket: (color) =>
      own.sharedMat(`jacket:${color}`, () => {
        const pigment = jacketPigment(color);
        const m = full
          ? new THREE.MeshPhysicalMaterial({
              color: pigment,
              // The map carries the roughness (about 0.58, scuffs rougher).
              roughness: 1,
              // Realism pass 6: the extruded jacket's surface (jacketSurface), not a perfect tube.
              bumpMap: jacketSurface(own),
              bumpScale: 0.6,
              roughnessMap: jacketSurface(own),
              clearcoat: 0.08,
              clearcoatRoughness: 0.6,
              sheen: 0.3,
              sheenRoughness: 0.7,
              sheenColor: new THREE.Color(pigment).lerp(new THREE.Color('#ffffff'), 0.35),
            })
          : new THREE.MeshStandardMaterial({ color: pigment, roughness: 0.62 });
        // The surface maps need only the tubes' UVs: the jackets still merge into one batch per
        // colour (renderer.ts batchStatic).
        m.userData.batchUv = true;
        return m;
      }),
    conductor,
  };
}

/** Jacket surface texture: one tile covers this length of wire (mm) and the full circumference. */
const JACKET_TILE = 24;

/**
 * An extruded PVC jacket's surface (realism pass 6), full tier: faint die lines along the wire,
 * a slow ripple where the soft jacket was drawn and handled, and a few scuffs; red channel the
 * height (bump), green the roughness (around 0.58, the jacket's own). Tileable both ways; u runs
 * along the wire (wireSurfaceUv), v round it. Deterministic.
 */
function jacketSurface(own: OwnedResources): THREE.Texture {
  return own.lasting('wire:jacket-surface', () => {
    const W = 256;
    const H = 64;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    let seed = 7654321;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // Die lines: a fixed random profile round the circumference, constant along the wire.
    const lines = Array.from({ length: H }, () => rnd() - 0.5);
    const smooth = lines.map(
      (_, y) => (lines[(y + H - 1) % H]! + 2 * lines[y]! + lines[(y + 1) % H]!) / 4,
    );
    // Ripple: a few low harmonics along the wire (whole periods, so the tile wraps).
    const harm = Array.from({ length: 4 }, (_, k) => ({
      f: 2 + k * 3,
      p: rnd() * 6.283,
      a: 0.5 / (k + 1),
    }));
    // Scuffs: short rough patches.
    const scuffs = Array.from({ length: 7 }, () => ({
      x: rnd() * W,
      y: rnd() * H,
      r: 3 + rnd() * 7,
    }));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let ripple = 0;
        for (const h of harm)
          ripple += h.a * Math.sin((x / W) * 6.283 * h.f + h.p + (y / H) * 6.283);
        let scuff = 0;
        for (const s of scuffs) {
          const dx = Math.min(Math.abs(x - s.x), W - Math.abs(x - s.x));
          const dy = Math.min(Math.abs(y - s.y), H - Math.abs(y - s.y)) * 3;
          scuff = Math.max(scuff, 1 - Math.hypot(dx, dy) / s.r);
        }
        const height = 128 + 40 * smooth[y]! + 22 * ripple + 10 * (rnd() - 0.5);
        const rough = 148 + 18 * smooth[y]! + 40 * Math.max(0, scuff) + 8 * (rnd() - 0.5);
        const i = (y * W + x) * 4;
        img.data[i] = Math.round(height);
        img.data[i + 1] = Math.round(rough);
        img.data[i + 2] = 0;
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

/**
 * Re-maps a tube's u to arc length (one jacket tile per JACKET_TILE mm, measured on the tube's
 * own rings, since its segments are not evenly spaced), starting at `offset` tiles so no two
 * wires show the same stretch of surface.
 */
export function wireSurfaceUv(geo: THREE.TubeGeometry, offset: number) {
  const { tubularSegments, radialSegments } = geo.parameters;
  const pos = geo.attributes.position!;
  const uv = geo.attributes.uv!;
  const ring = radialSegments + 1;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centre = (i: number, v: THREE.Vector3) => {
    v.set(0, 0, 0);
    for (let j = 0; j < radialSegments; j++) v.add(b.fromBufferAttribute(pos, i * ring + j));
    return v.divideScalar(radialSegments);
  };
  let s = offset * JACKET_TILE;
  centre(0, a);
  for (let i = 0; i <= tubularSegments; i++) {
    if (i > 0) {
      centre(i, c);
      s += a.distanceTo(c);
      a.copy(c);
    }
    for (let j = 0; j < ring; j++) uv.setX(i * ring + j, s / JACKET_TILE);
  }
  uv.needsUpdate = true;
}

/** A stable fraction in [0, 1) for a wire's id (its jacket texture's start). */
function idFraction(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * A path through `pts` with round bends: per-corner radius (`radii[i - 1]` for the corner at
 * point i; by default vertical/horizontal corners wider), always limited to half of each
 * adjoining run and to the previous corner's tangent point. With `arms` (a physical cable shape,
 * wireShape.ts) each corner instead has its own arm length into and out of it (a bend need not be
 * symmetric: a wire curving into a terminal bends over most of its last run), still never past
 * the previous corner's tangent point or the next point.
 */
export function bentPath(
  pts: Vec3[],
  radii?: number[],
  arms?: readonly (readonly [number, number])[],
): THREE.CurvePath<THREE.Vector3> {
  const v = pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let from = v[0]!;
  for (let i = 1; i < v.length - 1; i++) {
    const p = v[i]!;
    const a = v[i - 1]!;
    const b = v[i + 1]!;
    let rin: number;
    let rout: number;
    const arm = arms?.[i - 1];
    if (arm) {
      rin = Math.min(arm[0], from.distanceTo(p));
      rout = Math.min(arm[1], p.distanceTo(b));
    } else {
      const vertical = Math.abs(a.y - p.y) > 1e-6 || Math.abs(b.y - p.y) > 1e-6;
      // Half of each adjoining run, and never past the previous corner's tangent point.
      rin = rout = Math.min(
        radii?.[i - 1] ?? (vertical ? RISER_BEND : PLAN_BEND),
        a.distanceTo(p) / 2,
        p.distanceTo(b) / 2,
        from.distanceTo(p),
      );
    }
    const inP = p.clone().add(a.clone().sub(p).setLength(rin));
    const outP = p.clone().add(b.clone().sub(p).setLength(rout));
    if (from.distanceTo(inP) > 1e-6) path.add(new THREE.LineCurve3(from, inP));
    if (rin > 1e-6 && rout > 1e-6) path.add(new THREE.QuadraticBezierCurve3(inP, p, outP));
    else if (inP.distanceTo(outP) > 1e-6) path.add(new THREE.LineCurve3(inP, outP));
    from = outP;
  }
  const end = v[v.length - 1]!;
  if (from.distanceTo(end) > 1e-6) path.add(new THREE.LineCurve3(from, end));
  return path;
}

/** The part of a curve between two arc-length fractions. */
class Portion extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly curve: THREE.Curve<THREE.Vector3>,
    private readonly u0: number,
    private readonly u1: number,
  ) {
    super();
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.curve.getPointAt(this.u0 + (this.u1 - this.u0) * t));
  }
}

/**
 * A curve re-parameterised so that equal parameter steps fall densely in the bends and sparsely
 * on straight runs: a TubeGeometry over it needs one segment per straight run and a few per bend,
 * instead of a segment every half millimetre (a 10x saving on long wires, same silhouette).
 */
class Adaptive extends THREE.Curve<THREE.Vector3> {
  /** Arc-length fractions at the segment boundaries. */
  private readonly stops: number[];
  constructor(
    private readonly curve: THREE.Curve<THREE.Vector3>,
    pieces: { length: number; segments: number }[],
  ) {
    super();
    const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
    const stops = [0];
    let at = 0;
    for (const p of pieces) {
      for (let i = 1; i <= p.segments; i++) stops.push((at + (p.length * i) / p.segments) / total);
      at += p.length;
    }
    stops[stops.length - 1] = 1;
    this.stops = stops;
  }
  get segments() {
    return this.stops.length - 1;
  }
  private map(u: number) {
    const x = Math.min(Math.max(u, 0), 1) * this.segments;
    const i = Math.min(Math.floor(x), this.segments - 1);
    return this.stops[i]! + (this.stops[i + 1]! - this.stops[i]!) * (x - i);
  }
  override getPoint(u: number, target = new THREE.Vector3()) {
    return target.copy(this.curve.getPointAt(this.map(u)));
  }
  override getPointAt(u: number, target = new THREE.Vector3()) {
    return this.getPoint(u, target);
  }
  override getTangent(u: number, target = new THREE.Vector3()) {
    return target.copy(this.curve.getTangentAt(this.map(u)));
  }
  override getTangentAt(u: number, target = new THREE.Vector3()) {
    return this.getTangent(u, target);
  }
}

/**
 * The pieces of a bent path (its straight runs and bends) between two arc-length fractions, each
 * with the tube segments it needs: one per straight run; per bend, one per `step` radians it
 * turns (a gentle bow needs two, a hairpin a dozen), so smooth wires stay cheap.
 */
export function pieces(path: THREE.CurvePath<THREE.Vector3>, u0: number, u1: number, step: number) {
  const total = path.getLength();
  const out: { length: number; segments: number }[] = [];
  let at = 0;
  for (const c of path.curves) {
    const len = c.getLength();
    const a = Math.max(at, u0 * total);
    const b = Math.min(at + len, u1 * total);
    if (b > a + 1e-9) {
      let segments = 1;
      if (!(c as THREE.LineCurve3).isLineCurve3) {
        const turn = c.getTangent(0).angleTo(c.getTangent(1)) * ((b - a) / len);
        segments = Math.min(12, Math.max(2, Math.ceil(turn / step)));
      }
      out.push({ length: b - a, segments });
    }
    at += len;
  }
  return out;
}

/** One wire: jacket tube, stripped ends, the jacket's cut faces. */
export function buildWire(
  w: SceneWire,
  own: OwnedResources,
  m: WireMaterials,
  shape?: { points: Vec3[]; radii: number[]; arms?: [number, number][] },
): THREE.Group {
  const g = new THREE.Group();
  g.name = `wire:${w.id}`;
  g.userData.node = w.node;
  // The natural shape (wireShape.ts) when given, else the route as drawn.
  const pts = (shape?.points ?? w.points).map((p) => ({ ...p }));
  const radii = shape ? [...shape.radii] : undefined;
  const arms = shape?.arms ? shape.arms.map((a) => [...a] as [number, number]) : undefined;
  // A jumper end: the jacket continues straight down into the housing (out of sight).
  if (w.ends[0] === 'jumper' && pts.length > 1 && pts[1]!.y > pts[0]!.y) {
    pts.unshift({ ...pts[0]!, y: pts[0]!.y - INTO_HOUSING });
    radii?.unshift(RISER_BEND);
    arms?.unshift([0, 0]);
  }
  if (w.ends[1] === 'jumper' && pts.length > 1 && pts[pts.length - 2]!.y > pts[pts.length - 1]!.y) {
    pts.push({ ...pts[pts.length - 1]!, y: pts[pts.length - 1]!.y - INTO_HOUSING });
    radii?.push(RISER_BEND);
    arms?.push([0, 0]);
  }
  const path = bentPath(pts, radii, arms);
  const length = path.getLength();
  // Bare conductor at a lead, a post, and (realism pass 5) a junction, where the wires meeting
  // there are twisted together (buildSplice): their jackets stop short instead of merging into a T.
  const stripped = (k: 0 | 1) =>
    w.ends[k] === 'lead' || w.ends[k] === 'post' || w.ends[k] === 'junction';
  const stripOf = (k: 0 | 1) => (w.ends[k] === 'junction' ? JUNCTION_STRIP : STRIP);
  const s0 = stripped(0) ? Math.min(stripOf(0), length * 0.25) / length : 0;
  const s1 = stripped(1) ? Math.min(stripOf(1), length * 0.25) / length : 0;
  // One tube segment per ~9 degrees of bend (full tier), ~13 (reduced).
  const step = own.tier === 'full' ? 0.16 : 0.23;
  const jacketCurve = new Adaptive(
    s0 || s1 ? new Portion(path, s0, 1 - s1) : path,
    pieces(path, s0, 1 - s1, step),
  );
  const tube = new THREE.TubeGeometry(
    jacketCurve,
    jacketCurve.segments,
    WIRE_RADIUS,
    own.tier === 'full' ? 14 : 10,
    false,
  );
  if (own.tier === 'full') wireSurfaceUv(tube, idFraction(w.id) * 7);
  const jacket = new THREE.Mesh(own.geo(tube), m.jacket(w.color));
  jacket.castShadow = true;
  jacket.receiveShadow = true;
  jacket.userData.wireJacket = w.id;
  g.add(jacket);
  // Each end: the jacket's cut face (an annulus round the conductor) and the bare conductor; or,
  // for a junction, a rounded end.
  const cut = own.shared(
    'wire:cut',
    () => new THREE.RingGeometry(CONDUCTOR_R, WIRE_RADIUS, own.tier === 'full' ? 14 : 10),
  );
  for (const k of [0, 1] as const) {
    const u = k === 0 ? s0 : 1 - s1;
    if (stripped(k)) {
      const at = path.getPointAt(u);
      const tangent = path.getTangentAt(u);
      const face = new THREE.Mesh(cut, m.jacket(w.color));
      face.position.copy(at);
      face.lookAt(at.clone().add(k === 0 ? tangent.clone().negate() : tangent));
      g.add(face);
      const bare = new THREE.Mesh(
        own.geo(
          new THREE.TubeGeometry(
            new Portion(path, k === 0 ? 0 : u, k === 0 ? u : 1),
            8,
            CONDUCTOR_R,
            8,
            false,
          ),
        ),
        m.conductor,
      );
      bare.userData.conductor = w.id;
      g.add(bare);
      if (w.ends[k] !== 'junction') {
        const tip = new THREE.Mesh(
          own.shared('wire:tip', () => new THREE.SphereGeometry(CONDUCTOR_R, 10, 6)),
          m.conductor,
        );
        tip.position.copy(path.getPointAt(k === 0 ? 0 : 1));
        g.add(tip);
      }
    }
  }
  return g;
}

/**
 * A direct contact: a tinned link from the joint to each other terminal it joins, wrapped twice
 * round each lead (a twisted mechanical joint); an open joint: the red not-connected ring.
 */
export function buildJoint(
  j: SceneJoint,
  own: OwnedResources,
  m: { lead: THREE.Material; notConnected: THREE.Material },
): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `joint:${j.kind}:${j.terminals.join('+')}`;
  g.userData.joint = j.kind;
  if (j.kind === 'open') {
    const ring = new THREE.Mesh(
      own.shared('joint:open', () => new THREE.TorusGeometry(1.5, 0.2, 8, 32)),
      m.notConnected,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(j.x, j.y, j.z);
    g.add(ring);
    return g;
  }
  const wrap = own.shared('joint:wrap', () => new THREE.TorusGeometry(0.42, 0.13, 8, 20));
  const addWraps = (p: Vec3) => {
    for (const dy of [0.25, 0.62]) {
      const r = new THREE.Mesh(wrap, m.lead);
      r.rotation.x = Math.PI / 2;
      r.position.set(p.x, p.y + dy, p.z);
      g.add(r);
    }
  };
  addWraps(j);
  for (const l of j.links ?? []) {
    // Out of the wrap on one lead, a gentle arch just above the bench, into the wrap on the other.
    const lift = Math.max(j.y, l.y) + 0.45;
    const link = new THREE.Mesh(
      own.geo(
        new THREE.TubeGeometry(
          bentPath([
            { x: j.x, y: j.y + 0.45, z: j.z },
            { x: j.x, y: lift + 0.3, z: j.z },
            { x: l.x, y: lift + 0.3, z: l.z },
            { x: l.x, y: l.y + 0.45, z: l.z },
          ]),
          24,
          0.16,
          8,
          false,
        ),
      ),
      m.lead,
    );
    link.userData.contactLink = true;
    g.add(link);
    addWraps(l);
  }
  return g;
}

/**
 * A junction (realism pass 5): where the project joins three or more wires at one point, their
 * stripped conductors are twisted together into one short tinned splice lying on the bench (the
 * same mechanical language as a direct contact). Deliberately not a solder blob: the project says
 * "connected", not "soldered". One per junction; the wires' jackets stop short of it.
 */
export function buildSplice(at: Vec3, own: OwnedResources, conductor: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.name = 'splice';
  g.userData.splice = true;
  // The twisted bundle: a short barrel of wraps.
  const core = new THREE.Mesh(
    own.shared('splice:core', () => new THREE.CylinderGeometry(0.42, 0.42, 0.9, 10)),
    conductor,
  );
  core.position.set(at.x, at.y, at.z);
  g.add(core);
  const wrap = own.shared('splice:wrap', () => new THREE.TorusGeometry(0.42, 0.14, 6, 14));
  for (const dy of [-0.3, 0, 0.3]) {
    const r = new THREE.Mesh(wrap, conductor);
    r.rotation.x = Math.PI / 2;
    r.rotation.z = dy * 1.7;
    r.position.set(at.x, at.y + dy, at.z);
    g.add(r);
  }
  return g;
}
