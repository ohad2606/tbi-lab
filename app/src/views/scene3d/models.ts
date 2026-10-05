/**
 * Physically scaled 3D models (Sprint 10; procedural since Sprint 9, D-S9-3). One builder per model
 * key; each builds a group in the part's LOCAL frame (origin = the component's layout origin,
 * +X = the layout's x axis at rotation 0, +Z = the layout's y axis, +Y up, millimetres) from the
 * part's physical metadata (physical.ts). Every lead, post or pin ends exactly at its terminal's
 * attach point (scene.ts), so wires meet the part where the circuit connects it.
 *
 * Recognisable silhouettes, believable dimensions, correct orientation cues (LED flat and short
 * cathode side, diode band, supply polarity) and plausible materials. No textures are loaded from
 * anywhere: silkscreen, markings and displays are drawn on canvases at build time.
 *
 * Resource discipline: geometries are shared per shape key (identical parts share them), materials
 * are shared per viewer, the ESP32's 38 header pins are one instanced mesh per board.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CATALOG, ESP32_DEVKITC_WROOM32, boardPinPosition, boardTerminalId } from '@tbi-lab/domain';
import {
  DIODE_DO35,
  ESP32_DEVKITC,
  ESP32_PCB_BOTTOM,
  ESP32_PCB_TOP,
  GROUND_POST,
  LEAD_ATTACH_HEIGHT,
  LED_PACKAGES,
  PSU,
  RESISTOR,
  TACTILE,
  TOGGLE,
  type AxialPhysics,
} from './physical.js';
import { SCALE, realPinZ, type ModelKey, type SceneComponent } from './scene.js';

export type Materials = ReturnType<typeof createMaterials>;

/** Shared materials of one viewer (disposed with it). */
export function createMaterials() {
  const std = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...extra });
  return {
    /** Tinned copper leads. */
    lead: std('#c9cdd2', { metalness: 0.55, roughness: 0.3 }),
    /** Gold-flashed header pins. */
    gold: std('#d9b558', { metalness: 0.6, roughness: 0.3 }),
    /** Soldermask: the DevKitC's near-black board. */
    pcb: std('#16191e', { roughness: 0.55 }),
    pcbEdge: std('#3a3f2c', { roughness: 0.8 }),
    moduleBoard: std('#1b2733', { roughness: 0.6 }),
    shield: std('#d3d7dc', { metalness: 0.55, roughness: 0.36 }),
    blackPlastic: std('#1d1e21', { roughness: 0.55 }),
    darkPlastic: std('#2c2f34', { roughness: 0.5 }),
    ic: std('#202226', { roughness: 0.45 }),
    chrome: std('#e4e7ea', { metalness: 0.6, roughness: 0.2 }),
    steel: std('#b4bac0', { metalness: 0.55, roughness: 0.35 }),
    resistorBody: std('#d8c29a', { roughness: 0.55 }),
    /** DO-35: amber-tinted glass with the junction inside. */
    glass: std('#d9772a', { roughness: 0.12, transparent: true, opacity: 0.72 }),
    cathodeBand: std('#151515', { roughness: 0.5 }),
    psuCase: std('#b9bfc6', { roughness: 0.5, metalness: 0.1 }),
    psuPanel: std('#2b3139', { roughness: 0.55 }),
    red: std('#c62828', { roughness: 0.4 }),
    black: std('#1b1c1e', { roughness: 0.4 }),
    white: std('#eceff1', { roughness: 0.5 }),
    smdTan: std('#a07c4f', { roughness: 0.6 }),
    smdLed: std('#e53935', { roughness: 0.3 }),
    generic: std('#8d97a3'),
  };
}

const BAND_COLORS: Record<string, string> = {
  black: '#121212',
  brown: '#6d3b16',
  red: '#d32f2f',
  orange: '#f57c00',
  yellow: '#fbc02d',
  green: '#2e7d32',
  blue: '#1565c0',
  violet: '#7b1fa2',
  grey: '#8e8e8e',
  white: '#f5f5f5',
  gold: '#c9a227',
  silver: '#c0c0c0',
};

type Builder = (c: SceneComponent, m: Materials, own: OwnedResources) => THREE.Object3D;

/** Per-build resources (geometries, one-off materials, textures) the viewer disposes on rebuild. */
export class OwnedResources {
  readonly geometries: THREE.BufferGeometry[] = [];
  private readonly cache = new Map<string, THREE.BufferGeometry>();
  private readonly matCache = new Map<string, THREE.Material>();
  /** One shared geometry per shape key (identical parts and pins reuse it). */
  shared<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
    let g = this.cache.get(key) as T | undefined;
    if (!g) {
      g = this.geo(make());
      this.cache.set(key, g);
    }
    return g;
  }
  /** One shared material per key (band colours, LED lenses of one colour…). */
  sharedMat<T extends THREE.Material>(key: string, make: () => T): T {
    let m = this.matCache.get(key) as T | undefined;
    if (!m) {
      m = this.mat(make());
      this.matCache.set(key, m);
    }
    return m;
  }
  readonly materials: THREE.Material[] = [];
  readonly textures: THREE.Texture[] = [];
  geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }
  mat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
  tex<T extends THREE.Texture>(t: T): T {
    this.textures.push(t);
    return t;
  }
  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.cache.clear();
    this.matCache.clear();
    this.materials.length = 0;
    this.textures.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

type V3 = [number, number, number];

function mesh(g: THREE.BufferGeometry, m: THREE.Material, at?: V3): THREE.Mesh {
  const x = new THREE.Mesh(g, m);
  if (at) x.position.set(...at);
  x.castShadow = true;
  x.receiveShadow = true;
  return x;
}

function box(own: OwnedResources, w: number, h: number, d: number, m: THREE.Material, at?: V3) {
  return mesh(
    own.shared(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)),
    m,
    at,
  );
}

function cylinder(
  own: OwnedResources,
  r: number,
  h: number,
  m: THREE.Material,
  at?: V3,
  seg = 24,
  r2 = r,
) {
  return mesh(
    own.shared(`cyl:${r}:${r2}:${h}:${seg}`, () => new THREE.CylinderGeometry(r, r2, h, seg)),
    m,
    at,
  );
}

/**
 * A wire-like round path through `pts` with rounded corners (radius `bend`): leads, legs. Shared
 * by key, so identical parts reuse one geometry.
 */
export function roundPath(pts: V3[], bend: number): THREE.CurvePath<THREE.Vector3> {
  const v = pts.map((p) => new THREE.Vector3(...p));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let from = v[0]!;
  for (let i = 1; i < v.length - 1; i++) {
    const p = v[i]!;
    const a = v[i - 1]!;
    const b = v[i + 1]!;
    const r = Math.min(bend, a.distanceTo(p) / 2, p.distanceTo(b) / 2);
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

function tube(own: OwnedResources, pts: V3[], r: number, m: THREE.Material, bend = 0.8) {
  const key = `tube:${r}:${bend}:${pts.map((p) => p.map((n) => n.toFixed(3)).join(',')).join(';')}`;
  const g = own.shared(key, () => {
    const path = roundPath(pts, bend);
    const segs = Math.max(8, Math.ceil(path.getLength() / 0.6));
    return new THREE.TubeGeometry(path, segs, r, 8, false);
  });
  return mesh(g, m);
}

/** A body of revolution around +Y from (radius, height) pairs. */
function lathe(own: OwnedResources, key: string, profile: [number, number][], m: THREE.Material) {
  return mesh(
    own.shared(
      `lathe:${key}`,
      () =>
        new THREE.LatheGeometry(
          profile.map(([r, y]) => new THREE.Vector2(r, y)),
          32,
        ),
    ),
    m,
  );
}

/** A canvas texture (silkscreen, markings, displays). */
function canvasTexture(
  own: OwnedResources,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  draw(ctx);
  const tex = own.tex(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Terminal x positions at rotation 0, mm, and whether each is `open` (touching, unconnected). */
function twoTerminals(c: SceneComponent) {
  const [a, b] = CATALOG[c.type].terminals;
  const open = (id: string) => c.terminals.some((t) => t.id === id && t.open);
  return {
    xa: a!.offset.x * SCALE,
    xb: b!.offset.x * SCALE,
    openA: open(a!.id),
    openB: open(b!.id),
  };
}

/**
 * How far a lead stops short of a terminal that another part's terminal touches WITHOUT a
 * connection (scene.ts `open`): the two lead ends then show a visible gap instead of meeting.
 */
export const OPEN_LEAD_GAP = 1.0;

/** Axial leads: out of the body ends, bent down to the bench at the terminals. */
function axialLeads(c: SceneComponent, p: AxialPhysics, m: Materials, own: OwnedResources) {
  const { xa, xb, openA, openB } = twoTerminals(c);
  const y = p.standoffMm + p.bodyDiameterMm / 2;
  const r = p.leadDiameterMm / 2;
  const endA = xa + (openA ? OPEN_LEAD_GAP : 0);
  const endB = xb - (openB ? OPEN_LEAD_GAP : 0);
  const g = new THREE.Group();
  g.add(
    tube(
      own,
      [
        [-p.bodyLengthMm / 2 + 0.2, y, 0],
        [endA, y, 0],
        [endA, LEAD_ATTACH_HEIGHT - 0.3, 0],
      ],
      r,
      m.lead,
    ),
  );
  g.add(
    tube(
      own,
      [
        [p.bodyLengthMm / 2 - 0.2, y, 0],
        [endB, y, 0],
        [endB, LEAD_ATTACH_HEIGHT - 0.3, 0],
      ],
      r,
      m.lead,
    ),
  );
  return g;
}

/** Rotate a +Y lathe onto the +X axis, centred at height y. */
function alongX(o: THREE.Object3D, y: number) {
  o.rotation.z = -Math.PI / 2;
  o.position.y = y;
  return o;
}

// ---------------------------------------------------------------------------------------------
// Builders

const BUILDERS: Record<ModelKey, Builder> = {
  'resistor.axial': (c, m, own) => {
    const p = RESISTOR;
    const g = new THREE.Group();
    const y = p.standoffMm + p.bodyDiameterMm / 2;
    const L = p.bodyLengthMm;
    const R = p.bodyDiameterMm / 2;
    // The carbon-film "dog bone": end caps slightly fatter than the middle, rounded ends.
    const profile: [number, number][] = [
      [0.001, -L / 2],
      [R * 0.7, -L / 2 + 0.05],
      [R, -L / 2 + 0.45],
      [R, -L / 2 + 1.5],
      [R * 0.88, -L / 2 + 1.9],
      [R * 0.88, L / 2 - 1.9],
      [R, L / 2 - 1.5],
      [R, L / 2 - 0.45],
      [R * 0.7, L / 2 - 0.05],
      [0.001, L / 2],
    ];
    g.add(alongX(lathe(own, `resistor:${L}:${R}`, profile, m.resistorBody), y));
    // Colour bands, from the value (presentation of the design value; never invented).
    const bands = c.visual.bands;
    if (bands) {
      const xs =
        bands.length === 4
          ? [-L / 2 + 1.05, -L / 2 + 1.75, -0.35, L / 2 - 1.05]
          : [-L / 2 + 1.0, -L / 2 + 1.65, -0.45, 0.25, L / 2 - 1.0];
      bands.forEach((b, i) => {
        const x = xs[i]!;
        const inEnd = Math.abs(x) > L / 2 - 1.9;
        const mat = own.sharedMat(
          `band:${b}`,
          () =>
            new THREE.MeshStandardMaterial({
              color: BAND_COLORS[b] ?? '#000',
              roughness: 0.5,
              metalness: b === 'gold' || b === 'silver' ? 0.7 : 0,
            }),
        );
        const ring = cylinder(own, (inEnd ? R : R * 0.88) + 0.02, 0.42, mat, undefined, 28);
        ring.rotation.z = Math.PI / 2;
        ring.position.set(x, y, 0);
        ring.userData.band = b;
        g.add(ring);
      });
    }
    g.add(axialLeads(c, p, m, own));
    return g;
  },

  'diode.axial': (c, m, own) => {
    const p = DIODE_DO35;
    const g = new THREE.Group();
    const y = p.standoffMm + p.bodyDiameterMm / 2;
    const L = p.bodyLengthMm;
    const R = p.bodyDiameterMm / 2;
    const profile: [number, number][] = [
      [0.001, -L / 2],
      [R * 0.75, -L / 2 + 0.08],
      [R, -L / 2 + 0.45],
      [R, L / 2 - 0.45],
      [R * 0.75, L / 2 - 0.08],
      [0.001, L / 2],
    ];
    g.add(alongX(lathe(own, `do35:${L}:${R}`, profile, m.glass), y));
    // Inside the glass: the dark junction slug between two metal studs.
    const slug = cylinder(own, R * 0.42, L * 0.36, m.ic, undefined, 16);
    slug.rotation.z = Math.PI / 2;
    slug.position.set(0, y, 0);
    g.add(slug);
    for (const s of [-1, 1]) {
      const stud = cylinder(own, R * 0.48, L * 0.3, m.lead, undefined, 16);
      stud.rotation.z = Math.PI / 2;
      stud.position.set(s * L * 0.33, y, 0);
      g.add(stud);
    }
    // Cathode band on the cathode (second terminal, +x) end.
    const band = cylinder(own, R + 0.03, 0.45, m.cathodeBand, undefined, 24);
    band.rotation.z = Math.PI / 2;
    band.position.set(L / 2 - 0.6, y, 0);
    band.userData.cathodeBand = true;
    g.add(band);
    g.add(axialLeads(c, p, m, own));
    return g;
  },

  'led.radial': (c, m, own) => {
    const look = c.visual.led ?? { color: '#e53935', package: 't1_34' as const, clear: false };
    const p = LED_PACKAGES[look.package];
    const g = new THREE.Group();
    // Each LED has its own lens material, so its glow is its own.
    const own_lens = own.mat(
      new THREE.MeshStandardMaterial({
        color: look.clear
          ? new THREE.Color(look.color).lerp(new THREE.Color('#ffffff'), 0.6)
          : look.color,
        roughness: look.clear ? 0.08 : 0.32,
        transparent: true,
        opacity: look.clear ? 0.5 : 0.82,
        emissive: look.color,
        emissiveIntensity: 0,
        depthWrite: false,
      }),
    );
    const base = p.standoffMm;
    const R = p.bodyDiameterMm / 2;
    const F = p.flangeDiameterMm / 2;
    const top = base + p.heightMm;
    const domeStart = top - p.domeRadiusMm;
    // Cylinder and dome as one body of revolution, on a flange with the cathode flat (the
    // cathode is the second terminal, +x): the flat is cut into the flange, as on the real part.
    const profile: [number, number][] = [
      [0.001, base + p.flangeThicknessMm],
      [R, base + p.flangeThicknessMm],
      [R, domeStart],
    ];
    for (let i = 1; i <= 10; i++) {
      const a = (i / 10) * (Math.PI / 2);
      profile.push([
        Math.max(0.001, p.domeRadiusMm * Math.cos(a)),
        domeStart + p.domeRadiusMm * Math.sin(a),
      ]);
    }
    const body = lathe(own, `led:${look.package}`, profile, own_lens);
    body.castShadow = false;
    body.userData.lens = true;
    g.add(body);
    const flatX = F - 0.45; // the flat's distance from the axis
    const flange = mesh(
      own.shared(`ledFlange:${look.package}`, () => {
        const a = Math.acos(flatX / F);
        const shape = new THREE.Shape();
        shape.absarc(0, 0, F, a, 2 * Math.PI - a, false);
        shape.lineTo(flatX, F * Math.sin(a));
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: p.flangeThicknessMm,
          bevelEnabled: false,
          curveSegments: 32,
        });
        geo.rotateX(-Math.PI / 2);
        return geo;
      }),
      own_lens,
      [0, base, 0],
    );
    flange.castShadow = false;
    flange.userData.cathodeFlat = flatX;
    g.add(flange);
    // Inside the lens: the anode post and the wider cathode anvil with its reflector cup.
    const inner = base + p.flangeThicknessMm;
    const postH = (domeStart - inner) * 0.75;
    g.add(box(own, 0.35, postH, 0.35, m.lead, [-p.leadPitchMm / 2 + 0.3, inner + postH / 2, 0]));
    g.add(
      box(own, 0.9, postH * 0.85, 0.35, m.lead, [
        p.leadPitchMm / 2 - 0.45,
        inner + (postH * 0.85) / 2,
        0,
      ]),
    );
    g.add(
      cylinder(
        own,
        0.45,
        0.35,
        m.lead,
        [p.leadPitchMm / 2 - 0.45, inner + postH * 0.85, 0],
        16,
        0.3,
      ),
    );
    // Leads: down from the seating plane at 2.54 mm, splayed to the terminals.
    const { xa, xb, openA, openB } = twoTerminals(c);
    const endA = xa + (openA ? OPEN_LEAD_GAP : 0);
    const endB = xb - (openB ? OPEN_LEAD_GAP : 0);
    const lr = p.leadSizeMm / 2;
    const kneeA = 1.6;
    const kneeB = 1.1; // the cathode lead is the shorter one on the real part
    g.add(
      tube(
        own,
        [
          [-p.leadPitchMm / 2, base + 0.2, 0],
          [-p.leadPitchMm / 2, kneeA, 0],
          [endA, kneeA, 0],
          [endA, LEAD_ATTACH_HEIGHT - 0.3, 0],
        ],
        lr,
        m.lead,
      ),
    );
    g.add(
      tube(
        own,
        [
          [p.leadPitchMm / 2, base + 0.2, 0],
          [p.leadPitchMm / 2, kneeB, 0],
          [endB, kneeB, 0],
          [endB, LEAD_ATTACH_HEIGHT - 0.3, 0],
        ],
        lr,
        m.lead,
      ),
    );
    g.userData.lensMaterial = own_lens;
    g.userData.ledTop = top;
    g.userData.ledColor = look.color;
    return g;
  },

  'switch.tactile': (c, m, own) => {
    const p = TACTILE;
    const g = new THREE.Group();
    const y0 = p.standoffMm;
    g.add(
      box(own, p.bodyMm, p.bodyHeightMm - 0.3, p.bodyMm, m.blackPlastic, [
        0,
        y0 + (p.bodyHeightMm - 0.3) / 2,
        0,
      ]),
    );
    // The steel cover plate with its corner tabs.
    g.add(
      box(own, p.bodyMm + 0.1, 0.3, p.bodyMm + 0.1, m.steel, [0, y0 + p.bodyHeightMm - 0.15, 0]),
    );
    for (const sx of [-1, 1])
      g.add(
        box(own, 0.6, p.bodyHeightMm * 0.7, 1.2, m.steel, [
          sx * (p.bodyMm / 2 + 0.05),
          y0 + p.bodyHeightMm * 0.6,
          0,
        ]),
      );
    // Round actuator.
    g.add(
      cylinder(
        own,
        p.actuatorDiameterMm / 2,
        p.actuatorHeightMm,
        m.darkPlastic,
        [0, y0 + p.bodyHeightMm + p.actuatorHeightMm / 2, 0],
        28,
      ),
    );
    // Four legs (pairs are internally joined: the two -x legs are terminal a, the +x legs b), bent
    // out to the terminals.
    const { xa, xb, openA, openB } = twoTerminals(c);
    const legs = (sx: -1 | 1, end: number) => {
      for (const sz of [-1, 1])
        g.add(
          tube(
            own,
            [
              [sx * (p.legPitchXMm / 2), y0 + 0.4, sz * (p.legPitchZMm / 2)],
              [sx * (p.legPitchXMm / 2), 0.9, sz * (p.legPitchZMm / 2)],
              [end, 0.9, sz * (p.legPitchZMm / 2)],
              [end, LEAD_ATTACH_HEIGHT - 0.3, sz * (p.legPitchZMm / 2)],
            ],
            p.legWidthMm / 2,
            m.lead,
            0.5,
          ),
        );
      // The pair joined at the terminal.
      g.add(
        tube(
          own,
          [
            [end, LEAD_ATTACH_HEIGHT - 0.2, -p.legPitchZMm / 2],
            [end, LEAD_ATTACH_HEIGHT - 0.2, p.legPitchZMm / 2],
          ],
          p.legWidthMm / 2,
          m.lead,
        ),
      );
    };
    legs(-1, xa + (openA ? OPEN_LEAD_GAP : 0));
    legs(1, xb - (openB ? OPEN_LEAD_GAP : 0));
    return g;
  },

  'switch.toggle': (c, m, own) => {
    const p = TOGGLE;
    const g = new THREE.Group();
    const y0 = p.standoffMm;
    g.add(
      box(own, p.bodyXMm, p.bodyHeightMm, p.bodyZMm, m.darkPlastic, [
        0,
        y0 + p.bodyHeightMm / 2,
        0,
      ]),
    );
    // Chrome frame band around the body.
    g.add(
      box(own, p.bodyXMm + 0.2, 1.0, p.bodyZMm + 0.2, m.chrome, [0, y0 + p.bodyHeightMm - 0.5, 0]),
    );
    const bushTop = y0 + p.bodyHeightMm + p.bushingHeightMm;
    g.add(
      cylinder(
        own,
        p.bushingDiameterMm / 2,
        p.bushingHeightMm,
        m.chrome,
        [0, y0 + p.bodyHeightMm + p.bushingHeightMm / 2, 0],
        24,
      ),
    );
    g.add(
      cylinder(
        own,
        p.bushingDiameterMm / 2 + 0.9,
        0.9,
        m.steel,
        [0, y0 + p.bodyHeightMm + 0.45, 0],
        6,
      ),
    );
    // Lever: leans toward one side when closed (the persisted position).
    const tilt = c.visual.closed ? -0.38 : 0.38;
    const lever = cylinder(
      own,
      p.leverDiameterMm / 2,
      p.leverLengthMm,
      m.chrome,
      undefined,
      16,
      p.leverDiameterMm / 2 + 0.25,
    );
    lever.position.set(
      Math.sin(-tilt) * (p.leverLengthMm / 2),
      bushTop + Math.cos(tilt) * (p.leverLengthMm / 2),
      0,
    );
    lever.rotation.z = tilt;
    lever.userData.lever = c.visual.closed ? 'closed' : 'open';
    g.add(lever);
    const tip = new THREE.Mesh(
      own.shared('sphere:0.95', () => new THREE.SphereGeometry(0.95, 16, 12)),
      m.chrome,
    );
    tip.position.set(
      Math.sin(-tilt) * p.leverLengthMm,
      bushTop + Math.cos(tilt) * p.leverLengthMm,
      0,
    );
    tip.castShadow = true;
    g.add(tip);
    const { xa, xb, openA, openB } = twoTerminals(c);
    for (const [sx, end] of [
      [-1, xa + (openA ? OPEN_LEAD_GAP : 0)],
      [1, xb - (openB ? OPEN_LEAD_GAP : 0)],
    ] as const)
      g.add(
        tube(
          own,
          [
            [sx * 2.54, y0 + 0.2, 0],
            [sx * 2.54, 0.9, 0],
            [end, 0.9, 0],
            [end, LEAD_ATTACH_HEIGHT - 0.3, 0],
          ],
          0.4,
          m.lead,
          0.5,
        ),
      );
    return g;
  },

  'ground.post': (c, m, own) => {
    // A small black binding post just behind the terminal, its tinned lug reaching the terminal.
    const p = GROUND_POST;
    const g = new THREE.Group();
    const t = CATALOG[c.type].terminals[0]!;
    const x = t.offset.x * SCALE;
    const z = t.offset.y * SCALE;
    const pz = z + p.postOffsetZMm;
    g.add(
      box(own, p.plateMm, p.plateThicknessMm, p.plateMm, m.steel, [x, p.plateThicknessMm / 2, pz]),
    );
    const y0 = p.plateThicknessMm;
    g.add(cylinder(own, 1.25, 0.9, m.chrome, [x, y0 + 0.45, pz], 6));
    g.add(
      cylinder(
        own,
        p.postDiameterMm / 2,
        p.postHeightMm - 1.5,
        m.black,
        [x, y0 + 0.9 + (p.postHeightMm - 1.5) / 2, pz],
        28,
      ),
    );
    g.add(
      cylinder(
        own,
        p.postDiameterMm / 2 + 0.1,
        0.6,
        m.black,
        [x, y0 + p.postHeightMm - 0.3, pz],
        28,
        p.postDiameterMm / 2 - 0.3,
      ),
    );
    // The lug: a flat tinned strip from the post's foot to a ring at the terminal.
    g.add(
      box(own, 1.2, 0.3, p.postOffsetZMm, m.lead, [
        x,
        p.attachHeightMm - 0.15,
        z + p.postOffsetZMm / 2,
      ]),
    );
    const ring = mesh(
      own.shared('torus:lug', () => new THREE.TorusGeometry(0.7, 0.25, 8, 20)),
      m.lead,
      [x, p.attachHeightMm - 0.15, z],
    );
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    return g;
  },

  'instrument.psu': (c, m, own) => {
    // A bench supply at REDUCED, SYMBOLIC scale (physical.ts PSU): case, front panel with its two
    // displays (the design setpoints), knobs, and red/black binding posts at the terminals.
    const p = PSU;
    const g = new THREE.Group();
    const cx = p.frontXMm - p.bodyXMm / 2;
    g.add(box(own, p.bodyXMm, p.bodyHeightMm, p.bodyZMm, m.psuCase, [cx, p.bodyHeightMm / 2, 0]));
    g.add(
      box(own, 0.5, p.bodyHeightMm - 1.2, p.bodyZMm - 1.2, m.psuPanel, [
        p.frontXMm + 0.2,
        p.bodyHeightMm / 2,
        0,
      ]),
    );
    // Feet.
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        g.add(
          box(own, 2, 0.6, 2, m.black, [
            cx + sx * (p.bodyXMm / 2 - 1.6),
            0.3,
            sz * (p.bodyZMm / 2 - 1.6),
          ]),
        );
    // Displays: the setpoint voltage (green) and current limit (red), as designed.
    const v = { psuVolts: c.visual.psu?.volts, psuAmps: c.visual.psu?.amps };
    const screen = canvasTexture(own, 256, 96, (ctx) => {
      ctx.fillStyle = '#071810';
      ctx.fillRect(0, 0, 256, 96);
      ctx.font = 'bold 64px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#5dff8a';
      ctx.fillText(v.psuVolts !== undefined ? v.psuVolts.toFixed(2) : '0.00', 128, 52);
    });
    const screenA = canvasTexture(own, 256, 96, (ctx) => {
      ctx.fillStyle = '#1a0806';
      ctx.fillRect(0, 0, 256, 96);
      ctx.font = 'bold 64px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ff6a4d';
      ctx.fillText(v.psuAmps !== undefined ? v.psuAmps.toFixed(3) : '0.000', 128, 52);
    });
    const dispV = new THREE.Mesh(
      own.shared('plane:psuDisplay', () => new THREE.PlaneGeometry(4.6, 1.75)),
      own.mat(
        // The plain textured variant (no emissive map: one shader program fewer); the
        // display's own bright digits read as lit.
        new THREE.MeshStandardMaterial({ map: screen, roughness: 0.3 }),
      ),
    );
    dispV.rotation.y = Math.PI / 2;
    dispV.position.set(p.frontXMm + 0.46, p.bodyHeightMm - 2.0, -2.75);
    const dispA = new THREE.Mesh(
      own.shared('plane:psuDisplay', () => new THREE.PlaneGeometry(4.6, 1.75)),
      own.mat(
        // The plain textured variant (no emissive map: one shader program fewer); the
        // display's own bright digits read as lit.
        new THREE.MeshStandardMaterial({ map: screenA, roughness: 0.3 }),
      ),
    );
    dispA.rotation.y = Math.PI / 2;
    dispA.position.set(p.frontXMm + 0.46, p.bodyHeightMm - 2.0, 2.75);
    g.add(dispV, dispA);
    for (const sz of [-1, 1]) {
      const knob = cylinder(own, 1.05, 1.0, m.black, undefined, 24);
      knob.rotation.z = Math.PI / 2;
      knob.position.set(p.frontXMm + 0.9, p.bodyHeightMm - 4.6, sz * 2.75);
      g.add(knob);
    }
    for (const t of CATALOG[c.type].terminals) {
      const z = t.offset.y * SCALE;
      const x = t.offset.x * SCALE;
      const post = cylinder(
        own,
        p.postDiameterMm / 2,
        p.postLengthMm,
        t.id === 'positive' ? m.red : m.black,
        undefined,
        20,
      );
      post.rotation.z = Math.PI / 2;
      post.position.set(p.frontXMm + p.postLengthMm / 2 + 0.4, p.attachHeightMm, z);
      post.userData.polarity = t.id;
      g.add(post);
      const stud = cylinder(own, 0.5, x - p.frontXMm, m.chrome, undefined, 12);
      stud.rotation.z = Math.PI / 2;
      stud.position.set((x + p.frontXMm) / 2 + 0.3, p.attachHeightMm, z);
      g.add(stud);
    }
    return g;
  },

  'board.esp32_devkitc': (c, m, own) => buildEsp32(c, m, own),

  generic: (c, m, own) => {
    const g = new THREE.Group();
    g.add(box(own, 6, 2.5, 3, m.generic, [0, 2, 0]));
    for (const t of CATALOG[c.type].terminals)
      g.add(
        tube(
          own,
          [
            [0, 1.2, 0],
            [t.offset.x * SCALE, 1.2, t.offset.y * SCALE],
            [t.offset.x * SCALE, LEAD_ATTACH_HEIGHT - 0.3, t.offset.y * SCALE],
          ],
          0.3,
          m.lead,
        ),
      );
    return g;
  },
};

/** ESP32-DevKitC V4 at its real size (physical.ts, [ESP-DIM]). */
function buildEsp32(c: SceneComponent, m: Materials, own: OwnedResources): THREE.Object3D {
  const d = ESP32_DEVKITC;
  const g = new THREE.Group();
  const zc = d.pcbCentreZMm;
  const zTop = zc - d.pcbLengthMm / 2; // the antenna end (pin 1)
  const zBottom = zc + d.pcbLengthMm / 2; // the USB end
  const rowX = d.headerRowSpacingMm / 2;

  // PCB with its silkscreen (pin names beside each header, board name, button labels).
  const silk = canvasTexture(own, 560, 1020, (ctx) => {
    const k = 560 / d.pcbWidthMm;
    ctx.fillStyle = '#16191e';
    ctx.fillRect(0, 0, 560, 1020);
    const X = (mm: number) => (mm + d.pcbWidthMm / 2) * k;
    const Z = (mm: number) => (mm - zTop) * k;
    ctx.strokeStyle = '#d9dde2';
    ctx.fillStyle = '#e6e9ec';
    ctx.lineWidth = 2;
    ctx.font = 'bold 26px ui-sans-serif, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    for (const pin of ESP32_DEVKITC_WROOM32.pins) {
      const local = boardPinPosition(pin);
      const z = realPinZ(pin.position);
      const left = local.x < 0;
      const x = left ? -rowX : rowX;
      // Pad ring.
      ctx.beginPath();
      ctx.arc(X(x), Z(z), 0.95 * k, 0, Math.PI * 2);
      ctx.fillStyle = '#c9a54a';
      ctx.fill();
      ctx.fillStyle = '#e6e9ec';
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillText(pin.headerLabel, X(left ? x + 1.7 : x - 1.7), Z(z));
    }
    ctx.textAlign = 'center';
    ctx.font = 'bold 24px ui-sans-serif, Arial, sans-serif';
    ctx.fillText('EN', X(-8.2), Z(zBottom - 8.7));
    ctx.fillText('BOOT', X(8.2), Z(zBottom - 8.7));
    ctx.save();
    ctx.translate(X(-4.6), Z(zc + 6));
    ctx.rotate(-Math.PI / 2);
    ctx.font = 'bold 22px ui-sans-serif, Arial, sans-serif';
    ctx.fillText('ESP32-DevKitC V4', 0, 0);
    ctx.restore();
  });
  const pcbTop = own.mat(new THREE.MeshStandardMaterial({ map: silk, roughness: 0.55 }));
  const pcbGeo = own.shared(
    'esp32:pcb',
    () => new THREE.BoxGeometry(d.pcbWidthMm, d.pcbThicknessMm, d.pcbLengthMm),
  );
  // Box material order: +x, -x, +y (top), -y, +z, -z.
  const pcb = new THREE.Mesh(pcbGeo, [m.pcbEdge, m.pcbEdge, pcbTop, m.pcb, m.pcbEdge, m.pcbEdge]);
  pcb.position.set(0, ESP32_PCB_BOTTOM + d.pcbThicknessMm / 2, zc);
  pcb.castShadow = true;
  pcb.receiveShadow = true;
  g.add(pcb);

  // ESP32-WROOM-32 module: its own board, overhanging the top edge with the PCB antenna, and the
  // shield can carrying its marking.
  const modZ0 = zTop - d.moduleOverhangMm;
  const modZ1 = modZ0 + d.moduleLengthMm;
  const antenna = canvasTexture(own, 360, 510, (ctx) => {
    const k = 360 / d.moduleWidthMm;
    ctx.fillStyle = '#1b2733';
    ctx.fillRect(0, 0, 360, 510);
    // The meandered inverted-F antenna trace.
    ctx.strokeStyle = '#c9a54a';
    ctx.lineWidth = 0.55 * k;
    ctx.beginPath();
    const y0 = 1.2 * k;
    ctx.moveTo(1.5 * k, 5.4 * k);
    ctx.lineTo(1.5 * k, y0);
    let x = 1.5 * k;
    for (let i = 0; i < 6; i++) {
      x += 2.4 * k;
      ctx.lineTo(x, y0);
      ctx.lineTo(x, i % 2 ? y0 : 4.2 * k);
      ctx.lineTo(x + 1.2 * k, i % 2 ? y0 : 4.2 * k);
      ctx.lineTo(x + 1.2 * k, y0);
      x += 1.2 * k;
    }
    ctx.stroke();
  });
  const modTop = own.mat(new THREE.MeshStandardMaterial({ map: antenna, roughness: 0.6 }));
  const modGeo = own.shared(
    'esp32:module',
    () => new THREE.BoxGeometry(d.moduleWidthMm, d.moduleThicknessMm, d.moduleLengthMm),
  );
  const mod = new THREE.Mesh(modGeo, [
    m.moduleBoard,
    m.moduleBoard,
    modTop,
    m.moduleBoard,
    m.moduleBoard,
    m.moduleBoard,
  ]);
  mod.position.set(0, ESP32_PCB_TOP + d.moduleThicknessMm / 2, (modZ0 + modZ1) / 2);
  mod.castShadow = true;
  mod.receiveShadow = true;
  g.add(mod);
  const marking = canvasTexture(own, 320, 350, (ctx) => {
    ctx.fillStyle = '#cfd3d8';
    ctx.fillRect(0, 0, 320, 350);
    ctx.fillStyle = '#4a4f55';
    ctx.textAlign = 'center';
    ctx.font = 'bold 34px ui-sans-serif, Arial, sans-serif';
    ctx.fillText('ESP32-WROOM-32', 160, 150);
    ctx.font = '24px ui-sans-serif, Arial, sans-serif';
    ctx.fillText('Espressif', 160, 200);
  });
  const shieldTop = own.mat(
    new THREE.MeshStandardMaterial({ map: marking, metalness: 0.5, roughness: 0.4 }),
  );
  const shieldGeo = own.shared(
    'esp32:shield',
    () => new THREE.BoxGeometry(d.shieldWidthMm, d.shieldHeightMm, d.shieldLengthMm),
  );
  const shield = new THREE.Mesh(shieldGeo, [
    m.shield,
    m.shield,
    shieldTop,
    m.shield,
    m.shield,
    m.shield,
  ]);
  shield.position.set(
    0,
    ESP32_PCB_TOP + d.moduleThicknessMm + d.shieldHeightMm / 2,
    modZ1 - 0.9 - d.shieldLengthMm / 2,
  );
  shield.castShadow = true;
  g.add(shield);

  // Micro-USB connector at the bottom edge, the USB-UART bridge, the regulator, EN/BOOT buttons,
  // the power LED and a few passives (the parts that make the board recognisable).
  const top = ESP32_PCB_TOP;
  g.add(box(own, 7.5, 2.8, 5.6, m.chrome, [0, top + 1.4, zBottom - 5.6 / 2 + 1.0]));
  g.add(box(own, 6.3, 1.4, 0.8, m.black, [0, top + 1.4, zBottom + 1.05]));
  g.add(box(own, 5, 0.9, 5, m.ic, [1.5, top + 0.45, zc + 13.5]));
  g.add(box(own, 6.5, 1.6, 3.5, m.ic, [-1.0, top + 0.8, zc + 4.0]));
  g.add(box(own, 3.0, 1.6, 0.8, m.lead, [-1.0, top + 0.8, zc + 6.0]));
  for (const sx of [-1, 1]) {
    g.add(box(own, 3.5, 1.4, 4.6, m.white, [sx * 8.2, top + 0.7, zBottom - 5.0]));
    g.add(cylinder(own, 0.9, 0.7, m.darkPlastic, [sx * 8.2, top + 1.75, zBottom - 5.0], 16));
  }
  g.add(box(own, 1.6, 0.5, 0.8, m.smdLed, [-6.0, top + 0.25, zc + 13.0]));
  for (const [x, z] of [
    [4.2, 6.5],
    [4.2, 8.5],
    [-4.8, 9.5],
    [6.2, 13.5],
    [-3.2, 15.5],
    [2.8, 17.5],
  ] as const)
    g.add(box(own, 1.6, 0.5, 0.8, m.smdTan, [x, top + 0.25, zc + z]));

  // Male headers: plastic strips under the PCB, every pin through them (one instanced mesh), and
  // a jumper housing on every pin that carries a wire.
  for (const sx of [-1, 1])
    g.add(
      box(own, 2.54, d.headerPlasticHeightMm, d.headerSpanMm, m.blackPlastic, [
        sx * rowX,
        d.pinBelowPlasticMm + d.headerPlasticHeightMm / 2,
        0,
      ]),
    );
  // Every header pin, as one merged geometry (one draw, and no instanced shader variant: on
  // software WebGL every extra shader program costs a noticeable compile on each opening).
  const pinLen = top + d.pinStubAboveMm;
  const pinGeo = own.shared(`esp32:pins:${pinLen}`, () => {
    const one = new THREE.BoxGeometry(d.pinSizeMm, pinLen, d.pinSizeMm).toNonIndexed();
    const parts = ESP32_DEVKITC_WROOM32.pins.map((pin) => {
      const local = boardPinPosition(pin);
      return one.clone().translate(Math.sign(local.x) * rowX, pinLen / 2, realPinZ(pin.position));
    });
    const merged = mergeGeometries(parts, false)!;
    one.dispose();
    for (const g of parts) g.dispose();
    return merged;
  });
  const pins = mesh(pinGeo, m.gold);
  pins.userData.headerPins = ESP32_DEVKITC_WROOM32.pins.length;
  g.add(pins);
  const wired = new Set(c.visual.wiredPins ?? []);
  for (const pin of ESP32_DEVKITC_WROOM32.pins) {
    const id = boardTerminalId(pin);
    if (!id || !wired.has(id)) continue;
    const local = boardPinPosition(pin);
    const h = box(own, d.dupontSizeMm, d.dupontHeightMm, d.dupontSizeMm, m.blackPlastic, [
      Math.sign(local.x) * rowX,
      top + 0.3 + d.dupontHeightMm / 2,
      realPinZ(pin.position),
    ]);
    h.userData.jumper = id;
    g.add(h);
  }
  return g;
}

/** Build the model of one component, placed and rotated in the scene. */
export function buildComponent(
  c: SceneComponent,
  m: Materials,
  own: OwnedResources,
): THREE.Object3D {
  const local = (BUILDERS[c.model] ?? BUILDERS.generic)(c, m, own);
  local.position.set(c.x, 0, c.z);
  local.rotation.y = c.rotationY;
  local.name = c.id;
  local.userData.component = c.id;
  local.userData.model = c.model;
  return local;
}
