/**
 * Shared building blocks of the procedural 3D models (Sprint 9/10): owned GPU resources and the
 * geometry helpers every builder uses. No product knowledge here.
 */
import * as THREE from 'three';

/** Templates of the viewer-lifetime textures, kept for the page (CPU-side images only). */
const pageTextures = new Map<string, THREE.Texture>();

/** Per-build resources (geometries, one-off materials, textures) the viewer disposes on rebuild. */
export class OwnedResources {
  /**
   * @param persistent the viewer's long-lived resources: what does not depend on the project
   *   (board surface textures, marking atlases) is drawn once per viewer and kept across rebuilds.
   * @param tier rendering tier: builders size textures and pick detail by it.
   */
  constructor(
    readonly persistent: OwnedResources | null = null,
    readonly tier: 'full' | 'reduced' = 'full',
  ) {}
  /** A viewer-lifetime texture (or this build's, without a persistent store), drawn once per key. */
  lasting<T extends THREE.Texture>(key: string, make: () => T): T {
    const store = this.persistent ?? this;
    let t = store.texCache.get(key) as T | undefined;
    if (!t) {
      // Drawn once per page: a later viewer gets a copy sharing the drawn image (only the GPU
      // upload is per viewer), so re-entering the 3D view never redraws these textures.
      const template = pageTextures.get(key) as T | undefined;
      t = store.tex(template ? (template.clone() as T) : make());
      if (!template) pageTextures.set(key, t.clone());
      store.texCache.set(key, t);
    }
    return t;
  }
  private readonly texCache = new Map<string, THREE.Texture>();
  /** A viewer-lifetime material, made once per key (parts whose look never depends on the project). */
  lastingMat<T extends THREE.Material>(key: string, make: () => T): T {
    return (this.persistent ?? this).sharedMat(`lasting:${key}`, make);
  }
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
    this.texCache.clear();
    this.materials.length = 0;
    this.textures.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

export type V3 = [number, number, number];

export function mesh(g: THREE.BufferGeometry, m: THREE.Material, at?: V3): THREE.Mesh {
  const x = new THREE.Mesh(g, m);
  if (at) x.position.set(...at);
  x.castShadow = true;
  x.receiveShadow = true;
  return x;
}

export function box(
  own: OwnedResources,
  w: number,
  h: number,
  d: number,
  m: THREE.Material,
  at?: V3,
) {
  return mesh(
    own.shared(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)),
    m,
    at,
  );
}

export function cylinder(
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

export function tube(
  own: OwnedResources,
  pts: V3[],
  r: number,
  m: THREE.Material,
  bend = 0.8,
  radial = 8,
) {
  const key = `tube:${r}:${bend}:${radial}:${pts.map((p) => p.map((n) => n.toFixed(3)).join(',')).join(';')}`;
  const g = own.shared(key, () => {
    const path = roundPath(pts, bend);
    // Finer along round leads (radial >= 12): smooth bends instead of faceted elbows.
    const segs = Math.max(8, Math.ceil(path.getLength() / (radial >= 12 ? 0.2 : 0.6)));
    return new THREE.TubeGeometry(path, segs, r, radial, false);
  });
  return mesh(g, m);
}

/**
 * A flat stamped lead (a tactile switch's leg, a lug): a rectangular strip `width` x `thick` swept
 * along a path with rounded bends. The strip's width lies along the fixed `widthAxis` (the path
 * must stay perpendicular to it, as a formed leg in one plane does); its thickness along the
 * path's normal in that plane. Shared per shape.
 */
export function ribbon(
  own: OwnedResources,
  pts: V3[],
  width: number,
  thick: number,
  m: THREE.Material,
  bend = 0.5,
  widthAxis: V3 = [0, 0, 1],
) {
  const key = `ribbon:${width}:${thick}:${bend}:${widthAxis.join(',')}:${pts.map((p) => p.map((n) => n.toFixed(3)).join(',')).join(';')}`;
  const g = own.shared(key, () => {
    const path = roundPath(pts, bend);
    const n = Math.max(8, Math.ceil(path.getLength() / 0.15));
    const W = new THREE.Vector3(...widthAxis).normalize();
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;
    const pos: number[] = [];
    const ring = (i: number) => {
      const u = i / n;
      const c = path.getPointAt(u);
      const t = path.getTangentAt(u).normalize();
      const N = new THREE.Vector3().crossVectors(t, W).normalize();
      return corners.map(([a, b]) =>
        c
          .clone()
          .addScaledVector(W, (a * width) / 2)
          .addScaledVector(N, (b * thick) / 2),
      );
    };
    let prev = ring(0);
    const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
      pos.push(
        ...a.toArray(),
        ...b.toArray(),
        ...c.toArray(),
        ...a.toArray(),
        ...c.toArray(),
        ...d.toArray(),
      );
    // End caps.
    quad(prev[0]!, prev[3]!, prev[2]!, prev[1]!);
    for (let i = 1; i <= n; i++) {
      const cur = ring(i);
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        quad(prev[k]!, prev[k2]!, cur[k2]!, cur[k]!);
      }
      prev = cur;
    }
    quad(prev[0]!, prev[1]!, prev[2]!, prev[3]!);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  });
  return mesh(g, m);
}

/** A body of revolution around +Y from (radius, height) pairs. */
export function lathe(
  own: OwnedResources,
  key: string,
  profile: [number, number][],
  m: THREE.Material,
) {
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

/** A canvas texture (silkscreen, markings, displays), owned by this build. */
export function canvasTexture(
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

/** Drawn canvases by key, for the page's lifetime (they hold no GPU resource). */
const drawn = new Map<string, HTMLCanvasElement>();

/**
 * A canvas texture not yet owned by anyone (for OwnedResources.lasting). With `cacheKey`, the
 * drawing is done once per page and reused by later viewers (only the upload is per viewer):
 * re-entering the 3D view does not redraw board surfaces.
 */
export function drawTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  color = true,
  cacheKey?: string,
): THREE.CanvasTexture {
  let canvas = cacheKey ? drawn.get(cacheKey) : undefined;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    draw(canvas.getContext('2d', { willReadFrequently: true })!);
    if (cacheKey) drawn.set(cacheKey, canvas);
  }
  const tex = new THREE.CanvasTexture(canvas);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
