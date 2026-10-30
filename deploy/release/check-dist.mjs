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

  // The switch is checked above, where it is compiled; every other value must appear verbatim.
  for (const [name, v] of Object.entries(profile.vite))
    if (name === 'VITE_PROBLEM_REPORTS') continue;
    else if (v !== null && !all.includes(`\`${v}\``) && !all.includes(`"${v}"`))
      errors.push(`${name}: pinned value ${v} not found in the bundle`);
  errors.push(...checkBranding(profile, dist));
  return { errors, files: assets.length };
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
