/**
 * Build the web brand assets from the PM-provided TBI logo files (not committed; 1.1-1.4 MB
 * each). Run from app/ (so Playwright resolves):  node ../scripts/build-brand-assets.mjs <dir>
 *   <dir>/logo_rounded.png -> src/assets/brand/tbi-mark.png   (circle, transparent outside, 128 px;
 *                             a profile asset, not used in the product UI)
 *   <dir>/logo_main.png    -> src/assets/brand/tbi-logo.png   (elongated logo: auto-cropped to the
 *                             artwork, its painted navy background turned into real transparency by
 *                             colour-to-alpha against the measured background colour; 300 px tall,
 *                             shown at 150 px on the Projects screen, i.e. 2x for sharp displays)
 *   <dir>/logo_no_bg.png   -> src/assets/brand/tbi-logo-light.png (the same logo for light surfaces:
 *                             no alpha channel, a light checkerboard painted in; cleared by
 *                             colour-to-alpha towards dark; 120 px tall, top bar at 38 px,
 *                             also the favicon)
 * An optional second argument builds only that output path.
 * Chromium's canvas does the resampling (high-quality smoothing, halving steps).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const dir = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();

async function render(file, job) {
  const src = `data:image/png;base64,${readFileSync(`${dir}/${file}`).toString('base64')}`;
  const url = await page.evaluate(
    async ({ src, job }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      let crop = { x: 0, y: 0, w: img.width, h: img.height };
      if (job.key === 'measure') {
        // The background colour: the median of the four corner pixels' channels.
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const px = [
          [0, 0],
          [img.width - 1, 0],
          [0, img.height - 1],
          [img.width - 1, img.height - 1],
        ].map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]);
        job.key = [0, 1, 2].map((ch) => px.map((p) => p[ch]).sort((a, b) => a - b)[1]);
      }
      if (job.autocrop) {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        const [br, bg, bb] = [d[0], d[1], d[2]];
        let x0 = img.width,
          y0 = img.height,
          x1 = 0,
          y1 = 0;
        for (let y = 0; y < img.height; y++)
          for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > 60) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        const pad = job.autocrop;
        crop = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: 0, h: 0 };
        crop.w = Math.min(img.width, x1 + pad) - crop.x;
        crop.h = Math.min(img.height, y1 + pad) - crop.y;
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
      if (job.circle) {
        g.beginPath();
        g.arc(outW / 2, outH / 2, outW / 2 - 0.5, 0, Math.PI * 2);
        g.clip();
      }
      g.drawImage(cur, 0, 0, outW, outH);
      if (job.key) {
        // Colour-to-alpha (the classic un-blend): every pixel is treated as artwork colour A
        // over the measured background B with opacity a, C = a*A + (1-a)*B. a is the smallest
        // opacity that explains C with an in-gamut A; A is then recovered exactly. The painted
        // background becomes transparent, glows become translucent, nothing is redrawn.
        // The background's own texture (grain, faint glow) up to job.floor opacity is cleared.
        const img2 = g.getImageData(0, 0, outW, outH);
        const d = img2.data;
        const B = job.key;
        for (let i = 0; i < d.length; i += 4) {
          let a = 0;
          for (let c = 0; c < 3; c++) {
            const v = d[i + c];
            // Light-on-dark artwork: only brightness above the background is artwork.
            // (Darker-than-background grain would otherwise become opaque dark speckles, since
            // a near-zero channel turns a 2-level dip into a large ratio.) Dark-on-light artwork
            // (job.light): only darkness below the background is artwork, towards black.
            const ac = job.light
              ? v < B[c]
                ? (B[c] - v) / B[c]
                : 0
              : v > B[c]
                ? (v - B[c]) / (255 - B[c])
                : 0;
            if (ac > a) a = ac;
          }
          if (a <= job.floor) {
            d[i + 3] = 0;
            continue;
          }
          for (let c = 0; c < 3; c++) {
            d[i + c] = Math.max(0, Math.min(255, Math.round((d[i + c] - B[c]) / a + B[c])));
          }
          // Soft floor: opacities just above the painted background's texture fade in linearly
          // instead of being cut, so glow edges stay smooth.
          d[i + 3] = Math.round(((a - job.floor) / (1 - job.floor)) * 255);
        }
        g.putImageData(img2, 0, 0);
      }
      return out.toDataURL('image/png');
    },
    { src, job },
  );
  return Buffer.from(url.split(',')[1], 'base64');
}

const only = process.argv[3]; // optional: build just this output path
const outputs = [
  ['logo_rounded.png', { height: 128, circle: true }, 'src/assets/brand/tbi-mark.png'],
  [
    'logo_main.png',
    { height: 300, autocrop: 24, key: 'measure', floor: 0.03 },
    'src/assets/brand/tbi-logo.png',
  ],
  // The same regular logo for light surfaces (the top bar): the PM's light-background version,
  // whose painted checkerboard (~248/252 grey) is cleared by the floor.
  [
    'logo_no_bg.png',
    { height: 120, autocrop: 12, key: 'measure', floor: 0.06, light: true },
    'src/assets/brand/tbi-logo-light.png',
  ],
];
for (const [file, job, out] of outputs.filter(([, , o]) => !only || o === only)) {
  const png = await render(file, job);
  writeFileSync(out, png);
  const sha = createHash('sha256')
    .update(readFileSync(`${dir}/${file}`))
    .digest('hex');
  console.log(`${out}: ${png.length} bytes from ${file} (sha256 ${sha})`);
}
await browser.close();
