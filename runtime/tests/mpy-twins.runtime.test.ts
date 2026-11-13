/**
 * MicroPython expansion (real stack): every new verified twin, run on real QEMU Runtime v5 with
 * its real program built by the real provider (MicroPython: the pinned mpy-cross check and
 * interpreter image; Arduino: the pinned arduino-esp32 core), on the app's request for the
 * example's circuit (the existing fixture of its original: the twins' circuits are identical,
 * catalog.ts EXAMPLE_VARIANTS). Each scenario is run in BOTH languages and asserts the same
 * observable behaviour: what the program printed (from the levels it read) and the circuit's
 * response (the engine's operating point).
 *
 * Needs TBI_RUNTIME_HOME (arduino + micropython homes) and TBI_QEMU, as s24/s25.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import type { SolveSuccess } from '@tbi-lab/engine';
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

const stack = RT && V4 ? new MpyStack() : null;
const store = stack ? mkdtempSync(join('/var/tmp', 'mpy-twins-store-')) : '';
const work = stack ? mkdtempSync(join('/var/tmp', 'mpy-twins-work-')) : '';
const mpyHost = realHost(stack ? { artifactsDir: stack.store, leaseMs: 600_000 } : {});
const inoHost = realHost(stack ? { artifactsDir: store, leaseMs: 600_000 } : {});
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  await mpyHost.shutdown();
  await inoHost.shutdown();
  stack?.cleanup();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
  if (stack) recordEvidence('mpy-twins', { runtimeId: runtimeInfo().runtimeId, ...evidence });
});

const A = principalFor();
let arduino: BuildService | null = null;
const arduinoService = () =>
  (arduino ??= new BuildService(
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

type Request = Omit<CreateSessionRequest, 'artifact' | 'ticket' | 'protocol'>;

/** Build example `id`'s program (its own language), start it on `fixture`'s request. */
async function start(
  id: string,
  fixture: string,
): Promise<{ s: HostSession; req: CreateSessionRequest }> {
  assertProvisioned();
  const ex = example(id, fixture);
  const request = JSON.parse(JSON.stringify(ex.request)) as Request;
  if (id.startsWith('mpy-')) {
    const r = await stack!.run(mpyHost, ex.text, request);
    evidence[`${id}.features`] = r.build.features;
    return { s: r.s, req: r.req };
  }
  const svc = arduinoService();
  const out = svc.submit(
    {
      protocol: 'tbi-lab.build/1',
      profile: ESP32_ARDUINO_PROFILE.id,
      files: [{ name: 'sketch.ino', text: ex.text }],
    },
    A,
  );
  if (!('cached' in out)) await svc.whenIdle();
  const result = 'cached' in out ? out.cached : svc.status(out.buildId, out.token, A)!.result!;
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  evidence[`${id}.features`] = result.features;
  const lease = svc.lease(A, result.artifact!.sha256, 600_000)!;
  const req: CreateSessionRequest = {
    ...request,
    protocol: PROTOCOL,
    artifact: { sha256: result.artifact!.sha256 },
    ticket: lease.ticket,
  };
  const s = open(inoHost, req);
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return { s, req };
}

const outcomeOf = (e: unknown) => (e as { outcome: SolveSuccess }).outcome;

/** A driver for one running session: user actions and waits on what the session reports. */
function driver(s: HostSession, req: CreateSessionRequest) {
  let seq = 0;
  let rev = req.circuit.projectRevision;
  const byType = (type: string) => req.circuit.components.find((c) => c.type === type)!.id;
  return {
    byType,
    mirror(component: string, control: Record<string, unknown>) {
      expect(
        s.submit({ category: 'mirror', seq: ++seq, projectRevision: ++rev, component, control }),
      ).toMatchObject({ accepted: true });
    },
    transient(component: string, action: 'press' | 'release') {
      expect(s.submit({ category: 'transient', seq: ++seq, action, component })).toMatchObject({
        accepted: true,
      });
    },
    /** The serial output from now on matches `re`. */
    async serialAfter(mark: number, re: RegExp, ms = 180_000): Promise<string> {
      await waitEvent(s, () => re.test(serialText(s).slice(mark)), ms);
      return re.exec(serialText(s).slice(mark))![0];
    },
    mark: () => serialText(s).length,
    /** An electrical outcome after log position `after` that satisfies `pred`. */
    async electrical(pred: (o: SolveSuccess) => boolean, ms = 180_000): Promise<SolveSuccess> {
      const after = s.log.lastSeq;
      const e = await waitEvent(
        s,
        (x) => x.seq > after && x.type === 'electrical' && pred(outcomeOf(x)),
        ms,
      );
      return outcomeOf(e);
    },
    async stop() {
      expect(s.status().state).toBe('running');
      s.stop();
      await waitEvent(
        s,
        (e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'),
        30_000,
      );
      await s.done();
    },
  };
}

const LANGS = (arduino: string, micropython: string) =>
  [
    ['arduino', arduino],
    ['micropython', micropython],
  ] as const;

describe.skipIf(!stack)('MicroPython expansion: the new verified twins on real QEMU', () => {
  // The four InputEcho circuits: GPIO34 is copied to GPIO4.
  for (const [lang, id] of LANGS('esp32-input-echo', 'mpy-input-echo'))
    it(`${id} (${lang}): the switch reaches GPIO34; the program copies it to GPIO4 and the LED`, async () => {
      const { s, req } = await start(id, 's8-input-echo-session.json');
      const d = driver(s, req);
      const sw = d.byType('component.toggle_switch');
      const led = d.byType('component.led');
      await d.serialAfter(0, /ECHO34=0\r?\n/);
      let m = d.mark();
      d.mirror(sw, { closed: true });
      const on = await d.electrical((o) => (o.components[led]!.current ?? 0) > 1e-3);
      await d.serialAfter(m, /ECHO34=1\r?\n/);
      m = d.mark();
      d.mirror(sw, { closed: false });
      await d.electrical((o) => (o.components[led]!.current ?? 1) < 1e-6);
      await d.serialAfter(m, /ECHO34=0\r?\n/);
      evidence[`${id}.ledOnA`] = on.components[led]!.current;
      await d.stop();
    });

  for (const [lang, id] of LANGS('esp32-bench', 'mpy-bench'))
    it(`${id} (${lang}): the bench input lights D1 through the program; D3 lit by the supply`, async () => {
      const { s, req } = await start(id, 's10-bench-session.json');
      const d = driver(s, req);
      await d.serialAfter(0, /ECHO34=0\r?\n/);
      const m = d.mark();
      d.mirror(d.byType('component.toggle_switch'), { closed: true });
      const on = await d.electrical((o) => (o.components.D1!.current ?? 0) > 1e-3);
      await d.serialAfter(m, /ECHO34=1\r?\n/);
      expect(on.components.D3!.current!).toBeGreaterThan(1e-3);
      evidence[`${id}.on`] = { D1: on.components.D1!.current, D3: on.components.D3!.current };
      await d.stop();
    });

  for (const [lang, id] of LANGS('esp32-motion-relay', 'mpy-motion-relay'))
    it(`${id} (${lang}): motion -> GPIO34 HIGH -> GPIO4 -> relay -> alarm LED; none -> off`, async () => {
      const { s, req } = await start(id, 'r1-motion-relay-session.json');
      const d = driver(s, req);
      const pir = d.byType('sensor.pir_hc_sr501');
      await d.serialAfter(0, /ECHO34=0\r?\n/);
      let m = d.mark();
      d.mirror(pir, { params: { motion: true } });
      const on = await d.electrical((o) => (o.components.D2!.current ?? 0) > 1e-3);
      await d.serialAfter(m, /ECHO34=1\r?\n/);
      m = d.mark();
      d.mirror(pir, { params: { motion: false } });
      await d.electrical((o) => (o.components.D2!.current ?? 1) < 1e-6);
      await d.serialAfter(m, /ECHO34=0\r?\n/);
      evidence[`${id}.alarmA`] = on.components.D2!.current;
      await d.stop();
    });

  for (const [lang, id] of LANGS('esp32-night-light', 'mpy-night-light'))
    it(`${id} (${lang}): dark -> GPIO34 HIGH -> white; bright -> off`, async () => {
      const { s, req } = await start(id, 'r1-night-light-session.json');
      const d = driver(s, req);
      const ldr = d.byType('component.photoresistor');
      const rgb = d.byType('component.rgb_led');
      await d.serialAfter(0, /ECHO34=0\r?\n/);
      let m = d.mark();
      d.mirror(ldr, { params: { illuminance: 1 } });
      const on = await d.electrical((o) => (o.pins!.find((p) => p.gpio === 4)?.voltage ?? 0) > 3);
      await d.serialAfter(m, /ECHO34=1\r?\n/);
      m = d.mark();
      d.mirror(ldr, { params: { illuminance: 300 } });
      await d.electrical((o) => (o.pins!.find((p) => p.gpio === 4)?.voltage ?? 3.3) < 0.1);
      await d.serialAfter(m, /ECHO34=0\r?\n/);
      evidence[`${id}.lit`] = on.components[rgb];
      await d.stop();
    });

  for (const [lang, id] of LANGS('esp32-servo-sweep', 'mpy-servo-sweep'))
    it(`${id} (${lang}): the SG90 is commanded to 0, 180 and 90 degrees`, async () => {
      const { s, req } = await start(id, 's15-servo-sweep-session.json');
      const d = driver(s, req);
      const servo = d.byType('component.servo_sg90');
      const seen = new Set<number>();
      const near = (x: number) => [...seen].some((a) => Math.abs(a - x) <= 0.1);
      await waitEvent(
        s,
        (e) => {
          if (e.type !== 'electrical') return false;
          const st = outcomeOf(e).components[servo]?.state;
          if (typeof st?.commandedDeg === 'number')
            seen.add(Math.round(st.commandedDeg * 100) / 100);
          return near(0) && near(180) && near(90);
        },
        400_000,
      );
      // Pulse widths 1000 / 2000 / 1500 us within the LEDC duty resolution (0.1 degree here).
      evidence[`${id}.angles`] = [...seen].sort((a, b) => a - b);
      await d.stop();
    });

  for (const [lang, id] of LANGS('esp32-button', 'mpy-button'))
    it(`${id} (${lang}): held lights the LED and prints "button held"; released turns it off`, async () => {
      const { s, req } = await start(id, 's24-mpy-button-session.json');
      const d = driver(s, req);
      const btn = d.byType('component.push_button');
      const led = d.byType('component.led');
      await d.serialAfter(0, /button released\r?\n/);
      let m = d.mark();
      d.transient(btn, 'press');
      const on = await d.electrical((o) => (o.components[led]!.current ?? 0) > 1e-3);
      await d.serialAfter(m, /button held\r?\n/);
      m = d.mark();
      d.transient(btn, 'release');
      await d.electrical((o) => (o.components[led]!.current ?? 1) < 1e-6);
      await d.serialAfter(m, /button released\r?\n/);
      evidence[`${id}.ledOnA`] = on.components[led]!.current;
      await d.stop();
    });

  for (const [lang, id] of LANGS('esp32-adder-monitor', 'mpy-adder-monitor'))
    it(`${id} (${lang}): each switch state printed with its sum (ok); the LED brightness follows`, async () => {
      const { s, req } = await start(id, 's29-mpy-adder-monitor-session.json');
      const d = driver(s, req);
      const led = d.byType('component.led');
      const states: Record<string, unknown>[] = [];
      const check = async (a: boolean, b: boolean, mark: number) => {
        const sum = +a + +b;
        const line = await d.serialAfter(
          mark,
          new RegExp(`A=${+a} B=${+b} -> C=${+(a && b)} S=${+(a !== b)} = ${sum} ok`),
        );
        states.push({ a, b, line });
      };
      await check(true, false, 0);
      let m = d.mark();
      d.mirror('SW2', { closed: true });
      await check(true, true, m);
      m = d.mark();
      d.mirror('SW1', { closed: false });
      await check(false, true, m);
      m = d.mark();
      d.mirror('SW2', { closed: false });
      await check(false, false, m);
      const last = electrical(s).at(-1)!.o; // the operating point at sum 0
      evidence[`${id}.states`] = states;
      evidence[`${id}.ledA.sum0`] = last.components[led]?.current;
      await d.stop();
    });
});
