/**
 * Artifact grants (Sprint 8, D-S8-2/3/10): who may use which artifact, and which build records a
 * principal can see. Kept apart from the other concepts:
 *
 *   1. identity   — sha256 of the bytes (the store computes it)
 *   2. storage    — one write-once blob per identity, shared internally (store.ts)
 *   3. grant      — (principal | 'global', sha256, origin): who may use it   ← this module
 *   4. cache view — a grant's source key: which source resolves to which build, per principal
 *   5. retention  — policy over `createdAt`/`lastUsedAt` (no expiry is stored; D-S8-8)
 *
 * Two users who build different private sources that compile to the same bytes share one blob
 * but each has their own grant and record; neither can see the other's. `global` grants are the
 * explicitly shared system records (curated example and starter sources).
 *
 * Backed by the built-in `node:sqlite` (WAL, transactions); the database lives in the service's
 * private state directory.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Principal } from '../identity/principal.js';
import type { BuildResult } from './protocol.js';

export const GLOBAL = 'global' as const;
export type Owner = Principal | typeof GLOBAL;
export type StoredBuild = Omit<BuildResult, 'timings'>;

export class Grants {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS artifact_grant (
        owner        TEXT NOT NULL,            -- a principal, or 'global'
        sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
        origin       TEXT NOT NULL CHECK (origin IN ('build', 'prebuilt')),
        source_key   TEXT NOT NULL DEFAULT '', -- build cache key; '' for prebuilt
        record       TEXT,                     -- the build record (JSON), private to this grant
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (owner, sha256, source_key)
      );
      CREATE INDEX IF NOT EXISTS grant_by_key ON artifact_grant (owner, source_key);
      CREATE INDEX IF NOT EXISTS grant_by_sha ON artifact_grant (sha256);
      CREATE INDEX IF NOT EXISTS grant_by_use ON artifact_grant (last_used_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Record a successful build for its owner (upsert: the newest record wins). */
  recordBuild(owner: Owner, result: StoredBuild): void {
    const sha = result.artifact!.sha256;
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO artifact_grant (owner, sha256, origin, source_key, record, created_at, last_used_at)
         VALUES (?, ?, 'build', ?, ?, ?, ?)
         ON CONFLICT (owner, sha256, source_key)
         DO UPDATE SET record = excluded.record, last_used_at = excluded.last_used_at`,
      )
      .run(owner, sha, result.key, JSON.stringify(result), t, t);
  }

  /** Grant an Advanced prebuilt image to the principal who uploaded it. */
  recordPrebuilt(owner: Principal, sha: string): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO artifact_grant (owner, sha256, origin, source_key, record, created_at, last_used_at)
         VALUES (?, ?, 'prebuilt', '', NULL, ?, ?)
         ON CONFLICT (owner, sha256, source_key) DO UPDATE SET last_used_at = excluded.last_used_at`,
      )
      .run(owner, sha, t, t);
  }

  /**
   * The build of exactly this source visible to the principal: their own record, else a shared
   * system record. Never another principal's.
   */
  findBuild(principal: Principal, key: string): StoredBuild | null {
    const row = this.db
      .prepare(
        `SELECT owner, sha256, record FROM artifact_grant
         WHERE source_key = ? AND origin = 'build' AND owner IN (?, 'global')
         ORDER BY owner = 'global' LIMIT 1`,
      )
      .get(key, principal) as { owner: string; sha256: string; record: string } | undefined;
    if (!row) return null;
    this.touch(row.owner as Owner, row.sha256);
    return JSON.parse(row.record) as StoredBuild;
  }

  /** Whether the principal may use this artifact (their own grant or a global one). */
  canUse(principal: Principal, sha: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM artifact_grant WHERE sha256 = ? AND owner IN (?, 'global') LIMIT 1`)
        .get(sha, principal) !== undefined
    );
  }

  /**
   * The server-side feature record for a run of this artifact by this principal: from their own
   * (else a global) build record; null when the artifact was never analysed (prebuilt).
   */
  features(principal: Principal, sha: string): StoredBuild['features'] | null {
    const row = this.db
      .prepare(
        `SELECT record FROM artifact_grant
         WHERE sha256 = ? AND owner IN (?, 'global') AND origin = 'build'
         ORDER BY owner = 'global', last_used_at DESC LIMIT 1`,
      )
      .get(sha, principal) as { record: string } | undefined;
    if (!row) return null;
    return (JSON.parse(row.record) as StoredBuild).features ?? null;
  }

  touch(owner: Owner, sha: string): void {
    this.db
      .prepare(`UPDATE artifact_grant SET last_used_at = ? WHERE owner = ? AND sha256 = ?`)
      .run(this.now(), owner, sha);
  }

  touchFor(principal: Principal, sha: string): void {
    this.db
      .prepare(
        `UPDATE artifact_grant SET last_used_at = ? WHERE sha256 = ? AND owner IN (?, 'global')`,
      )
      .run(this.now(), sha, principal);
  }

  /** The blob is gone (evicted): every grant on it goes too. Users see "Build required". */
  dropArtifact(sha: string): void {
    this.db.prepare(`DELETE FROM artifact_grant WHERE sha256 = ?`).run(sha);
  }

  /** Counts for tests and operator summaries (no identifiers). */
  stats(): { grants: number; global: number; owners: number } {
    const r = this.db
      .prepare(
        `SELECT count(*) AS grants, sum(owner = 'global') AS global,
                (SELECT count(DISTINCT owner) FROM artifact_grant WHERE owner <> 'global') AS owners
         FROM artifact_grant`,
      )
      .get() as { grants: number; global: number | null; owners: number };
    return { grants: r.grants, global: r.global ?? 0, owners: r.owners };
  }
}
