/**
 * DO-35 glass signal diode (1N4148) (Sprint 10 realism pass). Procedural.
 *
 * The actual part [V81857]: a hermetically sealed glass tube, 3.05-5.08 mm long (3.4 mm used), 1.53-
 * 2.28 mm in diameter (1.75 mm used), its ends drawn round onto the leads. Inside, along the axis:
 * the two leads' DUMET slugs (copper-clad, reddish metal) pressing the small silicon die between
 * them; the cathode end carries a black painted band. The glass of a 1N4148 is clear with an
 * orange-amber tint.
 *
 * Full tier: the glass is a refracting, transmissive material (the slugs and die show through,
 * distorted, as in the real part); reduced tier: a plain translucent amber.
 * Local frame: axis along +X (anode at -X, cathode at +X), body centre at height `y`.
 */
import * as THREE from 'three';
import { DIODE_DO35 } from '../physical.js';
import { OwnedResources, mesh } from '../kit.js';

export function buildDo35(own: OwnedResources, y: number, metal: THREE.Material): THREE.Group {
  const p = DIODE_DO35;
  const g = new THREE.Group();
  const L = p.bodyLengthMm;
  const R = p.bodyDiameterMm / 2;
  const full = own.tier === 'full';
  // The envelope: a drawn glass tube, its ends sealed round onto the leads.
  const profile: [number, number][] = [
    [p.leadDiameterMm / 2 + 0.02, -L / 2 - 0.12],
    [R * 0.55, -L / 2 + 0.02],
    [R * 0.86, -L / 2 + 0.16],
    [R * 0.98, -L / 2 + 0.42],
    [R, -L / 2 + 0.7],
    [R, L / 2 - 0.7],
    [R * 0.98, L / 2 - 0.42],
    [R * 0.86, L / 2 - 0.16],
    [R * 0.55, L / 2 - 0.02],
    [p.leadDiameterMm / 2 + 0.02, L / 2 + 0.12],
  ];
  const glass = own.sharedMat(`do35:glass:${own.tier}`, () =>
    full
      ? new THREE.MeshPhysicalMaterial({
          color: '#ffd9b0',
          roughness: 0.03,
          transmission: 1,
          thickness: 1.2,
          ior: 1.5,
          attenuationColor: '#ff8a3a',
          attenuationDistance: 2.2,
          clearcoat: 1,
          clearcoatRoughness: 0.02,
          specularIntensity: 1,
        })
      : new THREE.MeshStandardMaterial({
          color: '#e0893a',
          roughness: 0.1,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        }),
  );
  const env = mesh(
    own.shared(`do35:glass:${L}:${R}`, () => {
      const curve = new THREE.SplineCurve(profile.map(([r, x]) => new THREE.Vector2(r, x)));
      return new THREE.LatheGeometry(curve.getPoints(40), 32);
    }),
    glass,
  );
  env.rotation.z = -Math.PI / 2;
  env.position.y = y;
  env.castShadow = false;
  env.userData.glass = true;
  g.add(env);
  // Inside: the DUMET slugs (copper-clad wire, reddish), the die between them.
  const dumet = own.sharedMat(
    'do35:dumet',
    () => new THREE.MeshStandardMaterial({ color: '#c06a48', metalness: 1, roughness: 0.32 }),
  );
  const slug = own.shared(`do35:slug:${R}`, () =>
    new THREE.CylinderGeometry(R * 0.5, R * 0.5, L * 0.36, 20).rotateZ(Math.PI / 2),
  );
  for (const s of [-1, 1]) {
    const m = mesh(slug, dumet, [s * L * 0.21, y, 0]);
    m.castShadow = false;
    g.add(m);
  }
  const die = mesh(
    own.shared('do35:die', () => new THREE.BoxGeometry(0.16, 0.5, 0.5)),
    own.sharedMat(
      'do35:die',
      () => new THREE.MeshStandardMaterial({ color: '#3a3d44', metalness: 0.4, roughness: 0.35 }),
    ),
    [0, y, 0],
  );
  die.castShadow = false;
  g.add(die);
  // The leads continue through the seals into the slugs.
  for (const s of [-1, 1]) {
    const lead = mesh(
      own.shared(`do35:leadIn:${L}`, () =>
        new THREE.CylinderGeometry(p.leadDiameterMm / 2, p.leadDiameterMm / 2, 0.7, 12).rotateZ(
          Math.PI / 2,
        ),
      ),
      metal,
      [s * (L / 2 - 0.15), y, 0],
    );
    g.add(lead);
  }
  // The cathode band: black paint round the glass at the cathode (+X) end.
  const band = mesh(
    own.shared(`do35:band:${R}`, () =>
      new THREE.CylinderGeometry(R + 0.025, R + 0.025, 0.5, 32, 1, true).rotateZ(Math.PI / 2),
    ),
    own.sharedMat(
      'do35:band',
      () =>
        new THREE.MeshStandardMaterial({
          color: '#141414',
          roughness: 0.55,
          side: THREE.DoubleSide,
        }),
    ),
    [L / 2 - 0.95, y, 0],
  );
  band.userData.cathodeBand = true;
  g.add(band);
  return g;
}
