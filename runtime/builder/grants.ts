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
        bytes        INTEGER NOT NULL DEFAULT 0, -- the artifact's size (storage quota)
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (owner, sha256, source_key)
      );
      CREATE INDEX IF NOT EXISTS grant_by_key ON artifact_grant (owner, source_key);
      CREATE INDEX IF NOT EXISTS grant_by_sha ON artifact_grant (sha256);
      CREATE INDEX IF NOT EXISTS grant_by_use ON artifact_grant (last_used_at);
    `);
    this.upgrade();
  }

  /**
   * Versioned schema upgrades (`user_version`), applied in place at start. Only the SHAPE of the
   * table ever changes here; policy values (limits, retention) never touch stored data.
   *   1 → 2 (Sprint 8 Phase 4): `bytes` per grant, for the storage quota.
   */
  private upgrade(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version < 2) {
      const cols = this.db.prepare('PRAGMA table_info(artifact_grant)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'bytes'))
        this.db.exec('ALTER TABLE artifact_grant ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0');
      this.db.exec('PRAGMA user_version = 2');
    }
  }

  /** Grants recorded before sizes were (rows with `bytes` 0): fill them from the blob layer. */
  backfillBytes(sizeOf: (sha256: string) => number | undefined): number {
    const rows = this.db
      .prepare(`SELECT DISTINCT sha256 FROM artifact_grant WHERE bytes = 0`)
      .all() as { sha256: string }[];
    let n = 0;
    for (const r of rows) {
      const size = sizeOf(r.sha256);
      if (!size) continue;
      this.db
        .prepare(`UPDATE artifact_grant SET bytes = ? WHERE sha256 = ? AND bytes = 0`)
        .run(size, r.sha256);
      n++;
    }
    return n;
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
        `INSERT INTO artifact_grant (owner, sha256, origin, source_key, record, bytes, created_at, last_used_at)
         VALUES (?, ?, 'build', ?, ?, ?, ?, ?)
         ON CONFLICT (owner, sha256, source_key)
         DO UPDATE SET record = excluded.record, last_used_at = excluded.last_used_at`,
      )
      .run(owner, sha, result.key, JSON.stringify(result), result.artifact!.bytes, t, t);
  }

  /** Grant an Advanced prebuilt image to the principal who uploaded it. */
  recordPrebuilt(owner: Principal, sha: string, bytes: number): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO artifact_grant (owner, sha256, origin, source_key, record, bytes, created_at, last_used_at)
         VALUES (?, ?, 'prebuilt', '', NULL, ?, ?, ?)
         ON CONFLICT (owner, sha256, source_key) DO UPDATE SET last_used_at = excluded.last_used_at`,
      )
      .run(owner, sha, bytes, t, t);
  }

  /**
   * A principal's storage footprint: distinct artifacts they hold grants on, and their bytes
   * (a blob shared with others counts for each holder). Shared system records are not theirs.
   */
  usage(principal: Principal): { artifacts: number; bytes: number } {
    const r = this.db
      .prepare(
        `SELECT count(*) AS artifacts, coalesce(sum(bytes), 0) AS bytes FROM
           (SELECT sha256, max(bytes) AS bytes FROM artifact_grant WHERE owner = ? GROUP BY sha256)`,
      )
      .get(principal) as { artifacts: number; bytes: number };
    return r;
  }

  /** A principal's artifacts, least recently used first (quota eviction order). */
  lruOf(principal: Principal): { sha256: string; bytes: number }[] {
    return this.db
      .prepare(
        `SELECT sha256, max(bytes) AS bytes, max(last_used_at) AS used FROM artifact_grant
         WHERE owner = ? GROUP BY sha256 ORDER BY used ASC`,
      )
      .all(principal) as { sha256: string; bytes: number }[];
  }

  /** Drop every grant (all source keys) one owner holds on one artifact. */
  dropGrant(owner: Owner, sha: string): void {
    this.db.prepare(`DELETE FROM artifact_grant WHERE owner = ? AND sha256 = ?`).run(owner, sha);
  }

  /** How many owners still hold a grant on the artifact. */
  holders(sha: string): number {
    return (
      this.db
        .prepare(`SELECT count(DISTINCT owner) AS n FROM artifact_grant WHERE sha256 = ?`)
        .get(sha) as { n: number }
    ).n;
  }

  /** Private grants unused since `before` (retention candidates; global records never are). */
  unusedSince(before: number): { owner: Principal; sha256: string; lastUsedAt: number }[] {
    return this.db
      .prepare(
        `SELECT owner, sha256, max(last_used_at) AS lastUsedAt FROM artifact_grant
         WHERE owner <> 'global' GROUP BY owner, sha256 HAVING max(last_used_at) < ?`,
      )
      .all(before) as { owner: Principal; sha256: string; lastUsedAt: number }[];
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
