/**
 * K12 slice 1: `PendingStore.deleteNow` (the owner deletes one request now). Temporary
 * directories only. The HTTP route (DELETE /signups/<id>, owner only) is tested in
 * admin-service.test.ts with the service's own harness.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SignupApprover } from '../signup/service.js';
import { PendingStore } from '../signup/store.js';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) {
    try {
      chmodSync(join(d, 'p'), 0o700);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const T0 = Date.UTC(2026, 10, 24, 12);
const INPUT = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  role: 'Teacher',
  lang: 'he' as const,
  consent: true as const,
};

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-delete-'));
  roots.push(root);
  const dir = join(root, 'p');
  const store = new PendingStore(dir, { now: () => T0 });
  await store.init();
  return { dir, store };
}

const mark = (email: string) => `${createHash('sha256').update(email).digest('hex')}.mark`;

describe('PendingStore.deleteNow', () => {
  it('removes the record, both markers, the address marker and crash leftovers; audits "<id> delete ok"', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    const { record: keep } = await s.store.createIfNew({ ...INPUT, email: 'keep@example.com' });
    await s.store.markNotified(r.id);
    await s.store.markNotifyPending(r.id);
    writeFileSync(join(s.dir, `${r.id}.abcdef012345.tmp`), 'x', { mode: 0o600 });
    expect(readdirSync(s.dir)).toContain(mark(INPUT.email));

    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    const left = readdirSync(s.dir).sort();
    expect(left).toEqual(['audit.log', `${keep.id}.json`, mark('keep@example.com')].sort());
    const audit = readFileSync(join(s.dir, 'audit.log'), 'utf8');
    expect(audit).toBe(`${new Date(T0).toISOString()} ${r.id} delete ok\n`);
    for (const personal of ['dana', 'Dana', 'example.com', 'Teacher'])
      expect(audit).not.toContain(personal);
    await expect(s.store.get(r.id)).rejects.toThrow('not_found');
    // The other request is untouched; the address may apply again (no stale de-dup lock).
    expect((await s.store.get(keep.id)).email).toBe('keep@example.com');
    expect((await s.store.createIfNew(INPUT)).created).toBe(true);
  });

  it('twice is a no-op: already_deleted, no second audit line', async () => {
    const s = await setup();
    const r = await s.store.create(INPUT);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(await s.store.deleteNow(r.id)).toBe('already_deleted');
    expect(readFileSync(join(s.dir, 'audit.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('an unknown or malformed id is not_found and changes nothing', async () => {
    const s = await setup();
    const r = await s.store.create(INPUT);
    await s.store.audit(r.id, 'approve', 'ok');
    const before = readdirSync(s.dir).sort();
    for (const id of ['0123456789ABCDEFGHJKMNPQRS', '../etc', '', `${r.id}x`, 'pending'])
      expect(await s.store.deleteNow(id)).toBe('not_found');
    expect(readdirSync(s.dir).sort()).toEqual(before);
    // "approve ok" for an id is not mistaken for an earlier delete.
    const other = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ';
    await s.store.audit(other, 'delete', 'okay');
    expect(await s.store.deleteNow(other)).toBe('not_found');
  });

  it('deletes whatever the status, and an unparseable record file too', async () => {
    const s = await setup();
    const a = await s.store.create(INPUT);
    await s.store.update(a.id, { status: 'email_sent', accountAdded: true });
    expect(await s.store.deleteNow(a.id)).toBe('deleted');
    const b = await s.store.create({ ...INPUT, email: 'b@example.com' });
    writeFileSync(join(s.dir, `${b.id}.json`), '{broken', { mode: 0o600 });
    expect(await s.store.deleteNow(b.id)).toBe('deleted');
    expect(existsSync(join(s.dir, `${b.id}.json`))).toBe(false);
  });

  it('a failing unlink is incomplete (no delete ok, the record stays for a retry)', async () => {
    const s = await setup();
    const r = await s.store.create(INPUT);
    chmodSync(s.dir, 0o500);
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    chmodSync(s.dir, 0o700);
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    expect(existsSync(join(s.dir, 'audit.log'))).toBe(false);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
  });

  it('serialised with the approver: a delete queued behind an approve sees its result and still deletes', async () => {
    const s = await setup();
    const r = await s.store.create(INPUT);
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const approver = new SignupApprover({
      store: s.store,
      accounts: {
        add: async () => {
          await gate;
          return 'done';
        },
      },
      email: { sendApproval: async () => undefined },
      now: () => T0,
    });
    const approving = approver.approve(r.id);
    const deleting = approver.remove(r.id);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    release();
    expect((await approving).ok).toBe(true);
    expect(await deleting).toBe('deleted');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(false);
    const audit = readFileSync(join(s.dir, 'audit.log'), 'utf8');
    expect(audit).toMatch(new RegExp(`${r.id} approve ok\\n.* ${r.id} delete ok\\n$`));
  });
  it('a web record: deleteNow removes <id>.web before the record and frees the web sub-cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tbi-signup-delete-'));
    roots.push(root);
    const dir = join(root, 'p');
    const store = new PendingStore(dir, { now: () => T0, maxWebRecords: 1 });
    await store.init();
    const { record: r } = await store.createIfNew(INPUT, { origin: 'web' });
    expect(existsSync(join(dir, `${r.id}.web`))).toBe(true);
    // The sub-cap is full: a second web request is refused.
    await expect(
      store.createIfNew({ ...INPUT, email: 'second@example.com' }, { origin: 'web' }),
    ).rejects.toMatchObject({ code: 'full' });
    expect(await store.deleteNow(r.id)).toBe('deleted');
    expect(existsSync(join(dir, `${r.id}.web`))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.web'))).toEqual([]);
    // The slot is free again.
    const again = await store.createIfNew(
      { ...INPUT, email: 'second@example.com' },
      { origin: 'web' },
    );
    expect(again.created).toBe(true);
  });

  it('an orphan <id>.web marker (no record) is cleared on not_found and on already_deleted', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT, { origin: 'web' });
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    // A crash-style leftover: the marker without its record, after the delete.
    writeFileSync(join(s.dir, `${r.id}.web`), '');
    expect(await s.store.deleteNow(r.id)).toBe('already_deleted');
    expect(existsSync(join(s.dir, `${r.id}.web`))).toBe(false);
    const unknown = '01KZZZZZZZZZZZZZZZZZZZZZZZ';
    writeFileSync(join(s.dir, `${unknown}.web`), '');
    expect(await s.store.deleteNow(unknown)).toBe('not_found');
    expect(existsSync(join(s.dir, `${unknown}.web`))).toBe(false);
  });
});
