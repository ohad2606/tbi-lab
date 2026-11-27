/**
 * BETA-G1 precondition 5 (shared user): the intake runs as the admin's user and can write any file
 * in the sign-up store. Every read of a store file (records, address markers, the audit log) and the
 * audit append must never follow a symlink, never block on a FIFO, and refuse a non-regular or
 * oversize file. A refused file is handled like an unreadable record today (no crash, no deletion of
 * the target, nothing written through the link).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION, PendingStore, STORE_FILE_MAX_BYTES } from '../signup/store.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const input = {
  name: 'Dana',
  email: 'dana@example.com',
  role: 'T',
  lang: 'en' as const,
  consent: true as const,
};
async function mkStore() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-nf-'));
  roots.push(root);
  const dir = join(root, 'p');
  const store = new PendingStore(dir);
  await store.init();
  return { root, dir, store };
}
const mkfifo = (p: string) => {
  const r = spawnSync('mkfifo', ['-m', '600', p]);
  if (r.status !== 0) throw new Error('mkfifo failed');
};
const markName = (email: string) => `${createHash('sha256').update(email).digest('hex')}.mark`;

describe('sign-up store reads never follow symlinks or block on FIFOs', () => {
  it('a normal record still reads', async () => {
    const { store } = await mkStore();
    const { record } = await store.createIfNew(input);
    expect((await store.get(record.id)).id).toBe(record.id);
    expect(await store.list()).toHaveLength(1);
  });

  it('a record that is a symlink is refused (not_found), skipped by list, target untouched', async () => {
    const { root, dir, store } = await mkStore();
    const { record } = await store.createIfNew(input);
    const outside = join(root, 'outside.json');
    writeFileSync(outside, readFileSync(join(dir, `${record.id}.json`)), { mode: 0o600 });
    rmSync(join(dir, `${record.id}.json`));
    symlinkSync(outside, join(dir, `${record.id}.json`));
    await expect(store.get(record.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.list()).toEqual([]);
    await store.purge(DEFAULT_RETENTION, 10 * 365 * 86_400_000);
    expect(readFileSync(outside, 'utf8')).toContain(record.id);
  });

  it('a record that is a FIFO does not hang and is refused', async () => {
    const { dir, store } = await mkStore();
    const { record } = await store.createIfNew(input);
    rmSync(join(dir, `${record.id}.json`));
    mkfifo(join(dir, `${record.id}.json`));
    await expect(store.get(record.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.list()).toEqual([]);
  }, 5000);

  it('an oversize record is refused (not_found), not deleted', async () => {
    const { dir, store } = await mkStore();
    const { record } = await store.createIfNew(input);
    const p = join(dir, `${record.id}.json`);
    const rec = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    rec.pad = 'x'.repeat(STORE_FILE_MAX_BYTES);
    writeFileSync(p, JSON.stringify(rec), { mode: 0o600 });
    await expect(store.get(record.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(lstatSync(p).size).toBeGreaterThan(STORE_FILE_MAX_BYTES);
  });

  it('the cap is above any legitimate record', () => {
    expect(STORE_FILE_MAX_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });

  it('an address marker that is a symlink is not followed; create replaces the link only', async () => {
    const { root, dir, store } = await mkStore();
    const outside = join(root, 'victim');
    writeFileSync(outside, 'keep\n', { mode: 0o600 });
    symlinkSync(outside, join(dir, markName(input.email)));
    expect(await store.writeResendMarkerFor(input.email)).toBe('skip');
    const r = await store.createIfNew(input);
    expect(r.created).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('keep\n');
    expect(lstatSync(join(dir, markName(input.email))).isSymbolicLink()).toBe(false);
  });

  it('an address marker that is a FIFO does not hang', async () => {
    const { dir, store } = await mkStore();
    mkfifo(join(dir, markName(input.email)));
    expect(await store.writeResendMarkerFor(input.email)).toBe('skip');
    expect((await store.createIfNew(input)).created).toBe(true);
  }, 5000);

  it('audit.log as a symlink: nothing is written through it', async () => {
    const { root, dir, store } = await mkStore();
    const { record } = await store.createIfNew(input);
    const outside = join(root, 'victim.log');
    writeFileSync(outside, '', { mode: 0o600 });
    rmSync(join(dir, 'audit.log'), { force: true });
    symlinkSync(outside, join(dir, 'audit.log'));
    await expect(store.audit(record.id, 'approve', 'ok')).rejects.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('');
  });

  it('audit.log as a FIFO: append and lookup do not hang', async () => {
    const { dir, store } = await mkStore();
    const { record } = await store.createIfNew(input);
    rmSync(join(dir, 'audit.log'), { force: true });
    mkfifo(join(dir, 'audit.log'));
    await expect(store.audit(record.id, 'approve', 'ok')).rejects.toThrow();
    // An unknown id: the audit lookup (refused) answers not_found instead of hanging.
    expect(await store.deleteNow('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('not_found');
    expect(readdirSync(dir)).toContain('audit.log');
  }, 5000);
});
