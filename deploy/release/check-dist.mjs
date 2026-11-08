#!/usr/bin/env node
/**
 * Release check of a built frontend (packaging gate G3), after verify-build.mjs: the build is
 * the one its profile describes.
 *
 *   check-dist.mjs <profile.release.json> <dist>
 *
 * - No excluded feature is in the bundle: no source map lists a module under an excluded path,
 *   and no bundle names an excluded setting.
 * - Every VITE_* reference was compiled to its pinned value: none survives in the output.
 * - Report a Problem: the compiled switch is the profile's value (fails closed when it cannot be
 *   located, e.g. after a minifier change).
 * - Sprint 23C, the administration switch (VITE_ADMIN_UI): likewise, by its own parser's form,
 *   found exactly once and compiled to the profile's value.
 * - Every pinned value is present in the bundle.
 * - No source map carries a bundler asset placeholder (G2: assigned in a nondeterministic order).
 * - Branding (2026-10-29): the entry HTML links the icon set and the web app manifest, each file
 *   exists and every PNG has the size it is declared with; the DEV markers ([DEV] title,
 *   data-tbi-env, "DEV" in the manifest names) are present exactly when the profile pins
 *   VITE_TBI_ENV=dev, so a production or Alpha package can never carry them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadProfile } from './release-config.mjs';

/** parseEnabled (app/src/deployment.ts) applied to the build-time value, as the minifier emits it. */
const SWITCH =
  /function (\w+)\((\w+)\)\{return typeof \2==`string`&&\2\.trim\(\)===`1`\}var \w+=\1\((`[^`]*`|void 0)\)/g;

/**
 * Sprint 23C: parseAdminUi (app/src/deployment.ts) applied to VITE_ADMIN_UI, as the minifier emits
 * it. Its own form, distinct from the Report a Problem switch: each is located exactly once.
 */
const ADMIN_SWITCH =
  /function (\w+)\((\w+)\)\{let (\w+)=typeof \2==`string`\?\2\.trim\(\):``;return \3===`full`\?`full`:\3===`reports`\?`reports`:`off`\}var \w+=\1\((`[^`]*`|void 0)\)/g;

export function checkDist(profile, dist) {
  const errors = [];
  const assets = readdirSync(join(dist, 'assets')).sort();
  const js = assets.filter((f) => f.endsWith('.js'));
  const maps = assets.filter((f) => f.endsWith('.js.map'));
  const code = js.map((f) => readFileSync(join(dist, 'assets', f), 'utf8'));
  const all = code.join('\n');

  for (const m of maps) {
    const { sources, sourcesContent } = JSON.parse(readFileSync(join(dist, 'assets', m), 'utf8'));
    // G2: bundler placeholders are assigned in a nondeterministic order (vite.config.ts).
    if (
      (sourcesContent ?? []).some((c) => typeof c === 'string' && c.includes('ROLLDOWN_FILE_URL_'))
    )
      errors.push(`${m}: carries a bundler asset placeholder (nondeterministic)`);
    for (const s of sources)
      for (const p of profile.excluded.paths)
        if (s.replace(/\\/g, '/').includes(`/${p.replace(/^app\//, '')}`) || s.includes(p))
          errors.push(`${m}: bundles ${s} (excluded: ${p})`);
  }
  for (const name of profile.excluded.settings)
    if (all.includes(name)) errors.push(`bundle names excluded setting ${name}`);

  const left = new Set(all.match(/\bVITE_[A-Z0-9_]+\b/g) ?? []);
  for (const name of left) errors.push(`${name} was not compiled to a value`);

  const found = [...all.matchAll(SWITCH)].map((m) => m[3]);
  const want = `\`${profile.vite.VITE_PROBLEM_REPORTS}\``;
  if (found.length !== 1)
    errors.push(`Report a Problem switch: found ${found.length} compiled switches, expected 1`);
  else if (found[0] !== want)
    errors.push(`Report a Problem switch compiled as ${found[0]}, profile pins ${want}`);

  // Sprint 23C: the administration switch, where the profile pins it (every s23c profile does).
  if ('VITE_ADMIN_UI' in profile.vite) {
    const admin = [...all.matchAll(ADMIN_SWITCH)].map((m) => m[4]);
    const pinned = profile.vite.VITE_ADMIN_UI;
    const wantAdmin = pinned === null ? 'void 0' : `\`${pinned}\``;
    if (admin.length !== 1)
      errors.push(`administration switch: found ${admin.length} compiled switches, expected 1`);
    else if (admin[0] !== wantAdmin)
      errors.push(`administration switch compiled as ${admin[0]}, profile pins ${wantAdmin}`);
  }

  // The switches are checked above, where they are compiled; every other value must appear verbatim.
  for (const [name, v] of Object.entries(profile.vite))
    if (name === 'VITE_PROBLEM_REPORTS' || name === 'VITE_ADMIN_UI') continue;
    else if (v !== null && !all.includes(`\`${v}\``) && !all.includes(`"${v}"`))
      errors.push(`${name}: pinned value ${v} not found in the bundle`);
  errors.push(...checkBranding(profile, dist));
  errors.push(...checkAssist(profile, dist));
  return { errors, files: assets.length };
}

/** Sprint 28: traces of an AI provider client that must never reach a browser bundle. */
const PROVIDER_TRACES = [
  [
    'an AI provider endpoint',
    /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis/,
  ],
  ['an AI provider SDK', /@anthropic-ai\/sdk|anthropic-version|x-api-key/i],
];

/** Modules of the experimental Circuit Debugger (Sprint 27, DEV-Lab builds only). */
// Source map paths are relative to the bundle (`../../src/assist/…`) or carry the repository path.
const ASSIST_MODULE = /(^|\/)((app\/)?src\/assist|packages\/assist)\//;

/**
 * Sprint 27: the Circuit Debugger is in a build exactly when its profile pins VITE_TBI_ENV=dev.
 * Any other build (production, Alpha, RC) carries none of its modules, no emitted chunk (an
 * unreferenced chunk is still served) and no trace of its button.
 */
export function checkAssist(profile, dist) {
  const errors = [];
  const dev = profile.vite.VITE_TBI_ENV === 'dev';
  const assets = readdirSync(join(dist, 'assets')).sort();
  const modules = new Set();
  for (const m of assets.filter((f) => f.endsWith('.js.map')))
    for (const s of JSON.parse(readFileSync(join(dist, 'assets', m), 'utf8')).sources)
      if (ASSIST_MODULE.test(s.replace(/\\/g, '/'))) modules.add(`${m}: ${s}`);
  const chunks = assets.filter((f) => /^AssistPanel-.*\.js$/.test(f));
  const button = assets
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(join(dist, 'assets', f), 'utf8').includes('assist-open'));
  // Sprint 28: no build, of any profile, carries a provider SDK, its endpoint or a key header:
  // provider calls are server-side only (runtime/assist), never from a browser.
  for (const f of assets.filter((a) => a.endsWith('.js')))
    for (const [what, re] of PROVIDER_TRACES)
      if (re.test(readFileSync(join(dist, 'assets', f), 'utf8')))
        errors.push(`${f}: carries ${what} (provider calls are server-side only)`);
  if (dev) {
    if (!chunks.length) errors.push('DEV build without the Circuit Debugger panel chunk');
    if (!button) errors.push('DEV build without the Circuit Debugger button');
  } else {
    for (const m of modules) errors.push(`Circuit Debugger module in a non-DEV build: ${m}`);
    for (const c of chunks) errors.push(`Circuit Debugger chunk in a non-DEV build: ${c}`);
    if (button) errors.push('Circuit Debugger button in a non-DEV build');
  }
  return errors;
}

/** The pixel size of a PNG (IHDR), or null. */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

export function checkBranding(profile, dist) {
  const errors = [];
  const dev = profile.vite.VITE_TBI_ENV === 'dev';
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const local = (href) => join(dist, href.replace(/^\//, ''));
  const declared = [];
  for (const m of html.matchAll(/<link rel="(icon|apple-touch-icon)"[^>]*>/g)) {
    const href = /href="([^"]+)"/.exec(m[0])?.[1];
    const sizes = /sizes="([^"]+)"/.exec(m[0])?.[1];
    declared.push({ rel: m[1], href, sizes });
  }
  if (!declared.some((d) => d.rel === 'icon')) errors.push('index.html links no favicon');
  if (!declared.some((d) => d.rel === 'apple-touch-icon'))
    errors.push('index.html links no apple-touch-icon');
  const manifestTag = /<link rel="manifest"[^>]*>/.exec(html)?.[0];
  const manifestHref = manifestTag && /href="([^"]+)"/.exec(manifestTag)?.[1];
  let manifest = null;
  if (!manifestHref || !existsSync(local(manifestHref))) errors.push('no web app manifest');
  else {
    if (!/crossorigin="use-credentials"/.test(manifestTag))
      errors.push('the manifest link must send credentials (the deployment gate)');
    manifest = JSON.parse(readFileSync(local(manifestHref), 'utf8'));
    for (const i of manifest.icons ?? [])
      declared.push({ rel: `manifest ${i.purpose}`, href: i.src, sizes: i.sizes });
    for (const p of ['any', 'maskable'])
      for (const size of ['192x192', '512x512'])
        if (!(manifest.icons ?? []).some((i) => i.purpose === p && i.sizes === size))
          errors.push(`manifest: no ${p} ${size} icon`);
  }
  for (const d of declared) {
    if (!d.href?.startsWith('/assets/') || !existsSync(local(d.href))) {
      errors.push(`${d.rel} ${d.href}: missing (or not a content-hashed asset)`);
      continue;
    }
    if (d.href.endsWith('.ico')) {
      // A .ico lists its sizes in `sizes` and holds them in its directory (0 means 256).
      const b = readFileSync(local(d.href));
      const held = [];
      if (b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1)
        for (let i = 0; i < b.readUInt16LE(4); i++) {
          const n = b[6 + 16 * i] || 256;
          held.push(`${n}x${n}`);
        }
      if (held.join(' ') !== d.sizes)
        errors.push(`${d.rel} ${d.href}: declared ${d.sizes}, holds ${held.join(' ')}`);
      continue;
    }
    const size = pngSize(readFileSync(local(d.href)));
    if (size !== d.sizes) errors.push(`${d.rel} ${d.href}: declared ${d.sizes}, is ${size}`);
  }

  const markers = {
    'the [DEV] title': /<title>\[DEV\] /.test(html),
    'data-tbi-env="dev"': html.includes('data-tbi-env="dev"'),
    'DEV in the manifest names':
      !!manifest && /\bDEV\b/.test(`${manifest.name} ${manifest.short_name}`),
  };
  for (const [what, present] of Object.entries(markers))
    if (dev && !present) errors.push(`DEV profile, but the build lacks ${what}`);
    else if (!dev && present)
      errors.push(`production branding expected, but the build has ${what}`);
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [profilePath, dist] = process.argv.slice(2);
  const { errors, files } = checkDist(loadProfile(profilePath), dist);
  for (const e of errors) console.error(`check-dist: ${e}`);
  if (errors.length) process.exitCode = 1;
  else
    console.log(`check-dist: ${files} assets, profile ${profilePath.split('/').pop()} confirmed`);
}
