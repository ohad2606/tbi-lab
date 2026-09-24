/**
 * Build the web brand assets from the PM-provided TBI logo files (not committed; 1.1-1.4 MB
 * each). Run from app/ (so Playwright resolves):  node ../scripts/build-brand-assets.mjs <dir>
 *   <dir>/logo_rounded.png -> src/assets/brand/tbi-mark.png   (circle, transparent outside, 128 px)
 *                          -> public/favicon.png              (64 px)
 *   <dir>/logo_main.png    -> src/assets/brand/tbi-logo.png   (auto-cropped to the artwork, 200 px tall)
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
      return out.toDataURL('image/png');
    },
    { src, job },
  );
  return Buffer.from(url.split(',')[1], 'base64');
}

const outputs = [
  ['logo_rounded.png', { height: 128, circle: true }, 'src/assets/brand/tbi-mark.png'],
  ['logo_rounded.png', { height: 64, circle: true }, 'public/favicon.png'],
  ['logo_main.png', { height: 200, autocrop: 24 }, 'src/assets/brand/tbi-logo.png'],
];
for (const [file, job, out] of outputs) {
  const png = await render(file, job);
  writeFileSync(out, png);
  const sha = createHash('sha256')
    .update(readFileSync(`${dir}/${file}`))
    .digest('hex');
  console.log(`${out}: ${png.length} bytes from ${file} (sha256 ${sha})`);
}
await browser.close();
