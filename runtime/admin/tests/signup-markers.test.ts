/**
 * BETA-G1 pre-enable QA/security findings: odd directory entries (directory, symlink, FIFO,
 * unreadable marker) never block other requests; unknown ids stay unknown. Real fs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PendingStore } from '../signup/store.js';

const person = (i: number) => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'Student',
  lang: 'en' as const,
  consent: true as const,
});
const UNKNOWN = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ';
const markName = (email: string) => `${createHash('sha256').update(email).digest('hex')}.mark`;
const FOREIGN = `${'a'.repeat(64)}.mark`;
const asRoot = process.getuid?.() === 0;

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig(o: { onRemoved?: (id: string) => Promise<void> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-mark-')));
  roots.push(root);
  const dir = join(root, 'p');
  const logs: string[] = [];
  const store = new PendingStore(dir, { log: (l) => logs.push(l), ...o });
  await store.init();
  return { root, dir, store, logs };
}
const audit = (dir: string) =>
  existsSync(join(dir, 'audit.log')) ? readFileSync(join(dir, 'audit.log'), 'utf8') : '';

const odd: Array<[string, (path: string, root: string, holder: string) => void]> = [
  ['directory', (p) => mkdirSync(p)],
  [
    'symlink',
    (p, root, holder) => {
      writeFileSync(join(root, 'outside'), `${holder}\n`);
      symlinkSync(join(root, 'outside'), p);
    },
  ],
  ['FIFO', (p) => void execFileSync('mkfifo', [p])],
];

describe('A: a non-regular .mark entry cannot hold an id', () => {
  for (const [kind, make] of odd) {
    it(`${kind}: other ids delete and purge; the entry is neither followed nor removed`, async () => {
      const s = await rig();
      const { record: r } = await s.store.createIfNew(person(1));
      const { record: w } = await s.store.createIfNew({ ...person(2) }, { origin: 'web' });
      make(join(s.dir, FOREIGN), s.root, r.id);
      expect(await s.store.deleteNow(r.id)).toBe('deleted');
      expect(
        await s.store.purgeIf(
          w.id,
          async () => true,
          async () => undefined,
        ),
      ).toBe(true);
      await s.store.purge();
      expect(lstatSync(join(s.dir, FOREIGN))).toBeDefined();
    }, 10_000);

    it(`${kind} at the own address: delete, create and resend do not hang or follow it`, async () => {
      const s = await rig();
      const { record: r } = await s.store.createIfNew(person(1), { origin: 'web' });
      const own = join(s.dir, markName(person(1).email));
      unlinkSync(own);
      make(own, s.root, r.id);
      expect(await s.store.writeResendMarkerFor(person(1).email)).toBe('skip');
      if (kind === 'directory')
        await expect(s.store.createIfNew(person(1))).rejects.toMatchObject({ code: 'corrupt' });
      else expect((await s.store.createIfNew(person(1))).created).toBe(true);
      // BETA-G1 delete truth: a directory still wedges the address, so the delete is not done.
      // A symlink or FIFO was replaced by the new request's regular marker above (not wedged).
      expect(await s.store.deleteNow(r.id)).toBe(kind === 'directory' ? 'incomplete' : 'deleted');
    }, 10_000);
  }

  it.skipIf(asRoot)('a foreign unreadable marker is skipped with a fixed log class', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    const { record: w } = await s.store.createIfNew(person(2), { origin: 'web' });
    writeFileSync(join(s.dir, FOREIGN), 'x');
    chmodSync(join(s.dir, FOREIGN), 0o000);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(
      await s.store.purgeIf(
        w.id,
        async () => true,
        async () => undefined,
      ),
    ).toBe(true);
    expect(existsSync(join(s.dir, FOREIGN))).toBe(true);
    expect(s.logs).toContain('signup: foreign marker skipped (unreadable)');
    for (const l of s.logs) expect(l).not.toMatch(/@|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{64}|\//);
  });

  it.skipIf(asRoot)('the own unreadable marker is incomplete, with a class-only log', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    const own = join(s.dir, markName(person(1).email));
    chmodSync(own, 0o000);
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    expect(s.logs).toEqual(['signup: delete incomplete (EACCES)']);
    chmodSync(own, 0o600);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
  });

  it.skipIf(asRoot)('record unparseable: any unreadable regular marker is incomplete', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    writeFileSync(join(s.dir, `${r.id}.json`), '{broken');
    writeFileSync(join(s.dir, FOREIGN), 'x');
    chmodSync(join(s.dir, FOREIGN), 0o000);
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
  });

  it('F: an error without a usable code logs a fixed class only', async () => {
    const s = await rig({
      onRemoved: async () => {
        throw Object.assign(new Error('/secret/path a@b.c'), { code: '/secret/path' });
      },
    });
    const { record: r } = await s.store.createIfNew(person(1));
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatch(/^signup: delete incomplete \([A-Za-z_]+\)$/);
  });
});

describe('B: an unknown id stays unknown', () => {
  it('failing cleanup steps: not_found twice, nothing audited', async () => {
    const s = await rig({
      onRemoved: async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    });
    mkdirSync(join(s.dir, FOREIGN));
    if (!asRoot) writeFileSync(join(s.dir, `${'b'.repeat(64)}.mark`), 'x', { mode: 0o000 });
    expect(await s.store.deleteNow(UNKNOWN)).toBe('not_found');
    expect(await s.store.deleteNow(UNKNOWN)).toBe('not_found');
    expect(audit(s.dir)).toBe('');
  });
});

describe('C: a directory under a .tmp name is not a record copy', () => {
  it('delete and purgeIf succeed; the directory is left alone', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    const { record: w } = await s.store.createIfNew(person(2), { origin: 'web' });
    for (const id of [r.id, w.id]) mkdirSync(join(s.dir, `${id}.x.tmp`));
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(
      await s.store.purgeIf(
        w.id,
        async () => true,
        async () => undefined,
      ),
    ).toBe(true);
    expect(readdirSync(s.dir)).toContain(`${r.id}.x.tmp`);
  });
});
