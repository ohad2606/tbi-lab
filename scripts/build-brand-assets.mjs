/**
 * Build the web brand assets from the official TBI Lab logo package (the `logo_app` set provided
 * by the owner, 2026-10-14; not committed, 1.3-1.9 MB each).
 * Run from app/ (so Playwright resolves):  node ../scripts/build-brand-assets.mjs ~/logo/logo_app
 * An optional second argument builds only that output path.
 *
 * Top bar and Projects band (unchanged since 2026-10-14; Chromium's canvas resamples them, with
 * high-quality smoothing and halving steps, so they stay byte-identical to the committed files):
 *   app_logo_04.png -> src/assets/brand/tbi-lab-symbol.png  (the infinity symbol alone, transparent;
 *                      76 px tall, top bar at 38 px, i.e. 2x for sharp displays)
 *   app_logo_01.png -> src/assets/brand/tbi-lab-logo.png    (the full logo with the TBI LAB wordmark and
 *                      tagline, transparent; 300 px tall, Projects band at 150 px)
 *
 * Application icons (2026-10-29, sizes and small-size art revised 2026-11-05; scripts/brand-image.mjs:
 * Node only, Lanczos-3 in linear light): src/assets/brand/icons/production/ and, for DEV-Lab builds
 * only, src/assets/brand/icons/dev/. A platform given only 192 and 512 px scales them down itself for
 * its taskbar and shortcuts, so every size a desktop uses is supplied, made for that size:
 *   favicon-16.png, favicon-24.png (and DEV up to 96 px)   the official symbol (app_logo_04, trimmed) on the app icon's
 *                      navy rounded square: below 32 px the wordmark and the scenes cannot be
 *                      resolved. The square, because the symbol alone is drawn for a dark ground and
 *                      washes out on a light browser tab or taskbar.
 *   favicon-32.png, favicon-48.png, favicon-64.png, icon-96.png, icon-128.png, icon-192.png,
 *   icon-256.png, icon-512.png   the whole app icon (app_logo_05): its rounded square with the
 *                      painted black outside it made transparent (TILE: the measured outline, not a
 *                      redraw), so no dark square shows around it on a light desktop. Sharpened after
 *                      the reduction, more at the smaller sizes.
 *   favicon.ico        16, 24, 32, 48, 64 and 256 px of the above, for Windows.
 *   apple-touch-icon-180.png   the app icon cropped to its own rounded square, opaque: iOS draws
 *                      transparency as black and masks the corners itself (the square's corner
 *                      radius, 23%, matches its mask, about 22%).
 *   maskable-192.png, maskable-512.png   the content of the app icon (symbol and wordmark, inside
 *                      the rounded square's outline, its ground fading out at the edge) on the brand
 *                      navy, as large as the 80% safe zone allows: the farthest content point is
 *                      HALF_DIAGONAL source pixels from the centre and lands at 0.40 of the canvas, so
 *                      no launcher mask cuts it. No frame inside a frame, and no black margin.
 * The DEV set is the same images with a yellow "DEV" marker over them, drawn so it is unmistakable at
 * each size: up to 96 px a band across the bottom of the rounded square; above that a yellow ring and
 * the word on the "LAB" plate of the app icon; on the maskable and apple-touch icons, which launchers show smallest,
 * the symbol on the navy with a yellow band, full bleed. The glyphs are a 5-row pixel font (V five cells wide
 * so it never reads as "U").
 *
 * The artwork is used as supplied: transparent files are only trimmed to their non-transparent
 * pixels, images are scaled with the aspect ratio kept, and nothing is recoloured or redrawn. The
 * only pixels removed are the painted black around the rounded square (and, on the maskable icons,
 * the outline with it); the only additions are the brand navy behind the symbol at 16 and 24 px and
 * behind the maskable icons and, on DEV builds, the DEV marker.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import * as I from './brand-image.mjs';

const dir = process.argv[2];
const only = process.argv[3]; // optional: build just this output path
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The app icon's rounded square inside app_logo_05 (1254 x 1254), measured from its pixels. */
const TILE = { sx: 48, sy: 48, sw: 1158, sh: 1158 };
/** The same square, centred on the outline's measured box (x 48..1205, y 60..1190, radius 270). */
const OUTLINE = { x0: 48, y0: 60, x1: 1205, y1: 1190, radius: 270 };
const OUTLINE_CROP = { sx: 48, sy: 47, sw: 1158, sh: 1158 };
/** The small-size square: the navy of the app icon's ground and the blue of its outline. */
const TILE_NAVY = [0x0a, 0x1a, 0x33]; // BRAND_COLOURS.navy, the manifest's background
const TILE_EDGE = [0x1a, 0x4f, 0xd6];
const CORNER = 0.235;
/** Sharpening after the reduction: the larger the reduction, the more edge contrast it costs. */
const sharpness = (size) => (size <= 48 ? 0.8 : size <= 96 ? 0.4 : size <= 256 ? 0.2 : 0);
/** The centre of the "LAB" plate in app_logo_05 pixels: the DEV marker covers it. */
const LAB_PLATE = { x: 925, y: 902 };
/** Maskable icons: the content's centre and farthest point from it, in app_logo_05 pixels. */
const CONTENT = { x: 627, y: 627 };
const HALF_DIAGONAL = 675;
const SAFE_RADIUS = 0.4;
/** Inside the outline: `inset` px in from OUTLINE, the ground fading out over `fade` px. */
const GROUND = { inset: 28, fade: 45 };
const DEV_YELLOW = [0xff, 0xcc, 0x00];
const DEV_INK = [0x11, 0x11, 0x11];

// ------------------------------------------------------------------ top bar and Projects band

async function renderWithChromium(jobs) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, job, out] of jobs) {
    const src = `data:image/png;base64,${readFileSync(`${dir}/${file}`).toString('base64')}`;
    const url = await page.evaluate(
      async ({ src, job }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        let crop = { x: 0, y: 0, w: img.width, h: img.height };
        if (job.trim) {
          // The bounds of every pixel with any opacity: only fully transparent margins go.
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, img.width, img.height).data;
          let x0 = img.width,
            y0 = img.height,
            x1 = -1,
            y1 = -1;
          for (let y = 0; y < img.height; y++)
            for (let x = 0; x < img.width; x++) {
              if (d[(y * img.width + x) * 4 + 3] === 0) continue;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          crop = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
        }
        const outH = job.height;
        const outW = Math.round((crop.w / crop.h) * outH);
        // Halve repeatedly for quality, then the final step.
        let cur = document.createElement('canvas');
        cur.width = crop.w;
        cur.height = crop.h;
        cur.getContext('2d').drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
        while (cur.width / 2 > outW) {
          const next = document.createElement('canvas');
          next.width = Math.round(cur.width / 2);
          next.height = Math.round(cur.height / 2);
          const g = next.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(cur, 0, 0, next.width, next.height);
          cur = next;
        }
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const g = out.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(cur, 0, 0, outW, outH);
        return out.toDataURL('image/png');
      },
      { src, job },
    );
    write(out, Buffer.from(url.split(',')[1], 'base64'), file);
  }
  await browser.close();
}

// ------------------------------------------------------------------ application icons

const sources = new Map();
function source(file) {
  if (!sources.has(file)) {
    const png = I.decodePng(readFileSync(`${dir}/${file}`));
    sources.set(file, { png, img: I.fromRgba8(png) });
  }
  return sources.get(file);
}

/** The DEV marker: a yellow plate with "DEV", centred on (cx, cy), `cell` px per glyph cell. */
function devPlate(dst, cx, cy, cell) {
  const w = (I.DEV_WORD_CELLS.w + 2) * cell;
  const h = (I.DEV_WORD_CELLS.h + 2) * cell;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);
  I.fillShape(dst, I.roundedRect(x0, y0, x0 + w, y0 + h, cell), DEV_YELLOW, {
    x0,
    y0,
    x1: x0 + w,
    y1: y0 + h,
  });
  I.drawDevWord(dst, x0 + cell, y0 + cell, cell, DEV_INK);
}

const inSquare = (size) => I.roundedRect(0, 0, size, size, Math.round(size * CORNER));
const allOf = (size) => ({ x0: 0, y0: 0, x1: size, y1: size });

/** DEV, up to 96 px: a yellow band across the bottom of the rounded square, with the word. */
function devBand(out, size) {
  const cell = Math.max(1, Math.floor(size / 20));
  const height = (I.DEV_WORD_CELLS.h + 2) * cell;
  const top = size - height;
  const inside = inSquare(size);
  I.fillShape(out, (x, y) => y >= top && inside(x, y), DEV_YELLOW, { ...allOf(size), y0: top });
  I.drawDevWord(out, Math.floor((size - I.DEV_WORD_CELLS.w * cell) / 2), top + cell, cell, DEV_INK);
  return height;
}

/** DEV, above 96 px: a yellow ring just inside the edge of the rounded square. */
function devRing(out, size) {
  const c = Math.max(1, Math.round(size / 28));
  const r = Math.round(size * CORNER);
  const outer = I.roundedRect(0, 0, size, size, r);
  const inner = I.roundedRect(c, c, size - c, size - c, Math.max(0, r - c));
  I.fillShape(out, (x, y) => outer(x, y) && !inner(x, y), DEV_YELLOW, allOf(size));
}

/** 16 and 24 px: the symbol on the navy rounded square (DEV: above the band). */
function symbolIcon(size, dev) {
  const { png, img } = source('app_logo_04.png');
  const b = I.opaqueBounds(png);
  const out = I.image(size, size);
  const r = Math.round(size * CORNER);
  const e = Math.max(1, Math.round(size / 24));
  I.fillShape(out, inSquare(size), TILE_EDGE, allOf(size));
  I.fillShape(
    out,
    I.roundedRect(e, e, size - e, size - e, Math.max(0, r - e)),
    TILE_NAVY,
    allOf(size),
  );
  const w = size - (size <= 24 ? 2 : 2 * Math.round(size / 16));
  const h = Math.round((w * b.sh) / b.sw);
  const area = dev ? size - (I.DEV_WORD_CELLS.h + 2) * Math.max(1, Math.floor(size / 20)) : size;
  const symbol = I.sharpen(I.resample(img, b, w, h), sharpness(size));
  I.drawOver(out, symbol, Math.round((size - w) / 2), Math.round((area - h) / 2));
  if (dev) devBand(out, size);
  return { img: out, opaque: false };
}

let outlined;
/** 32 px and up: the app icon, transparent outside its rounded square. */
function tileIcon(size, dev) {
  // A band over the wordmark would leave pieces of its letters: DEV up to 96 px is the symbol and the band.
  if (dev && size <= 96) return symbolIcon(size, true);
  if (!outlined) {
    const { x0, y0, x1, y1, radius: r } = OUTLINE;
    outlined = I.maskTo(
      source('app_logo_05.png').img,
      I.roundedRect(x0, y0, x1, y1, r),
      (x, y) => x < x0 + r + 2 || x > x1 - r - 2 || y < y0 + r + 2 || y > y1 - r - 2,
    );
  }
  const out = I.sharpen(I.resample(outlined, OUTLINE_CROP, size, size), sharpness(size));
  if (dev) {
    devPlate(
      out,
      ((LAB_PLATE.x - OUTLINE_CROP.sx) / OUTLINE_CROP.sw) * size,
      ((LAB_PLATE.y - OUTLINE_CROP.sy) / OUTLINE_CROP.sh) * size,
      Math.max(1, Math.floor(size / 48)),
    );
    devRing(out, size);
  }
  return { img: out, opaque: false };
}

/**
 * iOS: the app icon cropped to its rounded square, opaque (iOS masks the corners). DEV: the same design
 * as the maskable icon: a ring would be masked away, and a plate the size of "LAB" is easily read as
 * production at the 60 to 76 px of a home screen.
 */
function touchIcon(size, dev) {
  if (dev) return maskableIcon(size, true);
  const out = I.sharpen(
    I.resample(source('app_logo_05.png').img, TILE, size, size),
    sharpness(size),
  );
  return { img: out, opaque: true };
}

let content;
/** The app icon inside its outline, the ground fading out towards the outline. */
function contentImage() {
  if (content) return content;
  const { img } = source('app_logo_05.png');
  const { x0, y0, x1, y1, radius } = OUTLINE;
  const r = radius - GROUND.inset;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const [hx, hy] = [(x1 - x0) / 2 - GROUND.inset - r, (y1 - y0) / 2 - GROUND.inset - r];
  const data = Float64Array.from(img.data);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const qx = Math.abs(x + 0.5 - cx) - hx;
      const qy = Math.abs(y + 0.5 - cy) - hy;
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const a = Math.min(1, Math.max(0, -d / GROUND.fade));
      if (a === 1) continue;
      const o = (y * img.w + x) * 4;
      for (let k = 0; k < 4; k++) data[o + k] *= a;
    }
  content = { w: img.w, h: img.h, data };
  return content;
}

/** Maskable: full bleed on the brand navy, everything that matters inside the safe zone. */
function maskableIcon(size, dev) {
  const out = I.image(size, size);
  I.fillShape(out, () => true, TILE_NAVY, allOf(size));
  if (dev) {
    const { png, img } = source('app_logo_04.png');
    const b = I.opaqueBounds(png);
    const w = Math.round(size * 0.72);
    const h = Math.round((w * b.sh) / b.sw);
    const top = Math.round(size * 0.64);
    const symbol = I.sharpen(I.resample(img, b, w, h), sharpness(size));
    I.drawOver(out, symbol, Math.round((size - w) / 2), Math.round((top - h) / 2 + size * 0.04));
    I.fillShape(out, (x, y) => y >= top, DEV_YELLOW, { ...allOf(size), y0: top });
    const cell = Math.floor(size / 32);
    I.drawDevWord(
      out,
      Math.floor((size - I.DEV_WORD_CELLS.w * cell) / 2),
      top + Math.round(size * 0.035),
      cell,
      DEV_INK,
    );
  } else {
    const k = (SAFE_RADIUS * size) / HALF_DIAGONAL;
    const src = contentImage();
    const d = Math.round(src.w * k);
    const art = I.sharpen(I.resample(src, undefined, d, d), sharpness(size));
    I.drawOver(
      out,
      art,
      Math.round(size / 2 - CONTENT.x * k),
      Math.round(size / 2 - CONTENT.y * k),
    );
  }
  return { img: out, opaque: true };
}

const ICONS = [
  ['favicon-16.png', (dev) => symbolIcon(16, dev), 'app_logo_04.png'],
  ['favicon-24.png', (dev) => symbolIcon(24, dev), 'app_logo_04.png'],
  ['favicon-32.png', (dev) => tileIcon(32, dev), 'app_logo_05.png'],
  ['favicon-48.png', (dev) => tileIcon(48, dev), 'app_logo_05.png'],
  ['favicon-64.png', (dev) => tileIcon(64, dev), 'app_logo_05.png'],
  ['icon-96.png', (dev) => tileIcon(96, dev), 'app_logo_05.png'],
  ['icon-128.png', (dev) => tileIcon(128, dev), 'app_logo_05.png'],
  ['apple-touch-icon-180.png', (dev) => touchIcon(180, dev), 'app_logo_05.png'],
  ['icon-192.png', (dev) => tileIcon(192, dev), 'app_logo_05.png'],
  ['icon-256.png', (dev) => tileIcon(256, dev), 'app_logo_05.png'],
  ['icon-512.png', (dev) => tileIcon(512, dev), 'app_logo_05.png'],
  ['maskable-192.png', (dev) => maskableIcon(192, dev), 'app_logo_05.png'],
  ['maskable-512.png', (dev) => maskableIcon(512, dev), 'app_logo_05.png'],
];
/** favicon.ico: these sizes, from the files above. */
const ICO = [
  [16, 'favicon-16.png'],
  [24, 'favicon-24.png'],
  [32, 'favicon-32.png'],
  [48, 'favicon-48.png'],
  [64, 'favicon-64.png'],
  [256, 'icon-256.png'],
];

function write(out, png, file) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(
    `${out}: ${png.length} bytes, sha256 ${sha(png).slice(0, 16)} from ${file} (sha256 ${sha(readFileSync(`${dir}/${file}`))})`,
  );
}

const chromiumJobs = [
  ['app_logo_04.png', { height: 76, trim: true }, 'src/assets/brand/tbi-lab-symbol.png'],
  ['app_logo_01.png', { height: 300, trim: true }, 'src/assets/brand/tbi-lab-logo.png'],
].filter(([, , o]) => !only || o === only);
if (chromiumJobs.length) await renderWithChromium(chromiumJobs);

for (const variant of ['production', 'dev']) {
  const made = new Map();
  for (const [name, make, file] of ICONS) {
    const out = `src/assets/brand/icons/${variant}/${name}`;
    if (only && only !== out) continue;
    const { img, opaque } = make(variant === 'dev');
    const png = I.encodePng(img.w, img.h, I.toRgba8(img), { opaque });
    made.set(name, png);
    write(out, png, file);
  }
  const ico = `src/assets/brand/icons/${variant}/favicon.ico`;
  if (!only)
    write(
      ico,
      I.encodeIco(ICO.map(([size, name]) => ({ size, png: made.get(name) }))),
      'app_logo_05.png',
    );
}
