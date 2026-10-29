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
 * Application icons (2026-10-29; scripts/brand-image.mjs: Node only, Lanczos-3 in linear light):
 * src/assets/brand/icons/production/ and, for DEV-Lab builds only, src/assets/brand/icons/dev/:
 *   favicon-16.png, favicon-32.png, favicon-48.png   the infinity symbol alone (app_logo_04,
 *                      trimmed), centred on a transparent square: the detailed app icon is not
 *                      legible at tab sizes (its "LAB" and the scenes inside the symbol vanish;
 *                      evidence ~/tbi-dev-brand). 48 is what a 3x screen picks for a 16 px tab, so it
 *                      is the same symbol, not the detailed icon.
 *   apple-touch-icon-180.png, icon-192.png, icon-512.png   the app icon
 *                      (app_logo_05) cropped to its own rounded square: the source's centred square
 *                      x/y 48..1205, which keeps the whole rounded square and its outline and drops
 *                      most of the black margin around it. The square's corner radius (about 265 of
 *                      1158 px, 23%) matches the iPadOS/iOS home-screen mask (about 22%), so the mask
 *                      removes the black corners instead of framing a dark square inside a dark tile.
 *                      Opaque, as supplied (no corner is made transparent).
 *   maskable-192.png, maskable-512.png   the whole app icon (with its black margin) at 70% of the
 *                      canvas, centred; the rest of the canvas repeats the source's own edge pixels
 *                      outward (its margin is near-black with a faint navy glow, up to #00061a at
 *                      the edge centres, so a flat black fill would show a visible square seam):
 *                      the entire rounded square, outline included, lies inside
 *                      the 80% safe zone (its farthest point is 0.557 of the source size from the
 *                      centre, times 0.70 = 0.39 < 0.40 of the canvas), so no launcher mask cuts it.
 * The DEV set is the same images with a yellow "DEV" marker drawn over them: on the "LAB" plate of
 * the app icon (so it reads "TBI DEV"); on the maskable icons, which launchers show smallest, a
 * large plate across the whole wordmark row; and as a yellow band under the symbol at 16 and 32 px. The
 * glyphs are a 5-row pixel font (V five cells wide so it never reads as "U").
 *
 * The artwork is used exactly as supplied: transparent files are only trimmed to their
 * non-transparent pixels (fully transparent margins removed, nothing visible cut), crops keep
 * whole source pixels, and images are scaled with the aspect ratio kept. Nothing is recoloured,
 * redrawn or made transparent; the DEV marker is an overlay on DEV builds only.
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
/** The centre of the "LAB" plate in app_logo_05 pixels: the DEV marker covers it. */
const LAB_PLATE = { x: 925, y: 902 };
/** Maskable icons: the whole source at this share of the canvas (see the header). */
const MASKABLE_SCALE = 0.7;
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

/** Tab sizes: the symbol alone; DEV puts it on top and a yellow "DEV" band beneath. */
function symbolIcon(size, dev) {
  const { png, img } = source('app_logo_04.png');
  const b = I.opaqueBounds(png);
  const h = Math.round((size * b.sh) / b.sw);
  const out = I.image(size, size);
  I.drawOver(out, I.resample(img, b, size, h), 0, dev ? 0 : Math.floor((size - h) / 2));
  if (dev) {
    const cell = size / 16;
    const top = h;
    I.fillShape(out, (x, y) => y >= top, DEV_YELLOW, { x0: 0, y0: top, x1: size, y1: size });
    const textW = I.DEV_WORD_CELLS.w * cell;
    const textH = I.DEV_WORD_CELLS.h * cell;
    I.drawDevWord(
      out,
      Math.floor((size - textW) / 2),
      top + Math.floor((size - top - textH) / 2),
      cell,
      DEV_INK,
    );
  }
  return { img: out, opaque: false };
}

/** The app icon cropped to its rounded square. */
function tileIcon(size, dev) {
  const { img } = source('app_logo_05.png');
  const out = I.resample(img, TILE, size, size);
  if (dev)
    devPlate(
      out,
      ((LAB_PLATE.x - TILE.sx) / TILE.sw) * size,
      ((LAB_PLATE.y - TILE.sy) / TILE.sh) * size,
      Math.max(1, Math.floor(size / 48)),
    );
  return { img: out, opaque: true };
}

/** Maskable: the whole app icon at 70%, centred, its own edge pixels extended to the canvas. */
function maskableIcon(size, dev) {
  const { png, img } = source('app_logo_05.png');
  const inner = Math.round(size * MASKABLE_SCALE);
  const off = Math.floor((size - inner) / 2);
  const out = I.extendEdges(I.resample(img, undefined, inner, inner), size, size, off, off);
  // DEV: launchers show maskable icons at about 48 dp, where a plate the size of "LAB" is
  // unreadable; a large plate centred across the wordmark row ("TBI LAB") is, and stays inside
  // the safe zone (its farthest corner is about 0.32 of the canvas from the centre, < 0.40).
  if (dev)
    devPlate(out, size / 2, off + (LAB_PLATE.y / png.h) * inner, Math.floor((size * 0.42) / 15));
  return { img: out, opaque: true };
}

const ICONS = [
  ['favicon-16.png', (dev) => symbolIcon(16, dev), 'app_logo_04.png'],
  ['favicon-32.png', (dev) => symbolIcon(32, dev), 'app_logo_04.png'],
  ['favicon-48.png', (dev) => symbolIcon(48, dev), 'app_logo_04.png'],
  ['apple-touch-icon-180.png', (dev) => tileIcon(180, dev), 'app_logo_05.png'],
  ['icon-192.png', (dev) => tileIcon(192, dev), 'app_logo_05.png'],
  ['icon-512.png', (dev) => tileIcon(512, dev), 'app_logo_05.png'],
  ['maskable-192.png', (dev) => maskableIcon(192, dev), 'app_logo_05.png'],
  ['maskable-512.png', (dev) => maskableIcon(512, dev), 'app_logo_05.png'],
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

for (const variant of ['production', 'dev'])
  for (const [name, make, file] of ICONS) {
    const out = `src/assets/brand/icons/${variant}/${name}`;
    if (only && only !== out) continue;
    const { img, opaque } = make(variant === 'dev');
    write(out, I.encodePng(img.w, img.h, I.toRgba8(img), { opaque }), file);
  }
