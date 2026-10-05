/**
 * Procedural, simplified 3D models (Sprint 9, D-S9-3). One builder per model key; each builds a
 * group in the part's LOCAL frame (origin = the component's layout origin, +X = the layout's
 * x axis at rotation 0, +Z = the layout's y axis, +Y up) whose leads end exactly at the
 * component's terminals (the catalog terminal offsets × SCALE).
 *
 * Clarity over realism: recognisable shapes and colours, correct orientation (LED/diode cathode,
 * supply polarity), no textures loaded from anywhere. A later, more detailed model replaces one
 * builder here; neither the scene description nor the project schema changes.
 */

import * as THREE from 'three';
import { CATALOG, ESP32_DEVKITC_WROOM32, boardPinPosition, boardTerminalId } from '@tbi-lab/domain';
import { SCALE, TERMINAL_HEIGHT, type ModelKey, type SceneComponent } from './scene.js';

export type Materials = ReturnType<typeof createMaterials>;

/** Shared materials of one viewer (disposed with it). */
export function createMaterials() {
  const std = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...extra });
  return {
    lead: std('#b8bec6', { metalness: 0.7, roughness: 0.35 }),
    gold: std('#c9a227', { metalness: 0.75, roughness: 0.3 }),
    pcb: std('#1f2a38', { roughness: 0.8 }),
    shield: std('#c7ccd2', { metalness: 0.65, roughness: 0.35 }),
    black: std('#25282c', { roughness: 0.5 }),
    resistorBody: std('#d8c39b', { roughness: 0.7 }),
    diodeBody: std('#2a2b2e', { roughness: 0.45 }),
    silver: std('#d7dade', { metalness: 0.5, roughness: 0.4 }),
    psuBody: std('#9aa3ad', { roughness: 0.55 }),
    psuPanel: std('#2f3742', { roughness: 0.6 }),
    display: std('#143d27', { emissive: '#1e7a3e', emissiveIntensity: 0.6 }),
    red: std('#c62828'),
    generic: std('#8d97a3'),
    buttonCap: std('#8a1c1c', { roughness: 0.5 }),
    usb: std('#aeb4bb', { metalness: 0.6, roughness: 0.35 }),
  };
}

const BAND_COLORS: Record<string, string> = {
  black: '#111111',
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

/** Per-build resources (geometries, one-off materials) the viewer disposes on rebuild. */
export class OwnedResources {
  readonly geometries: THREE.BufferGeometry[] = [];
  private readonly cache = new Map<string, THREE.BufferGeometry>();
  /** One shared geometry per shape key (pins, leads and wire segments reuse a handful). */
  shared<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
    let g = this.cache.get(key) as T | undefined;
    if (!g) {
      g = this.geo(make());
      this.cache.set(key, g);
    }
    return g;
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
  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.cache.clear();
    this.materials.length = 0;
    this.textures.length = 0;
  }
}

const S = SCALE;

function box(own: OwnedResources, w: number, h: number, d: number, mat: THREE.Material) {
  return new THREE.Mesh(
    own.shared(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)),
    mat,
  );
}

/** A cylinder of radius `r` from `a` to `b` (a shared unit cylinder, scaled). */
export function segment(
  own: OwnedResources,
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
  mat: THREE.Material,
  radial = 8,
): THREE.Mesh | null {
  const len = a.distanceTo(b);
  if (len < 1e-6) return null;
  const geo = own.shared(`seg:${r}:${radial}`, () => new THREE.CylinderGeometry(r, r, 1, radial));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.y = len;
  mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return mesh;
}

/** A cylinder along local X, centred at the origin. */
function rodX(own: OwnedResources, r: number, len: number, mat: THREE.Material, seg = 16) {
  const mesh = new THREE.Mesh(own.geo(new THREE.CylinderGeometry(r, r, len, seg)), mat);
  mesh.rotation.z = Math.PI / 2;
  return mesh;
}

/** A thin lead through the given local points (straight segments). */
function lead(own: OwnedResources, pts: [number, number, number][], mat: THREE.Material, r = 0.07) {
  const group = new THREE.Group();
  for (let i = 1; i < pts.length; i++) {
    const seg = segment(
      own,
      new THREE.Vector3(...pts[i - 1]!),
      new THREE.Vector3(...pts[i]!),
      r,
      mat,
    );
    if (seg) group.add(seg);
  }
  return group;
}

/**
 * How far a lead stops short of a terminal that another part's terminal touches WITHOUT a
 * connection (scene.ts `open`): the two lead ends then show a visible gap instead of meeting.
 */
export const OPEN_LEAD_GAP = 0.45;
const isOpen = (c: SceneComponent, id: string) => c.terminals.some((t) => t.id === id && t.open);

/** Two-terminal parts: where the leads end at rotation 0 (local x, scene units). */
function ends(c: SceneComponent): [number, number] {
  const [a, b] = CATALOG[c.type].terminals;
  return [
    a!.offset.x * S + (isOpen(c, a!.id) ? OPEN_LEAD_GAP : 0),
    b!.offset.x * S - (isOpen(c, b!.id) ? OPEN_LEAD_GAP : 0),
  ];
}

/** Axial body with leads bent down to both terminals. */
function axial(
  c: SceneComponent,
  m: Materials,
  own: OwnedResources,
  body: THREE.Material,
  radius: number,
  length: number,
): THREE.Group {
  const g = new THREE.Group();
  const [xa, xb] = ends(c);
  const h = 0.85;
  const tube = rodX(own, radius, length, body, 20);
  tube.position.y = h;
  g.add(tube);
  const y0 = TERMINAL_HEIGHT[c.model];
  g.add(
    lead(
      own,
      [
        [-length / 2, h, 0],
        [xa + 0.4, h, 0],
        [xa, h - 0.4, 0],
        [xa, y0, 0],
      ],
      m.lead,
    ),
  );
  g.add(
    lead(
      own,
      [
        [length / 2, h, 0],
        [xb - 0.4, h, 0],
        [xb, h - 0.4, 0],
        [xb, y0, 0],
      ],
      m.lead,
    ),
  );
  return g;
}

const BUILDERS: Record<ModelKey, Builder> = {
  'resistor.axial': (c, m, own) => {
    const g = axial(c, m, own, m.resistorBody, 0.6, 3.6);
    const bands = c.visual.bands;
    if (bands) {
      const xs = bands.length === 4 ? [-1.1, -0.6, -0.1, 1.1] : [-1.2, -0.8, -0.4, 0.0, 1.2];
      bands.forEach((b, i) => {
        const mat = own.mat(
          new THREE.MeshStandardMaterial({ color: BAND_COLORS[b] ?? '#000', roughness: 0.6 }),
        );
        const ring = rodX(own, 0.62, 0.22, mat, 20);
        ring.position.set(xs[i]!, 0.85, 0);
        ring.userData.band = b;
        g.add(ring);
      });
    }
    return g;
  },
  'diode.axial': (c, m, own) => {
    const g = axial(c, m, own, m.diodeBody, 0.42, 2.8);
    // Cathode band on the cathode (second terminal) side.
    const band = rodX(own, 0.44, 0.3, m.silver, 20);
    band.position.set(1.0, 0.85, 0);
    band.userData.cathodeBand = true;
    g.add(band);
    return g;
  },
  'led.5mm': (c, m, own) => {
    const g = new THREE.Group();
    const [xa, xb] = ends(c);
    const lens = own.mat(
      new THREE.MeshStandardMaterial({
        color: c.visual.ledColor ?? '#e53935',
        roughness: 0.25,
        transparent: true,
        opacity: 0.85,
      }),
    );
    const base = 1.4;
    const rim = new THREE.Mesh(own.geo(new THREE.CylinderGeometry(1.15, 1.15, 0.25, 32)), lens);
    rim.position.y = base + 0.125;
    const body = new THREE.Mesh(own.geo(new THREE.CylinderGeometry(1.0, 1.0, 1.4, 32)), lens);
    body.position.y = base + 0.25 + 0.7;
    const dome = new THREE.Mesh(
      own.geo(new THREE.SphereGeometry(1.0, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2)),
      lens,
    );
    dome.position.y = base + 0.25 + 1.4;
    dome.userData.lens = true;
    g.userData.lensMaterial = lens;
    g.add(rim, body, dome);
    const y0 = TERMINAL_HEIGHT[c.model];
    // Anode leg (longer, as on the real part) to the anode terminal; cathode leg to the other.
    g.add(
      lead(
        own,
        [
          [-0.25, base, 0],
          [-0.25, 0.7, 0],
          [xa + 0.4, 0.7, 0],
          [xa, 0.4, 0],
          [xa, y0, 0],
        ],
        m.lead,
      ),
    );
    g.add(
      lead(
        own,
        [
          [0.25, base, 0],
          [0.25, 0.6, 0],
          [xb - 0.4, 0.6, 0],
          [xb, 0.35, 0],
          [xb, y0, 0],
        ],
        m.lead,
      ),
    );
    return g;
  },
  'switch.tactile': (c, m, own) => {
    const g = new THREE.Group();
    const [xa, xb] = ends(c);
    const body = box(own, 3.4, 1.1, 3.4, m.black);
    body.position.y = 0.55 + 0.2;
    const cap = new THREE.Mesh(own.geo(new THREE.CylinderGeometry(1.0, 1.0, 0.7, 24)), m.buttonCap);
    cap.position.y = 0.2 + 1.1 + 0.35;
    g.add(body, cap);
    const y0 = TERMINAL_HEIGHT[c.model];
    g.add(
      lead(
        own,
        [
          [-1.2, 0.35, 0],
          [xa, 0.35, 0],
          [xa, y0, 0],
        ],
        m.lead,
      ),
    );
    g.add(
      lead(
        own,
        [
          [1.2, 0.35, 0],
          [xb, 0.35, 0],
          [xb, y0, 0],
        ],
        m.lead,
      ),
    );
    return g;
  },
  'switch.toggle': (c, m, own) => {
    const g = new THREE.Group();
    const [xa, xb] = ends(c);
    const body = box(own, 3.0, 1.1, 1.6, m.black);
    body.position.y = 0.2 + 0.55;
    const bushing = new THREE.Mesh(
      own.geo(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 16)),
      m.silver,
    );
    bushing.position.y = 1.45;
    const lever = new THREE.Mesh(
      own.geo(new THREE.CylinderGeometry(0.12, 0.16, 1.2, 12)),
      m.silver,
    );
    // The lever leans toward the closed side when the (persisted) position is closed.
    const tilt = c.visual.closed ? -0.45 : 0.45;
    lever.position.set(Math.sin(-tilt) * 0.6, 1.55 + Math.cos(tilt) * 0.6, 0);
    lever.rotation.z = tilt;
    lever.userData.lever = c.visual.closed ? 'closed' : 'open';
    g.add(body, bushing, lever);
    const y0 = TERMINAL_HEIGHT[c.model];
    g.add(
      lead(
        own,
        [
          [-1.5, 0.35, 0],
          [xa, 0.35, 0],
          [xa, y0, 0],
        ],
        m.lead,
      ),
    );
    g.add(
      lead(
        own,
        [
          [1.5, 0.35, 0],
          [xb, 0.35, 0],
          [xb, y0, 0],
        ],
        m.lead,
      ),
    );
    return g;
  },
  'ground.post': (c, m, own) => {
    // A ground binding post at the terminal (the reference connection point).
    const g = new THREE.Group();
    const t = CATALOG[c.type].terminals[0]!;
    const post = new THREE.Mesh(own.geo(new THREE.CylinderGeometry(0.45, 0.55, 0.9, 20)), m.black);
    post.position.set(t.offset.x * S, 0.45, t.offset.y * S);
    const plate = box(own, 1.6, 0.12, 1.6, m.silver);
    plate.position.set(t.offset.x * S, 0.06, t.offset.y * S);
    g.add(plate, post);
    return g;
  },
  'instrument.psu': (c, m, own) => {
    // A bench supply: body, front panel with a display, and two binding posts at the terminals
    // (positive red, negative black).
    const g = new THREE.Group();
    const body = box(own, 6, 3.6, 8, m.psuBody);
    body.position.set(-1, 1.8, 0);
    const panel = box(own, 0.12, 3.2, 7.4, m.psuPanel);
    panel.position.set(2.06, 1.8, 0);
    const display = box(own, 0.1, 0.9, 3.2, m.display);
    display.position.set(2.14, 2.6, -1.2);
    g.add(body, panel, display);
    for (const t of CATALOG[c.type].terminals) {
      const post = new THREE.Mesh(
        own.geo(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 16)),
        t.id === 'positive' ? m.red : m.black,
      );
      post.rotation.z = Math.PI / 2;
      post.position.set(t.offset.x * S - 1.6, TERMINAL_HEIGHT[c.model], t.offset.y * S);
      post.userData.polarity = t.id;
      g.add(post);
      g.add(
        lead(
          own,
          [
            [t.offset.x * S - 1.2, TERMINAL_HEIGHT[c.model], t.offset.y * S],
            [
              t.offset.x * S - (isOpen(c, t.id) ? OPEN_LEAD_GAP : 0),
              TERMINAL_HEIGHT[c.model],
              t.offset.y * S,
            ],
          ],
          m.lead,
          0.09,
        ),
      );
    }
    return g;
  },
  'board.esp32_devkitc': (c, m, own) => {
    // ESP32 DevKitC on short stand-offs: PCB, the WROOM-32 module can with its antenna area,
    // micro-USB, EN/BOOT buttons and a header pin at every header position. Connectable pins run
    // out to their terminal (as in the circuit view); the others are plain header pins.
    const g = new THREE.Group();
    const lift = 0.6;
    const pcb = box(own, 12, 0.16, 39.2, m.pcb);
    pcb.position.y = lift;
    const module = box(own, 5.6, 0.5, 8, m.shield);
    module.position.set(0, lift + 0.33, -14.6);
    const antenna = box(own, 5.6, 0.06, 2.6, m.pcb);
    antenna.position.set(0, lift + 0.11, -19.1 + 1.3);
    const usb = box(own, 2.4, 0.8, 1.6, m.usb);
    usb.position.set(0, lift + 0.48, 19.0);
    const en = box(own, 1.0, 0.4, 0.8, m.black);
    en.position.set(-3.6, lift + 0.28, 17.2);
    const boot = box(own, 1.0, 0.4, 0.8, m.black);
    boot.position.set(3.6, lift + 0.28, 17.2);
    g.add(pcb, module, antenna, usb, en, boot);
    for (let side = -1; side <= 1; side += 2) {
      const header = box(own, 0.8, 0.8, 38.2, m.black);
      header.position.set(side * 5.4, lift + 0.48, 0.6);
      g.add(header);
    }
    for (const pin of ESP32_DEVKITC_WROOM32.pins) {
      const p = boardPinPosition(pin);
      const side = p.x < 0 ? -1 : 1;
      const z = p.y * S;
      const top = box(own, 0.22, 0.6, 0.22, m.gold);
      top.position.set(side * 5.4, lift + 1.1, z);
      g.add(top);
      const terminal = boardTerminalId(pin);
      if (terminal)
        g.add(
          lead(
            own,
            [
              [side * 5.4, TERMINAL_HEIGHT[c.model], z],
              [
                p.x * S - (isOpen(c, terminal) ? side * OPEN_LEAD_GAP : 0),
                TERMINAL_HEIGHT[c.model],
                z,
              ],
            ],
            m.gold,
            0.08,
          ),
        );
    }
    return g;
  },
  generic: (c, m, own) => {
    const g = new THREE.Group();
    const b = box(own, 4, 1.2, 1.6, m.generic);
    b.position.y = 0.8;
    g.add(b);
    for (const t of CATALOG[c.type].terminals)
      g.add(
        lead(
          own,
          [
            [0, 0.5, 0],
            [t.offset.x * S, 0.5, t.offset.y * S],
            [t.offset.x * S, TERMINAL_HEIGHT.generic, t.offset.y * S],
          ],
          m.lead,
        ),
      );
    return g;
  },
};

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
