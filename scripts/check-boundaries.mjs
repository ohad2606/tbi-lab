#!/usr/bin/env node
/**
 * Production boundary guard (Sprint 2, A12): production code must never import from
 * experiments/. Feasibility code enters production only by deliberate promotion (a copy with
 * its tests), never by reference. Runs in CI as part of `npm run lint`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['app', 'packages'];
const SKIP = new Set(['node_modules', 'dist']);
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
      const source = readFileSync(path, 'utf8');
      for (const m of source.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (spec && /(^|\/)experiments(\/|$)/.test(spec))
          violations.push(`${relative('.', path)}: ${spec}`);
      }
    }
  }
}
for (const root of ROOTS) walk(root);

if (violations.length) {
  console.error('Production code imports from experiments/:\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log(`boundary check: ${ROOTS.join(', ')} import nothing from experiments/`);
