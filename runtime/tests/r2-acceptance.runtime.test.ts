/**
 * Runtime R2 heavy acceptance, part 1: lifecycle, determinism, the command-quantum regression and
 * browser/server electrical equivalence, through the Session Host on the REAL runtime.
 * Run on a provisioned machine: npm run test:r2 (TBI_RUNTIME_HOME=<provisioned home>).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { runClosedLoop } from '../harness/closedLoop.js';
import { QEMU, artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { alive, gone, serialText, waitEvent, waitState } from '../host/tests/support.js';
import type { SessionEvent } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import {
  gateMirrors,
  gateRequest,
  loadRequest,
  open,
  realHost,
  runtimeEvents,
} from './r2-support.js';

assertProvisioned();
const host = realHost();
afterAll(() => host.shutdown());
const evidence: Record<string, unknown> = { runtime: runtimeInfo() };
afterAll(() => recordEvidence('r2-acceptance', evidence));

const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const END = 15_500_000_000n;

/** Run a session until its simulation time passes `untilNs` of simulation time, then stop it. */
async function runUntil(s: HostSession, untilNs: bigint): Promise<void> {
  expect(s.run()).toEqual({ ok: true });
  // Simulation time, not event arrival: a quiet guest publishes nothing.
  await expect
    .poll(() => BigInt(s.status().simNs) >= untilNs, { timeout: 120_000, interval: 50 })
    .toBe(true);
  expect(s.state).toBe('running');
  s.stop();
  await waitState(s, 'ended', 30_000);
  await s.done();
}

function gateSession(tickUs?: number) {
  const s = open(host, gateRequest('TbiGpioProof', tickUs ? { commandQuantumUs: tickUs } : {}));
  for (const m of gateMirrors()) {
    const r = host.command(s, m);
    expect(r).toMatchObject({ ok: true, value: { accepted: true } });
  }
  return s;
}

describe('R2 lifecycle on the real runtime', () => {
  it('create -> run -> stop -> cleanup, three times: fresh private state, artifact untouched', async () => {
    const art = artifact('TbiNvs');
    const before = createHash('sha256').update(readFileSync(art.path)).digest('hex');
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const s = open(host, loadRequest('TbiNvs'));
      expect(s.state).toBe('ready');
      const dir = s.privateDir;
      s.run();
      await waitEvent(s, () => serialText(s).includes('TBI-NVS-DONE'), 60_000);
      const pid = s.status().runtime.pid;
      expect(alive(pid)).toBe(true);
      expect(serialText(s)).toContain('TBI-NVS-BOOTS=1'); // guest wrote NVS; the next session starts fresh
      s.stop();
      await waitState(s, 'ended');
      await s.done();
      expect(s.status()).toMatchObject({ state: 'ended', reason: 'stopped' });
      expect(alive(pid)).toBe(false);
      expect(gone(dir)).toBe(true);
      rows.push({ pid, reason: s.status().reason });
    }
    expect(createHash('sha256').update(readFileSync(art.path)).digest('hex')).toBe(before);
    evidence.lifecycle = rows;
  });
});

describe('R2 determinism through the Session Host', () => {
  it('the gate workload with scheduled persistent mirrors: 5 sessions, one runtime event stream', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = gateSession();
      await runUntil(s, END);
      hashes.push(sha(runtimeEvents(s, END)));
    }
    evidence.gateHashes = hashes;
    expect(new Set(hashes).size).toBe(1);
  });

  it('command quantum 1 ms vs 10 ms: identical guest timeline, no host commands (TbiTiming)', async () => {
    const until = 4_000_000_000n;
    const streams = [];
    for (const tickUs of [1000, 10_000]) {
      const s = open(host, loadRequest('TbiTiming', { commandQuantumUs: tickUs }));
      await runUntil(s, until);
      streams.push(runtimeEvents(s, until));
    }
    evidence.quantumNoCommands = streams.map(sha);
    expect(streams[1]).toEqual(streams[0]);
    expect(streams[0]!.some((e) => e.type === 'gpio')).toBe(true);
  });

  it('command quantum 1 ms vs 10 ms with the gate mirrors (all on 10 ms multiples): identical', async () => {
    const a = gateSession(1000);
    await runUntil(a, END);
    const b = gateSession(10_000);
    await runUntil(b, END);
    evidence.quantumGate = [sha(runtimeEvents(a, END)), sha(runtimeEvents(b, END))];
    expect(runtimeEvents(b, END)).toEqual(runtimeEvents(a, END));
  });
});

describe('R2 electrical equivalence: Session Host (EngineSession + pads) vs the R1 reference loop', () => {
  it('every published operating point equals the R1 harness solve in force at that time (1e-9)', async () => {
    const fw = artifact('TbiGpioProof');
    const ref = await runClosedLoop({
      qemu: QEMU,
      artifact: fw.path,
      artifactSha256: fw.sha256,
      endNs: END,
      tickUs: 1000,
    });
    // R1 timeline: `V <vns> <cause> io2=.. io5=.. iLED=..` and `G <vns> gpioN drive= level=`.
    const solves = ref.timeline
      .filter((l) => l.startsWith('V '))
      .map((l) => {
        const m = /^V (\d+) \S+ io2=(\S+) io5=(\S+) iLED=(\S+)/.exec(l)!;
        return { vns: BigInt(m[1]!), io2: Number(m[2]), io5: Number(m[3]), iLed: Number(m[4]) };
      });
    const s = gateSession();
    await runUntil(s, END);
    const elec = s.log
      .since(0)
      .filter((e): e is Extract<SessionEvent, { type: 'electrical' }> => e.type === 'electrical')
      .filter((e) => BigInt(e.simNs!) <= END);
    expect(elec.length).toBeGreaterThan(20);
    let compared = 0;
    let worst = 0;
    for (const e of elec) {
      const t = BigInt(e.simNs!);
      const r = [...solves].reverse().find((x) => x.vns <= t)!;
      const o = e.outcome as {
        pins: { gpio: number; voltage: number }[];
        components: Record<string, { current: number }>;
      };
      const io2 = o.pins.find((p) => p.gpio === 2)!.voltage;
      const io5 = o.pins.find((p) => p.gpio === 5)!.voltage;
      const iLed = o.components.D1!.current;
      for (const [a, b] of [
        [io2, r.io2],
        [io5, r.io5],
        [iLed, r.iLed],
      ] as const) {
        const rel = Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
        worst = Math.max(worst, Math.abs(a - b) <= 1e-12 ? 0 : rel);
        expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
      }
      compared++;
    }
    // GPIO: every published window's final pad-2 state matches the R1 pad events.
    const g2 = ref.timeline
      .filter((l) => l.startsWith('G ') && l.includes(' gpio2 '))
      .map((l) => {
        const m = /^G (\d+) gpio2 drive=(\d) level=(\d)$/.exec(l)!;
        return { vns: BigInt(m[1]!), drive: Number(m[2]), level: Number(m[3]) };
      });
    for (const e of s.log.since(0)) {
      if (e.type !== 'gpio' || BigInt(e.simNs!) > END) continue;
      const c = e.changes.find((x) => x.gpio === 2);
      if (!c) continue;
      const last = [...g2].reverse().find((x) => x.vns <= BigInt(e.simNs!))!;
      expect({ drive: c.drive, level: c.level }).toEqual({ drive: last.drive, level: last.level });
    }
    evidence.equivalence = { comparedOperatingPoints: compared, worstRelative: worst };
  });
});
