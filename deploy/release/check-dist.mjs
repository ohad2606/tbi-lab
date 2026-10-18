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
 */
import { readFileSync, readdirSync } from 'node:fs';
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
    const { sources } = JSON.parse(readFileSync(join(dist, 'assets', m), 'utf8'));
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
  return { errors, files: assets.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [profilePath, dist] = process.argv.slice(2);
  const { errors, files } = checkDist(loadProfile(profilePath), dist);
  for (const e of errors) console.error(`check-dist: ${e}`);
  if (errors.length) process.exitCode = 1;
  else
    console.log(`check-dist: ${files} assets, profile ${profilePath.split('/').pop()} confirmed`);
}
