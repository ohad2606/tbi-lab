/**
 * Switches, the bench supply and the ground post (Sprint 10 realism pass). Procedural, original
 * geometry at the dimensions in physical.ts; each builder works in the part's local frame and ends
 * every lead exactly at its terminal's attach point (scene.ts), as before.
 *
 * - 6 x 6 mm tactile switch: moulded base, stamped steel cover whose four tabs clamp down the base's
 *   sides, the cover's raised boss and a chamfered round actuator, four flat legs [TACT].
 * - Sub-miniature toggle switch: phenolic base inside a plated steel frame, threaded bushing with
 *   its hex nut and keyed lock washer, a tapered lever with a rounded tip (in the persisted
 *   position), flat solder lugs [TOGGLE].
 * - Bench supply (REDUCED, SYMBOLIC scale, an intentional exception; physical.ts PSU): powder-coated
 *   case with vents and rubber feet, a dark front panel with its legend, two recessed LCD windows
 *   showing the design setpoints, knurled knobs, red/black binding posts.
 * - Ground: a black binding post on a small plated base plate engraved with the ground symbol,
 *   its tinned lug reaching the terminal; an abstract reference point, not an earth rod.
 * [TACT] [TOGGLE]: representative dimensions of the part class [REP] (physical.ts).
 */
import * as THREE from 'three';
import { PSU, TACTILE, TOGGLE, GROUND_POST, LEAD_ATTACH_HEIGHT } from '../physical.js';
import { OwnedResources, drawTexture, canvasTexture, mesh, tube, type V3 } from '../kit.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { strokeText } from './strokeFont.js';

export interface PartMaterials {
  lead: THREE.Material;
  chrome: THREE.Material;
  steel: THREE.Material;
  blackPlastic: THREE.Material;
  darkPlastic: THREE.Material;
  psuCase: THREE.Material;
  psuPanel: THREE.Material;
  red: THREE.Material;
  black: THREE.Material;
  rubber: THREE.Material;
}

const lathe = (own: OwnedResources, key: string, profile: [number, number][], seg = 32) =>
  own.shared(
    `lathe:${key}`,
    () =>
      new THREE.LatheGeometry(
        profile.map(([r, y]) => new THREE.Vector2(r, y)),
        seg,
      ),
  );
const rbox = (own: OwnedResources, w: number, h: number, d: number, r: number, seg = 2) =>
  own.shared(`rbox:${w}:${h}:${d}:${r}:${seg}`, () => new RoundedBoxGeometry(w, h, d, seg, r));
const boxGeo = (own: OwnedResources, w: number, h: number, d: number) =>
  own.shared(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));

// ---------------------------------------------------------------------------------------------

/** 6 x 6 mm tactile switch; `xa`/`xb`: the leg ends (terminal a's two legs at -x, b's at +x). */
export function buildTactile(own: OwnedResources, m: PartMaterials, xa: number, xb: number) {
  const p = TACTILE;
  const g = new THREE.Group();
  const y0 = p.standoffMm;
  const baseH = p.bodyHeightMm - 0.35;
  g.add(mesh(rbox(own, p.bodyMm, baseH, p.bodyMm, 0.25), m.blackPlastic, [0, y0 + baseH / 2, 0]));
  // The stamped cover: plate, raised boss round the actuator, and the four clamping tabs.
  const coverY = y0 + baseH + 0.12;
  g.add(mesh(rbox(own, p.bodyMm + 0.1, 0.24, p.bodyMm + 0.1, 0.1, 1), m.steel, [0, coverY, 0]));
  g.add(
    mesh(
      lathe(own, 'tact:boss', [
        [1.85, 0],
        [2.35, 0],
        [2.25, 0.18],
        [1.85, 0.22],
      ]),
      m.steel,
      [0, coverY + 0.1, 0],
    ),
  );
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const tab = mesh(boxGeo(own, 0.22, 2.2, 1.4), m.steel, [
        sx * (p.bodyMm / 2 + 0.11),
        coverY - 1.1,
        sz * 1.6,
      ]);
      g.add(tab);
    }
  // The actuator: a round stem with a chamfered top, dark moulded.
  const a = p.actuatorDiameterMm / 2;
  g.add(
    mesh(
      lathe(own, 'tact:actuator', [
        [a, 0],
        [a, p.actuatorHeightMm - 0.35],
        [a - 0.05, p.actuatorHeightMm - 0.2],
        [a - 0.35, p.actuatorHeightMm + 0.05],
        [0.001, p.actuatorHeightMm + 0.05],
      ]),
      m.darkPlastic,
      [0, coverY + 0.12, 0],
    ),
  );
  // Four flat legs, out of the base's underside, kinked, along the bench to the terminals.
  const legs = (sx: -1 | 1, end: number) => {
    for (const sz of [-1, 1]) {
      const z = sz * (p.legPitchZMm / 2);
      const x0 = sx * (p.legPitchXMm / 2);
      const leg = tube(
        own,
        [
          [x0, y0 + 0.3, z],
          [x0, 0.9, z],
          [end, 0.9, z],
          [end, LEAD_ATTACH_HEIGHT - 0.3, z],
        ],
        p.legWidthMm / 2,
        m.lead,
        0.5,
        8,
      );
      leg.scale.set(1, 1, 1);
      g.add(leg);
    }
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
  legs(-1, xa);
  legs(1, xb);
  return g;
}

// ---------------------------------------------------------------------------------------------

/** Sub-miniature SPST toggle switch; lever towards -x when closed (the persisted position). */
export function buildToggle(
  own: OwnedResources,
  m: PartMaterials,
  xa: number,
  xb: number,
  closed: boolean,
) {
  const p = TOGGLE;
  const g = new THREE.Group();
  const y0 = p.standoffMm;
  // Base (phenolic, dark) and the plated steel frame round its upper part.
  g.add(
    mesh(rbox(own, p.bodyXMm - 0.3, p.bodyHeightMm, p.bodyZMm - 0.3, 0.3), m.darkPlastic, [
      0,
      y0 + p.bodyHeightMm / 2,
      0,
    ]),
  );
  const frameH = p.bodyHeightMm * 0.55;
  g.add(
    mesh(rbox(own, p.bodyXMm, frameH, p.bodyZMm, 0.15, 1), m.steel, [
      0,
      y0 + p.bodyHeightMm - frameH / 2,
      0,
    ]),
  );
  const top = y0 + p.bodyHeightMm;
  // Threaded bushing (1/4-40 class): a sawtooth profile.
  const R = p.bushingDiameterMm / 2;
  const thread: [number, number][] = [[R - 0.2, 0]];
  const pitch = 0.6;
  for (let y = 0.4; y < p.bushingHeightMm - 0.3; y += pitch)
    thread.push([R, y], [R - 0.22, y + pitch / 2]);
  thread.push(
    [R - 0.2, p.bushingHeightMm],
    [R - 0.9, p.bushingHeightMm],
    [R - 0.9, p.bushingHeightMm - 0.4],
  );
  g.add(mesh(lathe(own, 'toggle:bushing', thread, 28), m.chrome, [0, top, 0]));
  // Keyed lock washer, then the hex nut (chamfered).
  g.add(
    mesh(
      lathe(own, 'toggle:washer', [
        [R - 0.1, 0],
        [R + 1.4, 0],
        [R + 1.4, 0.3],
        [R - 0.1, 0.3],
      ]),
      m.steel,
      [0, top + 0.05, 0],
    ),
  );
  const nut = own.shared('toggle:nut', () => {
    const geo = new THREE.CylinderGeometry(R + 1.05, R + 1.05, 1.1, 6, 1);
    // Chamfer the corners: pull the top and bottom rings' vertices in a little.
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(Math.abs(pos.getY(i)) - 0.55) < 1e-6) {
        const k = 0.92;
        pos.setX(i, pos.getX(i) * k);
        pos.setZ(i, pos.getZ(i) * k);
      }
    }
    geo.computeVertexNormals();
    return geo;
  });
  g.add(mesh(nut, m.steel, [0, top + 0.95, 0]));
  // The lever: tapered round stem with a rounded tip, pivoting at the bushing's top.
  const L = p.leverLengthMm;
  const lever = mesh(
    lathe(
      own,
      'toggle:lever',
      [
        [0.001, 0],
        [0.95, 0],
        [0.8, 0.6],
        [0.62, L - 1.4],
        [0.82, L - 0.9],
        [0.9, L - 0.45],
        [0.75, L - 0.1],
        [0.001, L],
      ],
      20,
    ),
    m.chrome,
  );
  const tilt = closed ? -0.38 : 0.38;
  lever.position.set(0, top + p.bushingHeightMm - 0.6, 0);
  lever.rotation.z = tilt;
  lever.userData.lever = closed ? 'closed' : 'open';
  g.add(lever);
  // Solder lugs under the base, and the leads from them to the terminals.
  for (const [sx, end] of [
    [-1, xa],
    [1, xb],
  ] as const) {
    g.add(mesh(boxGeo(own, 1.6, y0 + 0.6, 0.35), m.lead, [sx * 2.54, (y0 + 0.6) / 2 + 0.15, 0]));
    g.add(
      tube(
        own,
        [
          [sx * 2.54, 0.9, 0],
          [end, 0.9, 0],
          [end, LEAD_ATTACH_HEIGHT - 0.3, 0],
        ],
        0.4,
        m.lead,
        0.5,
      ),
    );
  }
  return g;
}

// ---------------------------------------------------------------------------------------------

/** A binding post along +X from x0: hex base, threaded body with the cross hole, knurled cap. */
function bindingPost(own: OwnedResources, cap: THREE.Material, metal: THREE.Material, len: number) {
  const g = new THREE.Group();
  const base = mesh(
    own.shared('post:hex', () =>
      new THREE.CylinderGeometry(1.3, 1.3, 0.6, 6).rotateZ(-Math.PI / 2),
    ),
    metal,
    [0.3, 0, 0],
  );
  g.add(base);
  const stud = mesh(
    own.shared(`post:stud:${len}`, () =>
      new THREE.CylinderGeometry(0.75, 0.75, len, 16).rotateZ(-Math.PI / 2),
    ),
    metal,
    [0.6 + len / 2, 0, 0],
  );
  g.add(stud);
  // The cap: a knurled cylinder with a domed end (the ridges as a lathe would not do: 24 flutes).
  const capGeo = own.shared('post:cap', () => {
    const geo = new THREE.CylinderGeometry(1.15, 1.15, 1.6, 24, 1);
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      const r = 1.15 * (1 - 0.04 * (Math.cos(a * 24) > 0 ? 1 : 0));
      const k = r / Math.hypot(pos.getX(i), pos.getZ(i) || 1e-9);
      if (Math.hypot(pos.getX(i), pos.getZ(i)) > 0.5) {
        pos.setX(i, pos.getX(i) * k);
        pos.setZ(i, pos.getZ(i) * k);
      }
    }
    geo.computeVertexNormals();
    return geo.rotateZ(-Math.PI / 2);
  });
  g.add(mesh(capGeo, cap, [0.6 + len - 0.8, 0, 0]));
  const dome = mesh(
    own.shared('post:dome', () =>
      new THREE.SphereGeometry(1.15, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2)
        .rotateZ(-Math.PI / 2)
        .scale(0.35, 1, 1),
    ),
    cap,
    [0.6 + len, 0, 0],
  );
  g.add(dome);
  return g;
}

/** The supply's front-panel legend (no project values), one texture per viewer. */
function panelLegend(own: OwnedResources) {
  return own.lasting('psu:panel', () =>
    drawTexture(512, 466, (ctx) => {
      ctx.fillStyle = '#22262c';
      ctx.fillRect(0, 0, 512, 466);
      ctx.strokeStyle = '#d9dcdf';
      ctx.fillStyle = '#d9dcdf';
      // Panel frame line and legend (canvas x = panel z, canvas y = down the panel).
      ctx.lineWidth = 3;
      ctx.strokeRect(14, 14, 484, 438);
      strokeText(ctx, 'DC POWER SUPPLY', 256, 46, { height: 22, align: 'center', weight: 0.14 });
      strokeText(ctx, 'VOLTAGE', 140, 220, { height: 16, align: 'center', weight: 0.14 });
      strokeText(ctx, 'CURRENT', 372, 220, { height: 16, align: 'center', weight: 0.14 });
      strokeText(ctx, 'V', 238, 128, { height: 20, align: 'center', weight: 0.15 });
      strokeText(ctx, 'A', 470, 128, { height: 20, align: 'center', weight: 0.15 });
      // The panel is seen from +x: canvas left is world +z (the - post), right is -z (+).
      ctx.fillStyle = '#c4161c';
      ctx.fillRect(342, 392, 60, 6);
      strokeText(ctx, '+', 372, 420, { height: 22, align: 'center', weight: 0.16 });
      ctx.fillStyle = '#d9dcdf';
      strokeText(ctx, '-', 140, 420, { height: 22, align: 'center', weight: 0.16 });
      strokeText(ctx, 'OUTPUT', 256, 420, { height: 14, align: 'center', weight: 0.14 });
    }),
  );
}

/**
 * Bench supply at reduced, symbolic scale. `terminals`: its posts' attach points (local x, z);
 * `volts`/`amps`: the design setpoints shown on its displays.
 */
export function buildPsu(
  own: OwnedResources,
  m: PartMaterials,
  terminals: { id: string; x: number; z: number }[],
  setpoint: { volts?: number; amps?: number },
) {
  const p = PSU;
  const g = new THREE.Group();
  const cx = p.frontXMm - p.bodyXMm / 2;
  const footH = 0.6;
  const H = p.bodyHeightMm - footH;
  g.add(mesh(rbox(own, p.bodyXMm, H, p.bodyZMm, 0.7, 3), m.psuCase, [cx, footH + H / 2, 0]));
  // Front bezel (the panel's frame) and the panel with its legend.
  g.add(
    mesh(rbox(own, 0.7, H - 0.4, p.bodyZMm - 0.4, 0.25, 2), m.darkPlastic, [
      p.frontXMm - 0.1,
      footH + H / 2,
      0,
    ]),
  );
  const panel = new THREE.Mesh(
    own.shared('psu:panelPlane', () => new THREE.PlaneGeometry(p.bodyZMm - 1.4, H - 1.4)),
    own.lastingMat(
      'psu:panel',
      () => new THREE.MeshStandardMaterial({ map: panelLegend(own), roughness: 0.5 }),
    ),
  );
  panel.rotation.y = Math.PI / 2;
  panel.position.set(p.frontXMm + 0.26, footH + H / 2, 0);
  g.add(panel);
  // Vents on the top: a row of slots.
  for (let i = 0; i < 6; i++)
    g.add(
      mesh(boxGeo(own, 0.5, 0.06, p.bodyZMm * 0.55), m.rubber, [
        cx - p.bodyXMm * 0.28 + i * 0.9,
        footH + H + 0.005,
        0,
      ]),
    );
  // Rubber feet.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      g.add(
        mesh(
          own.shared('psu:foot', () => new THREE.CylinderGeometry(0.9, 1.0, footH, 16)),
          m.rubber,
          [cx + sx * (p.bodyXMm / 2 - 1.4), footH / 2, sz * (p.bodyZMm / 2 - 1.4)],
        ),
      );
  // LCD windows: recessed dark glass, the setpoint digits lit.
  const lcd = (text: string, color: string) =>
    canvasTexture(own, 256, 96, (ctx) => {
      ctx.fillStyle = '#0b0f0d';
      ctx.fillRect(0, 0, 256, 96);
      ctx.strokeStyle = color;
      strokeText(ctx, text, 128, 50, { height: 54, align: 'center', weight: 0.16 });
    });
  const displays: [string, number, string][] = [
    // VOLTAGE on the left of the panel (+z seen from the front), CURRENT on the right.
    [setpoint.volts !== undefined ? setpoint.volts.toFixed(2) : '0.00', 2.75, '#62ff8e'],
    [setpoint.amps !== undefined ? setpoint.amps.toFixed(3) : '0.000', -2.75, '#ff7a55'],
  ];
  for (const [text, z, color] of displays) {
    const tex = lcd(text, color);
    const win = new THREE.Mesh(
      own.shared('psu:lcd', () => new THREE.PlaneGeometry(4.4, 1.7)),
      own.mat(
        own.tier === 'full'
          ? new THREE.MeshPhysicalMaterial({
              map: tex,
              emissiveMap: tex,
              emissive: '#ffffff',
              emissiveIntensity: 0.9,
              roughness: 0.15,
              clearcoat: 1,
              clearcoatRoughness: 0.05,
            })
          : // Reduced tier: the plain textured variant (one shader program fewer).
            new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3 }),
      ),
    );
    win.rotation.y = Math.PI / 2;
    win.position.set(p.frontXMm + 0.33, footH + H - 2.6, z);
    g.add(win);
    // The window's bezel.
    g.add(
      mesh(rbox(own, 0.12, 2.1, 4.8, 0.05, 1), m.black, [p.frontXMm + 0.24, footH + H - 2.6, z]),
    );
  }
  // Knurled knobs with their pointer lines.
  for (const z of [-2.75, 2.75]) {
    const knob = mesh(
      own.shared('psu:knob', () => {
        const geo = new THREE.CylinderGeometry(1.0, 1.1, 1.1, 28, 1);
        const pos = geo.attributes.position!;
        for (let i = 0; i < pos.count; i++) {
          const a = Math.atan2(pos.getZ(i), pos.getX(i));
          if (Math.hypot(pos.getX(i), pos.getZ(i)) > 0.5 && Math.cos(a * 14) > 0.3) {
            pos.setX(i, pos.getX(i) * 0.95);
            pos.setZ(i, pos.getZ(i) * 0.95);
          }
        }
        geo.computeVertexNormals();
        return geo.rotateZ(-Math.PI / 2);
      }),
      m.black,
      [p.frontXMm + 0.85, footH + H - 5.4, z],
    );
    g.add(knob);
    g.add(mesh(boxGeo(own, 0.05, 0.6, 0.12), m.chrome, [p.frontXMm + 1.41, footH + H - 5.15, z]));
  }
  // Binding posts at the terminals (red +, black -).
  for (const t of terminals) {
    const len = Math.max(1.2, t.x - p.frontXMm - 1.0);
    const post = bindingPost(own, t.id === 'positive' ? m.red : m.black, m.chrome, len);
    post.position.set(p.frontXMm + 0.3, p.attachHeightMm, t.z);
    post.userData.polarity = t.id;
    g.add(post);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------

/** The ground plate's engraving (the earth/ground symbol and GND), once per viewer. */
function groundPlate(own: OwnedResources) {
  return own.lasting('ground:plate', () =>
    drawTexture(128, 128, (ctx) => {
      ctx.fillStyle = '#c6cacd';
      ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = '#3a3e43';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      // The symbol, beside the post (the post stands in the plate's centre).
      const x = 26;
      ctx.beginPath();
      ctx.moveTo(x, 70);
      ctx.lineTo(x, 88);
      for (const [w, y] of [
        [16, 88],
        [10, 98],
        [4, 108],
      ] as const) {
        ctx.moveTo(x - w, y);
        ctx.lineTo(x + w, y);
      }
      ctx.stroke();
      strokeText(ctx, 'GND', 98, 100, {
        height: 16,
        align: 'center',
        weight: 0.18,
        rotate: -Math.PI / 2,
      });
    }),
  );
}

/** Ground: a black binding post on a plated plate, behind its terminal; the lug reaches it. */
export function buildGround(own: OwnedResources, m: PartMaterials, x: number, z: number) {
  const p = GROUND_POST;
  const g = new THREE.Group();
  const pz = z + p.postOffsetZMm;
  const plate = new THREE.Mesh(
    rbox(own, p.plateMm, p.plateThicknessMm, p.plateMm, 0.2, 1),
    own.lastingMat(
      'ground:plate',
      () =>
        new THREE.MeshStandardMaterial({ map: groundPlate(own), metalness: 1, roughness: 0.32 }),
    ),
  );
  plate.position.set(x, p.plateThicknessMm / 2, pz);
  plate.castShadow = plate.receiveShadow = true;
  g.add(plate);
  const y0 = p.plateThicknessMm;
  // The post: the same binding post as the supply's, standing up (black: the reference).
  const post = bindingPost(own, m.black, m.chrome, p.postHeightMm - 1.6);
  post.rotation.z = Math.PI / 2;
  post.position.set(x, y0 - 0.3, pz);
  g.add(post);
  // The lug: a flat tinned strip from the post's foot to a ring at the terminal.
  g.add(
    mesh(boxGeo(own, 1.2, 0.3, p.postOffsetZMm), m.lead, [
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
}

export type { V3 };
