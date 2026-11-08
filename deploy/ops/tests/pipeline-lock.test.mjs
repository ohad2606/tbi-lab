import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELD,
  acquire,
  alive,
  bootId,
  check,
  me,
  release,
  startTime,
  whose,
} from '../pipeline-lock.mjs';

const TOOL = new URL('../pipeline-lock.mjs', import.meta.url).pathname;

/** A fake /proc: pid -> { start, ppid, env }. */
function fakeProc(procs) {
  const root = mkdtempSync(join(tmpdir(), 'proc-'));
  for (const [pid, p] of Object.entries(procs)) {
    mkdirSync(join(root, pid));
    // comm with spaces and a parenthesis, as the kernel may report it
    const fields = ['S', String(p.ppid ?? 1), ...Array(17).fill('0'), String(p.start)];
    writeFileSync(join(root, pid, 'stat'), `${pid} (we ird) cmd) ${fields.join(' ')} 0 0\n`);
    writeFileSync(
      join(root, pid, 'environ'),
      Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\0'),
    );
  }
  return root;
}
function dirs() {
  const d = mkdtempSync(join(tmpdir(), 'lock-'));
  return { lease: join(d, 'l.json'), mutex: join(d, 'l.lock'), history: join(d, 'h.log') };
}
const A = { id: 'session-aaaa', pid: 100, start: '5000', host: 'h', kind: 'claude-code' };
const B = { id: 'session-bbbb', pid: 200, start: '6000', host: 'h', kind: 'claude-code' };

describe('pipeline lock', () => {
  it('reads the start time after the last parenthesis of comm', () => {
    const proc = fakeProc({ 100: { start: 5000 } });
    expect(startTime(100, proc)).toBe('5000');
    expect(startTime(999, proc)).toBeNull();
  });

  it('one owner at a time; a live holder refuses others; release frees it', () => {
    const p = dirs();
    const proc = fakeProc({ 100: { start: 5000 }, 200: { start: 6000 } });
    expect(acquire(p, A, 'S28 gates', proc).code).toBe(0);
    expect(check(p, A, proc).code).toBe(0);
    const r = acquire(p, B, 'other', proc);
    expect(r.code).toBe(HELD);
    expect(r.msg).toMatch(/held by claude-code session- \(pid 100\).*S28 gates/);
    expect(check(p, B, proc).code).toBe(HELD);
    expect(release(p, B).code).toBe(HELD); // only the holder releases
    expect(release(p, A).code).toBe(0);
    expect(check(p, A, proc).code).toBe(HELD); // free is not held: acquire first
    expect(acquire(p, B, 'other', proc).code).toBe(0);
  });

  it('a reused PID is not the holder: the lease is stale and taken over, with a record', () => {
    const p = dirs();
    acquire(p, A, 'old', fakeProc({ 100: { start: 5000 } }));
    const proc = fakeProc({ 100: { start: 7777 }, 200: { start: 6000 } }); // pid 100 reused
    expect(alive(A, proc)).toBe(false);
    expect(acquire(p, B, 'new', proc).code).toBe(0);
    expect(readFileSync(p.history, 'utf8')).toMatch(
      /TAKEOVER session- pid 200 took the stale lease of session- pid 100/,
    );
  });

  it('an unreadable lease fails closed', () => {
    const p = dirs();
    writeFileSync(p.lease, '{not json');
    const proc = fakeProc({ 200: { start: 6000 } });
    expect(acquire(p, B, 'x', proc).code).toBe(HELD);
    expect(check(p, B, proc).code).toBe(HELD);
  });

  it('refresh keeps the original acquisition time', () => {
    const p = dirs();
    const proc = fakeProc({ 100: { start: 5000 } });
    acquire(p, A, 'a', proc, new Date('2026-11-02T10:00:00Z'));
    acquire(p, A, 'b', proc, new Date('2026-11-02T11:00:00Z'));
    const l = JSON.parse(readFileSync(p.lease, 'utf8'));
    expect([l.acquired, l.refreshed, l.purpose]).toEqual([
      '2026-11-02T10:00:00.000Z',
      '2026-11-02T11:00:00.000Z',
      'b',
    ]);
  });

  it('whose: attributes a process to its Claude Code session through its ancestors', () => {
    const proc = fakeProc({
      100: {
        start: 1,
        ppid: 1,
        env: { CLAUDE_CODE_SESSION_ID: 'session-aaaa', CLAUDE_PID: '100' },
      },
      150: {
        start: 2,
        ppid: 100,
        env: { CLAUDE_CODE_SESSION_ID: 'session-aaaa', CLAUDE_PID: '100' },
      },
      160: { start: 3, ppid: 150 }, // e.g. a sudo child whose environ we cannot read
      300: { start: 4, ppid: 1, env: { PATH: '/bin' } },
    });
    expect(whose(160, proc, { id: 'session-aaaa', pid: 100 })).toEqual({
      owner: 'session-aaaa',
      claudePid: 100,
      holdsLease: true,
    });
    expect(whose(300, proc).owner).toBeNull();
    // a Claude Code process itself: identified by comm and pid; owner known only if it holds the lease
    const c = fakeProc({ 400: { start: 1, ppid: 1 } });
    writeFileSync(
      join(c, '400', 'stat'),
      '400 (claude) S 1 ' + Array(17).fill('0').join(' ') + ' 9 0\n',
    );
    expect(whose(400, c, { id: 'session-x', pid: 400 })).toEqual({
      owner: 'session-x',
      claudePid: 400,
      holdsLease: true,
    });
    expect(whose(400, c, { id: 'session-x', pid: 1 })).toEqual({
      owner: null,
      claudePid: 400,
      holdsLease: false,
    });
  });

  it('CLI: acquire, refuse a second owner (exit 75, holder named), status, release', () => {
    const d = mkdtempSync(join(tmpdir(), 'cli-'));
    const run = (args, owner) =>
      spawnSync(process.execPath, [TOOL, ...args], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: d,
          TBI_PIPELINE_LOCK_DIR: d,
          TBI_PIPELINE_HISTORY: join(d, 'h.log'),
          TBI_PIPELINE_OWNER: owner,
          TBI_PIPELINE_PID: String(process.pid),
        },
      });
    expect(run(['acquire', '--purpose', 'test'], 'owner-one').status).toBe(0);
    const r = run(['acquire', '--purpose', 'x'], 'owner-two');
    expect(r.status).toBe(75);
    expect(r.stderr).toMatch(/held by person owner-on/);
    expect(run(['check'], 'owner-two').status).toBe(75);
    expect(run(['check'], 'owner-one').status).toBe(0);
    expect(run(['status'], 'owner-two').status).toBe(75);
    expect(run(['release'], 'owner-one').status).toBe(0);
    expect(run(['status'], 'owner-two').status).toBe(0);
    expect(run(['acquire'], 'owner-two').status).toBe(64);
  });
});

describe('Sprint 28 recovery: one owner is one process', () => {
  /** fakeProc plus a boot id. */
  const withBoot = (procs, boot) => {
    const root = fakeProc(procs);
    mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), `${boot}\n`);
    return root;
  };
  const S = 'session-same';
  const first = { id: S, pid: 100, start: '5000', boot: 'boot-1', host: 'h', kind: 'claude-code' };
  const resumed = {
    id: S,
    pid: 200,
    start: '6000',
    boot: 'boot-1',
    host: 'h',
    kind: 'claude-code',
  };

  it('two live processes of one resumed session: the second is refused, cannot check, refresh or release', () => {
    const p = dirs();
    const proc = withBoot({ 100: { start: 5000 }, 200: { start: 6000 } }, 'boot-1');
    expect(acquire(p, first, 'S28', proc).code).toBe(0);
    const r = acquire(p, resumed, 'S28 resumed', proc);
    expect(r.code).toBe(HELD);
    expect(r.msg).toMatch(/pid 100.*another live process of the same session/);
    expect(check(p, resumed, proc).code).toBe(HELD);
    expect(release(p, resumed).code).toBe(HELD);
    expect(check(p, first, proc).code).toBe(0); // untouched
    expect(JSON.parse(readFileSync(p.lease, 'utf8')).pid).toBe(100);
  });

  it('the holder ended: the resumed process takes the stale lease over, with a record', () => {
    const p = dirs();
    acquire(p, first, 'S28', withBoot({ 100: { start: 5000 } }, 'boot-1'));
    const proc = withBoot({ 200: { start: 6000 } }, 'boot-1'); // pid 100 gone
    expect(acquire(p, resumed, 'S28 resumed', proc).code).toBe(0);
    expect(readFileSync(p.history, 'utf8')).toMatch(
      /TAKEOVER session- pid 200 took the stale lease of session- pid 100 \(process gone or PID reused\)/,
    );
  });

  it('after a reboot the old lease is stale even if the same PID and start time exist again', () => {
    const p = dirs();
    acquire(p, first, 'before reboot', withBoot({ 100: { start: 5000 } }, 'boot-1'));
    const proc = withBoot({ 100: { start: 5000 }, 300: { start: 7000 } }, 'boot-2');
    expect(alive(first, proc)).toBe(false);
    const next = {
      id: 'session-new',
      pid: 300,
      start: '7000',
      boot: 'boot-2',
      host: 'h',
      kind: 'claude-code',
    };
    expect(acquire(p, next, 'after reboot', proc).code).toBe(0);
    expect(readFileSync(p.history, 'utf8')).toMatch(/another boot/);
    expect(bootId(proc)).toBe('boot-2');
  });

  it('identity is proved by ancestry: a PID that is not this process or an ancestor is refused', () => {
    const proc = withBoot(
      {
        100: { start: 1, ppid: 1 },
        150: { start: 2, ppid: 100 },
        160: { start: 3, ppid: 150 },
        900: { start: 4, ppid: 1 },
      },
      'b',
    );
    expect(
      me({ TBI_PIPELINE_OWNER: 'person-x', TBI_PIPELINE_PID: '100' }, proc, 160),
    ).toMatchObject({ pid: 100, start: '1', boot: 'b' });
    expect(() =>
      me({ TBI_PIPELINE_OWNER: 'person-x', TBI_PIPELINE_PID: '900' }, proc, 160),
    ).toThrow(/not this process or an ancestor/);
    expect(() =>
      me({ CLAUDE_CODE_SESSION_ID: 'session-x', CLAUDE_PID: '4242' }, proc, 160),
    ).toThrow(/does not exist/);
  });

  it('CLI: concurrent acquisitions by six live processes: exactly one wins (atomic)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'race-'));
    const env = {
      PATH: process.env.PATH,
      HOME: d,
      TBI_PIPELINE_LOCK_DIR: d,
      TBI_PIPELINE_HISTORY: join(d, 'h.log'),
    };
    // Each contender is its own live bash process (the owner), which stays alive during the race.
    const runs = Array.from(
      { length: 6 },
      (_, i) =>
        new Promise((resolve) => {
          const c = spawn(
            'bash',
            [
              '-c',
              `TBI_PIPELINE_OWNER=race-${i} TBI_PIPELINE_PID=$$ "${process.execPath}" "${TOOL}" acquire --purpose r${i}; echo "rc=$?"; sleep 1`,
            ],
            { env },
          );
          let out = '';
          c.stdout.on('data', (b) => (out += b));
          c.on('close', () => resolve(/rc=(\d+)/.exec(out)?.[1]));
        }),
    );
    const codes = await Promise.all(runs);
    expect(codes.filter((c) => c === '0')).toHaveLength(1);
    expect(codes.filter((c) => c === '75')).toHaveLength(5);
  });

  it('CLI: the same owner id from two live processes: the second is refused (exit 75)', () => {
    const d = mkdtempSync(join(tmpdir(), 'dup-'));
    const env = {
      PATH: process.env.PATH,
      HOME: d,
      TBI_PIPELINE_LOCK_DIR: d,
      TBI_PIPELINE_HISTORY: join(d, 'h.log'),
      TBI_PIPELINE_OWNER: 'session-dup',
    };
    const holder = spawnSync(
      'bash',
      ['-c', `TBI_PIPELINE_PID=$PPID "${process.execPath}" "${TOOL}" acquire --purpose one`],
      { env: { ...env }, encoding: 'utf8' },
    );
    expect(holder.status).toBe(0); // the test process (bash's parent) holds it
    const other = spawnSync(
      'bash',
      ['-c', `TBI_PIPELINE_PID=$$ "${process.execPath}" "${TOOL}" acquire --purpose two`],
      { env, encoding: 'utf8' },
    );
    expect(other.status).toBe(75);
    expect(other.stderr).toMatch(/another live process of the same session/);
    const rel = spawnSync(
      'bash',
      ['-c', `TBI_PIPELINE_PID=$$ "${process.execPath}" "${TOOL}" release`],
      { env, encoding: 'utf8' },
    );
    expect(rel.status).toBe(75); // and cannot release it
  });
});
