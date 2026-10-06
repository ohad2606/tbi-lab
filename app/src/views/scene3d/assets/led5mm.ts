/**
 * Radial T-1 3/4 (5 mm) and T-1 (3 mm) LEDs (Sprint 10 high-fidelity proof set). Procedural:
 * bodies of revolution and extruded frame parts reach this part's realism cleanly (manifest.ts).
 *
 * The actual part form:
 * - the epoxy lens: cylinder with a slight moulding draft, hemispherical dome, on a flange with
 *   the cathode flat; a glossy skin (clearcoat) over a tinted-diffused or water-clear body;
 * - the lead frame visible inside the lens: the anode post and the wider cathode anvil carrying
 *   the reflector cup with the die, joined by the bond wire;
 * - two 0.5 mm square legs at the real 2.54 mm pitch, straight down to the bench. The legs are the
 *   electrical anchors: wires end at the leg tips (scene.ts), not at the 2D terminal spacing.
 *
 * Package [V83012] (5 mm) / [V83009] (3 mm): physical.ts LED_PACKAGES.
 */
import * as THREE from 'three';
import { LEAD_ATTACH_HEIGHT, type LedPhysics } from '../physical.js';
import { OwnedResources, mesh, tube } from '../kit.js';

/** Leg tip (anchor) of each terminal, local frame, mm: anode at -x, cathode (the flat) at +x. */
export function ledAnchors(p: LedPhysics) {
  return {
    anode: { x: -p.leadPitchMm / 2, y: LEAD_ATTACH_HEIGHT, z: 0 },
    cathode: { x: p.leadPitchMm / 2, y: LEAD_ATTACH_HEIGHT, z: 0 },
  };
}

/** Lens profile (radius, height) from the flange top to the dome apex. */
function lensProfile(p: LedPhysics): THREE.Vector2[] {
  const base = p.standoffMm + p.flangeThicknessMm;
  const top = p.standoffMm + p.heightMm;
  const R = p.bodyDiameterMm / 2;
  const domeR = Math.min(p.domeRadiusMm, R * 0.995);
  const domeStart = top - domeR;
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.001, base),
    new THREE.Vector2(R * 0.97, base),
    // A small fillet where the lens meets the flange, then the drafted wall.
    new THREE.Vector2(R, base + 0.12),
    new THREE.Vector2(R * 0.985, domeStart),
  ];
  for (let i = 1; i <= 16; i++) {
    const a = (i / 16) * (Math.PI / 2);
    pts.push(
      new THREE.Vector2(Math.max(0.001, R * 0.985 * Math.cos(a)), domeStart + domeR * Math.sin(a)),
    );
  }
  return pts;
}

export interface LedLook {
  color: string;
  clear: boolean;
}

/** Build the LED in its local frame. Returns the group and its lens material (live glow). */
export function buildLedHiFi(
  own: OwnedResources,
  key: string,
  p: LedPhysics,
  look: LedLook,
  m: { lead: THREE.Material; frame: THREE.Material },
): { group: THREE.Group; lens: THREE.MeshPhysicalMaterial; top: number } {
  const g = new THREE.Group();
  const base = p.standoffMm;
  const top = base + p.heightMm;
  const lens = own.mat(
    new THREE.MeshPhysicalMaterial({
      color: look.clear
        ? new THREE.Color(look.color).lerp(new THREE.Color('#ffffff'), 0.72)
        : look.color,
      roughness: look.clear ? 0.04 : 0.42,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      transparent: true,
      opacity: look.clear ? 0.38 : 0.86,
      emissive: look.color,
      emissiveIntensity: 0,
      depthWrite: false,
    }),
  );
  const body = mesh(
    own.shared(`led:lens:${key}`, () => new THREE.LatheGeometry(lensProfile(p), 48)),
    lens,
  );
  body.castShadow = false;
  body.userData.lens = true;
  g.add(body);

  // Flange with the cathode flat on the +x (cathode) side.
  const F = p.flangeDiameterMm / 2;
  const flatX = F - 0.45;
  const flange = mesh(
    own.shared(`led:flange:${key}`, () => {
      const a = Math.acos(flatX / F);
      const shape = new THREE.Shape();
      shape.absarc(0, 0, F, a, 2 * Math.PI - a, false);
      shape.lineTo(flatX, F * Math.sin(a));
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: p.flangeThicknessMm - 0.1,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.05,
        bevelSegments: 2,
        curveSegments: 48,
      });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, 0.05, 0);
      return geo;
    }),
    lens,
    [0, base, 0],
  );
  flange.castShadow = false;
  flange.userData.cathodeFlat = flatX;
  g.add(flange);

  // Lead frame inside the lens.
  const inner = base + p.flangeThicknessMm;
  const frameTop = top - p.domeRadiusMm * 1.15;
  const half = p.leadPitchMm / 2;
  const post = mesh(
    own.shared(`led:post:${key}`, () => {
      // Anode post: a narrow bar with a small hooked head.
      const s = new THREE.Shape();
      s.moveTo(-0.22, 0);
      s.lineTo(0.22, 0);
      s.lineTo(0.22, frameTop - inner - 0.25);
      s.lineTo(0.45, frameTop - inner);
      s.lineTo(-0.22, frameTop - inner);
      s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: false });
      geo.translate(0, 0, -0.15);
      return geo;
    }),
    m.frame,
    [-half, inner, 0],
  );
  g.add(post);
  const anvilW = Math.min(1.7, p.bodyDiameterMm * 0.36);
  const anvil = mesh(
    own.shared(`led:anvil:${key}`, () => {
      // Cathode anvil: rises from the leg and widens into the cup platform, towards the axis.
      const s = new THREE.Shape();
      s.moveTo(-0.22, 0);
      s.lineTo(0.22, 0);
      s.lineTo(0.22, frameTop - inner - 0.9);
      s.lineTo(0.3, frameTop - inner);
      s.lineTo(-anvilW + 0.2, frameTop - inner);
      s.lineTo(-anvilW + 0.2, frameTop - inner - 0.45);
      s.lineTo(-0.22, frameTop - inner - 1.2);
      s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.36, bevelEnabled: false });
      geo.translate(0, 0, -0.18);
      return geo;
    }),
    m.frame,
    [half, inner, 0],
  );
  g.add(anvil);
  // Reflector cup on the anvil, the die in it, and the bond wire from the post to the die.
  const cupX = half - anvilW / 2 + 0.2;
  const cup = mesh(
    own.shared(
      `led:cup:${key}`,
      () =>
        new THREE.LatheGeometry(
          [
            [0.001, 0],
            [0.3, 0],
            [0.42, 0.25],
            [0.5, 0.3],
          ].map(([r, y]) => new THREE.Vector2(r, y)),
          20,
        ),
    ),
    m.frame,
    [cupX, frameTop, 0],
  );
  g.add(cup);
  const die = mesh(
    own.shared('led:die', () => new THREE.BoxGeometry(0.26, 0.14, 0.26)),
    own.mat(
      new THREE.MeshStandardMaterial({
        color: '#2b2b2b',
        emissive: look.color,
        emissiveIntensity: 0.15,
        roughness: 0.4,
      }),
    ),
    [cupX, frameTop + 0.08, 0],
  );
  g.add(die);
  g.add(
    tube(
      own,
      [
        [-half + 0.25, frameTop, 0],
        [(-half + cupX) / 2, frameTop + 0.75, 0],
        [cupX, frameTop + 0.16, 0],
      ],
      0.03,
      m.frame,
      0.6,
      6,
    ),
  );

  // Legs: 0.5 mm square, straight down from inside the flange to the bench, at the real pitch.
  const legTop = inner + 0.4;
  const legLen = legTop - (LEAD_ATTACH_HEIGHT - 0.3);
  const leg = own.shared(
    `led:leg:${key}`,
    () => new THREE.BoxGeometry(p.leadSizeMm, legLen, p.leadSizeMm),
  );
  for (const x of [-half, half]) {
    const l = mesh(leg, m.lead, [x, LEAD_ATTACH_HEIGHT - 0.3 + legLen / 2, 0]);
    l.userData.leg = x < 0 ? 'anode' : 'cathode';
    g.add(l);
  }
  return { group: g, lens, top };
}
