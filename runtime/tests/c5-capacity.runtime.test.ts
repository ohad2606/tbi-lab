/**
 * C-5 capacity harness (Sprint 12, S12-11; SPRINT-12-ARCHITECTURE §8): N concurrent live ESP32
 * sessions, each paced at real time (D-10), each driving a workload through the Session Host and
 * real QEMU, measured every second:
 *   - per-session simulation rate (x real time over each 1 s window; p5 and minimum);
 *   - tick wall-gap p99 and maximum (the Session Host's own statistics);
 *   - host CPU busy/steal (/proc/stat), load average, QEMU RSS;
 *   - session failures and diagnostics.
 * The pass criteria (PM D-2, ratified for the POC host 2026-10-11, docs/runtime/
 * RUNTIME-V2-LIMITATIONS.md): every session's p5 simulation rate >= 0.995x over 5 s wall-clock
 * windows, tick-gap p99 <= 100 ms, no failures. The 1 s window statistics are reported for
 * information only (a session paced at exactly 1.0x scatters about +-1 % over 1 s windows). Measurement only: it never changes a deployed instance
 * (an in-process Session Host with its own temporary root; no service, policy or unit is
 * touched). The first 30 s of each session (ROM and boot, slower than real time in QEMU,
 * V1-ARCHITECTURE §7.8) are excluded from the rate statistics and reported separately.
 *
 * Opt-in (skipped unless TBI_C5 is set), parameters from the environment:
 *   TBI_C5=1 TBI_C5_N=3 TBI_C5_SECONDS=120 TBI_C5_WORKLOAD=mix [TBI_C5_PACE=off] \
 *     npx vitest run --config vitest.runtime.config.ts runtime/tests/c5-capacity.runtime.test.ts
 *   workloads: sonar (HC-SR04 at 10 Hz), dht (DHT22 every 2.5 s), lcd (I2C LCD), gpio
 *   (TbiGpioProof), mix (sonar, dht, gpio, lcd, gpio in turn)
 *
 * Sprint 13 (H5, five-session alpha capacity), optional:
 *   TBI_C5_BUILDS=k          k simultaneous REAL builds (distinct users and sketches) submitted
 *                            10 s after the warm-up, to an in-process build service with the
 *                            alpha policy's queue (10) and TBI_C5_BUILD_WORKERS workers (default
 *                            2); every build must succeed and the worst user's completion is
 *                            reported against the 120 s target. Builds defer while live sessions
 *                            >= TBI_C5_BUILD_DEFER (default: the CPU count, as the policy).
 *   TBI_C5_BUILD_EVERY=s     repeat the build burst every s seconds (soak).
 *   TBI_C5_FAULTS=1          20 s after the warm-up session 0 is stopped and re-created; 40 s
 *                            after, session 1's QEMU is killed (SIGKILL) and the session re-created.
 *                            Checked: the stopped and crashed runtimes are gone, the other sessions
 *                            keep their pace; faulted sessions are excluded from the rate criteria.
 * Every report records the host configuration (CPUs, model, memory, kernel, runtime id, commit).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { Grants } from '../builder/grants.js';
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import { RUNTIME_HOME } from '../harness/env.js';
import { principalFor } from '../identity/test-gate.js';
import { Policy } from '../policy/policy.js';
import { RateLimiter } from '../policy/rate.js';
import { openPolicyConfig } from '../policy/testing.js';
import { TEST_TICKET_KEY } from '../identity/test-gate.js';
import profileRecord from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import { artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import type { HostSession } from '../host/session.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';

const N = Number(process.env.TBI_C5_N ?? 1);
const SECONDS = Number(process.env.TBI_C5_SECONDS ?? 120);
const WORKLOAD = process.env.TBI_C5_WORKLOAD ?? 'mix';
const PACE = process.env.TBI_C5_PACE === 'off' ? null : 1;
const WARMUP_S = 30;
const BUILDS = Number(process.env.TBI_C5_BUILDS ?? 0);
const BUILD_WORKERS = Number(process.env.TBI_C5_BUILD_WORKERS ?? 2);
const BUILD_EVERY_S = Number(process.env.TBI_C5_BUILD_EVERY ?? 0);
const BUILD_DEFER = process.env.TBI_C5_BUILD_DEFER;
const FAULTS = process.env.TBI_C5_FAULTS === '1';
const BUILD_SKETCHES = ['TbiHcSr04', 'TbiDht22', 'TbiLcd', 'TbiGpioProof', 'TbiBanks'];

/** The exact host this ran on (evidence). */
function hostConfig() {
  const sh = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    cpus: availableParallelism(),
    model: /Model name:\s*(.*)/.exec(sh('lscpu', []) ?? '')?.[1]?.trim() ?? null,
    memTotalMb: Math.round(totalmem() / 2 ** 20),
    kernel: sh('uname', ['-r']),
    commit: sh('git', ['rev-parse', 'HEAD']),
    runtimeId: runtimeInfo().runtimeId,
  };
}

/** An in-process build service with the real toolchain and the alpha policy's build limits. */
function buildService(live: () => number) {
  const store = mkdtempSync(join('/var/tmp', 'c5-store-'));
  const work = mkdtempSync(join('/var/tmp', 'c5-work-'));
  const grants = new Grants(':memory:');
  const c = openPolicyConfig();
  c.global.build.maxQueued = 10;
  c.global.build.maxActive = BUILD_WORKERS;
  c.global.build.deferWhileLiveSessionsAtLeast = BUILD_DEFER ? Number(BUILD_DEFER) : 'cpus';
  const service = new BuildService(
    [
      new ArduinoEsp32Provider({
        profile: ESP32_ARDUINO_PROFILE,
        record: profileRecord as ArduinoProfileRecord,
        home: join(RUNTIME_HOME, 'arduino'),
        retainedOutputBytes: 256 * 1024,
      }),
    ],
    new ArtifactStore({
      dir: store,
      capBytes: 512 * 1024 * 1024,
      graceMs: 0,
      onEvicted: (x) => grants.dropArtifact(x),
    }),
    work,
    DEFAULT_LIMITS,
    {
      grants,
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      policy: new Policy(c),
      rates: new RateLimiter(':memory:'),
      liveSessions: live,
    },
  );
  return {
    service,
    cleanup: () => {
      service.close();
      rmSync(store, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}
const alive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Build = () => {
  c: Circuit;
  fw: string;
  id: string;
  poke?: (s: HostSession, t: number) => void;
};

const workloads: Record<string, Build> = {
  sonar: () => {
    const c = new Circuit().psu(5);
    const u = c.add('sensor.hc_sr04');
    const r1 = c.add('component.resistor');
    const r2 = c.add('component.resistor');
    c.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref').pad(5, `${u}.trig`);
    c.ohms(r1, 1000).ohms(r2, 2000);
    c.wire(`${u}.echo`, `${r1}.a`).wire(`${r1}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    c.pad(18, `${r1}.b`);
    return { c, fw: 'TbiHcSr04', id: u };
  },
  dht: () => {
    const c = new Circuit().psu(3.3);
    const u = c.add('sensor.dht22');
    const r = c.add('component.resistor');
    c.wire('PSU1.positive', `${u}.vdd`).wire(`${u}.gnd`, 'GND1.ref');
    c.ohms(r, 10_000).wire(`${r}.a`, 'PSU1.positive').wire(`${r}.b`, `${u}.data`);
    c.pad(4, `${u}.data`);
    return { c, fw: 'TbiDht22', id: u };
  },
  lcd: () => {
    const c = new Circuit().psu(4.5);
    const lcd = c.add('display.lcd1602_i2c');
    const p2 = c.add('instrument.lab_psu');
    c.set(p2, 'setpointVoltage', { value: 3.3, unit: 'volt' }).set(p2, 'outputEnabled', true);
    c.wire(`${p2}.negative`, 'GND1.ref').wire('PSU1.positive', `${lcd}.vcc`);
    c.wire(`${lcd}.gnd`, 'GND1.ref');
    for (const [line, gpio] of [
      ['sda', 21],
      ['scl', 22],
    ] as const) {
      const r = c.add('component.resistor');
      c.ohms(r, 4700).wire(`${r}.a`, `${p2}.positive`).wire(`${r}.b`, `${lcd}.${line}`);
      c.pad(gpio, `${lcd}.${line}`);
    }
    return { c, fw: 'TbiLcd', id: lcd };
  },
  gpio: () => {
    const c = new Circuit().psu(3.3);
    const r = c.add('component.resistor');
    const d = c.add('component.led');
    c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(2, `${r}.a`);
    return { c, fw: 'TbiGpioProof', id: d };
  },
};
const MIX = ['sonar', 'dht', 'gpio', 'lcd', 'gpio'];

function cpu(): { busy: number; total: number; steal: number } {
  const f = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.split(/\s+/).slice(1).map(Number);
  const [, , , idle, iowait, , , steal] = f as number[];
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - idle! - iowait!, total, steal: steal! };
}
const rss = (pid: number | null) => {
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]) / 1024;
  } catch {
    return null;
  }
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

describe.skipIf(!process.env.TBI_C5)('C-5 capacity (opt-in measurement)', () => {
  it(
    `N=${N} ${WORKLOAD} ${SECONDS}s`,
    async () => {
      assertProvisioned();
      // No client renews the lease here: it covers the whole measurement.
      const host = realHost({ maxSessions: N, paceRate: PACE, leaseMs: (SECONDS + 120) * 1000 });
      type Tracked = {
        s: HostSession;
        workload: string;
        start: number;
        rates: number[];
        last: [number, number];
        rates5: number[];
        last5: [number, number];
        ticks: number;
        fault?: 'stopped' | 'crashed';
        replaces?: number;
      };
      const sessions: Tracked[] = [];
      const start = (name: string, replaces?: number): Tracked => {
        const w = workloads[name]!();
        const a = artifact(w.fw);
        const s = open(host, { ...w.c.request(a.sha256), ticket: ticketFor(a.sha256) });
        if (s.state !== 'ready') throw new Error(`session ${name}: ${JSON.stringify(s.status())}`);
        s.run();
        const now = performance.now();
        const x: Tracked = {
          s,
          workload: name,
          start: now,
          rates: [],
          last: [now, 0],
          rates5: [],
          last5: [now, 0],
          ticks: 0,
          ...(replaces !== undefined ? { replaces } : {}),
        };
        sessions.push(x);
        return x;
      };
      for (let i = 0; i < N; i++) start(WORKLOAD === 'mix' ? MIX[i % MIX.length]! : WORKLOAD);
      const liveCount = () => sessions.filter((x) => !x.fault && x.s.state === 'running').length;
      const builder = BUILDS > 0 ? buildService(liveCount) : null;
      const builds: {
        burst: number;
        user: number;
        sketch: string;
        submittedMs: number;
        doneMs?: number;
        ok?: boolean;
        failure?: string;
        queuedMs?: number;
        buildMs?: number;
        refused?: string;
      }[] = [];
      let burst = 0;
      const submitBurst = () => {
        const b = burst++;
        for (let k = 0; k < BUILDS; k++) {
          const sketch = BUILD_SKETCHES[k % BUILD_SKETCHES.length]!;
          const text =
            readFileSync(
              new URL(`../firmware/arduino/${sketch}/${sketch}.ino`, import.meta.url),
              'utf8',
            ) + `\n// c5 burst ${b} user ${k}\n`;
          const who = principalFor(`c5-user-${k}`);
          const rec: (typeof builds)[number] = {
            burst: b,
            user: k,
            sketch,
            submittedMs: performance.now(),
          };
          builds.push(rec);
          try {
            const out = builder!.service.submit(
              {
                protocol: 'tbi-lab.build/1',
                profile: ESP32_ARDUINO_PROFILE.id,
                files: [{ name: 'sketch.ino', text }],
              },
              who,
            );
            if ('cached' in out) throw new Error('unexpected cache hit');
            const poll = setInterval(() => {
              const st = builder!.service.status(out.buildId, out.token, who);
              if (st?.result) {
                clearInterval(poll);
                rec.doneMs = performance.now();
                rec.ok = st.result.ok;
                if (!st.result.ok) rec.failure = st.result.failure;
                rec.queuedMs = st.result.timings.queuedMs;
                rec.buildMs = st.result.timings.buildMs;
              }
            }, 250);
          } catch (e) {
            rec.refused = (e as Error).message;
          }
        }
      };
      const faults: Record<string, unknown> = {};
      const host0 = cpu();
      const load: number[] = [];
      const qemuRss: number[] = [];
      let prevCpu = host0;
      const cpuBusy: number[] = [];
      const memAvail: number[] = [];
      const t0 = performance.now();
      let nextBurstS = BUILDS > 0 ? WARMUP_S + 10 : Infinity;
      let stopDone = false;
      let crashDone = false;
      while (performance.now() - t0 < SECONDS * 1000) {
        await new Promise((r) => setTimeout(r, 1000));
        const now = performance.now();
        const elapsedS = (now - t0) / 1000;
        for (const x of sessions) {
          if (x.fault) continue;
          const sim = Number(x.s.status().simNs) / 1e9;
          const rate = (sim - x.last[1]) / ((now - x.last[0]) / 1000);
          x.last = [now, sim];
          if ((now - x.start) / 1000 > WARMUP_S) x.rates.push(rate);
          // D-2: rate over 5 s windows (a window starting inside the warm-up is not counted).
          if (++x.ticks % 5 === 0) {
            const rate5 = (sim - x.last5[1]) / ((now - x.last5[0]) / 1000);
            if ((x.last5[0] - x.start) / 1000 >= WARMUP_S) x.rates5.push(rate5);
            x.last5 = [now, sim];
          }
          const m = rss(x.s.status().runtime.pid);
          if (m !== null) qemuRss.push(m);
        }
        if (elapsedS >= nextBurstS) {
          submitBurst();
          nextBurstS = BUILD_EVERY_S > 0 ? nextBurstS + BUILD_EVERY_S : Infinity;
        }
        if (FAULTS && !stopDone && elapsedS >= WARMUP_S + 20 && sessions.length > 0) {
          stopDone = true;
          const x = sessions[0]!;
          const pid = x.s.status().runtime.pid;
          x.fault = 'stopped';
          x.s.stop();
          await x.s.done();
          await new Promise((r) => setTimeout(r, 2000));
          faults.stop = { workload: x.workload, state: x.s.state, runtimeGone: !alive(pid) };
          start(x.workload, 0);
        }
        if (FAULTS && !crashDone && elapsedS >= WARMUP_S + 40 && sessions.length > 1) {
          crashDone = true;
          const x = sessions[1]!;
          const pid = x.s.status().runtime.pid;
          x.fault = 'crashed';
          if (pid) process.kill(pid, 'SIGKILL');
          const t = performance.now();
          while (x.s.state === 'running' && performance.now() - t < 15_000)
            await new Promise((r) => setTimeout(r, 200));
          await x.s.done();
          faults.crash = {
            workload: x.workload,
            state: x.s.state,
            reason: x.s.status().reason,
            runtimeGone: !alive(pid),
            reportedAfterMs: Math.round(performance.now() - t),
          };
          start(x.workload, 1);
        }
        const c = cpu();
        cpuBusy.push((c.busy - prevCpu.busy) / Math.max(1, c.total - prevCpu.total));
        prevCpu = c;
        load.push(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]));
        const ma = /MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'));
        if (ma) memAvail.push(Number(ma[1]) / 1024);
      }
      if (builder) {
        const t = performance.now();
        while (
          builds.some((b) => !b.refused && b.doneMs === undefined) &&
          performance.now() - t < 600_000
        )
          await new Promise((r) => setTimeout(r, 500));
      }
      const result = sessions.map((x) => {
        const st = x.s.status();
        return {
          workload: x.workload,
          ...(x.fault ? { fault: x.fault } : {}),
          ...(x.replaces !== undefined ? { replaces: x.replaces } : {}),
          state: st.state,
          reason: st.reason,
          simS: Number(st.simNs) / 1e9,
          rateP5: pct(x.rates, 5),
          rateMin: x.rates.length ? Math.min(...x.rates) : null,
          rateMedian: pct(x.rates, 50),
          rate5sP5: pct(x.rates5, 5),
          rate5sMin: x.rates5.length ? Math.min(...x.rates5) : null,
          windows5s: x.rates5.length,
          pace: st.pace,
          diagnostics: x.s.log
            .since(0)
            .filter((e) => e.type === 'diagnostic')
            .map((e) => (e as { code: string }).code),
        };
      });
      for (const x of sessions) if (!x.fault) x.s.stop();
      await Promise.all(sessions.map((x) => x.s.done()));
      const leftover = sessions.map((x) => x.s.status().runtime.pid).filter(alive);
      await host.shutdown();
      builder?.cleanup();
      const end = cpu();
      const measured = result.filter((r) => !r.fault && r.windows5s > 0);
      const buildDone = builds.filter((b) => b.doneMs !== undefined);
      const worstBuildMs = buildDone.length
        ? Math.max(...buildDone.map((b) => b.doneMs! - b.submittedMs))
        : null;
      const report = {
        runtimeId: runtimeInfo().runtimeId,
        n: N,
        seconds: SECONDS,
        workload: WORKLOAD,
        pace: PACE,
        warmupExcludedS: WARMUP_S,
        hostConfig: hostConfig(),
        host: {
          cpus: Number(readFileSync('/proc/cpuinfo', 'utf8').match(/^processor/gm)?.length ?? 0),
          cpuBusyMean: cpuBusy.reduce((a, b) => a + b, 0) / Math.max(1, cpuBusy.length),
          cpuBusyP95: pct(cpuBusy, 95),
          stealShare: (end.steal - host0.steal) / Math.max(1, end.total - host0.total),
          loadMax: Math.max(...load),
          qemuRssMaxMb: qemuRss.length ? Math.max(...qemuRss) : null,
          memAvailableMinMb: memAvail.length ? Math.round(Math.min(...memAvail)) : null,
        },
        sessions: result,
        ...(BUILDS > 0
          ? {
              builds: {
                perBurst: BUILDS,
                workers: BUILD_WORKERS,
                records: builds.map((b) => ({
                  ...b,
                  completionMs:
                    b.doneMs !== undefined ? Math.round(b.doneMs - b.submittedMs) : null,
                  submittedMs: undefined,
                  doneMs: undefined,
                })),
                worstCompletionMs: worstBuildMs !== null ? Math.round(worstBuildMs) : null,
              },
            }
          : {}),
        ...(FAULTS ? { faults } : {}),
        leftoverRuntimes: leftover.length,
        pass: {
          rate5sP5AtLeast0995: measured.every((r) => (r.rate5sP5 ?? 0) >= 0.995),
          tickGapP99AtMost100: measured.every((r) => (r.pace.tickGapMs.p99 ?? Infinity) <= 100),
          noFailures: result.filter((r) => !r.fault).every((r) => r.state === 'running'),
          noLeftoverRuntimes: leftover.length === 0,
          ...(BUILDS > 0
            ? {
                buildsAllSucceeded: builds.length > 0 && builds.every((b) => b.ok === true),
                buildsNoneRefused: builds.every((b) => !b.refused),
                buildWorstAtMost120s: worstBuildMs !== null && worstBuildMs <= 120_000,
              }
            : {}),
          ...(FAULTS
            ? {
                faultsCleanedUp:
                  (faults.stop as { runtimeGone?: boolean } | undefined)?.runtimeGone === true &&
                  (faults.crash as { runtimeGone?: boolean } | undefined)?.runtimeGone === true,
              }
            : {}),
        },
      };
      recordEvidence(
        `c5-n${N}-${WORKLOAD}-${PACE ? 'paced' : 'unpaced'}${BUILDS ? `-b${BUILDS}w${BUILD_WORKERS}` : ''}${FAULTS ? '-faults' : ''}`,
        report,
      );
      console.log(JSON.stringify(report, null, 2));
    },
    (SECONDS + 900) * 1000,
  );
});
