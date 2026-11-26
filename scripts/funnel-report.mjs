#!/usr/bin/env node
/**
 * K12: read-only operator report of the funnel counters (docs/alpha/SIGNUP-DATA-DELETION.md
 * section 3). The numbers are indicative only.
 *
 *   sudo node scripts/funnel-report.mjs --dir /path/to/funnel-dir [--dir ...] [--csv]
 *
 * STRICTLY READ-ONLY: it never writes, creates, renames, repairs or prunes anything and never
 * touches the writers' lock file (they replace the file atomically, so a read sees a whole file).
 * No dependencies; plain Node (it may run where the TypeScript sources cannot be imported).
 *
 * `FUNNEL_*` and `parseReportFile` COPY runtime/admin/funnel/counters.ts (`parseFunnelFile`);
 * scripts/tests/funnel-report.test.mjs pins them together. The one difference: an event name this
 * copy does not know (a newer writer) is not refused; its count is summed into the `unknown`
 * column and the name is never printed.
 *
 * Output (stdout, only on success): days, fixed event names, integers and the dir index (the
 * position of --dir, from 1). Exit status 0: report; 1: invalid or unreadable input; 2: usage.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FUNNEL_EVENTS = [
  'landing_view',
  'signup_form_view',
  'signup_submitted',
  'signup_approved',
  'first_session',
];
export const FUNNEL_FILE = 'funnel-counters.json';
export const FUNNEL_DAY_CAP = 10_000;
/** A larger file is not ours (400 days of five events stay far below this). */
export const MAX_FILE_BYTES = 1024 * 1024;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLUMNS = ['day', 'dir', ...FUNNEL_EVENTS, 'unknown'];
const USAGE =
  'usage: funnel-report.mjs --dir /absolute/dir [--dir /absolute/dir ...] [--csv]\n' +
  '       each --dir once, without ".." segments\n';

/** A fixed reason code; the only thing ever said about a bad input. */
class InputError extends Error {}

/** Map day -> counts in column order (the last one: unknown events); null when not our format. */
export function parseReportFile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!obj(raw) || raw.v !== 1 || !obj(raw.days) || Object.keys(raw).length !== 2) return null;
  const days = new Map();
  for (const [day, counts] of Object.entries(raw.days)) {
    if (!DAY_RE.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || !obj(counts))
      return null;
    const row = new Array(FUNNEL_EVENTS.length + 1).fill(0);
    for (const [ev, n] of Object.entries(counts)) {
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > FUNNEL_DAY_CAP)
        return null;
      const i = FUNNEL_EVENTS.indexOf(ev);
      row[i < 0 ? FUNNEL_EVENTS.length : i] += n;
    }
    days.set(day, row);
  }
  return days;
}

/** The directory itself must be a real directory, not a symlink. Returns its identity. */
function checkDir(dir) {
  let s;
  try {
    s = lstatSync(dir);
  } catch {
    throw new InputError('dir_unreadable');
  }
  if (s.isSymbolicLink()) throw new InputError('dir_symlink');
  if (!s.isDirectory()) throw new InputError('dir_not_directory');
  return `${s.dev}:${s.ino}`;
}

/** The file's text, or null when there is none. Opens read-only, no symlink, regular, bounded. */
function readCounters(dir) {
  let fd;
  try {
    // O_NONBLOCK: opening a FIFO must not hang; it is then refused as not regular.
    fd = openSync(
      join(dir, FUNNEL_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new InputError(e.code === 'ELOOP' ? 'file_symlink' : 'file_unreadable');
  }
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) throw new InputError('file_not_regular');
    if (s.size > MAX_FILE_BYTES) throw new InputError('file_too_large');
    // One byte more than allowed, so a file that grew after the check is refused too.
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let len = 0;
    let got;
    do {
      got = readSync(fd, buf, len, buf.length - len, null);
      len += got;
    } while (got > 0 && len < buf.length);
    if (len > MAX_FILE_BYTES) throw new InputError('file_too_large');
    return buf.toString('utf8', 0, len);
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError('file_unreadable');
  } finally {
    closeSync(fd);
  }
}

/** The arguments, or null on any usage error. */
function parseArgs(argv) {
  const dirs = [];
  let csv = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--csv' && !csv) csv = true;
    else if (argv[i] === '--dir') {
      const v = argv[++i];
      if (!v?.startsWith('/') || v.split('/').includes('..')) return null;
      const dir = resolve(v); // drops a trailing slash, which would make lstat follow a symlink
      if (dirs.includes(dir)) return null;
      dirs.push(dir);
    } else return null;
  }
  return dirs.length > 0 ? { dirs, csv } : null;
}

/** Rows: per day, one per dir that has the day, then the day's total over all dirs. */
function rows(reports) {
  const out = [];
  const all = [...new Set(reports.flatMap((r) => [...r.keys()]))].sort();
  for (const day of all) {
    const total = new Array(FUNNEL_EVENTS.length + 1).fill(0);
    reports.forEach((r, i) => {
      const row = r.get(day);
      if (!row) return;
      row.forEach((n, c) => (total[c] += n));
      out.push([day, i + 1, ...row]);
    });
    out.push([day, 'total', ...total]);
  }
  return out;
}

function format(table, csv) {
  const lines = [COLUMNS, ...table].map((r) => r.map(String));
  if (csv) return lines.map((r) => `${r.join(',')}\n`).join('');
  const width = COLUMNS.map((_, c) => Math.max(...lines.map((r) => r[c].length)));
  return lines
    .map(
      (r) => `${r.map((v, c) => (c < 2 ? v.padEnd(width[c]) : v.padStart(width[c]))).join('  ')}\n`,
    )
    .join('');
}

/** Pure of process state: what to print and the exit status. */
export function report(argv) {
  const args = parseArgs(argv);
  if (!args) return { code: 2, stdout: '', stderr: USAGE };
  const reports = [];
  const seen = new Set();
  let stderr = '';
  let bad = false;
  for (const [i, dir] of args.dirs.entries()) {
    try {
      const id = checkDir(dir);
      // The same directory under another path would be counted twice.
      if (seen.has(id)) return { code: 2, stdout: '', stderr: USAGE };
      seen.add(id);
      const text = readCounters(dir);
      if (text === null) {
        stderr += `funnel-report: warning: dir ${i + 1}: no counters file, counted as empty\n`;
        reports.push(new Map());
        continue;
      }
      const days = parseReportFile(text);
      if (!days) throw new InputError('file_invalid');
      reports.push(days);
    } catch (e) {
      bad = true;
      stderr += `funnel-report: dir ${i + 1}: ${e instanceof InputError ? e.message : 'error'}\n`;
    }
  }
  // No partial report: totals without one directory would be wrong.
  if (bad) return { code: 1, stdout: '', stderr };
  return { code: 0, stdout: format(rows(reports), args.csv), stderr };
}

/** True when run as a program (also through a symlink), false when imported. */
function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.stdout.on('error', () => process.exit(1)); // e.g. a closed pipe: no stack trace
  const r = report(process.argv.slice(2));
  process.stderr.write(r.stderr);
  process.stdout.write(r.stdout);
  process.exitCode = r.code;
}
