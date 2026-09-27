/**
 * Content-addressed, write-once artifact store shared with the R2 Session Host (Sprint 7).
 *
 *   <dir>/<sha256>.bin    the artifact bytes (0444), exactly what R2 resolves, re-hashes and
 *                         copies into a private session directory before starting QEMU
 *   <dir>/<sha256>.json   the service's manifest (origin, and one build record per source key that
 *                         produced these bytes) — never read by R2
 *
 * Several sources can compile to the same bytes (a comment-only edit, for example): the artifact
 * is stored once, and each source keeps its own build record (its key, diagnostics, features),
 * so a cache hit or lookup always answers with the record of the source that was asked for.
 *
 * The service always computes the sha256 itself; a client-supplied hash is never trusted.
 * Publishing writes a temporary file and renames it into place, so R2 never sees a partial file,
 * and an existing `<sha>.bin` is never rewritten. Files without a manifest (the R1-provisioned
 * reference images) are not managed here and are never evicted.
 *
 * Eviction (LRU over managed artifacts, above the byte cap) skips any artifact under a lease:
 * the browser leases the artifact just before it creates a runtime session, which covers the
 * interval until the Session Host has made its private copy (D-S7-8). A leased or recently used
 * artifact is never removed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { chmod, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactInfo, BuildResult } from './protocol.js';

export interface Manifest {
  sha256: string;
  bytes: number;
  origin: ArtifactInfo['origin'];
  /** Build records by source key (timings are not kept), at most MAX_BUILDS_PER_ARTIFACT. */
  builds?: Record<string, StoredBuild>;
  createdAt: string;
}

export type StoredBuild = Omit<BuildResult, 'timings'>;

/** Distinct sources remembered per artifact (oldest record dropped first). */
const MAX_BUILDS_PER_ARTIFACT = 32;

/** What a publish adds: the origin and, for a build, the record of the source that built it. */
export interface ManifestFields {
  origin: ArtifactInfo['origin'];
  key?: string;
  result?: StoredBuild;
}

export interface StoreOptions {
  dir: string;
  /** Upper bound for managed artifacts (bytes); LRU above it. */
  capBytes: number;
  /** Minimum time an artifact stays after its last use or lease request. */
  graceMs: number;
  now?: () => number;
}

const SHA = /^[0-9a-f]{64}$/;

export type ManifestInput = ManifestFields | ((info: ArtifactInfo) => ManifestFields);

export class ArtifactStore {
  private readonly manifests = new Map<string, Manifest>();
  private readonly byKey = new Map<string, string>();
  private readonly lastUsed = new Map<string, number>();
  private readonly leases = new Map<string, number>();
  private readonly now: () => number;
  /** Reference images present at start without a manifest: never managed, never evicted. */
  private readonly provisioned = new Set<string>();

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? Date.now;
    const names = new Set(readdirSync(opts.dir));
    for (const name of names) {
      const sha = /^([0-9a-f]{64})\.bin$/.exec(name)?.[1];
      if (sha && !names.has(`${sha}.json`)) this.provisioned.add(sha);
    }
  }

  /** Rebuild the in-memory index from the manifests on disk (service start). */
  async load(): Promise<void> {
    for (const name of readdirSync(this.opts.dir)) {
      const m = /^([0-9a-f]{64})\.json$/.exec(name);
      if (!m) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.opts.dir, name), 'utf8')) as Manifest & {
          key?: string;
          result?: StoredBuild;
        };
        if (raw.sha256 !== m[1] || !this.exists(raw.sha256)) continue;
        // Early Sprint 7 manifests held one `key`/`result`: read them as one build record.
        const builds = raw.builds ?? (raw.key && raw.result ? { [raw.key]: raw.result } : {});
        const manifest: Manifest = {
          sha256: raw.sha256,
          bytes: raw.bytes,
          origin: raw.origin,
          builds,
          createdAt: raw.createdAt,
        };
        this.manifests.set(manifest.sha256, manifest);
        for (const key of Object.keys(builds)) this.byKey.set(key, manifest.sha256);
        this.lastUsed.set(manifest.sha256, statSync(this.binPath(manifest.sha256)).mtimeMs);
      } catch {
        // unreadable manifest: the artifact stays but is not indexed
      }
    }
  }

  binPath(sha: string): string {
    if (!SHA.test(sha)) throw new Error('bad sha');
    return join(this.opts.dir, `${sha}.bin`);
  }

  exists(sha: string): boolean {
    try {
      return statSync(this.binPath(sha)).isFile();
    } catch {
      return false;
    }
  }

  /** The successful build record of exactly this source key, if its artifact is still present. */
  findBuild(key: string): StoredBuild | undefined {
    const sha = this.byKey.get(key);
    if (!sha) return undefined;
    if (!this.exists(sha)) {
      this.forget(sha);
      return undefined;
    }
    this.touch(sha);
    return this.manifests.get(sha)?.builds?.[key];
  }

  manifest(sha: string): Manifest | undefined {
    return this.manifests.get(sha);
  }

  /** Publish bytes from a file the service produced; returns the service-computed identity. */
  async publishFile(path: string, meta: ManifestInput) {
    return this.publish(await readFile(path), meta);
  }

  /**
   * Publish bytes. The identity is computed here; `meta` may be a function of it (a manifest
   * that records the artifact's own identity, such as a build result).
   */
  async publish(bytes: Buffer, metaInput: ManifestInput): Promise<ArtifactInfo> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const info0: ArtifactInfo = {
      sha256: sha,
      bytes: bytes.length,
      origin: typeof metaInput === 'function' ? 'build' : metaInput.origin,
    };
    const meta = typeof metaInput === 'function' ? metaInput(info0) : metaInput;
    const bin = this.binPath(sha);
    if (!this.exists(sha)) {
      const tmp = join(this.opts.dir, `.tmp-${randomBytes(8).toString('hex')}`);
      await writeFile(tmp, bytes, { mode: 0o444 });
      await rename(tmp, bin);
    }
    const existing = this.manifests.get(sha);
    const builds: Record<string, StoredBuild> = { ...(existing?.builds ?? {}) };
    if (meta.key && meta.result) {
      delete builds[meta.key]; // re-insert: most recent last
      builds[meta.key] = meta.result;
    }
    const keys = Object.keys(builds);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_BUILDS_PER_ARTIFACT))) {
      delete builds[old];
      if (this.byKey.get(old) === sha) this.byKey.delete(old);
    }
    const manifest: Manifest = {
      sha256: sha,
      bytes: bytes.length,
      origin: existing?.origin ?? meta.origin,
      builds,
      createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
    };
    // Unmanaged reference images (no manifest) stay unmanaged: never write a manifest for them.
    if (existing || !this.unmanaged(sha)) {
      const tmp = join(this.opts.dir, `.tmp-${randomBytes(8).toString('hex')}`);
      await writeFile(tmp, JSON.stringify(manifest), { mode: 0o444 });
      await rename(tmp, join(this.opts.dir, `${sha}.json`));
      this.manifests.set(sha, manifest);
      for (const key of Object.keys(builds)) this.byKey.set(key, sha);
    }
    this.touch(sha);
    await this.evict();
    return { sha256: sha, bytes: bytes.length, origin: manifest.origin };
  }

  /** Pin an artifact for `ms` (from now): it cannot be evicted before the lease ends. */
  lease(sha: string, ms: number): number | null {
    if (!this.exists(sha)) return null;
    const until = this.now() + ms;
    this.leases.set(sha, Math.max(this.leases.get(sha) ?? 0, until));
    this.touch(sha);
    return until;
  }

  /** Bytes held by managed artifacts. */
  managedBytes(): number {
    let total = 0;
    for (const m of this.manifests.values()) total += m.bytes;
    return total;
  }

  private touch(sha: string) {
    this.lastUsed.set(sha, this.now());
  }

  private unmanaged(sha: string): boolean {
    // A file that existed before any manifest (provisioned reference image).
    return this.exists(sha) && !this.manifests.has(sha) && this.provisioned.has(sha);
  }

  private forget(sha: string) {
    const m = this.manifests.get(sha);
    for (const key of Object.keys(m?.builds ?? {}))
      if (this.byKey.get(key) === sha) this.byKey.delete(key);
    this.manifests.delete(sha);
    this.lastUsed.delete(sha);
    this.leases.delete(sha);
  }

  /** LRU over managed artifacts; never leased, never inside the grace period. */
  async evict(): Promise<string[]> {
    const removed: string[] = [];
    const now = this.now();
    const candidates = [...this.manifests.values()]
      .filter((m) => (this.leases.get(m.sha256) ?? 0) <= now)
      .filter((m) => now - (this.lastUsed.get(m.sha256) ?? 0) >= this.opts.graceMs)
      .sort((a, b) => (this.lastUsed.get(a.sha256) ?? 0) - (this.lastUsed.get(b.sha256) ?? 0));
    let total = this.managedBytes();
    for (const m of candidates) {
      if (total <= this.opts.capBytes) break;
      await rm(join(this.opts.dir, `${m.sha256}.json`), { force: true });
      await rm(this.binPath(m.sha256), { force: true });
      this.forget(m.sha256);
      total -= m.bytes;
      removed.push(m.sha256);
    }
    return removed;
  }
}

/** Copy the R1 reference images into a store directory (provisioning helper). */
export async function seedReference(from: string, to: string, shas: string[]): Promise<void> {
  for (const sha of shas) {
    const target = join(to, `${sha}.bin`);
    try {
      await stat(target);
    } catch {
      await copyFile(join(from, `${sha}.bin`), target);
      await chmod(target, 0o444);
    }
  }
}
