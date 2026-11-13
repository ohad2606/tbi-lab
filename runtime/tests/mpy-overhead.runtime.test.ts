/**
 * MicroPython expansion phase 2: the cost of the Build-analysis change (analyzer 7 → 9) for
 * programs that do NOT use time_pulse_us or dht. A measurement, not a gate: skipped unless
 * TBI_MPY_BENCH=1 (plus the runtime home, as every runtime test). The same file is run on the
 * pre-change tree (analyzer 7) and on this one, and the two JSON results are compared.
 *
 * - Build, no cache: every curated MicroPython example program that uses neither, built N times,
 *   each into a FRESH store (cold, nothing reused): build wall time (the service's own buildMs),
 *   artifact size and sha256, the feature report.
 * - Analysis alone: analyzeMicroPython over the same programs, 200 iterations (CPU time).
 * - Run: one artifact (mpy-blink) run for 3 s of simulated time, N times: wall time from Run to the
 *   first serial line of the program, wall time to 3 s simulated, and the QEMU process's CPU time
 *   (utime + stime from /proc/<pid>/stat just before Stop).
 * Results: $TBI_RUNTIME_HOME/results/mpy-overhead-a<analyzer>.json.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeMicroPython, PY_FEATURES_ANALYZER } from '../builder/pyFeatures.js';
import { recordEvidence } from '../harness/env.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { realHost } from './r2-support.js';
import { MpyStack, RT, V4, example, simNow } from './s24-support.js';

const ON = !!process.env.TBI_MPY_BENCH && RT && V4;
const N = Number(process.env.TBI_MPY_BENCH_N ?? 5);
const PROGRAMS = [
  'mpy-blink',
  'mpy-button',
  'mpy-fade',
  'mpy-lcd-hello',
  'mpy-pot-threshold',
  'mpy-adder-monitor',
  'mpy-logic-feedback',
];
const text = (id: string) => {
  const doc = JSON.parse(
    readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as { programs: Record<string, { text: string }> };
  return Object.values(doc.programs)[0]!.text;
};
const CLK_TCK = 100; // Linux USER_HZ
const cpuMs = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
  return ((Number(rest[11]) + Number(rest[12])) * 1000) / CLK_TCK;
};
const out: Record<string, unknown> = { analyzer: PY_FEATURES_ANALYZER, n: N };
afterAll(() => {
  if (ON) recordEvidence(`mpy-overhead-a${PY_FEATURES_ANALYZER}`, out);
});

describe.skipIf(!ON)('MicroPython analyzer overhead (measurement)', () => {
  it('builds with no cache', async () => {
    const rows: Record<string, unknown>[] = [];
    for (let k = 0; k < N; k++)
      for (const id of PROGRAMS) {
        const stack = new MpyStack(); // a fresh, empty store: no cache
        try {
          const r = await stack.build(text(id));
          rows.push({
            id,
            k,
            buildMs: r.timings?.buildMs,
            bytes: r.artifact?.bytes,
            sha256: r.artifact?.sha256,
            features: r.features,
          });
        } finally {
          stack.cleanup();
        }
      }
    out.builds = rows;
    expect(rows.length).toBe(N * PROGRAMS.length);
  }, 3_600_000);

  it('analysis alone', () => {
    const texts = PROGRAMS.map(text);
    const caps = ['gpio-irq', 'i2c', 'i2c-clock', 'input-read', 'pad-func', 'pwm', 'sched-input'];
    for (const t of texts) analyzeMicroPython(t, caps); // warm-up
    const t0 = process.cpuUsage();
    const w0 = performance.now();
    for (let i = 0; i < 200; i++) for (const t of texts) analyzeMicroPython(t, caps);
    const cpu = process.cpuUsage(t0);
    out.analysis = {
      calls: 200 * texts.length,
      wallMsPerCall: (performance.now() - w0) / (200 * texts.length),
      cpuMsPerCall: (cpu.user + cpu.system) / 1000 / (200 * texts.length),
    };
  });

  it('runs mpy-blink for 3 s simulated', async () => {
    const stack = new MpyStack();
    const host = realHost({ artifactsDir: stack.store, leaseMs: 600_000 });
    const rows: Record<string, unknown>[] = [];
    try {
      const ex = example('mpy-blink', 's24-mpy-blink-session.json');
      for (let k = 0; k < N; k++) {
        const t0 = performance.now();
        const { s } = await stack.run(host, ex.text, ex.request);
        await waitEvent(s, () => /\S/.test(serialText(s).split('>>>').at(-1) ?? ''), 120_000);
        const firstLineMs = performance.now() - t0;
        await waitEvent(s, (e) => e.simNs !== null && BigInt(e.simNs) >= 3_000_000_000n, 300_000);
        const to3sMs = performance.now() - t0;
        const pid = s.status().runtime.pid!;
        const qemuCpuMs = cpuMs(pid);
        rows.push({ k, firstLineMs, to3sMs, qemuCpuMs, simNs: String(simNow(s)) });
        s.stop();
        await waitEvent(
          s,
          (e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'),
          30_000,
        );
        await s.done();
      }
    } finally {
      await host.shutdown();
      stack.cleanup();
    }
    out.runs = rows;
  }, 3_600_000);
});
