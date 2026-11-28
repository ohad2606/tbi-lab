/**
 * BETA-G1 (day1849 Ideas): `deleted` is never answered without a durable audit line, a lost `ok`
 * line never turns into a later `not_found`, a restored record is deleted again, the retention
 * purge never touches the audit log, and the `delete incomplete` server log carries only a
 * fixed-enum stage tag and an error class. Temporary store directories only.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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

const T0 = Date.UTC(2026, 10, 28, 12);
const DAY = 86_400_000;
const INPUT = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  role: 'Teacher',
  lang: 'he' as const,
  consent: true as const,
};

/** A store whose audit appends can be made to fail (EIO) from a given point on. */
class FlakyStore extends PendingStore {
  failFrom: string | null = null;
  failing = false;
  override async audit(id: string, action: string, outcome: string, actor?: 'auto') {
    if (this.failFrom === outcome) this.failing = true;
    if (this.failing) throw Object.assign(new Error('disk'), { code: 'EIO' });
    return super.audit(id, action, outcome, actor);
  }
}

async function setup(o: { onRemoved?: (id: string) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-delete-started-'));
  roots.push(root);
  const dir = join(root, 'p');
  const logs: string[] = [];
  let now = T0;
  const store = new FlakyStore(dir, {
    now: () => now,
    log: (l) => logs.push(l),
    ...(o.onRemoved ? { onRemoved: o.onRemoved } : {}),
  });
  await store.init();
  const auditLines = () =>
    existsSync(join(dir, 'audit.log'))
      ? readFileSync(join(dir, 'audit.log'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split(' ').slice(1).join(' '))
      : [];
  return { dir, store, logs, auditLines, setNow: (t: number) => (now = t) };
}

const STAGE_LOG =
  /^signup: delete incomplete stage=(history|side|web|record|verify|audit) \((E[A-Z0-9]{1,30}|[a-z_]+)\)$/;

describe('deleteNow: `started` before anything is removed', () => {
  it('a present record: `started` then `ok`, in that order, before `deleted`', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(s.auditLines()).toEqual([`${r.id} delete started`, `${r.id} delete ok`]);
  });

  it('`started` cannot be written: nothing is removed, incomplete (stage=audit)', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    await s.store.markNotified(r.id);
    const before = readdirSync(s.dir).sort();
    s.store.failFrom = 'started';
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(readdirSync(s.dir).sort()).toEqual(before);
    expect(s.logs).toEqual(['signup: delete incomplete stage=audit (EIO)']);
    s.store.failFrom = null;
    s.store.failing = false;
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(s.auditLines()).toEqual([`${r.id} delete started`, `${r.id} delete ok`]);
  });

  it('`ok` cannot be written: incomplete (never deleted); the retry is never not_found', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    s.store.failFrom = 'ok';
    // Everything was removed, but without a durable `ok` the answer is not `deleted`.
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(false);
    expect(s.auditLines()).toEqual([`${r.id} delete started`]);
    expect(s.logs).toEqual(['signup: delete incomplete stage=audit (EIO)']);
    s.store.failFrom = null;
    s.store.failing = false;
    // Before this fix: no line and no file left -> `not_found`. `started` keeps the delete open.
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(s.auditLines()).toEqual([
      `${r.id} delete started`,
      `${r.id} delete started`,
      `${r.id} delete ok`,
    ]);
    expect(await s.store.deleteNow(r.id)).toBe('already_deleted');
  });

  it('a log whose last line for the id is `started` is an open delete, like `incomplete`', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    rmSync(join(s.dir, `${r.id}.json`));
    await s.store.audit(r.id, 'delete', 'started');
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    // The address may apply again: the marker was removed by the re-run.
    expect((await s.store.createIfNew(INPUT)).created).toBe(true);
  });

  it('`started` after an older `ok` reopens it (no already_deleted)', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    await s.store.audit(r.id, 'delete', 'started');
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
  });

  it('audit lines carry only time, id, verb and outcome word', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    s.store.failFrom = 'ok';
    await s.store.deleteNow(r.id);
    s.store.failFrom = null;
    s.store.failing = false;
    await s.store.deleteNow(r.id);
    const text = readFileSync(join(s.dir, 'audit.log'), 'utf8');
    for (const l of text.split('\n').filter(Boolean))
      expect(l).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z [0-9A-HJKMNP-TV-Z]{26} delete (started|ok)$/);
  });
});

describe('retention purge vs a restored record', () => {
  it('a restored, previously deleted record is existing: deleteNow deletes it again', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    const json = readFileSync(join(s.dir, `${r.id}.json`));
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    // A backup restore brings the record back (audit log untouched).
    writeFileSync(join(s.dir, `${r.id}.json`), json, { mode: 0o600 });
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(false);
    expect(s.auditLines()).toEqual([
      `${r.id} delete started`,
      `${r.id} delete ok`,
      `${r.id} delete started`,
      `${r.id} delete ok`,
    ]);
  });

  it('the purge re-checks a restored record and never writes or removes audit lines', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    const json = readFileSync(join(s.dir, `${r.id}.json`));
    expect(await s.store.deleteNow(r.id)).toBe('deleted');
    writeFileSync(join(s.dir, `${r.id}.json`), json, { mode: 0o600 });
    const audit = readFileSync(join(s.dir, 'audit.log'), 'utf8');
    // Not yet expired: kept.
    expect(await s.store.purge()).toEqual([]);
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(true);
    // Past the not-approved retention: removed; the audit log is byte-identical.
    s.setNow(T0 + 91 * DAY);
    expect(await s.store.purge()).toEqual([r.id]);
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(false);
    expect(readFileSync(join(s.dir, 'audit.log'), 'utf8')).toBe(audit);
    // The last audited delete is still `ok`: nothing open, nothing new.
    expect(await s.store.deleteNow(r.id)).toBe('already_deleted');
    expect(readFileSync(join(s.dir, 'audit.log'), 'utf8')).toBe(audit);
  });

  it('a purge and a delete of the same restored record serialise (one removes, one answers)', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    s.setNow(T0 + 91 * DAY);
    const [purged, out] = await Promise.all([s.store.purge(), s.store.deleteNow(r.id)]);
    expect(existsSync(join(s.dir, `${r.id}.json`))).toBe(false);
    if (purged.length === 1) {
      // The purge removed it first: the delete then sees no record and no history.
      expect(out).toBe('not_found');
      expect(s.auditLines()).toEqual([]);
    } else {
      expect(out).toBe('deleted');
      expect(s.auditLines()).toEqual([`${r.id} delete started`, `${r.id} delete ok`]);
    }
  });
});

describe('delete incomplete server log: fixed-enum stage + error class only', () => {
  const secretsOf = (dir: string, id: string) => [id, 'dana', 'Dana', 'example', dir, '.json'];

  it.each([
    ['verify', 'verify'],
    ['web', 'web'],
    ['record', 'record'],
    ['audit', 'audit'],
  ] as const)('stage=%s', async (_n, stage) => {
    const s = await setup({
      onRemoved: async () => {
        if (stage === 'verify')
          throw Object.assign(new Error('/var/x dana@example.com'), { code: 'EBUSY' });
      },
    });
    const { record: r } = await s.store.createIfNew(INPUT);
    if (stage === 'web') {
      mkdirSync(join(s.dir, `${r.id}.web`));
      writeFileSync(join(s.dir, `${r.id}.web`, 'x'), '');
    }
    if (stage === 'record') {
      // Unlink of a directory fails: the record stays and the step is tagged.
      rmSync(join(s.dir, `${r.id}.json`));
      mkdirSync(join(s.dir, `${r.id}.json`));
    }
    if (stage === 'audit') s.store.failFrom = 'started';
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatch(STAGE_LOG);
    expect(s.logs[0]).toContain(`stage=${stage} `);
    for (const secret of secretsOf(s.dir, r.id)) expect(s.logs[0]).not.toContain(secret);
  });

  it('stage=history (gone record, unreadable history) and stage=side (own marker)', async () => {
    const s = await setup();
    const { record: r } = await s.store.createIfNew(INPUT);
    const own = readdirSync(s.dir).find((f) => f.endsWith('.mark'))!;
    rmSync(join(s.dir, own));
    mkdirSync(join(s.dir, own));
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    rmSync(join(s.dir, 'audit.log'));
    mkdirSync(join(s.dir, 'audit.log'));
    rmSync(join(s.dir, `${r.id}.json`));
    expect(await s.store.deleteNow(r.id)).toBe('incomplete');
    expect(s.logs).toEqual([
      'signup: delete incomplete stage=side (mark_not_file)',
      'signup: delete incomplete stage=history (EISDIR)',
    ]);
    for (const l of s.logs) {
      expect(l).toMatch(STAGE_LOG);
      for (const secret of [...secretsOf(s.dir, r.id), own.slice(0, 12)])
        expect(l).not.toContain(secret);
    }
  });
});
