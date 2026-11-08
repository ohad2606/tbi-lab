/**
 * Alpha Convergence RC: the projects Alpha's testers have today (schema v3, the running Alpha line
 * 2fe1ca0) open on this source without data loss. The fixtures are that commit's own documents,
 * byte for byte. And the other direction: a document of this source is `newer` for a v3 reader, so
 * a rolled-back Alpha build opens it read-only instead of guessing (the v3 reader's rule is
 * reproduced here by passing current = 3; its code path is the same since v3).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  createPackage,
  openDocument,
  parsePackage,
  serializePackage,
  validateProject,
} from '@tbi-lab/domain';

const DIR = new URL('./fixtures/alpha-v3/', import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const read = (f: string) =>
  JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Record<string, unknown>;

describe('Alpha v3 projects on this source', () => {
  it('has the whole Alpha example set', () => {
    expect(files).toHaveLength(22);
    for (const f of files) expect(read(f).schemaVersion, f).toBe(3);
  });

  for (const f of files) {
    it(`${f}: opens, valid, every field kept, only the version changes`, () => {
      const raw = read(f);
      const out = openDocument(raw);
      expect(out.status, f).toBe('ok');
      if (out.status !== 'ok') return;
      expect(validateProject(out.doc), f).toEqual([]);
      expect({ ...out.doc, schemaVersion: 3 }).toEqual(raw);
      expect(out.doc.schemaVersion).toBe(SCHEMA_VERSION);
      // Export and import on this source: the same project.
      const text = serializePackage(
        createPackage(out.doc, {
          appVersion: 'rc6-test',
          exportedAt: '2026-11-08T00:00:00.000Z',
        }),
      );
      const back = parsePackage(text);
      expect(back.ok, f).toBe(true);
      if (back.ok) expect(back.doc).toEqual(out.doc);
    });
  }

  it('a document of this source is `newer` for a v3 reader: never guessed at, nothing changes', () => {
    const out = openDocument(read(files[0]!));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const before = JSON.stringify(out.doc);
    const v3Reader = openDocument(JSON.parse(before), MIGRATIONS, 3);
    expect(v3Reader.status).toBe('newer');
    expect(JSON.stringify(out.doc)).toBe(before);
  });
});
