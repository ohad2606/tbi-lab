/**
 * Authoring source of the ESP32-DevKitC V4 visual asset (Sprint 10; realism pass).
 *
 * Pure three.js geometry and materials, no DOM: `scripts/build-3d-assets.ts` runs this in Node and
 * exports the result as a binary glTF (`esp32-devkitc-v4.glb`), which the 3D view loads lazily.
 * The asset is AUTHORED IN THIS REPOSITORY from Espressif's dimension drawing and the board photo
 * in Espressif's user guide (measured, never traced or embedded) and from the package outlines
 * of its parts; no external model geometry (sources: ./esp32Layout.ts, ./manifest.ts).
 *
 * Frame (as every 3D model, physical.ts): millimetres, origin = the board centre on the bench
 * plane, +X across the board towards header J3, +Z along it towards the USB end, +Y up. The board
 * stands on its male header pins on the bench, as on a breadboard.
 *
 * Named nodes the runtime finishes (presentation only, never product logic; esp32DevkitC.ts):
 *   `pcb_top`, `pcb_bottom`  skins over the two faces, UV across the PCB: the board's surface
 *                            texture (solder mask over copper, pads, silkscreen) is drawn on them
 *   `module_top`             the module's exposed top beside its can (antenna area), UV across it
 *   `markings`               quads on the RF can and the ICs, UV into the marking atlas
 * Everything else is final geometry. Repeated features are merged into one mesh per material.
 */

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ESP32_DEVKITC_WROOM32, boardPinPosition } from '@tbi-lab/domain';
import { ESP32_DEVKITC as D, ESP32_PCB_BOTTOM, ESP32_PCB_TOP } from '../physical.js';
import { CHIPS, CHIP_SIZE, LAYOUT, MARK_ATLAS } from './esp32Layout.js';

/**
 * A square prism (side `side`, corners chamfered by `c`) along +Y, centred on the origin, open
 * ended (its ends are covered by the pin's tips); flat-shaded so each face keeps its own normal.
 */
function chamferedSquarePrism(side: number, c: number, length: number): THREE.BufferGeometry {
  const h = side / 2;
  const ring: [number, number][] = [
    [h - c, -h],
    [h, -h + c],
    [h, h - c],
    [h - c, h],
    [-h + c, h],
    [-h, h - c],
    [-h, -h + c],
    [-h + c, -h],
  ];
  const pos: number[] = [];
  const y0 = -length / 2;
  const y1 = length / 2;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i]!;
    const [bx, bz] = ring[(i + 1) % ring.length]!;
    // Outward-facing (counter-clockwise seen from outside).
    pos.push(ax, y0, az, bx, y1, bz, bx, y0, bz, ax, y0, az, ax, y1, az, bx, y1, bz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Along a header, the real pin centre (2.54 mm pitch, centred on the board origin). */
const pinZ = (position: number) => (position - (D.headerPins + 1) / 2) * D.pinPitchMm;
const ROW_X = D.headerRowSpacingMm / 2;

/** PBR materials of the asset (exported with it; KHR_materials_clearcoat where used). */
function materials() {
  const phys = (p: THREE.MeshPhysicalMaterialParameters, name: string) => {
    const m = new THREE.MeshPhysicalMaterial(p);
    m.name = name;
    return m;
  };
  return {
    // The PCB's body: its routed edge shows the glass-epoxy core under the black mask.
    fr4: phys({ color: '#24231f', roughness: 0.75 }, 'fr4_edge'),
    // Board faces: drawn at runtime (mask, copper, pads, silkscreen) on a glossy lacquer.
    // Realism pass 5: a satin LPI mask (it was a glossy lacquer: too much like plastic).
    pcbTop: phys(
      { color: '#ffffff', roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.45 },
      'pcb_top',
    ),
    pcbBottom: phys(
      { color: '#ffffff', roughness: 0.58, clearcoat: 0.28, clearcoatRoughness: 0.5 },
      'pcb_bottom',
    ),
    // ENIG (gold) exposed copper, tinned solder, gold-flashed header pins.
    gold: phys({ color: '#e0b860', metalness: 1, roughness: 0.25 }, 'enig_gold'),
    // Lead-free solder: satin grey-silver, not a mirror (high-fidelity pass 3).
    solder: phys({ color: '#c3c7cb', metalness: 1, roughness: 0.34 }, 'solder'),
    pinGold: phys({ color: '#e2bc68', metalness: 1, roughness: 0.22 }, 'pin_gold'),
    // PBT header housing: matte black with a faint sheen. Realism pass 8: a moulded satin (0.58),
    // its micro-surface and per-strip finish drawn at runtime (variation.ts).
    housing: phys({ color: '#121214', roughness: 0.58 }, 'header_pbt'),
    // The module: black FR-4 substrate (glossy mask), its top drawn at runtime; a stamped
    // nickel-silver RF can.
    moduleBoard: phys(
      { color: '#141518', roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 },
      'module_substrate',
    ),
    moduleTop: phys(
      { color: '#ffffff', roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 },
      'module_top',
    ),
    can: phys({ color: '#cfd2d5', metalness: 1, roughness: 0.36 }, 'shield_can'),
    // Connector shell (nickel-plated steel), its plastic tongue, gold contacts.
    // Double-sided: the shell is a thin drawn wall seen from inside through its mouth.
    nickel: phys(
      { color: '#d6d9dc', metalness: 1, roughness: 0.22, side: THREE.DoubleSide },
      'usb_shell',
    ),
    // Realism pass 8: connector nylon is smoother than the IC moulding (a semi-gloss 0.42).
    tongue: phys({ color: '#101011', roughness: 0.42 }, 'usb_tongue'),
    shadowed: phys({ color: '#060607', roughness: 0.9, side: THREE.DoubleSide }, 'cavity'),
    // IC moulding compound: dark grey, an EDM-textured matte (realism pass 8: rougher than the
    // header and connector plastics; its fine stipple is drawn at runtime, variation.ts).
    epoxy: phys({ color: '#1d1e21', roughness: 0.68 }, 'ic_mould'),
    tin: phys({ color: '#c6cacd', metalness: 1, roughness: 0.28 }, 'lead_tin'),
    // Passives: MLCC ceramic (warm tan), thick-film resistors (realism pass 8: a white alumina
    // substrate under a black glassy overcoat), the LED's body.
    ceramic: phys({ color: '#a68e6e', roughness: 0.58 }, 'mlcc_ceramic'),
    resistor: phys({ color: '#17181a', roughness: 0.36 }, 'chip_resistor'),
    alumina: phys({ color: '#e2dfd7', roughness: 0.62 }, 'chip_substrate'),
    ledBody: phys({ color: '#efece2', roughness: 0.5 }, 'led_body'),
    ledLens: phys(
      {
        color: '#ffcf9e',
        roughness: 0.12,
        clearcoat: 1,
        transparent: true,
        opacity: 0.75,
      },
      'power_led_lens',
    ),
    // SMD tact switches: black base, stainless cover, black actuator.
    switchBody: phys({ color: '#18181a', roughness: 0.6 }, 'switch_body'),
    steel: phys({ color: '#c3c7cb', metalness: 1, roughness: 0.3 }, 'switch_cover'),
    actuator: phys({ color: '#1f2023', roughness: 0.45 }, 'switch_actuator'),
    // Markings (atlas, drawn at runtime).
    markings: phys({ color: '#ffffff', roughness: 0.6, transparent: true }, 'markings'),
  };
}

/** A rounded rectangle centred on the origin. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2, false);
  return s;
}

/**
 * Merging needs matching attributes: indexed (shared vertices keep the file small), position and
 * normal only (merged meshes are untextured), no groups.
 */
function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g.clone();
  for (const k of Object.keys(out.attributes))
    if (!['position', 'normal'].includes(k)) out.deleteAttribute(k);
  if (!out.index) out = mergeVertices(out, 1e-4);
  out.clearGroups();
  return out;
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) =>
  plain(g).translate(x, y, z);

function merged(name: string, parts: THREE.BufferGeometry[], m: THREE.Material): THREE.Mesh {
  const geo = mergeGeometries(parts.map(plain), false)!;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = name;
  return mesh;
}

/** A flat skin over a face, with UV (u across x, v along z: v = 1 at z0) for a runtime texture. */
function skin(
  shape: THREE.Shape,
  w: number,
  l: number,
  zc: number,
  y: number,
  up: boolean,
  name: string,
  m: THREE.Material,
): THREE.Mesh {
  const geo = new THREE.ShapeGeometry(shape, 8);
  geo.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
  const pos = geo.attributes.position!;
  const uv = geo.attributes.uv!;
  for (let i = 0; i < pos.count; i++) {
    // Seen from below, u still runs along +x in the board frame (the texture is drawn mirrored).
    uv.setXY(i, (pos.getX(i) + w / 2) / w, 1 - (pos.getZ(i) + l / 2) / l);
  }
  geo.translate(0, y, zc);
  geo.deleteAttribute('normal');
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = name;
  return mesh;
}

/**
 * A marking quad facing up over a part's top (centre x/z, extent w along x and d along z, height
 * y), its UV the atlas region (canvas x = +x, canvas y = +z).
 */
function markQuad(
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  region: [number, number, number, number],
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position!;
  const uv = geo.attributes.uv!;
  const S = MARK_ATLAS.size;
  const [rx, ry, rw, rh] = region;
  for (let i = 0; i < pos.count; i++) {
    const s = (pos.getX(i) + w / 2) / w;
    const t = (pos.getZ(i) + d / 2) / d;
    uv.setXY(i, (rx + s * rw) / S, 1 - (ry + t * rh) / S);
  }
  return geo.translate(x, y, z);
}

/** Build the asset's scene graph. Deterministic: the same output for the same source. */
export function authorEsp32DevkitC(): THREE.Group {
  const m = materials();
  const root = new THREE.Group();
  root.name = 'esp32_devkitc_v4';
  const yb = ESP32_PCB_BOTTOM;
  const yt = ESP32_PCB_TOP;
  const zc = D.pcbCentreZMm;
  const zTop = zc - D.pcbLengthMm / 2; // the antenna end (pin 1)

  // ---- PCB: 1.6 mm, rounded corners, a hair of edge break; both faces skinned --------------
  const outline = roundedRect(D.pcbWidthMm, D.pcbLengthMm, 0.9);
  const core = new THREE.ExtrudeGeometry(
    roundedRect(D.pcbWidthMm - 0.16, D.pcbLengthMm - 0.16, 0.82),
    {
      depth: D.pcbThicknessMm - 0.16,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.08,
      bevelSegments: 2,
      curveSegments: 8,
    },
  );
  core.rotateX(Math.PI / 2);
  core.translate(0, yt - 0.08, zc);
  const pcb = new THREE.Mesh(plain(core), m.fr4);
  pcb.name = 'pcb';
  root.add(pcb);
  root.add(skin(outline, D.pcbWidthMm, D.pcbLengthMm, zc, yt + 0.004, true, 'pcb_top', m.pcbTop));
  root.add(
    skin(outline, D.pcbWidthMm, D.pcbLengthMm, zc, yb - 0.004, false, 'pcb_bottom', m.pcbBottom),
  );

  // ---- Header: pins through the board, soldered on top; plastic bodies underneath ----------
  const fillets: THREE.BufferGeometry[] = [];
  const pins: THREE.BufferGeometry[] = [];
  const segments: THREE.BufferGeometry[] = [];
  // The top joint (high-fidelity pass 3): a wetted solder MENISCUS from the pad (r 0.85) to the
  // pin, low and concave (it climbs ~0.45 mm and hugs the pin's corners), not a tall cone.
  const fillet = new THREE.LatheGeometry(
    [
      [0.87, 0],
      [0.8, 0.02],
      [0.68, 0.06],
      [0.57, 0.12],
      [0.49, 0.2],
      [0.44, 0.29],
      [0.42, 0.37],
      [0.41, 0.45],
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    // 16 segments: round at any distance a 1.7 mm joint is seen from (asset budget).
    16,
  );
  // A square header pin with chamfered tips, full length from the bench to its cut stub.
  const pinLen = yt + D.pinStubAboveMm;
  const tip = 0.28;
  const s = D.pinSizeMm;
  // Realism pass 7: the square wire's corners are slightly broken (a chamfered square, eight
  // flat faces): each narrow corner face catches a thin highlight. With sharp edges every face
  // reflected one flat colour. (A rounded box costs about 50 KB of the asset budget.)
  const shaft = chamferedSquarePrism(s, 0.07, pinLen - 2 * tip);
  const pyramid = new THREE.CylinderGeometry(s * 0.3, s / Math.SQRT2, tip, 4, 1).rotateY(
    Math.PI / 4,
  );
  const pinGeo = mergeGeometries(
    [
      plain(shaft).translate(0, pinLen / 2, 0),
      plain(pyramid).translate(0, pinLen - tip / 2, 0),
      plain(pyramid.clone().rotateX(Math.PI)).translate(0, tip / 2, 0),
    ],
    false,
  )!;
  // Header body segment: 2.54 pitch, a V-groove between positions, chamfered top and bottom.
  const seg = new RoundedBoxGeometry(2.44, D.headerPlasticHeightMm, 2.5, 1, 0.2);
  for (const pin of ESP32_DEVKITC_WROOM32.pins) {
    const x = Math.sign(boardPinPosition(pin).x) * ROW_X;
    const z = pinZ(pin.position);
    fillets.push(at(fillet, x, yt, z));
    pins.push(at(pinGeo, x, 0, z));
    segments.push(at(seg, x, D.pinBelowPlasticMm + D.headerPlasticHeightMm / 2, z));
  }
  root.add(merged('solder_joints', fillets, m.solder));
  root.add(merged('header_pins', pins, m.pinGold));
  root.add(merged('header_housing', segments, m.housing));

  // ---- ESP32-WROOM-32 module ---------------------------------------------------------------
  const modZ0 = zTop - D.moduleOverhangMm;
  const modZ1 = modZ0 + D.moduleLengthMm;
  const modZc = (modZ0 + modZ1) / 2;
  const modTop = yt + D.moduleThicknessMm;
  const module = new THREE.Mesh(
    plain(
      new RoundedBoxGeometry(D.moduleWidthMm, D.moduleThicknessMm, D.moduleLengthMm, 2, 0.1),
    ).translate(0, yt + D.moduleThicknessMm / 2, modZc),
    m.moduleBoard,
  );
  module.name = 'module_substrate';
  root.add(module);
  root.add(
    skin(
      roundedRect(D.moduleWidthMm - 0.1, D.moduleLengthMm - 0.1, 0.1),
      D.moduleWidthMm - 0.1,
      D.moduleLengthMm - 0.1,
      modZc,
      modTop + 0.004,
      true,
      'module_top',
      m.moduleTop,
    ),
  );
  // Castellated pads: 14 down each long side and 10 along the far edge (1.27 mm pitch) [WROOM]:
  // a solder-filled half hole in the edge, its pad on top, and the joint's fillet on the board.
  const castel: THREE.BufferGeometry[] = [];
  const padTop = new THREE.BoxGeometry(0.9, 0.035, 0.62);
  // The plated, solder-filled half hole: a strip of solder across the edge's thickness.
  const plate = new THREE.BoxGeometry(0.08, D.moduleThicknessMm * 0.95, 0.6);
  const toe = new THREE.BoxGeometry(0.35, 0.08, 0.55);
  const sideZ0 = modZ1 - 1.5 - 13 * 1.27;
  for (let i = 0; i < 14; i++)
    for (const sx of [-1, 1]) {
      const z = sideZ0 + i * 1.27;
      const ex = sx * (D.moduleWidthMm / 2);
      castel.push(at(padTop, sx * (D.moduleWidthMm / 2 - 0.45), modTop + 0.018, z));
      castel.push(at(plate, ex + sx * 0.02, yt + D.moduleThicknessMm / 2, z));
      castel.push(at(toe, ex + sx * 0.18, yt + 0.04, z));
    }
  for (let i = 0; i < 10; i++) {
    const x = (i - 4.5) * 1.27;
    castel.push(at(new THREE.BoxGeometry(0.62, 0.035, 0.9), x, modTop + 0.018, modZ1 - 0.45));
    castel.push(
      at(
        new THREE.BoxGeometry(0.6, D.moduleThicknessMm * 0.95, 0.08),
        x,
        yt + D.moduleThicknessMm / 2,
        modZ1 + 0.02,
      ),
    );
    castel.push(at(new THREE.BoxGeometry(0.55, 0.08, 0.35), x, yt + 0.04, modZ1 + 0.18));
  }
  root.add(merged('module_castellations', castel, m.tin));
  // The RF can: drawn steel, rounded corners, a stamped rim around its top panel.
  const canZc = modZ1 - 0.9 - D.shieldLengthMm / 2;
  const canY = modTop;
  const canGeo = mergeGeometries(
    [
      plain(
        new RoundedBoxGeometry(D.shieldWidthMm, D.shieldHeightMm, D.shieldLengthMm, 3, 0.3),
      ).translate(0, canY + D.shieldHeightMm / 2, canZc),
      // The top panel stands a hair proud of the rim (the stamping).
      plain(
        new RoundedBoxGeometry(D.shieldWidthMm - 0.9, 0.08, D.shieldLengthMm - 0.9, 2, 0.04),
      ).translate(0, canY + D.shieldHeightMm + 0.02, canZc),
    ],
    false,
  )!;
  // Texture coordinates for the runtime brushed-metal roughness: a top-down projection (the
  // brushing runs along x), 1 unit per 8 mm.
  {
    const pos = canGeo.attributes.position!;
    const nor = canGeo.attributes.normal!;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      // The walls (drawn, not brushed) take one texel: a projection would smear the streaks.
      const top = nor.getY(i) > 0.7;
      uv[i * 2] = top ? pos.getX(i) / 8 : 0.5;
      uv[i * 2 + 1] = top ? pos.getZ(i) / 8 : 0.5;
    }
    canGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const can = new THREE.Mesh(canGeo, m.can);
  can.name = 'shield_can';
  root.add(can);

  // ---- Markings: one atlas (runtime), quads on the can and the ICs --------------------------
  const marks: THREE.BufferGeometry[] = [
    markQuad(
      0,
      canY + D.shieldHeightMm + 0.065,
      canZc,
      D.shieldWidthMm - 1.2,
      D.shieldLengthMm - 1.2,
      MARK_ATLAS.regions.can,
    ),
  ];

  // ---- Micro-USB B receptacle (realism pass 5: rebuilt) -------------------------------------
  // A drawn-steel shell (0.22 mm wall) of the micro-B profile: a trapezoid with its lower corners
  // chamfered and its upper corners slightly rounded, flaring outward over the last 0.4 mm at the
  // mouth; inside, a dark cavity and the moulded insert tongue in the upper half, its five gold
  // contacts on the underside; two latch windows on top with their spring fingers; the rear wall
  // and its folded flap; side anchor tabs soldered to the board.
  {
    const u = LAYOUT.usb;
    const w = u.width;
    const h = u.height;
    const c = 0.85; // the B profile's lower chamfers
    const rTop = 0.18; // the drawn shell's upper bend radius
    /** The profile, centred on (0, 0): half-width W, half-height H, grown by `grow` (mm). */
    const profile = (grow: number) => {
      const W = w / 2 + grow;
      const H = h / 2 + grow;
      const C = c + grow * 0.4;
      const r = Math.max(0.02, rTop + grow * 0.5);
      const p = new THREE.Shape();
      p.moveTo(-W + r, H);
      p.lineTo(W - r, H);
      p.quadraticCurveTo(W, H, W, H - r);
      p.lineTo(W, -H + C);
      p.lineTo(W - C, -H);
      p.lineTo(-W + C, -H);
      p.lineTo(-W, -H + C);
      p.lineTo(-W, H - r);
      p.quadraticCurveTo(-W, H, -W + r, H);
      return p;
    };
    const ring = (outer: number, inner: number, depth: number) => {
      const shape = profile(outer);
      shape.holes.push(new THREE.Path(profile(inner).getPoints(4)));
      return plain(
        new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 }),
      );
    };
    const t = 0.22;
    const flare = 0.4;
    const yc = yt + h / 2;
    const z0 = u.front - u.depth; // the rear face
    const shellParts: THREE.BufferGeometry[] = [];
    // The body of the shell, then the flared mouth (outer and inner grow together).
    shellParts.push(ring(0, -t, u.depth - flare).translate(u.x, yc, z0));
    shellParts.push(ring(0.14, -t + 0.14, flare).translate(u.x, yc, u.front - flare));
    // The folded flap over the rear wall, from the top (the wall itself is in shadow: below).
    shellParts.push(
      at(new THREE.BoxGeometry(w * 0.62, 0.18, 1.1).rotateX(-0.95), u.x, yt + h - 0.3, z0 - 0.3),
    );
    // Rear anchor tabs, surface-mounted (the front pair goes through the board, out of sight).
    for (const sx of [-1, 1])
      shellParts.push(
        at(new THREE.BoxGeometry(0.9, 0.16, 1.3), u.x + sx * (w / 2 + 0.4), yt + 0.08, z0 + 1.0),
      );
    // Spring fingers of the two latch windows: strips stamped from the top, seen in the window.
    for (const sx of [-1, 1])
      shellParts.push(
        at(new THREE.BoxGeometry(0.3, 0.05, 0.9), u.x + sx * 2.2, yt + h + 0.012, u.front - 1.85),
      );
    root.add(merged('usb_shell', shellParts, m.nickel));
    // The dark: the latch windows' openings, and the cavity liner (inner walls in shadow; the
    // mouth's first 0.6 mm stays bright metal).
    const dark: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1])
      dark.push(
        at(new THREE.BoxGeometry(0.6, 0.03, 1.15), u.x + sx * 2.2, yt + h + 0.004, u.front - 1.85),
      );
    dark.push(ring(-t - 0.01, -t - 0.06, u.depth - 0.7).translate(u.x, yc, z0 + 0.12));
    dark.push(plain(new THREE.ShapeGeometry(profile(-t * 0.5), 4)).translate(u.x, yc, z0 + 0.13));
    root.add(merged('usb_cavity', dark, m.shadowed));
    // The insert tongue: moulded, in the upper half of the opening, set back from the mouth.
    const tongueW = 3.9;
    const tongueH = 0.6;
    const tongueTop = yt + h - t - 0.42;
    const tongueLen = u.depth - 1.0;
    const tongue = new THREE.Mesh(
      plain(new RoundedBoxGeometry(tongueW, tongueH, tongueLen, 1, 0.08)).translate(
        u.x,
        tongueTop - tongueH / 2,
        z0 + 0.12 + tongueLen / 2,
      ),
      m.tongue,
    );
    tongue.name = 'usb_tongue';
    root.add(tongue);
    const contacts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) {
      const x = u.x + (i - 2) * 0.65;
      contacts.push(
        at(
          new THREE.BoxGeometry(0.3, 0.05, tongueLen - 0.8),
          x,
          tongueTop - tongueH - 0.02,
          z0 + 0.12 + (tongueLen - 0.8) / 2 + 0.6,
        ),
      );
      // The SMD tails leaving the back of the connector onto their pads.
      contacts.push(at(new THREE.BoxGeometry(0.4, 0.12, 1.1), x, yt + 0.06, z0 - 0.45));
    }
    root.add(merged('usb_contacts', contacts, m.gold));
    // The anchor tabs soldered to their pads: low fillets.
    const usbSolder: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1])
      for (const [zc, len, dx] of [
        [u.front - 1.6, 1.5, 0.3],
        [z0 + 1.0, 1.3, 0.45],
      ] as const)
        usbSolder.push(
          at(
            new THREE.CylinderGeometry(0.55, 0.65, len + 0.3, 8, 1)
              .rotateX(Math.PI / 2)
              .scale(1, 0.32, 1),
            u.x + sx * (w / 2 + dx),
            yt + 0.06,
            zc,
          ),
        );
    root.add(merged('usb_solder', usbSolder, m.solder));
  }

  // ---- EN and BOOT SMD tact switches ----------------------------------------------------------
  {
    const b = LAYOUT.switchBody;
    const bodies: THREE.BufferGeometry[] = [];
    const covers: THREE.BufferGeometry[] = [];
    const caps: THREE.BufferGeometry[] = [];
    for (const p of [LAYOUT.en, LAYOUT.boot]) {
      bodies.push(
        at(
          new RoundedBoxGeometry(b.x - 0.3, b.h - 0.35, b.z - 0.2, 2, 0.12),
          p.x,
          yt + (b.h - 0.35) / 2,
          p.z,
        ),
      );
      // Stainless cover: the top plate and its folded side skirts, with the round opening's boss.
      covers.push(at(new RoundedBoxGeometry(b.x, 0.14, b.z, 1, 0.05), p.x, yt + b.h - 0.28, p.z));
      for (const sx of [-1, 1])
        covers.push(
          at(
            new THREE.BoxGeometry(0.1, b.h - 0.45, b.z - 0.8),
            p.x + sx * (b.x / 2 - 0.05),
            yt + (b.h - 0.45) / 2 + 0.1,
            p.z,
          ),
        );
      covers.push(at(new THREE.CylinderGeometry(0.85, 0.95, 0.1, 28), p.x, yt + b.h - 0.16, p.z));
      // Gull-wing terminals at both ends.
      for (const sz of [-1, 1])
        for (const sx of [-1, 1])
          covers.push(
            at(
              new THREE.BoxGeometry(0.7, 0.12, 0.9),
              p.x + sx * 0.8,
              yt + 0.06,
              p.z + sz * (b.z / 2 + 0.3),
            ),
          );
      caps.push(at(new THREE.CylinderGeometry(0.62, 0.66, 0.42, 28), p.x, yt + b.h - 0.0, p.z));
    }
    // Each gull-wing foot soldered to its pad: a low fillet beyond the foot.
    const feet: THREE.BufferGeometry[] = [];
    for (const p of [LAYOUT.en, LAYOUT.boot])
      for (const sz of [-1, 1])
        for (const sx of [-1, 1])
          feet.push(
            at(
              new THREE.CylinderGeometry(0.4, 0.45, 0.55, 6, 1)
                .rotateX(Math.PI / 2)
                .scale(1, 0.4, 1),
              p.x + sx * 0.8,
              yt + 0.08,
              p.z + sz * (b.z / 2 + 0.62),
            ),
          );
    root.add(merged('switch_solder', feet, m.solder));
    root.add(merged('switch_bodies', bodies, m.switchBody));
    root.add(merged('switch_covers', covers, m.steel));
    root.add(merged('switch_actuators', caps, m.actuator));
  }

  // ---- ICs: USB-UART bridge (QFN-28), 3.3 V regulator (SOT-223), two SOT-23 transistors -----
  {
    const ics: THREE.BufferGeometry[] = [];
    const leads: THREE.BufferGeometry[] = [];
    const q = LAYOUT.bridge;
    ics.push(
      at(new RoundedBoxGeometry(q.size, q.h, q.size, 1, 0.06), q.x, yt + q.h / 2 + 0.02, q.z),
    );
    for (let i = 0; i < 7; i++) {
      const o = (i - 3) * 0.5;
      const e = q.size / 2;
      leads.push(at(new THREE.BoxGeometry(0.25, 0.22, 0.45), q.x + o, yt + 0.11, q.z - e + 0.12));
      leads.push(at(new THREE.BoxGeometry(0.25, 0.22, 0.45), q.x + o, yt + 0.11, q.z + e - 0.12));
      leads.push(at(new THREE.BoxGeometry(0.45, 0.22, 0.25), q.x - e + 0.12, yt + 0.11, q.z + o));
      leads.push(at(new THREE.BoxGeometry(0.45, 0.22, 0.25), q.x + e - 0.12, yt + 0.11, q.z + o));
    }
    marks.push(
      markQuad(q.x, yt + q.h + 0.03, q.z, q.size - 0.6, q.size - 0.6, MARK_ATLAS.regions.bridge),
    );

    // SOT-223: body 3.5 (x) x 6.5 (z) x 1.6 standing 0.1 proud; leads leave at mid-height.
    const r = LAYOUT.regulator;
    ics.push(at(new RoundedBoxGeometry(3.5, 1.6, 6.5, 1, 0.1), r.x, yt + 0.1 + 0.8, r.z));
    marks.push(markQuad(r.x, yt + 1.73, r.z, 3.0, 5.6, MARK_ATLAS.regions.regulator));
    const gull = (width: number, reach: number) => {
      // Side profile in the XY plane: out of the body at mid-height, down, out along the board.
      const p = new THREE.Shape();
      p.moveTo(0, 0.95);
      p.lineTo(0.35, 0.95);
      p.quadraticCurveTo(0.55, 0.95, 0.6, 0.6);
      p.lineTo(0.7, 0.25);
      p.quadraticCurveTo(0.75, 0.12, 0.95, 0.12);
      p.lineTo(reach, 0.12);
      p.lineTo(reach, 0);
      p.lineTo(0.9, 0);
      p.quadraticCurveTo(0.65, 0, 0.58, 0.22);
      p.lineTo(0.48, 0.6);
      p.quadraticCurveTo(0.45, 0.83, 0.3, 0.83);
      p.lineTo(0, 0.83);
      p.closePath();
      const geo = new THREE.ExtrudeGeometry(p, {
        depth: width,
        bevelEnabled: false,
        curveSegments: 3,
      });
      return geo.translate(0, 0, -width / 2);
    };
    for (let i = 0; i < 3; i++) {
      // Leads towards -x (rotate the +x profile by 180 degrees about y).
      leads.push(at(gull(0.7, 1.6).rotateY(Math.PI), r.x - 1.75, yt, r.z + (1 - i) * 2.3));
    }
    leads.push(at(gull(3.0, 1.6), r.x + 1.75, yt, r.z));
    // SOT-23: body 2.9 (x) x 1.3 (z) x 1.0; two leads towards -z, one towards +z.
    LAYOUT.transistors.forEach((t, k) => {
      ics.push(at(new RoundedBoxGeometry(2.9, 1.0, 1.3, 1, 0.08), t.x, yt + 0.1 + 0.5, t.z));
      const small = (rot: number) => gull(0.4, 1.05).scale(1, 0.62, 1).rotateY(rot);
      for (const dx of [-0.95, 0.95]) leads.push(at(small(Math.PI / 2), t.x + dx, yt, t.z - 0.65));
      leads.push(at(small(-Math.PI / 2), t.x, yt, t.z + 0.65));
      marks.push(markQuad(t.x, yt + 1.13, t.z, 2.4, 1.0, MARK_ATLAS.regions[k ? 'sot2' : 'sot1']));
    });
    root.add(merged('ic_bodies', ics, m.epoxy));
    root.add(merged('ic_leads', leads, m.tin));
  }

  // ---- Chip passives, the power LED, the ESD diodes; exposed gold pads --------------------
  {
    const caps: THREE.BufferGeometry[] = [];
    const res: THREE.BufferGeometry[] = [];
    const substrates: THREE.BufferGeometry[] = [];
    const ends: THREE.BufferGeometry[] = [];
    const ledBodies: THREE.BufferGeometry[] = [];
    const ledLenses: THREE.BufferGeometry[] = [];
    const diodes: THREE.BufferGeometry[] = [];
    for (const c of CHIPS) {
      const [L, W, H] = CHIP_SIZE[c.kind];
      const along = (l: number, w: number, h: number) =>
        new RoundedBoxGeometry(c.alongZ ? w : l, h, c.alongZ ? l : w, 1, Math.min(0.04, h / 6));
      const box = (l: number, w: number, h: number) =>
        new THREE.BoxGeometry(c.alongZ ? w : l, h, c.alongZ ? l : w);
      const term = Math.min(0.3, L * 0.22);
      if (c.kind === 'led0603') {
        ledBodies.push(at(along(L, W, H * 0.45), c.x, yt + H * 0.225, c.z));
        ledLenses.push(at(along(L * 0.62, W * 0.9, H * 0.55), c.x, yt + H * 0.45 + H * 0.275, c.z));
      } else if (c.kind === 'sod523') {
        diodes.push(at(along(L * 0.7, W, H), c.x, yt + H / 2, c.z));
      } else if (c.kind.startsWith('c')) {
        // Ceramic body between two tinned terminations.
        caps.push(at(along(L - 2 * term, W * 0.98, H * 0.98), c.x, yt + H / 2, c.z));
      } else {
        // Thick-film resistor: the white alumina substrate (its sides show) under the black
        // overcoat on top, between the terminations.
        substrates.push(at(along(L - 2 * term, W * 0.98, H * 0.72), c.x, yt + H * 0.36, c.z));
        res.push(at(box((L - 2 * term) * 0.96, W * 0.9, H * 0.26), c.x, yt + H * 0.85, c.z));
      }
      for (const e of [-1, 1]) {
        const dz = c.alongZ ? e * (L / 2 - term / 2) : 0;
        const dx = c.alongZ ? 0 : e * (L / 2 - term / 2);
        const h = c.kind === 'sod523' ? 0.18 : H;
        ends.push(at(box(term, W + 0.02, h), c.x + dx, yt + h / 2, c.z + dz));
        // The solder fillet on the pad beyond the termination.
        ends.push(
          at(box(0.18, W * 0.9, h * 0.35), c.x + dx * 1.18, yt + h * 0.17, c.z + dz * 1.18),
        );
      }
    }
    root.add(merged('mlcc', caps, m.ceramic));
    root.add(merged('chip_resistors', res, m.resistor));
    root.add(merged('chip_substrates', substrates, m.alumina));
    root.add(merged('chip_terminations', ends, m.tin));
    root.add(merged('diodes', diodes, m.epoxy));
    root.add(merged('power_led_body', ledBodies, m.ledBody));
    const lens = new THREE.Mesh(mergeGeometries(ledLenses.map(plain), false)!, m.ledLens);
    lens.name = 'power_led';
    root.add(lens);
    const pads: THREE.BufferGeometry[] = [];
    const gp = LAYOUT.goldPads;
    for (const x of gp.x)
      for (const z of gp.z)
        pads.push(at(new THREE.BoxGeometry(gp.l, 0.035, gp.w), x, yt + 0.018, z));
    root.add(merged('enig_pads', pads, m.gold));
  }

  const markMesh = new THREE.Mesh(mergeGeometries(marks, false)!, m.markings);
  markMesh.name = 'markings';
  root.add(markMesh);
  return root;
}

/** Anchors (electrical attach points) of the asset, local frame, mm: each header pin's top stub. */
export function esp32PinAnchors(): Record<string, { x: number; y: number; z: number }> {
  const out: Record<string, { x: number; y: number; z: number }> = {};
  for (const pin of ESP32_DEVKITC_WROOM32.pins)
    out[`${pin.header}.${pin.position}`] = {
      x: Math.sign(boardPinPosition(pin).x) * ROW_X,
      y: ESP32_PCB_TOP + D.pinStubAboveMm,
      z: pinZ(pin.position),
    };
  return out;
}
