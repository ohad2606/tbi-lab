/**
 * MicroPython expansion (real stack): `machine.time_pulse_us` against the HC-SR04 model, the
 * product-level validation required before the Build analysis allows it (analyzer 8).
 *
 * Everything runs on real QEMU Runtime v5 with the genuine MicroPython 1.29 interpreter, on the
 * app's request for the distance-alarm circuit (fixture s12-distance-alarm-session.json: GPIO5 →
 * TRIG, ECHO → 1 kΩ / 2 kΩ divider → GPIO18, the module on 5 V). The echo is the Session Host's
 * HC-SR04 model (hcsr04Echo: the edges are scheduled at exact virtual times); the oracle is the
 * same function for the same environment. Nothing in the runtime, the host or the firmware
 * changed: the interpreter's own time_pulse_us (a C loop polling the GPIO input register) reads
 * the scheduled edges.
 *
 * - Accuracy: 2 cm .. 4 m at 20 °C, and 1 m at −10 / 40 °C: every reading within
 *   TIME_PULSE_TOLERANCE_US of the oracle width.
 * - Out of range (1 cm, 5 m: the model gives no echo): −2 ("no pulse started") within the timeout,
 *   the program keeps running, and readings resume when the target returns in range.
 * - A pulse longer than the timeout: −1 ("pulse did not end") after the timeout, never a hang.
 * - The shipped example mpy-distance-alarm prints the same distances as its Arduino twin
 *   (pulseIn) and lights the LED below 20 cm.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { hcsr04Echo, type SolveSuccess } from '@tbi-lab/engine';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { Grants } from '../builder/grants.js';
import record from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import { assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { principalFor, TEST_TICKET_KEY } from '../identity/test-gate.js';
import { openAccessPolicy } from '../policy/testing.js';
import { realHost } from './r2-support.js';
import { MpyStack, RT, V4, electrical, example, runtimeCaps } from './s24-support.js';

/**
 * Measured on Runtime v5 39f2229a66d45e43 (evidence mpy-distance-pulse.json): the bound for one
 * time_pulse_us reading against the oracle width. The interpreter polls the input register in a C
 * loop with mp_hal_ticks_us(); the Sprint 12 G2 timing contract allows a polled input to be seen
 * up to ≈ 13 µs late inside the other core's interval (G2-ROUND5 §1.1), so this bound is that
 * contract's, not a tighter claim: 13 µs is 0.22 cm at 20 °C.
 */
const TIME_PULSE_TOLERANCE_US = 13;
const SENSOR = 'U2';
const FIXTURE = 's12-distance-alarm-session.json';

const stack = RT && V4 ? new MpyStack() : null;
const store = stack ? mkdtempSync(join('/var/tmp', 'mpy-distance-store-')) : '';
const work = stack ? mkdtempSync(join('/var/tmp', 'mpy-distance-work-')) : '';
const mpyHost = realHost(stack ? { artifactsDir: stack.store, leaseMs: 600_000 } : {});
const inoHost = realHost(stack ? { artifactsDir: store, leaseMs: 600_000 } : {});
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  await mpyHost.shutdown();
  await inoHost.shutdown();
  stack?.cleanup();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
  if (stack)
    recordEvidence('mpy-distance-pulse', { runtimeId: runtimeInfo().runtimeId, ...evidence });
});

type Request = Omit<CreateSessionRequest, 'artifact' | 'ticket' | 'protocol'>;
const request = () =>
  JSON.parse(JSON.stringify(example('esp32-distance-alarm', FIXTURE).request)) as Request;

/** A probe: trigger every 60 ms, print the raw reading and how long the call took (ms). */
const probe = (timeoutUs: number) => `from machine import Pin, time_pulse_us
import time
trig = Pin(5, Pin.OUT, value=0)
echo = Pin(18, Pin.IN)
print("TBI-PULSE-READY")
while True:
    trig.value(1)
    time.sleep_us(10)
    trig.value(0)
    t0 = time.ticks_us()
    us = time_pulse_us(echo, 1, ${timeoutUs})
    print("D %d %d" % (us, time.ticks_diff(time.ticks_us(), t0)))
    time.sleep_ms(60)
`;

let seq = 0;
function mirror(s: HostSession, params: Record<string, number>) {
  const rev = s.status().revisions.accepted + 1;
  expect(
    s.submit({
      category: 'mirror',
      seq: ++seq,
      projectRevision: rev,
      component: SENSOR,
      control: { params },
    }),
  ).toMatchObject({ accepted: true });
}

/** `n` lines matching `re` after `from` characters of serial output. */
async function nextLines(s: HostSession, re: RegExp, n: number, from: number, ms = 180_000) {
  let got: RegExpMatchArray[] = [];
  await waitEvent(
    s,
    () => {
      got = [...serialText(s).slice(from).matchAll(re)];
      return got.length >= n;
    },
    ms,
  );
  return got.slice(0, n);
}

async function stop(s: HostSession) {
  expect(s.status().state).toBe('running');
  s.stop();
  await waitEvent(
    s,
    (e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'),
    30_000,
  );
  await s.done();
}

/** Readings (µs, call duration µs) at one environment: the one in flight skipped, then three. */
async function readingsAt(s: HostSession, distance: number, airTemperature: number) {
  mirror(s, { distance, airTemperature });
  const lines = await nextLines(s, /^D (-?\d+) (\d+)\r?$/gm, 4, serialText(s).length);
  return lines.slice(1).map((m) => ({ us: Number(m[1]), callUs: Number(m[2]) }));
}

let arduino: BuildService | null = null;
async function startArduino(text: string): Promise<HostSession> {
  arduino ??= new BuildService(
    [
      new ArduinoEsp32Provider({
        profile: ESP32_ARDUINO_PROFILE,
        record: record as ArduinoProfileRecord,
        home: join(RT, 'arduino'),
        retainedOutputBytes: 256 * 1024,
        runtimeCapabilities: runtimeCaps(),
      }),
    ],
    new ArtifactStore({ dir: store, capBytes: 256 * 1024 * 1024, graceMs: 0 }),
    work,
    DEFAULT_LIMITS,
    {
      grants: new Grants(':memory:'),
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      ...openAccessPolicy(),
    },
  );
  const A = principalFor();
  const out = arduino.submit(
    {
      protocol: 'tbi-lab.build/1',
      profile: ESP32_ARDUINO_PROFILE.id,
      files: [{ name: 'sketch.ino', text }],
    },
    A,
  );
  if (!('cached' in out)) await arduino.whenIdle();
  const r = 'cached' in out ? out.cached : arduino.status(out.buildId, out.token, A)!.result!;
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
  const lease = arduino.lease(A, r.artifact!.sha256, 600_000)!;
  const s = open(inoHost, {
    ...request(),
    protocol: PROTOCOL,
    artifact: { sha256: r.artifact!.sha256 },
    ticket: lease.ticket,
  });
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return s;
}

describe.skipIf(!stack)('MicroPython time_pulse_us with the HC-SR04 model (real QEMU)', () => {
  it('builds (time_pulse_us allowed) and reads the echo width within the timing contract from 2 cm to 4 m', async () => {
    assertProvisioned();
    const { s, build } = await stack!.run(mpyHost, probe(30_000), request());
    expect(build.features?.unsupported).toEqual([]);
    await waitEvent(s, () => serialText(s).includes('TBI-PULSE-READY'), 120_000);
    const rows: {
      distanceM: number;
      tempC: number;
      oracleUs: number | null;
      read: { us: number; callUs: number }[];
    }[] = [];
    for (const [distanceM, tempC] of [
      [0.02, 20],
      [0.05, 20],
      [0.1, 20],
      [0.2, 20],
      [0.5, 20],
      [1, 20],
      [2, 20],
      [3, 20],
      [4, 20],
      [1, -10],
      [1, 40],
      [0.01, 20],
      [5, 20],
      [0.5, 20],
    ] as const) {
      const read = await readingsAt(s, distanceM, tempC);
      rows.push({
        distanceM,
        tempC,
        oracleUs: hcsr04Echo(0n, 10, distanceM, tempC)?.widthUs ?? null,
        read,
      });
    }
    await stop(s);
    const errors = rows.flatMap((r) =>
      r.oracleUs === null ? [] : r.read.map((x) => x.us - r.oracleUs!),
    );
    evidence.accuracy = {
      rows,
      errorUs: { min: Math.min(...errors), max: Math.max(...errors), n: errors.length },
    };
    for (const r of rows) {
      if (r.oracleUs === null) {
        // No echo: "no pulse started" (−2), returned at the timeout (30 ms), not later.
        for (const x of r.read) {
          expect(x.us, `${r.distanceM} m`).toBe(-2);
          expect(x.callUs, `${r.distanceM} m call`).toBeGreaterThanOrEqual(30_000);
          expect(x.callUs, `${r.distanceM} m call`).toBeLessThan(31_000);
        }
      } else
        for (const x of r.read)
          expect(
            Math.abs(x.us - r.oracleUs),
            `${r.distanceM} m ${r.tempC} degC: ${x.us} vs ${r.oracleUs}`,
          ).toBeLessThanOrEqual(TIME_PULSE_TOLERANCE_US);
    }
  }, 900_000);

  it('a pulse longer than the timeout returns −1 after the timeout (no hang); a shorter one is read', async () => {
    const { s } = await stack!.run(mpyHost, probe(1000), request());
    await waitEvent(s, () => serialText(s).includes('TBI-PULSE-READY'), 120_000);
    const long = await readingsAt(s, 1, 20); // 5 831 µs echo
    const short = await readingsAt(s, 0.1, 20); // 583 µs echo
    await stop(s);
    evidence.timeout = { long, short };
    for (const x of long) {
      expect(x.us).toBe(-1);
      // The wait for the start (≈ 200 µs after the trigger) plus the 1 ms timeout.
      expect(x.callUs).toBeGreaterThanOrEqual(1000);
      expect(x.callUs).toBeLessThan(1400);
    }
    const oracle = hcsr04Echo(0n, 10, 0.1, 20)!.widthUs;
    for (const x of short)
      expect(Math.abs(x.us - oracle)).toBeLessThanOrEqual(TIME_PULSE_TOLERANCE_US);
  }, 900_000);

  it('mpy-distance-alarm prints the distances its Arduino twin prints; the LED lights below 20 cm', async () => {
    const run = async (lang: 'arduino' | 'micropython') => {
      const id = lang === 'arduino' ? 'esp32-distance-alarm' : 'mpy-distance-alarm';
      const text = example(id, FIXTURE).text;
      const s =
        lang === 'arduino'
          ? await startArduino(text)
          : (await stack!.run(mpyHost, text, request())).s;
      const out: Record<string, unknown> = {};
      for (const d of [0.5, 0.1, 5, 0.3]) {
        mirror(s, { distance: d, airTemperature: 20 });
        const lines = await nextLines(
          s,
          /^(Distance: [\d.]+ cm|No echo)\r?$/gm,
          3,
          serialText(s).length,
        );
        const last = lines.at(-1)![1]!;
        // The circuit's operating point after the program acted on these readings.
        const o: SolveSuccess = electrical(s).at(-1)!.o;
        out[String(d)] = {
          line: last,
          gpio2V: o.pins!.find((p) => p.gpio === 2)!.voltage,
          ledA: o.components.D1!.current,
        };
      }
      await stop(s);
      return out as Record<string, { line: string; gpio2V: number; ledA: number }>;
    };
    const ino = await run('arduino');
    const mpy = await run('micropython');
    evidence.example = { arduino: ino, micropython: mpy };
    expect(mpy['0.5']!.line).toMatch(/^Distance: 50\.\d cm$/);
    expect(mpy['0.1']!.line).toMatch(/^Distance: 10\.\d cm$/);
    expect(mpy['5']!.line).toBe('No echo');
    expect(mpy['0.3']!.line).toMatch(/^Distance: 30\.\d cm$/);
    for (const d of ['0.5', '0.1', '5', '0.3']) {
      const a = ino[d]!.line.match(/[\d.]+/)?.[0];
      const b = mpy[d]!.line.match(/[\d.]+/)?.[0];
      if (a === undefined) expect(mpy[d]!.line).toBe(ino[d]!.line);
      else
        expect(
          Math.abs(Number(a) - Number(b)),
          `${d} m: ${ino[d]!.line} / ${mpy[d]!.line}`,
        ).toBeLessThanOrEqual(0.25);
      // The LED: on below 20 cm only, in both languages.
      const lit = d === '0.1';
      for (const r of [ino[d]!, mpy[d]!]) {
        if (lit) expect(r.ledA, `${d} m`).toBeGreaterThan(1e-3);
        else expect(r.ledA, `${d} m`).toBeLessThan(1e-6);
      }
    }
  }, 900_000);

  /**
   * Phase 2: the edges of the range and ten independent runs per case. Each run is a fresh session
   * (fresh QEMU, same artifact) through the same scripted sequence; every reading (value and call
   * duration) must be identical across the ten runs, and within the bound of the oracle.
   */
  const EDGES: [number, number][] = [
    [0.0199, 20],
    [0.02, 20],
    [0.5, 20],
    [4, 20],
    [4.001, 20],
    [1, -10],
  ];
  it('edges (just under 2 cm, 2 cm, 4 m, just over 4 m) and timeouts: ten runs, identical', async () => {
    const runs: unknown[] = [];
    for (let k = 0; k < 10; k++) {
      const { s } = await stack!.run(mpyHost, probe(30_000), request());
      await waitEvent(s, () => serialText(s).includes('TBI-PULSE-READY'), 120_000);
      const rows: { distanceM: number; tempC: number; read: { us: number; callUs: number }[] }[] =
        [];
      for (const [distanceM, tempC] of EDGES)
        rows.push({ distanceM, tempC, read: await readingsAt(s, distanceM, tempC) });
      await stop(s);
      runs.push(rows);
      for (const r of rows) {
        const o = hcsr04Echo(0n, 10, r.distanceM, r.tempC)?.widthUs ?? null;
        for (const x of r.read)
          if (o === null) {
            expect(x.us, `${r.distanceM} m`).toBe(-2);
            expect(x.callUs).toBeLessThan(31_000);
          } else
            expect(Math.abs(x.us - o), `${r.distanceM} m: ${x.us} vs ${o}`).toBeLessThanOrEqual(
              TIME_PULSE_TOLERANCE_US,
            );
      }
    }
    evidence.edgesTenRuns = runs;
    for (const r of runs) expect(r).toEqual(runs[0]);
  }, 1_800_000);

  it('a pulse longer than the timeout: ten runs, identical (−1, same call duration)', async () => {
    const runs: unknown[] = [];
    for (let k = 0; k < 10; k++) {
      const { s } = await stack!.run(mpyHost, probe(1000), request());
      await waitEvent(s, () => serialText(s).includes('TBI-PULSE-READY'), 120_000);
      const long = await readingsAt(s, 1, 20);
      await stop(s);
      for (const x of long) expect(x.us).toBe(-1);
      runs.push(long);
    }
    evidence.timeoutTenRuns = runs;
    for (const r of runs) expect(r).toEqual(runs[0]);
  }, 1_800_000);
});
