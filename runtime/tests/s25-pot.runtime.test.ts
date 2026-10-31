/**
 * Sprint 25 (Phase 4): ESP32 + potentiometer on the real stack (real build service, Session Host,
 * QEMU Runtime v5), Arduino and MicroPython: esp32-pot-threshold / mpy-pot-threshold, the app's
 * requests (fixtures). The wiper (10 kΩ PTV09A across 3.3 V) feeds GPIO34, read as a DIGITAL level.
 *
 *   - 10 %: the wiper voltage is the reference engine's (to 1e-9 V), the firmware reports LEVEL=0;
 *   - turned live to 90 %: LEVEL=1, the LED current is the reference output-high operating point;
 *   - back to 10 %: LEVEL=0; to 90 % again: LEVEL=1;
 *   - then 50 % (between V_IL and V_IH): the ESP32 specifies no hysteresis (datasheet v5.3 Table
 *     5-3, TRM v5.9), so the previous HIGH is NOT kept: the next read ends the run by name
 *     (gpio_input_undefined, between_thresholds), never read as LOW or HIGH;
 *   - a run that STARTS at 50 % is refused the same way at its first read.
 * Analog input stays refused: no ADC scenario exists (BLOCKED, see SPRINT-25.md).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_ARDUINO_PROFILE } from '@tbi-lab/domain';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
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
import { MpyStack, example, runtimeCaps, terminal } from './s24-support.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const store = RT ? mkdtempSync(join('/var/tmp', 's25-pot-store-')) : '';
const work = RT ? mkdtempSync(join('/var/tmp', 's25-pot-work-')) : '';
const host = realHost(RT ? { artifactsDir: store } : {});
const mpy = RT ? new MpyStack() : null;
// The MicroPython builds land in the stack's own store: a host that serves them.
const mpyHost = mpy ? realHost({ artifactsDir: mpy.store, leaseMs: 600_000 }) : host;
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  await host.shutdown();
  if (mpyHost !== host) await mpyHost.shutdown();
  mpy?.cleanup();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
  if (RT) recordEvidence('s25-pot', { runtimeId: runtimeInfo().runtimeId, ...evidence });
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

type Lang = 'arduino' | 'micropython';
const FIXTURE: Record<Lang, [string, string]> = {
  arduino: ['esp32-pot-threshold', 's25-esp32-pot-threshold-session.json'],
  micropython: ['mpy-pot-threshold', 's25-mpy-pot-threshold-session.json'],
};

/** Build the example's program, lease it, start the app's request (optionally edited). */
async function start(lang: Lang, edit?: (r: CreateSessionRequest) => void, text?: string) {
  assertProvisioned();
  const [id, fixture] = FIXTURE[lang];
  const ex = example(id, fixture);
  if (lang === 'micropython') {
    const r = await mpy!.run(
      mpyHost,
      text ?? ex.text,
      ex.request as Omit<CreateSessionRequest, 'artifact' | 'ticket' | 'protocol'>,
    );
    evidence[`${lang}.features`] = r.build.features;
    if (edit) throw new Error('edit before run: use the Arduino path');
    return { s: r.s, req: r.req };
  }
  const svc = arduinoService();
  const out = svc.submit(
    {
      protocol: 'tbi-lab.build/1',
      profile: ESP32_ARDUINO_PROFILE.id,
      files: [{ name: 'sketch.ino', text: text ?? ex.text }],
    },
    A,
  );
  if (!('cached' in out)) await svc.whenIdle();
  const result = 'cached' in out ? out.cached : svc.status(out.buildId, out.token, A)!.result!;
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  evidence[`${lang}.features`] = result.features;
  const lease = svc.lease(A, result.artifact!.sha256, 600_000)!;
  const req: CreateSessionRequest = {
    ...(JSON.parse(JSON.stringify(ex.request)) as Omit<
      CreateSessionRequest,
      'artifact' | 'ticket'
    >),
    protocol: PROTOCOL,
    artifact: { sha256: result.artifact!.sha256 },
    ticket: lease.ticket,
  };
  edit?.(req);
  const s = open(host, req);
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return { s, req };
}

const outcomeOf = (e: unknown) => (e as { outcome: SolveSuccess }).outcome;

async function scenario(lang: Lang, text?: string) {
  const { s, req } = await start(lang, undefined, text);
  const rv = req.circuit.components.find((c) => c.type === 'component.potentiometer')!.id;
  const led = req.circuit.components.find((c) => c.type === 'component.led')!.id;
  let seq = 0;
  let rev = req.circuit.projectRevision;
  const ref = new EngineSession(req.circuit, { pins: req.attachments });
  ref.setPinMode(4, 'output-low');
  const wiperOf = (o: SolveSuccess) => o.pins!.find((p) => p.gpio === 34)!.voltage;
  const levels = () => (serialText(s).match(/LEVEL=[01]/g) ?? []).map((x) => Number(x.slice(6)));
  const turn = async (position: number, ledOn: boolean | null) => {
    const at = s.log.lastSeq;
    expect(
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component: rv,
        control: { params: { position } },
      }),
    ).toMatchObject({ accepted: true });
    ref.applyControl(rv, { params: { position } }, rev);
    const e = await waitEvent(
      s,
      (x) =>
        x.seq > at &&
        x.type === 'electrical' &&
        outcomeOf(x).appliedRevision === rev &&
        (ledOn === null || (outcomeOf(x).components[led]!.current ?? 0) > 1e-3 === ledOn),
      120_000,
    );
    return outcomeOf(e);
  };
  // 10 %: LOW.
  await waitEvent(s, () => /LEVEL=0/.test(serialText(s)), 240_000);
  const low = ref.solve();
  if (!low.ok) throw new Error('reference');
  const first = outcomeOf(
    s.log
      .since(0)
      .filter((e) => e.type === 'electrical')
      .at(-1),
  );
  expect(Math.abs(wiperOf(first) - wiperOf(low))).toBeLessThan(1e-9);
  // 3.3 V × 10 %, less the pad's datasheet input leakage (50 nA) through the divider: 0.3300 V.
  expect(wiperOf(first)).toBeCloseTo(0.33, 4);
  // 90 %: HIGH, the LED at the output-high operating point.
  const high = await turn(90, true);
  ref.setPinMode(4, 'output-high');
  const want = ref.solve();
  if (!want.ok) throw new Error('reference');
  expect(Math.abs(wiperOf(high) - wiperOf(want))).toBeLessThan(1e-9);
  expect(Math.abs(high.components[led]!.current! - want.components[led]!.current!)).toBeLessThan(
    1e-12,
  );
  await waitEvent(s, () => levels().at(-1) === 1, 120_000);
  // 10 % again: LOW; 90 % again: HIGH (both transitions in both directions).
  await turn(10, false);
  await waitEvent(s, () => levels().at(-1) === 0 && levels().length >= 3, 120_000);
  await turn(90, true);
  await waitEvent(s, () => levels().at(-1) === 1 && levels().length >= 4, 120_000);
  const n = levels().length;
  // 50 %: between V_IL and V_IH. No hysteresis is specified, so the HIGH just read is not kept:
  // the program's next read ends the run by name, with the solved wiper voltage.
  expect(
    s.submit({
      category: 'mirror',
      seq: ++seq,
      projectRevision: ++rev,
      component: rv,
      control: { params: { position: 50 } },
    }),
  ).toMatchObject({ accepted: true });
  const end = await terminal(s);
  expect(end).toMatchObject({
    state: 'failed',
    reason: 'electrical_error',
    detail: {
      code: 'gpio_input_undefined',
      param: 'gpio34',
      detail: { inputs: [{ gpio: 34, cause: 'between_thresholds' }] },
    },
  });
  const band = (end.detail as { detail: { inputs: { voltage: number }[] } }).detail.inputs[0]!
    .voltage;
  expect(band).toBeGreaterThan(0.825);
  expect(band).toBeLessThan(2.475);
  // No level was reported after the turn to 50 %.
  expect(levels().length).toBe(n);
  evidence[lang] = {
    levels: levels(),
    wiper: { low: wiperOf(first), high: wiperOf(high), band },
    refusedAtNs: (end.detail as { detail: { sinceNs: string } }).detail.sinceNs,
  };
}

describe.skipIf(!RT)('Sprint 25: ESP32 + potentiometer as a digital input (real QEMU)', () => {
  it('Arduino: LOW at 10 %, HIGH at 90 %, LOW, HIGH, then 50 % refused at the read; voltages = reference engine', async () => {
    await scenario('arduino');
  }, 900_000);

  it('MicroPython: the same circuit and the same observations', async () => {
    await scenario('micropython');
  }, 900_000);

  it('a run that starts between the thresholds is refused at the first read (no level invented)', async () => {
    const { s } = await start('arduino', (req) => {
      const rv = req.circuit.components.find((c) => c.type === 'component.potentiometer')!;
      rv.params.position = { value: 50, unit: 'percent' };
    });
    expect(await terminal(s)).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: {
        code: 'gpio_input_undefined',
        param: 'gpio34',
        detail: { inputs: [{ gpio: 34, cause: 'between_thresholds' }] },
      },
    });
    expect(serialText(s)).not.toMatch(/LEVEL=/);
  }, 600_000);
  it('an edge interrupt on the wiper pin: CHANGE runs its ISR at 90 %, and 50 % ends the run while it is armed', async () => {
    // No digitalRead at all: GPIO34 is watched only because an interrupt is attached to it.
    const sketch = [
      'volatile int edges = 0;',
      'void IRAM_ATTR onEdge() { edges++; }',
      'void setup() {',
      '  Serial.begin(115200);',
      '  pinMode(34, INPUT);',
      '  pinMode(4, OUTPUT);',
      '  attachInterrupt(digitalPinToInterrupt(34), onEdge, CHANGE);',
      '  Serial.println("IRQ-READY");',
      '}',
      'void loop() {',
      '  static int last = -1;',
      '  int n = edges;',
      '  if (n != last) { Serial.printf("EDGES=%d\\n", n); last = n; }',
      '  delay(5);',
      '}',
      '',
    ].join('\n');
    const { s, req } = await start('arduino', undefined, sketch);
    const rv = req.circuit.components.find((c) => c.type === 'component.potentiometer')!.id;
    const edges = () => (serialText(s).match(/EDGES=\d+/g) ?? []).map((x) => Number(x.slice(6)));
    await waitEvent(s, () => edges().at(-1) === 0, 240_000);
    let rev = req.circuit.projectRevision;
    let seq = 0;
    const turn = (position: number) =>
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component: rv,
        control: { params: { position } },
      });
    expect(turn(90)).toMatchObject({ accepted: true });
    await waitEvent(s, () => edges().at(-1) === 1, 120_000);
    expect(turn(10)).toMatchObject({ accepted: true });
    await waitEvent(s, () => edges().at(-1) === 2, 120_000);
    expect(turn(50)).toMatchObject({ accepted: true });
    const end = await terminal(s);
    expect(end).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: {
        code: 'gpio_input_undefined',
        param: 'gpio34',
        detail: { inputs: [{ gpio: 34, cause: 'between_thresholds' }] },
      },
    });
    expect(edges().at(-1)).toBe(2);
    evidence['arduino.irq'] = { edges: edges(), end: end.detail };
  }, 900_000);
  it('MicroPython Pin.irq on the wiper pin: the handler runs at 90 % and 10 %, and 50 % ends the run', async () => {
    const script = [
      'from machine import Pin',
      'import time',
      'edges = 0',
      'def on_edge(p):',
      '    global edges',
      '    edges += 1',
      'w = Pin(34, Pin.IN)',
      'w.irq(trigger=Pin.IRQ_RISING | Pin.IRQ_FALLING, handler=on_edge)',
      'last = -1',
      'while True:',
      '    n = edges',
      '    if n != last:',
      '        print("EDGES=%d" % n)',
      '        last = n',
      '    time.sleep_ms(5)',
      '',
    ].join('\n');
    const { s, req } = await start('micropython', undefined, script);
    const rv = req.circuit.components.find((c) => c.type === 'component.potentiometer')!.id;
    const edges = () => (serialText(s).match(/EDGES=\d+/g) ?? []).map((x) => Number(x.slice(6)));
    await waitEvent(s, () => edges().at(-1) === 0, 240_000);
    let rev = req.circuit.projectRevision;
    let seq = 0;
    const turn = (position: number) =>
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component: rv,
        control: { params: { position } },
      });
    expect(turn(90)).toMatchObject({ accepted: true });
    await waitEvent(s, () => edges().at(-1) === 1, 120_000);
    expect(turn(10)).toMatchObject({ accepted: true });
    await waitEvent(s, () => edges().at(-1) === 2, 120_000);
    expect(turn(50)).toMatchObject({ accepted: true });
    const end = await terminal(s);
    expect(end).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: {
        code: 'gpio_input_undefined',
        param: 'gpio34',
        detail: { inputs: [{ gpio: 34, cause: 'between_thresholds' }] },
      },
    });
    expect(edges().at(-1)).toBe(2);
    evidence['micropython.irq'] = { edges: edges(), end: end.detail };
  }, 900_000);
});
