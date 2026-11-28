/**
 * BETA-G1: the audit append starts on its own line after a torn tail, is fsynced before it counts,
 * and never follows a symlink. Any failure means "not appended".
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  existsSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingStore } from '../signup/store.js';

const faults = vi.hoisted(() => ({ sync: false, synced: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const sync = fh.sync.bind(fh);
      fh.sync = async () => {
        faults.synced.push(String(args[0]));
        if (faults.sync) throw Object.assign(new Error('disk'), { code: 'EIO' });
        return sync();
      };
      return fh;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  faults.sync = false;
  faults.synced.length = 0;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const INPUT = {
  name: 'Dana',
  email: 'dana@example.com',
  role: 'Teacher',
  lang: 'he' as const,
  consent: true as const,
};
/** A line cut off by a full disk: no newline. */
const TORN = '2026-11-27T10:00:00.000Z 01ARZ3NDEKTSV4RRFFQ69G5FAV appro';

/** Dies (as far as the log can tell) once the removal is done: no `ok`, no `incomplete`. */
class DyingStore extends PendingStore {
  dead = false;
  override async audit(id: string, action: string, outcome: string, actor?: 'auto') {
    if (this.dead && outcome !== 'started') throw new Error('dead');
    return super.audit(id, action, outcome, actor);
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tbi-signup-audit-append-'));
  roots.push(root);
  const dir = join(root, 'p');
  const store = new DyingStore(dir, { now: () => Date.UTC(2026, 10, 28, 12) });
  await store.init();
  const { record } = await store.createIfNew(INPUT);
  const log = join(dir, 'audit.log');
  const text = () => readFileSync(log, 'utf8');
  return { root, dir, store, log, text, id: record.id, rec: join(dir, `${record.id}.json`) };
}

describe('audit append after a torn tail', () => {
  it('two faults: torn tail, then a death after removal; the retry is never not_found', async () => {
    const s = await setup();
    writeFileSync(s.log, TORN, { mode: 0o600 });
    s.store.dead = true;
    expect(await s.store.deleteNow(s.id)).toBe('incomplete');
    expect(existsSync(s.rec)).toBe(false);
    expect(s.text()).toBe(`${TORN}\n2026-11-28T12:00:00.000Z ${s.id} delete started\n`);
    s.store.dead = false;
    expect(await s.store.deleteNow(s.id)).toBe('deleted');
    expect(await s.store.deleteNow(s.id)).toBe('already_deleted');
  });

  it('an empty log and a complete tail get no blank line', async () => {
    const s = await setup();
    writeFileSync(s.log, '', { mode: 0o600 });
    await s.store.audit(s.id, 'approve', 'ok');
    await s.store.audit(s.id, 'resend', 'ok');
    expect(s.text().split('\n')).toHaveLength(3);
    expect(s.text()).not.toMatch(/^\n|\n\n/);
  });

  it('blank and torn lines in the history are skipped', async () => {
    const s = await setup();
    rmSync(s.rec);
    writeFileSync(s.log, `\n\n2026-11-28T11:00:00.000Z ${s.id} delete ok\n\n${TORN}`, {
      mode: 0o600,
    });
    expect(await s.store.deleteNow(s.id)).toBe('already_deleted');
  });

  it('a log that cannot be read (write only) still takes the line, on a line of its own', async () => {
    const s = await setup();
    writeFileSync(s.log, TORN, { mode: 0o600 });
    chmodSync(s.log, 0o200);
    await s.store.audit(s.id, 'delete', 'started');
    chmodSync(s.log, 0o600);
    expect(s.text()).toContain(`${TORN}\n`);
    expect(s.text()).toMatch(/ delete started\n$/);
  });
});

describe('audit append durability and safety', () => {
  it('creates the log 0600 and fsyncs it (and, when new, its directory)', async () => {
    const s = await setup();
    faults.synced.length = 0;
    await s.store.audit(s.id, 'approve', 'ok');
    expect(statSync(s.log).mode & 0o777).toBe(0o600);
    expect(faults.synced).toEqual([s.log, s.dir]);
    await s.store.audit(s.id, 'resend', 'ok');
    expect(faults.synced).toEqual([s.log, s.dir, s.log]);
  });

  it('a failed fsync of `started` removes nothing: incomplete', async () => {
    const s = await setup();
    faults.sync = true;
    expect(await s.store.deleteNow(s.id)).toBe('incomplete');
    expect(existsSync(s.rec)).toBe(true);
    faults.sync = false;
    expect(await s.store.deleteNow(s.id)).toBe('deleted');
  });

  it('a symlinked log is never followed: incomplete, nothing removed, target untouched', async () => {
    const s = await setup();
    const target = join(s.root, 'elsewhere');
    writeFileSync(target, 'keep', { mode: 0o600 });
    symlinkSync(target, s.log);
    await expect(s.store.audit(s.id, 'approve', 'ok')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await s.store.deleteNow(s.id)).toBe('incomplete');
    expect(existsSync(s.rec)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
});
