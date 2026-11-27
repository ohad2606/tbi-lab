/**
 * K2-b / BETA-G2: load harness against the DEPLOYED STAGING instance (`tbi-s8`), never any other.
 * Plan of record: reports/2026-11-24-fable52-k2k3-plan.md section 3.
 *
 * Identities (the c5-deployed root relays and `x-forwarded-user`): Free + 2 preview, at most 30 in all
 * (22 Free with the default maxFree 16). 6 sessions live (4 Free + 2 preview).
 *  1. Builds: two unique sketches built concurrently, then one per identity.
 *  2. Admission: 4 Free + 2 preview get 201; 10 more Free with `Tbi-Queue: 1` get 202 at positions
 *     1..10. Free live never exceeds 4, host live never 6. Status must report idleMs 300000.
 *  3. Cancel: the last waiter cancels (204) and `waiting` drops by one.
 *  4. Pause drill: `free-admission.paused` -> new Free 429 `free_paused` within 5 s, waiting Free are
 *     removed (polled), running sessions untouched; file removed -> admission back; waiters re-queue.
 *  5. Drain: 120 s lifetimes free the seats; every waiter is promoted (201) in FIFO order, the head
 *     within pollAfterS + 30 s. Then all sessions are deleted and the Free cooldown is waited out.
 *  6. Idle (G3): 6 live; one Free gets no presence, 5 post presence every 60 s, one Free waits. The
 *     silent one ends `idle_timeout` at 300 s +/- 2 s after `run`, the others survive, the waiter is
 *     promoted within pollAfterS + 30 s. Status polls renew the lease and are not interaction. As a
 *     left-open tab, the silent session holds its event stream and must receive its own
 *     `idle_timeout` on it; one present session holds a stream too, which must still be open (longer
 *     than the idle limit) at the end of step 9.
 *  7. queue_full (G5): Free join until refusal: exactly maxFree wait, the next gets 429 `queue_full`.
 *     Refused (run FAILS) if it needs more than the identity budget. Then, only with enough extra paying
 *     identities (maxLength - maxFree + 1, default 5, none holding a seat): they join behind the full
 *     Free share, `waiting` reaches maxLength and the next paying one gets 429 `queue_full`. With too
 *     few the drill is `not_run` (report `queueFullAtMaxLength`, metrics `queueFullPaidNeeded` /
 *     `Given`, its own vitest case skipped with the number needed); it never counts as passed.
 *  8. Abandon (G5): a waiter that never polls leaves within vanishMs + 5 s housekeeping + 10 s.
 *  9. Builds under load and queue_timeout (G4 + G5), concurrently with 6 live: two new builds, each
 *     success or explicit refusal within 600 s (+10 s observation), wait > 120 s flagged `dec32` (not a
 *     failure); a polling waiter gets 429 `queue_timeout` at maxWaitMs (<= + 2 x pollAfterS + 30 s).
 * 10. Clean-up (G7, also after any failure): own tickets cancelled, own sessions deleted, own pause
 *     file removed; within 30 s live/waiting/metered 0, no own runtime unit or session directory;
 *     exactly one sim_open and one sim_close per own session in sim-journal.log; no identity, token or
 *     ticket in that file or the host journal. Others' units/directories are counted, never touched.
 *
 * Auto-stop (G6, g2-load.ts): every 5 s (never two at once), read-only commands. Abort on
 * MemAvailable < 300 MiB twice in a row; load1 > max(4 x CPUs, 12) for 60 s; session-host or build
 * unit working set (memory.stat anon + kernel + shmem; MemoryCurrent is reported only) >= 90 % of
 * MemoryMax; a new oom_kill or kernel OOM line; 3 failed samples in a row; the pipeline lock no
 * longer held (or 3 checks in a row without an answer); or the manual stop file
 * $TBI_RUNTIME_HOME/g2-stop, read first. A whole sample has 15 s. Without aborting, the run FAILS on
 * MemAvailable < 400 MiB at any sample, load1 > 2 x CPUs for 60 s, > 10 % failed samples, or more
 * than 30 s between two good samples.
 * G4 counts only builder_busy / memory_pressure / storage_pressure / capacity_timeout as a refusal
 * (any 429 fails); zero successful builds is flagged `dec32`. Every report lists `notCovered`.
 * Reports (numbers and fixed codes only): $TBI_RUNTIME_HOME/results/g2-deployed-<run>[-FAILED].json.
 * Capacity A1 (only with TBI_G2_A1=1, g2-metrics.ts): 1 Hz unprivileged cgroup reads for the whole
 * run and, after step 9, labelled rounds (delay solo, busy loop solo, 3 + 3 together; 120 s each,
 * up to about 35 min more). They add the report field `a1`; an unfinished round is `a1.status:
 * incomplete` and does not fail the run, but auto-stop and the run criteria stay in force.
 *
 * RUNBOOK (interactive only, daytime, never from the night runner or CI; staging only):
 *   1. Staging installed per the plan (policy.beta.json, TBI_HOST_MAX_SESSIONS=6, metering on,
 *      TBI_HOST_IDLE_MS=300000); the two preview identities mapped to `preview` in the server's policy
 *      copy (not in the repo). The harness configures nothing.
 *   2. Take the pipeline lock (deploy/ops/pipeline-lock.mjs acquire) inside tmux, from the shell that
 *      runs the test; lock window 2 h by default, up to 2.5 h.
 *   3. TBI_G2_DEPLOYED=tbi-s8 TBI_ALLOW_SERVICE_MUTATION=tbi-s8 TBI_G2_PREVIEW_USERS=<id1>,<id2> \
 *      [TBI_G2_SECONDS=1500] npx vitest run --config vitest.runtime.config.ts \
 *      runtime/tests/g2-deployed.runtime.test.ts
 *      For the 3.12 capacity numbers run this gate pass first without TBI_G2_A1, then a second
 *      pass with TBI_G2_A1=1, a 2.5 h lock and no testers on DEV-Lab (docs/ops/TEST-SAFETY.md).
 *      Optional: TBI_G2_EXTRA_PAYING_USERS=<id3>,...,<id7> (existing identities, also mapped to
 *      `preview` in the server's policy copy; never committed).
 *   4. Without TBI_G2_DEPLOYED the file does nothing. With it set, CI, a wrong instance, a missing
 *      mutation opt-in or lock, a wrong preview list or an unclean baseline FAILS the test. The only
 *      writes are the pause file and the harness's own builds, sessions and tickets.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it, onTestFailed } from 'vitest';
import { parseConfig } from '../plans/config.js';
import { DEFAULT_SIM_HOUSEKEEPING_MS, FREE_PAUSE_FILE } from '../plans/hostboot.js';
import { recordEvidence, RUNTIME_HOME } from '../harness/env.js';
import { Circuit } from '../host/tests/r1-support.js';
import { PROTOCOL } from '../host/protocol.js';
import { mutationAllowed, pipelineLockStatus } from './mutation-gate.js';
import {
  g2Decision,
  g2Report,
  g2FreeUsers,
  pollUntil,
  G2_ENV,
  G2_FREE_LIVE,
  G2_PAUSE_PROBE,
  G2_PAUSE_REMOVAL_MS,
  G2_PREVIEW,
  G2_QUEUED,
  G2_STAGING,
  type G2Failure,
  type G2Progress,
} from './g2-guard.js';
import * as L from './g2-load.js';
import * as M from './g2-metrics.js';

const decision = g2Decision();
/** Capacity A1: extra CPU/RAM sampling and, after the drills, the labelled workload rounds */
const A1 = process.env.TBI_G2_A1 === '1';
const INSTANCE = G2_STAGING;
const SECONDS = Number(process.env.TBI_G2_SECONDS ?? 1500);
const LIFETIME_MS = 120_000;
const SEATS = G2_FREE_LIVE + G2_PREVIEW;
const RUN = Date.now().toString(36);
const FETCH_MS = 15_000;
const sudo = (...args: string[]) =>
  spawnSync('sudo', ['-n', ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 28 });
/** the sampler's reads: same argv rules, but without blocking the event loop */
const sudoAsync: L.G2Run = (argv, signal) =>
  new Promise((resolve) => {
    execFile(
      'sudo',
      ['-n', ...argv],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 24, signal },
      (error, stdout) =>
        resolve({
          status: !error ? 0 : typeof error.code === 'number' ? error.code : null,
          stdout,
        }),
    );
  });
const PAUSE_FILE = `${L.G2_STATE_DIR}/${FREE_PAUSE_FILE}`;
const STOP_FILE = join(RUNTIME_HOME, L.G2_STOP_FILE);
/** `test -e`: 0 exists, 1 does not; anything else is unknown and refused. */
const rootExists = (path: string) => {
  const status = sudo('test', '-e', path).status;
  if (status !== 0 && status !== 1) throw new Error('g2-deployed: file check failed');
  return status === 0;
};

const relays: ChildProcess[] = [];
async function relay(socket: string): Promise<string> {
  const port = 5800 + Math.floor(Math.random() * 150);
  // own process group: a Ctrl-C must not kill the relays before the clean-up has used them. The
  // stdin pipe is the tie to this process: when it ends, however we die, the relay exits.
  const child = spawn('sudo', ['-n', process.execPath, '-e', L.g2RelayCode(socket, port)], {
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: true,
  });
  child.stdin!.on('error', () => undefined); // EPIPE when the relay is already gone
  relays.push(child);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('g2-deployed: relay did not start')), 10_000);
    child.stdout!.once('data', () => (clearTimeout(t), resolve()));
  });
  return `http://127.0.0.1:${port}`;
}
async function killRelays() {
  await Promise.all(
    relays.splice(0).map(async (r) => {
      r.stdin!.end();
      if (L.g2Running(r))
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5000);
          r.once('exit', () => (clearTimeout(t), resolve()));
        });
      // only for one that is still running: an exited relay's PID may be someone else's
      if (!L.g2Running(r)) return;
      for (const c of sudo('pgrep', '-P', String(r.pid)).stdout.split(/\s+/).filter(Boolean))
        sudo('kill', c);
    }),
  );
}

/** Set by the running test: its one idempotent clean-up. */
let cleanupRun: (() => Promise<void>) | undefined;
afterAll(async () => {
  await cleanupRun?.();
  await killRelays();
});

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-user': user,
  ...extra,
});
const call = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_MS) });
const json = async (r: Response) => ({
  status: r.status,
  headers: r.headers,
  body: (await r.json().catch(() => ({}))) as Record<string, any>,
});

const gpioCircuit = () => {
  const c = new Circuit().psu(3.3);
  const r = c.add('component.resistor');
  const d = c.add('component.led');
  c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
  return c.pad(2, `${r}.a`);
};
const sketch = (tag: string) =>
  `${readFileSync(new URL('../firmware/arduino/TbiGpioProof/TbiGpioProof.ino', import.meta.url), 'utf8')}\n// g2-deployed ${tag}\n`;

describe('G2 deployed: queue, idle and builds under load on staging', () => {
  let paidDrill: G2Progress['paidDrill'];
  let paidNote = 'not run: the drills did not reach it';
  it.skipIf(decision.kind === 'off')(
    `${G2_ENV}: guard, then the queue, idle and build drills`,
    async () => {
      // Refusal is a FAILURE, never a skip (a green no-op would be a false result).
      if (decision.kind === 'refused') throw new Error(`g2-deployed refused: ${decision.reason}`);
      if (decision.kind !== 'run') return;
      // Belt and braces: the shared gate itself, evaluated again at the point of mutation.
      if (!mutationAllowed(INSTANCE)) throw new Error('g2-deployed refused: mutation gate');
      if (sudo('test', '-f', `/etc/systemd/system/${INSTANCE}-session-host.service`).status !== 0)
        throw new Error(`g2-deployed: ${INSTANCE} is not installed on this host`);

      // ---- run state, clean-up and report (registered before anything is touched)
      const t00 = performance.now();
      const progress: G2Progress = {
        instance: INSTANCE,
        phase: 'preflight',
        seconds: 0,
        admitted: [],
        builds: [],
        promotedPositions: [],
        samples: [],
        metrics: {},
        flags: [],
        failures: [],
      };
      const metrics = progress.metrics!;
      const fail = (f: G2Failure) => void progress.failures!.push(f);
      const abort = new AbortController();
      const checkAbort = () => abort.signal.throwIfAborted();
      /** abortable */
      const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          checkAbort();
          const onAbort = () => (clearTimeout(t), reject(abort.signal.reason));
          const t = setTimeout(() => {
            abort.signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          abort.signal.addEventListener('abort', onAbort, { once: true });
        });
      const clock = { now: () => performance.now(), sleep };

      interface Mine {
        user: string;
        plan: 'free' | 'preview';
        id: string;
        token: string;
        createdMs: number;
        terminalMs?: number;
      }
      // everything we own, registered the moment it exists
      const mine: Mine[] = [];
      const tickets: { user: string; ticket: string }[] = [];
      const openBuilds = new Set<string>();
      const secrets = new Set<string>();
      /** event streams we hold open */
      const streams: AbortController[] = [];
      const inflight = new Set<Promise<unknown>>();
      const track = <T>(p: Promise<T>): Promise<T> => {
        inflight.add(p);
        void p.finally(() => inflight.delete(p)).catch(() => undefined);
        return p;
      };
      let BUILD = '';
      let HOST = '';
      let HEALTH = '';
      let pauseCreated = false;
      let stopped = false;
      const auth = (m: Mine) => as(m.user, { authorization: `Bearer ${m.token}` });
      const health = async () =>
        (await json(await call(`${HEALTH}/health`))).body.capacity as L.G2Capacity;

      // ---- Capacity A1: unprivileged reads only; it never judges or stops the run
      const a1 = A1
        ? M.g2A1Recorder(
            { readFile: (p) => readFile(p, 'utf8'), readdir: (p) => readdir(p) },
            () => performance.now(),
            () => progress.phase,
          )
        : undefined;
      let a1Sampler: ReturnType<typeof L.g2Loop> | undefined;
      /** how the sessions being created are labelled in the A1 report */
      let a1Label: [M.G2A1Type, M.G2A1Round] = ['gpio_proof', 'drills'];

      // ---- G6 sampler
      const watch = L.g2WatchState();
      const sinceEpochS = Math.floor(Date.now() / 1000);
      /** kernel lines are read since the start of the last good sample */
      let kernelSinceS = sinceEpochS;
      let sampler: ReturnType<typeof L.g2Loop> | undefined;
      const stop = (why: L.G2Autostop) => {
        if (abort.signal.aborted) return;
        progress.autostop = why;
        abort.abort(new Error(`autostop:${why}`));
        void cleanup();
      };
      const tick = L.g2Ticker(() => pipelineLockStatus(10_000), sudoAsync);
      const takeSample = async () => {
        // first, so that slow reads cannot delay it
        if (existsSync(STOP_FILE)) return stop('manual');
        let breach: L.G2Autostop | null;
        try {
          const startedS = Math.floor(Date.now() / 1000);
          const r = await tick(kernelSinceS);
          if (!r.sample) metrics.lastSamplerExit = r.exit;
          breach = L.g2Evaluate(watch, r.sample, performance.now());
          if (r.sample) kernelSinceS = startedS;
          breach = L.g2LockBreach(watch, r.lock) ?? breach;
        } catch {
          breach = 'sampler';
        }
        Object.assign(metrics, {
          sampleCount: watch.samples,
          sampleFailures: watch.failures,
          lockUnknown: watch.lockUnknown,
          maxSampleGapMs: Math.round(watch.maxGapMs),
          minMemAvailableMiB: Math.round(watch.minAvailMiB),
          maxLoad1: watch.maxLoad1,
          nproc: watch.nproc,
          maxUnitMemoryRatio: watch.maxUnitRatio,
          maxUnitCurrentRatio: watch.maxUnitCurrentRatio,
          hostPeakBytes: watch.unitPeakBytes[0],
          buildPeakBytes: watch.unitPeakBytes[1],
          oomKills: watch.oomKills,
          kernelOomLines: watch.kernelOom,
          maxQemuUnits: watch.maxQemuUnits,
        });
        if (
          watch.minAvailMiB < L.G2_LIMITS.failAvailMiB &&
          !progress.failures!.includes('mem_below_400')
        )
          fail('mem_below_400');
        if (watch.maxGapMs > L.G2_MAX_GAP_MS && !progress.failures!.includes('sample_gap'))
          fail('sample_gap');
        if (watch.loadFail && !progress.failures!.includes('load_above_2x_cpus'))
          fail('load_above_2x_cpus');
        if (breach) stop(breach);
      };

      // ---- the one clean-up (idempotent; G7 counts), for success, failure, timeout and signals
      let cleaning: Promise<void> | undefined;
      const cleanup = (): Promise<void> => (cleaning ??= doCleanup());
      cleanupRun = cleanup;
      async function doCleanup() {
        stopped = true; // no new admission or build from here on
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise((r) => setTimeout(r, 60_000).unref()),
        ]);
        const drop = async (url: string, headers: Record<string, string>) => {
          try {
            const r = await call(url, { method: 'DELETE', headers });
            return r.ok || r.status === 404;
          } catch {
            return false;
          }
        };
        // tickets first, so a freed seat is not taken by one of our own waiters
        const cancelled = await Promise.all(
          tickets.map((t) =>
            drop(`${HOST}/sessions/queue`, as(t.user, { 'tbi-queue-ticket': t.ticket })),
          ),
        );
        const deleted = await Promise.all(
          mine.map((m) => drop(`${HOST}/sessions/${m.id}`, auth(m))),
        );
        metrics.deleteFailures = [...cancelled, ...deleted].filter((ok) => !ok).length;
        if (metrics.deleteFailures) fail('delete_failed');
        if (pauseCreated) {
          if (sudo('rm', '-f', PAUSE_FILE).status === 0) pauseCreated = false;
          else fail('pause_file_not_removed');
        }
        for (const s of streams) s.abort();
        metrics.unresolvedBuilds = openBuilds.size; // no cancel endpoint: counted only
        if (mine.length || tickets.length) await countLeftovers();
        await sampler?.stop();
        await a1Sampler?.stop();
        if (L.g2SamplerBlind(watch)) fail('sampler_blind');
        await killRelays();
      }
      async function countLeftovers() {
        const ids = mine.map((m) => m.id);
        const deadline = performance.now() + L.G2_DRAIN_CHECK_MS;
        for (;;) {
          let clean = false;
          try {
            const h = await health();
            const units = sudo(...L.G2_QEMU_LIST);
            const dirs = sudo('ls', '-1', L.G2_SESSION_ROOT);
            if (units.status !== 0 || dirs.status !== 0) throw new Error('listing failed');
            const left = L.g2Leftovers(units.stdout, dirs.stdout, ids);
            Object.assign(metrics, {
              leftoverLive: h.live,
              leftoverWaiting: h.waiting,
              leftoverMetered: h.metered,
              leftoverUnits: left.units,
              leftoverDirs: left.dirs,
              otherUnits: left.otherUnits,
              otherDirs: left.otherDirs,
            });
            clean = [h.live, h.waiting, h.metered, left.units, left.dirs].every((n) => n === 0);
          } catch {
            if (performance.now() >= deadline) fail('leftover_check_failed');
          }
          if (clean) break;
          if (performance.now() >= deadline) {
            fail('leftovers');
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        const sim = sudo('cat', L.G2_JOURNAL);
        const host = sudo(
          'journalctl',
          '-u',
          L.G2_HOST_UNIT,
          '--no-pager',
          '-o',
          'cat',
          '--since',
          `@${sinceEpochS}`,
        );
        if (sim.status !== 0 || host.status !== 0) return fail('journal_unreadable');
        const j = L.g2JournalCount(sim.stdout, ids);
        metrics.journalSessions = j.own;
        metrics.journalBad = j.bad;
        metrics.journalUnparsable = j.unparsable;
        if (j.bad || j.unparsable) fail('journal_counts');
        metrics.secretLeaks = L.g2Leaks([sim.stdout, host.stdout], [...secrets]);
        if (metrics.secretLeaks) fail('secret_in_journal');
      }

      let written = false;
      const writeReport = (result: 'PASSED' | 'FAILED') => {
        if (written) return;
        written = true;
        progress.seconds = Math.round((performance.now() - t00) / 1000);
        try {
          progress.a1 = a1?.report();
        } catch {
          console.warn('g2-deployed: the A1 report could not be built'); // keep the run report
        }
        recordEvidence(
          `g2-deployed-${RUN}${result === 'FAILED' ? '-FAILED' : ''}`,
          g2Report(progress, result),
        );
      };
      const bail = async (why: string) => {
        abort.abort(new Error(why));
        await cleanup();
        writeReport('FAILED');
      };
      const onSignal = (signal: NodeJS.Signals) => {
        progress.autostop ??= 'signal';
        void bail('signal').finally(() => process.kill(process.pid, signal));
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      process.once('SIGHUP', onSignal); // a closed terminal or lost ssh session
      // also covers a test timeout, which a finally block would not
      onTestFailed(() => bail('test failed'));

      try {
        // ---- 0. preflight: read-only, refuses an unclean instance
        const shown = sudo('systemctl', 'show', '-p', 'Environment', `${L.G2_HOST_UNIT}.service`);
        const cfgPath = /TBI_HOST_SIM_PLANS_CONFIG=(\/[\w./-]+)/.exec(shown.stdout)?.[1];
        const cfgText = cfgPath ? sudo('cat', cfgPath) : undefined;
        if (cfgText?.status !== 0)
          throw new Error('g2-deployed refused: the sim plans config of the host is not readable');
        if (a1)
          a1.state.config = {
            ...M.g2A1HostConfig(shown.stdout),
            cpus: M.g2A1ProcStat(readFileSync('/proc/stat', 'utf8'))?.cpus ?? null,
          };
        const queue = parseConfig(JSON.parse(cfgText.stdout)).queue;
        const queueProblem = L.g2QueueProblem(queue);
        if (queueProblem) throw new Error(`g2-deployed refused: ${queueProblem}`);
        const identities = L.g2IdentityPlan(queue.maxFree);
        const paidPlan = L.g2PaidPlan(queue, decision.payingUsers.length);
        const paying = paidPlan.reason ? [] : decision.payingUsers.slice(0, paidPlan.needed);
        metrics.queueFullPaidNeeded = paidPlan.needed;
        metrics.queueFullPaidGiven = decision.payingUsers.length;
        if (paidPlan.reason) {
          paidNote = `not run: ${paidPlan.reason}`;
          console.warn(`g2-deployed: queue_full at maxLength ${paidNote}`);
        }

        BUILD = await relay(`/run/${INSTANCE}-build/api.sock`);
        HOST = await relay(`/run/${INSTANCE}-runtime/api.sock`);
        HEALTH = await relay(`/run/${INSTANCE}-runtime/health.sock`);
        const dirty = L.g2Baseline(await health(), rootExists(PAUSE_FILE), existsSync(STOP_FILE));
        if (dirty.length)
          throw new Error(`g2-deployed refused: unclean baseline: ${dirty.join(', ')}`);
        await takeSample();
        checkAbort();
        if (!watch.samples) throw new Error('g2-deployed refused: resource sampling does not work');
        sampler = L.g2Loop(takeSample, L.G2_LIMITS.sampleMs, () => stop('sampler'));
        if (a1) a1Sampler = L.g2Loop(a1.tick, M.G2_A1_SAMPLE_MS, () => undefined);

        const base = g2FreeUsers(RUN);
        const free = Array.from(
          { length: identities.free },
          (_, i) => base[i] ?? `g2d-${RUN}-f${i}`,
        );
        const preview = decision.previewUsers;
        const everyone = [...free, ...preview, ...paying];
        for (const u of everyone) secrets.add(u);

        // ---- 1. builds
        progress.phase = 'builds';
        const submitBuild = async (user: string, text: string) => {
          if (stopped) throw new Error('stopped');
          checkAbort();
          const s = await json(
            await call(`${BUILD}/v1/builds`, {
              method: 'POST',
              headers: as(user, { 'content-type': 'application/json' }),
              body: JSON.stringify({
                protocol: 'tbi-lab.build/1',
                profile: 'esp32-arduino-3.3.12',
                files: [{ name: 'sketch.ino', text }],
              }),
            }),
          );
          if (s.body.token) {
            secrets.add(s.body.token);
            openBuilds.add(s.body.buildId);
          }
          return s;
        };
        const buildFor = async (user: string, text: string, listed = true) => {
          const t0 = performance.now();
          const s = await track(submitBuild(user, text));
          let sha: string | undefined = s.body.build?.artifact?.sha256;
          let state: string | undefined = s.status === 200 && sha ? 'succeeded' : undefined;
          let failure: string | undefined;
          while (s.status === 202 && performance.now() - t0 <= L.G2_BUILD_CAP_MS) {
            checkAbort();
            // a slow or failed status read is not an answer: poll again until the cap
            const st = await call(`${BUILD}/v1/builds/${s.body.buildId}`, {
              headers: as(user, { authorization: `Bearer ${s.body.token}` }),
            })
              .then(json)
              .catch(() => undefined);
            state = st?.body.state;
            if (state === 'succeeded' || state === 'failed') {
              sha = st!.body.result?.artifact?.sha256;
              failure = st!.body.result?.failure;
              openBuilds.delete(s.body.buildId);
              break;
            }
            await sleep(1000);
          }
          const ms = Math.round(performance.now() - t0);
          if (listed) progress.builds.push({ status: s.status, ms });
          const outcome = L.g2BuildOutcome({
            http: s.status,
            error: s.body.error,
            state,
            failure,
            ms,
          });
          return { status: s.status, sha, ms, outcome };
        };
        const buildsDeadline = performance.now() + L.G2_BUDGET_S.builds * 1000;
        const unique = await Promise.all([
          buildFor(everyone[0]!, sketch(`${RUN}-a`)),
          buildFor(everyone[1]!, sketch(`${RUN}-b`)),
        ]);
        const shaOf = new Map<string, string>();
        for (const [i, b] of unique.entries()) {
          expect(b.sha, `unique build ${i} (status ${b.status}) must succeed`).toBeTruthy();
          shaOf.set(everyone[i]!, b.sha!);
        }
        for (const [i, u] of everyone.slice(2).entries()) {
          expect(performance.now(), 'build phase budget').toBeLessThan(buildsDeadline);
          const b = await buildFor(u, sketch(`${RUN}-a`));
          expect(b.sha, `build ${i + 2} (status ${b.status}) must succeed`).toBeTruthy();
          shaOf.set(u, b.sha!);
        }

        // ---- session helpers
        const starts = new Map<string, number[]>();
        const createNow = async (user: string, ticket: string | undefined, lifetimeMs: number) => {
          const sha = shaOf.get(user)!;
          const l = await json(
            await call(`${BUILD}/v1/artifacts/${sha}/lease`, { method: 'POST', headers: as(user) }),
          );
          secrets.add(l.body.ticket ?? '');
          const req = gpioCircuit().request(sha);
          if (stopped) throw new Error('stopped');
          checkAbort();
          let r;
          try {
            r = await json(
              await call(`${HOST}/sessions`, {
                method: 'POST',
                headers: as(user, {
                  'content-type': 'application/json',
                  'tbi-queue': '1',
                  ...(ticket ? { 'tbi-queue-ticket': ticket } : {}),
                }),
                body: JSON.stringify({
                  ...req,
                  protocol: PROTOCOL,
                  artifact: { sha256: sha },
                  ticket: l.body.ticket,
                  limits: { maxLifetimeMs: lifetimeMs },
                }),
              }),
            );
          } catch (e) {
            metrics.unconfirmedCreates = (metrics.unconfirmedCreates ?? 0) + 1;
            throw e;
          }
          if (r.status === 202 && !ticket) {
            tickets.push({ user, ticket: r.body.queued.ticket });
            secrets.add(r.body.queued.ticket);
          }
          if (r.status === 201) {
            const m: Mine = {
              user,
              plan: preview.includes(user) ? 'preview' : 'free',
              id: r.body.sessionId,
              token: r.body.token,
              createdMs: performance.now(),
            };
            mine.push(m);
            secrets.add(m.token);
            const run = await call(`${HOST}/sessions/${m.id}/run`, {
              method: 'POST',
              headers: auth(m),
            });
            expect(run.ok, `run answered ${run.status}`).toBe(true);
            a1?.addRun(m.id, ...a1Label);
          }
          return r;
        };
        const create = (user: string, ticket?: string, lifetimeMs = LIFETIME_MS) => {
          if (!ticket) {
            const h = starts.get(user) ?? [];
            if (!L.g2MayStart(h, performance.now()))
              throw new Error('g2-deployed refused: per-user start rate would be exceeded');
            starts.set(user, [...h, performance.now()]);
          }
          return track(createNow(user, ticket, lifetimeMs));
        };
        const cancel = async (user: string, ticket: string) =>
          (
            await call(`${HOST}/sessions/queue`, {
              method: 'DELETE',
              headers: as(user, { 'tbi-queue-ticket': ticket }),
            })
          ).status;
        const statusOf = async (m: Mine) =>
          (await json(await call(`${HOST}/sessions/${m.id}`, { headers: auth(m) }))).body;
        const stateOf = async (m: Mine) => (await statusOf(m)).state as string;
        const isEnded = (s: string) => s === 'ended' || s === 'failed';
        /** One pass: own live Free count and host live; throws on a breach (explicit failure). */
        const { samples, admitted } = progress;
        const sample = async () => {
          let freeLive = 0;
          for (const m of mine) {
            if (m.terminalMs !== undefined) continue;
            const s = await stateOf(m);
            if (isEnded(s)) m.terminalMs = performance.now();
            else if (m.plan === 'free') freeLive++;
          }
          const hostLive = (await health()).live;
          samples.push({ freeLive, hostLive });
          expect(freeLive, 'Free live sessions must never exceed 4').toBeLessThanOrEqual(
            G2_FREE_LIVE,
          );
          expect(hostLive, 'host live sessions must never exceed 6').toBeLessThanOrEqual(
            G2_FREE_LIVE + G2_PREVIEW,
          );
        };

        // ---- 2. admission
        progress.phase = 'admission';
        for (const u of [...free.slice(0, G2_FREE_LIVE), ...preview]) {
          admitted.push((await create(u)).status);
          if (admitted.length === 1 && mine[0]) {
            metrics.idleMs = Number((await statusOf(mine[0])).idleMs);
            expect(metrics.idleMs, 'session status idleMs (host idle limit)').toBe(L.G2_IDLE_MS);
          }
        }
        expect(admitted).toEqual(Array(G2_FREE_LIVE + G2_PREVIEW).fill(201));
        const queuedUsers = free.slice(G2_FREE_LIVE, G2_FREE_LIVE + G2_QUEUED);
        interface Waiter {
          user: string;
          ticket: string;
          pollAfterS: number;
          position: number;
          done?: { status: number; atMs: number; error?: unknown };
        }
        let waiters: Waiter[] = [];
        // joined waiters are polled while the harness does other things, or they vanish
        const line = L.g2WaitingLine<{ user: string; ticket: string }>(
          async (w) => (await create(w.user, w.ticket, L.G2_HOLD_LIFETIME_MS)).status,
          () => performance.now(),
        );
        const enqueue = async (users: string[]) => {
          const out: Waiter[] = [];
          for (const [i, user] of users.entries()) {
            const r = await create(user);
            expect(r.status, `queue join ${i}: ${r.body.error}`).toBe(202);
            const q = r.body.queued as { ticket: string; position: number; pollAfterS: number };
            expect(q.position).toBe(i + 1);
            expect(r.body.error).not.toBe('runtime_capacity');
            const w = { user, ticket: q.ticket, pollAfterS: q.pollAfterS, position: q.position };
            out.push(w);
            line.add(w);
            await line.keep();
          }
          return out;
        };
        const firstJoinAt = performance.now();
        waiters = await enqueue(queuedUsers);
        await sample();
        await line.keep();
        expect((await health()).waiting).toBe(G2_QUEUED);

        // ---- 3. cancel
        progress.phase = 'cancel';
        const last = waiters.pop()!;
        line.remove(last);
        expect(await cancel(last.user, last.ticket)).toBe(204);
        expect((await health()).waiting).toBe(G2_QUEUED - 1);

        // ---- 4. pause drill
        progress.phase = 'pause';
        // last sign of life of every waiter: no polls from here on, so only the pause can remove them
        await line.keep(0);
        const aliveSince = line.oldestSeenAt();
        line.clear();
        const tPause = performance.now();
        checkAbort();
        expect(rootExists(PAUSE_FILE), 'pause file made by someone else').toBe(false);
        pauseCreated = true;
        expect(sudo('touch', PAUSE_FILE).status).toBe(0);
        let pausedAnswer = 0;
        while (performance.now() - tPause < 5000 && pausedAnswer !== 429) {
          pausedAnswer = (await create(free[G2_PAUSE_PROBE]!)).status;
          if (pausedAnswer !== 429) await sleep(500);
        }
        expect(pausedAnswer, 'free_paused (429) within 5 s').toBe(429);
        const refusal = await create(free[G2_PAUSE_PROBE]!);
        expect(refusal.body.error).toBe('free_paused');
        // after vanishMs without a poll a waiter leaves anyway, which would prove nothing
        const removed = await pollUntil(
          async () => (await health()).waiting,
          (w) => w === 0,
          Math.min(tPause + G2_PAUSE_REMOVAL_MS, aliveSince + queue.vanishMs),
          clock,
        );
        expect(
          removed.ok,
          `waiting Free removed by the pause: waiting=${removed.value}, ${Math.round(removed.atMs - tPause)} ms after the pause, ${Math.round(removed.atMs - firstJoinAt)} ms after the first join, ${Math.round(removed.atMs - aliveSince)} ms after the oldest poll`,
        ).toBe(true);
        // a waiter that merely vanished answers queue_timeout: only the pause answers free_paused
        const dropped = await create(waiters[0]!.user, waiters[0]!.ticket);
        expect([dropped.status, dropped.body.error], 'removed ticket poll').toEqual([
          429,
          'free_paused',
        ]);
        await sample(); // running Free and preview sessions are untouched (still counted, none ended)
        expect(
          mine.filter((m) => m.terminalMs !== undefined && performance.now() - m.createdMs < 60_000)
            .length,
          'sessions ended early during the pause',
        ).toBe(0);
        expect(sudo('rm', '-f', PAUSE_FILE).status).toBe(0);
        pauseCreated = false;
        const back = await create(free[G2_PAUSE_PROBE]!);
        expect([201, 202], `admission after removal: ${back.body.error}`).toContain(back.status);
        if (back.status === 202) await cancel(free[G2_PAUSE_PROBE]!, back.body.queued.ticket);
        // the waiters the pause removed queue again (their old tickets keep answering free_paused)
        waiters = await enqueue(waiters.map((w) => w.user));
        await line.keep(0);
        line.clear(); // from here each waiter has its own poller

        // ---- 5. drain: poll every pollAfterS; seats free themselves at the 120 s lifetime
        progress.phase = 'drain';
        const promoted: { user: string; atMs: number; position: number }[] = [];
        const deadline = performance.now() + SECONDS * 1000;
        const poller = async (w: Waiter) => {
          while (performance.now() < deadline && !w.done) {
            await sleep(w.pollAfterS * 1000);
            const r = await create(w.user, w.ticket);
            if (r.status === 202) continue;
            w.done = { status: r.status, atMs: performance.now(), error: r.body.error };
            if (r.status === 201) {
              promoted.push({ user: w.user, atMs: w.done.atMs, position: w.position });
              progress.promotedPositions.push(w.position);
            }
          }
        };
        const pollers = Promise.all(waiters.map(poller));
        pollers.catch((e) => abort.abort(e));
        while (performance.now() < deadline && waiters.some((w) => !w.done)) {
          await sample();
          await sleep(1000);
        }
        await pollers;
        expect(
          waiters
            .filter((w) => w.done?.status !== 201)
            .map((w) => [w.position, w.done?.status, w.done?.error]),
          'every waiter promoted',
        ).toEqual([]);
        // FIFO: promotions arrive in queue position order within one poll round of each other
        const positions = promoted.sort((a, b) => a.atMs - b.atMs).map((p) => p.position);
        const inversions = positions.filter((p, i) => i > 0 && p < positions[i - 1]! - 0).length;
        expect(inversions, `promotion order ${positions.join(',')} must be FIFO`).toBe(0);
        // head promotion gap: first seat freed -> first 201, <= pollAfterS + 30 s
        const firstFree = Math.min(
          ...mine.filter((m) => m.terminalMs !== undefined).map((m) => m.terminalMs!),
        );
        const gapS = (promoted[0]!.atMs - firstFree) / 1000;
        expect(gapS, 'head of the queue promoted within pollAfterS + 30 s').toBeLessThanOrEqual(
          waiters[0]!.pollAfterS + 30,
        );

        metrics.headPromotionGapS = gapS;

        // free every seat, then wait out the Free re-queue cooldown
        progress.phase = 'cooldown';
        for (const m of mine)
          await call(`${HOST}/sessions/${m.id}`, { method: 'DELETE', headers: auth(m) });
        const emptied = await pollUntil(
          health,
          (h) => h.live === 0 && h.waiting === 0,
          performance.now() + L.G2_DRAIN_CHECK_MS,
          clock,
        );
        expect(emptied.ok, 'no live or waiting after the drain').toBe(true);
        await sleep(queue.freeCooldownMs + 5000);

        // ---- 6. idle (G3)
        progress.phase = 'idle';
        const held = new Set<Mine>();
        const seat = async (user: string) => {
          const r = await create(user, undefined, L.G2_HOLD_LIFETIME_MS);
          expect(r.status, `held session: ${r.body.error}`).toBe(201);
          return mine.at(-1)!;
        };
        /** attach and keep the session's event stream; only the connect is bounded */
        const openStream = async (m: Mine) => {
          const own = new AbortController();
          streams.push(own);
          const connect = setTimeout(() => own.abort(), FETCH_MS);
          try {
            const r = await fetch(`${HOST}/sessions/${m.id}/events`, {
              headers: auth(m),
              signal: AbortSignal.any([own.signal, abort.signal]),
            });
            expect(r.status, 'event stream').toBe(200);
            return L.g2FollowStream(r.body!, () => performance.now());
          } finally {
            clearTimeout(connect);
          }
        };
        const subject = await seat(free[0]!);
        const subjectRunAt = performance.now(); // `run` was just answered
        const silentTab = await openStream(subject);
        for (const u of [...free.slice(1, G2_FREE_LIVE), ...preview]) held.add(await seat(u));
        const presentTab = await openStream([...held][0]!);
        const presentTabAt = performance.now();
        // keeps the held sessions alive: status reads renew the lease, presence resets the idle clock
        let keep = true;
        const keeper = (async () => {
          const last = new Map<Mine, number>();
          while (keep) {
            for (const m of [...held]) {
              if (isEnded(await stateOf(m))) {
                held.delete(m);
                metrics.heldEndedEarly = (metrics.heldEndedEarly ?? 0) + 1;
                fail('held_session_ended');
                continue;
              }
              if (performance.now() - (last.get(m) ?? m.createdMs) < L.G2_PRESENCE_MS) continue;
              const p = await call(`${HOST}/sessions/${m.id}/presence`, {
                method: 'POST',
                headers: auth(m),
              });
              expect(p.status, 'presence').toBe(204);
              last.set(m, performance.now());
            }
            await sleep(3000);
          }
        })();
        keeper.catch((e) => abort.abort(e));

        /** join the queue (202), then poll every pollAfterS until another answer or the deadline */
        const join = async (user: string) => {
          const r = await create(user, undefined, L.G2_HOLD_LIFETIME_MS);
          expect(r.status, `queue join: ${r.body.error}`).toBe(202);
          return r.body.queued as { ticket: string; pollAfterS: number };
        };
        const waitAnswer = async (
          user: string,
          q: { ticket: string; pollAfterS: number },
          deadlineAt: number,
        ) => {
          while (performance.now() < deadlineAt) {
            await sleep(Math.min(q.pollAfterS * 1000, deadlineAt - performance.now()));
            const r = await create(user, q.ticket, L.G2_HOLD_LIFETIME_MS);
            if (r.status !== 202)
              return { status: r.status, error: r.body.error as string, atMs: performance.now() };
          }
          return { status: 202, error: 'no answer', atMs: performance.now() };
        };

        const idleUser = free[G2_FREE_LIVE]!;
        const idleQ = await join(idleUser);
        const idleDeadline = subjectRunAt + L.G2_IDLE_MS + 60_000;
        const promotion = waitAnswer(idleUser, idleQ, idleDeadline);
        promotion.catch((e) => abort.abort(e));
        let status = await statusOf(subject);
        while (status.state === 'running' && performance.now() < idleDeadline) {
          const early = subjectRunAt + L.G2_IDLE_MS - 10_000 - performance.now();
          await sleep(early > 0 ? Math.min(early, 5000) : 500);
          status = await statusOf(subject);
        }
        const idleEndAt = performance.now();
        metrics.idleEndMs = Math.round(idleEndAt - subjectRunAt);
        const settled = await pollUntil(
          () => statusOf(subject),
          (x) => isEnded(x.state),
          performance.now() + FETCH_MS,
          clock,
        );
        expect(settled.value.reason, 'end reason of the silent session').toBe('idle_timeout');
        await Promise.race([silentTab.done, sleep(FETCH_MS)]);
        metrics.idleStreamEnded = L.g2IdleStreamOk(silentTab.state) ? 1 : 0;
        expect(
          metrics.idleStreamEnded,
          'idle_timeout delivered on the open event stream ' +
            `(stream closedAtMs ${silentTab.state.closedAtMs}, idle end at ${idleEndAt})`,
        ).toBe(1);
        expect(L.g2IdleOnTime(metrics.idleEndMs), `idle end after ${metrics.idleEndMs} ms`).toBe(
          true,
        );
        const promotedIdle = await promotion;
        expect(promotedIdle.status, `seat passes to the queue: ${promotedIdle.error}`).toBe(201);
        metrics.idlePromotionMs = Math.round(promotedIdle.atMs - idleEndAt);
        expect(metrics.idlePromotionMs).toBeLessThanOrEqual(idleQ.pollAfterS * 1000 + 30_000);
        held.add([...mine].reverse().find((m) => m.user === idleUser)!);
        const seatsFull = async () => {
          expect((await health()).live, 'host live sessions').toBe(SEATS);
          expect(held.size, 'held sessions').toBe(SEATS);
        };
        await seatsFull(); // presence kept the other sessions alive past the idle limit

        // ---- 7. queue_full (G5), Free share
        progress.phase = 'queue-full';
        if (!identities.queueFull) fail('queue_full_refused');
        else {
          const joinQueue = async (user: string) => {
            const r = await create(user, undefined, L.G2_HOLD_LIFETIME_MS);
            return { status: r.status, error: r.body.error, ticket: r.body.queued?.ticket };
          };
          const keepWaiting = async (w: { user: string; ticket: string }) => {
            line.add(w);
            await line.keep();
          };
          const { accepted: fillers, refused: refusedWith } = await L.g2FillQueue(
            free.slice(G2_FREE_LIVE + 1),
            joinQueue,
            keepWaiting,
          );
          metrics.queueFullAccepted = fillers.length;
          metrics.queueFullStatus = refusedWith?.status ?? 0;
          expect([refusedWith?.status, refusedWith?.error]).toEqual([429, 'queue_full']);
          expect(fillers.length).toBe(queue.maxFree);
          await line.keep();
          expect((await health()).waiting).toBe(queue.maxFree);
          if (paying.length) {
            progress.paidDrill = paidDrill = 'started';
            paidNote = 'not passed: see the drills test';
            const paid = await L.g2FillQueue(paying, joinQueue, keepWaiting);
            metrics.queueFullPaidAccepted = paid.accepted.length;
            metrics.queueFullPaidStatus = paid.refused?.status ?? 0;
            fillers.push(...paid.accepted);
            expect([paid.refused?.status, paid.refused?.error]).toEqual([429, 'queue_full']);
            expect(paid.accepted.length).toBe(queue.maxLength - queue.maxFree);
            await line.keep();
            expect((await health()).waiting).toBe(queue.maxLength);
            progress.paidDrill = paidDrill = 'passed';
          }
          for (const f of fillers) {
            line.remove(f);
            expect(await cancel(f.user, f.ticket)).toBe(204);
            await line.keep();
          }
          expect((await health()).waiting).toBe(0);
        }

        // ---- 8. abandon (G5)
        progress.phase = 'abandon';
        const gone = free[G2_FREE_LIVE + 1]!;
        const goneQ = await join(gone);
        const joinedAt = performance.now();
        expect((await health()).waiting).toBe(1);
        const left = await pollUntil(
          async () => (await health()).waiting,
          (w) => w === 0,
          joinedAt + queue.vanishMs + DEFAULT_SIM_HOUSEKEEPING_MS + 10_000,
          clock,
        );
        metrics.abandonMs = Math.round(left.atMs - joinedAt);
        expect(left.ok, `abandoned waiter still queued after ${metrics.abandonMs} ms`).toBe(true);
        expect(metrics.abandonMs, 'left before vanishMs').toBeGreaterThanOrEqual(
          queue.vanishMs - 2000,
        );
        const late = await create(gone, goneQ.ticket);
        expect([late.status, late.body.error]).toEqual([429, 'queue_timeout']);

        // ---- 9. two builds with 6 live (G4) while one waiter runs into queue_timeout (G5)
        progress.phase = 'builds-under-load';
        await seatsFull();
        const patient = free[G2_FREE_LIVE + 2]!;
        const patientAt = performance.now();
        const patientQ = await join(patient);
        let building = true;
        let minLive = SEATS;
        const builds = Promise.all(
          ['c', 'd'].map((tag, i) => buildFor(free[i + 1]!, sketch(`${RUN}-g4${tag}`))),
        ).finally(() => (building = false));
        const watchLive = (async () => {
          while (building) {
            const { live } = await health();
            if (building) minLive = Math.min(minLive, live);
            await sleep(1000);
          }
        })();
        const [done, timedOut] = await Promise.all([
          builds,
          waitAnswer(
            patient,
            patientQ,
            patientAt + queue.maxWaitMs + 2 * patientQ.pollAfterS * 1000 + 30_000,
          ),
          watchLive,
        ]);
        const g4 = L.g2BuildSummary(done);
        Object.assign(metrics, {
          ...g4.metrics,
          minLiveDuringBuilds: minLive,
          queueTimeoutMs: Math.round(timedOut.atMs - patientAt),
          queueTimeoutStatus: timedOut.status,
        });
        if (g4.dec32) progress.flags!.push('dec32');
        if (g4.failed) fail('build_lost_or_failed');
        if (minLive < SEATS) fail('builds_not_under_6_live');
        expect(
          L.g2TimeoutOk(
            { status: timedOut.status, error: timedOut.error, ms: metrics.queueTimeoutMs! },
            queue.maxWaitMs,
            patientQ.pollAfterS,
          ),
          `queue_timeout: ${timedOut.status} ${timedOut.error} after ${metrics.queueTimeoutMs} ms`,
        ).toBe(true);
        const heldAt = performance.now();
        metrics.heldStreamOpenMs = Math.round(heldAt - presentTabAt);
        const { lastChunkAtMs, closedAtMs } = presentTab.state;
        metrics.heldStreamOk = L.g2HeldStreamOk(presentTab.state, metrics.heldStreamOpenMs, heldAt)
          ? 1
          : 0;
        expect(
          metrics.heldStreamOk === 1,
          `present session's event stream still open after ${metrics.heldStreamOpenMs} ms ` +
            `(last chunk at ${lastChunkAtMs}, closed at ${closedAtMs}, checked at ${heldAt})`,
        ).toBe(true);
        keep = false;
        await keeper;

        // ---- A1 rounds, only after every drill: labelled workloads on otherwise empty seats
        const measure = async (rec: NonNullable<typeof a1>) => {
          const users = [...free.slice(0, G2_FREE_LIVE), ...preview];
          const emptySeats = async () => {
            for (const m of mine)
              await call(`${HOST}/sessions/${m.id}`, { method: 'DELETE', headers: auth(m) });
            const empty = await pollUntil(
              health,
              (h) => h.live === 0 && h.waiting === 0,
              performance.now() + L.G2_DRAIN_CHECK_MS,
              clock,
            );
            expect(empty.ok, 'A1: seats not empty').toBe(true);
          };
          progress.phase = 'a1-cooldown';
          await emptySeats();
          progress.phase = 'a1-builds';
          const shas = new Map<string, string>();
          const buildsFrom = performance.now();
          for (const { runs } of M.G2_A1_ROUNDS)
            for (const [i, type] of runs) {
              if (shas.has(`${i} ${type}`)) continue;
              const text = `${M.G2_A1_SKETCHES[type]}// g2-a1 ${RUN}\n`;
              expect(performance.now() - buildsFrom, 'A1 build budget').toBeLessThan(
                M.G2_A1_BUILD_START_MS,
              );
              const b = await buildFor(users[i]!, text, false);
              expect(b.sha, `A1 build ${type} (status ${b.status})`).toBeTruthy();
              shas.set(`${i} ${type}`, b.sha!);
            }
          for (const { round, phase, runs } of M.G2_A1_ROUNDS) {
            progress.phase = 'a1-cooldown';
            await emptySeats();
            await sleep(queue.freeCooldownMs + 5000);
            progress.phase = phase;
            const started: Mine[] = [];
            for (const [i, type] of runs) {
              shaOf.set(users[i]!, shas.get(`${i} ${type}`)!);
              a1Label = [type, round];
              const r = await create(users[i]!);
              expect(r.status, `A1 session: ${r.body.error}`).toBe(201);
              started.push(mine.at(-1)!);
            }
            // status reads renew the lease; each session ends at its own lifetime
            const until = performance.now() + LIFETIME_MS + FETCH_MS;
            const open = new Set(started);
            while (open.size && performance.now() < until) {
              for (const m of open) {
                const s = await statusOf(m);
                const ended = isEnded(s.state);
                rec.pace(m.id, {
                  simPerWall: s.pace?.simPerWall ?? null,
                  tickGapP99Ms: s.pace?.tickGapMs?.p99 ?? null,
                  endReason: ended ? (s.reason ?? null) : null,
                });
                if (ended) open.delete(m);
              }
              await sleep(5000);
            }
            expect(open.size, 'A1 sessions still live after their lifetime').toBe(0);
          }
        };
        if (a1) {
          a1.state.failuresBefore = [...progress.failures!];
          a1.state.status = 'incomplete';
          try {
            await measure(a1);
            a1.state.status = 'complete';
          } catch (e) {
            checkAbort(); // an auto-stop still fails the run
            // a measurement that could not finish is reported, and does not judge the drills
            console.warn(`g2-deployed: A1 incomplete: ${(e as Error).message}`);
          }
        }

        // ---- 10. clean-up and G7 counts
        progress.phase = 'clean-up';
        await cleanup();
        checkAbort();
        expect(progress.failures, 'run criteria').toEqual([]);
        writeReport('PASSED');
      } catch (e) {
        // an auto-stop is the cause, whatever call it interrupted
        throw abort.signal.aborted ? abort.signal.reason : e;
      } finally {
        abort.abort(new Error('run over'));
        await cleanup();
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGHUP', onSignal);
      }
    },
    L.g2TimeoutMs(decision.kind === 'run' ? SECONDS : 0) + (A1 ? M.G2_A1_BUDGET_S * 1000 : 0),
  );

  // After the drills above (same file, in order): passed only if they ran and passed this one.
  it('queue_full at maxLength with paid waiters', ({ skip }) => {
    if (paidDrill !== 'passed') skip(paidNote);
  });
});
