import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELD, acquire, alive, check, release, startTime, whose } from '../pipeline-lock.mjs';

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
      /TAKEOVER session- took the stale lease of session-/,
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
    expect(whose(160, proc, { id: 'session-aaaa' })).toEqual({
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
