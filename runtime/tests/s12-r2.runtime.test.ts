/**
 * Sprint 12 (R2) on the REAL runtime (Runtime v2, patch 0006+): HC-SR04 and DHT22 through the
 * Session Host, the firmware reading them exactly as on hardware (pulseIn; a library-free AM2302
 * read), the environment changed LIVE as part parameters (ADR-010 mirrors). Oracles: the engine's
 * hcsr04Echo / dht22Frame for the same environment.
 *
 * - T-R2-2: pulseIn width vs the oracle at 2 cm, 10 cm, 1 m, 4 m (20 degC) and 1 m at 35 degC.
 * - T-R2-3: out of range (1 cm, 5 m): no echo, pulseIn times out (0).
 * - T-R2-7: the firmware decodes exactly the oracle (T, RH) at three points.
 * - T-R2-8: without a pull-up the sensor's answer cannot be read (no invented frame).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { hcsr04Echo } from '@tbi-lab/engine';
import { artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { stopped } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

/**
 * The echo edges are applied at their exact virtual times (patch 0006); pulseIn returns whole
 * microseconds. Measured on runtime b5b34b49cb7e4049: the reading is the oracle width truncated
 * to the microsecond at every point (116, 582, 5823, 23295, 5673 us), so the bound is 1 us, the
 * test matrix's T-R2-2 figure.
 */
const PULSEIN_TOLERANCE_US = 1;

async function start(c: Circuit, fw: string, ready: string): Promise<HostSession> {
  assertProvisioned();
  const a = artifact(fw);
  const s = open(host, { ...c.request(a.sha256), ticket: ticketFor(a.sha256) });
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  await waitEvent(s, () => serialText(s).includes(ready), 120_000);
  return s;
}

/** Lines matching `re` that appear after `from` characters of serial output. */
async function nextLines(s: HostSession, re: RegExp, n: number, from: number, ms = 120_000) {
  let got: RegExpMatchArray[] = [];
  await waitEvent(
    s,
    () => {
      got = [...serialText(s).slice(from).matchAll(re)];
      return got.length >= n;
    },
    ms,
  );
  return got;
}

let seq = 0;
function mirror(s: HostSession, component: string, params: Record<string, number>) {
  const rev = s.status().revisions.accepted + 1;
  seq++;
  expect(
    s.submit({ category: 'mirror', seq, projectRevision: rev, component, control: { params } }),
  ).toMatchObject({ accepted: true });
}

describe('R2 on the real runtime', () => {
  it('HC-SR04: pulseIn equals the oracle echo width; out of range gives no echo (T-R2-2, -3)', async () => {
    const c = new Circuit().psu(5);
    const u = c.add('sensor.hc_sr04');
    const r1 = c.add('component.resistor');
    const r2 = c.add('component.resistor');
    c.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref').pad(5, `${u}.trig`);
    c.ohms(r1, 1000).ohms(r2, 2000);
    c.wire(`${u}.echo`, `${r1}.a`).wire(`${r1}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    c.pad(18, `${r1}.b`);
    const s = await start(c, 'TbiHcSr04', 'TBI-HCSR04-READY');
    const rows: { distanceM: number; tempC: number; oracleUs: number | null; readUs: number[] }[] =
      [];
    for (const [distanceM, tempC] of [
      [0.02, 20],
      [0.1, 20],
      [1, 20],
      [4, 20],
      [1, 35],
      [0.01, 20],
      [5, 20],
    ] as const) {
      mirror(s, u, { distance: distanceM, airTemperature: tempC });
      // The change applies at the next tick; skip the reading in flight, then take three.
      const from = serialText(s).length;
      const lines = await nextLines(s, /^D (\d+)\r?$/gm, 4, from);
      const readUs = lines.slice(1).map((m) => Number(m[1]));
      const echo = hcsr04Echo(0n, 10, distanceM, tempC);
      rows.push({ distanceM, tempC, oracleUs: echo?.widthUs ?? null, readUs });
    }
    await stopped(s);
    recordEvidence('s12-r2-hcsr04', { runtimeId: runtimeInfo().runtimeId, rows });
    for (const r of rows) {
      if (r.oracleUs === null) expect(r.readUs, `${r.distanceM} m`).toEqual([0, 0, 0]);
      else
        for (const v of r.readUs)
          expect(
            Math.abs(v - r.oracleUs),
            `${r.distanceM} m ${r.tempC} degC: ${v} vs ${r.oracleUs}`,
          ).toBeLessThanOrEqual(PULSEIN_TOLERANCE_US);
    }
  });

  it('DHT22: the firmware decodes exactly the oracle values at three points (T-R2-7)', async () => {
    const c = new Circuit().psu(3.3);
    const u = c.add('sensor.dht22');
    const r = c.add('component.resistor');
    c.wire('PSU1.positive', `${u}.vdd`).wire(`${u}.gnd`, 'GND1.ref');
    c.ohms(r, 10_000)
      .wire(`${r}.a`, 'PSU1.positive')
      .wire(`${r}.b`, `${u}.data`)
      .pad(4, `${u}.data`);
    const s = await start(c, 'TbiDht22', 'TBI-DHT22-READY');
    const got: { t: number; rh: number; line: string }[] = [];
    for (const [t, rh] of [
      [-10, 30],
      [21.5, 55.2],
      [60, 95],
    ] as const) {
      mirror(s, u, { temperature: t, humidity: rh });
      const from = serialText(s).length;
      const lines = await nextLines(s, /^(T -?\d+ H \d+|E \d+)\r?$/gm, 2, from);
      got.push({ t, rh, line: lines[1]![1]! });
    }
    await stopped(s);
    recordEvidence('s12-r2-dht22', { runtimeId: runtimeInfo().runtimeId, got });
    expect(got.map((g) => g.line)).toEqual(['T -100 H 300', 'T 215 H 552', 'T 600 H 950']);
  });

  it('DHT22 without a pull-up: the firmware reports a read failure, no frame is invented (T-R2-8)', async () => {
    const c = new Circuit().psu(3.3);
    const u = c.add('sensor.dht22');
    c.wire('PSU1.positive', `${u}.vdd`).wire(`${u}.gnd`, 'GND1.ref').pad(4, `${u}.data`);
    const s = await start(c, 'TbiDht22', 'TBI-DHT22-READY');
    const lines = await nextLines(s, /^(T -?\d+ H \d+|E \d+)\r?$/gm, 2, 0);
    await stopped(s);
    for (const m of lines) expect(m[1]).toMatch(/^E \d$/);
  });
});
