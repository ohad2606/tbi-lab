/**
 * Sprint 11 (R1), slice 6 — 8x8 matrix performance on the REAL runtime (PM condition: verify the
 * 2 ms per-event solve budget with measurements before the matrix is enabled for ESP32 projects).
 *
 * Firmware TbiR1Scan (runtime test firmware): GPIO34 LOW -> a static pattern; HIGH -> a
 * multiplexed checkerboard, one row per millisecond, every line its own digitalWrite.
 * Measured (test-only instrumentation of the host session: the engine's solve and the bridge tick
 * handler are wrapped with wall-clock timers; nothing in the product changes):
 * - per-pad-event solve latency p50 / p95 / p99 / max, static and scanning;
 * - solves per simulated second and per wall second; simulation-time rate;
 * - CPU: this process (the Session Host runs in it) and the QEMU process (/proc/<pid>/stat);
 * - impact on another session: a concurrent TbiBanks session's simulation rate and its largest
 *   wall-clock gap between bridge ticks, alone vs. beside the scanning session.
 * The numbers are written to $TBI_RUNTIME_HOME/results/r1-matrix-perf.json BEFORE the gates are
 * asserted, so a failed gate still leaves its evidence.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { CATALOG } from '@tbi-lab/domain';
import type { EngineSession, SolveOutcome } from '@tbi-lab/engine';
import { artifact, assertProvisioned, recordEvidence } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import type { CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { waitEvent, waitState } from '../host/tests/support.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { switchedInput } from './r1-support.js';

// No client streams in this test: the client lease must not end the companion session.
const host = realHost({ stallTimeoutMs: 60_000, leaseMs: 3_600_000 });
afterAll(() => host.shutdown());

const COLS = [4, 16, 27, 25, 32, 33, 18, 19];
const ROWS = [23, 22, 21, 17, 13, 14, 26, 5];

function matrixRequest(fw: string): { req: CreateSessionRequest; mode: string; m: string } {
  const c = new Circuit().psu(3.3);
  const mode = switchedInput(c, 34);
  const m = c.add('display.led_matrix_8x8');
  COLS.forEach((g, j) => {
    const r = c.add('component.resistor');
    c.ohms(r, 220)
      .wire(`${r}.b`, `${m}.c${j + 1}`)
      .pad(g, `${r}.a`);
  });
  ROWS.forEach((g, i) => c.pad(g, `${m}.r${i + 1}`));
  const a = artifact(fw);
  return { req: { ...c.request(a.sha256), ticket: ticketFor(a.sha256) }, mode, m };
}

function banksRequest(): CreateSessionRequest {
  const c = new Circuit().psu(3.3);
  switchedInput(c, 34);
  const r = c.add('component.resistor');
  const d = c.add('component.led');
  c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref').pad(4, `${r}.a`);
  const a = artifact('TbiBanks');
  return { ...c.request(a.sha256), ticket: ticketFor(a.sha256) };
}

/** Wrap a session's engine solve and bridge tick with wall-clock timers (test-only). */
function instrument(s: HostSession) {
  const solves: number[] = [];
  const ticks: number[] = [];
  const priv = s as unknown as { engine: EngineSession; onTick: (v: bigint) => unknown };
  const engine = priv.engine;
  const solve = engine.solve.bind(engine);
  engine.solve = (): SolveOutcome => {
    const t0 = performance.now();
    const out = solve();
    solves.push(performance.now() - t0);
    return out;
  };
  const onTick = priv.onTick.bind(s);
  priv.onTick = (v: bigint) => {
    ticks.push(performance.now());
    return onTick(v);
  };
  return { solves, ticks };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
};
const stats = (xs: number[]) => ({
  n: xs.length,
  p50: pct(xs, 50),
  p95: pct(xs, 95),
  p99: pct(xs, 99),
  max: xs.length ? Math.max(...xs) : null,
});
const maxGap = (ts: number[]) => ts.slice(1).reduce((m, t, i) => Math.max(m, t - ts[i]!), 0);

/** QEMU process CPU seconds (utime + stime) from /proc. */
function procCpu(pid: number | null): number | null {
  if (!pid) return null;
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) / 100; // clock ticks (USER_HZ = 100)
  } catch {
    return null;
  }
}

const simNs = (s: HostSession) => BigInt(s.status().simNs);
const serial = (s: HostSession) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'serial')
    .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
    .join('');

/** Measure a session (and optionally a companion) for `wallMs`. */
async function window(
  s: HostSession,
  probe: ReturnType<typeof instrument>,
  wallMs: number,
  companion?: { s: HostSession; probe: ReturnType<typeof instrument> },
) {
  const solves0 = probe.solves.length;
  const ticks0 = probe.ticks.length;
  const c0 = companion && {
    solves: companion.probe.solves.length,
    ticks: companion.probe.ticks.length,
    sim: simNs(companion.s),
  };
  const sim0 = simNs(s);
  const cpu0 = process.cpuUsage();
  const q0 = procCpu(s.status().runtime.pid);
  const w0 = performance.now();
  await new Promise((r) => setTimeout(r, wallMs));
  const wall = (performance.now() - w0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const q1 = procCpu(s.status().runtime.pid);
  const simS = Number(simNs(s) - sim0) / 1e9;
  const solves = probe.solves.slice(solves0);
  const out = {
    wallS: wall,
    simulatedS: simS,
    simRate: simS / wall,
    solve: stats(solves),
    solvesPerSimS: simS > 0 ? solves.length / simS : null,
    solvesPerWallS: solves.length / wall,
    maxTickGapMs: maxGap(probe.ticks.slice(ticks0)),
    hostCpuPerWallS: (cpu.user + cpu.system) / 1e6 / wall,
    qemuCpuPerWallS: q0 !== null && q1 !== null ? (q1 - q0) / wall : null,
    ...(companion && c0
      ? {
          companion: {
            simRate: Number(simNs(companion.s) - c0.sim) / 1e9 / wall,
            solve: stats(companion.probe.solves.slice(c0.solves)),
            maxTickGapMs: maxGap(companion.probe.ticks.slice(c0.ticks)),
          },
        }
      : {}),
  };
  return out;
}

describe('slice 6 — matrix performance on the real runtime (measurement)', () => {
  it('static and scanning, alone and beside another session; evidence first, then the gates', async () => {
    assertProvisioned();
    // The measurement precedes the decision (PM condition): while the catalog still refuses the
    // matrix for ESP32 projects, this test alone lifts that flag for its own duration.
    const def = CATALOG['display.led_matrix_8x8'] as { mcuRuntime?: false };
    const flagged = def.mcuRuntime;
    delete def.mcuRuntime;
    try {
      await measure(flagged === false);
    } finally {
      if (flagged === false) def.mcuRuntime = false;
    }
  });
});

async function measure(refusedByCatalog: boolean) {
  {
    const evidence: Record<string, unknown> = {
      measuredAt: new Date().toISOString(),
      host: 'dev host (the same machine as dev-lab: 4 cores ARM64, 4 GB)',
      gates: { solveP99Ms: 2, companionRateDegradation: 0.2, maxTickGapMs: 100 },
    };

    // Baseline: the companion session alone.
    const b = open(host, banksRequest());
    const bp = instrument(b);
    b.run();
    await waitEvent(b, () => serial(b).includes('TBI-BANKS-SWEEP-DONE'), 90_000);
    evidence.companionAlone = await window(b, bp, 5_000);

    // The matrix session beside it.
    const { req, mode, m } = matrixRequest('TbiR1Scan');
    const s = open(host, req);
    expect(s.state).toBe('ready');
    const sp = instrument(s);
    s.run();
    await waitEvent(s, () => serial(s).includes('STATIC'), 90_000);
    // Static: every solve from Run until the pattern stands (setup writes + the pattern itself),
    // then a window with the pattern standing (no pad events: no solves expected).
    evidence.staticSolves = stats([...sp.solves]);
    evidence.static = await window(s, sp, 4_000, { s: b, probe: bp });
    const lit = (
      s.log
        .since(0)
        .filter((e) => e.type === 'electrical')
        .at(-1) as unknown as {
        outcome: { components: Record<string, { state?: { lit?: number } }> };
      }
    ).outcome.components[m]!.state!.lit;
    evidence.staticLit = lit;

    // Scanning: the mode switch closed (a mirrored edit).
    expect(
      s.submit({
        category: 'mirror',
        seq: 1,
        projectRevision: req.circuit.projectRevision + 1,
        component: mode,
        control: { closed: true },
      }),
    ).toMatchObject({ accepted: true });
    await waitEvent(s, () => serial(s).includes('SCAN'), 120_000);
    evidence.scanning = await window(s, sp, 10_000, { s: b, probe: bp });

    s.stop();
    await waitState(s, 'ended', 60_000);
    evidence.companionAfter = await window(b, bp, 3_000);
    b.stop();
    await waitState(b, 'ended', 60_000);
    // Correctness of the static pattern: rows 1-2 x columns 1-4.
    expect(lit).toBe(8);
    const scan = evidence.scanning as Awaited<ReturnType<typeof window>>;
    const st = evidence.static as Awaited<ReturnType<typeof window>>;
    const stS = evidence.staticSolves as ReturnType<typeof stats>;
    const alone = evidence.companionAlone as Awaited<ReturnType<typeof window>>;
    expect(stS.n).toBeGreaterThan(0);
    expect(st.solve.n).toBe(0); // a standing pattern costs nothing
    // The gates (architecture §6.4), evaluated and recorded, never silently dropped.
    const gates = {
      staticP99: (stS.p99 ?? Infinity) <= 2,
      scanningP99: (scan.solve.p99 ?? Infinity) <= 2,
      companionRate: scan.companion!.simRate >= alone.simRate * 0.8,
      companionTickGap: scan.companion!.maxTickGapMs <= 100,
    };
    evidence.gatesMet = gates;
    recordEvidence(`r1-matrix-perf-${process.env.TBI_PERF_RUN ?? '1'}`, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    // The product decision must follow the measurement: the matrix may be offered with the board
    // only if every gate holds (PM condition, Sprint 11).
    if (!Object.values(gates).every(Boolean)) expect(refusedByCatalog).toBe(true);
  }
}
