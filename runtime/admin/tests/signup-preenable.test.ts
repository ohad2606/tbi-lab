/**
 * BETA-G1 pre-enable safety fixes. Real fs in a private temp dir; errors injected through a
 * `node:fs/promises` seam (vi.mock pass-through with per-test faults), not chmod only.
 *   1. owner approval after a failed automatic add: shown as the owner's, never "automatic"
 *   2. explicit owner approve / resend in quiet hours: bind and check BEFORE queueing
 *   3. deleteNow / purge: never "deleted" while a file or the verify state remains
 *   4. an unreadable record (EIO / EACCES) is never "gone"
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Fault = (op: string, path: string) => string | undefined;
const seam = vi.hoisted(() => ({ faults: [] as Fault[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrap =
    <F extends (...a: never[]) => Promise<unknown>>(op: string, fn: F) =>
    (...a: Parameters<F>): ReturnType<F> => {
      const p = String(a[0]);
      for (const f of seam.faults) {
        const code = f(op, p);
        if (code)
          return Promise.reject(
            Object.assign(new Error(`${code}: injected`), { code }),
          ) as ReturnType<F>;
      }
      return fn(...a) as ReturnType<F>;
    };
  const out = {
    ...real,
    unlink: wrap('unlink', real.unlink),
    readFile: wrap('readFile', real.readFile),
  };
  return { ...out, default: out };
});

import { AUTO_MARKER_FILE, AUTO_STATE_FILE, AutoApprover } from '../signup/autoApprove.js';
import type { EmailSender } from '../signup/email.js';
import { parseQuiet } from '../signup/quietHours.js';
import {
  SignupApprover,
  type AccountAdder,
  type AddOutcome,
  type ApprovalMailBinding,
} from '../signup/service.js';
import { PendingStore, StoreError } from '../signup/store.js';
import { collectSummary } from '../signup/summaryAdmin.js';

const NOON_IL = Date.parse('2026-11-23T10:00:00Z'); // 12:00 Israel
const NIGHT_IL = Date.parse('2026-11-23T22:00:00Z'); // 00:00 Israel
const DAY_MS = 86_400_000;
const person = (i: number) => ({
  name: `Tester ${i}`,
  email: `tester${i}@example.com`,
  role: 'Student',
  lang: 'en' as const,
  consent: true as const,
});

const roots: string[] = [];
const allLogs: string[] = [];
afterEach(() => {
  seam.faults.splice(0);
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  // Fixed class codes only: no id, address, name, path or token.
  for (const l of allLogs.splice(0))
    expect(l).not.toMatch(/@|example\.com|Tester|[0-9A-HJKMNP-TV-Z]{26}|\/tmp\/|\.cache|v1\./);
});

const fault = (op: string, test: (p: string) => boolean, code: string) =>
  seam.faults.push((o, p) => (o === op && test(p) ? code : undefined));

async function rig(o: { onRemoved?: (id: string) => Promise<void> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tbi-g1-pre-')));
  roots.push(root);
  const dir = join(root, 'p');
  const clock = { t: NOON_IL };
  const store = new PendingStore(dir, {
    now: () => clock.t,
    maxRecords: 100,
    ...(o.onRemoved ? { onRemoved: o.onRemoved } : {}),
  });
  await store.init();
  return { root, dir, store, clock };
}
const audit = (dir: string) =>
  existsSync(join(dir, 'audit.log')) ? readFileSync(join(dir, 'audit.log'), 'utf8') : '';
const filesOf = (dir: string, id: string) => readdirSync(dir).filter((f) => f.startsWith(id));
const markOf = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.mark'));

describe('item 3: deleteNow is deleted only when everything is gone', () => {
  it('EPERM on a .tmp: incomplete, no delete ok, record kept; the retry deletes', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    writeFileSync(join(s.dir, `${r.id}.abcdef012345.tmp`), 'x');
    fault('unlink', (p) => p.endsWith('.tmp'), 'EPERM');
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    expect(audit(s.dir)).not.toMatch(/ delete ok/);
    expect(audit(s.dir)).toMatch(new RegExp(` ${r.id} delete incomplete\n`));
    seam.faults.splice(0);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(filesOf(s.dir, r.id)).toEqual([]);
    expect(markOf(s.dir)).toEqual([]);
    expect(audit(s.dir).match(/ delete ok/g)).toHaveLength(1);
  });

  it('EISDIR on a .tmp is a failure too (only intake-made names may be directories)', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    writeFileSync(join(s.dir, `${r.id}.abcdef012345.tmp`), 'x');
    fault('unlink', (p) => p.endsWith('.tmp'), 'EISDIR');
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
  });

  it('EPERM on a .vq- marker is a failure', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    writeFileSync(join(s.dir, `${r.id}.vq-0123456789abcdef`), '');
    fault('unlink', (p) => p.includes('.vq-'), 'EPERM');
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
  });

  it('an unreadable .mark is a failure, not someone else marker; the retry removes it', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    expect(markOf(s.dir)).toHaveLength(1);
    fault('readFile', (p) => p.endsWith('.mark'), 'EACCES');
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(markOf(s.dir)).toHaveLength(1);
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    seam.faults.splice(0);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(markOf(s.dir)).toEqual([]);
  });

  it('onRemoved (verify state) throwing: incomplete; the retry finishes and answers deleted', async () => {
    let fail = true;
    const removed: string[] = [];
    const s = await rig({
      onRemoved: async (id) => {
        if (fail) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        removed.push(id);
      },
    });
    const { record: r } = await s.store.createIfNew(person(1));
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(audit(s.dir)).not.toMatch(/ delete ok/);
    fail = false;
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(removed).toEqual([r.id]);
    expect(audit(s.dir).match(/ delete ok/g)).toHaveLength(1);
    expect(await s.store.deleteNow(r.id)).toBe('already_deleted');
  });

  it('a directory under a .vq- name (EISDIR) is tolerated: still deleted', async () => {
    const s = await rig();
    const { record: r } = await s.store.createIfNew(person(1));
    mkdirSync(join(s.dir, `${r.id}.vq-0123456789abcdef`));
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(false);
  });
});

describe('item 3: retention purge never swallows the record unlink error', () => {
  it('EIO on the record unlink: not reported removed, verify state kept; next run removes', async () => {
    const removed: string[] = [];
    const s = await rig({
      onRemoved: async (id) => {
        removed.push(id);
      },
    });
    const { record: r } = await s.store.createIfNew(person(1));
    s.clock.t = NOON_IL + 100 * DAY_MS;
    fault('unlink', (p) => p.endsWith(`${r.id}.json`), 'EIO');
    expect(await s.store.purge()).toEqual([]);
    expect(s.store.purgeIncomplete).toBe(1);
    expect(removed).toEqual([]);
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    seam.faults.splice(0);
    expect(await s.store.purge()).toEqual([r.id]);
    expect(s.store.purgeIncomplete).toBe(0);
    expect(removed).toEqual([r.id]);
  });
});

describe('item 4: an unreadable record is never gone', () => {
  for (const code of ['EIO', 'EACCES']) {
    it(`${code} on the record read: unreadable; marker kept by purge; approve is not 404`, async () => {
      const s = await rig();
      const { record: r } = await s.store.createIfNew(person(1));
      fault('readFile', (p) => p.endsWith(`${r.id}.json`), code);
      await expect(s.store.get(r.id)).rejects.toMatchObject({ code: 'unreadable' });
      const a = new SignupApprover({
        store: s.store,
        accounts: { add: async () => 'done' },
        email: { sendApproval: async () => undefined },
        now: () => s.clock.t,
      });
      await expect(a.approve(r.id)).rejects.toBeInstanceOf(StoreError);
      // The address marker is old enough to be an orphan if the record were gone.
      const mark = join(s.dir, markOf(s.dir)[0]!);
      utimesSync(mark, new Date(NOON_IL - DAY_MS), new Date(NOON_IL - DAY_MS));
      s.clock.t = NOON_IL + 2 * 3_600_000;
      await s.store.purge();
      expect(existsSync(mark)).toBe(true);
      // A second request for the same address never takes the marker over.
      await expect(s.store.createIfNew(person(1))).rejects.toMatchObject({ code: 'unreadable' });
      expect(readFileSync(mark, 'utf8').trim()).toBe(r.id);
      seam.faults.splice(0);
      expect((await s.store.createIfNew(person(1))).created).toBe(false);
    });
  }

  it('ENOENT / ENOTDIR stay not_found', async () => {
    const s = await rig();
    await expect(s.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toMatchObject({
      code: 'not_found',
    });
    fault('readFile', (p) => p.endsWith('01ARZ3NDEKTSV4RRFFQ69G5FAW.json'), 'ENOTDIR');
    await expect(s.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAW')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

/** Auto approver + owner approver over one store; the account answers are scripted. */
async function autoRig(o: { quiet?: string; binding?: ApprovalMailBinding } = {}) {
  const s = await rig();
  const answers: AddOutcome[] = [];
  const added: string[] = [];
  const mails: string[] = [];
  const log = (l: string) => allLogs.push(l);
  const accounts: AccountAdder = {
    add: async (email) => {
      const a = answers.shift() ?? 'done';
      if (a === 'done') added.push(email);
      return a;
    },
  };
  const email: EmailSender = {
    sendApproval: async (to) => {
      mails.push(to.id);
    },
  };
  const now = () => s.clock.t;
  const quiet = o.quiet ? parseQuiet(o.quiet) : null;
  const binding = o.binding ? { mailBinding: o.binding } : {};
  const owner = () =>
    new SignupApprover({
      store: s.store,
      accounts,
      email,
      quiet,
      now,
      log,
      ownerActions: true,
      ...binding,
    });
  const drainer = (paused?: () => Promise<boolean>) =>
    new SignupApprover({
      store: s.store,
      accounts: { add: async () => 'error' },
      email,
      quiet,
      now,
      log,
      ...binding,
      ...(paused ? { paused } : {}),
    });
  const auto = () =>
    new AutoApprover({
      dir: s.dir,
      store: s.store,
      dailyCap: 3,
      now,
      log,
      since: NOON_IL - DAY_MS,
      approver: () =>
        new SignupApprover({ store: s.store, accounts, email, quiet, now, log, actor: 'auto' }),
    });
  return { ...s, answers, added, mails, owner, drainer, auto };
}
const counterOf = (dir: string) =>
  (JSON.parse(readFileSync(join(dir, AUTO_STATE_FILE), 'utf8')) as { count: number }).count;
const summaryAuto = async (s: { store: PendingStore; dir: string; clock: { t: number } }) =>
  (
    await collectSummary({
      storeDir: s.dir,
      store: s.store,
      auto: null,
      verify: null,
      mail: null,
      pauseDir: null,
      now: () => s.clock.t,
    })
  ).today.autoApproved;

describe('item 1: owner approval after a failed automatic add', () => {
  it('auto claim -> add error -> owner approve: owner label, count unchanged, never re-claimed', async () => {
    const s = await autoRig();
    s.clock.t = NOON_IL - 1000;
    const { record: r } = await s.store.createIfNew(person(1));
    s.clock.t = NOON_IL;
    s.answers.push('error');
    await s.auto().sweep();
    const failed = await s.store.get(r.id);
    expect(failed.status).toBe('pending');
    expect(failed.lastError).toBe('error');
    const autoAt = failed.autoApprovedAt;
    expect(autoAt).toBeTruthy();
    expect(counterOf(s.dir)).toBe(1);

    const out = await s.owner().approve(r.id);
    expect(out.ok).toBe(true);
    const done = await s.store.get(r.id);
    expect(done.accountAdded).toBe(true);
    expect(done.approvedBy).toBe('owner');
    expect(done.autoApprovedAt).toBe(autoAt); // never cleared
    expect(await summaryAuto(s)).toBe(0);
    expect(counterOf(s.dir)).toBe(1);

    // The auto marker on the record survives deletion of the state and marker files.
    unlinkSync(join(s.dir, AUTO_STATE_FILE));
    rmSync(join(s.dir, AUTO_MARKER_FILE), { force: true });
    await s.auto().sweep();
    expect(s.added).toHaveLength(1);
    expect((await s.store.get(r.id)).autoApprovedAt).toBe(autoAt);
  });

  it('a successful automatic approval stays automatic (no approvedBy)', async () => {
    const s = await autoRig();
    s.clock.t = NOON_IL - 1000;
    const { record: r } = await s.store.createIfNew(person(1));
    s.clock.t = NOON_IL;
    await s.auto().sweep();
    const rec = await s.store.get(r.id);
    expect(rec.accountAdded).toBe(true);
    expect(rec.approvedBy).toBeUndefined();
    expect(await summaryAuto(s)).toBe(1);
  });

  it('paused + forged approvedBy on an auto row: the mail stays held', async () => {
    const s = await autoRig();
    const { record: r } = await s.store.createIfNew(person(1));
    await s.store.update(r.id, {
      status: 'email_queued',
      accountAdded: true,
      autoApprovedAt: new Date(NOON_IL - 1000).toISOString(),
      approvedBy: 'owner',
      emailSendAfter: new Date(NOON_IL - 1000).toISOString(),
    });
    expect(await s.drainer(async () => true).drainEmails()).toBe(0);
    expect(s.mails).toEqual([]);
    expect((await s.store.get(r.id)).status).toBe('email_queued');
  });
});

describe('item 2: quiet hours, the owner binds and checks before queueing', () => {
  const failingBind = (): ApprovalMailBinding & { binds: number } => {
    const b = {
      binds: 0,
      bindApproval: async () => {
        b.binds++;
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
      checkApproval: async () => 'unbound',
      hasApproval: async () => false,
    };
    return b;
  };

  it('owner approve with a failing bind: unbound_state, nothing queued, the drain sends nothing', async () => {
    const binding = failingBind();
    const s = await autoRig({ quiet: '22:00-07:00', binding });
    s.clock.t = NIGHT_IL;
    const { record: r } = await s.store.createIfNew(person(1));
    const out = await s.owner().approve(r.id);
    expect(out).toMatchObject({ ok: false, code: 'unbound_state' });
    expect(binding.binds).toBeGreaterThan(0);
    const after = await s.store.get(r.id);
    expect(after.status).not.toBe('email_queued');
    expect(after.emailSendAfter).toBeNull();
    s.clock.t = NOON_IL + DAY_MS;
    expect(await s.drainer().drainEmails()).toBe(0);
    expect(s.mails).toEqual([]);
    expect(audit(s.dir)).toMatch(new RegExp(` ${r.id} approve unbound_state\n`));
  });

  it('owner resend of a failed mail in quiet hours with a failing bind: refused, not queued', async () => {
    const binding = failingBind();
    const s = await autoRig({ quiet: '22:00-07:00', binding });
    s.clock.t = NIGHT_IL;
    const { record: r } = await s.store.createIfNew(person(1));
    await s.store.update(r.id, { status: 'email_failed', accountAdded: true, origin: undefined });
    // A bound request (hasApproval) whose mail check fails at the send.
    binding.hasApproval = async () => true;
    const out = await s.owner().resend(r.id);
    expect(out).toMatchObject({ ok: false, code: 'unbound_state' });
    expect((await s.store.get(r.id)).status).toBe('email_failed');
  });

  it('owner approve with a working bind still queues in quiet hours', async () => {
    const bound = new Set<string>();
    const s = await autoRig({
      quiet: '22:00-07:00',
      binding: {
        bindApproval: async (id) => {
          bound.add(id);
        },
        checkApproval: async (id) => (bound.has(id) ? 'ok' : 'unbound'),
        hasApproval: async (id) => bound.has(id),
      },
    });
    s.clock.t = NIGHT_IL;
    const { record: r } = await s.store.createIfNew(person(1));
    const out = await s.owner().approve(r.id);
    expect(out).toMatchObject({ ok: true, note: 'email_queued' });
    expect(s.mails).toEqual([]);
  });

  it('the drain never binds (a queued unbound mail fails, no bind call)', async () => {
    const binding = failingBind();
    const s = await autoRig({ quiet: '22:00-07:00', binding });
    const { record: r } = await s.store.createIfNew(person(1));
    await s.store.update(r.id, {
      status: 'email_queued',
      accountAdded: true,
      emailSendAfter: new Date(NOON_IL - 1000).toISOString(),
    });
    await s.drainer().drainEmails();
    expect(binding.binds).toBe(0);
    expect(s.mails).toEqual([]);
  });
});
