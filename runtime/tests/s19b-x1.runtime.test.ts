/**
 * Sprint 19B, Exploration Foundation acceptance project X1 on the REAL stack, minus the browser:
 * the `esp32-logic-and` example's own sketch (LogicAndReadback.ino) built by the real build
 * service (pinned toolchain), run by the Session Host on real QEMU (Runtime v3), with the exact
 * request the app sends (fixtures/s19b-logic-and-session.json, kept equal to the app by
 * app/tests/runtime-fixtures.test.ts).
 *
 * Sprint 28: under the owner rules S22-F3/Q1 the session was refused at creation; Sprint 29
 * (S29-D1) it is created and the refusal comes at GPIO18's drive (Q7, see the test);
 * the S19B behaviour below is what the example did before those rules:
 * - button released: the gate's B input is LOW (10 kΩ pull-down), the output LOW whatever GPIO18
 *   does; the firmware reads GPIO4 = 0 on every line;
 * - button held (a transient press): the output follows GPIO18, and the firmware's read-back,
 *   taken right after each digitalWrite, equals what it wrote on EVERY line. The gate's real
 *   propagation delay is a few ns, far below the next instruction: a lagging read-back would be
 *   an invented delay;
 * - the electrical results: the gate HIGH lights the LED (a few mA), LOW leaves it dark;
 * - determinism: the serial transcript of a second identical run is identical.
 * Skipped unless TBI_RUNTIME_HOME is set (needs the toolchain and Runtime v3).
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
import { open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { terminal } from './s24-support.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const store = RT ? mkdtempSync(join('/var/tmp', 's19b-x1-store-')) : '';
const work = RT ? mkdtempSync(join('/var/tmp', 's19b-x1-work-')) : '';
const host = realHost(RT ? { artifactsDir: store } : {});
afterAll(async () => {
  await host.shutdown();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
});

const A = principalFor();
const caps = (): string[] =>
  (
    JSON.parse(readFileSync(join(RT, 'qemu-current', 'runtime.json'), 'utf8')) as {
      capabilities?: string[];
    }
  ).capabilities ?? [];

async function x1(): Promise<{ s: ReturnType<typeof open>; req: CreateSessionRequest }> {
  assertProvisioned();
  const doc = JSON.parse(
    readFileSync(
      new URL('../../app/src/examples/data/esp32-logic-and.json', import.meta.url),
      'utf8',
    ),
  ) as { programs: Record<string, { fileName: string; text: string }> };
  const p = Object.values(doc.programs)[0]!;
  const svc = new BuildService(
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
    {
      grants: new Grants(':memory:'),
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      ...openAccessPolicy(),
    },
  );
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
  // Only modelled facilities: nothing refused at build.
  expect(result.features?.unsupported ?? []).toEqual([]);
  const lease = svc.lease(A, result.artifact!.sha256, 600_000)!;
  const fx = JSON.parse(
    readFileSync(new URL('./fixtures/s19b-logic-and-session.json', import.meta.url), 'utf8'),
  ) as { request: Omit<CreateSessionRequest, 'artifact' | 'ticket'> };
  const req: CreateSessionRequest = {
    ...fx.request,
    protocol: PROTOCOL,
    artifact: { sha256: result.artifact!.sha256 },
    ticket: lease.ticket,
  };
  return { s: open(host, req), req };
}

describe.skipIf(!RT)('X1 on the real stack (Runtime v5, real QEMU)', () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => recordEvidence('s19b-x1', { runtimeId: runtimeInfo().runtimeId, ...evidence }));

  // Sprint 29 (owner decision S29-D1): before setup() A and B sit on their 10 kΩ pull-downs,
  // within 0.6 V of GND, so the AND gate's I_CC is bounded by ΔI_CC and the session is CREATED
  // and runs (Sprint 28 refused it at creation under strict S22-Q1). Once the sketch drives
  // GPIO18 into its pull-down, the pad carries more than leakage-level current; an ESP32 output's
  // level is guaranteed only at leakage-level current (owner decision Q7) → refused by name,
  // naming GPIO18 — what the staging browser spec s19b-real asserts. Deterministic on two runs.
  it('S29-D1: created and running; driving GPIO18 into its pull-down refused by name (Q7): logic_mcu_output_uncharacterized, identical on two runs', async () => {
    const details: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { s } = await x1();
      expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
      expect(s.run()).toEqual({ ok: true });
      const end = await terminal(s);
      expect(end).toMatchObject({
        state: 'failed',
        reason: 'electrical_error',
        detail: { code: 'logic_mcu_output_uncharacterized' },
      });
      const d = end.detail as { code: string; components?: string[]; detail?: { gpio?: number } };
      expect(JSON.stringify(d)).toContain('gpio18');
      details.push(JSON.stringify(d));
      evidence[`run${run}`] = d;
      await s.done();
    }
    expect(details[1]).toBe(details[0]);
  });
});
