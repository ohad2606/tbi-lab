/** Application icons and the web app manifest: every desktop size, real sizes, stable names. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brandAssets } from '../brand.config.js';

const ROOT = new URL('../', import.meta.url);
const pngSize = (b: Buffer) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;

describe('icons and the web app manifest', () => {
  it('links and lists every size, each file its declared size, names content-hashed', () => {
    const { files, tags, manifest } = brandAssets(ROOT);
    const byName = new Map(files.map((f) => [`/${f.fileName}`, f.source]));
    for (const f of files)
      expect(f.fileName).toMatch(/^assets\/[a-z0-9-]+-[0-9a-f]{8}\.(png|json|ico)$/);
    const links = tags.map((t) => t.attrs as Record<string, string>);
    const icons = links.filter((a) => a.rel === 'icon');
    const ICO = '16x16 24x24 32x32 48x48 64x64 256x256';
    expect(icons.map((a) => a.sizes)).toEqual(['16x16', '24x24', '32x32', '48x48', '64x64', ICO]);
    for (const a of icons.filter((i) => i.sizes !== ICO))
      expect(pngSize(byName.get(a.href!)!)).toBe(a.sizes);
    const ico = byName.get(icons.find((i) => i.sizes === ICO)!.href!)!;
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 6]);
    const apple = links.find((a) => a.rel === 'apple-touch-icon')!;
    expect(pngSize(byName.get(apple.href!)!)).toBe('180x180');
    const link = links.find((a) => a.rel === 'manifest')!;
    expect(link.crossorigin).toBe('use-credentials');
    expect(JSON.parse(byName.get(link.href!)!.toString())).toEqual(manifest);
    expect(manifest).toMatchObject({
      id: '/',
      name: 'TBI Lab',
      short_name: 'TBI Lab',
      display: 'standalone',
      theme_color: '#0a1a33',
      background_color: '#0a1a33',
    });
    expect(manifest.icons.map((i) => `${i.purpose} ${i.sizes}`)).toEqual([
      'any 16x16',
      'any 24x24',
      'any 32x32',
      'any 48x48',
      'any 64x64',
      'any 96x96',
      'any 128x128',
      'any 192x192',
      'any 256x256',
      'any 512x512',
      'maskable 192x192',
      'maskable 512x512',
    ]);
    for (const i of manifest.icons) expect(pngSize(byName.get(i.src)!)).toBe(i.sizes);
  });

  it('Apple and maskable icons are opaque (iOS fills transparency black); the others have alpha', () => {
    const dir = new URL('src/assets/brand/icons/production/', ROOT);
    const colourType = (name: string) => readFileSync(new URL(name, dir))[25];
    for (const n of ['favicon-16.png', 'favicon-32.png', 'icon-96.png', 'icon-512.png'])
      expect(colourType(n)).toBe(6);
    for (const n of ['apple-touch-icon-180.png', 'maskable-512.png']) expect(colourType(n)).toBe(2);
  });

  it('the source HTML has no hard-coded icon link left (the plugin adds the set)', () => {
    const html = readFileSync(new URL('index.html', ROOT), 'utf8');
    expect(html).not.toMatch(/rel="(icon|apple-touch-icon|manifest)"/);
  });
});
