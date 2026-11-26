/** K12: scripts/funnel-report.mjs, the read-only funnel report, and its parser pinned to the store's. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as store from '../../runtime/admin/funnel/counters.ts';
import * as cli from '../funnel-report.mjs';

const script = new URL('../funnel-report.mjs', import.meta.url).pathname;
const roots = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'tbi-funnel-report-'));
  roots.push(d);
  return d;
};
/** A directory holding `content` as the counters file (no file when undefined). */
function dir(content, base = root(), name = 'd') {
  const d = join(base, name);
  mkdirSync(d, { mode: 0o700 });
  if (content !== undefined) writeFileSync(join(d, cli.FUNNEL_FILE), content, { mode: 0o600 });
  return d;
}
const file = (days) => `${JSON.stringify({ v: 1, days })}\n`;
const run = (...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const HEAD =
  'day,dir,landing_view,signup_form_view,signup_submitted,signup_approved,first_session,unknown';

describe('pinned to runtime/admin/funnel/counters.ts', () => {
  it('same events, file name and cap', () => {
    expect(cli.FUNNEL_EVENTS).toEqual([...store.FUNNEL_EVENTS]);
    expect(cli.FUNNEL_FILE).toBe(store.FUNNEL_FILE);
    expect(cli.FUNNEL_DAY_CAP).toBe(store.FUNNEL_DAY_CAP);
  });

  it('accepts and refuses the same texts, with the same counts', () => {
    const day = (counts, d = '2026-11-26') => file({ [d]: counts });
    const corpus = [
      '',
      'x',
      'null',
      '[]',
      '1',
      '{}',
      '{"v":1}',
      '{"v":1,"days":{}}',
      '{"v":"1","days":{}}',
      '{"v":2,"days":{}}',
      '{"v":1,"days":[]}',
      '{"v":1,"days":null}',
      '{"v":1,"days":{},"ip":"x"}',
      day({}),
      day({ landing_view: 0, signup_form_view: 10_000 }),
      day(Object.fromEntries(store.FUNNEL_EVENTS.map((e, i) => [e, i + 1]))),
      day({ landing_view: 10_001 }),
      day({ landing_view: -1 }),
      day({ landing_view: 1.5 }),
      day({ landing_view: '1' }),
      day({ landing_view: null }),
      day([]),
      day(null),
      day({}, 'yesterday'),
      day({}, '2026-13-45'),
      day({}, '2026-02-30'),
      day({}, '=2026-11-26'),
      day({}, '2026-11-26\n'),
    ];
    for (const text of corpus) {
      const a = store.parseFunnelFile(text);
      const b = cli.parseReportFile(text);
      expect(b === null, text).toBe(a === null);
      if (!a) continue;
      expect([...b.keys()]).toEqual(Object.keys(a));
      for (const [d, row] of b)
        expect(row).toEqual([...store.FUNNEL_EVENTS.map((e) => a[d][e] ?? 0), 0]);
    }
  });

  it('differs only for unknown event names: summed, still bounded integers', () => {
    const text = file({ '2026-11-26': { new_event: 2, '=cmd': 3, landing_view: 1 } });
    expect(store.parseFunnelFile(text)).toBeNull();
    expect(cli.parseReportFile(text).get('2026-11-26')).toEqual([1, 0, 0, 0, 0, 5]);
    for (const n of [-1, 1.5, '1', 10_001])
      expect(cli.parseReportFile(file({ '2026-11-26': { new_event: n } }))).toBeNull();
  });
});

describe('report', () => {
  it('per-dir rows and per-day totals, sorted days, CSV', () => {
    const base = root();
    const a = dir(
      file({
        '2026-11-26': { signup_form_view: 7, signup_submitted: 2 },
        '2026-11-25': { signup_submitted: 1 },
      }),
      base,
      'a',
    );
    const b = dir(file({ '2026-11-26': { signup_approved: 1, '=HYPERLINK(1)': 4 } }), base, 'b');
    const r = run('--dir', a, '--dir', b, '--csv');
    expect(r).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        HEAD,
        '2026-11-25,1,0,0,1,0,0,0',
        '2026-11-25,total,0,0,1,0,0,0',
        '2026-11-26,1,0,7,2,0,0,0',
        '2026-11-26,2,0,0,0,1,0,4',
        '2026-11-26,total,0,7,2,1,0,4',
        '',
      ].join('\n'),
    });
    for (const f of r.stdout.split(/[,\n]/)) expect(f).not.toMatch(/^[=+\-@]/);
    const t = run('--dir', a, '--dir', b);
    expect(t.code).toBe(0);
    expect(
      t.stdout
        .trimEnd()
        .split('\n')
        .map((l) => l.trim().split(/ +/).join(',')),
    ).toEqual(r.stdout.trimEnd().split('\n'));
    expect(t.stdout).not.toContain(base);
    expect(t.stdout).not.toContain('HYPERLINK');
  });

  it('a missing counters file is empty, with a warning on stderr only', () => {
    expect(run('--dir', dir(), '--csv')).toEqual({
      code: 0,
      stdout: `${HEAD}\n`,
      stderr: 'funnel-report: warning: dir 1: no counters file, counted as empty\n',
    });
  });

  it('bad input: exit 1, nothing on stdout, one fixed reason per bad dir, no contents or paths', () => {
    const base = root();
    const good = dir(file({}), base, 'good');
    const corrupt = dir('{"secret-content', base, 'corrupt');
    const big = dir(`${file({})}${' '.repeat(cli.MAX_FILE_BYTES)}`, base, 'big');
    const linked = dir(undefined, base, 'linked');
    symlinkSync(join(good, cli.FUNNEL_FILE), join(linked, cli.FUNNEL_FILE));
    const isDir = dir(undefined, base, 'isdir');
    mkdirSync(join(isDir, cli.FUNNEL_FILE));
    const fifo = dir(undefined, base, 'fifo');
    expect(spawnSync('mkfifo', [join(fifo, cli.FUNNEL_FILE)]).status).toBe(0);
    const link = join(base, 'link');
    symlinkSync(good, link);
    const plain = join(good, cli.FUNNEL_FILE);
    const cases = [
      [corrupt, 'file_invalid'],
      [big, 'file_too_large'],
      [linked, 'file_symlink'],
      [isDir, 'file_not_regular'],
      [fifo, 'file_not_regular'],
      [link, 'dir_symlink'],
      [`${link}/`, 'dir_symlink'],
      [`${link}/.`, 'dir_symlink'],
      [join(base, 'absent'), 'dir_unreadable'],
      [plain, 'dir_not_directory'],
    ];
    for (const [d, why] of cases)
      expect(run('--dir', d)).toEqual({
        code: 1,
        stdout: '',
        stderr: `funnel-report: dir 1: ${why}\n`,
      });
    expect(run('--dir', good, '--dir', corrupt, '--dir', big)).toEqual({
      code: 1,
      stdout: '',
      stderr: 'funnel-report: dir 2: file_invalid\nfunnel-report: dir 3: file_too_large\n',
    });
  });

  it.skipIf(process.getuid?.() === 0)('an unreadable file: fixed reason', () => {
    const d = dir(file({}));
    chmodSync(join(d, cli.FUNNEL_FILE), 0o000);
    expect(run('--dir', d).stderr).toBe('funnel-report: dir 1: file_unreadable\n');
  });

  it('usage errors: exit 2, nothing on stdout, the argument is not echoed', () => {
    const base = root();
    const d = dir(file({}), base);
    mkdirSync(join(base, 'real'));
    symlinkSync(base, join(base, 'real', 'parent'));
    for (const args of [
      [],
      ['--csv'],
      ['--dir'],
      ['--dir', 'relative/dir'],
      ['--dir', ''],
      ['--dir', `${d}/../d`],
      ['--dir', d, '--dir', d],
      ['--dir', d, '--dir', `${d}/`],
      ['--dir', d, '--dir', join(base, 'real', 'parent', 'd')],
      ['--dir', d, '--csv', '--csv'],
      ['--dir', d, '--secret-flag'],
      ['--dir', d, 'extra'],
      [`--dir=${d}`],
    ]) {
      const r = run(...args);
      expect([r.code, r.stdout], args.join(' ')).toEqual([2, '']);
      expect(r.stderr).toMatch(/^usage: /);
      expect(r.stderr).not.toContain('secret-flag');
    }
  });

  it('is strictly read-only: read-only tree, lock file and corrupt file left exactly as they were', () => {
    const base = root();
    const good = dir(file({ '2020-01-01': { landing_view: 1 } }), base, 'good');
    const bad = dir('junk', base, 'bad');
    writeFileSync(join(good, store.FUNNEL_LOCK), '', { mode: 0o600 });
    const state = () =>
      [good, bad].map((d) =>
        [d, ...readdirSync(d).map((f) => join(d, f))].map((p) => {
          const s = statSync(p);
          return [p, s.ino, s.mode, s.mtimeMs, s.ctimeMs, s.isFile() && readFileSync(p, 'utf8')];
        }),
      );
    const before = state();
    expect(run('--dir', good).code).toBe(0); // an old day is shown, not pruned
    expect(run('--dir', bad).code).toBe(1);
    expect(state()).toEqual(before);
    // The source imports no way to write.
    const source = readFileSync(script, 'utf8');
    const fsImports = /import \{([^}]*)\} from 'node:fs';/.exec(source)[1];
    expect(
      fsImports
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort(),
    ).toEqual([
      'closeSync',
      'constants',
      'fstatSync',
      'lstatSync',
      'openSync',
      'readSync',
      'realpathSync',
    ]);
    expect(source).not.toMatch(/O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/);
  });

  it('text mode handles about 66k days (more lines than a call takes arguments)', () => {
    const base = root();
    const dirs = [0, 1].map((n) => {
      const days = {};
      for (let i = 0; i < 33_000; i++)
        days[
          new Date(Date.UTC(1900, 0, 1) + (n * 33_000 + i) * 86_400_000).toISOString().slice(0, 10)
        ] = {};
      return dir(file(days), base, `d${n}`);
    });
    const r = cli.report(['--dir', dirs[0], '--dir', dirs[1]]);
    expect([r.code, r.stderr]).toEqual([0, '']);
    const lines = r.stdout.split('\n');
    expect(lines).toHaveLength(1 + 66_000 * 2 + 1);
    expect(new Set(lines.slice(0, -1).map((l) => l.length)).size).toBe(1);
  });

  it('runs through a symlink to the script', () => {
    const base = root();
    const alias = join(base, 'report');
    symlinkSync(script, alias);
    const r = spawnSync(process.execPath, [alias, '--dir', dir(file({}), base), '--csv']);
    expect([r.status, String(r.stdout)]).toEqual([0, `${HEAD}\n`]);
  });
});
