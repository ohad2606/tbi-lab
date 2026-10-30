/**
 * Application icons and the web app manifest (2026-10-29), for one environment (environment.ts):
 * the production set, or on DEV-Lab builds the DEV set (the same icons with a yellow DEV marker),
 * never both. The PNGs are committed (src/assets/brand/icons/<env>/, made by
 * scripts/build-brand-assets.mjs from the owner's logo package).
 *
 * Every file is emitted under assets/ with a content hash in its name, so the deployment's cache
 * rule for assets/ ("immutable", deploy/dev-lab/Caddyfile) is safe, a new icon or manifest is a new
 * URL, and two builds of the same source give the same names (no bundler-assigned ids). The entry
 * HTML (never cached) links them. The manifest says `"id": "/"`, so an installed app keeps its
 * identity when the manifest's URL changes.
 *
 * The manifest link carries crossorigin="use-credentials": browsers fetch a manifest WITHOUT
 * cookies otherwise, and every request to a TBI Lab deployment passes the sign-in gate, so the
 * browser would get the sign-in redirect instead of the manifest (and no installable icons).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { HtmlTagDescriptor, Plugin } from 'vite';
import {
  BRAND_COLOURS,
  PRODUCT_NAME,
  appNames,
  documentTitle,
  type TbiEnvironment,
} from './src/environment.js';

type Role = 'favicon' | 'apple-touch-icon' | 'any' | 'maskable';
const ICONS: readonly { file: string; size: number; role: Role }[] = [
  { file: 'favicon-16.png', size: 16, role: 'favicon' },
  { file: 'favicon-32.png', size: 32, role: 'favicon' },
  { file: 'favicon-48.png', size: 48, role: 'favicon' },
  { file: 'apple-touch-icon-180.png', size: 180, role: 'apple-touch-icon' },
  { file: 'icon-192.png', size: 192, role: 'any' },
  { file: 'icon-512.png', size: 512, role: 'any' },
  { file: 'maskable-192.png', size: 192, role: 'maskable' },
  { file: 'maskable-512.png', size: 512, role: 'maskable' },
];

export interface BrandFile {
  /** The output path, e.g. assets/favicon-32-0123abcd.png. */
  fileName: string;
  source: Buffer;
}

const hashed = (stem: string, ext: string, source: Buffer) =>
  `assets/${stem}-${createHash('sha256').update(source).digest('hex').slice(0, 8)}.${ext}`;

/** The icon directory of an environment. */
export const iconDir = (root: URL, env: TbiEnvironment) =>
  new URL(`src/assets/brand/icons/${env}/`, root);

/** Everything the environment's branding adds to a build: files, head tags, the manifest. */
export function brandAssets(root: URL, env: TbiEnvironment, base = '/') {
  const icons = ICONS.map((icon) => {
    const source = readFileSync(new URL(icon.file, iconDir(root, env)));
    return { ...icon, source, fileName: hashed(icon.file.replace(/\.png$/, ''), 'png', source) };
  });
  const url = (fileName: string) => `${base}${fileName}`;
  const names = appNames(env);
  const theme = env === 'dev' ? BRAND_COLOURS.devYellow : BRAND_COLOURS.navy;
  const manifest = {
    id: '/',
    name: names.name,
    short_name: names.shortName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BRAND_COLOURS.navy,
    theme_color: theme,
    icons: icons
      .filter((i) => i.role === 'any' || i.role === 'maskable')
      .map((i) => ({
        src: url(i.fileName),
        sizes: `${i.size}x${i.size}`,
        type: 'image/png',
        purpose: i.role,
      })),
  };
  const manifestSource = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  // Sprint 25: `.json`, not `.webmanifest`: a static file server's MIME table (Go's, under Caddy)
  // has no type for `.webmanifest` and served it with none; `.json` gets application/json, which
  // browsers accept for a manifest. No server configuration changes.
  const manifestName = hashed('manifest', 'json', manifestSource);
  const files: BrandFile[] = [
    ...icons.map((i) => ({ fileName: i.fileName, source: i.source })),
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
    { tag: 'meta', attrs: { name: 'theme-color', content: theme } },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: names.shortName } },
  ];
  return { files, tags, manifest };
}

/** The Vite plugin: emits the files, links them from the HTML, and brands the title on DEV. */
export function brandPlugin(root: URL, env: TbiEnvironment): Plugin {
  let base = '/';
  let assets = brandAssets(root, env, base);
  return {
    name: 'tbi-brand',
    configResolved(config) {
      base = config.base;
      assets = brandAssets(root, env, base);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = assets.files.find((f) => `${base}${f.fileName}` === req.url?.split('?')[0]);
        if (!file) return next();
        res.setHeader(
          'Content-Type',
          file.fileName.endsWith('.png') ? 'image/png' : 'application/manifest+json',
        );
        res.end(file.source);
      });
    },
    generateBundle() {
      for (const f of assets.files)
        this.emitFile({ type: 'asset', fileName: f.fileName, source: f.source });
    },
    transformIndexHtml(html) {
      let out = html.replace(
        `<title>${PRODUCT_NAME}</title>`,
        `<title>${documentTitle(env)}</title>`,
      );
      if (env === 'dev') out = out.replace('<html lang="en"', '<html data-tbi-env="dev" lang="en"');
      return { html: out, tags: assets.tags.map((t) => ({ ...t, injectTo: 'head' as const })) };
    },
  };
}
