/**
 * Sprint 15 (R4) curated PWM examples end to end on the REAL stack, minus the browser: each
 * example's own program is built by the real build service (pinned toolchain) configured with
 * Runtime v3's capabilities (the lease's ticket then `requires` pwm), and the exact request the
 * app sends (runtime/tests/fixtures, kept equal to the app by app/tests/runtime-fixtures.test.ts)
 * runs in the Session Host on real QEMU.
 *
 * - LED fade: the LED's published current is the time-average of the reference high point at the
 *   duty the pad reports (A1), below the peak, and changes as the sketch fades; never refused.
 * - Servo sweep: the SG90's commanded angle visits exactly the angles of the sketch's integer
 *   duties (1.0 / 2.0 / 1.5 ms requested; 3276 / 6553 / 4915 counts: 0 deg (clamped), 179.97, 89.99).
 * Skipped unless TBI_RUNTIME_HOME is set (needs the toolchain and Runtime v3).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import type { SolveSuccess } from '@tbi-lab/engine';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { Grants } from '../builder/grants.js';
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import record from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import { assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { principalFor, TEST_TICKET_KEY } from '../identity/test-gate.js';
import { openAccessPolicy } from '../policy/testing.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { stopped } from './r1-support.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const dirs: string[] = [];
const store = RT ? mkdtempSync(join('/var/tmp', 's15-ex-store-')) : '';
const work = RT ? mkdtempSync(join('/var/tmp', 's15-ex-work-')) : '';
dirs.push(store, work);
const host = realHost(RT ? { artifactsDir: store } : {});
afterAll(async () => {
  await host.shutdown();
  for (const d of dirs) if (d) rmSync(d, { recursive: true, force: true });
});

const caps = (): string[] =>
  (
    JSON.parse(readFileSync(join(RT, 'qemu-current', 'runtime.json'), 'utf8')) as {
      capabilities?: string[];
    }
  ).capabilities ?? [];

const A = principalFor();
let service: BuildService | null = null;
function buildService(): BuildService {
  if (service) return service;
  const grants = new Grants(':memory:');
  service = new BuildService(
    [
      new ArduinoEsp32Provider({
        profile: ESP32_ARDUINO_PROFILE,
        record: record as ArduinoProfileRecord,
        home: join(RT, 'arduino'),
        retainedOutputBytes: 256 * 1024,
        runtimeCapabilities: caps(),
      }),
    ],
    new ArtifactStore({ dir: store, capBytes: 256 * 1024 * 1024, graceMs: 0 }),
    work,
    DEFAULT_LIMITS,
    { grants, ticketKey: TEST_TICKET_KEY, systemKeys: new Set(), ...openAccessPolicy() },
  );
  return service;
}

const evidence: Record<string, unknown> = {};

/** Build the example's program, lease it, and start the app's request for it. */
async function start(
  example: string,
  fixture: string,
): Promise<{ s: HostSession; req: CreateSessionRequest }> {
  assertProvisioned();
  const doc = JSON.parse(
    readFileSync(new URL(`../../app/src/examples/data/${example}.json`, import.meta.url), 'utf8'),
  ) as { programs: Record<string, { fileName: string; text: string }> };
  const p = Object.values(doc.programs)[0]!;
  const svc = buildService();
  const out = svc.submit(
    {
      protocol: 'tbi-lab.build/1',
      profile: ESP32_ARDUINO_PROFILE.id,
      files: [{ name: p.fileName, text: p.text }],
    },
    A,
  );
  if (!('cached' in out)) await svc.whenIdle();
  const result = 'cached' in out ? out.cached : svc.status(out.buildId, out.token, A)!.result!;
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  const sha = result.artifact!.sha256;
  const lease = svc.lease(A, sha, 600_000)!;
  expect(lease).not.toBeNull();
  evidence[example] = { sha256: sha, features: result.features };
  const fx = JSON.parse(
    readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'),
  ) as {
    request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>;
  };
  const req: CreateSessionRequest = {
    ...fx.request,
    protocol: PROTOCOL,
    artifact: { sha256: sha },
    ticket: lease.ticket,
  };
  const s = open(host, req);
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return { s, req };
}

import { reference } from '../host/tests/r1-support.js';

describe.skipIf(!RT)('Sprint 15 PWM examples on the real stack', () => {
  afterAll(() =>
    recordEvidence('s15-examples', { runtimeId: runtimeInfo().runtimeId, ...evidence }),
  );

  it('LED fade: average = duty x reference high-point current; it fades; pwm is required', async () => {
    const { s, req } = await start('esp32-led-fade', 's15-led-fade-session.json');
    const led = req.circuit.components.find((c) => c.type === 'component.led')!.id;
    const high = reference(req, { 18: 'output-high' }).components[led]!.current!;
    const samples: { duty: number; avg: number; peak: number }[] = [];
    await waitEvent(
      s,
      (e) => {
        if (e.type !== 'electrical') return false;
        const o = (e as unknown as { outcome: SolveSuccess }).outcome;
        const pin = o.pins?.find((p) => p.gpio === 18);
        const r = o.components[led];
        if (pin?.pwm && r?.pwm && r.current !== null)
          samples.push({ duty: pin.pwm.duty, avg: r.current, peak: r.pwm.peakCurrent ?? NaN });
        return samples.length >= 20;
      },
      300_000,
    );
    for (const x of samples) {
      expect(x.avg).toBeCloseTo(x.duty * high, 12);
      expect(x.peak).toBeCloseTo(high, 12);
    }
    expect(new Set(samples.map((x) => x.duty)).size).toBeGreaterThan(5); // it fades
    expect(s.status().state).toBe('running'); // duty 0 never reached: not refused
    expect(
      (evidence['esp32-led-fade'] as { features: { requires?: string[] } }).features.requires,
    ).toEqual(['pwm']);
    evidence['esp32-led-fade-samples'] = samples.slice(0, 20);
    await stopped(s);
  });

  it('servo sweep: commanded angles are exactly those of the integer duties', async () => {
    const { s, req } = await start('esp32-servo-sweep', 's15-servo-sweep-session.json');
    const m = req.circuit.components.find((c) => c.type === 'component.servo_sg90')!.id;
    const seen = new Set<number>();
    await waitEvent(
      s,
      (e) => {
        if (e.type !== 'electrical') return false;
        const st = (e as unknown as { outcome: SolveSuccess }).outcome.components[m]?.state;
        if (typeof st?.commandedDeg === 'number') seen.add(Math.round(st.commandedDeg * 100) / 100);
        return seen.has(0) && seen.has(179.97) && seen.has(89.99);
      },
      400_000,
    );
    // width = counts x 6250 / 256 / 80 MHz; angle = (width - 1000 us) / 1000 us x 180, clamped.
    const deg = (counts: number) =>
      Math.max(0, (((counts * 6250e3) / 256 / 80e6 - 1000) / 1000) * 180);
    expect(deg(3276)).toBe(0);
    expect(Math.round(deg(6553) * 100) / 100).toBe(179.97);
    expect(Math.round(deg(4915) * 100) / 100).toBe(89.99);
    evidence['esp32-servo-sweep-angles'] = [...seen].sort((a, b) => a - b);
    await stopped(s);
  });
});
