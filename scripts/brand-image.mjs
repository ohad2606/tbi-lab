/**
 * Deterministic image operations for the brand icon set (scripts/build-brand-assets.mjs). Node
 * built-ins only, so the output depends on this code and the source bytes, not on a browser's
 * canvas implementation.
 *
 * - PNG decode (8-bit truecolour, with or without alpha, non-interlaced: what the owner's package
 *   uses) and encode (an explicit sRGB chunk, maximum zlib compression).
 * - Resampling: separable Lanczos-3, widened by the scale factor for downscaling, in LINEAR light
 *   with premultiplied alpha. Averaging gamma-encoded values (what a browser canvas does) darkens
 *   thin bright strokes against a dark ground: exactly the neon lines of the TBI Lab artwork.
 * - Compositing (source-over, linear light) and a small anti-aliased rasterizer (fixed 8 x 8
 *   supersampling) for the DEV marker, which is drawn over the artwork, never into it.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// sRGB transfer function (IEC 61966-2-1).
const TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** Linear [0,1] to the nearest 8-bit sRGB code value. */
function toSrgb8(v) {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
}

/** An image in premultiplied linear-light RGBA, Float64Array of w*h*4. */
export function image(w, h, fill = [0, 0, 0, 0]) {
  const data = new Float64Array(w * h * 4);
  const [r, g, b, a] = fill;
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = TO_LINEAR[r] * (a / 255);
    data[i * 4 + 1] = TO_LINEAR[g] * (a / 255);
    data[i * 4 + 2] = TO_LINEAR[b] * (a / 255);
    data[i * 4 + 3] = a / 255;
  }
  return { w, h, data };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Decode a PNG into 8-bit RGBA (and report its colour type). */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let o = 8,
    w = 0,
    h = 0,
    depth = 0,
    type = 0,
    interlace = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('latin1', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0)
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${interlace}`);
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = px[i * bpp];
    rgba[i * 4 + 1] = px[i * bpp + 1];
    rgba[i * 4 + 2] = px[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255;
  }
  return { w, h, rgba, colorType: type };
}

/** 8-bit sRGB RGBA to the working representation. */
export function fromRgba8({ w, h, rgba }) {
  const data = new Float64Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    data[i * 4] = TO_LINEAR[rgba[i * 4]] * a;
    data[i * 4 + 1] = TO_LINEAR[rgba[i * 4 + 1]] * a;
    data[i * 4 + 2] = TO_LINEAR[rgba[i * 4 + 2]] * a;
    data[i * 4 + 3] = a;
  }
  return { w, h, data };
}

/** Working representation to 8-bit sRGB RGBA. */
export function toRgba8({ w, h, data }) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, Math.max(0, data[i * 4 + 3]));
    const a8 = Math.round(a * 255);
    out[i * 4 + 3] = a8;
    if (a8 === 0) continue;
    for (let k = 0; k < 3; k++) out[i * 4 + k] = toSrgb8(data[i * 4 + k] / a);
  }
  return out;
}

/** Encode 8-bit RGBA; `opaque` writes colour type 2 (RGB) and requires alpha 255 everywhere. */
export function encodePng(w, h, rgba, { opaque = false } = {}) {
  const bpp = opaque ? 3 : 4;
  const raw = Buffer.alloc(h * (w * bpp + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * bpp + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      if (opaque && rgba[s + 3] !== 255) throw new Error(`pixel ${x},${y} is not opaque`);
      for (let k = 0; k < bpp; k++) raw[y * (w * bpp + 1) + 1 + x * bpp + k] = rgba[s + k];
    }
  }
  const chunk = (kind, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const kb = Buffer.from(kind, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kb, body])));
    return Buffer.concat([len, kb, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    // sRGB, perceptual intent: the pixels are sRGB, said explicitly rather than assumed.
    chunk('sRGB', Buffer.from([0])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lanczos3 = (x) => {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};

/** Filter taps for resampling `n` source samples (from `start`) to `m` outputs. */
function taps(start, n, m) {
  const scale = n / m;
  const widen = Math.max(1, scale);
  const support = 3 * widen;
  const out = [];
  for (let i = 0; i < m; i++) {
    const center = start + (i + 0.5) * scale;
    const lo = Math.floor(center - support);
    const hi = Math.ceil(center + support);
    const idx = [];
    const wts = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      const wgt = lanczos3((j + 0.5 - center) / widen);
      if (wgt === 0) continue;
      // Edge pixels repeat: the crop's own border, never pixels outside it.
      idx.push(Math.min(start + n - 1, Math.max(start, j)));
      wts.push(wgt);
      sum += wgt;
    }
    out.push({ idx, wts: wts.map((v) => v / sum) });
  }
  return out;
}

/** Resample the crop (sx, sy, sw, sh) of `src` to dw x dh. */
export function resample(src, { sx = 0, sy = 0, sw = src.w, sh = src.h } = {}, dw, dh) {
  const tx = taps(sx, sw, dw);
  const ty = taps(sy, sh, dh);
  // Horizontal pass over the rows the vertical pass needs.
  const tmp = new Float64Array(dw * src.h * 4);
  const rowsNeeded = new Set(ty.flatMap((t) => t.idx));
  for (const y of rowsNeeded)
    for (let x = 0; x < dw; x++) {
      const { idx, wts } = tx[x];
      for (let k = 0; k < 4; k++) {
        let s = 0;
        for (let t = 0; t < idx.length; t++) s += src.data[(y * src.w + idx[t]) * 4 + k] * wts[t];
        tmp[(y * dw + x) * 4 + k] = s;
      }
    }
  const out = new Float64Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const { idx, wts } = ty[y];
    for (let x = 0; x < dw; x++) {
      let a = 0;
      const c = [0, 0, 0];
      for (let t = 0; t < idx.length; t++) {
        const o = (idx[t] * dw + x) * 4;
        c[0] += tmp[o] * wts[t];
        c[1] += tmp[o + 1] * wts[t];
        c[2] += tmp[o + 2] * wts[t];
        a += tmp[o + 3] * wts[t];
      }
      // Lanczos rings: clamp to a valid premultiplied pixel.
      a = Math.min(1, Math.max(0, a));
      const o = (y * dw + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = Math.min(a, Math.max(0, c[k]));
      out[o + 3] = a;
    }
  }
  return { w: dw, h: dh, data: out };
}

/** Composite `top` over `dst` at integer offset (x, y), in place. */
export function drawOver(dst, top, x0, y0) {
  for (let y = 0; y < top.h; y++)
    for (let x = 0; x < top.w; x++) {
      const dx = x + x0,
        dy = y + y0;
      if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h) continue;
      const s = (y * top.w + x) * 4;
      const d = (dy * dst.w + dx) * 4;
      const ia = 1 - top.data[s + 3];
      for (let k = 0; k < 4; k++) dst.data[d + k] = top.data[s + k] + dst.data[d + k] * ia;
    }
  return dst;
}

/**
 * Place `src` at integer offset (x0, y0) on a w x h canvas and fill the rest by extending its own
 * edge pixels outward (clamp to edge): every output pixel is a source pixel, so there is no seam
 * where the artwork's (not quite black) margin meets a flat background.
 */
export function extendEdges(src, w, h, x0, y0) {
  const out = image(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.max(0, x - x0));
      const sy = Math.min(src.h - 1, Math.max(0, y - y0));
      const s = (sy * src.w + sx) * 4;
      const d = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = src.data[s + k];
    }
  return out;
}

/** The bounds of every pixel with any opacity (fully transparent margins removed). */
export function opaqueBounds({ w, h, rgba }) {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return { sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 };
}

const SS = 8; // supersampling grid per pixel axis

/**
 * Fill a shape (inside(x, y) in pixel coordinates, continuous) with an 8-bit sRGB colour, over
 * `dst`, with coverage from a fixed 8 x 8 sample grid. `box` bounds the pixels examined.
 */
export function fillShape(dst, inside, [r, g, b], { x0, y0, x1, y1 }) {
  const lin = [TO_LINEAR[r], TO_LINEAR[g], TO_LINEAR[b]];
  for (let py = Math.max(0, Math.floor(y0)); py < Math.min(dst.h, Math.ceil(y1)); py++)
    for (let px = Math.max(0, Math.floor(x0)); px < Math.min(dst.w, Math.ceil(x1)); px++) {
      let n = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) if (inside(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) n++;
      if (!n) continue;
      const cov = n / (SS * SS);
      const d = (py * dst.w + px) * 4;
      for (let k = 0; k < 3; k++) dst.data[d + k] = lin[k] * cov + dst.data[d + k] * (1 - cov);
      dst.data[d + 3] = cov + dst.data[d + 3] * (1 - cov);
    }
}

/** Inside test for a rounded rectangle. */
export function roundedRect(x0, y0, x1, y1, radius) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };
}

/**
 * "DEV" on a 5-row cell grid (one blank column between letters): D and E 3 cells wide, V 5 cells
 * wide so its point is visible (a 3-wide V reads as "U" at 16-32 px); 13 x 5 cells. Cells map to
 * whole pixels at every size, so the word stays crisp down to a 16 px favicon.
 */
const DEV_GLYPHS = [
  ['XX.', 'X.X', 'X.X', 'X.X', 'XX.'],
  ['XXX', 'X..', 'XX.', 'X..', 'XXX'],
  ['X...X', 'X...X', '.X.X.', '.X.X.', '..X..'],
];
export const DEV_WORD_CELLS = {
  w: DEV_GLYPHS.reduce((n, g) => n + g[0].length, 0) + DEV_GLYPHS.length - 1,
  h: 5,
};

/** Draw "DEV" with its top-left corner at (x, y), `cell` pixels per grid cell. */
export function drawDevWord(dst, x, y, cell, rgb) {
  const cells = [];
  let left = 0;
  for (const rows of DEV_GLYPHS) {
    rows.forEach((row, ry) =>
      [...row].forEach((ch, rx) => {
        if (ch === 'X') cells.push([x + (left + rx) * cell, y + ry * cell]);
      }),
    );
    left += rows[0].length + 1;
  }
  const inside = (px, py) =>
    cells.some(([cx, cy]) => px >= cx && px < cx + cell && py >= cy && py < cy + cell);
  fillShape(dst, inside, rgb, {
    x0: x,
    y0: y,
    x1: x + DEV_WORD_CELLS.w * cell,
    y1: y + DEV_WORD_CELLS.h * cell,
  });
}
