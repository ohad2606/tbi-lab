#!/usr/bin/env node
/**
 * Operator CLI for in-app problem reports (Sprint 14; docs/alpha/PROBLEM-REPORTS.md). Reads the
 * report directory directly: it needs neither the Session Host nor any messaging service. Run as
 * root (the files are 0600, owned by the Session Host's user), e.g.
 *
 *   sudo node scripts/problem-reports.mjs list
 *   sudo node scripts/problem-reports.mjs show 7K3M-9QX2-WDAB
 *   sudo node scripts/problem-reports.mjs delete 7K3M-9QX2-WDAB
 *   sudo node scripts/problem-reports.mjs delete-principal p_XXXXXXXXXXXXXXXXXXXXXXXXXX
 *   sudo node scripts/problem-reports.mjs purge-older 90
 *
 * Directory: --dir DIR, else $TBI_REPORTS_DIR, else /var/lib/tbi-runtime/state/reports.
 * No dependencies; plain Node.
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ID_RE = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const FILE_RE = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\.json$/;
const PRINCIPAL_RE = /^p_[A-Za-z0-9_-]{26}$/;
const DAY_MS = 24 * 3600_000;

function usage(code = 2) {
  process.stderr.write(
    'usage: problem-reports.mjs [--dir DIR] list | show <id> | delete <id> |\n' +
      '       delete-principal <principal> | purge-older <days>\n',
  );
  process.exit(code);
}

const args = process.argv.slice(2);
let dir = process.env.TBI_REPORTS_DIR || '/var/lib/tbi-runtime/state/reports';
const at = args.indexOf('--dir');
if (at >= 0) {
  dir = args[at + 1] ?? usage();
  args.splice(at, 2);
}
const [command, arg] = args;

/** Every stored report, oldest first; unreadable files are listed with what is known. */
function reports() {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    process.stderr.write(`cannot read ${dir}: ${e.code ?? e.message}\n`);
    process.exit(1);
  }
  const out = [];
  for (const name of names.filter((n) => FILE_RE.test(n))) {
    const path = join(dir, name);
    let r = null;
    try {
      r = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // listed as unreadable below
    }
    let received = Date.parse(r?.receivedAt);
    if (!Number.isFinite(received)) received = statSync(path).mtimeMs;
    out.push({ id: name.slice(0, -5), path, r, received });
  }
  return out.sort((a, b) => a.received - b.received);
}

function find(id) {
  if (!ID_RE.test(id ?? '')) {
    process.stderr.write('a report id looks like 7K3M-9QX2-WDAB\n');
    process.exit(2);
  }
  const path = join(dir, `${id}.json`);
  try {
    statSync(path);
  } catch {
    process.stderr.write(`no report ${id}\n`);
    process.exit(1);
  }
  return path;
}

switch (command) {
  case 'list': {
    const all = reports();
    for (const { id, r, received } of all) {
      const cols = r
        ? [
            id,
            new Date(received).toISOString(),
            r.category,
            r.blocking ? 'blocking' : '-',
            String(r.principal ?? '').slice(0, 10),
            r.release?.version ?? r.app?.version ?? '?',
            r.session ? `session:${r.session.state}` : '-',
            `${[...(r.description ?? '')].length} chars`,
          ]
        : [id, new Date(received).toISOString(), 'UNREADABLE'];
      process.stdout.write(`${cols.join('  ')}\n`);
    }
    process.stdout.write(`${all.length} report(s) in ${dir}\n`);
    break;
  }
  case 'show':
    // Still valid JSON, but bidirectional controls and line separators in a tester's text are
    // shown escaped, so they cannot reorder or hide what the operator's terminal displays.
    process.stdout.write(
      readFileSync(find(arg), 'utf8').replace(
        /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ),
    );
    break;
  case 'delete':
    unlinkSync(find(arg));
    process.stdout.write(`deleted ${arg}\n`);
    break;
  case 'delete-principal': {
    if (!PRINCIPAL_RE.test(arg ?? '')) usage();
    let n = 0;
    for (const { path, r } of reports())
      if (r?.principal === arg) {
        unlinkSync(path);
        n++;
      }
    process.stdout.write(`deleted ${n} report(s) of ${arg.slice(0, 10)}\n`);
    break;
  }
  case 'purge-older': {
    if (!/^\d{1,4}$/.test(arg ?? '')) usage();
    const cutoff = Date.now() - Number(arg) * DAY_MS;
    let n = 0;
    for (const { path, received } of reports())
      if (received < cutoff) {
        unlinkSync(path);
        n++;
      }
    process.stdout.write(`deleted ${n} report(s) older than ${arg} day(s)\n`);
    break;
  }
  default:
    usage(command === undefined || command === 'help' ? 0 : 2);
}
