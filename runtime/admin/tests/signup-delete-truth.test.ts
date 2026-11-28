/**
 * BETA-G1 delete truthfulness: a request's own address marker that is not a regular file keeps
 * the delete `incomplete` (never "deleted" while the address lock stays wedged), and an unknown
 * id's cleanup failure is logged by class only. Temporary directories only.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
    for (const f of readdirSync(join(d, 'p'), { withFileTypes: true }))
      if (f.isFile()) chmodSync(join(d, 'p', f.name), 0o600);
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
const mark = (email: string) => `${createHash('sha256').update(email).digest('hex')}.mark`;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-delete-truth-'));
  roots.push(root);
  const dir = join(root, 'p');
  const logs: string[] = [];
  const store = new PendingStore(dir, { now: () => T0, log: (l) => logs.push(l) });
  await store.init();
  return { root, dir, store, logs };
}

const audit = (dir: string) => {
  try {
    return readFileSync(join(dir, 'audit.log'), 'utf8');
  } catch {
    return '';
  }
};

type Kind = 'directory' | 'symlink' | 'fifo';
function replaceOwnMark(root: string, dir: string, kind: Kind): { path: string; outside: string } {
  const path = join(dir, mark(INPUT.email));
  unlinkSync(path);
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'outside-content', { mode: 0o600 });
  if (kind === 'directory') {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, 'inner'), 'x');
  } else if (kind === 'symlink') symlinkSync(outside, path);
  else execFileSync('mkfifo', ['-m', '600', path]);
  return { path, outside };
}

describe('deleteNow: own address marker that is not a regular file', () => {
  for (const kind of ['directory', 'symlink', 'fifo'] as const) {
    it(`${kind} at the own .mark: incomplete, audited, class-only log, target untouched`, async () => {
      const s = await setup();
      const { record: r } = await s.store.createIfNew(INPUT);
      const { path, outside } = replaceOwnMark(s.root, s.dir, kind);

      expect(await s.store.deleteNow(r.id)).toBe('incomplete');
      // The record stays (a partial delete keeps it); the entry and the symlink target remain.
      expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
      const st = lstatSync(path);
      if (kind === 'directory') {
        expect(st.isDirectory()).toBe(true);
        expect(existsSync(join(path, 'inner'))).toBe(true);
      } else if (kind === 'symlink') expect(st.isSymbolicLink()).toBe(true);
      else expect(st.isFIFO()).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('outside-content');
      expect(audit(s.dir)).toBe(`${new Date(T0).toISOString()} ${r.id} delete incomplete\n`);
      expect(s.logs).toEqual(['signup: delete incomplete (mark_not_file)']);
      for (const l of s.logs)
        for (const secret of [r.id, 'dana', 'example', mark(INPUT.email).slice(0, 16), s.dir])
          expect(l).not.toContain(secret);

      // A retry is still incomplete (idempotent, never "deleted" while the entry remains) ...
      expect(await s.store.deleteNow(r.id)).toBe('incomplete');
      expect(audit(s.dir)).not.toContain('delete ok');
      // ... and finishes once the operator removed the entry.
      rmSync(path, { recursive: true, force: true });
      expect(await s.store.deleteNow(r.id)).toBe('deleted');
      expect(readFileSync(outside, 'utf8')).toBe('outside-content');
    });
  }

  it('a non-file marker of another address stays skipped (delete ok, entry untouched)', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    const foreign = join(s.dir, mark('other@example.com'));
    mkdirSync(foreign, { mode: 0o700 });
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(lstatSync(foreign).isDirectory()).toBe(true);
  });

  it('purgeIf applies the same rule: the record is kept and the call fails with mark_not_file', async () => {
    const s = await setup();
    const { record } = await s.store.createIfNew(INPUT, { origin: 'web' });
    const id = record.id;
    const { path } = replaceOwnMark(s.root, s.dir, 'directory');
    await expect(
      s.store.purgeIf(
        id,
        async () => true,
        async () => undefined,
      ),
    ).rejects.toThrow('mark_not_file');
    expect(existsSync(join(s.dir, `${id}.json`))).toBe(true);
    expect(lstatSync(path).isDirectory()).toBe(true);
  });
});

describe('deleteNow: record unreadable or gone, a non-file .mark (ownMark unknown)', () => {
  it('unreadable record + directory .mark: incomplete (never deleted), entry untouched, record last', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    const { path } = replaceOwnMark(s.root, s.dir, 'directory');
    chmodSync(join(s.dir, `${r.id}.json`), 0o000);

    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(existsSync(join(path, 'inner'))).toBe(true);
    expect(audit(s.dir)).toBe(`${new Date(T0).toISOString()} ${r.id} delete incomplete\n`);
    expect(s.logs).toEqual(['signup: delete incomplete (mark_not_file)']);
    for (const l of s.logs)
      for (const secret of [r.id, 'dana', 'example', mark(INPUT.email).slice(0, 16), s.dir])
        expect(l).not.toContain(secret);

    // The record removed meanwhile (retention): the retry still answers incomplete ...
    chmodSync(join(s.dir, `${r.id}.json`), 0o600);
    unlinkSync(join(s.dir, `${r.id}.json`));
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(audit(s.dir)).not.toContain('delete ok');
    expect(lstatSync(path).isDirectory()).toBe(true);
    // ... and finishes once the operator removed the entry (append-only audit).
    rmSync(path, { recursive: true, force: true });
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(audit(s.dir).split('\n').filter(Boolean)).toEqual([
      `${new Date(T0).toISOString()} ${r.id} delete incomplete`,
      `${new Date(T0).toISOString()} ${r.id} delete incomplete`,
      `${new Date(T0).toISOString()} ${r.id} delete ok`,
    ]);
  });

  it('purge then delete: the purged id answers not_found (never deleted), a non-file .mark stays', async () => {
    const s = await setup();
    const { record } = await s.store.createIfNew(INPUT, { origin: 'web' });
    const id = record.id;
    expect(
      await s.store.purgeIf(
        id,
        async () => true,
        async () => undefined,
      ),
    ).toBe(true);
    const foreign = join(s.dir, mark(INPUT.email));
    mkdirSync(foreign, { mode: 0o700 });
    expect(await s.store.deleteNow(id)).toBe('not_found');
    expect(audit(s.dir)).toBe('');
    expect(lstatSync(foreign).isDirectory()).toBe(true);
  });

  it('leftovers only (no record, no delete audited) with a directory .mark: not_found, never deleted', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    const id = r.id;
    unlinkSync(join(s.dir, `${id}.json`));
    writeFileSync(join(s.dir, `${id}.notified`), '', { mode: 0o600 });
    replaceOwnMark(s.root, s.dir, 'directory');
    expect(await s.store.deleteNow(id)).toBe('not_found');
    expect(await s.store.deleteNow(id)).toBe('not_found');
    expect(audit(s.dir)).not.toContain('delete');
  });
});

describe('deleteNow: unknown id cleanup errors', () => {
  it('an EACCES marker during an unknown-id cleanup: not_found, class-only log, no audit line', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    // Another request's marker made unreadable; the unknown id has no record (ownMark unknown).
    chmodSync(join(s.dir, mark(INPUT.email)), 0o000);
    const unknown = r.id.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(await s.store.deleteNow(unknown)).toBe('not_found');
    expect(audit(s.dir)).toBe('');
    expect(s.logs).toEqual(['signup: unknown-id cleanup failed (EACCES)']);
    for (const secret of [unknown, r.id, 'dana', mark(INPUT.email).slice(0, 16), s.dir])
      expect(s.logs[0]).not.toContain(secret);
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
  });
});

describe('resend of a queued mail held by the pause (BETA-G1 e)', () => {
  async function queuedAuto(auto: boolean) {
    const s = await setup();
    const { record } = await s.store.createIfNew(INPUT, { origin: 'web' });
    await s.store.update(record.id, {
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: new Date(T0).toISOString(),
      lastError: null,
      ...(auto ? { autoApprovedAt: new Date(T0).toISOString() } : {}),
    });
    return { s, id: record.id };
  }
  const approver = (s: Awaited<ReturnType<typeof setup>>, drainHeld?: () => Promise<boolean>) => {
    const sent: string[] = [];
    const a = new SignupApprover({
      store: s.store,
      accounts: { add: async () => 'done' },
      email: {
        sendApproval: async (m: { id: string }) => {
          sent.push(m.id);
        },
      },
      now: () => T0,
      ownerActions: true,
      ...(drainHeld ? { drainHeld } : {}),
    });
    return { a, sent };
  };

  it('paused: email_held_paused, nothing sent, the record stays queued (no bypass)', async () => {
    const { s, id } = await queuedAuto(true);
    const { a, sent } = approver(s, async () => true);
    const out = await a.resend(id);
    expect(out).toMatchObject({ ok: true, note: 'email_held_paused' });
    expect(sent).toEqual([]);
    expect((await s.store.get(id)).status).toBe('email_queued');
  });

  it('a pause-check error counts as paused', async () => {
    const { s, id } = await queuedAuto(true);
    const { a } = approver(s, async () => {
      throw Object.assign(new Error('x'), { code: 'EACCES' });
    });
    expect(await a.resend(id)).toMatchObject({ ok: true, note: 'email_held_paused' });
  });

  it('owner approve of a held queued mail: email_held_paused, nothing sent, still queued', async () => {
    const { s, id } = await queuedAuto(true);
    const { a, sent } = approver(s, async () => true);
    expect(await a.approve(id)).toMatchObject({ ok: true, note: 'email_held_paused' });
    expect(sent).toEqual([]);
    expect((await s.store.get(id)).status).toBe('email_queued');
    const errored = approver(s, async () => {
      throw Object.assign(new Error('x'), { code: 'EACCES' });
    });
    expect(await errored.a.approve(id)).toMatchObject({ note: 'email_held_paused' });
    expect(await approver(s, async () => false).a.approve(id)).toMatchObject({
      note: 'email_queued',
    });
  });

  it('owner resend of email_failed during a pause still sends (runbook: as without a pause)', async () => {
    const { s, id } = await queuedAuto(true);
    await s.store.update(id, { status: 'email_failed', lastError: 'error' });
    const sent: string[] = [];
    const a = new SignupApprover({
      store: s.store,
      accounts: { add: async () => 'done' },
      email: {
        sendApproval: async (m: { id: string }, held?: () => Promise<boolean>) => {
          // The owner's own send carries no pause hold.
          expect(held).toBeUndefined();
          sent.push(m.id);
        },
      },
      now: () => T0,
      ownerActions: true,
      paused: async () => true,
      drainHeld: async () => true,
    });
    expect(await a.resend(id)).toMatchObject({ ok: true });
    expect(sent).toEqual([id]);
    expect((await s.store.get(id)).status).toBe('email_sent');
  });

  it('not paused, or an owner-approved queued mail: email_queued as before', async () => {
    const one = await queuedAuto(true);
    expect(await approver(one.s, async () => false).a.resend(one.id)).toMatchObject({
      note: 'email_queued',
    });
    const two = await queuedAuto(false);
    expect(await approver(two.s, async () => true).a.resend(two.id)).toMatchObject({
      note: 'email_queued',
    });
  });
});
