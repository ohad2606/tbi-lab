/**
 * BETA-G1: an audit log that cannot be read is never an empty history. Only ENOENT is; any other
 * read error keeps the delete `incomplete` and removes nothing. Temporary directories only.
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

function expectClassOnly(s: S, code: string, id: string) {
  expect(s.logs).toContain(`signup: delete incomplete (${code})`);
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

    it.skipIf(skip)(`${code}: present record: incomplete, record kept, retry deletes`, async () => {
      const s = await setup();
      const { record: r } = await s.store.createIfNew(INPUT);
      const before = readdirSync(s.dir).sort();
      const restore = breakLog(s);
      expect(await s.store.deleteNow(r.id)).toBe('incomplete');
      restore();
      expect(readdirSync(s.dir).filter((f) => f !== 'audit.log')).toEqual(before);
      // Append-only: only a log that still takes lines records the attempt.
      if (code === 'EACCES') expect(readFileSync(s.log, 'utf8')).toMatch(/ delete incomplete\n$/);
      expectClassOnly(s, code, r.id);
      expect(await s.store.deleteNow(r.id)).toBe('deleted');
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
