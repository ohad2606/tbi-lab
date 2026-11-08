/**
 * Sprint 26: pack the vendored managed-library sources (runtime/libraries/<id>/<version>/) into
 * runtime/libraries/sources.json and print each tree checksum (for the registry). Deterministic:
 * entries and files sorted. `--check` fails if the committed file differs.
 *   npx vite-node scripts/gen-library-sources.ts [--check]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeChecksum } from '../runtime/libraries/tree.js';

const ROOT = join(import.meta.dirname, '..', 'runtime', 'libraries');
const walk = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isSymbolicLink()) throw new Error(`symlink in vendored source: ${p}`);
      return st.isDirectory() ? walk(p) : [p];
    });

const out: { id: string; version: string; files: { path: string; base64: string }[] }[] = [];
for (const id of readdirSync(ROOT).sort()) {
  const d = join(ROOT, id);
  if (!statSync(d).isDirectory()) continue;
  for (const version of readdirSync(d).sort()) {
    const v = join(d, version);
    const files = walk(v).map((p) => ({ path: relative(v, p), bytes: readFileSync(p) }));
    out.push({
      id,
      version,
      files: files.map((f) => ({ path: f.path, base64: f.bytes.toString('base64') })),
    });
    console.log(`${id}@${version} tree ${treeChecksum(files)}`);
  }
}
const text = JSON.stringify(out, null, 1) + '\n';
const target = join(ROOT, 'sources.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== text) {
    console.error('runtime/libraries/sources.json is not what the vendored sources give');
    process.exit(1);
  }
} else writeFileSync(target, text);
