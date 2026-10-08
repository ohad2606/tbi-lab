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
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CATALOG, ESP32_DEVKITC_WROOM32, boardPinPosition, boardTerminalId } from '@tbi-lab/domain';
import {
  BUZZER_CEM1205,
  DIODE_DO35,
  LDR_GL5528,
  RELAY_SRD,
  RGB_LED_5MM,
  TO92,
  PIR_HC_SR501,
  LED_MATRIX_1088AS,
  matrixPinXZ,
  capacitorPackage,
  ESP32_DEVKITC,
  ESP32_PCB_BOTTOM,
  ESP32_PCB_TOP,
  LEAD_ATTACH_HEIGHT,
  LED_PACKAGES,
  type AxialPhysics,
} from './physical.js';
import { SCALE, realPinZ, type ModelKey, type SceneComponent } from './scene.js';
import {
  OwnedResources,
  box,
  canvasTexture,
  cylinder,
  lathe,
  mesh,
  roundPath,
  tube,
  type V3,
} from './kit.js';

import { buildResistorHiFi } from './assets/resistorAxial.js';
import { buildLedHiFi } from './assets/led5mm.js';
import { buildDo35 } from './assets/diodeDo35.js';
import { buildGround, buildPsu, buildTactile, buildToggle } from './assets/benchParts.js';
import { buildEsp32Asset } from './assets/esp32DevkitC.js';
import { buildDupont, dupontMaterials } from './assets/dupont.js';

export { OwnedResources, roundPath };

export type Materials = ReturnType<typeof createMaterials>;

/**
 * The material library (Sprint 10 realism pass): one physically based set per viewer, shared by
 * every procedural part. Metals are metals (metalness 1, their colour the reflectance: tin, nickel,
 * gold, stainless), plastics are dielectrics with the roughness of their finish (moulded PBT and
 * nylon, glossy binding-post caps, a powder-coated case). In the reduced tier the viewer damps
 * metalness (renderer.ts simplifyMaterials) because there is no environment to reflect.
 */
export function createMaterials() {
  const std = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...extra });
  const metal = (color: string, roughness: number) => std(color, { metalness: 1, roughness });
  const library = {
    /** Tinned copper leads: hot-dip tin is satin, not mirror chrome (high-fidelity pass 3). */
    lead: metal('#c9cdd2', 0.4),
    /** Gold-flashed header pins. */
    gold: metal('#e0b65c', 0.26),
    /** Soldermask: the DevKitC's near-black board. */
    pcb: std('#121417', { roughness: 0.45 }),
    pcbEdge: std('#2a2a24', { roughness: 0.75 }),
    moduleBoard: std('#15171a', { roughness: 0.45 }),
    shield: metal('#cfd2d5', 0.36),
    /** Moulded black plastics (PBT, nylon): matte with a faint sheen. */
    blackPlastic: std('#141416', { roughness: 0.55 }),
    darkPlastic: std('#24262a', { roughness: 0.45 }),
    ic: std('#1b1c1f', { roughness: 0.55 }),
    /** Bright nickel/chrome plating (bushings, levers, binding-post studs). */
    chrome: metal('#eceef0', 0.22),
    /** Stainless and plated steel (switch covers, nuts, washers). */
    steel: metal('#c2c7cc', 0.3),
    resistorBody: std('#d8c29a', { roughness: 0.55 }),
    /** DO-35: amber-tinted glass with the junction inside (procedural fallback only). */
    glass: std('#d9772a', { roughness: 0.12, transparent: true, opacity: 0.72 }),
    cathodeBand: std('#151515', { roughness: 0.5 }),
    /** Bench-supply case: powder-coated steel (fine texture, matte). */
    psuCase: std('#8f969e', { roughness: 0.55 }),
    psuPanel: std('#23272d', { roughness: 0.5 }),
    /** Glossy moulded caps (binding posts, ground post). */
    red: std('#c4161c', { roughness: 0.28 }),
    black: std('#141416', { roughness: 0.3 }),
    white: std('#eceff1', { roughness: 0.5 }),
    smdTan: std('#a07c4f', { roughness: 0.6 }),
    smdLed: std('#e53935', { roughness: 0.3 }),
    /** Rubber feet. */
    rubber: std('#1c1c1e', { roughness: 0.9 }),
    generic: std('#8d97a3'),
  };
  // Named by key: the deterministic finish variation (variation.ts) finds its family by name.
  for (const [name, m] of Object.entries(library)) m.name = name;
  return library;
}

type Builder = (c: SceneComponent, m: Materials, own: OwnedResources) => THREE.Object3D;

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

/** Bend radius of a formed axial lead, to the lead's centre minus its radius (mm). */
const FORMED_BEND = 0.8;

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
      // A formed lead: bent round a ~2x lead-diameter radius, smooth (not a faceted elbow).
      FORMED_BEND + r,
      12,
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
      FORMED_BEND + r,
      12,
    ),
  );
  return g;
}

// ---------------------------------------------------------------------------------------------
// Sprint 10 parts

/**
 * A multi-lead part's leads: each from its exit point under the body, down to its own knee height,
 * along a plan path (optional detour points), to its terminal, then down to the bench. Distinct
 * knee heights keep leads that cross in plan apart (more than a lead's thickness). A terminal that
 * another part touches without a connection stops OPEN_LEAD_GAP short.
 */
function splayedLeads(
  c: SceneComponent,
  own: OwnedResources,
  mat: THREE.Material,
  radius: number,
  leads: {
    terminal: string;
    from: [number, number];
    top: number;
    knee: number;
    via?: [number, number][];
  }[],
) {
  const g = new THREE.Group();
  const def = CATALOG[c.type];
  for (const l of leads) {
    const t = def.terminals.find((x) => x.id === l.terminal)!;
    let tx = t.offset.x * SCALE;
    let tz = t.offset.y * SCALE;
    const prev = l.via?.at(-1) ?? l.from;
    if (c.terminals.some((x) => x.id === l.terminal && x.open)) {
      const d = Math.hypot(tx - prev[0], tz - prev[1]) || 1;
      tx -= ((tx - prev[0]) / d) * OPEN_LEAD_GAP;
      tz -= ((tz - prev[1]) / d) * OPEN_LEAD_GAP;
    }
    const pts: V3[] = [
      [l.from[0], l.top, l.from[1]],
      [l.from[0], l.knee, l.from[1]],
      ...(l.via ?? []).map(([x, z]): V3 => [x, l.knee, z]),
      [tx, l.knee, tz],
      [tx, LEAD_ATTACH_HEIGHT - 0.3, tz],
    ];
    g.add(tube(own, pts, radius, mat, 0.5));
  }
  return g;
}

/** A flat label/marking on the top of a part (a plane, canvas-textured, facing up). */
function topLabel(
  own: OwnedResources,
  key: string,
  w: number,
  d: number,
  y: number,
  px: [number, number],
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const tex = canvasTexture(own, px[0], px[1], (ctx) => draw(ctx, px[0], px[1]));
  const plane = new THREE.Mesh(
    own.shared(`plane:${key}`, () => new THREE.PlaneGeometry(w, d)),
    own.mat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, transparent: true })),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = y;
  plane.receiveShadow = true;
  return plane;
}

function buildRgbLed(c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = RGB_LED_5MM;
  const g = new THREE.Group();
  // Water-clear epoxy (realism pass 2: transmissive on the full tier, like the single LEDs): its
  // glow colour is set live from the solved channel currents (renderer).
  const lens = own.mat(
    own.tier === 'full'
      ? new THREE.MeshPhysicalMaterial({
          color: '#f2f5f7',
          roughness: 0.1,
          transmission: 0.9,
          thickness: 4,
          ior: 1.5,
          clearcoat: 0.9,
          clearcoatRoughness: 0.06,
          emissive: '#ffffff',
          emissiveIntensity: 0,
        })
      : new THREE.MeshStandardMaterial({
          color: '#eef3f7',
          roughness: 0.06,
          transparent: true,
          opacity: 0.45,
          emissive: '#ffffff',
          emissiveIntensity: 0,
          depthWrite: false,
        }),
  );
  const base = p.standoffMm;
  const R = p.bodyDiameterMm / 2;
  const top = base + p.heightMm;
  const domeStart = top - p.domeRadiusMm;
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
  const body = lathe(own, 'rgbLed', profile, lens);
  body.castShadow = false;
  body.userData.lens = true;
  g.add(body);
  const flange = cylinder(
    own,
    p.flangeDiameterMm / 2,
    p.flangeThicknessMm,
    lens,
    [0, base + p.flangeThicknessMm / 2, 0],
    32,
  );
  flange.castShadow = false;
  g.add(flange);
  // Inside: four posts in a row; the three dice (red, blue, green) sit on the cathode anvil.
  const inner = base + p.flangeThicknessMm;
  const postH = (domeStart - inner) * 0.7;
  const xs = p.pinOrder.map((_, i) => (i - 1.5) * p.leadPitchMm);
  p.pinOrder.forEach((pin, i) =>
    g.add(
      box(own, pin === 'cathode' ? 0.8 : 0.3, postH, 0.3, m.lead, [xs[i]!, inner + postH / 2, 0]),
    ),
  );
  const dieY = inner + postH + 0.12;
  (
    [
      ['#d81b1b', -0.35],
      ['#1e4dd8', 0],
      ['#17b04a', 0.35],
    ] as const
  ).forEach(([col, dx]) =>
    g.add(
      box(
        own,
        0.28,
        0.2,
        0.28,
        own.sharedMat(
          `die:${col}`,
          () => new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 }),
        ),
        [xs[1]! + dx, dieY, 0],
      ),
    ),
  );
  // Leads at 1.27 mm (pin 1 red, 2 cathode, 3 blue, 4 green), splayed to the terminals at
  // distinct knee heights; the cathode and green leads detour round the other pins.
  g.add(
    splayedLeads(c, own, m.lead, p.leadSizeMm / 2, [
      { terminal: 'red', from: [xs[0]!, 0], top: base + 0.2, knee: 1.0 },
      {
        terminal: 'cathode',
        from: [xs[1]!, 0],
        top: base + 0.2,
        knee: 1.0,
        via: [
          [xs[1]!, -1.3],
          [6.35, -1.3],
        ],
      },
      { terminal: 'blue', from: [xs[2]!, 0], top: base + 0.2, knee: 1.6 },
      {
        terminal: 'green',
        from: [xs[3]!, 0],
        top: base + 0.2,
        knee: 2.3,
        via: [
          [xs[3]!, 1.7],
          [-6.35, 1.7],
        ],
      },
    ]),
  );
  g.userData.lensMaterial = lens;
  g.userData.ledTop = top;
  g.userData.ledColor = '#ffffff';
  g.userData.rgb = true;
  return g;
}

function buildPhotoresistor(c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = LDR_GL5528;
  const g = new THREE.Group();
  const R = p.diameterMm / 2;
  const flat = p.flatToFlatMm / 2;
  const outline = () => {
    const a = Math.asin(flat / R);
    const sh = new THREE.Shape();
    // Two flats parallel to x (the leads' axis), as on the part's top view.
    sh.absarc(0, 0, R, -a, a, false);
    sh.lineTo(R * Math.cos(a), flat);
    sh.absarc(0, 0, R, a, Math.PI - a, false);
    sh.absarc(0, 0, R, Math.PI - a, Math.PI + a, false);
    sh.absarc(0, 0, R, Math.PI + a, 2 * Math.PI - a, false);
    return sh;
  };
  const ceramic = own.sharedMat(
    'ldrCeramic',
    () => new THREE.MeshStandardMaterial({ color: '#efe6d2', roughness: 0.65 }),
  );
  const disc = mesh(
    own.shared('ldrDisc', () => {
      const geo = new THREE.ExtrudeGeometry(outline(), {
        depth: p.thicknessMm,
        bevelEnabled: false,
        curveSegments: 24,
      });
      geo.rotateX(-Math.PI / 2);
      return geo;
    }),
    ceramic,
    [0, p.standoffMm, 0],
  );
  g.add(disc);
  // The light-sensitive face: the CdS serpentine between two comb electrodes, under clear epoxy.
  const face = topLabel(
    own,
    'ldrFace',
    p.diameterMm,
    p.diameterMm,
    p.standoffMm + p.thicknessMm + 0.01,
    [256, 256],
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 2 - 2, 0, 2 * Math.PI);
      ctx.clip();
      ctx.fillStyle = '#efe6d2';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#c9a36a'; // the two electrode pads
      ctx.fillRect(0, 0, w, 40);
      ctx.fillRect(0, h - 40, w, 40);
      ctx.strokeStyle = '#a0521d'; // the CdS track
      ctx.lineWidth = 16;
      ctx.beginPath();
      const turns = 6;
      for (let i = 0; i <= turns; i++) {
        const x = 40 + (i * (w - 80)) / turns;
        if (i === 0) ctx.moveTo(x, 40);
        ctx.lineTo(x, i % 2 ? h - 40 : 40);
        if (i < turns) ctx.lineTo(x + (w - 80) / turns, i % 2 ? h - 40 : 40);
      }
      ctx.stroke();
      ctx.restore();
    },
  );
  face.rotation.z = Math.PI / 2;
  g.add(face);
  g.add(
    splayedLeads(c, own, m.lead, p.leadDiameterMm / 2, [
      { terminal: 'a', from: [-p.leadSpacingMm / 2, 0], top: p.standoffMm + 0.2, knee: 1.3 },
      { terminal: 'b', from: [p.leadSpacingMm / 2, 0], top: p.standoffMm + 0.2, knee: 1.3 },
    ]),
  );
  return g;
}

function buildBuzzer(c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = BUZZER_CEM1205;
  const g = new THREE.Group();
  const R = p.diameterMm / 2;
  const y0 = p.standoffMm;
  // Moulded can (realism pass 2): rounded base and top edges, the top's raised rim, the sound
  // hole as a real recess; glossy black plastic.
  const H = p.heightMm;
  const hole = p.soundHoleDiameterMm / 2;
  const can = mesh(
    own.shared(
      'buzzer:can',
      () =>
        new THREE.LatheGeometry(
          (
            [
              [0.001, 0],
              [R - 0.35, 0],
              [R - 0.05, 0.15],
              [R, 0.45],
              [R, H - 0.55],
              [R - 0.08, H - 0.18],
              [R - 0.35, H],
              [R - 0.9, H],
              [R - 1.1, H - 0.2],
              [hole + 0.6, H - 0.2],
              [hole + 0.25, H - 0.08],
              [hole, H - 0.12],
              [hole, H - 1.2],
              [0.001, H - 1.2],
            ] as [number, number][]
          ).map(([r, y]) => new THREE.Vector2(r, y)),
          48,
        ),
    ),
    own.sharedMat(
      'buzzer:plastic',
      () => new THREE.MeshStandardMaterial({ color: '#111113', roughness: 0.32 }),
    ),
    [0, y0, 0],
  );
  g.add(can);
  // Top: the sound hole in the middle, "+" beside the positive pin (-x), the laser marking.
  const top = topLabel(
    own,
    'buzzerTop',
    p.diameterMm,
    p.diameterMm,
    y0 + p.heightMm + 0.01,
    [256, 256],
    (ctx, w, h) => {
      // (The sound hole is geometry now: the marking leaves it clear.)
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#8d9096';
      ctx.font = 'bold 64px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', w * 0.2, h * 0.5);
      ctx.font = '22px sans-serif';
      ctx.fillText('CEM1205IC', w / 2, h * 0.78);
    },
  );
  g.add(top);
  g.add(
    splayedLeads(c, own, m.gold, p.pinDiameterMm / 2, [
      { terminal: 'positive', from: [-p.pinSpacingMm / 2, 0], top: y0 + 0.2, knee: 0.8 },
      { terminal: 'negative', from: [p.pinSpacingMm / 2, 0], top: y0 + 0.2, knee: 0.8 },
    ]),
  );
  return g;
}

function buildRelay(_c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = RELAY_SRD;
  const g = new THREE.Group();
  const blue = own.sharedMat(
    'relayCase',
    () => new THREE.MeshStandardMaterial({ color: '#1b5ac0', roughness: 0.3 }),
  );
  const y0 = p.standoffMm;
  // Moulded case (realism pass 2): rounded edges, glossy.
  g.add(
    mesh(
      own.shared(
        'relay:case',
        () => new RoundedBoxGeometry(p.lengthMm, p.heightMm, p.widthMm, 3, 0.7),
      ),
      blue,
      [0, y0 + p.heightMm / 2, 0],
    ),
  );
  // The printed top: maker, part number and the contact ratings (as on the part).
  g.add(
    topLabel(
      own,
      'relayTop',
      p.lengthMm - 1.2,
      p.widthMm - 1.2,
      y0 + p.heightMm + 0.01,
      [512, 416],
      (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#f4f6f8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 64px sans-serif';
        ctx.fillText('SONGLE', w / 2, h * 0.18);
        ctx.font = 'bold 46px sans-serif';
        ctx.fillText('SRD-05VDC-SL-C', w / 2, h * 0.38);
        ctx.font = '34px sans-serif';
        ctx.fillText('10A 250VAC  10A 125VAC', w / 2, h * 0.6);
        ctx.fillText('10A 30VDC   10A 28VDC', w / 2, h * 0.75);
      },
    ),
  );
  // Five pins down to the bench: round coil/COM pins, flat contact pins; a solder joint at each
  // tip where its wire is attached.
  for (const [id, [x, z]] of Object.entries(p.pins)) {
    const flatPin = id === 'no' || id === 'nc';
    g.add(
      flatPin
        ? box(own, 1.0, y0, 0.4, m.lead, [x, y0 / 2, z])
        : cylinder(own, 0.3, y0, m.lead, [x, y0 / 2, z], 12),
    );
    const blob = cylinder(own, 0.55, 0.9, m.chrome, [x, p.attachHeightMm, z], 16, 0.75);
    blob.userData.pin = id;
    g.add(blob);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Builders

function buildTo92(c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = TO92;
  const g = new THREE.Group();
  const y0 = p.standoffMm;
  // The D-shaped body: flat face towards +z (the viewer of the default camera), round back.
  const r = p.widthMm / 2;
  const flatZ = p.depthMm - r; // the flat face's distance in front of the round back's centre
  const body = mesh(
    own.shared('to92', () => {
      // In the shape plane, y maps to -z: the chord at y = -flatZ becomes the flat face at
      // z = +flatZ (towards the default camera), the arc through +y the round back.
      const a = Math.asin(Math.min(1, flatZ / r));
      const sh = new THREE.Shape();
      sh.absarc(0, 0, r, -a, Math.PI + a, false);
      sh.lineTo(r * Math.cos(-a), -flatZ);
      const geo = new THREE.ExtrudeGeometry(sh, {
        depth: p.heightMm,
        bevelEnabled: false,
        curveSegments: 24,
      });
      geo.rotateX(-Math.PI / 2);
      return geo;
    }),
    m.ic,
    [0, y0, 0],
  );
  g.add(body);
  // The marking on the flat face.
  const tex = canvasTexture(own, 256, 256, (ctx) => {
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = '#9da2a8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 54px sans-serif';
    ctx.fillText('2N', 128, 92);
    ctx.fillText('3904', 128, 160);
  });
  const face = new THREE.Mesh(
    own.shared('plane:to92face', () => new THREE.PlaneGeometry(p.widthMm * 0.8, p.heightMm * 0.8)),
    own.mat(new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6 })),
  );
  // Facing the flat side (from +z), the leads read E-B-C left to right, as on the drawing.
  face.position.set(0, y0 + p.heightMm / 2, flatZ + 0.01);
  g.add(face);
  const xs = p.pinOrder.map((_, i) => (i - 1) * p.leadPitchMm);
  const at = (pin: string) => xs[p.pinOrder.indexOf(pin as (typeof p.pinOrder)[number])]!;
  g.add(
    splayedLeads(c, own, m.lead, p.leadWidthMm / 2, [
      { terminal: 'emitter', from: [at('emitter'), 0], top: y0 + 0.2, knee: 1.8 },
      { terminal: 'base', from: [at('base'), 0], top: y0 + 0.2, knee: 1.0 },
      { terminal: 'collector', from: [at('collector'), 0], top: y0 + 0.2, knee: 1.4 },
    ]),
  );
  return g;
}

function buildPir(_c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = PIR_HC_SR501;
  const g = new THREE.Group();
  const y0 = p.standoffMm;
  const green = own.sharedMat(
    'pirPcb',
    () => new THREE.MeshStandardMaterial({ color: '#1f6b3c', roughness: 0.6 }),
  );
  g.add(
    box(own, p.boardXMm, p.boardThicknessMm, p.boardZMm, green, [
      0,
      y0 + p.boardThicknessMm / 2,
      0,
    ]),
  );
  // Fresnel dome: a body of revolution with shallow ridges (the lens facets), milky white.
  const R = p.domeDiameterMm / 2;
  // Realism pass 2: a smooth dome with fine, shallow facet rings (the Fresnel zones), milky
  // translucent plastic on the full tier.
  const profile: [number, number][] = [[R, 0]];
  const steps = 72;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    const ridge = 0.07 * Math.abs(Math.sin(i * 0.9));
    profile.push([Math.max(0.001, (R + ridge) * Math.cos(a)), p.domeHeightMm * Math.sin(a)]);
  }
  const dome = lathe(
    own,
    'pirDome2',
    profile,
    own.sharedMat('pirDome', () =>
      own.tier === 'full'
        ? new THREE.MeshPhysicalMaterial({
            color: '#f4f4f0',
            roughness: 0.55,
            transmission: 0.25,
            thickness: 1.5,
            sheen: 0.4,
            sheenRoughness: 0.5,
            sheenColor: new THREE.Color('#ffffff'),
          })
        : new THREE.MeshStandardMaterial({ color: '#f1f2ee', roughness: 0.7 }),
    ),
  );
  dome.position.y = y0 + p.boardThicknessMm;
  dome.userData.pirDome = true;
  g.add(dome);
  // Underneath: the two orange trim pots (delay, sensitivity) and the trigger jumper.
  const orange = own.sharedMat(
    'trimPot',
    () => new THREE.MeshStandardMaterial({ color: '#e8862a', roughness: 0.5 }),
  );
  for (const z of [-6, 6]) g.add(cylinder(own, 2.6, 2.2, orange, [10, y0 - 1.1, z], 20));
  g.add(box(own, 2.0, 2.4, 5.2, m.blackPlastic, [4, y0 - 1.2, -9]));
  // The 3-pin header (GND, OUT, +V): plastic spacer under the board, pins down to the bench.
  g.add(box(own, 2.5, 2.5, 7.6, m.blackPlastic, [p.pins.gnd![0], y0 - 1.25, 0]));
  for (const [id, [x, z]] of Object.entries(p.pins)) {
    g.add(box(own, 0.64, y0, 0.64, m.gold, [x, y0 / 2, z]));
    const blob = cylinder(own, 0.55, 0.9, m.chrome, [x, p.attachHeightMm, z], 16, 0.75);
    blob.userData.pin = id;
    g.add(blob);
  }
  return g;
}

/** Paint the matrix face: every dot dark, or lit by its level (0..1, from the solved current). */
export function paintMatrixFace(ctx: CanvasRenderingContext2D, size: number, levels: number[]) {
  const n = 8;
  ctx.fillStyle = '#121315';
  ctx.fillRect(0, 0, size, size);
  const step = size / n;
  levels.forEach((l, k) => {
    const x = (k % n) * step + step / 2;
    const y = Math.floor(k / n) * step + step / 2;
    ctx.beginPath();
    ctx.arc(x, y, step * 0.36, 0, 2 * Math.PI);
    if (l > 0) {
      const a = Math.min(1, 0.25 + 0.75 * l);
      ctx.fillStyle = `rgba(255, ${Math.round(60 + 120 * l)}, ${Math.round(40 + 60 * l)}, ${a})`;
    } else ctx.fillStyle = '#26272a';
    ctx.fill();
  });
}

function buildLedMatrix(_c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = LED_MATRIX_1088AS;
  const g = new THREE.Group();
  const y0 = p.standoffMm;
  const body = own.sharedMat(
    'matrixBody',
    () => new THREE.MeshStandardMaterial({ color: '#e9eaec', roughness: 0.6 }),
  );
  g.add(
    mesh(
      own.shared(
        'matrix:body',
        () => new RoundedBoxGeometry(p.sizeMm, p.heightMm, p.sizeMm, 2, 0.5),
      ),
      body,
      [0, y0 + p.heightMm / 2, 0],
    ),
  );
  // The face: its own canvas texture, repainted live from the dot currents (renderer).
  const tex = canvasTexture(own, 256, 256, (ctx) =>
    paintMatrixFace(ctx, 256, new Array(64).fill(0)),
  );
  const faceMat = own.mat(
    new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.35,
      emissiveMap: tex,
      emissive: '#000000',
    }),
  );
  const face = new THREE.Mesh(
    own.shared('plane:matrixFace', () => new THREE.PlaneGeometry(p.sizeMm - 0.6, p.sizeMm - 0.6)),
    faceMat,
  );
  face.rotation.x = -Math.PI / 2;
  face.position.y = y0 + p.heightMm + 0.02;
  g.add(face);
  for (let n = 1; n <= 16; n++) {
    const [x, z] = matrixPinXZ(n);
    g.add(box(own, 0.5, y0, 0.5, m.lead, [x, y0 / 2, z]));
    const blob = cylinder(own, 0.55, 0.9, m.chrome, [x, p.attachHeightMm, z], 16, 0.75);
    blob.userData.pin = n;
    g.add(blob);
  }
  g.userData.matrixFace = { texture: tex, material: faceMat };
  return g;
}

function buildCapacitor(c: SceneComponent, m: Materials, own: OwnedResources) {
  const p = capacitorPackage(c.visual.farads ?? 100e-6);
  const g = new THREE.Group();
  const y0 = p.standoffMm;
  if (p.kind === 'disc') {
    // Disc ceramic, standing on edge (the disc's plane along x).
    // Realism pass 2: the epoxy dip's rounded, slightly domed faces (not a flat cylinder).
    const Rd = p.diameterMm / 2;
    const t = p.thicknessMm / 2;
    const disc = mesh(
      own.shared(
        `cap:disc:${Rd}:${t}`,
        () =>
          new THREE.LatheGeometry(
            (
              [
                [0.001, -t],
                [Rd * 0.6, -t * 0.97],
                [Rd * 0.88, -t * 0.82],
                [Rd, -t * 0.35],
                [Rd, t * 0.35],
                [Rd * 0.88, t * 0.82],
                [Rd * 0.6, t * 0.97],
                [0.001, t],
              ] as [number, number][]
            ).map(([r, y]) => new THREE.Vector2(r, y)),
            40,
          ),
      ),
      own.sharedMat(
        'ceramicDisc',
        () => new THREE.MeshStandardMaterial({ color: '#c9772a', roughness: 0.45 }),
      ),
      [0, y0 + p.diameterMm / 2, 0],
    );
    disc.rotation.x = Math.PI / 2;
    g.add(disc);
  } else {
    // Radial electrolytic, bipolar: sleeve, silver top with the vent cross, "NP" and value printed.
    const R = p.diameterMm / 2;
    // Realism pass 2: the printed PVC sleeve over the can with its rolled-in groove near the top
    // and its rounded shoulder, the rubber seal at the base.
    const H = p.heightMm;
    g.add(
      mesh(
        own.shared(
          `cap:can:${R}:${H}`,
          () =>
            new THREE.LatheGeometry(
              (
                [
                  [R * 0.82, 0],
                  [R * 0.97, 0.12],
                  [R, 0.5],
                  [R, H - 1.4],
                  [R - 0.22, H - 1.15],
                  [R - 0.22, H - 0.95],
                  [R, H - 0.7],
                  [R, H - 0.25],
                  [R - 0.12, H - 0.02],
                  [R * 0.9, H + 0.02],
                ] as [number, number][]
              ).map(([r, y]) => new THREE.Vector2(r, y)),
              40,
            ),
        ),
        own.sharedMat(
          'capSleeve',
          () => new THREE.MeshStandardMaterial({ color: '#1a2c66', roughness: 0.3 }),
        ),
        [0, y0, 0],
      ),
    );
    g.add(cylinder(own, R * 0.8, 0.5, m.rubber, [0, y0 + 0.2, 0], 32));
    g.add(cylinder(own, R * 0.96, 0.15, m.steel, [0, y0 + p.heightMm + 0.05, 0], 32));
    const label = canvasTexture(own, 256, 256, (ctx) => {
      ctx.clearRect(0, 0, 256, 256);
      ctx.strokeStyle = '#7b8088';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(128, 50);
      ctx.lineTo(128, 206);
      ctx.moveTo(50, 128);
      ctx.lineTo(206, 128);
      ctx.stroke();
    });
    const top = new THREE.Mesh(
      own.shared(`plane:capTop:${R}`, () => new THREE.CircleGeometry(R * 0.95, 32)),
      own.mat(new THREE.MeshStandardMaterial({ map: label, transparent: true, roughness: 0.4 })),
    );
    top.rotation.x = -Math.PI / 2;
    top.position.y = y0 + p.heightMm + 0.14;
    g.add(top);
    const uF = (c.visual.farads ?? 0) * 1e6;
    const side = canvasTexture(own, 256, 256, (ctx) => {
      ctx.clearRect(0, 0, 256, 256);
      ctx.fillStyle = '#e9ecf2';
      ctx.textAlign = 'center';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText('NP', 128, 90);
      ctx.font = '38px sans-serif';
      ctx.fillText(`${Number(uF.toPrecision(3))}µF`, 128, 150);
    });
    const face = new THREE.Mesh(
      own.shared(
        `plane:capSide:${R}:${p.heightMm}`,
        () => new THREE.PlaneGeometry(R * 1.4, p.heightMm * 0.6),
      ),
      own.mat(new THREE.MeshStandardMaterial({ map: side, transparent: true, roughness: 0.5 })),
    );
    face.position.set(0, y0 + p.heightMm * 0.55, R + 0.02);
    g.add(face);
  }
  g.add(
    splayedLeads(c, own, m.lead, 0.25, [
      { terminal: 'a', from: [-p.leadSpacingMm / 2, 0], top: y0 + 0.2, knee: 0.9 },
      { terminal: 'b', from: [p.leadSpacingMm / 2, 0], top: y0 + 0.2, knee: 0.9 },
    ]),
  );
  return g;
}

const BUILDERS: Record<ModelKey, Builder> = {
  'capacitor.radial': buildCapacitor,
  'display.matrix': buildLedMatrix,
  'sensor.pir': buildPir,
  'transistor.to92': buildTo92,
  'led.rgb': buildRgbLed,
  'ldr.disc': buildPhotoresistor,
  'buzzer.can': buildBuzzer,
  'relay.cube': buildRelay,
  // High-fidelity proof set (Sprint 10): the real part form (assets/resistorAxial.ts).
  'resistor.axial': (c, m, own) => {
    const { xa, xb, openA, openB } = twoTerminals(c);
    return buildResistorHiFi(own, {
      bands: c.visual.bands,
      xa: xa + (openA ? OPEN_LEAD_GAP : 0),
      xb: xb - (openB ? OPEN_LEAD_GAP : 0),
      leadMaterial: m.lead,
    });
  },

  // DO-35 glass diode (realism pass): assets/diodeDo35.ts; the leads as every axial part's.
  'diode.axial': (c, m, own) => {
    const p = DIODE_DO35;
    const g = buildDo35(own, p.standoffMm + p.bodyDiameterMm / 2, m.lead);
    g.add(axialLeads(c, p, m, own));
    return g;
  },

  // High-fidelity proof set (Sprint 10): the real part form; legs at the real pitch are its
  // anchors (assets/led5mm.ts, scene.ts).
  'led.radial': (c, m, own) => {
    const look = c.visual.led ?? { color: '#e53935', package: 't1_34' as const, clear: false };
    const { group, lens, die, core, top, gain } = buildLedHiFi(
      own,
      look.package,
      LED_PACKAGES[look.package],
      look,
      { lead: m.lead, frame: m.lead },
    );
    group.userData.lensMaterial = lens;
    group.userData.ledDie = die;
    group.userData.ledCore = core;
    group.userData.ledGain = gain;
    group.userData.ledTop = top;
    group.userData.ledColor = look.color;
    return group;
  },

  // Realism pass: assets/benchParts.ts (switches, supply, ground).
  'switch.tactile': (c, m, own) => {
    const { xa, xb, openA, openB } = twoTerminals(c);
    return buildTactile(own, m, xa + (openA ? OPEN_LEAD_GAP : 0), xb - (openB ? OPEN_LEAD_GAP : 0));
  },

  'switch.toggle': (c, m, own) => {
    const { xa, xb, openA, openB } = twoTerminals(c);
    return buildToggle(
      own,
      m,
      xa + (openA ? OPEN_LEAD_GAP : 0),
      xb - (openB ? OPEN_LEAD_GAP : 0),
      c.visual.closed === true,
    );
  },

  'ground.post': (c, m, own) => {
    const t = CATALOG[c.type].terminals[0]!;
    return buildGround(own, m, t.offset.x * SCALE, t.offset.y * SCALE);
  },

  'instrument.psu': (c, m, own) =>
    buildPsu(
      own,
      m,
      CATALOG[c.type].terminals.map((t) => ({
        id: t.id,
        x: t.offset.x * SCALE,
        z: t.offset.y * SCALE,
      })),
      { volts: c.visual.psu?.volts, amps: c.visual.psu?.amps },
    ),

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

/**
 * ESP32-DevKitC V4: the high-fidelity glTF asset (Sprint 10) when it is loaded; otherwise this
 * procedural board (Sprint 9/10) at its real size (physical.ts, [ESP-DIM]).
 */
function buildEsp32(c: SceneComponent, m: Materials, own: OwnedResources): THREE.Object3D {
  const asset = buildEsp32Asset(own, c.visual.wiredPins ?? []);
  if (asset) return asset;
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
    const h = buildDupont(own, d.dupontSizeMm, d.dupontHeightMm, dupontMaterials(own));
    h.position.set(Math.sign(local.x) * rowX, top + d.dupontSeatMm, realPinZ(pin.position));
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
