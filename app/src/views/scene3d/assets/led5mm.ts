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
import { OwnedResources, drawTexture, mesh, tube } from '../kit.js';

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

/**
 * The lens's emission profile when lit (an emissive map along the lathe's v, flange to apex): a
 * lit diffused lens scatters the die's light through the whole epoxy, brightest round the die and
 * in the dome, dimmer towards the flange.
 */
function glowProfile(own: OwnedResources): THREE.Texture {
  return own.lasting('led:glowProfile', () => {
    const t = drawTexture(
      2,
      64,
      (ctx) => {
        const g = ctx.createLinearGradient(0, 64, 0, 0);
        g.addColorStop(0, '#1a1a1a');
        g.addColorStop(0.45, '#7a7a7a');
        g.addColorStop(0.75, '#ffffff');
        g.addColorStop(1, '#e8e8e8');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 2, 64);
      },
      true,
    );
    return t;
  });
}

/** Build the LED in its local frame. Returns the group, its lens and die materials (live glow). */
export function buildLedHiFi(
  own: OwnedResources,
  key: string,
  p: LedPhysics,
  look: LedLook,
  m: { lead: THREE.Material; frame: THREE.Material },
): {
  group: THREE.Group;
  lens: THREE.MeshStandardMaterial;
  die: THREE.MeshStandardMaterial;
  top: number;
  /** Lens emission per unit live level (diffused epoxy glows; a clear lens mostly shows the die). */
  gain: number;
} {
  const g = new THREE.Group();
  const base = p.standoffMm;
  const top = base + p.heightMm;
  const full = own.tier === 'full';
  const tint = new THREE.Color(look.color);
  // The epoxy. Full tier: a transmissive, refracting body (IOR 1.5) with a glossy skin; tinted
  // diffused epoxy is frosted (rough transmission, short absorption distance), water-clear is
  // glass-like. Reduced tier: a plain translucent standard material of the same colour.
  const lens = own.mat(
    full
      ? new THREE.MeshPhysicalMaterial({
          // Moulded epoxy, not glass (realism pass 2): tinted-diffused epoxy scatters most light
          // inside it (low transmission, rough: the frame shows only as a soft shape) under a
          // satin moulded skin; water-clear epoxy is clear but not optically perfect.
          color: look.clear
            ? tint.clone().lerp(new THREE.Color('#ffffff'), 0.6)
            : tint.clone().multiplyScalar(0.82),
          roughness: look.clear ? 0.1 : 0.62,
          transmission: look.clear ? 0.92 : 0.32,
          thickness: p.bodyDiameterMm * 0.9,
          ior: 1.5,
          attenuationColor: tint.clone().lerp(new THREE.Color('#ffffff'), look.clear ? 0.35 : 0),
          attenuationDistance: look.clear ? 5 : 0.8,
          clearcoat: look.clear ? 0.9 : 0.55,
          clearcoatRoughness: look.clear ? 0.06 : 0.22,
          // Lit, the epoxy reads a little hotter (yellower) than its colour.
          emissive: tint.clone().lerp(new THREE.Color('#ffd27a'), 0.18),
          emissiveIntensity: 0,
          emissiveMap: glowProfile(own),
        })
      : new THREE.MeshStandardMaterial({
          color: look.clear
            ? tint.clone().lerp(new THREE.Color('#ffffff'), 0.72)
            : tint.clone().lerp(new THREE.Color('#000000'), 0.18),
          roughness: look.clear ? 0.05 : 0.4,
          transparent: true,
          opacity: look.clear ? 0.38 : 0.9,
          emissive: look.color,
          emissiveIntensity: 0,
          // (reduced tier: no emissive map: one shader program fewer on software WebGL)
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
  post.userData.noAo = true;
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
  anvil.userData.noAo = true;
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
  cup.userData.noAo = true;
  g.add(cup);
  // The die: dark when off; when lit it is the light source (renderer: live level).
  const dieMat = own.mat(
    new THREE.MeshStandardMaterial({
      color: '#262626',
      emissive: tint.clone().lerp(new THREE.Color('#ffffff'), 0.35),
      emissiveIntensity: 0,
      roughness: 0.4,
    }),
  );
  const die = mesh(
    own.shared('led:die', () => new THREE.BoxGeometry(0.28, 0.16, 0.28)),
    dieMat,
    [cupX, frameTop + 0.08, 0],
  );
  die.userData.ledDie = true;
  die.userData.noAo = true;
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
  return { group: g, lens, die: dieMat, top, gain: look.clear ? 0.9 : 2.2 };
}
