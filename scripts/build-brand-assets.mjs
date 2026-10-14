/**
 * Build the web brand assets from the official TBI Lab logo package (the `logo_app` set provided
 * by the owner, 2026-10-14; not committed, 1.3-1.9 MB each).
 * Run from app/ (so Playwright resolves):  node ../scripts/build-brand-assets.mjs ~/logo/logo_app
 *   app_logo_04.png -> src/assets/brand/tbi-lab-symbol.png  (the infinity symbol alone, transparent;
 *                      76 px tall, top bar at 38 px, i.e. 2x for sharp displays)
 *   app_logo_01.png -> src/assets/brand/tbi-lab-logo.png    (the full logo with the TBI LAB wordmark and
 *                      tagline, transparent; 300 px tall, Projects band at 150 px)
 *   app_logo_05.png -> src/assets/brand/tbi-lab-favicon.png (the dark app icon, 64 px; interim tab icon:
 *                      the package has no dedicated small-size favicon)
 * The artwork is used exactly as supplied: transparent files are only trimmed to their non-transparent
 * pixels (fully transparent margins removed, nothing visible cut), then scaled with the aspect ratio
 * kept. Nothing is recoloured, redrawn or made transparent.
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
  return Buffer.from(url.split(',')[1], 'base64');
}

const only = process.argv[3]; // optional: build just this output path
const outputs = [
  ['app_logo_04.png', { height: 76, trim: true }, 'src/assets/brand/tbi-lab-symbol.png'],
  ['app_logo_01.png', { height: 300, trim: true }, 'src/assets/brand/tbi-lab-logo.png'],
  ['app_logo_05.png', { height: 64 }, 'src/assets/brand/tbi-lab-favicon.png'],
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
