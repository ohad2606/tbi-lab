/**
 * Sprint 26: the vendored managed-library sources (runtime/libraries/<id>/<version>/, byte-exact
 * upstream files) as the build service carries them: `sources.json`, generated from those
 * directories by scripts/gen-library-sources.ts (base64, so every byte, CRLF included, survives),
 * and checked against the registry's `tree` checksums before any use.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, MANAGED_LIBRARIES, type ManagedLibrary } from '@tbi-lab/domain';
import sources from './sources.json' with { type: 'json' };

export interface LibraryFile {
  /** Path inside the library's tree, `/`-separated. */
  path: string;
  bytes: Buffer;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The tree checksum: canonical JSON of `[{path, sha256}]`, sorted by path, hashed as UTF-8. */
export function treeChecksum(files: readonly LibraryFile[]): string {
  const list = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, sha256: sha256(f.bytes) }));
  return sha256(canonicalJson(list));
}

interface Packed {
  id: string;
  version: string;
  files: { path: string; base64: string }[];
}

/**
 * The vendored files of one registry library, verified: present, with safe relative paths, and
 * matching the registry's tree checksum. Throws otherwise (the build service refuses to start).
 */
export function libraryFiles(lib: Pick<ManagedLibrary, 'id' | 'version' | 'tree'>): LibraryFile[] {
  const p = (sources as Packed[]).find((s) => s.id === lib.id && s.version === lib.version);
  if (!p) throw new Error(`managed library ${lib.id}@${lib.version}: no vendored source`);
  const files = p.files.map((f) => {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(f.path))
      throw new Error(`managed library ${lib.id}: unsafe path`);
    return { path: f.path, bytes: Buffer.from(f.base64, 'base64') };
  });
  const tree = treeChecksum(files);
  if (tree !== lib.tree)
    throw new Error(`managed library ${lib.id}@${lib.version}: tree ${tree} is not the registry's`);
  return files;
}

/** Verify every registry library at once (build service start, tests). */
export function verifyRegistry(): void {
  for (const lib of MANAGED_LIBRARIES) libraryFiles(lib);
}
