/** The deterministic image operations behind the application icons (scripts/brand-image.mjs). */
import { describe, expect, it } from 'vitest';
import * as I from '../brand-image.mjs';

const rgba = (w, h, f) => {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(f(x, y), (y * w + x) * 4);
  return b;
};

describe('brand image operations', () => {
  it('PNG encode/decode round-trips RGBA and RGB exactly, with an explicit sRGB chunk', () => {
    const px = rgba(7, 5, (x, y) => [x * 30, y * 50, (x * y) % 256, 255 - x]);
    const png = I.encodePng(7, 5, px);
    expect(png.includes(Buffer.from('sRGB'))).toBe(true);
    expect(I.decodePng(png)).toMatchObject({ w: 7, h: 5, colorType: 6 });
    expect(I.decodePng(png).rgba.equals(px)).toBe(true);
    const opaque = rgba(4, 3, (x, y) => [x * 60, y * 90, 7, 255]);
    const rgb = I.encodePng(4, 3, opaque, { opaque: true });
    expect(I.decodePng(rgb)).toMatchObject({ colorType: 2 });
    expect(I.decodePng(rgb).rgba.equals(opaque)).toBe(true);
    expect(() => I.encodePng(7, 5, px, { opaque: true })).toThrow(/not opaque/);
  });

  it('the same input gives the same bytes (deterministic)', () => {
    const src = I.fromRgba8({
      w: 40,
      h: 40,
      rgba: rgba(40, 40, (x, y) => [x * 6, y * 6, 128, 255]),
    });
    const a = I.encodePng(16, 16, I.toRgba8(I.resample(src, undefined, 16, 16)));
    const b = I.encodePng(16, 16, I.toRgba8(I.resample(src, undefined, 16, 16)));
    expect(a.equals(b)).toBe(true);
  });

  it('a flat colour stays exactly that colour at any scale (normalised filter, no drift)', () => {
    const src = I.fromRgba8({ w: 50, h: 30, rgba: rgba(50, 30, () => [10, 26, 51, 255]) });
    for (const [w, h] of [
      [16, 16],
      [7, 3],
      [100, 60],
    ]) {
      const out = I.toRgba8(I.resample(src, undefined, w, h));
      for (let i = 0; i < w * h; i++)
        expect([...out.subarray(i * 4, i * 4 + 4)]).toEqual([10, 26, 51, 255]);
    }
  });

  it('averages in linear light: a 1-px white/black stripe pattern halves to sRGB 188, not 128', () => {
    const src = I.fromRgba8({
      w: 64,
      h: 2,
      rgba: rgba(64, 2, (x) => (x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
    });
    // Downscaling by an even factor averages each stripe pair: 50% linear light.
    const out = I.toRgba8(I.resample(src, undefined, 8, 2));
    expect(out[4 * 3]).toBeGreaterThanOrEqual(186);
    expect(out[4 * 3]).toBeLessThanOrEqual(190);
  });

  it('transparent pixels add no colour (premultiplied alpha); bounds trim only transparent margins', () => {
    const px = rgba(10, 10, (x, y) =>
      x >= 3 && x < 7 && y >= 2 && y < 9 ? [255, 0, 0, 255] : [0, 255, 0, 0],
    );
    expect(I.opaqueBounds({ w: 10, h: 10, rgba: px })).toEqual({ sx: 3, sy: 2, sw: 4, sh: 7 });
    const out = I.toRgba8(I.resample(I.fromRgba8({ w: 10, h: 10, rgba: px }), undefined, 5, 5));
    for (let i = 0; i < 25; i++) if (out[i * 4 + 3] > 0) expect(out[i * 4 + 1]).toBe(0);
  });

  it('the DEV word is crisp: whole-pixel cells at cell size 1 (16 px favicon)', () => {
    const img = I.image(13, 5, [255, 204, 0, 255]);
    I.drawDevWord(img, 0, 0, 1, [17, 17, 17]);
    const out = I.toRgba8(img);
    const row0 = [...Array(13)].map((_, x) =>
      out[x * 4] === 17 ? 'X' : out[x * 4] === 255 ? '.' : '?',
    );
    // D (XX.), a blank column, E (XXX), a blank column, V (X...X), whose point is row 4 (..X..).
    expect(row0.join('')).toBe('XX..XXX.X...X');
    const row4 = [...Array(13)].map((_, x) => (out[(4 * 13 + x) * 4] === 17 ? 'X' : '.'));
    expect(row4.join('')).toBe('XX..XXX...X..');
  });
});
