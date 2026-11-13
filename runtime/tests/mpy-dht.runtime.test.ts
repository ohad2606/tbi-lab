/**
 * MicroPython expansion phase 2 (real stack): the firmware's own `dht` module (DHT22) against the
 * Session Host's DHT22 model, the validation required before the Build analysis allows `import dht`.
 *
 * Real QEMU Runtime v5 with the genuine MicroPython 1.29 interpreter; the program is built by the
 * real MicroPython provider. `dht.DHT22.measure()` calls the firmware's C routine
 * `esp.dht_readinto` (open-drain start pulse, then a timed read of the 40 bits); the sensor's
 * answer is scheduled by the host at exact virtual times from the engine's `dht22Frame` /
 * `dht22Waveform` (the oracle). Nothing in the runtime, host or firmware changed.
 *
 * - Range: every reading's raw 5-byte frame equals the oracle frame, so temperature, humidity and
 *   the checksum are exact, from −40 °C / 0 %RH to 80 °C / 100 %RH, negative temperatures included.
 * - Determinism: the same scripted sweep run twice gives the same serial transcript.
 * - Error paths: a read within the sensor's 2 s collecting period gets no answer →
 *   OSError(errno.ETIMEDOUT, 116 in this firmware) after the driver's own 268 ms (250 ms high, 18 ms
 *   start pulse, then its response waits), never a hang; no sensor on the line → the same; no
 *   pull-up → the run is refused by name (gpio_input_undefined), as the Arduino read is. A checksum
 *   error cannot be produced: the model always sends a valid frame (the driver would raise
 *   Exception("checksum error"), printed as `X`, which no run shows).
 * - The shipped twin prints exactly what the Arduino example prints.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { dht22Frame } from '@tbi-lab/engine';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { Grants } from '../builder/grants.js';
import record from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import { assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import { principalFor, TEST_TICKET_KEY } from '../identity/test-gate.js';
import { openAccessPolicy } from '../policy/testing.js';
import { realHost } from './r2-support.js';
import { MpyStack, RT, V4, example, runtimeCaps } from './s24-support.js';

const SENSOR = 'U2';
const FIXTURE = 's12-thermo-hygrometer-session.json';

const stack = RT && V4 ? new MpyStack() : null;
const store = stack ? mkdtempSync(join('/var/tmp', 'mpy-dht-store-')) : '';
const work = stack ? mkdtempSync(join('/var/tmp', 'mpy-dht-work-')) : '';
const mpyHost = realHost(stack ? { artifactsDir: stack.store, leaseMs: 600_000 } : {});
const inoHost = realHost(stack ? { artifactsDir: store, leaseMs: 600_000 } : {});
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  await mpyHost.shutdown();
  await inoHost.shutdown();
  stack?.cleanup();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
  if (stack) recordEvidence('mpy-dht', { runtimeId: runtimeInfo().runtimeId, ...evidence });
});

type Request = Omit<CreateSessionRequest, 'artifact' | 'ticket' | 'protocol'>;
const request = () =>
  JSON.parse(JSON.stringify(example('esp32-thermo-hygrometer', FIXTURE).request)) as Request;

/** A probe: one read every `everyMs`, printing the raw frame or the error. */
const probe = (everyMs: number, firstDelayMs: number) => `import dht
import errno
from machine import Pin
import time
sensor = dht.DHT22(Pin(4))
print("TBI-DHT-READY ETIMEDOUT=%d" % errno.ETIMEDOUT)
time.sleep_ms(${firstDelayMs})
while True:
    t0 = time.ticks_us()
    try:
        sensor.measure()
        print("B %s %.1f %.1f" % (" ".join(str(b) for b in sensor.buf), sensor.temperature(), sensor.humidity()))
    except OSError as e:
        print("E %d %d" % (e.args[0], time.ticks_diff(time.ticks_us(), t0)))
    except Exception as e:
        print("X %s" % e)
    time.sleep_ms(${everyMs})
`;

const LINE = /^(B [\d ]+ -?[\d.]+ [\d.]+|E \d+ \d+|X .*)\r?$/gm;

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

async function nextLines(s: HostSession, re: RegExp, n: number, from: number, ms = 300_000) {
  let got: RegExpMatchArray[] = [];
  await waitEvent(
    s,
    () => {
      got = [...serialText(s).slice(from).matchAll(re)];
      return got.length >= n;
    },
    ms,
  );
  return got.slice(0, n).map((m) => m[1]!);
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

/** The oracle line for (tempC, rh): the frame, then the values as the driver computes them. */
const oracle = (tempC: number, rh: number) => {
  const f = dht22Frame(rh, tempC)!;
  const t = (((f[2]! & 0x7f) << 8) | f[3]!) * 0.1 * (f[2]! & 0x80 ? -1 : 1);
  const h = ((f[0]! << 8) | f[1]!) * 0.1;
  return `B ${f.join(' ')} ${t.toFixed(1)} ${h.toFixed(1)}`;
};

/** The DHT22's range corners and interior points, negative temperatures included. */
const POINTS: [number, number][] = [
  [21.5, 55],
  [-40, 0],
  [-39.9, 0.1],
  [-10, 30],
  [-0.1, 50],
  [0, 50],
  [0.1, 50],
  [25.6, 33.3],
  [60, 95],
  [80, 100],
];

async function sweep(): Promise<{ point: [number, number]; lines: string[] }[]> {
  const { s } = await stack!.run(mpyHost, probe(2100, 1200), request());
  await waitEvent(s, () => serialText(s).includes('TBI-DHT-READY'), 120_000);
  const rows: { point: [number, number]; lines: string[] }[] = [];
  for (const [t, rh] of POINTS) {
    mirror(s, { temperature: t, humidity: rh });
    // The read in flight may predate the change: skip it, then take two.
    const lines = await nextLines(s, LINE, 3, serialText(s).length);
    rows.push({ point: [t, rh], lines: lines.slice(1) });
  }
  await stop(s);
  return rows;
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

/** A circuit request (Circuit helper) without the artifact fields MpyStack.run adds. */
const circuitRequest = (c: Circuit): Request => {
  const { artifact: _a, ticket: _t, protocol: _p, ...rest } = c.request('0'.repeat(64));
  return rest;
};

describe.skipIf(!stack)('MicroPython dht.DHT22 with the DHT22 model (real QEMU)', () => {
  it('every reading is the oracle frame across the range (−40..80 °C, 0..100 %RH); two runs identical', async () => {
    assertProvisioned();
    const first = await sweep();
    const second = await sweep();
    evidence.range = first;
    evidence.rangeRepeat = second;
    for (const r of first)
      for (const l of r.lines) expect(l, `${r.point}`).toBe(oracle(...r.point));
    expect(second).toEqual(first);
  }, 1_800_000);

  it('ten independent runs of the same reads give identical frames and transcripts', async () => {
    const runs: string[][] = [];
    for (let k = 0; k < 10; k++) {
      const { s } = await stack!.run(mpyHost, probe(2100, 1200), request());
      await waitEvent(s, () => serialText(s).includes('TBI-DHT-READY'), 120_000);
      const lines = await nextLines(s, LINE, 2, 0);
      mirror(s, { temperature: -10.3, humidity: 47.9 });
      lines.push(...(await nextLines(s, LINE, 3, serialText(s).length)).slice(1));
      await stop(s);
      // The frames only: the error lines' call durations are not part of this comparison.
      runs.push(lines);
    }
    evidence.tenRuns = runs;
    for (const r of runs) {
      expect(r.slice(0, 2)).toEqual([oracle(21.5, 55), oracle(21.5, 55)]);
      expect(r.slice(2)).toEqual([oracle(-10.3, 47.9), oracle(-10.3, 47.9)]);
      expect(r).toEqual(runs[0]);
    }
  }, 1_800_000);

  it('a read within 2 s of the last gets no answer: OSError(ETIMEDOUT), the call returns', async () => {
    // A read every 0.6 s (+ the driver's 268 ms): only reads ≥ 2 s apart are answered.
    const { s } = await stack!.run(mpyHost, probe(600, 0), request());
    const lines = await nextLines(s, LINE, 8, 0);
    const etimedout = /ETIMEDOUT=(\d+)/.exec(serialText(s))![1]!;
    await stop(s);
    evidence.period = { etimedout, lines };
    expect(lines.filter((l) => l === oracle(21.5, 55)).length).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => l.startsWith('E ')).length).toBeGreaterThanOrEqual(4);
    for (const l of lines) {
      if (l.startsWith('E ')) {
        const [, code, us] = l.split(' ');
        expect(code).toBe(etimedout);
        expect(Number(us)).toBeLessThan(300_000);
      } else expect(l).toBe(oracle(21.5, 55));
    }
  }, 900_000);

  it('no sensor on the pulled-up line: OSError(ETIMEDOUT), every read, the call returns', async () => {
    const c = new Circuit().psu(3.3);
    const r = c.add('component.resistor');
    c.ohms(r, 10_000).wire(`${r}.a`, 'PSU1.positive').pad(4, `${r}.b`);
    const { s } = await stack!.run(mpyHost, probe(2100, 1200), circuitRequest(c));
    const lines = await nextLines(s, LINE, 3, 0);
    const etimedout = /ETIMEDOUT=(\d+)/.exec(serialText(s))![1]!;
    await stop(s);
    evidence.noSensor = { etimedout, lines };
    for (const l of lines) {
      const [kind, code, us] = l.split(' ');
      expect([kind, code]).toEqual(['E', etimedout]);
      expect(Number(us)).toBeLessThan(300_000);
    }
  }, 900_000);

  it('no pull-up: refused by name (gpio_input_undefined on GPIO4), no frame invented — as the Arduino read', async () => {
    const c = new Circuit().psu(3.3);
    const u = c.add('sensor.dht22');
    c.wire('PSU1.positive', `${u}.vdd`).wire(`${u}.gnd`, 'GND1.ref').pad(4, `${u}.data`);
    const { s } = await stack!.run(mpyHost, probe(2100, 1200), circuitRequest(c));
    await waitEvent(s, (e) => e.type === 'state' && e.state === 'failed', 300_000);
    evidence.noPullUp = s.status();
    expect(s.status()).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: { code: 'gpio_input_undefined', param: 'gpio4' },
    });
    expect(serialText(s)).not.toMatch(/^B /m);
    await s.done();
  }, 900_000);

  it('mpy-thermo-hygrometer prints exactly what esp32-thermo-hygrometer prints', async () => {
    const run = async (s: HostSession) => {
      const out: string[] = [];
      for (const [t, rh] of [
        [21.5, 55],
        [-10, 30],
        [60, 95],
      ] as const) {
        mirror(s, { temperature: t, humidity: rh });
        const lines = await nextLines(
          s,
          /^(Temperature: .*|DHT22 read failed.*)\r?$/gm,
          2,
          serialText(s).length,
        );
        out.push(lines[1]!);
      }
      await stop(s);
      return out;
    };
    const ino = await run(await startArduino(example('esp32-thermo-hygrometer', FIXTURE).text));
    const mpy = await run(
      (await stack!.run(mpyHost, example('mpy-thermo-hygrometer', FIXTURE).text, request())).s,
    );
    evidence.example = { arduino: ino, micropython: mpy };
    expect(ino).toEqual([
      'Temperature: 21.5 C  Humidity: 55.0 %',
      'Temperature: -10.0 C  Humidity: 30.0 %',
      'Temperature: 60.0 C  Humidity: 95.0 %',
    ]);
    expect(mpy).toEqual(ino);
  }, 900_000);
});
