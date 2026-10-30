/**
 * 2026-10-29 owner decisions: sharp application icons with a web app manifest, DEV-Lab clearly
 * marked (environment.ts, brand.config.ts), and the screen support policy (screenSupport.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brandAssets } from '../brand.config.js';
import { appNames, documentTitle, parseTbiEnv } from '../src/environment.js';
import { screenSupport } from '../src/ui/screenSupport.js';

const ROOT = new URL('../', import.meta.url);
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

describe('the environment flag', () => {
  it('is production unless exactly "dev"; anything else fails the build', () => {
    expect(parseTbiEnv(undefined)).toBe('production');
    expect(parseTbiEnv('')).toBe('production');
    expect(parseTbiEnv('dev')).toBe('dev');
    for (const bad of ['DEV', ' dev', 'prod', 'production', '1', 'true'])
      expect(() => parseTbiEnv(bad, 'VITE_TBI_ENV')).toThrow(/VITE_TBI_ENV must be unset or "dev"/);
    // The app's own call names no VITE_ setting (check-dist refuses a bundle that does).
    expect(() => parseTbiEnv('x')).toThrow(/^the environment setting must be/);
  });

  it('titles: "[DEV] " first on DEV; production unchanged; previews keep their name', () => {
    expect(documentTitle('production')).toBe('TBI Lab');
    expect(documentTitle('dev')).toBe('[DEV] TBI Lab');
    expect(documentTitle('production', 'Sprint 9')).toBe('Sprint 9 preview · TBI Lab');
    expect(documentTitle('dev', 'Sprint 9')).toBe('[DEV] Sprint 9 preview · TBI Lab');
    expect(appNames('production')).toEqual({ name: 'TBI Lab', shortName: 'TBI Lab' });
    expect(appNames('dev')).toEqual({ name: 'TBI Lab DEV', shortName: 'TBI Lab DEV' });
  });
});

describe('icons and the web app manifest', () => {
  for (const env of ['production', 'dev'] as const)
    it(`${env}: favicons 16/32/48, apple-touch-icon 180, manifest any + maskable 192/512`, () => {
      const { files, tags, manifest } = brandAssets(ROOT, env);
      const byName = new Map(files.map((f) => [`/${f.fileName}`, f.source]));
      // Content-hashed names under assets/ (the deployment caches assets/ as immutable).
      for (const f of files)
        expect(f.fileName).toMatch(/^assets\/[a-z0-9-]+-[0-9a-f]{8}\.(png|json)$/);
      const links = tags.map((t) => t.attrs as Record<string, string>);
      const icons = links.filter((a) => a.rel === 'icon');
      expect(icons.map((a) => a.sizes)).toEqual(['16x16', '32x32', '48x48']);
      const apple = links.filter((a) => a.rel === 'apple-touch-icon');
      expect(apple.map((a) => a.sizes)).toEqual(['180x180']);
      for (const a of [...icons, ...apple])
        expect(pngSize(byName.get(a.href!)!).join('x')).toBe(a.sizes);
      const link = links.find((a) => a.rel === 'manifest')!;
      expect(link.crossorigin).toBe('use-credentials');
      expect(JSON.parse(byName.get(link.href!)!.toString())).toEqual(manifest);
      expect(manifest).toMatchObject({
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        name: appNames(env).name,
        short_name: appNames(env).shortName,
        background_color: '#0a1a33',
        theme_color: env === 'dev' ? '#ffcc00' : '#0a1a33',
      });
      expect(manifest.icons.map((i) => `${i.purpose} ${i.sizes}`)).toEqual([
        'any 192x192',
        'any 512x512',
        'maskable 192x192',
        'maskable 512x512',
      ]);
      for (const i of manifest.icons) expect(pngSize(byName.get(i.src)!).join('x')).toBe(i.sizes);
      expect(links.find((a) => a.name === 'apple-mobile-web-app-title')?.content).toBe(
        appNames(env).shortName,
      );
    });

  it('the DEV set differs from production in every icon; the names are stable across builds', () => {
    const prod = brandAssets(ROOT, 'production');
    const dev = brandAssets(ROOT, 'dev');
    expect(brandAssets(ROOT, 'production').files.map((f) => f.fileName)).toEqual(
      prod.files.map((f) => f.fileName),
    );
    prod.files.forEach((f, i) => expect(f.source.equals(dev.files[i]!.source)).toBe(false));
  });

  it('the app and Apple icons are opaque (iOS fills transparency black); favicons keep alpha', () => {
    const dir = new URL('src/assets/brand/icons/production/', ROOT);
    const colourType = (name: string) => readFileSync(new URL(name, dir))[25];
    for (const n of ['favicon-16.png', 'favicon-32.png']) expect(colourType(n)).toBe(6);
    for (const n of ['apple-touch-icon-180.png', 'icon-512.png', 'maskable-512.png'])
      expect(colourType(n)).toBe(2);
  });

  it('the source HTML has no hard-coded icon link left (the plugin adds the set)', () => {
    const html = readFileSync(new URL('index.html', ROOT), 'utf8');
    expect(html).not.toMatch(/rel="(icon|apple-touch-icon|manifest)"/);
    expect(html).toContain('<title>TBI Lab</title>');
  });
});

describe('screen support policy', () => {
  // [width, height, coarse pointer, expected]
  const cases: [string, number, number, boolean, string][] = [
    ['desktop 1400 x 860', 1400, 860, false, 'ok'],
    ['desktop at the narrowest layout, 1024 x 768', 1024, 768, false, 'ok'],
    ['short desktop window 1400 x 560 (not a phone)', 1400, 560, false, 'ok'],
    ['narrow desktop window 900 x 800', 900, 800, false, 'narrow'],
    ['tall narrow desktop window 900 x 1000 (mouse)', 900, 1000, false, 'narrow'],
    ['Galaxy Tab S4 landscape 1138 x 712', 1138, 712, true, 'ok'],
    ['Galaxy Tab S4 portrait 712 x 1138', 712, 1138, true, 'rotate'],
    ['iPad (gen 7) landscape 1080 x 810', 1080, 810, true, 'ok'],
    ['iPad (gen 7) portrait 810 x 1080', 810, 1080, true, 'rotate'],
    ['iPad mini portrait 744 x 1133', 744, 1133, true, 'rotate'],
    ['iPad Pro 12.9 portrait 1024 x 1366', 1024, 1366, true, 'rotate'],
    ['iPad Pro 12.9 landscape 1366 x 1024', 1366, 1024, true, 'ok'],
    ['7-inch Android tablet portrait 600 x 960', 600, 960, true, 'rotate'],
    ['7-inch Android tablet landscape 960 x 600', 960, 600, true, 'narrow'],
    ['Pixel 7 portrait 412 x 915', 412, 915, true, 'phone'],
    ['Pixel 7 landscape 915 x 412', 915, 412, true, 'phone'],
    ['iPhone 15 Pro Max landscape 932 x 430', 932, 430, true, 'phone'],
    ['phone-size desktop window 500 x 900', 500, 900, false, 'phone'],
  ];
  for (const [name, w, h, coarse, want] of cases)
    it(`${name}: ${want}`, () => expect(screenSupport(w, h, coarse)).toBe(want));
});
