/**
 * Sprint 25 closure: which build records a rollback to an older runtime must not keep (they
 * require a capability the target does not announce), and the backup / remove / restore cycle.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { principalFor } from '../../identity/test-gate.js';
import { GLOBAL, Grants, type StoredBuild } from '../grants.js';
import {
  incompatibleRecords,
  readRows,
  removeIncompatible,
  restore,
  summarize,
} from '../records.js';
import { tempDir } from './support.js';

const V4 = ['i2c', 'pad-func', 'pwm', 'sched-input', 'unmodelled'];
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

const A = principalFor('user-a');
const B = principalFor('user-b');
const sha = (c: string) => c.repeat(64);
const build = (s: string, key: string, requires?: string[]): StoredBuild =>
  ({
    protocol: 'tbi-lab.build/1',
    ok: true,
    key,
    profile: 'esp32-arduino-3.3.12',
    profileHash: 'f'.repeat(64),
    artifact: { sha256: s, bytes: 100 },
    diagnostics: [],
    features: {
      internalPull: [],
      gpioInterrupt: [],
      restart: false,
      unsupported: [],
      ...(requires ? { requires } : {}),
    },
    analyzer: 3,
  }) as unknown as StoredBuild;

function fixture() {
  const dir = tempDir('tbi-records-');
  cleanup.push(dir);
  const path = join(dir, 'grants.db');
  const g = new Grants(path);
  g.recordBuild(A, build(sha('a'), 'k1', ['input-read'])); // v5: incompatible
  g.recordBuild(GLOBAL, build(sha('b'), 'k2', ['i2c', 'i2c-clock', 'input-read'])); // v5 example
  g.recordBuild(B, build(sha('c'), 'k3', ['gpio-irq', 'input-read'])); // v5 interrupts
  g.recordBuild(B, build(sha('d'), 'k4', ['i2c'])); // runs on v4: kept
  g.recordBuild(A, build(sha('e'), 'k5')); // no requirement: kept
  g.recordPrebuilt(A, sha('f'), 100); // a user's uploaded image: never touched
  return { dir, path };
}

describe('build records across a rollback to Runtime v4', () => {
  it('names exactly the build records requiring a capability v4 does not announce', () => {
    const { path } = fixture();
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = readRows(db);
    const found = incompatibleRecords(rows, V4);
    expect(found.map((f) => [f.row.sha256[0], f.missing])).toEqual([
      ['a', ['input-read']],
      ['b', ['i2c-clock', 'input-read']],
      ['c', ['gpio-irq', 'input-read']],
    ]);
    // On v5 itself nothing is incompatible.
    expect(incompatibleRecords(rows, [...V4, 'gpio-irq', 'i2c-clock', 'input-read'])).toEqual([]);
    // The summary names no principal.
    const s = summarize(found, rows.length);
    expect(s).toMatchObject({ rows: 6, incompatible: 3, global: 1, user: 2, users: 2 });
    expect(JSON.stringify(s)).not.toContain(A);
    expect(JSON.stringify(s)).not.toContain(B);
    db.close();
  });

  it('backs up, deletes only those rows, and restores them without overwriting a rebuilt one', () => {
    const { dir, path } = fixture();
    const backup = join(dir, 'removed.jsonl');
    const db = new DatabaseSync(path);
    const before = readRows(db);
    const removed = removeIncompatible(db, V4, backup);
    expect(removed).toHaveLength(3);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(readFileSync(backup, 'utf8').trim().split('\n')).toHaveLength(3);
    const after = readRows(db);
    expect(after.map((r) => r.sha256[0]).sort()).toEqual(['d', 'e', 'f']);
    // A second run never overwrites the backup.
    expect(() => removeIncompatible(db, V4, backup)).toThrow('exists');
    // The older service rebuilt one of them meanwhile (same key and image): that row is kept.
    const g = new Grants(path);
    g.recordBuild(A, build(sha('a'), 'k1'));
    expect(restore(db, backup)).toEqual({ restored: 2, kept: 1 });
    const back = readRows(db);
    expect(back).toHaveLength(before.length);
    expect(JSON.parse(back.find((r) => r.sha256 === sha('a'))!.record!).features.requires).toBe(
      undefined,
    );
    db.close();
    expect(existsSync(backup)).toBe(true);
  });
});
