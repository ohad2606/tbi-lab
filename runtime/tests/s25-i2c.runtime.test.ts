/**
 * Sprint 25 (Phase 2, Runtime v5 `i2c-clock`): the Arduino I2C contract on the real stack (real
 * build service, Session Host, QEMU Runtime v5), with the esp32-lcd-hello example (the app's
 * request, s12-lcd-hello-session.json):
 *   - as shipped (Wire.begin(21, 22, 100000)): every START carries the programmed SCL period, the
 *     derived clock is exactly 100 kHz (TRM v5.9 Table 21.3-1 with the IDF's register values), the
 *     display shows the text, nothing is refused;
 *   - Wire.setClock(400000): refused at the first START to the display, by name
 *     (i2c_clock_exceeded, 400 kHz > the PCF8574's 100 kHz), before any byte reaches it;
 *   - Wire.requestFrom(0x27, 1): refused at the read (i2c_read_unsupported): no byte is invented.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { Grants } from '../builder/grants.js';
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import record from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import { assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { principalFor, TEST_TICKET_KEY } from '../identity/test-gate.js';
import { openAccessPolicy } from '../policy/testing.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { runtimeCaps, terminal } from './s24-support.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const store = RT ? mkdtempSync(join('/var/tmp', 's25-i2c-store-')) : '';
const work = RT ? mkdtempSync(join('/var/tmp', 's25-i2c-work-')) : '';
const host = realHost(RT ? { artifactsDir: store } : {});
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  await host.shutdown();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
  if (RT) recordEvidence('s25-i2c', { runtimeId: runtimeInfo().runtimeId, ...evidence });
});

const A = principalFor();
let service: BuildService | null = null;
const svc = () =>
  (service ??= new BuildService(
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
  ));

const lcdSource = (): string => {
  const doc = JSON.parse(
    readFileSync(
      new URL('../../app/src/examples/data/esp32-lcd-hello.json', import.meta.url),
      'utf8',
    ),
  ) as { programs: Record<string, { text: string }> };
  return Object.values(doc.programs)[0]!.text;
};

async function start(text: string, label: string) {
  assertProvisioned();
  const s0 = svc();
  const out = s0.submit(
    {
      protocol: 'tbi-lab.build/1',
      profile: ESP32_ARDUINO_PROFILE.id,
      files: [{ name: 'sketch.ino', text }],
    },
    A,
  );
  if (!('cached' in out)) await s0.whenIdle();
  const result = 'cached' in out ? out.cached : s0.status(out.buildId, out.token, A)!.result!;
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  evidence[`${label}.features`] = result.features;
  const lease = s0.lease(A, result.artifact!.sha256, 600_000)!;
  const fx = JSON.parse(
    readFileSync(new URL('./fixtures/s12-lcd-hello-session.json', import.meta.url), 'utf8'),
  ) as { request: Omit<CreateSessionRequest, 'artifact' | 'ticket'> };
  const req: CreateSessionRequest = {
    ...fx.request,
    protocol: PROTOCOL,
    artifact: { sha256: result.artifact!.sha256 },
    ticket: lease.ticket,
  };
  const s = open(host, req);
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return { s, req, features: result.features };
}

describe.skipIf(!RT)('Sprint 25: Arduino I2C contract on Runtime v5 (real QEMU)', () => {
  it('the shipped example at 100 kHz: requires i2c-clock, shows its text, nothing refused', async () => {
    const { s, req, features } = await start(lcdSource(), 'shipped');
    expect(features?.requires).toEqual(expect.arrayContaining(['i2c', 'i2c-clock']));
    const lcd = req.circuit.components.find((c) => c.type === 'display.lcd1602_i2c')!.id;
    const e = await waitEvent(
      s,
      (x) =>
        x.type === 'electrical' &&
        /Hello/.test(
          String(
            (
              x as unknown as {
                outcome: { components: Record<string, { state?: { line1?: string } }> };
              }
            ).outcome.components[lcd]?.state?.line1 ?? '',
          ),
        ),
      240_000,
    );
    expect(e).toBeTruthy();
    expect(s.status().state).toBe('running');
    s.stop();
    expect(await terminal(s)).toMatchObject({ state: 'ended' });
  }, 900_000);

  it('Wire.setClock(400000): refused at the first START to the display, by name', async () => {
    const text = lcdSource().replace(
      'Wire.begin(21, 22, 100000);',
      'Wire.begin(21, 22, 100000);\n  Wire.setClock(400000);',
    );
    expect(text).toContain('Wire.setClock(400000);');
    const { s, req } = await start(text, 'fast');
    const lcd = req.circuit.components.find((c) => c.type === 'display.lcd1602_i2c')!.id;
    const st = await terminal(s);
    expect(st).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: { code: 'i2c_clock_exceeded', components: [lcd], detail: { max: 100_000 } },
    });
    const hz = (st.detail as { detail: { hz: number } }).detail.hz;
    expect(hz).toBeGreaterThan(100_000);
    evidence.fastHz = hz;
  }, 900_000);

  it('Wire.requestFrom on the display: refused at the read, no byte invented', async () => {
    const text = lcdSource().replace(
      'Wire.begin(21, 22, 100000);',
      'Wire.begin(21, 22, 100000);\n  Wire.requestFrom((uint8_t)0x27, (uint8_t)1);\n  Serial.printf("READ=%d\\n", Wire.read());',
    );
    const { s, req } = await start(text, 'read');
    const lcd = req.circuit.components.find((c) => c.type === 'display.lcd1602_i2c')!.id;
    expect(await terminal(s)).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: { code: 'i2c_read_unsupported', components: [lcd], detail: { address: 0x27 } },
    });
    expect(serialText(s)).not.toMatch(/READ=/);
  }, 900_000);
});
