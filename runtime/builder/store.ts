/**
 * Content-addressed, write-once artifact store shared with the R2 Session Host (Sprint 7): the
 * BLOB layer only (Sprint 8, D-S8-2). Who may use an artifact and which source built it are
 * grants (grants.ts), never kept here.
 *
 *   <dir>/<sha256>.bin    the artifact bytes (0444), exactly what R2 resolves, re-hashes and
 *                         copies into a private session directory before starting QEMU
 *   <dir>/<sha256>.json   the service's manifest (origin, size, creation time) — never read by R2
 *
 * The service always computes the sha256 itself; a client-supplied hash is never trusted.
 * Publishing writes a temporary file and renames it into place, so R2 never sees a partial file,
 * and an existing `<sha>.bin` is never rewritten. Files without a manifest (the R1-provisioned
 * reference images) are not managed here, are never evicted, and are usable by everyone.
 *
 * Eviction (LRU over managed artifacts, above the byte cap) skips any artifact under a lease:
 * a lease is taken just before a runtime session is created, which covers the interval until the
 * Session Host has made its private copy (D-S7-8). `onEvicted` lets the owner of the grants drop
 * them with the blob.
 *
 * Migration from Sprint 7: manifests may still carry `builds` records (one per source key). They
 * are ignored — build records now belong to their principal — so users simply build again; the
 * blobs stay until LRU removes them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { chmod, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactInfo } from './protocol.js';

export interface Manifest {
  sha256: string;
  bytes: number;
  origin: ArtifactInfo['origin'];
  createdAt: string;
}

export interface StoreOptions {
  dir: string;
  /** Upper bound for managed artifacts (bytes); LRU above it. */
  capBytes: number;
  /** Minimum time an artifact stays after its last use or lease request. */
  graceMs: number;
  now?: () => number;
  /** Called for every evicted artifact (the grants on it are dropped). */
  onEvicted?: (sha256: string) => void;
}

const SHA = /^[0-9a-f]{64}$/;

export class ArtifactStore {
  private readonly manifests = new Map<string, Manifest>();
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
        const raw = JSON.parse(await readFile(join(this.opts.dir, name), 'utf8')) as Manifest;
        if (raw.sha256 !== m[1] || !this.exists(raw.sha256)) continue;
        // Any Sprint 7 `builds`/`key`/`result` fields are deliberately not read (see above).
        this.manifests.set(raw.sha256, {
          sha256: raw.sha256,
          bytes: raw.bytes,
          origin: raw.origin,
          createdAt: raw.createdAt,
        });
        this.lastUsed.set(raw.sha256, statSync(this.binPath(raw.sha256)).mtimeMs);
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

  /** A provisioned reference image (R1): global by nature, never evicted. */
  isReference(sha: string): boolean {
    return this.provisioned.has(sha) && !this.manifests.has(sha) && this.exists(sha);
  }

  manifest(sha: string): Manifest | undefined {
    return this.manifests.get(sha);
  }

  /** Publish bytes from a file the service produced; returns the service-computed identity. */
  async publishFile(path: string, origin: ArtifactInfo['origin']) {
    return this.publish(await readFile(path), origin);
  }

  /** Publish bytes. The identity is computed here, never taken from a client. */
  async publish(bytes: Buffer, origin: ArtifactInfo['origin']): Promise<ArtifactInfo> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const bin = this.binPath(sha);
    if (!this.exists(sha)) {
      const tmp = join(this.opts.dir, `.tmp-${randomBytes(8).toString('hex')}`);
      await writeFile(tmp, bytes, { mode: 0o444 });
      await rename(tmp, bin);
    }
    const existing = this.manifests.get(sha);
    // Unmanaged reference images (no manifest) stay unmanaged: never write a manifest for them.
    if (!existing && !this.isReference(sha)) {
      const manifest: Manifest = {
        sha256: sha,
        bytes: bytes.length,
        origin,
        createdAt: new Date(this.now()).toISOString(),
      };
      const tmp = join(this.opts.dir, `.tmp-${randomBytes(8).toString('hex')}`);
      await writeFile(tmp, JSON.stringify(manifest), { mode: 0o444 });
      await rename(tmp, join(this.opts.dir, `${sha}.json`));
      this.manifests.set(sha, manifest);
    }
    this.touch(sha);
    await this.evict();
    return { sha256: sha, bytes: bytes.length, origin: existing?.origin ?? origin };
  }

  /** Mark an artifact as used now (a cache hit or lookup on it). */
  used(sha: string): void {
    if (this.manifests.has(sha)) this.touch(sha);
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

  private forget(sha: string) {
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
      this.opts.onEvicted?.(m.sha256);
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
