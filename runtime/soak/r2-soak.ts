/**
 * Runtime R2 soak: a long-running endurance gate for the Session Host on the REAL provisioned
 * runtime. Heavy-only: never part of routine CI.
 *
 *   TBI_RUNTIME_HOME=<provisioned home> R2_SOAK_MINUTES=480 npm run test:r2:soak
 *
 * The run rotates through six phases until the time budget is spent. A phase that is running
 * when the budget runs out is allowed to finish.
 *   A lifecycle churn         B concurrent isolation     C long deterministic sessions
 *   D mirror/transient stress E SSE reconnect / bounded log
 *   F failure injection and host-process recovery
 *
 * Every random choice comes from a PRNG seeded per (seed, round, phase). The seed is recorded,
 * and `R2_SOAK_REPLAY=<phase>:<round>` replays exactly one phase instance with the same choices.
 * Wall-clock timing still decides when commands are submitted relative to simulation time, so
 * D and E are replayed in kind, not to the nanosecond; A, B, C and F are fully determined.
 *
 * Environment:
 *   R2_SOAK_MINUTES        time budget (default 480)
 *   R2_SOAK_SEED           32-bit seed (default 20260925)
 *   R2_SOAK_REPLAY         <A..F>:<round>: run only that phase instance
 *   R2_SOAK_EVIDENCE_DIR   where the final evidence JSON goes
 *                          (default docs/runtime/r2-evidence/runtime-<id>/)
 *   R2_SOAK_SELFTEST_FAIL  <A..F>: force a critical failure after that phase in round 1. Used
 *                          only to prove the failure path; the evidence labels it as a self-test.
 *
 * Outputs:
 *   $TBI_RUNTIME_HOME/results/r2-soak-status.txt    human-readable, rewritten atomically
 *   $TBI_RUNTIME_HOME/results/r2-soak-progress.json machine-readable, rewritten after every phase
 *   <evidence dir>/r2-soak-<start>.json             final evidence (pass, fail or abort)
 *
 * Hard failures stop the soak, preserve the evidence and exit 1:
 *   - an orphan QEMU;
 *   - a leaked private directory;
 *   - an artifact mutation;
 *   - cross-session contamination;
 *   - a command-order or revision invariant violation;
 *   - silent SSE history loss;
 *   - an event-ordering or determinism divergence;
 *   - a resource limit not enforced.
 * Other failures are recorded and the soak continues, as long as the cleanup checkpoint after
 * them passes; any recorded failure makes the verdict FAIL. SIGINT, SIGTERM and SIGHUP stop every
 * host, QEMU and child process the soak started, remove its temporary root and write the
 * evidence.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from '@tbi-lab/domain';
import { runClosedLoop } from '../harness/closedLoop.js';
import { QEMU, RUNTIME_HOME, artifact, runtimeInfo } from '../harness/env.js';
import type { SessionHost } from '../host/host.js';
import { createHttpServer } from '../host/http.js';
import type { MirrorRevisions, SessionCommand, SessionEvent } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { isTerminal } from '../host/stateMachine.js';
import {
  gateMirrors,
  gateProject,
  gateRequest,
  loadRequest,
  realHost,
  runtimeEvents,
} from '../tests/r2-support.js';

// ---------------------------------------------------------------------------------------------
// Configuration

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BUNDLE = join(REPO, 'runtime/host/dist/session-host.mjs');
const MINUTES = Number(process.env.R2_SOAK_MINUTES ?? 480);
const SEED = Number(process.env.R2_SOAK_SEED ?? 20260925) >>> 0;
const REPLAY = process.env.R2_SOAK_REPLAY ?? null;
const SELFTEST_FAIL = process.env.R2_SOAK_SELFTEST_FAIL ?? null;
const PHASES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
type Phase = (typeof PHASES)[number];
const PHASE_NAMES: Record<Phase, string> = {
  A: 'lifecycle churn',
  B: 'concurrent isolation',
  C: 'long deterministic sessions',
  D: 'mirror/transient command stress',
  E: 'SSE reconnect / bounded log',
  F: 'failure injection / host recovery',
};

/** Anchors from the committed heavy suite (R2-REPORT §16, pass 4): cross-run determinism. */
const ANCHOR_GATE = '72935ade7dce072d'; // gate stream to 15.5 s, 4 scheduled mirrors
const ANCHOR_TIMING_4S = '6c9dddce6df617fc'; // TbiTiming stream to 4 s, no commands
const GATE_END = 15_500_000_000n;
const TIMING_END = 30_000_000_000n; // long TbiTiming (7.5x the suite's 4 s)
const LONG_GATE_END = 120_000_000_000n; // long gate (7.7x the suite's 15.5 s)
const D_END = 40_000_000_000n;
const ARTIFACTS = ['TbiNvs', 'TbiGpioProof', 'TbiRestart', 'TbiTiming'] as const;

// ---------------------------------------------------------------------------------------------
// Failures

type CriticalKind =
  | 'orphan_qemu'
  | 'leaked_directory'
  | 'artifact_mutation'
  | 'contamination'
  | 'revision_invariant'
  | 'command_order'
  | 'sse_history_loss'
  | 'event_order'
  | 'determinism'
  | 'equivalence'
  | 'limit_not_enforced'
  | 'selftest'
  | 'harness';

class Critical extends Error {
  constructor(
    readonly kind: CriticalKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`${kind}: ${message}`);
  }
}
class PhaseError extends Error {}

function crit(cond: unknown, kind: CriticalKind, message: string, detail?: unknown): void {
  if (!cond) throw new Critical(kind, message, detail);
}
function check(cond: unknown, message: string): void {
  if (!cond) throw new PhaseError(message);
}

// ---------------------------------------------------------------------------------------------
// Deterministic randomness

function hash32(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32LE(0);
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof mulberry32>;
const phaseSeed = (round: number, phase: Phase) => hash32(`${SEED}:${round}:${phase}`);

// ---------------------------------------------------------------------------------------------
// Process, file and wait utilities

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const hash16 = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const now = () => new Date().toISOString();

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function procStatus(pid: number): { rss: number; hwm: number } | null {
  try {
    const t = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(t)?.[1] ?? 0);
    return { rss: kb('VmRSS') * 1024, hwm: kb('VmHWM') * 1024 };
  } catch {
    return null;
  }
}

/** Every qemu-system-xtensa process on the machine (the soak host runs no other QEMU). */
function qemuProcesses(): { pid: number; cmd: string }[] {
  const out: { pid: number; cmd: string }[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (argv[0]?.endsWith('qemu-system-xtensa'))
        out.push({ pid: Number(name), cmd: argv.join(' ') });
    } catch {
      /* exited meanwhile */
    }
  }
  return out;
}

function dirBytes(p: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const walk = (q: string) => {
    let st;
    try {
      st = lstatSync(q);
    } catch {
      return;
    }
    entries++;
    if (st.isDirectory()) for (const n of readdirSync(q)) walk(join(q, n));
    else bytes += st.size;
  };
  walk(p);
  return { entries: entries - 1, bytes };
}

function freeBytes(p: string): number {
  const s = statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n';

async function waitFor(pred: () => boolean, timeoutMs: number, label: string, everyMs = 50) {
  const t0 = performance.now();
  while (!pred()) {
    if (aborting) throw new PhaseError('aborted');
    if (performance.now() - t0 > timeoutMs) throw new PhaseError(`timed out: ${label}`);
    await sleep(everyMs);
  }
}

const simNs = (s: HostSession) => BigInt(s.status().simNs);
const serialText = (s: HostSession) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'serial')
    .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
    .join('');

// ---------------------------------------------------------------------------------------------
// Soak state (evidence)

const START = new Date();
const RESULTS = join(RUNTIME_HOME, 'results');
const STATUS_FILE = join(RESULTS, 'r2-soak-status.txt');
const PROGRESS_FILE = join(RESULTS, 'r2-soak-progress.json');
const RUNTIME = runtimeInfo();
const EVIDENCE_DIR =
  process.env.R2_SOAK_EVIDENCE_DIR ??
  join(REPO, 'docs/runtime/r2-evidence', `runtime-${RUNTIME.runtimeId}`);
const EVIDENCE_FILE = join(
  EVIDENCE_DIR,
  `r2-soak-${START.toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}.json`,
);

// Everything this process writes to "temp" goes under one private root: hosts, R1 reference
// overlays, child hosts. The leak checks look at this root only.
/** Pre-existing tbi-* entries in the global temp dir (the soak must not add any). */
const tbiTmpEntries = () =>
  readdirSync(process.env.TMPDIR ?? '/tmp').filter(
    (n) => n.startsWith('tbi-') && !n.startsWith('tbi-soak-'),
  );
const GLOBAL_TBI_BEFORE = tbiTmpEntries();
const SOAK_TMP = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', `tbi-soak-${process.pid}-`));
const GLOBAL_TMP = dirname(SOAK_TMP);
process.env.TMPDIR = SOAK_TMP;

let aborting = false;
let finished = false;
const hosts = new Set<SessionHost>();
const servers = new Set<Server>();
const children = new Set<ChildProcess>();

interface Failure {
  at: string;
  round: number;
  phase: Phase | 'checkpoint' | 'harness';
  critical: boolean;
  kind: string;
  message: string;
  detail?: unknown;
  replay: string;
}

const ev = {
  status: 'RUNNING' as 'RUNNING' | 'PASSED' | 'FAILED' | 'ABORTED',
  mode: REPLAY ? `replay ${REPLAY}` : SELFTEST_FAIL ? `selftest-fail ${SELFTEST_FAIL}` : 'soak',
  budgetMinutes: MINUTES,
  seed: SEED,
  round: 0,
  phase: null as Phase | null,
  phaseRuns: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 } as Record<Phase, number>,
  phaseWallMs: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 } as Record<Phase, number>,
  sessionsCreated: 0,
  sessionsReleasedVerified: 0,
  lifecycles: { stop: 0, terminate: 0, terminateEarly: 0 },
  commands: { submitted: 0, accepted: 0, rejected: {} as Record<string, number>, applied: 0 },
  events: { observed: 0, logWraps: 0 },
  sse: {
    connections: 0,
    resyncs: 0,
    resyncMissedTotal: 0,
    raceResyncs: 0,
    retainedReplays: 0,
    currentIdReplays: 0,
    postResyncContinuations: 0,
    malformedRefused: 0,
    futureRefused: 0,
    precedenceChecks: 0,
    leaseExpiries: 0,
    eventsValidated: 0,
  },
  injections: {} as Record<string, number>,
  determinism: {
    gate15s: {} as Record<string, number>,
    timing30s: {} as Record<string, number>,
    timing4sPrefix: {} as Record<string, number>,
    longGate120s: {} as Record<string, number>,
    longGatePrefix15s: {} as Record<string, number>,
    longGateByQuantum: { q1ms: 0, q10ms: 0 },
    timing1msVs10msEqual: 0,
    equivalencePoints: 0,
    equivalenceWorstAbs: 0,
    referenceOffGridPadEvents: 0,
  },
  artifacts: { pre: {} as Record<string, string>, post: {} as Record<string, string> },
  checkpoints: 0,
  failures: [] as Failure[],
  warnings: [] as string[],
  samples: [] as Record<string, number | string>[],
};
const refs: { timing30?: string; longGate?: string } = {};
const bump = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);

function gitInfo() {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
  const harness = ['runtime/soak/r2-soak.ts', 'runtime/tests/r2-support.ts'];
  return {
    head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain').split('\n').filter(Boolean),
    harnessSha256: Object.fromEntries(harness.map((f) => [f, sha256File(join(REPO, f))])),
  };
}

function environment() {
  let qemuVersion: string;
  try {
    qemuVersion = execFileSync(QEMU, ['--version'], { encoding: 'utf8' }).split('\n')[0]!;
  } catch (e) {
    qemuVersion = `unavailable: ${(e as Error).message}`;
  }
  return {
    hostname: hostname(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemBytes: totalmem(),
    node: process.version,
    qemu: qemuVersion,
    runtime: RUNTIME,
    runtimeHome: RUNTIME_HOME,
  };
}
const GIT = gitInfo();
const ENV = environment();

function statusText(): string {
  const el = (Date.now() - START.getTime()) / 60_000;
  const last = ev.samples.at(-1);
  const lines = [
    `R2 soak ${ev.status}  (${ev.mode})`,
    `pid ${process.pid}  seed ${SEED}  head ${GIT.head.slice(0, 7)}${GIT.dirty.length ? ' +uncommitted' : ''}`,
    `started ${START.toISOString()}  elapsed ${el.toFixed(1)} min of ${MINUTES}`,
    `round ${ev.round}  phase ${ev.phase ?? '-'}${ev.phase ? ` (${PHASE_NAMES[ev.phase]})` : ''}`,
    `phase runs ${PHASES.map((p) => `${p}=${ev.phaseRuns[p]}`).join(' ')}`,
    `sessions created ${ev.sessionsCreated}, released+verified ${ev.sessionsReleasedVerified}`,
    `commands submitted ${ev.commands.submitted}, accepted ${ev.commands.accepted}, applied ${ev.commands.applied}`,
    `events observed ${ev.events.observed}, log wraps ${ev.events.logWraps}, SSE resyncs ${ev.sse.resyncs}`,
    `checkpoints ${ev.checkpoints}, failures ${ev.failures.length} (critical ${ev.failures.filter((f) => f.critical).length})`,
    last
      ? `last sample ${last.at}: rss ${mb(last.rss as number)} fds ${last.fds} qemu ${last.qemu} soakTmp ${mb(last.soakTmpBytes as number)}`
      : 'no sample yet',
    ...ev.failures
      .slice(-5)
      .map(
        (f) =>
          `FAIL [${f.critical ? 'critical' : 'recorded'}] r${f.round} ${f.phase} ${f.kind}: ${f.message} (replay ${f.replay})`,
      ),
    `updated ${now()}`,
  ];
  return lines.join('\n') + '\n';
}
const mb = (b: number) => `${(b / 1048576).toFixed(1)}MB`;

function writeStatus(): void {
  try {
    writeAtomic(STATUS_FILE, statusText());
  } catch {
    /* status is best effort; the evidence write reports errors */
  }
}
function evidence() {
  return {
    kind: 'tbi-lab.r2-soak/1',
    note: 'Engineering endurance evidence on one host; NOT a capacity benchmark.',
    ...ev,
    start: START.toISOString(),
    end: finished ? now() : null,
    wallMs: Date.now() - START.getTime(),
    git: GIT,
    environment: ENV,
    telemetry: telemetrySummary(),
    sampleCount: ev.samples.length,
    samples: ev.samples,
  };
}
function writeProgress(): void {
  try {
    writeAtomic(PROGRESS_FILE, json(evidence()));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------------------------
// Telemetry

let mainHost: SessionHost | null = null;
const liveSessions = new Set<HostSession>();

function sample(): void {
  const q = qemuProcesses();
  const qs = q.map((p) => procStatus(p.pid)).filter(Boolean) as { rss: number; hwm: number }[];
  const kids = [...children].map((c) => (c.pid ? procStatus(c.pid) : null)).filter(Boolean) as {
    rss: number;
  }[];
  const tmp = dirBytes(SOAK_TMP);
  let logOcc = 0;
  let active = 0;
  for (const s of liveSessions) {
    logOcc += s.log.size;
    if (!isTerminal(s.state)) active++;
  }
  const health: Record<string, number> = {};
  for (const h of hosts) for (const [k, v] of Object.entries(h.health())) bump(health, k, v);
  const m = process.memoryUsage();
  ev.samples.push({
    at: now(),
    tMin: Number(((Date.now() - START.getTime()) / 60_000).toFixed(2)),
    round: ev.round,
    phase: ev.phase ?? '-',
    rss: m.rss,
    heapUsed: m.heapUsed,
    fds: readdirSync('/proc/self/fd').length,
    qemu: q.length,
    qemuRssSum: qs.reduce((a, b) => a + b.rss, 0),
    qemuPeakMax: qs.reduce((a, b) => Math.max(a, b.hwm), 0),
    childHosts: kids.length,
    childHostRss: kids.reduce((a, b) => a + b.rss, 0),
    soakTmpEntries: tmp.entries,
    soakTmpBytes: tmp.bytes,
    globalTmpFree: freeBytes(GLOBAL_TMP),
    runtimeHomeFree: freeBytes(RUNTIME_HOME),
    eventLogOccupancy: logOcc,
    sessionsActive: active,
    sessionsRegistered: Object.values(health).reduce((a, b) => a + b, 0),
    sessionsTerminalRetained: (health.ended ?? 0) + (health.failed ?? 0),
    sessionsCreated: ev.sessionsCreated,
    lifecyclesCompleted: ev.sessionsReleasedVerified,
  });
  writeStatus();
}

const METRICS = [
  'rss',
  'heapUsed',
  'fds',
  'qemu',
  'qemuRssSum',
  'qemuPeakMax',
  'soakTmpEntries',
  'soakTmpBytes',
  'globalTmpFree',
  'runtimeHomeFree',
  'eventLogOccupancy',
  'sessionsRegistered',
] as const;

/**
 * Start/min/max/final per metric. A trend flag for host RSS, FDs and temp storage is raised when
 * every quarter of the run has a higher median than the quarter before AND the last quarter's
 * median is more than 10% (RSS) / 5 FDs / 1 MiB above the first quarter's. The flag is for PM
 * review, not a failure (allocator and cache growth are expected to plateau).
 */
function telemetrySummary() {
  const s = ev.samples;
  const summary: Record<string, unknown> = {};
  for (const k of METRICS) {
    const xs = s.map((x) => x[k] as number).filter((x) => typeof x === 'number');
    if (!xs.length) continue;
    summary[k] = { start: xs[0], min: Math.min(...xs), max: Math.max(...xs), final: xs.at(-1) };
  }
  const trends: Record<string, unknown> = {};
  const median = (xs: number[]) => {
    const t = [...xs].sort((a, b) => a - b);
    return t.length ? t[Math.floor(t.length / 2)]! : 0;
  };
  const limits: Record<string, (first: number) => number> = {
    rss: (f) => f * 0.1,
    fds: () => 5,
    soakTmpBytes: () => 1 << 20,
  };
  if (s.length >= 8) {
    for (const k of Object.keys(limits)) {
      const xs = s.map((x) => x[k] as number);
      const q = 4;
      const size = Math.floor(xs.length / q);
      const meds = Array.from({ length: q }, (_, i) =>
        median(xs.slice(i * size, i === q - 1 ? xs.length : (i + 1) * size)),
      );
      const rising = meds.every((m, i) => i === 0 || m > meds[i - 1]!);
      const growth = meds[q - 1]! - meds[0]!;
      trends[k] = {
        quarterMedians: meds,
        growth,
        flagged: rising && growth > limits[k]!(meds[0]!),
      };
    }
  }
  return { metrics: summary, trends };
}

// ---------------------------------------------------------------------------------------------
// Circuits (real domain projects, snapshotted as the browser does)

/**
 * The R1 gate circuit plus a toggle switch and a push button, each from PSU1(+) to
 * R5 (10 k) -> GND. Every live-mirrorable control (PSU setpoint and current limit, toggle
 * position) and a transient input are in one circuit.
 */
function stressRequest() {
  const { d, r1, r2 } = gateProject();
  const sw = d.add('component.toggle_switch');
  const pb = d.add('component.push_button');
  const r5 = d.add('component.resistor');
  d.wire('PSU1.positive', `${sw}.a`).wire('PSU1.positive', `${pb}.a`);
  d.wire(`${sw}.b`, `${r5}.a`).wire(`${pb}.b`, `${r5}.a`).wire(`${r5}.b`, 'GND1.ref');
  d.set(r5, 'resistance', { value: 10_000, unit: 'ohm' });
  const gate = gateRequest('TbiGpioProof');
  return {
    request: {
      ...gate,
      circuit: createSnapshot(d.doc),
      attachments: [
        { gpio: 2, component: r1, terminal: 'a' },
        { gpio: 5, component: r2, terminal: 'b' },
      ],
    },
    sw,
    pb,
  };
}

/**
 * The suite's four VEXT mirrors, then one every 600 ms from 16.0 s up to the long-gate end
 * (10 ms grid). Nothing is scheduled at or before 15.5 s beyond the suite's four, so the
 * stream's first 15.5 s must equal the suite's gate stream.
 */
function longGateMirrors() {
  const out = gateMirrors();
  let t = 16_000_000_000n;
  let v = 3.3;
  while (t < LONG_GATE_END - 500_000_000n) {
    const i = out.length;
    out.push({
      category: 'mirror',
      seq: i + 1,
      atSimNs: String(t),
      projectRevision: 10 + i,
      component: 'PSU1',
      control: { setpointVoltage: v },
    });
    v = v ? 0 : 3.3;
    t += 600_000_000n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Session helpers

interface Ctx {
  round: number;
  phase: Phase;
  rng: Rng;
  sessions: HostSession[];
  hosts: SessionHost[];
  servers: Server[];
}

function newHost(ctx: Ctx, over: Parameters<typeof realHost>[0] = {}): SessionHost {
  const h = realHost({ stallTimeoutMs: 10_000, ...over });
  hosts.add(h);
  ctx.hosts.push(h);
  return h;
}

function track(ctx: Ctx, s: HostSession): HostSession {
  ev.sessionsCreated++;
  liveSessions.add(s);
  ctx.sessions.push(s);
  return s;
}

/**
 * Create a session. The soak drives sessions in-process, so, like a real client, it renews the
 * lease with an authenticated request every 5 s (`keepalive`). Lease expiry itself is exercised
 * with `keepalive: false` (F) and over HTTP/SSE (E).
 */
function create(ctx: Ctx, host: SessionHost, req: unknown, keepalive = true): HostSession {
  const r = host.create(req);
  if (!r.ok) throw new PhaseError(`create refused: ${r.status} ${r.error}`);
  const s = r.value.session;
  if (keepalive) {
    const t = setInterval(() => {
      if (isTerminal(s.state)) clearInterval(t);
      else host.get(s.id, s.token);
    }, 5000);
    t.unref();
  }
  return track(ctx, s);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new PhaseError(`timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function pidOf(s: HostSession): Promise<number> {
  await waitFor(
    () => s.status().runtime.pid !== null || isTerminal(s.state),
    30_000,
    'runtime spawned',
  );
  check(s.status().runtime.pid !== null, `no runtime process: ${JSON.stringify(s.status())}`);
  return s.status().runtime.pid!;
}

/**
 * The session is terminal and released: QEMU gone, private directory gone. An orphan or a leak
 * is critical; an unexpected terminal state/reason is a recorded (non-critical) failure.
 */
async function released(
  s: HostSession,
  pid: number | null,
  dir: string,
  want?: { state: 'ended' | 'failed'; reason: string },
) {
  await withTimeout(s.done(), 90_000, 'session done');
  try {
    await waitFor(() => !alive(pid), 15_000, 'QEMU exit');
  } catch {
    if (pid) process.kill(pid, 'SIGKILL');
    throw new Critical('orphan_qemu', `QEMU ${pid} alive after its session ended`, s.status());
  }
  crit(!existsSync(dir), 'leaked_directory', `private directory survived: ${dir}`, s.status());
  const st = s.status();
  crit(isTerminal(st.state), 'harness', 'session not terminal after done()', st);
  if (liveSessions.delete(s)) {
    ev.sessionsReleasedVerified++;
    ev.events.observed += s.log.lastSeq;
  }
  if (want)
    check(
      st.state === want.state && st.reason === want.reason,
      `expected ${want.state}(${want.reason}), got ${st.state}(${st.reason}) ${JSON.stringify(st.detail ?? null).slice(0, 300)}`,
    );
  return st;
}

/** Run until the simulation passes `until`, then stop in order and verify the release. */
async function finishAt(s: HostSession, until: bigint): Promise<void> {
  const pid = await pidOf(s);
  const dir = s.privateDir;
  const budgetMs = Number(until / 1_000_000n) * 4 + 120_000;
  await waitFor(() => simNs(s) >= until || isTerminal(s.state), budgetMs, `sim >= ${until}`, 100);
  check(s.state === 'running', `ended early: ${JSON.stringify(s.status())}`);
  s.stop();
  await waitFor(() => isTerminal(s.state), 60_000, 'stop');
  await released(s, pid, dir, { state: 'ended', reason: 'stopped' });
}

async function runUntil(s: HostSession, until: bigint): Promise<void> {
  check(s.run().ok, 'run refused');
  await finishAt(s, until);
}

function submitAll(host: SessionHost, s: HostSession, cmds: SessionCommand[]): void {
  for (const c of cmds) {
    ev.commands.submitted++;
    const r = host.command(s, c);
    crit(r.ok && r.value.accepted, 'command_order', 'scheduled command refused', { c, r });
    ev.commands.accepted++;
  }
}

const noEviction = (s: HostSession) =>
  crit(s.log.size === s.log.lastSeq, 'harness', 'event log evicted during a hashed session', {
    size: s.log.size,
    last: s.log.lastSeq,
  });

// ---------------------------------------------------------------------------------------------
// Phase A: lifecycle churn

async function phaseA(ctx: Ctx): Promise<void> {
  const host = mainHost!;
  const nvs = artifact('TbiNvs');
  for (const mode of ['stop', 'terminate', 'terminateEarly', 'stop'] as const) {
    const s = create(ctx, host, loadRequest('TbiNvs'));
    check(s.state === 'ready', `A: not ready: ${JSON.stringify(s.status())}`);
    const dir = s.privateDir;
    crit(
      sha256File(join(dir, 'flash.bin')) === nvs.sha256,
      'contamination',
      'A: the private flash is not a fresh copy of the artifact',
    );
    check(s.run().ok, 'A: run refused');
    const pid = await pidOf(s);
    if (mode === 'terminateEarly') {
      const at = BigInt(ctx.rng.int(200, 3000)) * 1_000_000n;
      await waitFor(() => simNs(s) >= at || isTerminal(s.state), 60_000, 'A: early point');
      await host.terminate(s);
      await released(s, pid, dir, { state: 'ended', reason: 'terminated' });
      ev.lifecycles.terminateEarly++;
      continue;
    }
    await waitFor(
      () => serialText(s).includes('TBI-NVS-DONE') || isTerminal(s.state),
      90_000,
      'A: TBI-NVS-DONE',
    );
    const text = serialText(s);
    crit(
      text.includes('TBI-NVS-BOOTS=1\n') && !/TBI-NVS-BOOTS=(?!1\n)/.test(text),
      'contamination',
      'A: the guest did not start from a clean state',
      text.slice(-400),
    );
    if (mode === 'stop') {
      s.stop();
      await waitFor(() => isTerminal(s.state), 60_000, 'A: stop');
      await released(s, pid, dir, { state: 'ended', reason: 'stopped' });
      ev.lifecycles.stop++;
    } else {
      await host.terminate(s);
      await released(s, pid, dir, { state: 'ended', reason: 'terminated' });
      ev.lifecycles.terminate++;
    }
  }
  // The live-session limit is enforced (sessions in `ready` hold no QEMU, only their copy).
  const held: HostSession[] = [];
  for (let i = 0; i < host.config.maxSessions; i++)
    held.push(create(ctx, host, loadRequest('TbiNvs')));
  const over = host.create(loadRequest('TbiNvs'));
  if (over.ok) track(ctx, over.value.session);
  crit(!over.ok && over.status === 429, 'limit_not_enforced', 'A: a session beyond the limit');
  for (const h of held) {
    const d = h.privateDir;
    await host.terminate(h);
    await released(h, null, d, { state: 'ended', reason: 'terminated' });
  }
  bump(ev.injections, 'session_limit_429');
}

// ---------------------------------------------------------------------------------------------
// Phase B: concurrent isolation

async function phaseB(ctx: Ctx): Promise<void> {
  const host = mainHost!;
  const a = create(ctx, host, loadRequest('TbiNvs'));
  const b = create(ctx, host, loadRequest('TbiNvs'));
  crit(a.id !== b.id && a.privateDir !== b.privateDir, 'contamination', 'B: shared identity');
  crit(
    !host.get(a.id, b.token).ok && !host.get(b.id, a.token).ok,
    'contamination',
    "B: one session's token opens the other",
  );
  check(a.run().ok && b.run().ok, 'B: run refused');
  const [pa, pb] = [await pidOf(a), await pidOf(b)];
  crit(pa !== pb, 'contamination', 'B: one QEMU for two sessions');
  for (const s of [a, b]) {
    await waitFor(
      () => serialText(s).includes('TBI-NVS-DONE') || isTerminal(s.state),
      120_000,
      'B: TBI-NVS-DONE',
    );
    crit(
      serialText(s).includes('TBI-NVS-BOOTS=1\n'),
      'contamination',
      "B: a concurrent session saw the other session's flash writes",
      serialText(s).slice(-300),
    );
  }
  // Alternate which session is terminated first.
  const aFirst = ctx.round % 2 === 1;
  const [first, other] = aFirst ? [a, b] : [b, a];
  const [pf, po] = aFirst ? [pa, pb] : [pb, pa];
  const [df, dOther] = [first.privateDir, other.privateDir];
  const simOther = simNs(other);
  await host.terminate(first);
  await released(first, pf, df, { state: 'ended', reason: 'terminated' });
  crit(
    other.state === 'running' && alive(po),
    'contamination',
    'B: terminating one session disturbed the other',
  );
  try {
    await waitFor(() => simNs(other) > simOther + 300_000_000n, 60_000, 'B: survivor advances');
  } catch {
    throw new Critical('contamination', 'B: the surviving session stopped advancing');
  }
  other.stop();
  await waitFor(() => isTerminal(other.state), 60_000, 'B: stop');
  await released(other, po, dOther, { state: 'ended', reason: 'stopped' });
  bump(ev.injections, aFirst ? 'B_terminate_A_first' : 'B_terminate_B_first');

  // Two concurrent gate sessions: each equals the solo reference, byte for byte.
  const g = [0, 1].map(() => {
    const s = create(ctx, host, gateRequest('TbiGpioProof'));
    submitAll(host, s, gateMirrors());
    return s;
  });
  for (const s of g) check(s.run().ok, 'B: run refused');
  await Promise.all(g.map((s) => finishAt(s, GATE_END)));
  for (const s of g) {
    noEviction(s);
    const h = hash16(runtimeEvents(s, GATE_END));
    bump(ev.determinism.gate15s, h);
    crit(h === ANCHOR_GATE, 'determinism', `B: concurrent gate stream ${h} != ${ANCHOR_GATE}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Phase C: long deterministic sessions

async function phaseC(ctx: Ctx): Promise<void> {
  const host = mainHost!;
  // Long TbiTiming, no host commands, at 1 ms and 10 ms: identical guest timelines.
  const streams: Record<number, unknown[]> = {};
  for (const q of [1000, 10_000]) {
    const s = create(ctx, host, loadRequest('TbiTiming', { commandQuantumUs: q }));
    await runUntil(s, TIMING_END);
    noEviction(s);
    streams[q] = runtimeEvents(s, TIMING_END);
    const prefix = hash16(runtimeEvents(s, 4_000_000_000n));
    bump(ev.determinism.timing4sPrefix, prefix);
    crit(
      prefix === ANCHOR_TIMING_4S,
      'determinism',
      `C: TbiTiming 4 s prefix ${prefix} at ${q} us`,
    );
  }
  const h1 = hash16(streams[1000]);
  const h10 = hash16(streams[10_000]);
  bump(ev.determinism.timing30s, h1);
  bump(ev.determinism.timing30s, h10);
  crit(h1 === h10, 'determinism', `C: TbiTiming 1 ms ${h1} != 10 ms ${h10} (no commands)`);
  ev.determinism.timing1msVs10msEqual++;
  refs.timing30 ??= h1;
  crit(h1 === refs.timing30, 'determinism', `C: TbiTiming ${h1} != first run ${refs.timing30}`);

  // Long gate with scheduled persistent mirrors; the quantum alternates by round, and every run
  // must equal the first (so 1 ms and 10 ms are compared from round 2 on).
  const q = ctx.round % 2 === 1 ? 1000 : 10_000;
  const s = create(ctx, host, gateRequest('TbiGpioProof', { commandQuantumUs: q }));
  submitAll(host, s, longGateMirrors());
  await runUntil(s, LONG_GATE_END);
  noEviction(s);
  const h = hash16(runtimeEvents(s, LONG_GATE_END));
  const prefix = hash16(runtimeEvents(s, GATE_END));
  bump(ev.determinism.longGate120s, h);
  bump(ev.determinism.longGatePrefix15s, prefix);
  ev.determinism.longGateByQuantum[q === 1000 ? 'q1ms' : 'q10ms']++;
  crit(prefix === ANCHOR_GATE, 'determinism', `C: long gate 15.5 s prefix ${prefix} at ${q} us`);
  refs.longGate ??= h;
  crit(
    h === refs.longGate,
    'determinism',
    `C: long gate ${h} at ${q} us != first ${refs.longGate}`,
  );

  // Feedback stays at its causing simulation time: every published operating point equals the
  // R1 reference loop's solve in force at that time; the reference's pad events are off-grid.
  const fw = artifact('TbiGpioProof');
  const ref = await runClosedLoop({
    qemu: QEMU,
    artifact: fw.path,
    artifactSha256: fw.sha256,
    endNs: GATE_END,
    tickUs: 1000,
  });
  const offGrid = ref.timeline
    .filter((l) => l.startsWith('G '))
    .filter((l) => BigInt(l.split(' ')[1]!) % 1_000_000n !== 0n).length;
  crit(offGrid > 0, 'equivalence', 'C: the reference loop has no off-grid pad events');
  ev.determinism.referenceOffGridPadEvents += offGrid;
  const solves = ref.timeline
    .filter((l) => l.startsWith('V '))
    .map((l) => {
      const m = /^V (\d+) \S+ io2=(\S+) io5=(\S+) iLED=(\S+)/.exec(l)!;
      return { vns: BigInt(m[1]!), io2: Number(m[2]), io5: Number(m[3]), iLed: Number(m[4]) };
    });
  const g = create(ctx, host, gateRequest('TbiGpioProof'));
  submitAll(host, g, gateMirrors());
  await runUntil(g, GATE_END);
  const gh = hash16(runtimeEvents(g, GATE_END));
  bump(ev.determinism.gate15s, gh);
  crit(gh === ANCHOR_GATE, 'determinism', `C: gate stream ${gh} != ${ANCHOR_GATE}`);
  let points = 0;
  for (const e of g.log.since(0)) {
    if (e.type !== 'electrical' || BigInt(e.simNs!) > GATE_END) continue;
    const t = BigInt(e.simNs!);
    const r = [...solves].reverse().find((x) => x.vns <= t)!;
    const o = e.outcome as {
      pins: { gpio: number; voltage: number }[];
      components: Record<string, { current: number }>;
    };
    const got = [
      o.pins.find((p) => p.gpio === 2)!.voltage,
      o.pins.find((p) => p.gpio === 5)!.voltage,
      o.components.D1!.current,
    ];
    const want = [r.io2, r.io5, r.iLed];
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(got[i]! - want[i]!);
      ev.determinism.equivalenceWorstAbs = Math.max(ev.determinism.equivalenceWorstAbs, d);
      crit(d <= 1e-9 * Math.max(1, Math.abs(want[i]!)), 'equivalence', 'C: operating point', {
        t,
        got,
        want,
      });
    }
    points++;
  }
  crit(points > 20, 'equivalence', `C: only ${points} operating points compared`);
  ev.determinism.equivalencePoints += points;
}

// ---------------------------------------------------------------------------------------------
// Phase D: mirror/transient command stress

type Op = 'mirror' | 'transient' | 'dupSeq' | 'dupRev' | 'stale' | 'ooo' | 'late';
const OPS: [Op, number][] = [
  ['mirror', 0.35],
  ['transient', 0.25],
  ['dupSeq', 0.06],
  ['dupRev', 0.09],
  ['stale', 0.09],
  ['ooo', 0.08],
  ['late', 0.08],
];
function pickOp(rng: Rng): Op {
  let x = rng.next();
  for (const [op, w] of OPS) if ((x -= w) < 0) return op;
  return 'mirror';
}

async function phaseD(ctx: Ctx): Promise<void> {
  const CAP = 128;
  const QMAX = 16;
  const host = newHost(ctx, { maxQueuedCommands: QMAX, eventLogCapacity: CAP });
  const { request, sw, pb } = stressRequest();
  const s = create(ctx, host, request);
  check(s.state === 'ready', `D: not ready: ${JSON.stringify(s.status())}`);
  const snap = request.circuit.projectRevision;
  const model = {
    seq: 0,
    lastAccSeq: 0,
    accepted: snap,
    applied: snap,
    psu: 0,
    sw: false,
    pb: false,
  };
  const sent = new Map<number, SessionCommand>();
  const pending = new Map<number, SessionCommand>();
  let violation: Critical | null = null;
  const fail = (kind: CriticalKind, msg: string, detail?: unknown) =>
    (violation ??= new Critical(kind, `D: ${msg}`, detail));
  let warnedMode = false;
  let submitting = false;

  const off = s.log.subscribe((e: SessionEvent) => {
    if (s.log.size > CAP) fail('limit_not_enforced', `event log holds ${s.log.size} > ${CAP}`);
    if (e.type === 'command') {
      if (e.result !== 'applied') {
        // Receipt-time rejections are logged during submit() (a `duplicate` names the seq of a
        // queued command); only a rejection logged at a command tick concerns the queue.
        if (!submitting && pending.has(e.commandSeq))
          fail('command_order', 'queued command rejected at apply', e);
        return;
      }
      ev.commands.applied++;
      const c = sent.get(e.commandSeq);
      if (!c || !pending.has(e.commandSeq))
        return fail('command_order', `applied ack for a command not queued (${e.commandSeq})`, e);
      const oldest = pending.keys().next().value;
      if (oldest !== e.commandSeq)
        fail('command_order', 'applied out of client order', { oldest, got: e.commandSeq });
      pending.delete(e.commandSeq);
      if (c.category === 'mirror') {
        if (e.projectRevision !== c.projectRevision)
          fail('revision_invariant', 'ack revision differs from the command', e);
        if (c.projectRevision <= model.applied)
          fail('revision_invariant', 'applied revision did not increase', { c, model });
        model.applied = c.projectRevision;
        if (c.control.setpointVoltage !== undefined) model.psu = c.control.setpointVoltage;
        if (c.control.closed !== undefined) model.sw = c.control.closed;
      } else {
        if (e.projectRevision !== undefined)
          fail('revision_invariant', 'transient ack carries a revision', e);
        model.pb = c.action === 'press';
      }
    } else if (e.type === 'electrical') {
      const o = e.outcome as {
        appliedRevision: number;
        components: Record<string, { voltage: number; closed?: boolean; mode?: string }>;
      };
      if (o.appliedRevision !== model.applied)
        fail('revision_invariant', `appliedRevision ${o.appliedRevision} != ${model.applied}`);
      const p = o.components.PSU1!;
      if (p.mode === 'cv') {
        if (Math.abs(p.voltage - model.psu) > 1e-9)
          fail('revision_invariant', 'PSU1 does not match the applied mirrors', { p, model });
      } else if (!warnedMode) {
        warnedMode = true;
        ev.warnings.push(`D r${ctx.round}: PSU1 mode ${p.mode} (voltage not compared)`);
      }
      if (o.components[sw]!.closed !== model.sw)
        fail('revision_invariant', 'switch does not match the applied mirrors', { model });
      if (o.components[pb]!.closed !== model.pb)
        fail('revision_invariant', 'push button does not match the applied transients', { model });
    }
  });

  let prev: MirrorRevisions = s.status().revisions;
  const inv = () => {
    const r = s.status().revisions;
    if (r.accepted < prev.accepted || r.applied < prev.applied)
      fail('revision_invariant', 'a revision moved backwards', { prev, r });
    if (r.applied > r.accepted) fail('revision_invariant', 'applied > accepted', r);
    if (r.accepted !== model.accepted || r.applied !== model.applied)
      fail('revision_invariant', 'status disagrees with the model', { r, model });
    const queuedMirror = [...pending.values()].some((c) => c.category === 'mirror');
    if (r.accepted > r.applied !== queuedMirror)
      fail('revision_invariant', 'accepted > applied must mean a mirror is queued', {
        r,
        queuedMirror,
      });
    prev = r;
  };

  const submit = (c: SessionCommand, accepted: boolean, reason?: string) => {
    ev.commands.submitted++;
    submitting = true;
    const r = host.command(s, c);
    submitting = false;
    if (!r.ok) throw new Critical('harness', 'D: command failed validation', { c, r });
    const v = r.value as { accepted: boolean; reason?: string; revisions?: MirrorRevisions };
    crit(
      v.accepted === accepted && v.reason === reason,
      'command_order',
      `D: expected ${reason ?? 'accepted'}, got ${v.reason ?? 'accepted'}`,
      { c, v, model },
    );
    if (v.accepted) {
      ev.commands.accepted++;
      sent.set(c.seq, c);
      pending.set(c.seq, c);
      model.lastAccSeq = c.seq;
      if (c.category === 'mirror') model.accepted = c.projectRevision;
    } else bump(ev.commands.rejected, v.reason!);
    if (c.category === 'mirror')
      crit(
        v.revisions?.accepted === model.accepted,
        'revision_invariant',
        'D: response revisions',
        {
          v,
          model,
        },
      );
    inv();
    if (violation) throw violation;
  };
  const rng = ctx.rng;
  const MS = 1_000_000n;
  const mirrorControl = () =>
    rng.chance(0.5)
      ? { component: 'PSU1', control: { setpointVoltage: rng.pick([0, 1.2, 2.5, 3.3]) } }
      : rng.chance(0.3)
        ? {
            component: 'PSU1',
            control: {
              setpointVoltage: rng.pick([0, 1.2, 2.5, 3.3]),
              currentLimit: rng.pick([0.05, 0.1]),
            },
          }
        : { component: sw, control: { closed: rng.chance(0.5) } };
  const mirror = (seq: number, rev: number, at: bigint): SessionCommand => ({
    category: 'mirror',
    seq,
    atSimNs: String(at),
    projectRevision: rev,
    ...mirrorControl(),
  });
  const transient = (seq: number, at: bigint | string): SessionCommand => ({
    category: 'transient',
    seq,
    atSimNs: String(at),
    action: rng.pick(['press', 'release'] as const),
    component: pb,
  });

  check(s.run().ok, 'D: run refused');
  const pid = await pidOf(s);
  const dir = s.privateDir;
  await waitFor(() => simNs(s) >= 1_000_000_000n || isTerminal(s.state), 60_000, 'D: boot');
  let batch = 0;
  while (simNs(s) < D_END) {
    check(s.state === 'running', `D: session ended: ${JSON.stringify(s.status())}`);
    batch++;
    let t = simNs(s) + 100n * MS;
    let lastT: bigint | null = null;
    for (let k = 0; k < 10; k++) {
      let op = pickOp(rng);
      if (op === 'ooo' && lastT === null) op = 'mirror';
      if (op === 'dupSeq' && model.lastAccSeq === 0) op = 'transient';
      switch (op) {
        case 'mirror':
          submit(
            mirror(++model.seq, model.accepted + 1 + (rng.chance(0.3) ? rng.int(1, 5) : 0), t),
            true,
          );
          break;
        case 'transient':
          submit(transient(++model.seq, t), true);
          break;
        case 'dupSeq':
          submit(mirror(model.lastAccSeq, model.accepted + 1, t), false, 'duplicate');
          bump(ev.injections, 'D_duplicate_seq');
          continue;
        case 'dupRev':
          submit(mirror(++model.seq, model.accepted, t), false, 'duplicate_revision');
          bump(ev.injections, 'D_duplicate_revision');
          continue;
        case 'stale':
          submit(
            mirror(++model.seq, Math.max(0, model.accepted - rng.int(1, 3)), t),
            false,
            'stale_revision',
          );
          bump(ev.injections, 'D_stale_revision');
          continue;
        case 'ooo':
          submit(mirror(++model.seq, model.accepted + 1, lastT! - MS), false, 'out_of_order');
          bump(ev.injections, 'D_out_of_order');
          continue;
        case 'late':
          submit(
            rng.chance(0.5)
              ? mirror(++model.seq, model.accepted + 1, 1000n)
              : transient(++model.seq, '1000'),
            false,
            'late',
          );
          bump(ev.injections, 'D_late');
          continue;
      }
      lastT = t;
      t += BigInt(rng.int(5, 30)) * MS;
    }
    if (batch % 3 === 0) {
      // Fill the queue exactly to its bound, then one transient and one valid mirror bounce.
      const free = QMAX - pending.size;
      for (let i = 0; i < free; i++) {
        submit(transient(++model.seq, t), true);
        lastT = t;
        t += MS;
      }
      submit(transient(++model.seq, t), false, 'queue_full');
      submit(mirror(++model.seq, model.accepted + 1, t), false, 'queue_full');
      bump(ev.injections, 'D_queue_full');
    }
    const target = lastT ?? t;
    await waitFor(
      () => {
        inv();
        return (
          violation !== null ||
          isTerminal(s.state) ||
          (pending.size === 0 && simNs(s) > target + 20n * MS)
        );
      },
      90_000,
      'D: batch applied',
      25,
    );
    if (violation) throw violation;
  }
  inv();
  if (violation) throw violation;
  crit(
    model.accepted === model.applied && pending.size === 0,
    'revision_invariant',
    'D: tail',
    model,
  );
  off();
  ev.events.logWraps += Math.floor(s.log.lastSeq / CAP);
  crit(s.log.size <= CAP, 'limit_not_enforced', 'D: event log over capacity');
  s.stop();
  await waitFor(() => isTerminal(s.state), 60_000, 'D: stop');
  await released(s, pid, dir, { state: 'ended', reason: 'stopped' });
  bump(ev.injections, 'D_batches', batch);
}

// ---------------------------------------------------------------------------------------------
// Phase E: SSE reconnect / bounded log

interface SseRead {
  status: number;
  events: SessionEvent[];
  ids: number[];
}

/** Open an SSE stream, read `want` events (or fail after `timeoutMs`), then disconnect. */
async function sse(url: string, headers: Record<string, string>, want: number, timeoutMs = 60_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  ev.sse.connections++;
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (res.status !== 200) {
      await res.text().catch(() => '');
      return { status: res.status, events: [], ids: [] } as SseRead;
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const out: SseRead = { status: 200, events: [], ids: [] };
    let buf = '';
    while (out.events.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i).split('\n');
        buf = buf.slice(i + 2);
        const data = block.find((l) => l.startsWith('data: '));
        if (!data) continue; // keepalive comment
        out.events.push(JSON.parse(data.slice(6)) as SessionEvent);
        out.ids.push(Number(block.find((l) => l.startsWith('id: '))?.slice(4)));
      }
    }
    return out;
  } catch (e) {
    throw new PhaseError(`SSE read failed or timed out: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

/** A replay after `after` must be contiguous; only its first event may be a resync marker. */
function validateReplay(after: number, r: SseRead, what: string): number {
  crit(r.status === 200, 'event_order', `E: ${what}: status ${r.status}`);
  let prev = after;
  r.events.forEach((e, i) => {
    crit(r.ids[i] === e.seq, 'event_order', `E: ${what}: SSE id ${r.ids[i]} != seq ${e.seq}`);
    if (e.type === 'resync') {
      crit(i === 0, 'event_order', `E: ${what}: resync marker not first`);
      crit(
        e.seq > prev && e.missed === e.seq - prev,
        'sse_history_loss',
        `E: ${what}: resync count wrong`,
        { after, e },
      );
      ev.sse.resyncs++;
      ev.sse.resyncMissedTotal += e.missed;
    } else {
      crit(
        e.seq === prev + 1,
        'sse_history_loss',
        `E: ${what}: silent gap or duplicate (expected ${prev + 1}, got ${e.seq})`,
        { after, seqs: r.events.map((x) => x.seq) },
      );
    }
    prev = e.seq;
    ev.sse.eventsValidated++;
  });
  return prev;
}

/** A background SSE client that keeps the session's lease alive while the phase waits. */
function holder(url: string, headers: Record<string, string>): () => void {
  const ctl = new AbortController();
  void fetch(url, { headers, signal: ctl.signal })
    .then(async (res) => {
      const rd = res.body!.getReader();
      for (;;) if ((await rd.read()).done) break;
    })
    .catch(() => undefined);
  return () => ctl.abort();
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function phaseE(ctx: Ctx): Promise<void> {
  const CAP = 32;
  const LEASE = 3000;
  const host = newHost(ctx, { eventLogCapacity: CAP, leaseMs: LEASE, housekeepingMs: 100 });
  const server = createHttpServer(host);
  servers.add(server);
  ctx.servers.push(server);
  const base = await listen(server);
  const cr = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(gateRequest('TbiGpioProof')),
  });
  check(cr.status === 201, `E: create ${cr.status}`);
  const { sessionId, token } = (await cr.json()) as { sessionId: string; token: string };
  const got = host.get(sessionId, token);
  check(got.ok, 'E: session not found in-process');
  const s = track(ctx, got.ok ? got.value : (null as never));
  const auth = { authorization: `Bearer ${token}` };
  const run = await fetch(`${base}/sessions/${sessionId}/run`, { method: 'POST', headers: auth });
  check(run.status === 202, `E: run ${run.status}`);
  const pid = await pidOf(s);
  const dir = s.privateDir;
  const url = `${base}/sessions/${sessionId}/events`;
  const release = holder(`${url}?after=${s.log.lastSeq}`, auth);
  const rng = ctx.rng;
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      // Fresh attach (from the start; a resync is legitimate once the start was evicted).
      let last = validateReplay(0, await sse(url, auth, 8), 'fresh');
      // Retained id: exactly what follows it.
      const r1 = await sse(url, { ...auth, 'last-event-id': String(last) }, 5);
      if (r1.events[0]?.type === 'resync') ev.sse.raceResyncs++;
      else ev.sse.retainedReplays++;
      last = validateReplay(last, r1, 'retained');
      // Evicted id: an explicit resync marker with the exact loss, then the retained tail.
      await waitFor(() => s.log.lastSeq - last > CAP + 8, 120_000, 'E: eviction', 50);
      const viaQuery = rng.chance(0.5);
      const r2 = await sse(
        viaQuery ? `${url}?after=${last}` : url,
        viaQuery ? auth : { ...auth, 'last-event-id': String(last) },
        4,
      );
      crit(
        r2.events[0]?.type === 'resync',
        'sse_history_loss',
        'E: evicted history without resync',
        {
          last,
          first: r2.events[0],
        },
      );
      const marker = r2.events[0]!.seq;
      validateReplay(last, r2, 'evicted');
      // Reconnect from the marker: the stream continues correctly.
      validateReplay(
        marker,
        await sse(url, { ...auth, 'last-event-id': String(marker) }, 3),
        'after resync',
      );
      ev.sse.postResyncContinuations++;
      // Exactly-current id: no replay and no marker, only new events.
      const cur = s.log.lastSeq;
      const r3 = await sse(url, { ...auth, 'last-event-id': String(cur) }, 2);
      crit(r3.events[0]?.type !== 'resync', 'sse_history_loss', 'E: resync for the current id');
      validateReplay(cur, r3, 'current');
      ev.sse.currentIdReplays++;
      // Malformed and future ids are refused (never reinterpreted).
      const bad = rng.pick(['abc', '-1', '1.5', '1e3', '0x7', '9'.repeat(16), '12a']);
      const st = async (u: string, h: Record<string, string>) => {
        const r = await fetch(u, { headers: h });
        await r.text().catch(() => '');
        return r.status;
      };
      crit(
        (await st(url, { ...auth, 'last-event-id': bad })) === 400,
        'event_order',
        `E: malformed id "${bad}" not refused`,
      );
      crit(
        (await st(`${url}?after=${encodeURIComponent(bad)}`, auth)) === 400,
        'event_order',
        'E: malformed after',
      );
      ev.sse.malformedRefused += 2;
      const future = s.log.lastSeq + rng.int(1, 100_000);
      crit(
        (await st(url, { ...auth, 'last-event-id': String(future) })) === 409,
        'event_order',
        'E: future id accepted',
      );
      crit(
        (await st(`${url}?after=${future}`, auth)) === 409,
        'event_order',
        'E: future after accepted',
      );
      ev.sse.futureRefused += 2;
      // Precedence: the header wins over ?after= (valid header + bad query -> 200; the reverse -> 400).
      const now2 = s.log.lastSeq;
      validateReplay(
        now2,
        await sse(`${url}?after=abc`, { ...auth, 'last-event-id': String(now2) }, 1),
        'precedence',
      );
      crit(
        (await st(`${url}?after=${now2}`, { ...auth, 'last-event-id': 'abc' })) === 400,
        'event_order',
        'E: header must win',
      );
      ev.sse.precedenceChecks += 2;
    }
    crit(s.log.size <= CAP, 'limit_not_enforced', 'E: event log over capacity');
    ev.events.logWraps += Math.floor(s.log.lastSeq / CAP);
  } finally {
    release();
  }
  // Repeated attach/detach, then nobody: the lease must still expire.
  for (let i = 0; i < 5; i++) await sse(url, auth, 1);
  const t0 = performance.now();
  await waitFor(() => isTerminal(s.state), LEASE + 15_000, 'E: lease expiry', 50);
  const ms = performance.now() - t0;
  await released(s, pid, dir, { state: 'ended', reason: 'lease_expired' });
  check(ms >= LEASE - 500 && ms <= LEASE + 3000, `E: lease expired after ${ms.toFixed(0)} ms`);
  ev.sse.leaseExpiries++;
}

// ---------------------------------------------------------------------------------------------
// Phase F: failure injection / host-process recovery

const ERASED_DIR = join(SOAK_TMP, 'art-erased');
let ERASED_SHA = '';

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function startChild(tmp: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BUNDLE], {
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: tmp,
      TBI_RUNTIME_HOME: RUNTIME_HOME,
      TBI_HOST_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.stderr!.resume();
  await withTimeout(
    new Promise<void>((resolveUp, reject) => {
      child.stdout!.on('data', (d: Buffer) => d.toString().includes('listening') && resolveUp());
      child.once('exit', (c) => reject(new PhaseError(`child host exited ${c}`)));
    }),
    30_000,
    'child host listening',
  );
  return child;
}

const exited = (c: ChildProcess) =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve(c.exitCode ?? c.signalCode)
    : new Promise<number | string | null>((r) => c.once('exit', (code, sig) => r(code ?? sig)));

async function api(port: number, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function childSession(port: number): Promise<number> {
  const c = await api(port, 'POST', '/sessions', undefined, gateRequest('TbiGpioProof'));
  check(c.status === 201, `F: child create ${c.status}`);
  ev.sessionsCreated++;
  const { sessionId, token } = c.body as { sessionId: string; token: string };
  check((await api(port, 'POST', `/sessions/${sessionId}/run`, token)).status === 202, 'F: run');
  const t0 = performance.now();
  for (;;) {
    const st = await api(port, 'GET', `/sessions/${sessionId}`, token);
    const pid = (st.body.runtime as { pid: number | null }).pid ?? 0;
    if (pid && BigInt(st.body.simNs as string) > 200_000_000n) return pid;
    check(performance.now() - t0 < 60_000, 'F: child session did not start');
    await sleep(100);
  }
}

async function orphanFree(pids: number[], label: string, ms = 15_000): Promise<number> {
  const t0 = performance.now();
  try {
    await waitFor(() => pids.every((p) => !alive(p)), ms, label, 25);
  } catch {
    for (const p of pids) if (alive(p)) process.kill(p, 'SIGKILL');
    throw new Critical('orphan_qemu', `${label}: QEMU survived`, pids);
  }
  return performance.now() - t0;
}

const F_CASES: Record<string, (ctx: Ctx, fHost: SessionHost) => Promise<void>> = {
  async crash(ctx, h) {
    const s = create(ctx, h, gateRequest('TbiGpioProof'));
    check(s.run().ok, 'run');
    const pid = await pidOf(s);
    const at = BigInt(ctx.rng.int(300, 1500)) * 1_000_000n;
    await waitFor(() => simNs(s) >= at || isTerminal(s.state), 60_000, 'crash point');
    process.kill(pid, 'SIGSEGV');
    await waitFor(() => isTerminal(s.state), 30_000, 'crash terminal');
    await released(s, pid, s.privateDir, { state: 'failed', reason: 'runtime_crashed' });
    const runs = s.log.since(0).filter((e) => e.type === 'state' && e.state === 'running').length;
    check(runs === 1, `crash: ${runs} running states (restart?)`);
  },
  async reset(ctx, h) {
    const s = create(ctx, h, loadRequest('TbiRestart'));
    check(s.run().ok, 'run');
    const pid = await pidOf(s);
    await waitFor(() => isTerminal(s.state), 90_000, 'reset terminal');
    await released(s, pid, s.privateDir, { state: 'failed', reason: 'guest_reset' });
    const text = serialText(s);
    check(text.includes('TBI-RESTART-REQUEST'), 'reset: no restart request');
    check((text.match(/^rst:/gm) ?? []).length === 1, 'reset: booted more than once');
  },
  async stall(ctx) {
    const h = newHost(ctx, { artifactsDir: ERASED_DIR, stallTimeoutMs: 5000 });
    const s = create(ctx, h, { ...loadRequest('TbiGpioProof'), artifact: { sha256: ERASED_SHA } });
    check(s.run().ok, 'run');
    const pid = await pidOf(s);
    await waitFor(() => isTerminal(s.state), 60_000, 'stall terminal');
    await released(s, pid, s.privateDir, { state: 'failed', reason: 'stalled' });
    const text = serialText(s);
    check(
      /invalid header: 0xffffffff/.test(text),
      `stall: ROM message missing; status ${JSON.stringify(s.status())}; serial (${text.length} bytes) ${JSON.stringify(text.slice(-300))}`,
    );
  },
  async startFailed(ctx) {
    const h = newHost(ctx, { qemu: join(SOAK_TMP, 'no-such-qemu') });
    const s = create(ctx, h, gateRequest('TbiGpioProof'));
    check(s.run().ok, 'run');
    await waitFor(() => isTerminal(s.state), 30_000, 'start failure terminal');
    await released(s, s.status().runtime.pid, s.privateDir, {
      state: 'failed',
      reason: 'start_failed',
    });
  },
  async termStartup(ctx, h) {
    const s = create(ctx, h, gateRequest('TbiGpioProof'));
    check(s.run().ok, 'run');
    const pid = await pidOf(s);
    await h.terminate(s);
    await released(s, pid, s.privateDir, { state: 'ended', reason: 'terminated' });
  },
  async termRunning(ctx, h) {
    const s = create(ctx, h, gateRequest('TbiGpioProof'));
    check(s.run().ok, 'run');
    const pid = await pidOf(s);
    const at = BigInt(ctx.rng.int(500, 4000)) * 1_000_000n;
    await waitFor(() => simNs(s) >= at || isTerminal(s.state), 60_000, 'terminate point');
    await Promise.all([h.terminate(s), h.terminate(s)]);
    await released(s, pid, s.privateDir, { state: 'ended', reason: 'terminated' });
  },
  async lease(ctx) {
    const h = newHost(ctx, { leaseMs: 1500, housekeepingMs: 100 });
    const s = create(ctx, h, gateRequest('TbiGpioProof'), false);
    check(s.run().ok, 'run');
    const pid = await pidOf(s);
    await waitFor(() => isTerminal(s.state), 30_000, 'lease terminal');
    await released(s, pid, s.privateDir, { state: 'ended', reason: 'lease_expired' });
  },
  async lifetime(ctx, h) {
    const s = create(ctx, h, gateRequest('TbiGpioProof', { limits: { maxLifetimeMs: 4000 } }));
    check(s.run().ok, 'run');
    const pid = await pidOf(s);
    await waitFor(() => isTerminal(s.state), 30_000, 'lifetime terminal');
    await released(s, pid, s.privateDir, { state: 'ended', reason: 'lifetime_exceeded' });
  },
  async hostSigterm() {
    const tmp = mkdtempSync(join(SOAK_TMP, 'child-'));
    const port = await freePort();
    const child = await startChild(tmp, port);
    const pids = [await childSession(port), await childSession(port)];
    const exit = exited(child);
    child.kill('SIGTERM');
    const code = await withTimeout(exit, 90_000, 'child host SIGTERM exit');
    check(code === 0, `hostSigterm: exit ${code}`);
    await orphanFree(pids, 'hostSigterm');
    crit(
      readdirSync(tmp).length === 0,
      'leaked_directory',
      'hostSigterm: temp root left',
      readdirSync(tmp),
    );
    rmSync(tmp, { recursive: true, force: true });
    ev.sessionsReleasedVerified += 2;
  },
  async hostSigkill() {
    const tmp = mkdtempSync(join(SOAK_TMP, 'child-'));
    const port = await freePort();
    const child = await startChild(tmp, port);
    const pid = await childSession(port);
    const exit = exited(child);
    child.kill('SIGKILL');
    await withTimeout(exit, 30_000, 'child host SIGKILL exit');
    const ms = await orphanFree([pid], 'hostSigkill: QEMU after its host was killed');
    bump(ev.injections, 'F_qemu_exit_after_host_kill_ms_total', Math.round(ms));
    check(
      readdirSync(tmp).length === 1,
      `hostSigkill: expected the dead host's root, got ${readdirSync(tmp)}`,
    );
    const next = await startChild(tmp, await freePort());
    const roots = readdirSync(tmp);
    crit(
      roots.length === 1 && readdirSync(join(tmp, roots[0]!)).length === 0,
      'leaked_directory',
      'hostSigkill: the restarted host did not remove the stale root',
      roots,
    );
    const e2 = exited(next);
    next.kill('SIGTERM');
    await withTimeout(e2, 60_000, 'restarted host exit');
    crit(readdirSync(tmp).length === 0, 'leaked_directory', 'hostSigkill: temp root left');
    rmSync(tmp, { recursive: true, force: true });
    ev.sessionsReleasedVerified++;
  },
};

async function phaseF(ctx: Ctx): Promise<void> {
  const fHost = newHost(ctx, {});
  const cases = Object.keys(F_CASES);
  for (let i = cases.length - 1; i > 0; i--) {
    const j = ctx.rng.int(0, i);
    [cases[i], cases[j]] = [cases[j]!, cases[i]!];
  }
  for (const name of cases) {
    try {
      await F_CASES[name]!(ctx, fHost);
      bump(ev.injections, `F_${name}`);
    } catch (e) {
      if (e instanceof Critical || aborting) throw e;
      recordFailure(ctx.round, 'F', e, false, `F:${name}`);
    }
    // Whatever happened, nothing of this case may survive it.
    await settle(ctx);
    const q = qemuProcesses();
    if (q.length)
      await orphanFree(
        q.map((p) => p.pid),
        `F:${name} checkpoint`,
        10_000,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Phase runner, checkpoints, teardown

function recordFailure(
  round: number,
  phase: Failure['phase'],
  e: unknown,
  critical: boolean,
  kind?: string,
) {
  const err = e as Error & { kind?: string; detail?: unknown };
  let detail: unknown = err.detail;
  try {
    const t = json(detail ?? null);
    if (t.length > 4000) detail = `${t.slice(0, 4000)}...`;
  } catch {
    detail = String(detail);
  }
  ev.failures.push({
    at: now(),
    round,
    phase,
    critical,
    kind: kind ?? err.kind ?? (e instanceof PhaseError ? 'phase_error' : 'exception'),
    message: err.message ?? String(e),
    ...(detail !== undefined ? { detail } : {}),
    replay:
      phase === 'checkpoint' || phase === 'harness'
        ? '-'
        : `R2_SOAK_SEED=${SEED} R2_SOAK_REPLAY=${phase}:${round}`,
  });
  writeStatus();
}

/** Terminate whatever the phase left running and verify it was released. */
async function settle(ctx: Ctx): Promise<void> {
  for (const s of ctx.sessions) {
    if (!liveSessions.has(s)) continue;
    const pid = s.status().runtime.pid;
    if (!isTerminal(s.state))
      await withTimeout(s.terminate('terminated'), 60_000, 'settle terminate');
    await released(s, pid, s.privateDir);
  }
}

async function phaseCleanup(ctx: Ctx): Promise<void> {
  await settle(ctx);
  for (const srv of ctx.servers) {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    servers.delete(srv);
  }
  for (const h of ctx.hosts) {
    await withTimeout(h.shutdown(), 90_000, 'host shutdown');
    hosts.delete(h);
    crit(!existsSync(h.tmpRoot), 'leaked_directory', `host root survived shutdown: ${h.tmpRoot}`);
  }
}

async function checkpoint(label: string): Promise<void> {
  ev.checkpoints++;
  let q = qemuProcesses();
  const t0 = performance.now();
  while (q.length && performance.now() - t0 < 10_000) {
    await sleep(200);
    q = qemuProcesses();
  }
  if (q.length) {
    for (const p of q) process.kill(p.pid, 'SIGKILL');
    throw new Critical('orphan_qemu', `${label}: ${q.length} QEMU alive at the checkpoint`, q);
  }
  crit(children.size === 0, 'harness', `${label}: a child host is still running`);
  const allowed = new Set(
    [...hosts].map((h) => h.tmpRoot.split('/').pop()!).concat(['art-erased']),
  );
  for (const name of readdirSync(SOAK_TMP)) {
    if (allowed.has(name)) continue;
    crit(
      !/^(tbi-host-|tbi-session-|s-|child-)/.test(name),
      'leaked_directory',
      `${label}: leftover ${name} in the soak temp root`,
    );
    const w = `${label}: unexpected ${name} in the soak temp root`;
    if (!ev.warnings.includes(w)) ev.warnings.push(w);
  }
  for (const h of hosts) {
    const left = readdirSync(h.tmpRoot);
    crit(left.length === 0, 'leaked_directory', `${label}: private directories left`, left);
  }
  for (const n of ARTIFACTS) {
    const a = artifact(n);
    crit(sha256File(a.path) === a.sha256, 'artifact_mutation', `${label}: ${n} changed`);
  }
  crit(
    sha256File(join(ERASED_DIR, `${ERASED_SHA}.bin`)) === ERASED_SHA,
    'artifact_mutation',
    `${label}: erased test artifact changed`,
  );
  sample();
}

const PHASE_FN: Record<Phase, (ctx: Ctx) => Promise<void>> = {
  A: phaseA,
  B: phaseB,
  C: phaseC,
  D: phaseD,
  E: phaseE,
  F: phaseF,
};

async function runPhase(phase: Phase, round: number): Promise<void> {
  ev.round = round;
  ev.phase = phase;
  writeStatus();
  const ctx: Ctx = {
    round,
    phase,
    rng: mulberry32(phaseSeed(round, phase)),
    sessions: [],
    hosts: [],
    servers: [],
  };
  const t0 = performance.now();
  try {
    await PHASE_FN[phase](ctx);
  } catch (e) {
    if (e instanceof Critical) throw e;
    if (aborting) return;
    recordFailure(round, phase, e, false);
  } finally {
    if (!aborting) await phaseCleanup(ctx);
  }
  if (aborting) return;
  ev.phaseRuns[phase]++;
  ev.phaseWallMs[phase] += Math.round(performance.now() - t0);
  await checkpoint(`${phase}${round}`);
  if (SELFTEST_FAIL === phase && round === 1)
    throw new Critical('selftest', `forced failure after phase ${phase} (R2_SOAK_SELFTEST_FAIL)`);
  writeProgress();
}

function artifactHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of ARTIFACTS) out[n] = sha256File(artifact(n).path);
  return out;
}

let tornDown = false;
async function teardown(): Promise<void> {
  if (tornDown) return;
  tornDown = true;
  aborting = true;
  const t = {
    hostsShutDown: 0,
    childrenKilled: 0,
    qemuKilled: 0,
    qemuLeft: 0,
    soakTmpRemoved: false,
  };
  await Promise.race([
    Promise.all(
      [...hosts].map((h) =>
        h.shutdown().then(
          () => t.hostsShutDown++,
          () => undefined,
        ),
      ),
    ),
    sleep(60_000),
  ]);
  for (const srv of servers) {
    srv.closeAllConnections();
    srv.close();
  }
  for (const c of [...children]) {
    c.kill('SIGTERM');
    const done = await Promise.race([exited(c).then(() => true), sleep(10_000).then(() => false)]);
    if (!done) c.kill('SIGKILL');
    t.childrenKilled++;
  }
  await sleep(500);
  for (const p of qemuProcesses().filter((x) => x.cmd.includes(SOAK_TMP))) {
    process.kill(p.pid, 'SIGKILL');
    t.qemuKilled++;
  }
  const t0 = performance.now();
  while (qemuProcesses().length && performance.now() - t0 < 10_000) await sleep(100);
  t.qemuLeft = qemuProcesses().length;
  rmSync(SOAK_TMP, { recursive: true, force: true });
  t.soakTmpRemoved = !existsSync(SOAK_TMP);
  (ev as Record<string, unknown>).teardown = t;
}

function finalize(code: number): never {
  finished = true;
  const after = readdirSync(GLOBAL_TMP).filter(
    (n) => n.startsWith('tbi-') && !n.startsWith('tbi-soak-'),
  );
  (ev as Record<string, unknown>).globalTmp = {
    tbiEntriesBefore: GLOBAL_TBI_BEFORE,
    tbiEntriesAfter: after,
    addedBySoak: after.filter((n) => !GLOBAL_TBI_BEFORE.includes(n)),
    soakRootRemoved: !existsSync(SOAK_TMP),
  };
  try {
    ev.artifacts.post = artifactHashes();
  } catch (e) {
    ev.warnings.push(`post artifact hashing failed: ${(e as Error).message}`);
  }
  try {
    writeAtomic(EVIDENCE_FILE, json(evidence()));
  } catch (e) {
    process.stderr.write(`evidence write failed: ${(e as Error).message}\n`);
  }
  writeProgress();
  writeStatus();
  process.stdout.write(statusText());
  process.stdout.write(`evidence: ${EVIDENCE_FILE}\n`);
  process.exit(code);
}

async function abortWith(signal: string): Promise<void> {
  if (tornDown || finished) return;
  ev.status = 'ABORTED';
  (ev as Record<string, unknown>).abortSignal = signal;
  writeStatus();
  await teardown();
  finalize(signal === 'SIGINT' ? 130 : 143);
}

async function failHard(e: unknown): Promise<void> {
  if (tornDown || finished) return;
  recordFailure(ev.round, e instanceof Critical ? (ev.phase ?? 'harness') : 'harness', e, true);
  ev.status = 'FAILED';
  writeStatus();
  await teardown();
  finalize(1);
}

// ---------------------------------------------------------------------------------------------
// Main

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(sig, () => void abortWith(sig));
process.on(
  'uncaughtException',
  (e) => void failHard(new Critical('harness', `uncaught: ${e.stack ?? e}`)),
);
process.on(
  'unhandledRejection',
  (e) => void failHard(new Critical('harness', `unhandled rejection: ${(e as Error)?.stack ?? e}`)),
);

async function main(): Promise<void> {
  crit(existsSync(QEMU), 'harness', `runtime not provisioned at ${RUNTIME_HOME}`);
  crit(existsSync(BUNDLE), 'harness', 'host bundle missing: run npm run host:build');
  mkdirSync(ERASED_DIR);
  const img = Buffer.alloc(4 << 20, 0xff);
  ERASED_SHA = createHash('sha256').update(img).digest('hex');
  writeFileSync(join(ERASED_DIR, `${ERASED_SHA}.bin`), img);
  chmodSync(join(ERASED_DIR, `${ERASED_SHA}.bin`), 0o444);
  ev.artifacts.pre = artifactHashes();
  for (const n of ARTIFACTS)
    crit(
      ev.artifacts.pre[n] === artifact(n).sha256,
      'artifact_mutation',
      `${n} differs from its lock`,
    );
  mainHost = realHost({ stallTimeoutMs: 10_000 });
  hosts.add(mainHost);
  sample();
  const sampler = setInterval(sample, 30_000);
  sampler.unref();
  const deadline = START.getTime() + MINUTES * 60_000;

  if (REPLAY) {
    const m = /^([A-F]):(\d+)$/.exec(REPLAY);
    crit(m, 'harness', `R2_SOAK_REPLAY must be <A..F>:<round>, got ${REPLAY}`);
    await runPhase(m![1] as Phase, Number(m![2]));
  } else {
    outer: for (let round = 1; ; round++) {
      for (const phase of PHASES) {
        if (Date.now() >= deadline || aborting) break outer;
        await runPhase(phase, round);
      }
    }
  }
  if (aborting) return;
  ev.phase = null;
  await withTimeout(mainHost.shutdown(), 90_000, 'main host shutdown');
  hosts.delete(mainHost);
  crit(!existsSync(mainHost.tmpRoot), 'leaked_directory', 'main host root survived shutdown');
  await checkpoint('final');
  clearInterval(sampler);
  ev.status = ev.failures.length ? 'FAILED' : 'PASSED';
  await teardown();
  finalize(ev.failures.length ? 1 : 0);
}

main().catch((e) => void failHard(e instanceof Critical ? e : e));
