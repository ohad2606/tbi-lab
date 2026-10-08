/**
 * Deterministic material variation (realism pass 8): parts from the same batch, not clones.
 *
 * Identical parts drawn with one material look perfectly identical, the strongest remaining
 * computer-graphics cue. Here each physical piece gets a small, fixed offset of its finish:
 * - roughness (+- a few hundredths: seen in the highlights),
 * - value (brightness, +- 1-3 %, only where a colour carries no meaning),
 * - the strength of a fine moulded/plated micro-surface (procedural noise in the shader: a faint
 *   roughness mottle and a tiny normal ripple, faded out before it gets smaller than a pixel, so
 *   it never shimmers).
 *
 * Deterministic: the offset is a hash of the component id, the mesh and the piece's index inside
 * it (no runtime randomness: the same project shows the same parts every time, in every viewer).
 *
 * No material explosion: the offsets are a per-vertex attribute (`aVar`) baked into the static
 * batches (renderer.ts batchStatic), so a varied family stays ONE material and ONE draw call. Each
 * family's material is replaced in its batch by one varied copy per viewer (the shared glTF
 * template is never modified); the copies share one shader program per material kind.
 *
 * Never varied: what carries meaning or identity (resistor colour bands, LED lens colours, wire
 * insulation colours by net, silkscreen and markings, the PCB) beyond roughness, and nothing
 * changes a shape, a size or a position. Full tier only (the reduced tier's software rasteriser
 * pays per pixel, and has no environment for a roughness change to show in).
 *
 * Pure parts (hash, families, pieces, offsets) need no WebGL and are unit-tested.
 */
import * as THREE from 'three';

export interface VaryFamily {
  /** Roughness offset range, +-. */
  rough: number;
  /** Relative brightness range, +- (0: the colour is never changed). */
  value: number;
  /** Strength of the micro-surface (0 none, 1 moulded plastic). */
  detail: number;
  /**
   * What one varied piece is: each connected piece of a mesh (a pin, a chip, a header segment), or
   * each side of the part (x < 0, x > 0: a header strip is one moulding).
   */
  piece?: 'island' | 'side';
}

// Metals: the finish offset only, almost no micro-relief (a polished or plated surface mirrors
// the studio: any ripple reads as dents).
const METAL: VaryFamily = { rough: 0.04, value: 0.01, detail: 0.08 };
const PLASTIC: VaryFamily = { rough: 0.05, value: 0.03, detail: 1 };
/** Colour carries meaning or must match (resistor body, a coloured case, net colours): finish only. */
const FINISH_ONLY: VaryFamily = { rough: 0.04, value: 0, detail: 0.5 };

/** Varied families by material name (glTF asset materials and the procedural library). */
export const FAMILIES: Readonly<Record<string, VaryFamily>> = {
  // ESP32-DevKitC asset (esp32DevkitC.author.ts).
  header_pbt: { ...PLASTIC, piece: 'side' },
  ic_mould: { rough: 0.05, value: 0.025, detail: 1.25 },
  switch_body: PLASTIC,
  switch_actuator: { rough: 0.05, value: 0.02, detail: 0.8 },
  usb_tongue: { rough: 0.04, value: 0.02, detail: 0.6 },
  mlcc_ceramic: { rough: 0.05, value: 0.02, detail: 0.6 },
  chip_resistor: { rough: 0.04, value: 0.02, detail: 0.5 },
  chip_substrate: { rough: 0.04, value: 0.015, detail: 0.6 },
  led_body: { rough: 0.03, value: 0, detail: 0.4 },
  pin_gold: { rough: 0.035, value: 0.01, detail: 0.08 },
  lead_tin: METAL,
  solder: { rough: 0.05, value: 0.01, detail: 0.12 },
  enig_gold: { rough: 0.03, value: 0.01, detail: 0.08 },
  switch_cover: { rough: 0.03, value: 0.01, detail: 0.08 },
  // Procedural library (models.ts createMaterials).
  lead: METAL,
  gold: METAL,
  chrome: { rough: 0.03, value: 0.01, detail: 0 },
  steel: METAL,
  blackPlastic: PLASTIC,
  darkPlastic: PLASTIC,
  ic: { rough: 0.05, value: 0.025, detail: 1.25 },
  black: { rough: 0.04, value: 0.02, detail: 0.6 },
  white: { rough: 0.04, value: 0.015, detail: 0.6 },
  rubber: { rough: 0.05, value: 0.02, detail: 1 },
  resistorBody: FINISH_ONLY,
  red: { rough: 0.04, value: 0, detail: 0.4 },
  smdTan: { rough: 0.05, value: 0.02, detail: 0.6 },
  psuCase: { rough: 0.04, value: 0.01, detail: 0.5 },
  psuPanel: { rough: 0.04, value: 0.01, detail: 0.5 },
  // Jumper housings (dupont.ts).
  dupont_housing: PLASTIC,
  // Wire insulation: the colour is the net's, never changed; the jacket's own bump stays.
  wire_jacket: { rough: 0.03, value: 0, detail: 0 },
};

/** The family of a material, or null (never varied). */
export function familyOf(m: THREE.Material): VaryFamily | null {
  return FAMILIES[(m.userData.varyFamily as string | undefined) ?? m.name] ?? null;
}

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Two independent values in [-1, 1) from a seed string. */
function signed2(seed: string): [number, number] {
  const a = hash32(seed);
  // A second, decorrelated hash (murmur3 finaliser).
  let b = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  b = Math.imul(b ^ (b >>> 13), 0xc2b2ae35);
  b = (b ^ (b >>> 16)) >>> 0;
  return [(a / 2 ** 32) * 2 - 1, (b / 2 ** 32) * 2 - 1];
}

/** One piece's offsets: [roughness delta, relative brightness delta, micro-surface strength]. */
export function pieceOffsets(f: VaryFamily, seed: string): [number, number, number] {
  const [r, v] = signed2(seed);
  return [r * f.rough, v * f.value, f.detail];
}

/**
 * The connected pieces of a geometry: a piece index per vertex (vertices at the same position
 * are one piece even where hard edges split them; a triangle's vertices are one piece; pieces
 * whose bounds touch are one). Pieces are numbered in the order of their first vertex
 * (deterministic). Pure.
 */
export function pieceIndex(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
): Uint32Array {
  const n = positions.length / 3;
  const parent = new Uint32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(positions[i * 3]! * 1e4)},${Math.round(positions[i * 3 + 1]! * 1e4)},${Math.round(positions[i * 3 + 2]! * 1e4)}`;
    const j = seen.get(k);
    if (j === undefined) seen.set(k, i);
    else union(i, j);
  }
  const tris = index ? index.length : n;
  for (let t = 0; t + 2 < tris; t += 3) {
    const a = index ? index[t]! : t;
    const b = index ? index[t + 1]! : t + 1;
    const c = index ? index[t + 2]! : t + 2;
    union(a, b);
    union(a, c);
  }
  // Pieces that touch are one part (a pin's shaft and its chamfered tips, a termination and its
  // solder fillet): islands whose bounds meet are joined (sweep along x).
  const box = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const b = box.get(r) ?? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k]!, positions[i * 3 + k]!);
      b[k + 3] = Math.max(b[k + 3]!, positions[i * 3 + k]!);
    }
    box.set(r, b);
  }
  const eps = 1e-3;
  const islands = [...box.entries()].sort((a, b) => a[1][0]! - b[1][0]!);
  for (let a = 0; a < islands.length; a++) {
    const [ra, ba] = islands[a]!;
    for (let b = a + 1; b < islands.length; b++) {
      const [rb, bb] = islands[b]!;
      if (bb[0]! > ba[3]! + eps) break;
      if (
        bb[1]! <= ba[4]! + eps &&
        ba[1]! <= bb[4]! + eps &&
        bb[2]! <= ba[5]! + eps &&
        ba[2]! <= bb[5]! + eps
      )
        union(ra, rb);
    }
  }
  const out = new Uint32Array(n);
  const number = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let k = number.get(r);
    if (k === undefined) {
      k = number.size;
      number.set(r, k);
    }
    out[i] = k;
  }
  return out;
}

/** Piece numbering per source geometry (template geometries are shared: computed once per page). */
const pieceCache = new WeakMap<THREE.BufferGeometry, Uint32Array>();

/**
 * The `aVar` attribute (vec3 per vertex, see pieceOffsets) for one source mesh's NON-INDEXED copy
 * (`flat`), from its original geometry `source` (indexed or not). `seed` names the mesh (its
 * component and its place in it); each piece adds its own number.
 */
export function variationAttribute(
  f: VaryFamily,
  source: THREE.BufferGeometry,
  flat: THREE.BufferGeometry,
  seed: string,
): THREE.BufferAttribute {
  const pos = source.attributes.position!;
  let pieces = pieceCache.get(source);
  if (!pieces) {
    pieces = pieceIndex(pos.array as ArrayLike<number>, source.index?.array ?? null);
    pieceCache.set(source, pieces);
  }
  const n = flat.attributes.position!.count;
  const out = new Float32Array(n * 3);
  const idx = source.index;
  const memo = new Map<number, [number, number, number]>();
  for (let i = 0; i < n; i++) {
    const v = idx ? idx.getX(i) : i;
    let key = pieces[v]!;
    if (f.piece === 'side') key = pos.getX(v) < 0 ? 0 : 1;
    let o = memo.get(key);
    if (!o) {
      o = pieceOffsets(f, `${seed}#${key}`);
      memo.set(key, o);
    }
    out.set(o, i * 3);
  }
  return new THREE.BufferAttribute(out, 3);
}

/** Micro-surface: spatial frequency (per mm) and the relief's height (mm) at strength 1. */
export const DETAIL_FREQ = 4.5;
export const DETAIL_BUMP = 0.012;
/** Roughness mottle of the micro-surface at strength 1, +-. */
export const DETAIL_ROUGH = 0.07;

const NOISE = /* glsl */ `
  varying vec3 vVar;
  varying vec3 vVarPos;
  float varHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float varNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(varHash(i), varHash(i + vec3(1, 0, 0)), f.x),
                   mix(varHash(i + vec3(0, 1, 0)), varHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(varHash(i + vec3(0, 0, 1)), varHash(i + vec3(1, 0, 1)), f.x),
                   mix(varHash(i + vec3(0, 1, 1)), varHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
`;

/**
 * Make a material read the `aVar` attribute (a varied copy; the caller owns it). Meshes without
 * the attribute are never drawn with it (only batches carry it).
 */
export function variedMaterial<T extends THREE.Material>(original: T): T {
  const m = original.clone() as T;
  m.userData = { ...original.userData, varied: true };
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aVar;
        varying vec3 vVar;
        varying vec3 vVarPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vVar = aVar;
        vVarPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= 1.0 + vVar.y;
        // The micro-surface: two octaves of value noise in the part's own space (static: it never
        // swims as the camera moves), faded out as its cells shrink below a pixel (no shimmer).
        vec3 varP = vVarPos * ${DETAIL_FREQ.toFixed(3)};
        float varN = varNoise(varP) * 0.65 + varNoise(varP * 2.37 + 11.0) * 0.35 - 0.5;
        float varFade = 1.0 - smoothstep(0.3, 0.8, length(fwidth(varP)));
        float varDetail = varN * varFade * vVar.z;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + vVar.x + varDetail * ${DETAIL_ROUGH.toFixed(3)}, 0.04, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // A relief of height varDetail * BUMP (mm) on the surface (as a bump map would).
          float varH = varDetail * ${DETAIL_BUMP.toFixed(4)};
          vec3 sx = dFdx(-vViewPosition);
          vec3 sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal);
          vec3 r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dFdx(varH) * r1 + dFdy(varH) * r2);
          normal = normalize(abs(det) * normal - grad);
        }`,
      );
  };
  // Every varied material of a kind shares one program.
  m.customProgramCacheKey = () => 'tbi-vary-1';
  return m;
}
