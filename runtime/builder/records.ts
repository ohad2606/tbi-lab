/**
 * Sprint 25 closure: build records across a runtime rollback.
 *
 * A build record's feature report is written for the runtime the build service serves: on Runtime
 * v5 every analysed program `requires` `input-read` (and `gpio-irq` / `i2c-clock` where used). An
 * older build service on an older runtime may still find such a record (Arduino's cache key does
 * not name the runtime there) and issue a ticket the older Session Host refuses at the handshake.
 *
 * `incompatibleRecords` names exactly the records that cannot run on a target runtime: a build
 * record (origin `build`) whose `requires` lists a capability the target's runtime.json does not
 * announce. Nothing else is touched: prebuilt (user-uploaded) grants, records whose requirements
 * the target meets, and the artifact files themselves. Every named record is regenerable: it is a
 * cache of a compilation of a source the client sends again with its next Build (curated sources
 * are seeded again by the build service at start).
 *
 * The CLI backs the rows up (JSON lines, every column) and verifies the backup before it deletes
 * anything, by primary key, in one transaction; `restore` puts them back without overwriting a
 * newer row. It prints counts and artifact prefixes only, never a principal.
 */
import { readFileSync, writeFileSync, fsyncSync, openSync, closeSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runtimeCapabilitiesFrom } from './runtimeJson.js';

export interface GrantRow {
  owner: string;
  sha256: string;
  origin: string;
  source_key: string;
  record: string | null;
  bytes: number;
  created_at: number;
  last_used_at: number;
}

export interface Incompatible {
  row: GrantRow;
  /** The capabilities the record requires that the target runtime does not announce. */
  missing: string[];
}

/** The records that cannot run on a runtime announcing `targetCaps`. */
export function incompatibleRecords(
  rows: readonly GrantRow[],
  targetCaps: readonly string[],
): Incompatible[] {
  const out: Incompatible[] = [];
  for (const row of rows) {
    if (row.origin !== 'build' || row.record === null) continue;
    let requires: unknown;
    try {
      requires = (JSON.parse(row.record) as { features?: { requires?: unknown } }).features
        ?.requires;
    } catch {
      continue; // not a record this tool understands: left alone
    }
    if (!Array.isArray(requires)) continue;
    const missing = requires.filter((c) => typeof c === 'string' && !targetCaps.includes(c));
    if (missing.length) out.push({ row, missing: [...new Set(missing as string[])].sort() });
  }
  return out;
}

const COLUMNS = 'owner, sha256, origin, source_key, record, bytes, created_at, last_used_at';

export function readRows(db: DatabaseSync): GrantRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM artifact_grant`).all() as unknown as GrantRow[];
}

/** A summary without principals: counts by owner class and missing capability, artifact prefixes. */
export function summarize(found: readonly Incompatible[], total: number) {
  const byMissing: Record<string, number> = {};
  for (const f of found) for (const m of f.missing) byMissing[m] = (byMissing[m] ?? 0) + 1;
  return {
    rows: total,
    incompatible: found.length,
    global: found.filter((f) => f.row.owner === 'global').length,
    user: found.filter((f) => f.row.owner !== 'global').length,
    users: new Set(found.filter((f) => f.row.owner !== 'global').map((f) => f.row.owner)).size,
    byMissing,
    artifacts: [...new Set(found.map((f) => f.row.sha256.slice(0, 12)))].sort(),
  };
}

/**
 * Back up, verify the backup, then delete exactly those rows, all inside one write transaction: the
 * rows are read under the lock, and a row is deleted only if it still holds the record that was
 * backed up (primary key and record), so nothing written meanwhile can be removed.
 */
export function removeIncompatible(db: DatabaseSync, targetCaps: string[], backup: string) {
  if (existsSync(backup)) throw new Error('the backup file exists: refusing to overwrite it');
  const del = db.prepare(
    `DELETE FROM artifact_grant
     WHERE owner = ? AND sha256 = ? AND source_key = ? AND origin = 'build' AND record IS ?`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    const found = incompatibleRecords(readRows(db), targetCaps);
    const text = found.map((f) => JSON.stringify(f.row)).join('\n') + (found.length ? '\n' : '');
    writeFileSync(backup, text, { mode: 0o600, flag: 'wx' });
    const fd = openSync(backup, 'r');
    fsyncSync(fd);
    closeSync(fd);
    const back = readBackup(backup);
    if (
      back.length !== found.length ||
      back.some((r, i) => JSON.stringify(r) !== JSON.stringify(found[i]!.row))
    )
      throw new Error('backup verification failed: nothing deleted');
    let n = 0;
    for (const f of found)
      n += Number(del.run(f.row.owner, f.row.sha256, f.row.source_key, f.row.record).changes);
    if (n !== found.length) throw new Error(`deleted ${n} of ${found.length}: rolled back`);
    db.exec('COMMIT');
    return found;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** The backed-up rows. A malformed line is reported by its number only (rows carry principals). */
export function readBackup(file: string): GrantRow[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l) as GrantRow;
      } catch {
        throw new Error(`backup line ${i + 1} is not valid JSON`);
      }
    });
}

/** Put backed-up rows back; a row that exists again (rebuilt since) is kept as it is. */
export function restore(db: DatabaseSync, file: string): { restored: number; kept: number } {
  const rows = readBackup(file);
  const ins = db.prepare(
    `INSERT INTO artifact_grant (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner, sha256, source_key) DO NOTHING`,
  );
  let restored = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows)
      restored += Number(
        ins.run(
          r.owner,
          r.sha256,
          r.origin,
          r.source_key,
          r.record,
          r.bytes,
          r.created_at,
          r.last_used_at,
        ).changes,
      );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { restored, kept: rows.length - restored };
}

/**
 * CLI (bundled for the deploy kit; run as the build service's user while it is stopped):
 *   list    <grants.db> <target runtime.json>
 *   remove  <grants.db> <target runtime.json> <backup.jsonl>
 *   restore <grants.db> <backup.jsonl>
 */
export function main(argv: string[]): number {
  const [cmd, dbPath, a, b] = argv;
  if (!dbPath || !existsSync(dbPath)) {
    console.error('usage: list|remove|restore <grants.db> ...');
    return 2;
  }
  const db = new DatabaseSync(dbPath, { readOnly: cmd === 'list' });
  try {
    if (cmd === 'list' && a) {
      const caps = runtimeCapabilitiesFrom(a);
      const rows = readRows(db);
      console.log(
        JSON.stringify({
          target: caps,
          ...summarize(incompatibleRecords(rows, caps), rows.length),
        }),
      );
      return 0;
    }
    if (cmd === 'remove' && a && b) {
      const caps = runtimeCapabilitiesFrom(a);
      const total = readRows(db).length;
      const found = removeIncompatible(db, caps, b);
      console.log(JSON.stringify({ removed: true, target: caps, ...summarize(found, total) }));
      return 0;
    }
    if (cmd === 'restore' && a) {
      console.log(JSON.stringify(restore(db, a)));
      return 0;
    }
    console.error('usage: list|remove|restore <grants.db> ...');
    return 2;
  } finally {
    db.close();
  }
}
