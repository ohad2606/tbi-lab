/**
 * Application icons and the web app manifest (production only). The PNGs and the .ico are committed
 * (src/assets/brand/icons/production/, made from the owner's logo package; see the README beside
 * them). A desktop takes its taskbar and shortcut sizes from the manifest and scales down from the
 * nearest larger icon when one is missing, so the sizes it uses are all listed.
 *
 * Every file is emitted under assets/ with a content hash in its name, so the deployment's cache
 * rule for assets/ ("immutable") is safe, a new icon or manifest is a new URL, and two builds of the
 * same source give the same names. The entry HTML (never cached) links them. The manifest says
 * `"id": "/"`, so an installed app keeps its identity when the manifest's URL changes.
 *
 * The manifest link carries crossorigin="use-credentials": browsers fetch a manifest WITHOUT cookies
 * otherwise, and every request to a TBI Lab deployment passes the sign-in gate, so the browser would
 * get the sign-in redirect instead of the manifest. The file is `.json`, not `.webmanifest`: Caddy's
 * file server has no type for `.webmanifest`; `.json` gets application/json, which browsers accept.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { HtmlTagDescriptor, Plugin } from 'vite';

const NAME = 'TBI Lab';
const NAVY = '#0a1a33'; // --brand-navy (styles.css), the app icon's ground

type Role = 'favicon' | 'apple-touch-icon' | 'any' | 'maskable';
const ICONS: readonly { file: string; size: number; role: Role }[] = [
  { file: 'favicon-16.png', size: 16, role: 'favicon' },
  { file: 'favicon-24.png', size: 24, role: 'favicon' },
  { file: 'favicon-32.png', size: 32, role: 'favicon' },
  { file: 'favicon-48.png', size: 48, role: 'favicon' },
  { file: 'favicon-64.png', size: 64, role: 'favicon' },
  { file: 'icon-96.png', size: 96, role: 'any' },
  { file: 'icon-128.png', size: 128, role: 'any' },
  { file: 'apple-touch-icon-180.png', size: 180, role: 'apple-touch-icon' },
  { file: 'icon-192.png', size: 192, role: 'any' },
  { file: 'icon-256.png', size: 256, role: 'any' },
  { file: 'icon-512.png', size: 512, role: 'any' },
  { file: 'maskable-192.png', size: 192, role: 'maskable' },
  { file: 'maskable-512.png', size: 512, role: 'maskable' },
];

const hashed = (stem: string, ext: string, source: Buffer) =>
  `assets/${stem}-${createHash('sha256').update(source).digest('hex').slice(0, 8)}.${ext}`;

/** Everything the branding adds to a build: files, head tags, the manifest. */
export function brandAssets(root: URL, base = '/') {
  const dir = new URL('src/assets/brand/icons/production/', root);
  const icons = ICONS.map((icon) => {
    const source = readFileSync(new URL(icon.file, dir));
    return { ...icon, source, fileName: hashed(icon.file.replace(/\.png$/, ''), 'png', source) };
  });
  const url = (fileName: string) => `${base}${fileName}`;
  const manifest = {
    id: '/',
    name: NAME,
    short_name: NAME,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: NAVY,
    theme_color: NAVY,
    icons: icons
      .filter((i) => i.role !== 'apple-touch-icon')
      .map((i) => ({
        src: url(i.fileName),
        sizes: `${i.size}x${i.size}`,
        type: 'image/png',
        purpose: i.role === 'maskable' ? 'maskable' : 'any',
      })),
  };
  const manifestSource = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestName = hashed('manifest', 'json', manifestSource);
  const ico = readFileSync(new URL('favicon.ico', dir));
  const icoName = hashed('favicon', 'ico', ico);
  const files = [
    ...icons.map((i) => ({ fileName: i.fileName, source: i.source })),
    { fileName: icoName, source: ico },
    { fileName: manifestName, source: manifestSource },
  ];
  const tags: HtmlTagDescriptor[] = [
    ...icons
      .filter((i) => i.role === 'favicon')
      .map((i) => ({
        tag: 'link',
        attrs: {
          rel: 'icon',
          type: 'image/png',
          sizes: `${i.size}x${i.size}`,
          href: url(i.fileName),
        },
      })),
    {
      tag: 'link',
      attrs: {
        rel: 'icon',
        type: 'image/x-icon',
        sizes: '16x16 24x24 32x32 48x48 64x64 256x256',
        href: url(icoName),
      },
    },
    ...icons
      .filter((i) => i.role === 'apple-touch-icon')
      .map((i) => ({
        tag: 'link',
        attrs: { rel: 'apple-touch-icon', sizes: `${i.size}x${i.size}`, href: url(i.fileName) },
      })),
    {
      tag: 'link',
      attrs: { rel: 'manifest', href: url(manifestName), crossorigin: 'use-credentials' },
    },
    { tag: 'meta', attrs: { name: 'theme-color', content: NAVY } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: NAME } },
  ];
  return { files, tags, manifest };
}

/** The Vite plugin: emits the files and links them from the HTML. */
export function brandPlugin(root: URL): Plugin {
  let base = '/';
  let assets = brandAssets(root, base);
  return {
    name: 'tbi-brand',
    configResolved(config) {
      base = config.base;
      assets = brandAssets(root, base);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = assets.files.find((f) => `${base}${f.fileName}` === req.url?.split('?')[0]);
        if (!file) return next();
        res.setHeader(
          'Content-Type',
          file.fileName.endsWith('.png')
            ? 'image/png'
            : file.fileName.endsWith('.ico')
              ? 'image/x-icon'
              : 'application/manifest+json',
        );
        res.end(file.source);
      });
    },
    generateBundle() {
      for (const f of assets.files)
        this.emitFile({ type: 'asset', fileName: f.fileName, source: f.source });
    },
    transformIndexHtml() {
      return assets.tags.map((t) => ({ ...t, injectTo: 'head' as const }));
    },
  };
}
