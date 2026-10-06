/**
 * Axial through-hole resistor, 1/4 W class (Sprint 10 high-fidelity proof set). Procedural: a body
 * of revolution reaches this part's realism cleanly, so it needs no glTF asset (manifest.ts).
 *
 * The actual part form, not a tube with rings:
 * - the body is the lacquer-dipped "dog bone": two pressed-on end caps (full diameter, rounded
 *   shoulders) and a slightly narrower waist between them, with the dip's meniscus running down
 *   onto each lead as a short tapered neck;
 * - the colour bands are PAINTED ON the lacquer (a texture on the body, following its curvature),
 *   with soft edges, from the design value (scene.ts resistorBands); 4-band parts get the beige
 *   carbon-film lacquer, 5-band parts the blue metal-film one, as the two common product families;
 * - tinned copper leads leave the necks on the body axis and are bent down with a real pliers bend
 *   radius to the terminal positions (the 2D terminals: 12.7 mm = 0.5 in lead spacing).
 *
 * Dimensions [CFR25]: Yageo CFR-25 / MFR-25 class, body 6.0 +- 0.5 x 2.3 +- 0.3 mm, lead 0.54 mm.
 */
import * as THREE from 'three';
import { LEAD_ATTACH_HEIGHT } from '../physical.js';
import { OwnedResources, canvasTexture, mesh, tube, type V3 } from '../kit.js';

export const RESISTOR_HIFI = {
  bodyLengthMm: 6.3,
  /** End-cap (maximum) diameter. */
  capDiameterMm: 2.45,
  /** Waist diameter between the caps. */
  waistDiameterMm: 2.2,
  /** End-cap length (shoulder to the start of the waist). */
  capLengthMm: 1.45,
  leadDiameterMm: 0.55,
  /** The dip meniscus down each lead, beyond the body end. */
  neckLengthMm: 0.55,
  /** Gap between the bench and the bottom of the body. */
  standoffMm: 1.0,
  /** Inner bend radius of the formed leads. */
  bendRadiusMm: 0.75,
} as const;

/** Paint colours of IEC 60062 bands (as printed on lacquer; gold/silver are metallic inks). */
const BAND_PAINT: Record<string, string> = {
  black: '#141414',
  brown: '#6a3a17',
  red: '#c9252b',
  orange: '#e8751a',
  yellow: '#efc12a',
  green: '#2f7d32',
  blue: '#1d5fb4',
  violet: '#7a2f9e',
  grey: '#8a8a8a',
  white: '#f2f2f2',
  gold: '#b8912f',
  silver: '#b9bcbf',
};

/** Body profile (axial position, radius), from one lead neck to the other: a smooth spline. */
function bodyProfile(): THREE.Vector2[] {
  const p = RESISTOR_HIFI;
  const a = p.bodyLengthMm / 2;
  const R = p.capDiameterMm / 2;
  const W = p.waistDiameterMm / 2;
  const rl = p.leadDiameterMm / 2;
  const n = p.neckLengthMm;
  // Half profile from the left lead neck to the centre (mirrored below).
  const half: [number, number][] = [
    [-a - n, rl * 1.04],
    [-a - n * 0.6, rl * 1.25],
    [-a - n * 0.15, R * 0.42],
    [-a + 0.05, R * 0.72],
    [-a + 0.22, R * 0.93],
    [-a + 0.5, R],
    [-a + p.capLengthMm - 0.25, R],
    [-a + p.capLengthMm + 0.05, (R + W) / 2],
    [-a + p.capLengthMm + 0.4, W],
    [0, W * 0.995],
  ];
  const pts = [
    ...half,
    ...half
      .slice(0, -1)
      .reverse()
      .map(([z, r]): [number, number] => [-z, r]),
  ];
  const curve = new THREE.SplineCurve(pts.map(([z, r]) => new THREE.Vector2(z, r)));
  // Lathe profile: x = radius, y = axial position.
  return curve.getSpacedPoints(96).map((v) => new THREE.Vector2(v.y, v.x));
}

/**
 * The lacquer and its bands as one texture along the body (v = axial position, end to end of the
 * profile): soft band edges and a faint mottling of the dipped finish.
 */
function bodyTexture(own: OwnedResources, bands: string[] | null | undefined): THREE.Texture {
  const p = RESISTOR_HIFI;
  const total = p.bodyLengthMm + 2 * p.neckLengthMm;
  const H = 1024;
  const metalFilm = bands?.length === 5;
  const base = metalFilm ? '#7fa6c4' : '#d6c095';
  return canvasTexture(own, 64, H, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 64, H);
    // Faint mottling: deterministic pseudo-random speckle (no Math.random: same look every build).
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(rnd() * 64, rnd() * H, 2 + rnd() * 3, 2 + rnd() * 6);
    }
    if (!bands) return;
    // Band centres from the left end (mm), as printed on CFR/MFR-25 parts: the significant
    // digits and the multiplier grouped from one end, the tolerance band near the other.
    const a = p.bodyLengthMm / 2;
    const xs =
      bands.length === 4
        ? [-a + 1.0, -a + 1.75, -a + 2.5, a - 1.0]
        : [-a + 0.95, -a + 1.6, -a + 2.25, -a + 2.9, a - 0.95];
    const width = bands.length === 4 ? 0.5 : 0.42;
    const row = (mm: number) => ((mm + a + p.neckLengthMm) / total) * H;
    bands.forEach((b, i) => {
      const y0 = row(xs[i]! - width / 2);
      const y1 = row(xs[i]! + width / 2);
      const g = ctx.createLinearGradient(0, y0 - 3, 0, y1 + 3);
      const c = BAND_PAINT[b] ?? '#000';
      g.addColorStop(0, `${base}`);
      g.addColorStop(3 / (y1 - y0 + 6), c);
      g.addColorStop(1 - 3 / (y1 - y0 + 6), c);
      g.addColorStop(1, `${base}`);
      ctx.fillStyle = g;
      ctx.fillRect(0, y0 - 3, 64, y1 - y0 + 6);
    });
  });
}

/** Build the resistor in its local frame (axis along X, terminals at xa / xb on the bench). */
export function buildResistorHiFi(
  own: OwnedResources,
  opts: {
    bands: string[] | null | undefined;
    xa: number;
    xb: number;
    leadMaterial: THREE.Material;
  },
): THREE.Group {
  const p = RESISTOR_HIFI;
  const g = new THREE.Group();
  const y = p.standoffMm + p.capDiameterMm / 2;
  const profile = bodyProfile();
  const geo = own.shared('resistor:hifi', () => {
    const lathe = new THREE.LatheGeometry(profile, 48);
    // Texture coordinates: u around, v = axial position (so the bands sit exactly where printed,
    // whatever the profile's point spacing).
    const pos = lathe.attributes.position!;
    const uv = lathe.attributes.uv!;
    const total = p.bodyLengthMm + 2 * p.neckLengthMm;
    // (v = 1 at the left end: the canvas texture's top row, where the band rows start.)
    for (let i = 0; i < pos.count; i++) uv.setY(i, 1 - (pos.getY(i) + total / 2) / total);
    return lathe;
  });
  const metalFilm = opts.bands?.length === 5;
  const body = mesh(
    geo,
    own.mat(
      new THREE.MeshPhysicalMaterial({
        map: bodyTexture(own, opts.bands),
        roughness: 0.52,
        clearcoat: 0.35,
        clearcoatRoughness: 0.45,
        sheen: metalFilm ? 0 : 0.15,
      }),
    ),
  );
  body.rotation.z = -Math.PI / 2; // lathe axis (+Y) onto +X
  body.position.y = y;
  body.userData.resistorBody = true;
  body.userData.bands = opts.bands ?? null;
  g.add(body);
  // Leads: from inside each neck along the axis, a formed 90-degree bend, down to the bench.
  const r = p.leadDiameterMm / 2;
  const neck = p.bodyLengthMm / 2 + p.neckLengthMm * 0.5;
  for (const [from, to] of [
    [-neck, opts.xa],
    [neck, opts.xb],
  ] as const) {
    const pts: V3[] = [
      [from, y, 0],
      [to, y, 0],
      [to, LEAD_ATTACH_HEIGHT - 0.3, 0],
    ];
    const lead = tube(own, pts, r, opts.leadMaterial, p.bendRadiusMm + r, 12);
    lead.userData.lead = true;
    g.add(lead);
  }
  return g;
}
