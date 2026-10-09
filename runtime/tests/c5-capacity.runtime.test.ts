/**
 * C-5 capacity harness (Sprint 12, S12-11; SPRINT-12-ARCHITECTURE §8): N concurrent live ESP32
 * sessions, each paced at real time (D-10), each driving a workload through the Session Host and
 * real QEMU, measured every second:
 *   - per-session simulation rate (x real time over each 1 s window; p5 and minimum);
 *   - tick wall-gap p99 and maximum (the Session Host's own statistics);
 *   - host CPU busy/steal (/proc/stat), load average, QEMU RSS;
 *   - session failures and diagnostics.
 * The pass criteria (PM D-2): every session p5 rate >= 1.0x and tick-gap p99 <= 100 ms under
 * the defined workloads, no failures. Measurement only: it never changes a deployed instance
 * (an in-process Session Host with its own temporary root; no service, policy or unit is
 * touched). The first 30 s of each session (ROM and boot, slower than real time in QEMU,
 * V1-ARCHITECTURE §7.8) are excluded from the rate statistics and reported separately.
 *
 * Opt-in (skipped unless TBI_C5 is set), parameters from the environment:
 *   TBI_C5=1 TBI_C5_N=3 TBI_C5_SECONDS=120 TBI_C5_WORKLOAD=mix [TBI_C5_PACE=off] \
 *     npx vitest run --config vitest.runtime.config.ts runtime/tests/c5-capacity.runtime.test.ts
 *   workloads: sonar (HC-SR04 at 10 Hz), dht (DHT22 every 2.5 s), lcd (I2C LCD), gpio
 *   (TbiGpioProof), mix (sonar, dht, gpio, lcd, gpio in turn)
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
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
      const sessions: {
        s: HostSession;
        workload: string;
        rates: number[];
        last: [number, number];
      }[] = [];
      for (let i = 0; i < N; i++) {
        const name = WORKLOAD === 'mix' ? MIX[i % MIX.length]! : WORKLOAD;
        const w = workloads[name]!();
        const a = artifact(w.fw);
        const s = open(host, { ...w.c.request(a.sha256), ticket: ticketFor(a.sha256) });
        if (s.state !== 'ready') throw new Error(`session ${i}: ${JSON.stringify(s.status())}`);
        s.run();
        sessions.push({ s, workload: name, rates: [], last: [performance.now(), 0] });
      }
      const host0 = cpu();
      const load: number[] = [];
      const qemuRss: number[] = [];
      let prevCpu = host0;
      const cpuBusy: number[] = [];
      const t0 = performance.now();
      while (performance.now() - t0 < SECONDS * 1000) {
        await new Promise((r) => setTimeout(r, 1000));
        const now = performance.now();
        for (const x of sessions) {
          const sim = Number(x.s.status().simNs) / 1e9;
          const rate = (sim - x.last[1]) / ((now - x.last[0]) / 1000);
          x.last = [now, sim];
          if ((now - t0) / 1000 > WARMUP_S) x.rates.push(rate);
          const m = rss(x.s.status().runtime.pid);
          if (m !== null) qemuRss.push(m);
        }
        const c = cpu();
        cpuBusy.push((c.busy - prevCpu.busy) / Math.max(1, c.total - prevCpu.total));
        prevCpu = c;
        load.push(Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]));
      }
      const result = sessions.map((x) => {
        const st = x.s.status();
        return {
          workload: x.workload,
          state: st.state,
          reason: st.reason,
          simS: Number(st.simNs) / 1e9,
          rateP5: pct(x.rates, 5),
          rateMin: x.rates.length ? Math.min(...x.rates) : null,
          rateMedian: pct(x.rates, 50),
          pace: st.pace,
          diagnostics: x.s.log
            .since(0)
            .filter((e) => e.type === 'diagnostic')
            .map((e) => (e as { code: string }).code),
        };
      });
      for (const x of sessions) x.s.stop();
      await Promise.all(sessions.map((x) => x.s.done()));
      await host.shutdown();
      const end = cpu();
      const report = {
        runtimeId: runtimeInfo().runtimeId,
        n: N,
        seconds: SECONDS,
        workload: WORKLOAD,
        pace: PACE,
        warmupExcludedS: WARMUP_S,
        host: {
          cpus: Number(readFileSync('/proc/cpuinfo', 'utf8').match(/^processor/gm)?.length ?? 0),
          cpuBusyMean: cpuBusy.reduce((a, b) => a + b, 0) / Math.max(1, cpuBusy.length),
          stealShare: (end.steal - host0.steal) / Math.max(1, end.total - host0.total),
          loadMax: Math.max(...load),
          qemuRssMaxMb: qemuRss.length ? Math.max(...qemuRss) : null,
        },
        sessions: result,
        pass: {
          rateP5AtLeast1: result.every((r) => (r.rateP5 ?? 0) >= 0.99),
          tickGapP99AtMost100: result.every((r) => (r.pace.tickGapMs.p99 ?? Infinity) <= 100),
          noFailures: result.every((r) => r.state === 'running'),
        },
      };
      recordEvidence(`c5-n${N}-${WORKLOAD}-${PACE ? 'paced' : 'unpaced'}`, report);
      console.log(JSON.stringify(report, null, 2));
    },
    (SECONDS + 300) * 1000,
  );
});
