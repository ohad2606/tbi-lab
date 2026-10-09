/**
 * Sprint 12 curated examples end to end on the REAL stack, minus the browser (T-E2E-1..3 at the
 * service level): each example's own program is built by the real build service (pinned
 * toolchain) configured with Runtime v2's capabilities, the lease issues a real ticket (with
 * `requires` for Wire), and the exact request the app sends (runtime/tests/fixtures, checked
 * against the app by app/tests/runtime-fixtures.test.ts) runs in the Session Host on real QEMU.
 *
 * - distance alarm: the firmware prints the HC-SR04 distance of the oracle (us / 58) and lights
 *   the LED below 20 cm (live distance change);
 * - thermo-hygrometer: the firmware prints exactly the environment's temperature and humidity;
 * - LCD hello: the published LCD shows "Hello, ESP32!" and the uptime line.
 * Skipped unless TBI_RUNTIME_HOME is set (needs the toolchain and Runtime v2).
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
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { stopped } from './r1-support.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const dirs: string[] = [];
const store = RT ? mkdtempSync(join('/var/tmp', 's12-ex-store-')) : '';
const work = RT ? mkdtempSync(join('/var/tmp', 's12-ex-work-')) : '';
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

describe.skipIf(!RT)('Sprint 12 curated examples on the real stack', () => {
  afterAll(() =>
    recordEvidence('s12-examples', { runtimeId: runtimeInfo().runtimeId, ...evidence }),
  );

  it('distance alarm: the oracle distance on serial; below 20 cm the LED lights', async () => {
    const { s, req } = await start('esp32-distance-alarm', 's12-distance-alarm-session.json');
    const sonar = req.circuit.components.find((c) => c.type === 'sensor.hc_sr04')!.id;
    const led = req.circuit.components.find((c) => c.type === 'component.led')!.id;
    await waitEvent(s, () => /Distance: [\d.]+ cm/.test(serialText(s)), 180_000);
    // 0.5 m at 20 degC: echo 2911 us -> 50.2 cm with the sketch's us / 58.
    expect(serialText(s)).toMatch(/Distance: 50\.\d+ cm/);
    const rev = s.status().revisions.accepted + 1;
    expect(
      s.submit({
        category: 'mirror',
        seq: 1,
        projectRevision: rev,
        component: sonar,
        control: { params: { distance: 0.1 } },
      }),
    ).toMatchObject({ accepted: true });
    await waitEvent(
      s,
      (e) =>
        e.type === 'electrical' &&
        ((e as unknown as { outcome: SolveSuccess }).outcome.components[led]?.current ?? 0) > 1e-3,
      120_000,
    );
    expect(serialText(s)).toMatch(/Distance: 10\.\d+ cm/);
    await stopped(s);
  });

  it('thermo-hygrometer: the firmware prints exactly the environment', async () => {
    const { s, req } = await start('esp32-thermo-hygrometer', 's12-thermo-hygrometer-session.json');
    const u = req.circuit.components.find((c) => c.type === 'sensor.dht22')!;
    const t = (u.params.temperature as { value: number }).value;
    const rh = (u.params.humidity as { value: number }).value;
    await waitEvent(s, () => /Temperature: .*Humidity: .*/.test(serialText(s)), 180_000);
    const line = /Temperature: .*/.exec(serialText(s))![0];
    expect(line).toContain(t.toFixed(1));
    expect(line).toContain(rh.toFixed(1));
    await stopped(s);
  });

  it('LCD hello: the published LCD shows the firmware text; Wire is a requirement, not refused', async () => {
    const { s, req } = await start('esp32-lcd-hello', 's12-lcd-hello-session.json');
    const lcd = req.circuit.components.find((c) => c.type === 'display.lcd1602_i2c')!.id;
    const shows = (e: { type: string }) => {
      const st = (
        e as unknown as {
          outcome?: { components: Record<string, { state?: Record<string, unknown> }> };
        }
      ).outcome?.components[lcd]?.state;
      return (
        e.type === 'electrical' &&
        st?.line1 === 'Hello, ESP32!   ' &&
        /^Up: \d+ s/.test(String(st?.line2))
      );
    };
    await waitEvent(s, shows, 180_000);
    expect(
      (evidence['esp32-lcd-hello'] as { features: { requires?: string[] } }).features.requires,
    ).toEqual(['i2c']);
    await stopped(s);
  });
});
