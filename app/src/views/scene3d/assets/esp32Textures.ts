/**
 * Surface textures of the ESP32-DevKitC V4 (Sprint 10 realism pass), drawn at runtime on canvases:
 * the asset's geometry is in the glTF (esp32DevkitC.author.ts); what is PRINTED or lies UNDER the
 * solder mask is drawn here, once per viewer (OwnedResources.lasting), shared by every board.
 *
 * - PCB faces: black solder mask over copper (ground pour and signal traces raise the mask and
 *   catch the light, with clearance gaps round each trace and pad, as on a real board), tented
 *   vias, tinned SMD pads, and the white silkscreen (pin labels, part outlines, button names),
 *   plotted with the project's stroke font. A matching height map gives the relief (bump map).
 * - The module's exposed top (the antenna's meander under its mask).
 * - The marking atlas: the RF can's laser marking and the ICs' top marks (MARK_ATLAS).
 * - Brushed-metal roughness for the RF can.
 * Resolution by tier: `full` ~37 px/mm on the board (labels stay sharp in close-up), `reduced` half.
 *
 * Layout: esp32Layout.ts (the same table as the geometry). Nothing here is product logic.
 */
import * as THREE from 'three';
import { ESP32_DEVKITC_WROOM32, boardPinPosition } from '@tbi-lab/domain';
import { ESP32_DEVKITC as D } from '../physical.js';
import { drawTexture, type OwnedResources } from '../kit.js';
import { CHIPS, CHIP_SIZE, LAYOUT, MARK_ATLAS, silkLabel } from './esp32Layout.js';
import { strokeText } from './strokeFont.js';

const MASK = '#0f1114';
/** Mask over copper (pour, traces): a shade lighter, with a faint green-blue cast of the resin. */
const MASK_COPPER = '#181c20';
const SILK = '#e6e7e1';
const PAD = '#c4c8cc';

const pinZ = (position: number) => (position - (D.headerPins + 1) / 2) * D.pinPitchMm;
const ROW_X = D.headerRowSpacingMm / 2;
const Z_TOP = D.pcbCentreZMm - D.pcbLengthMm / 2;
const MOD_Z1 = Z_TOP - D.moduleOverhangMm + D.moduleLengthMm;

type Pt = [number, number];

/** Board-space drawing helper: mm -> px on a canvas covering the PCB (x across, z along). */
function boardSpace(ctx: CanvasRenderingContext2D, k: number, mirror: boolean) {
  const W = D.pcbWidthMm * k;
  return {
    X: (x: number) => (mirror ? W - (x + D.pcbWidthMm / 2) * k : (x + D.pcbWidthMm / 2) * k),
    Z: (z: number) => (z - Z_TOP) * k,
    k,
    ctx,
  };
}

/**
 * The copper the mask covers: signal traces from the header pins to the module's pads (short jogs
 * beside the module, channels along the board for the far pins), the supply and USB runs.
 * Deterministic and plausible; not the board's real netlist (which is not published as artwork).
 */
function traces(): { w: number; pts: Pt[] }[] {
  const out: { w: number; pts: Pt[] }[] = [];
  const sideZ0 = MOD_Z1 - 1.5 - 13 * 1.27;
  const sidePads = Array.from({ length: 14 }, (_, i) => sideZ0 + i * 1.27);
  for (const sx of [-1, 1]) {
    const header = sx < 0 ? 'J2' : 'J3';
    const pins = ESP32_DEVKITC_WROOM32.pins.filter((p) => p.header === header);
    // Pins beside the module: a jog to the nearest free side pad.
    const used = new Set<number>();
    let channel = 0;
    for (const pin of pins) {
      const zp = pinZ(pin.position);
      const x = sx * ROW_X;
      if (pin.headerLabel === 'GND') continue; // into the pour
      if (zp < MOD_Z1 - 0.6) {
        const i = sidePads.reduce(
          (b, z, j) =>
            !used.has(j) && Math.abs(z - zp) < Math.abs((sidePads[b] ?? 1e9) - zp) ? j : b,
          -1,
        );
        if (i < 0) continue;
        used.add(i);
        const zt = sidePads[i]!;
        const dz = zt - zp;
        out.push({
          w: 0.22,
          pts: [
            [x, zp],
            [sx * (11.4 - Math.min(0.6, Math.abs(dz))), zp],
            [sx * 10.4, zt],
            [sx * 9.3, zt],
          ],
        });
      } else if (channel < 5 && zp < 14) {
        // Far pins: a channel along the board to the module's end pads.
        const cx = sx * (11.2 - channel * 0.3);
        const padX = sx * (5.715 - channel * 1.27);
        const zIn = MOD_Z1 + 0.35;
        const diag = Math.abs(cx - padX);
        out.push({
          w: 0.2,
          pts: [
            [x, zp],
            [cx + sx * 0.4, zp],
            [cx, zp - 0.4],
            [cx, zIn + 0.9 + diag],
            [padX, zIn + 0.9],
            [padX, zIn],
          ],
        });
        channel++;
      }
    }
  }
  const u = LAYOUT.usb;
  const r = LAYOUT.regulator;
  const q = LAYOUT.bridge;
  // USB data pair to the bridge, VBUS to the regulator and the 5V pin, 3V3 to the module.
  out.push({
    w: 0.2,
    pts: [
      [u.x - 0.33, u.front - u.depth - 1.0],
      [u.x - 0.33, q.z + 3.4],
      [q.x - 0.5, q.z + 2.8],
    ],
  });
  out.push({
    w: 0.2,
    pts: [
      [u.x + 0.33, u.front - u.depth - 1.0],
      [u.x + 0.33, q.z + 3.4],
      [q.x + 0.1, q.z + 2.8],
    ],
  });
  out.push({
    w: 0.6,
    pts: [
      [u.x - 1.3, u.front - u.depth - 1.0],
      [-3.6, u.front - u.depth - 2.2],
      [-3.6, r.z + 2.3],
      [r.x - 3.3, r.z + 2.3],
    ],
  });
  out.push({
    w: 0.6,
    pts: [
      [-3.6, u.front - u.depth - 2.2],
      [-11.6, 22.86 - 0.8],
      [-ROW_X, 22.86],
    ],
  });
  out.push({
    w: 0.6,
    pts: [
      [r.x + 2.6, r.z],
      [r.x + 2.6, MOD_Z1 + 1.6],
      [1.27 * 4.5, MOD_Z1 + 1.6],
      [5.715, MOD_Z1 + 0.35],
    ],
  });
  out.push({
    w: 0.6,
    pts: [
      [r.x + 2.6, MOD_Z1 + 1.6],
      [-4.0, MOD_Z1 + 1.6],
      [-4.0, MOD_Z1 + 0.35],
    ],
  });
  // Bridge UART and the auto-reset transistors.
  for (const t of LAYOUT.transistors)
    out.push({
      w: 0.2,
      pts: [
        [q.x + 2.6, q.z],
        [t.x - 1.6, q.z],
        [t.x - 1.6, t.z - 1.1],
        [t.x - 0.95, t.z - 1.1],
      ],
    });
  out.push({
    w: 0.2,
    pts: [
      [q.x + 1.0, q.z - 2.6],
      [q.x + 1.0, MOD_Z1 + 2.4],
      [2.54, MOD_Z1 + 2.4],
      [1.905, MOD_Z1 + 0.35],
    ],
  });
  out.push({
    w: 0.2,
    pts: [
      [q.x + 0.5, q.z - 2.6],
      [q.x + 0.5, MOD_Z1 + 2.8],
      [0.635, MOD_Z1 + 2.8],
      [0.635, MOD_Z1 + 0.35],
    ],
  });
  out.push({
    w: 0.2,
    pts: [
      [LAYOUT.en.x + 1.4, LAYOUT.en.z],
      [-6.3, LAYOUT.en.z],
      [-6.3, MOD_Z1 + 3.4],
      [-1.905, MOD_Z1 + 3.4],
      [-1.905, MOD_Z1 + 0.35],
    ],
  });
  return out;
}

/** Vias (tented), at trace ends and in the pour: board mm. */
function vias(): Pt[] {
  const v: Pt[] = [];
  let seed = 97;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 46; i++) {
    const x = -9.6 + rnd() * 19.2;
    const z = MOD_Z1 + 1.2 + rnd() * (22.5 - MOD_Z1);
    const clear =
      CHIPS.every((c) => Math.hypot(c.x - x, c.z - z) > 1.4) &&
      Math.hypot(LAYOUT.bridge.x - x, LAYOUT.bridge.z - z) > 3.8 &&
      !(Math.abs(LAYOUT.regulator.x - x) < 4.2 && Math.abs(LAYOUT.regulator.z - z) < 4.0) &&
      !(Math.abs(LAYOUT.usb.x - x) < 5 && z > LAYOUT.usb.front - LAYOUT.usb.depth - 1.5) &&
      [LAYOUT.en, LAYOUT.boot, ...LAYOUT.transistors].every(
        (p) => Math.hypot(p.x - x, p.z - z) > 2.8,
      );
    if (clear) v.push([x, z]);
  }
  return v;
}

/** Pads of the surface-mount parts: [x, z, w (x), l (z)] in board mm. */
function smdPads(): [number, number, number, number][] {
  const pads: [number, number, number, number][] = [];
  for (const c of CHIPS) {
    const [L, W] = CHIP_SIZE[c.kind];
    const pl = Math.min(0.55, L * 0.36);
    for (const e of [-1, 1]) {
      const d = L / 2 - pl / 2 + 0.12;
      if (c.alongZ) pads.push([c.x, c.z + e * d, W + 0.1, pl]);
      else pads.push([c.x + e * d, c.z, pl, W + 0.1]);
    }
  }
  const r = LAYOUT.regulator;
  for (let i = 0; i < 3; i++) pads.push([r.x - 3.1, r.z + (1 - i) * 2.3, 1.4, 0.95]);
  pads.push([r.x + 3.0, r.z, 1.6, 3.4]);
  for (const t of LAYOUT.transistors) {
    for (const dx of [-0.95, 0.95]) pads.push([t.x + dx, t.z - 1.15, 0.6, 0.8]);
    pads.push([t.x, t.z + 1.15, 0.6, 0.8]);
  }
  for (const p of [LAYOUT.en, LAYOUT.boot])
    for (const sz of [-1, 1])
      for (const sx of [-1, 1]) pads.push([p.x + sx * 0.8, p.z + sz * 2.25, 0.9, 1.0]);
  const u = LAYOUT.usb;
  for (let i = 0; i < 5; i++)
    pads.push([u.x + (i - 2) * 0.65, u.front - u.depth - 0.45, 0.45, 1.3]);
  return pads;
}

/** Silkscreen outlines round the parts (board mm rectangles: x0, z0, x1, z1). */
function outlines(): [number, number, number, number][] {
  const o: [number, number, number, number][] = [];
  const box = (x: number, z: number, w: number, l: number, m = 0.35) =>
    o.push([x - w / 2 - m, z - l / 2 - m, x + w / 2 + m, z + l / 2 + m]);
  const b = LAYOUT.switchBody;
  for (const p of [LAYOUT.en, LAYOUT.boot]) box(p.x, p.z, b.x + 0.6, b.z + 1.2, 0.2);
  box(LAYOUT.regulator.x + 0.4, LAYOUT.regulator.z, 7.6, 7.0, 0.1);
  for (const t of LAYOUT.transistors) box(t.x, t.z, 3.1, 3.0, 0.1);
  // Groups of passives share an outline, as on the board.
  box(-7.9, 12.5, 1.2, 4.6, 0.1);
  box(-7.9, 6.45, 1.0, 3.3, 0.1);
  box(-6.75, 6.62, 3.6, 2.6, 0.05);
  box(-6.75, 3.03, 3.6, 2.6, 0.05);
  box(-5.18, 11.7, 1.4, 5.8, 0.1);
  box(4.3, 14.03, 1.4, 2.1, 0.1);
  box(4.42, 10.0, 1.4, 2.1, 0.1);
  return o;
}

/** Draw a PCB face: colours, or (`height`) its relief for the bump map. `top`: component side. */
function drawBoard(ctx: CanvasRenderingContext2D, kk: number, top: boolean, height: boolean) {
  {
    const s = boardSpace(ctx, kk, !top);
    const W = D.pcbWidthMm * kk;
    const H = D.pcbLengthMm * kk;
    const col = (c: string, h: number) => (height ? `rgb(${h},${h},${h})` : c);
    ctx.fillStyle = col(MASK, 0);
    ctx.fillRect(0, 0, W, H);
    // Ground pour between the header rows (top: around the parts; bottom: the whole field).
    ctx.fillStyle = col(MASK_COPPER, 70);
    const pz0 = top ? MOD_Z1 + 0.6 : Z_TOP + 0.8;
    ctx.fillRect(
      s.X(-10.9),
      s.Z(pz0),
      21.8 * kk,
      (D.pcbCentreZMm + D.pcbLengthMm / 2 - 0.7 - pz0) * kk,
    );
    if (top) {
      // Around the module footprint the top is free copper too (keep-out under the antenna).
      ctx.fillRect(s.X(-13.4), s.Z(MOD_Z1 + 0.6), 26.8 * kk, 0.8 * kk);
    }
    // Clearances: mask-only gaps round every trace, via and pad.
    const tr = top
      ? traces()
      : traces().map((t) => ({ ...t, pts: t.pts.map(([x, z]): Pt => [-x * 0.98, z]) }));
    const stroke = (pts: Pt[], w: number) => {
      ctx.lineWidth = w * kk;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([x, z], i) => (i ? ctx.lineTo(s.X(x), s.Z(z)) : ctx.moveTo(s.X(x), s.Z(z))));
      ctx.stroke();
    };
    ctx.strokeStyle = col(MASK, 0);
    for (const t of tr) stroke(t.pts, t.w + 0.5);
    const pinPts: Pt[] = ESP32_DEVKITC_WROOM32.pins.map((p) => [
      Math.sign(boardPinPosition(p).x) * ROW_X,
      pinZ(p.position),
    ]);
    ctx.fillStyle = col(MASK, 0);
    for (const [x, z] of pinPts) {
      ctx.beginPath();
      ctx.arc(s.X(x), s.Z(z), 1.25 * kk, 0, 2 * Math.PI);
      ctx.fill();
    }
    const pads = top ? smdPads() : [];
    for (const [x, z, w, l] of pads)
      ctx.fillRect(
        s.X(x) - (w / 2 + 0.25) * kk,
        s.Z(z - l / 2 - 0.25),
        (w + 0.5) * kk,
        (l + 0.5) * kk,
      );
    const vs = vias();
    for (const [x, z] of vs) {
      ctx.beginPath();
      ctx.arc(s.X(top ? x : -x), s.Z(z), 0.62 * kk, 0, 2 * Math.PI);
      ctx.fill();
    }
    // Copper under the mask: traces, via lands, pin lands.
    ctx.strokeStyle = col(MASK_COPPER, 110);
    for (const t of tr) stroke(t.pts, t.w);
    ctx.fillStyle = col(MASK_COPPER, 110);
    for (const [x, z] of vs) {
      ctx.beginPath();
      ctx.arc(s.X(top ? x : -x), s.Z(z), 0.33 * kk, 0, 2 * Math.PI);
      ctx.fill();
    }
    // Via drill (tented: a small dimple in the mask).
    ctx.fillStyle = col('#0b0c0e', 40);
    for (const [x, z] of vs) {
      ctx.beginPath();
      ctx.arc(s.X(top ? x : -x), s.Z(z), 0.13 * kk, 0, 2 * Math.PI);
      ctx.fill();
    }
    // Pin pads: tinned rings (the solder fillet's geometry covers their centres).
    ctx.fillStyle = col(PAD, 150);
    for (const [x, z] of pinPts) {
      ctx.beginPath();
      ctx.arc(s.X(x), s.Z(z), 0.92 * kk, 0, 2 * Math.PI);
      ctx.fill();
    }
    // SMD pads: tinned.
    for (const [x, z, w, l] of pads)
      ctx.fillRect(s.X(x) - (w / 2) * kk, s.Z(z - l / 2), w * kk, l * kk);
    // Silkscreen.
    ctx.strokeStyle = col(SILK, 170);
    ctx.fillStyle = col(SILK, 170);
    const lw = 0.15;
    if (top) {
      for (const pin of ESP32_DEVKITC_WROOM32.pins) {
        const left = boardPinPosition(pin).x < 0;
        strokeText(
          ctx,
          silkLabel(pin.headerLabel),
          s.X(left ? -LAYOUT.pinLabelX : LAYOUT.pinLabelX),
          s.Z(pinZ(pin.position)),
          {
            height: LAYOUT.pinLabelHeight * kk,
            align: 'center',
            rotate: left ? Math.PI / 2 : -Math.PI / 2,
            weight: 0.17,
          },
        );
      }
      ctx.lineWidth = lw * kk;
      for (const [x0, z0, x1, z1] of outlines())
        ctx.strokeRect(s.X(x0), s.Z(z0), (x1 - x0) * kk, (z1 - z0) * kk);
      // The module's outline (open towards the antenna end, which overhangs the board).
      const m = LAYOUT.moduleOutline;
      ctx.beginPath();
      ctx.moveTo(s.X(m.x0), s.Z(Z_TOP));
      ctx.lineTo(s.X(m.x0), s.Z(m.z0));
      ctx.lineTo(s.X(m.x1), s.Z(m.z0));
      ctx.lineTo(s.X(m.x1), s.Z(Z_TOP));
      ctx.stroke();
      // The bridge's corner marks and pin-1 dot.
      const q = LAYOUT.bridge;
      const e = q.size / 2 + 0.45;
      for (const [cx, cz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(s.X(q.x + cx * e), s.Z(q.z + cz * (e - 0.8)));
        ctx.lineTo(s.X(q.x + cx * e), s.Z(q.z + cz * e));
        ctx.lineTo(s.X(q.x + cx * (e - 0.8)), s.Z(q.z + cz * e));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(s.X(q.x - e - 0.35), s.Z(q.z - e - 0.35), 0.2 * kk, 0, 2 * Math.PI);
      ctx.fill();
      strokeText(ctx, 'EN', s.X(LAYOUT.enLabel.x), s.Z(LAYOUT.enLabel.z), {
        height: 0.95 * kk,
        align: 'center',
        rotate: Math.PI / 2,
        weight: 0.17,
      });
      strokeText(ctx, 'Boot', s.X(LAYOUT.bootLabel.x), s.Z(LAYOUT.bootLabel.z), {
        height: 0.95 * kk,
        align: 'center',
        rotate: -Math.PI / 2,
        weight: 0.17,
      });
    } else {
      // The underside: the board's name and revision, the header names, the pin-1 marks.
      // Drawn mirrored (s.X), so it reads correctly from below.
      ctx.save();
      ctx.translate(s.X(0), s.Z(3));
      ctx.scale(-1, 1);
      strokeText(ctx, 'ESP32-DevKitC V4', 0, 0, {
        height: 1.5 * kk,
        align: 'center',
        rotate: -Math.PI / 2,
        weight: 0.16,
      });
      strokeText(ctx, 'ESPRESSIF', 2.6 * kk, 0, {
        height: 1.0 * kk,
        align: 'center',
        rotate: -Math.PI / 2,
        weight: 0.16,
      });
      ctx.restore();
      for (const [label, x] of [
        ['J2', -ROW_X],
        ['J3', ROW_X],
      ] as const) {
        ctx.save();
        ctx.translate(s.X(x * 0.82), s.Z(-22.86 - 0.2));
        ctx.scale(-1, 1);
        strokeText(ctx, label, 0, 0, { height: 0.9 * kk, align: 'center', weight: 0.17 });
        ctx.restore();
      }
    }
  }
}

export interface BoardTextures {
  top: { map: THREE.Texture; bump: THREE.Texture | null };
  bottom: { map: THREE.Texture; bump: THREE.Texture | null };
  moduleTop: { map: THREE.Texture; bump: THREE.Texture | null };
  marks: THREE.Texture;
  brushed: THREE.Texture;
}

/** The board's textures for this viewer (drawn on first use, then kept). */
export function esp32Textures(own: OwnedResources): BoardTextures {
  const full = own.tier === 'full';
  const k = full ? 36 : 18;
  const kh = full ? 18 : 9;
  const W = Math.round(D.pcbWidthMm * k);
  const H = Math.round(D.pcbLengthMm * k);
  const Wh = Math.round(D.pcbWidthMm * kh);
  const Hh = Math.round(D.pcbLengthMm * kh);
  const face = (top: boolean) => ({
    map: own.lasting(`esp32:${top ? 'top' : 'bottom'}:${k}`, () =>
      drawTexture(W, H, (ctx) => drawBoard(ctx, k, top, false), true, `esp32:${top}:${k}`),
    ),
    // The relief is soft (the mask flows over the copper's edges): every shape drawn blurred.
    // Full tier only (the reduced tier draws no bump maps).
    bump: !full
      ? null
      : own.lasting(`esp32:${top ? 'top' : 'bottom'}:bump:${kh}`, () =>
          drawTexture(
            Wh,
            Hh,
            (ctx) => {
              ctx.filter = 'blur(1px)';
              drawBoard(ctx, kh, top, true);
            },
            false,
            `esp32:${top}:bump:${kh}`,
          ),
        ),
  });
  return {
    top: face(true),
    bottom: face(false),
    moduleTop: moduleTop(own, full),
    marks: markAtlas(own, full),
    brushed: brushed(own, full),
  };
}

/** The module's top beside the can: mask, the antenna meander under it, two gold test dots. */
function moduleTop(own: OwnedResources, full: boolean) {
  const k = full ? 28 : 14;
  const w = D.moduleWidthMm - 0.1;
  const l = D.moduleLengthMm - 0.1;
  const draw = (height: boolean) => (ctx: CanvasRenderingContext2D) => {
    const col = (c: string, h: number) => (height ? `rgb(${h},${h},${h})` : c);
    ctx.fillStyle = col('#101215', 0);
    ctx.fillRect(0, 0, w * k, l * k);
    // The printed inverted-F antenna: a meander across the overhang (module frame: z from the
    // antenna end).
    ctx.strokeStyle = col('#1c2024', 120);
    ctx.lineWidth = 0.5 * k;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    const y0 = 0.9 * k;
    const y1 = 4.6 * k;
    let x = 1.4 * k;
    ctx.moveTo(x, 5.6 * k);
    ctx.lineTo(x, y0);
    for (let i = 0; i < 7; i++) {
      const nx = x + 2.0 * k;
      ctx.lineTo(nx, i % 2 ? y0 : y0);
      ctx.lineTo(nx, i % 2 ? y0 : y1);
      if (i % 2 === 0) {
        ctx.lineTo(nx + 1.0 * k, y1);
        ctx.lineTo(nx + 1.0 * k, y0);
        x = nx + 1.0 * k;
      } else x = nx;
    }
    ctx.stroke();
    // Ground plane edge under the can's area.
    ctx.fillStyle = col('#16191d', 80);
    ctx.fillRect(0.6 * k, 6.4 * k, (w - 1.2) * k, (l - 7.0) * k);
    if (!height) {
      ctx.fillStyle = '#c9a75a';
      for (const [px, pz] of [
        [w - 1.3, 4.0],
        [w - 1.3, 5.0],
      ] as const) {
        ctx.beginPath();
        ctx.arc(px * k, pz * k, 0.22 * k, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  };
  return {
    map: own.lasting(`esp32:module:${k}`, () =>
      drawTexture(Math.round(w * k), Math.round(l * k), draw(false)),
    ),
    bump: !full
      ? null
      : own.lasting(`esp32:module:bump:${k}`, () =>
          drawTexture(Math.round(w * k), Math.round(l * k), draw(true), false),
        ),
  };
}

/** The marking atlas (MARK_ATLAS): laser-etched can marking, ink marks on the ICs. */
function markAtlas(own: OwnedResources, full: boolean) {
  const S = full ? MARK_ATLAS.size : MARK_ATLAS.size / 2;
  const f = S / MARK_ATLAS.size;
  return own.lasting(`esp32:marks:${S}`, () =>
    drawTexture(S, S, (ctx) => {
      ctx.clearRect(0, 0, S, S);
      ctx.scale(f, f);
      // RF can (14.8 x 16.3 mm at ~43 px/mm): canvas up = towards the antenna.
      const [cx, cy, cw] = MARK_ATLAS.regions.can;
      const mm = cw / 14.8;
      ctx.strokeStyle = 'rgba(62, 66, 72, 0.9)';
      ctx.fillStyle = 'rgba(62, 66, 72, 0.9)';
      const line = (t: string, x: number, y: number, h: number, w = 0.12) =>
        strokeText(ctx, t, cx + x * mm, cy + y * mm, { height: h * mm, weight: w, align: 'left' });
      line('ESPRESSIF', 1.2, 2.0, 1.25, 0.13);
      line('ESP32-WROOM-32', 1.2, 4.1, 1.05, 0.12);
      line('FCC ID:2AC7Z-ESPWROOM32', 1.2, 6.2, 0.48, 0.1);
      line('IC:21098-ESPWROOM32', 1.2, 7.2, 0.48, 0.1);
      line('MGN4', 1.2, 8.4, 0.6, 0.1);
      // The data-matrix field (a pattern, not data), lower right.
      let seed = 11;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const n = 18;
      const cell = (4.2 * mm) / n;
      const ox = cx + 9.4 * mm;
      const oy = cy + 10.6 * mm;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          if (
            x === 0 ||
            y === n - 1 ||
            (y === 0 && x % 2 === 0) ||
            (x === n - 1 && y % 2 === 1) ||
            rnd() > 0.52
          )
            ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      // IC marks: light grey ink.
      ctx.strokeStyle = 'rgba(196, 200, 205, 0.92)';
      ctx.fillStyle = 'rgba(196, 200, 205, 0.92)';
      const [bx, by, bw] = MARK_ATLAS.regions.bridge;
      const bm = bw / 4.4;
      strokeText(ctx, 'CP2102N', bx + bw / 2, by + 1.3 * bm, {
        height: 0.62 * bm,
        align: 'center',
        weight: 0.13,
      });
      strokeText(ctx, 'A02853', bx + bw / 2, by + 2.25 * bm, {
        height: 0.55 * bm,
        align: 'center',
        weight: 0.13,
      });
      strokeText(ctx, '2441 A', bx + bw / 2, by + 3.15 * bm, {
        height: 0.55 * bm,
        align: 'center',
        weight: 0.13,
      });
      ctx.beginPath();
      ctx.arc(bx + 0.45 * bm, by + 0.45 * bm, 0.2 * bm, 0, 2 * Math.PI);
      ctx.fill();
      const [rx, ry, rw, rh] = MARK_ATLAS.regions.regulator;
      // Regulator quad: 3.0 (x) x 5.6 (z) mm; text runs along z (rotated).
      strokeText(ctx, 'MN4', rx + rw * 0.36, ry + rh / 2, {
        height: rh * 0.2,
        align: 'center',
        weight: 0.13,
        rotate: -Math.PI / 2,
      });
      strokeText(ctx, 'S214C', rx + rw * 0.64, ry + rh / 2, {
        height: rh * 0.2,
        align: 'center',
        weight: 0.13,
        rotate: -Math.PI / 2,
      });
      for (const key of ['sot1', 'sot2'] as const) {
        const [sx, sy, sw, sh] = MARK_ATLAS.regions[key];
        strokeText(ctx, '1YC', sx + sw / 2, sy + sh / 2, {
          height: sh * 0.5,
          align: 'center',
          weight: 0.14,
        });
      }
    }),
  );
}

/** Brushed metal: fine streaks along x (roughness, green channel). */
function brushed(own: OwnedResources, full: boolean) {
  const N = full ? 256 : 128;
  return own.lasting(`brushed:${N}`, () => {
    const t = drawTexture(
      N,
      N,
      (ctx) => {
        let seed = 4242;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        ctx.fillStyle = 'rgb(150,150,150)';
        ctx.fillRect(0, 0, N, N);
        for (let i = 0; i < N * 3; i++) {
          const v = Math.round(110 + rnd() * 90);
          ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
          ctx.fillRect(rnd() * N, rnd() * N, 8 + rnd() * N * 0.6, 1);
        }
      },
      false,
    );
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}
