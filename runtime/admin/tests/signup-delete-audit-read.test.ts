/**
 * BETA-G1: an audit log that cannot be read is never an empty history. Only ENOENT is; for a GONE
 * record any other read error keeps the delete `incomplete` and removes nothing. A PRESENT record
 * is deleted without reading the history, but only answers `deleted` once `delete started` and
 * `delete ok` were appended. Temporary directories only.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PendingStore } from '../signup/store.js';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INPUT = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  role: 'Teacher',
  lang: 'he' as const,
  consent: true as const,
};
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-delete-audit-'));
  roots.push(root);
  const dir = join(root, 'p');
  const logs: string[] = [];
  const store = new PendingStore(dir, {
    now: () => Date.UTC(2026, 10, 28, 12),
    log: (l) => logs.push(l),
  });
  await store.init();
  const log = join(dir, 'audit.log');
  return { dir, log, store, logs };
}

type S = Awaited<ReturnType<typeof setup>>;

/** Makes the audit log unreadable; returns how to restore it. */
const BROKEN: Record<string, (s: S) => () => void> = {
  EISDIR: (s) => {
    const had = existsSync(s.log);
    if (had) renameSync(s.log, `${s.log}.saved`);
    mkdirSync(s.log, { mode: 0o700 });
    return () => {
      rmdirSync(s.log);
      if (had) renameSync(`${s.log}.saved`, s.log);
    };
  },
  // Write-only: the line can still be appended, the history cannot be read.
  EACCES: (s) => {
    if (!existsSync(s.log)) writeFileSync(s.log, '', { mode: 0o600 });
    chmodSync(s.log, 0o200);
    return () => chmodSync(s.log, 0o600);
  },
};

function expectClassOnly(s: S, code: string, id: string, stage = 'history') {
  expect(s.logs).toContain(`signup: delete incomplete stage=${stage} (${code})`);
  for (const l of s.logs)
    for (const secret of [id, 'dana', 'example', s.dir, 'audit.log'])
      expect(l).not.toContain(secret);
}

describe('deleteNow: unreadable audit log', () => {
  for (const [code, breakLog] of Object.entries(BROKEN)) {
    // root reads a file whatever its mode.
    const skip = code === 'EACCES' && process.getuid?.() === 0;

    it.skipIf(skip)(`${code}: record gone but own data left: incomplete, data kept`, async () => {
      const s = await setup();
      const { record: r } = await s.store.createIfNew(INPUT);
      await s.store.audit(r.id, 'delete', 'incomplete');
      rmSync(join(s.dir, `${r.id}.json`));
      writeFileSync(join(s.dir, `${r.id}.notified`), '', { mode: 0o600 });
      const before = readdirSync(s.dir).sort();
      const restore = breakLog(s);
      expect(await s.store.deleteNow(r.id)).toBe('incomplete');
      restore();
      expect(readdirSync(s.dir).sort()).toEqual(before);
      expectClassOnly(s, code, r.id);
      // Readable again: the open delete finishes.
      expect(await s.store.deleteNow(r.id)).toBe('deleted');
    });

    it.skipIf(skip)(`${code}: after an audited ok: never already_deleted`, async () => {
      const s = await setup();
      const { record: r } = await s.store.createIfNew(INPUT);
      expect(await s.store.deleteNow(r.id)).toBe('deleted');
      const restore = breakLog(s);
      expect(await s.store.deleteNow(r.id)).toBe('incomplete');
      restore();
      expect(await s.store.deleteNow(r.id)).toBe('already_deleted');
    });

    it.skipIf(skip)(`${code}: unknown id: never not_found, nothing audited`, async () => {
      const s = await setup();
      const restore = breakLog(s);
      expect(await s.store.deleteNow(UNKNOWN)).toBe('incomplete');
      restore();
      if (existsSync(s.log)) expect(readFileSync(s.log, 'utf8')).toBe('');
      expectClassOnly(s, code, UNKNOWN);
    });

    it.skipIf(skip)(`${code}: present record: removed only with a durable audit`, async () => {
      const s = await setup();
      const { record: r } = await s.store.createIfNew(INPUT);
      const before = readdirSync(s.dir).sort();
      const restore = breakLog(s);
      const out = await s.store.deleteNow(r.id);
      restore();
      const text = existsSync(s.log) ? readFileSync(s.log, 'utf8') : '';
      const lines = text.split('\n').filter(Boolean);
      if (code === 'EACCES') {
        // Write-only log: the history is not needed for a present record; the lines still land.
        expect(out).toBe('deleted');
        expect(readdirSync(s.dir)).toEqual(['audit.log']);
        expect(lines.map((l) => l.split(' ').slice(1).join(' '))).toEqual([
          `${r.id} delete started`,
          `${r.id} delete ok`,
        ]);
        expect(s.logs).toEqual([]);
        expect(await s.store.deleteNow(r.id)).toBe('already_deleted');
      } else {
        // Not even `started` can be written: nothing is removed.
        expect(out).toBe('incomplete');
        expect(readdirSync(s.dir).filter((f) => f !== 'audit.log')).toEqual(
          before.filter((f) => f !== 'audit.log'),
        );
        expect(lines).toEqual([]);
        expectClassOnly(s, code, r.id, 'audit');
        expect(await s.store.deleteNow(r.id)).toBe('deleted');
      }
    });
  }

  it('a missing audit log (ENOENT) is an empty history: not_found, then a normal delete', async () => {
    const s = await setup();
    expect(await s.store.deleteNow(UNKNOWN)).toBe('not_found');
    const { record: r } = await s.store.createIfNew(INPUT);
    expect(existsSync(s.log)).toBe(false);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
  });
});
