#!/usr/bin/env node
/**
 * Host-wide exclusive pipeline lock (Sprint 28). One owner at a time may run heavy tests, staging
 * installs and browser batches, DEV-Lab deploys and rollbacks on this host.
 *
 *   pipeline-lock.mjs acquire --purpose <text>   take the lease (or refresh one we hold)
 *   pipeline-lock.mjs check                      exit 0 only if we hold the lease (kit scripts)
 *   pipeline-lock.mjs release                    give up our lease
 *   pipeline-lock.mjs status                     who holds it (exit 0 free, 75 held)
 *   pipeline-lock.mjs whose <pid>                which owner a process belongs to (before any kill)
 *
 * The owner is a Claude Code session (CLAUDE_CODE_SESSION_ID + CLAUDE_PID) or, for a person at a
 * shell, TBI_PIPELINE_OWNER + TBI_PIPELINE_PID (default: the login shell's parent). The lease
 * records the owner's PID together with its kernel start time, so a reused PID never looks alive.
 * A lease whose holder no longer exists is stale: acquire takes it over and records that it did.
 * Nothing here ever signals or stops a process.
 *
 * Exit codes: 0 ok; 75 held by another live owner (EX_TEMPFAIL); 64 usage; 70 internal error.
 * Files (TBI_PIPELINE_LOCK_DIR, default /run/lock): tbi-pipeline.json (the lease),
 * tbi-pipeline.lock (flock for atomic updates); history appended to TBI_PIPELINE_HISTORY
 * (default ~/tbi-pipeline/history.log). No secrets are written: owner ids are session ids.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HELD = 75;

export function paths(env = process.env) {
  const dir = env.TBI_PIPELINE_LOCK_DIR || '/run/lock';
  return {
    lease: join(dir, 'tbi-pipeline.json'),
    mutex: join(dir, 'tbi-pipeline.lock'),
    history: env.TBI_PIPELINE_HISTORY || join(homedir(), 'tbi-pipeline', 'history.log'),
  };
}

/** Kernel start time of a process (clock ticks since boot), or null if it does not exist. */
export function startTime(pid, procRoot = '/proc') {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    // Field 2 (comm) may contain spaces and parentheses: fields after the last ')' are fixed.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? null; // field 22 overall
  } catch {
    return null;
  }
}

export function alive(holder, procRoot = '/proc') {
  return !!holder && startTime(holder.pid, procRoot) === holder.start;
}

/** This caller's owner identity. */
export function me(env = process.env, procRoot = '/proc') {
  const id = env.TBI_PIPELINE_OWNER || env.CLAUDE_CODE_SESSION_ID;
  const pid = Number(env.TBI_PIPELINE_PID || env.CLAUDE_PID || process.ppid);
  if (!id)
    throw new UsageError('no owner: set TBI_PIPELINE_OWNER (or run inside a Claude Code session)');
  if (!/^[A-Za-z0-9._:-]{4,80}$/.test(id))
    throw new UsageError('owner id must be 4-80 chars [A-Za-z0-9._:-]');
  const start = startTime(pid, procRoot);
  if (!start) throw new UsageError(`owner process ${pid} does not exist`);
  return {
    id,
    pid,
    start,
    host: hostname(),
    kind: env.TBI_PIPELINE_OWNER ? 'person' : 'claude-code',
  };
}

class UsageError extends Error {}

function readLease(p) {
  if (!existsSync(p.lease)) return null;
  try {
    return JSON.parse(readFileSync(p.lease, 'utf8'));
  } catch {
    // A lease we cannot read is treated as held by an unknown owner: fail closed.
    return { id: 'unreadable', pid: -1, start: 'unknown', unreadable: true };
  }
}

function writeLease(p, lease) {
  const tmp = `${p.lease}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, p.lease);
}

function history(p, line) {
  try {
    mkdirSync(dirname(p.history), { recursive: true });
    appendFileSync(p.history, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* history is evidence, not a precondition */
  }
}

export const short = (id) => String(id).slice(0, 8);

export function describe(l, procRoot = '/proc') {
  if (!l) return 'free';
  if (l.unreadable) return 'held by an unreadable lease (fail closed; inspect it by hand)';
  return `held by ${l.kind ?? 'owner'} ${short(l.id)} (pid ${l.pid}${alive(l, procRoot) ? '' : ', GONE'}) on ${l.host} since ${l.acquired}: ${l.purpose}`;
}

/** Run fn with the mutex held (flock(1) on the mutex file; serialises acquire/release). */
function locked(p, args) {
  const r = spawnSync('flock', ['-w', '10', p.mutex, process.execPath, process.argv[1], ...args], {
    stdio: 'inherit',
    env: { ...process.env, TBI_PIPELINE_INNER: '1' },
  });
  return r.status ?? 70;
}

export function acquire(p, who, purpose, procRoot = '/proc', now = new Date()) {
  const cur = readLease(p);
  if (cur && cur.id !== who.id) {
    if (cur.unreadable || alive(cur, procRoot))
      return { code: HELD, msg: `refused: pipeline ${describe(cur, procRoot)}` };
    history(
      p,
      `TAKEOVER ${short(who.id)} took the stale lease of ${short(cur.id)} (pid ${cur.pid} gone)`,
    );
  }
  const lease = {
    ...who,
    purpose,
    acquired: cur?.id === who.id ? cur.acquired : now.toISOString(),
    refreshed: now.toISOString(),
  };
  writeLease(p, lease);
  history(
    p,
    `${cur?.id === who.id ? 'REFRESH' : 'ACQUIRE'} ${short(who.id)} pid ${who.pid}: ${purpose}`,
  );
  return { code: 0, msg: `pipeline lock held by ${short(who.id)}: ${purpose}` };
}

export function check(p, who, procRoot = '/proc') {
  const cur = readLease(p);
  if (cur && !cur.unreadable && cur.id === who.id)
    return { code: 0, msg: `ok: ${short(who.id)} holds the pipeline lock` };
  if (!cur)
    return {
      code: HELD,
      msg: 'refused: the pipeline lock is free; acquire it first (pipeline-lock.mjs acquire --purpose ...)',
    };
  return { code: HELD, msg: `refused: pipeline ${describe(cur, procRoot)}` };
}

export function release(p, who) {
  const cur = readLease(p);
  if (!cur) return { code: 0, msg: 'already free' };
  if (cur.id !== who.id)
    return { code: HELD, msg: `refused: not the holder (${short(cur.id)} holds it)` };
  unlinkSync(p.lease);
  history(p, `RELEASE ${short(who.id)}`);
  return { code: 0, msg: 'released' };
}

/** The owner a process belongs to: the nearest ancestor that is a Claude Code session or the lease holder. */
export function whose(pid, procRoot = '/proc', lease = null) {
  let cur = Number(pid);
  for (let i = 0; i < 64 && cur > 1; i++) {
    let env = '';
    try {
      env = readFileSync(join(procRoot, String(cur), 'environ'), 'utf8');
    } catch {
      /* not ours to read, or gone */
    }
    const sid = /(?:^|\0)CLAUDE_CODE_SESSION_ID=([^\0]+)/.exec(env)?.[1];
    const cpid = /(?:^|\0)CLAUDE_PID=(\d+)/.exec(env)?.[1];
    if (sid) return { owner: sid, claudePid: Number(cpid), holdsLease: lease?.id === sid };
    let stat;
    try {
      stat = readFileSync(join(procRoot, String(cur), 'stat'), 'utf8');
    } catch {
      return { owner: null };
    }
    // A Claude Code process carries its session id only in its children's environment.
    if (stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) === 'claude')
      return {
        owner: lease?.pid === cur ? lease.id : null,
        claudePid: cur,
        holdsLease: lease?.pid === cur,
      };
    cur = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return { owner: null };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const p = paths();
  const arg = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (cmd === 'status') {
      const l = readLease(p);
      console.log(`pipeline ${describe(l)}`);
      return l && (l.unreadable || alive(l)) ? HELD : 0;
    }
    if (cmd === 'whose') {
      const w = whose(rest[0], '/proc', readLease(p));
      const self = w.claudePid !== undefined && String(w.claudePid) === process.env.CLAUDE_PID;
      console.log(JSON.stringify({ ...w, owner: w.owner && short(w.owner), self }));
      return 0;
    }
    if (['acquire', 'check', 'release'].includes(cmd)) {
      if (cmd !== 'check' && !process.env.TBI_PIPELINE_INNER) return locked(p, argv);
      const who = me();
      let r;
      if (cmd === 'acquire') {
        const purpose = arg('--purpose');
        if (!purpose) throw new UsageError('acquire needs --purpose <text>');
        r = acquire(p, who, purpose.slice(0, 200));
      } else if (cmd === 'check') r = check(p, who);
      else r = release(p, who);
      (r.code ? console.error : console.log)(`pipeline-lock: ${r.msg}`);
      return r.code;
    }
    throw new UsageError(
      'usage: pipeline-lock.mjs acquire --purpose <text> | check | release | status | whose <pid>',
    );
  } catch (e) {
    console.error(`pipeline-lock: ${e.message}`);
    return e instanceof UsageError ? 64 : 70;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
