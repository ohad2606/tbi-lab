/**
 * Authoring source of the ESP32-DevKitC V4 visual asset (Sprint 10 high-fidelity proof set).
 *
 * Pure three.js geometry and materials, no DOM: `scripts/build-3d-assets.ts` runs this in Node and
 * exports the result as a binary glTF (`esp32-devkitc-v4.glb`), which the 3D view loads lazily.
 * The asset is AUTHORED IN THIS REPOSITORY from published dimensions; no external model geometry is
 * used (provenance and the per-feature sources: ./manifest.ts).
 *
 * Frame (the same as every 3D model, physical.ts): millimetres, origin = the board centre on the
 * bench plane, +X across the board towards header J3, +Z along it towards the USB end, +Y up. The
 * board stands on its male header pins on the bench, as on a breadboard.
 *
 * Named nodes the runtime fills in (presentation only, never product logic):
 *   `silkscreen`    a plane over the top face, UV 0..1 across the PCB: the pin labels (canvas)
 *   `module_label`  a plane on the shield can: its laser marking (canvas)
 * Everything else is final geometry. Repeated features (38 pins, 38 pads, 38 header segments, the
 * module's castellations, the passives) are merged into one mesh per material.
 */

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ESP32_DEVKITC_WROOM32, boardPinPosition } from '@tbi-lab/domain';
import { ESP32_DEVKITC as D, ESP32_PCB_BOTTOM, ESP32_PCB_TOP } from '../physical.js';

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
    // Black soldermask: a thin glossy lacquer over a dark substrate.
    mask: phys(
      { color: '#15171b', roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.25 },
      'soldermask',
    ),
    // The PCB edge: routed FR-4 (glass-epoxy core) with mask on both faces.
    fr4: phys({ color: '#3d3b30', roughness: 0.8 }, 'fr4_edge'),
    // ENIG pads (gold), tinned solder, gold-flashed header pins.
    gold: phys({ color: '#d7b25f', metalness: 1, roughness: 0.28 }, 'enig_gold'),
    solder: phys({ color: '#c9ccd0', metalness: 1, roughness: 0.22 }, 'solder'),
    pinGold: phys({ color: '#d4ad57', metalness: 1, roughness: 0.3 }, 'pin_gold'),
    // PBT header housing: matte black.
    housing: phys({ color: '#141416', roughness: 0.72 }, 'header_pbt'),
    // The module's own substrate and its RF-can (stamped nickel-silver).
    moduleBoard: phys(
      { color: '#1d2731', roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.3 },
      'module_substrate',
    ),
    can: phys({ color: '#c8ccd0', metalness: 1, roughness: 0.34 }, 'shield_can'),
    antenna: phys({ color: '#8a7a45', metalness: 0.6, roughness: 0.5 }, 'antenna_trace'),
    // Connector shell (nickel-plated), plastic tongue, IC moulding compound.
    nickel: phys({ color: '#d2d5d8', metalness: 1, roughness: 0.24 }, 'usb_shell'),
    tongue: phys({ color: '#0f0f10', roughness: 0.6 }, 'usb_tongue'),
    epoxy: phys({ color: '#1c1d20', roughness: 0.62 }, 'ic_mould'),
    tin: phys({ color: '#bfc3c7', metalness: 1, roughness: 0.3 }, 'lead_tin'),
    // Passives: ceramic capacitors (tan), thick-film resistors (black top, white base).
    ceramic: phys({ color: '#a8875a', roughness: 0.55 }, 'mlcc_ceramic'),
    resistor: phys({ color: '#18191b', roughness: 0.5 }, 'chip_resistor'),
    // Tactile switches: black body, stainless frame, dark actuator.
    switchBody: phys({ color: '#1a1a1c', roughness: 0.6 }, 'switch_body'),
    steel: phys({ color: '#b9bec3', metalness: 1, roughness: 0.32 }, 'switch_frame'),
    actuator: phys({ color: '#2a2b2e', roughness: 0.5 }, 'switch_actuator'),
    // The power LED (0805): clear epoxy over a red die.
    ledLens: phys(
      { color: '#e53935', roughness: 0.15, transparent: true, opacity: 0.85 },
      'power_led',
    ),
    // Runtime-filled planes (their maps are drawn by the 3D view).
    silk: phys(
      { color: '#ffffff', roughness: 0.6, transparent: true, opacity: 1, depthWrite: false },
      'silkscreen',
    ),
    label: phys({ color: '#ffffff', metalness: 0.6, roughness: 0.4 }, 'module_label'),
  };
}

/** A rounded rectangle in the XZ plane (as a Shape in X/Y, mapped later). */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * Merging needs matching attributes: indexed (shared vertices keep the file small), position and
 * normal only (no merged mesh is textured: only the runtime-drawn planes carry UVs), no groups.
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
  plain(g.clone()).translate(x, y, z);

function merged(name: string, parts: THREE.BufferGeometry[], m: THREE.Material): THREE.Mesh {
  const geo = mergeGeometries(parts.map(plain), false)!;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = name;
  return mesh;
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
  const zBottom = zc + D.pcbLengthMm / 2; // the USB end

  // ---- PCB: rounded outline, routed edge, mask on top ------------------------------------
  const outline = roundedRect(D.pcbWidthMm, D.pcbLengthMm, 0.6);
  const pcbGeo = new THREE.ExtrudeGeometry(outline, {
    depth: D.pcbThicknessMm,
    bevelEnabled: false,
    curveSegments: 6,
  });
  pcbGeo.rotateX(Math.PI / 2);
  pcbGeo.translate(0, yt, zc);
  // Extrude groups: 0 = the two faces (mask), 1 = the side wall (FR-4 edge).
  const pcb = new THREE.Mesh(pcbGeo, [m.mask, m.fr4]);
  pcb.name = 'pcb';
  root.add(pcb);

  // Silkscreen plane over the top, UV normalised across the PCB (u: -x..+x, v: pin 1 end..USB end).
  const silkGeo = new THREE.ShapeGeometry(outline, 6);
  silkGeo.rotateX(-Math.PI / 2); // facing up
  {
    const pos = silkGeo.attributes.position!;
    const uv = silkGeo.attributes.uv!;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(
        i,
        (pos.getX(i) + D.pcbWidthMm / 2) / D.pcbWidthMm,
        1 - (pos.getZ(i) + D.pcbLengthMm / 2) / D.pcbLengthMm,
      );
    }
  }
  silkGeo.translate(0, yt + 0.012, zc);
  const silk = new THREE.Mesh(silkGeo, m.silk);
  silk.name = 'silkscreen';
  root.add(silk);

  // ---- Header pads (ENIG rings) and solder fillets around every pin ------------------------
  const pads: THREE.BufferGeometry[] = [];
  const fillets: THREE.BufferGeometry[] = [];
  const pins: THREE.BufferGeometry[] = [];
  const segments: THREE.BufferGeometry[] = [];
  const ring = new THREE.RingGeometry(0.55, 0.95, 16).rotateX(-Math.PI / 2);
  // A soldered joint: a concave cone of solder from the pad up the pin.
  const fillet = new THREE.LatheGeometry(
    [
      [0.92, 0],
      [0.7, 0.08],
      [0.52, 0.22],
      [0.42, 0.45],
      [0.38, 0.62],
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    12,
  );
  // A square header pin with chamfered (pyramid) tips; full length from the bench to the stub.
  const pinLen = yt + D.pinStubAboveMm;
  const tip = 0.35;
  const s = D.pinSizeMm;
  const shaft = new THREE.BoxGeometry(s, pinLen - 2 * tip, s);
  const pyramid = new THREE.ConeGeometry(s / Math.SQRT2, tip, 4, 1).rotateY(Math.PI / 4);
  const pinGeo = mergeGeometries(
    [
      plain(shaft).translate(0, pinLen / 2, 0),
      plain(pyramid.clone()).translate(0, pinLen - tip / 2, 0),
      plain(pyramid.clone().rotateX(Math.PI)).translate(0, tip / 2, 0),
    ],
    false,
  )!;
  // Header housing segment: 2.54 pitch, slightly separated (the V-groove between positions).
  const seg = new RoundedBoxGeometry(2.42, D.headerPlasticHeightMm, 2.46, 1, 0.18);
  for (const pin of ESP32_DEVKITC_WROOM32.pins) {
    const x = Math.sign(boardPinPosition(pin).x) * ROW_X;
    const z = pinZ(pin.position);
    pads.push(at(ring, x, yt + 0.01, z), at(ring.clone().rotateX(Math.PI), x, yb - 0.01, z));
    fillets.push(at(fillet, x, yt, z));
    pins.push(at(pinGeo, x, 0, z));
    segments.push(at(seg, x, D.pinBelowPlasticMm + D.headerPlasticHeightMm / 2, z));
  }
  root.add(merged('header_pads', pads, m.gold));
  root.add(merged('solder_joints', fillets, m.solder));
  root.add(merged('header_pins', pins, m.pinGold));
  root.add(merged('header_housing', segments, m.housing));

  // ---- ESP32-WROOM-32 module ---------------------------------------------------------------
  const modZ0 = zTop - D.moduleOverhangMm;
  const modZ1 = modZ0 + D.moduleLengthMm;
  const modZc = (modZ0 + modZ1) / 2;
  const moduleGeo = new RoundedBoxGeometry(
    D.moduleWidthMm,
    D.moduleThicknessMm,
    D.moduleLengthMm,
    2,
    0.12,
  );
  const module = new THREE.Mesh(
    plain(moduleGeo).translate(0, yt + D.moduleThicknessMm / 2, modZc),
    m.moduleBoard,
  );
  module.name = 'module_substrate';
  root.add(module);
  // Castellated pads: 14 down each long side and 10 along the far edge (1.27 mm pitch) [WROOM].
  const castel: THREE.BufferGeometry[] = [];
  const padTop = new THREE.BoxGeometry(0.9, 0.04, 0.6);
  const padEdge = new THREE.BoxGeometry(0.06, D.moduleThicknessMm * 0.9, 0.55);
  const sideZ0 = modZ1 - 1.5 - 13 * 1.27;
  for (let i = 0; i < 14; i++)
    for (const sx of [-1, 1]) {
      const z = sideZ0 + i * 1.27;
      castel.push(
        at(padTop, sx * (D.moduleWidthMm / 2 - 0.45), yt + D.moduleThicknessMm + 0.02, z),
      );
      castel.push(at(padEdge, sx * (D.moduleWidthMm / 2 + 0.01), yt + D.moduleThicknessMm / 2, z));
    }
  for (let i = 0; i < 10; i++) {
    const x = (i - 4.5) * 1.27;
    castel.push(
      at(new THREE.BoxGeometry(0.6, 0.04, 0.9), x, yt + D.moduleThicknessMm + 0.02, modZ1 - 0.45),
    );
    castel.push(
      at(
        new THREE.BoxGeometry(0.55, D.moduleThicknessMm * 0.9, 0.06),
        x,
        yt + D.moduleThicknessMm / 2,
        modZ1 + 0.01,
      ),
    );
  }
  root.add(merged('module_pads', castel, m.gold));
  // The RF can: stamped, slightly rounded corners; its top carries the marking plane.
  const canZc = modZ1 - 0.9 - D.shieldLengthMm / 2;
  const canY = yt + D.moduleThicknessMm;
  const can = new THREE.Mesh(
    plain(
      new RoundedBoxGeometry(D.shieldWidthMm, D.shieldHeightMm, D.shieldLengthMm, 3, 0.35),
    ).translate(0, canY + D.shieldHeightMm / 2, canZc),
    m.can,
  );
  can.name = 'shield_can';
  root.add(can);
  const labelGeo = new THREE.PlaneGeometry(D.shieldWidthMm - 1.2, D.shieldLengthMm - 1.2).rotateX(
    -Math.PI / 2,
  );
  const label = new THREE.Mesh(
    labelGeo.translate(0, canY + D.shieldHeightMm + 0.01, canZc),
    m.label,
  );
  label.name = 'module_label';
  root.add(label);
  // The printed inverted-F antenna: a meander along the overhanging end.
  const trace: THREE.BufferGeometry[] = [];
  const tw = 0.5;
  const y = yt + D.moduleThicknessMm + 0.015;
  const zA = modZ0 + 1.3;
  const zB = modZ0 + 4.3;
  let x = -D.moduleWidthMm / 2 + 2.2;
  trace.push(at(new THREE.BoxGeometry(tw, 0.02, zB + 1.0 - zA), x, y, (zA + zB + 1.0) / 2));
  for (let i = 0; i < 6; i++) {
    const next = x + 2.2;
    const zz = i % 2 ? zA : zB;
    trace.push(at(new THREE.BoxGeometry(next - x + tw, 0.02, tw), (x + next) / 2, y, zz));
    trace.push(at(new THREE.BoxGeometry(tw, 0.02, zB - zA + tw), next, y, (zA + zB) / 2));
    x = next;
  }
  root.add(merged('antenna', trace, m.antenna));

  // ---- Micro-USB B receptacle at the bottom edge ---------------------------------------------
  {
    const w = 7.5;
    const h = 2.6;
    const c = 0.9; // bottom chamfers of the B profile
    const outer = new THREE.Shape();
    outer.moveTo(-w / 2, 0);
    outer.lineTo(w / 2, 0);
    outer.lineTo(w / 2, -h + c);
    outer.lineTo(w / 2 - c, -h);
    outer.lineTo(-w / 2 + c, -h);
    outer.lineTo(-w / 2, -h + c);
    outer.closePath();
    const t = 0.25;
    const inner = new THREE.Path();
    inner.moveTo(-w / 2 + t, -t);
    inner.lineTo(w / 2 - t, -t);
    inner.lineTo(w / 2 - t, -h + c + t * 0.4);
    inner.lineTo(w / 2 - c - t * 0.4, -h + t);
    inner.lineTo(-w / 2 + c + t * 0.4, -h + t);
    inner.lineTo(-w / 2 + t, -h + c + t * 0.4);
    inner.closePath();
    outer.holes.push(inner);
    const depth = 5.0;
    const shell = new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: false });
    // Profile X -> scene X, profile Y -> scene Y (pointing down from the top), extrusion -> +Z.
    shell.translate(0, yt + h, zBottom + 0.6 - depth);
    const usb = new THREE.Mesh(plain(shell), m.nickel);
    usb.name = 'usb_shell';
    root.add(usb);
    const tongue = new THREE.Mesh(
      plain(new THREE.BoxGeometry(w - 2.2, 0.6, depth - 0.8)).translate(
        0,
        yt + h - 0.95,
        zBottom + 0.6 - depth / 2 - 0.4,
      ),
      m.tongue,
    );
    tongue.name = 'usb_tongue';
    root.add(tongue);
    // Back plate and the two through-hole shell tabs.
    const tabs: THREE.BufferGeometry[] = [
      at(new THREE.BoxGeometry(w, h, 0.2), 0, yt + h / 2, zBottom + 0.6 - depth + 0.1),
      at(new THREE.BoxGeometry(0.3, 1.2, 1.2), -w / 2 - 0.15, yt + 0.6, zBottom - 3.0),
      at(new THREE.BoxGeometry(0.3, 1.2, 1.2), w / 2 + 0.15, yt + 0.6, zBottom - 3.0),
    ];
    root.add(merged('usb_tabs', tabs, m.nickel));
  }

  // ---- EN and BOOT tactile switches -----------------------------------------------------------
  {
    const bodies: THREE.BufferGeometry[] = [];
    const frames: THREE.BufferGeometry[] = [];
    const caps: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const cx = sx * 8.2;
      const cz = zBottom - 5.0;
      bodies.push(at(new RoundedBoxGeometry(3.6, 1.1, 4.4, 2, 0.15), cx, yt + 0.55, cz));
      frames.push(at(new THREE.BoxGeometry(3.7, 0.12, 4.5), cx, yt + 1.16, cz));
      // Frame legs folded down the short ends.
      for (const sz of [-1, 1])
        frames.push(at(new THREE.BoxGeometry(1.6, 1.2, 0.12), cx, yt + 0.6, cz + sz * 2.25));
      caps.push(at(new THREE.CylinderGeometry(0.85, 0.9, 0.55, 24), cx, yt + 1.5, cz));
    }
    root.add(merged('switch_bodies', bodies, m.switchBody));
    root.add(merged('switch_frames', frames, m.steel));
    root.add(merged('switch_actuators', caps, m.actuator));
  }

  // ---- USB-UART bridge (QFN-28, 5 x 5 mm), the 3.3 V regulator (SOT-223) ---------------------
  {
    const ics: THREE.BufferGeometry[] = [];
    const leads: THREE.BufferGeometry[] = [];
    // QFN: flat moulded body with its edge terminations.
    const qx = 1.5;
    const qz = zc + 13.5;
    ics.push(at(new RoundedBoxGeometry(5, 0.9, 5, 1, 0.08), qx, yt + 0.45, qz));
    for (let i = 0; i < 7; i++) {
      const o = (i - 3) * 0.5;
      leads.push(at(new THREE.BoxGeometry(0.25, 0.2, 0.4), qx + o, yt + 0.1, qz - 2.55));
      leads.push(at(new THREE.BoxGeometry(0.25, 0.2, 0.4), qx + o, yt + 0.1, qz + 2.55));
      leads.push(at(new THREE.BoxGeometry(0.4, 0.2, 0.25), qx - 2.55, yt + 0.1, qz + o));
      leads.push(at(new THREE.BoxGeometry(0.4, 0.2, 0.25), qx + 2.55, yt + 0.1, qz + o));
    }
    // SOT-223: body, three gull-wing leads on one long side, the wide tab on the other.
    const rx = -1.0;
    const rz = zc + 4.0;
    ics.push(at(new RoundedBoxGeometry(6.5, 1.6, 3.5, 1, 0.1), rx, yt + 0.25 + 0.8, rz));
    const gull = (w: number) => {
      const p = new THREE.Shape();
      // Side profile (Y up): out of the body at mid-height, down, out along the board.
      p.moveTo(0, 0.95);
      p.lineTo(0.55, 0.95);
      p.lineTo(0.85, 0.12);
      p.lineTo(1.45, 0.12);
      p.lineTo(1.45, 0);
      p.lineTo(0.75, 0);
      p.lineTo(0.45, 0.83);
      p.lineTo(0, 0.83);
      p.closePath();
      const g = new THREE.ExtrudeGeometry(p, { depth: w, bevelEnabled: false });
      g.translate(0, 0, -w / 2);
      return g;
    };
    for (let i = 0; i < 3; i++) {
      // Leads out of the -Z side (rotate the profile so "out" is -Z).
      const g = gull(0.7).rotateY(Math.PI / 2);
      leads.push(at(g, rx + (i - 1) * 2.3, yt, rz - 1.75));
    }
    leads.push(at(gull(3.0).rotateY(-Math.PI / 2), rx, yt, rz + 1.75));
    root.add(merged('ic_bodies', ics, m.epoxy));
    root.add(merged('ic_leads', leads, m.tin));
  }

  // ---- Chip passives (0603/0402) and the 0805 power LED -------------------------------------
  {
    const caps: THREE.BufferGeometry[] = [];
    const res: THREE.BufferGeometry[] = [];
    const ends: THREE.BufferGeometry[] = [];
    // [x, z, kind, rotated] around the regulator, the bridge and the module supply [REP].
    const parts: [number, number, 'c' | 'r', boolean][] = [
      [4.2, 6.5, 'c', false],
      [4.2, 8.5, 'c', false],
      [-4.8, 9.5, 'c', true],
      [-6.2, 2.0, 'c', true],
      [6.2, 2.5, 'c', false],
      [6.2, 13.5, 'r', true],
      [-3.2, 15.5, 'r', false],
      [2.8, 17.5, 'r', false],
      [-2.4, 17.5, 'r', false],
      [5.8, 17.0, 'c', true],
      [-6.0, 15.8, 'r', true],
      [-5.5, 5.5, 'r', false],
    ];
    for (const [px, pz, kind, rot] of parts) {
      const L = 1.6;
      const W = 0.8;
      const H = kind === 'c' ? 0.8 : 0.45;
      const body = new THREE.BoxGeometry(rot ? W : L - 0.5, H, rot ? L - 0.5 : W);
      (kind === 'c' ? caps : res).push(at(body, px, yt + H / 2, zc + pz));
      for (const e of [-1, 1]) {
        const cap = new THREE.BoxGeometry(rot ? W + 0.02 : 0.28, H + 0.02, rot ? 0.28 : W + 0.02);
        ends.push(
          at(
            cap,
            px + (rot ? 0 : e * (L / 2 - 0.14)),
            yt + H / 2,
            zc + pz + (rot ? e * (L / 2 - 0.14) : 0),
          ),
        );
      }
    }
    root.add(merged('mlcc', caps, m.ceramic));
    root.add(merged('chip_resistors', res, m.resistor));
    root.add(merged('chip_terminations', ends, m.tin));
    const led = new THREE.Mesh(
      plain(new THREE.BoxGeometry(2.0, 0.6, 1.25)).translate(-6.0, yt + 0.3, zc + 13.0),
      m.ledLens,
    );
    led.name = 'power_led';
    root.add(led);
  }

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
