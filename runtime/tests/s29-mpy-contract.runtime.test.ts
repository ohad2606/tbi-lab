/**
 * Sprint 29 (Workstream A): the MicroPython support contract's last untested entries, on the
 * genuine interpreter in QEMU (Runtime v5):
 * - machine.Signal (invert=True) DRIVES a pad: SUPPORTED, the LED follows the inverted value (a
 *   read back through Signal.value() is not resolved to a pin by the Build analysis, so the run
 *   watches every pad and is refused at the read while any is unconnected: fail closed);
 * - PWM.duty() (the 10-bit spelling, 0..1023): SUPPORTED, LED average = duty/1024 × ON current;
 * - Pin.irq with a LEVEL trigger: REFUSED by name at the access (unmodelled interrupt);
 *   never a silently accepted handler that does not fire.
 * The contract itself: runtime/builder/pyContract.ts (unit-tested against the Build analysis).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_MICROPYTHON_PROFILE } from '@tbi-lab/domain';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { Grants } from '../builder/grants.js';
import { MicroPythonProvider, type MicroPythonProfileRecord } from '../builder/micropython.js';
import record from '../builder/profiles/esp32-micropython-1.29.json' with { type: 'json' };
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import { recordEvidence } from '../harness/env.js';
import { principalFor, TEST_TICKET_KEY } from '../identity/test-gate.js';
import { openAccessPolicy } from '../policy/testing.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { serialMatches } from './s24-support.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const V4 = (process.env.TBI_QEMU ?? '').length > 0;
const store = RT ? mkdtempSync(join('/var/tmp', 's29-mpy-store-')) : '';
const work = RT ? mkdtempSync(join('/var/tmp', 's29-mpy-work-')) : '';
const host = realHost(RT ? { artifactsDir: store } : {});
afterAll(async () => {
  await host.shutdown();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
});

const A = principalFor();
let svc: BuildService | null = null;
const service = () => (svc ??= newService(store, work));
const newService = (storeDir: string, workDir: string) =>
  new BuildService(
    [
      new MicroPythonProvider({
        profile: ESP32_MICROPYTHON_PROFILE,
        record: record as MicroPythonProfileRecord,
        home: join(RT, 'micropython'),
      }),
    ],
    new ArtifactStore({ dir: storeDir, capBytes: 256 * 1024 * 1024, graceMs: 0 }),
    workDir,
    DEFAULT_LIMITS,
    {
      grants: new Grants(':memory:'),
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      ...openAccessPolicy(),
    },
  );

async function build(text: string, s = service()) {
  const out = s.submit(
    {
      protocol: 'tbi-lab.build/1',
      profile: ESP32_MICROPYTHON_PROFILE.id,
      files: [{ name: 'main.py', text }],
    },
    A,
  );
  if (!('cached' in out)) await s.whenIdle();
  const r = 'cached' in out ? out.cached : s.status(out.buildId, out.token, A)!.result!;
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
  return r;
}

/** The LED-fade circuit (GPIO18 -> 220 Ω -> red LED -> GND), as the app sends it. */
const fixture = (file = 's15-led-fade-session.json') =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')) as {
    request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>;
  };

async function run(
  text: string,
  file?: string,
): Promise<{ s: HostSession; req: CreateSessionRequest }> {
  const r = await build(text);
  const lease = service().lease(A, r.artifact!.sha256, 600_000)!;
  const req: CreateSessionRequest = {
    ...fixture(file).request,
    protocol: PROTOCOL,
    artifact: { sha256: r.artifact!.sha256 },
    ticket: lease.ticket,
  };
  const s = open(host, req);
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return { s, req };
}
const terminal = (s: HostSession, ms = 240_000) =>
  waitEvent(s, (e) => e.type === 'state' && (e.state === 'failed' || e.state === 'ended'), ms).then(
    () => s.status(),
  );

const ledCurrent = (e: { type: string }) =>
  e.type === 'electrical'
    ? ((e as unknown as { outcome: SolveSuccess }).outcome.components.D1?.current ?? null)
    : null;

/** The engine's own LED current with GPIO18 driven HIGH (the reference ON current). */
function onCurrent(req: CreateSessionRequest): number {
  const e = new EngineSession(req.circuit, { pins: req.attachments });
  e.setPinMode(18, 'output-high');
  const o = e.solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o.components.D1!.current!;
}

const SIGNAL = `from machine import Pin, Signal
import time
s = Signal(Pin(18, Pin.OUT), invert=True)
s.on()
print('SIG-ON')
time.sleep_ms(300)
s.off()
print('SIG-OFF')
while True:
    time.sleep_ms(100)
`;
const DUTY = `from machine import Pin, PWM
import time
p = PWM(Pin(18), freq=1000, duty=512)
print('DUTY', p.duty())
while True:
    time.sleep_ms(100)
`;
const LEVEL = `from machine import Pin
import time
b = Pin(34, Pin.IN)
b.irq(handler=lambda p: print('LEVEL-IRQ'), trigger=4)
print('ARMED')
while True:
    time.sleep_ms(100)
`;

describe.skipIf(!RT || !V4)('Sprint 29: MicroPython contract entries on the real stack', () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => recordEvidence('s29-mpy-contract', evidence));

  it('machine.Signal(invert=True): on() drives the pad LOW (LED off), off() drives it HIGH (LED on)', async () => {
    const { s, req } = await run(SIGNAL);
    await serialMatches(s, /SIG-ON\r\n/, 120_000);
    await waitEvent(s, (e) => (ledCurrent(e) ?? 1) < 1e-9, 60_000);
    await serialMatches(s, /SIG-OFF\r\n/, 120_000);
    const on = onCurrent(req);
    await waitEvent(s, (e) => Math.abs((ledCurrent(e) ?? 0) - on) <= on * 1e-9, 60_000);
    expect(s.status().state).toBe('running');
    evidence.signal = { onA: on, serial: serialText(s).slice(-120) };
    s.stop();
    await terminal(s);
    await s.done();
  }, 600_000);

  it('PWM.duty(512) (10-bit spelling): LED average = 512/1024 × the ON current', async () => {
    const { s, req } = await run(DUTY);
    await serialMatches(s, /DUTY 512\r\n/, 120_000);
    const want = (512 / 1024) * onCurrent(req);
    await waitEvent(s, (e) => Math.abs((ledCurrent(e) ?? 0) - want) <= want * 1e-3, 60_000);
    expect(s.status().state).toBe('running');
    evidence.duty = { wantA: want, serial: serialText(s).slice(-80) };
    s.stop();
    await terminal(s);
    await s.done();
  }, 600_000);

  it('Pin.irq with a level trigger (trigger=4, GPIO_INTR_LOW_LEVEL; MicroPython 1.29 has no IRQ_*_LEVEL constant) is refused by name at the access (unmodelled interrupt), before the handler is armed', async () => {
    const { s } = await run(LEVEL, 's24-mpy-button-session.json');
    const st = await terminal(s);
    expect(st).toMatchObject({
      state: 'failed',
      reason: 'unsupported_feature',
      detail: { unmodelled: 'interrupt' },
    });
    expect(serialText(s)).not.toMatch(/LEVEL-IRQ|ARMED|Guru Meditation/);
    evidence.levelIrq = { status: st, serial: serialText(s).slice(-200) };
    await s.done();
  }, 600_000);
});
