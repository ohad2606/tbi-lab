/**
 * Sprint 19B, Exploration Foundation acceptance project X1 on the REAL stack, minus the browser:
 * the `esp32-logic-and` example's own sketch (LogicAndReadback.ino) built by the real build
 * service (pinned toolchain), run by the Session Host on real QEMU (Runtime v3), with the exact
 * request the app sends (fixtures/s19b-logic-and-session.json, kept equal to the app by
 * app/tests/runtime-fixtures.test.ts).
 *
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

async function x1(): Promise<{ s: HostSession; req: CreateSessionRequest }> {
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
  const s = open(host, req);
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return { s, req };
}

/** The firmware's lines `A=<a> Y=<y>` so far. */
const lines = (s: HostSession) =>
  [...serialText(s).matchAll(/A=(\d) Y=(\d)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
const waitLines = (s: HostSession, n: number, timeoutMs = 120_000) =>
  waitEvent(s, () => lines(s).length >= n, timeoutMs);

describe.skipIf(!RT)('X1 on the real stack (Runtime v3, real QEMU)', () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => recordEvidence('s19b-x1', { runtimeId: runtimeInfo().runtimeId, ...evidence }));

  it('released: Y = 0 whatever A; held: Y = A on every line; the LED follows the gate', async () => {
    const transcripts: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { s } = await x1();
      // Released: 4 lines, A alternating, Y always 0.
      await waitLines(s, 4);
      const released = lines(s).slice(0, 4);
      expect(new Set(released.map(([a]) => a))).toEqual(new Set([0, 1]));
      expect(released.every(([, y]) => y === 0)).toBe(true);
      // Held from here (a transient press between two lines).
      const before = lines(s).length;
      expect(
        s.submit({ category: 'transient', seq: 1, action: 'press', component: 'SW1' }),
      ).toMatchObject({ accepted: true });
      const lit: number[] = [];
      await waitEvent(
        s,
        (e) => {
          if (e.type === 'electrical') {
            const o = (e as unknown as { outcome: SolveSuccess }).outcome;
            const g = o.components.U2;
            if (g?.state?.gateOutput === 'high') lit.push(o.components.D1!.current!);
          }
          return lines(s).length >= before + 6 && lit.length > 0;
        },
        120_000,
      );
      // The first line after the press may predate it; every later line reads back what it wrote.
      const held = lines(s).slice(before + 1, before + 6);
      expect(held.length).toBe(5);
      for (const [a, y] of held) expect(y, JSON.stringify(held)).toBe(a);
      expect(new Set(held.map(([a]) => a))).toEqual(new Set([0, 1]));
      for (const i of lit) {
        expect(i).toBeGreaterThan(3e-3);
        expect(i).toBeLessThan(6e-3);
      }
      evidence[`run${run}`] = { released, held, ledCurrentA: lit[0] };
      transcripts.push(
        lines(s)
          .slice(0, before + 6)
          .map(([a, y]) => `${a}${y}`)
          .join(','),
      );
      await stopped(s);
      expect(s.status().state).toBe('ended');
    }
    // Deterministic up to the press (whose virtual time depends on wall-clock submission): the
    // released prefix is identical.
    expect(transcripts[0]!.slice(0, 11)).toBe(transcripts[1]!.slice(0, 11));
  });
});
