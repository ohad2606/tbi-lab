/**
 * Sprint 12 (D-10, V1-ARCHITECTURE §7.8): pacing by withholding tick replies. The fake runtime
 * simulates at about 1.2x real time unpaced, so the cap is exercised at 0.5x: simulation time
 * never runs ahead of 0.5 x wall time by more than the slack; unpaced it does; the firmware's
 * output is the same either way (pacing cannot alter the simulated timeline). Real time (1x) on
 * the real runtime: runtime/tests/s12-pace.runtime.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { principalFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { HostSession } from '../session.js';
import { createRequest, fakeHost, serialText, waitState } from './support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

async function runFor(paceRate: number | null, ms: number) {
  const r = fakeHost('normal', { paceRate });
  hosts.push(r.host);
  const c = r.host.create(createRequest(r.art.sha256), principalFor());
  if (!c.ok) throw new Error(c.error);
  const s: HostSession = c.value.session;
  s.run();
  await waitState(s, 'running');
  const samples: { simS: number; wallS: number }[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await new Promise((res) => setTimeout(res, 100));
    const st = s.status();
    samples.push({ simS: Number(st.simNs) / 1e9, wallS: (performance.now() - t0) / 1000 });
  }
  s.stop();
  await Promise.race([waitState(s, 'ended', 15_000), waitState(s, 'failed', 15_000)]);
  await s.done();
  return { s, samples, status: s.status() };
}

describe('pacing (D-10)', () => {
  it('paced at 0.5x: simulation time never runs ahead of 0.5 x wall time; ticks keep flowing', async () => {
    const { samples, status } = await runFor(0.5, 1500);
    // The handshake precedes t0, so sim may lead t0-based wall by the startup time; bound loosely.
    for (const x of samples) expect(x.simS).toBeLessThanOrEqual(0.5 * x.wallS + 0.1);
    expect(samples.at(-1)!.simS).toBeGreaterThan(0.5);
    expect(status.pace.rate).toBe(0.5);
    expect(status.pace.simPerWall!).toBeLessThanOrEqual(0.52);
    expect(status.pace.simPerWall!).toBeGreaterThan(0.4);
    expect(status.pace.pacedMs).toBeGreaterThan(300);
    expect(status.pace.tickGapMs.count).toBeGreaterThan(500);
    expect(status.pace.tickGapMs.p99!).toBeLessThanOrEqual(100);
  });

  it('unpaced: the fake runtime runs well ahead of the 0.5x cap', async () => {
    const { samples, status } = await runFor(null, 800);
    expect(samples.at(-1)!.simS).toBeGreaterThan(0.8 * samples.at(-1)!.wallS);
    expect(status.pace).toMatchObject({ rate: null, pacedMs: 0 });
  });

  it('pacing does not change what the firmware does (same serial stream prefix)', async () => {
    const paced = await runFor(0.5, 1200);
    const fast = await runFor(null, 400);
    const a = serialText(paced.s);
    const b = serialText(fast.s);
    const n = Math.min(a.length, b.length);
    expect(n).toBeGreaterThan(5);
    expect(a.slice(0, n)).toBe(b.slice(0, n));
  });
});
