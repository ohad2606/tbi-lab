/**
 * Hook-up wires and terminal contacts in 3D (Sprint 10 realism pass). Presentation only: the
 * route, height and colour of every wire, and which terminals a contact joins, come from the scene
 * description (scene.ts), which comes from the project; nothing here infers a connection.
 *
 * Wires: solid-core hook-up wire, PVC jacket (a soft satin plastic), coloured by electrical node.
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
import { WIRE_RADIUS, type SceneJoint, type SceneWire, type Vec3 } from './scene.js';

/** Bend radius where the run turns in plan, and where it rises from or drops to an end (mm). */
const PLAN_BEND = 2.0;
const RISER_BEND = 3.0;
/** Stripped length at a lead or post end (mm), and the conductor's radius (22 AWG solid). */
const STRIP = 2.0;
const CONDUCTOR_R = 0.32;
/** How far the jacket runs on into a jumper housing (hidden inside it). */
const INTO_HOUSING = 1.2;

export interface WireMaterials {
  jacket(color: string): THREE.Material;
  conductor: THREE.Material;
}

/** Wire materials for one build (jackets per colour). */
export function wireMaterials(own: OwnedResources, conductor: THREE.Material): WireMaterials {
  const full = own.tier === 'full';
  return {
    jacket: (color) =>
      own.sharedMat(`jacket:${color}`, () =>
        full
          ? new THREE.MeshPhysicalMaterial({
              color,
              roughness: 0.42,
              clearcoat: 0.35,
              clearcoatRoughness: 0.35,
              sheen: 0.25,
              sheenRoughness: 0.5,
              sheenColor: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.5),
            })
          : new THREE.MeshStandardMaterial({ color, roughness: 0.45 }),
      ),
    conductor,
  };
}

/**
 * A path through `pts` with round bends: per-corner radius (`radii[i - 1]` for the corner at
 * point i; by default vertical/horizontal corners wider), always limited to half of each
 * adjoining run and to the previous corner's tangent point.
 */
export function bentPath(pts: Vec3[], radii?: number[]): THREE.CurvePath<THREE.Vector3> {
  const v = pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let from = v[0]!;
  for (let i = 1; i < v.length - 1; i++) {
    const p = v[i]!;
    const a = v[i - 1]!;
    const b = v[i + 1]!;
    const vertical = Math.abs(a.y - p.y) > 1e-6 || Math.abs(b.y - p.y) > 1e-6;
    // Half of each adjoining run, and never past the previous corner's tangent point.
    const r = Math.min(
      radii?.[i - 1] ?? (vertical ? RISER_BEND : PLAN_BEND),
      a.distanceTo(p) / 2,
      p.distanceTo(b) / 2,
      from.distanceTo(p),
    );
    const inP = p.clone().add(a.clone().sub(p).setLength(r));
    const outP = p.clone().add(b.clone().sub(p).setLength(r));
    if (from.distanceTo(inP) > 1e-6) path.add(new THREE.LineCurve3(from, inP));
    if (r > 1e-6) path.add(new THREE.QuadraticBezierCurve3(inP, p, outP));
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
    pieces: { length: number; bend: boolean }[],
    bendSegments: number,
  ) {
    super();
    const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
    const stops = [0];
    let at = 0;
    for (const p of pieces) {
      const n = p.bend ? bendSegments : 1;
      for (let i = 1; i <= n; i++) stops.push((at + (p.length * i) / n) / total);
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

/** The pieces of a bent path (its straight runs and bends) between two arc-length fractions. */
function pieces(path: THREE.CurvePath<THREE.Vector3>, u0: number, u1: number) {
  const total = path.getLength();
  const out: { length: number; bend: boolean }[] = [];
  let at = 0;
  for (const c of path.curves) {
    const len = c.getLength();
    const a = Math.max(at, u0 * total);
    const b = Math.min(at + len, u1 * total);
    if (b > a + 1e-9) out.push({ length: b - a, bend: !(c as THREE.LineCurve3).isLineCurve3 });
    at += len;
  }
  return out;
}

/** One wire: jacket tube, stripped ends, the jacket's cut faces. */
export function buildWire(
  w: SceneWire,
  own: OwnedResources,
  m: WireMaterials,
  shape?: { points: Vec3[]; radii: number[] },
): THREE.Group {
  const g = new THREE.Group();
  g.name = `wire:${w.id}`;
  g.userData.node = w.node;
  // The natural shape (wireShape.ts) when given, else the route as drawn.
  const pts = (shape?.points ?? w.points).map((p) => ({ ...p }));
  const radii = shape ? [...shape.radii] : undefined;
  // A jumper end: the jacket continues down into the housing (out of sight).
  if (w.ends[0] === 'jumper' && pts.length > 1 && pts[1]!.y > pts[0]!.y) {
    pts.unshift({ ...pts[0]!, y: pts[0]!.y - INTO_HOUSING });
    radii?.unshift(RISER_BEND);
  }
  if (w.ends[1] === 'jumper' && pts.length > 1 && pts[pts.length - 2]!.y > pts[pts.length - 1]!.y) {
    pts.push({ ...pts[pts.length - 1]!, y: pts[pts.length - 1]!.y - INTO_HOUSING });
    radii?.push(RISER_BEND);
  }
  const path = bentPath(pts, radii);
  const length = path.getLength();
  const stripped = (k: 0 | 1) => w.ends[k] === 'lead' || w.ends[k] === 'post';
  const s0 = stripped(0) ? Math.min(STRIP, length * 0.25) / length : 0;
  const s1 = stripped(1) ? Math.min(STRIP, length * 0.25) / length : 0;
  const bendSegs = own.tier === 'full' ? 8 : 6;
  const jacketCurve = new Adaptive(
    s0 || s1 ? new Portion(path, s0, 1 - s1) : path,
    pieces(path, s0, 1 - s1),
    bendSegs,
  );
  const jacket = new THREE.Mesh(
    own.geo(
      new THREE.TubeGeometry(
        jacketCurve,
        jacketCurve.segments,
        WIRE_RADIUS,
        own.tier === 'full' ? 14 : 10,
        false,
      ),
    ),
    m.jacket(w.color),
  );
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
      const tip = new THREE.Mesh(
        own.shared('wire:tip', () => new THREE.SphereGeometry(CONDUCTOR_R, 10, 6)),
        m.conductor,
      );
      tip.position.copy(path.getPointAt(k === 0 ? 0 : 1));
      g.add(tip);
    } else if (w.ends[k] === 'junction') {
      const end = new THREE.Mesh(
        own.shared('wire:end', () => new THREE.SphereGeometry(WIRE_RADIUS, 14, 10)),
        m.jacket(w.color),
      );
      end.position.copy(path.getPointAt(k));
      g.add(end);
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
