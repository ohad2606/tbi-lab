/**
 * Sprint 24 (M3) on the REAL stack: MicroPython's hardware `machine.I2C` (the genuine v1.29.0
 * ESP-IDF driver) on real QEMU Runtime v4, through patch 0008's bus phases to the Session Host's
 * LCD1602 model (PCF8574 + HD44780), with the same electrical gating at every START as Arduino Wire
 * (wiring, pull-ups the solver sees, module power, address).
 *
 * - the mpy-lcd-hello example (a pure-Python HD44780 driver in main.py): the PUBLISHED LCD state
 *   (engine/runtime state, not serial) shows "Hello, ESP32!" and the uptime, exactly as the Arduino
 *   esp32-lcd-hello example's (s12-examples.runtime.test.ts asserts the same line 1); the build
 *   requires `i2c` (and `unmodelled`);
 * - scan() with the LCD: [0x27]; the pull-ups' supply off: [] and a write NACKs (OSError), with the
 *   host's `i2c_no_pullup` diagnostic; the module at another address (0x26): [0x26] and a write to
 *   0x27 NACKs;
 * - Build refusals, named, before any session: freq above 100 kHz (`i2c_frequency`), another bus,
 *   reads (`i2c_operation`), and I2C on a runtime without the `i2c` capability (`i2c`);
 * - determinism: the LCD state sequence and the serial transcript of two runs are identical.
 * Evidence: $TBI_RUNTIME_HOME/results/s24-i2c.json.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { SolveSuccess } from '@tbi-lab/engine';
import { recordEvidence } from '../harness/env.js';
import type { CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { MpyStack, RT, V4, example, serialMatches, sha } from './s24-support.js';
import { PROTOCOL } from '../host/protocol.js';
import { principalFor } from '../identity/test-gate.js';

const stack = RT && V4 ? new MpyStack() : null;
// Sessions here have no attached event stream: a long lease, so a slow (1 CPU) host never expires
// one mid-test (the lease is wall-clock and host-side; it never touches the simulated loop).
const host = realHost(stack ? { artifactsDir: stack.store, leaseMs: 600_000 } : {});
afterAll(async () => {
  await host.shutdown();
  stack?.cleanup();
});
const evidence: Record<string, unknown> = {};

const PROBE = `from machine import Pin, I2C
import time
i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
print("SCAN", i2c.scan())
try:
    i2c.writeto(0x27, bytes([0x00]))
    print("WRITE ok")
except OSError as e:
    print("WRITE", e)
print("DONE")
while True:
    time.sleep_ms(100)
`;

type Lcd = { backlight?: boolean; displayOn?: boolean; line1?: string; line2?: string };
const lcdStates = (s: HostSession, id: string): Lcd[] =>
  s.log
    .since(0)
    .filter((e) => e.type === 'electrical')
    .map((e) => (e as unknown as { outcome: SolveSuccess }).outcome.components[id]?.state as Lcd)
    .filter((x): x is Lcd => !!x);

async function stop(s: HostSession) {
  s.stop();
  await waitEvent(
    s,
    (e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'),
    30_000,
  );
  await s.done();
}

/** The LCD example's request with some component parameters changed. */
function variant(
  request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>,
  changes: Record<string, Record<string, unknown>>,
) {
  const r = structuredClone(request);
  for (const c of r.circuit.components)
    if (changes[c.id]) c.params = { ...c.params, ...changes[c.id] } as typeof c.params;
  return r;
}

describe.skipIf(!stack)('Sprint 24 MicroPython hardware I2C on the real stack (Runtime v4)', () => {
  afterAll(() => recordEvidence('s24-i2c', evidence));
  const { text: LCD_PY, request: LCD_REQ } = example(
    'mpy-lcd-hello',
    's24-mpy-lcd-hello-session.json',
  );
  const lcdId = LCD_REQ.circuit.components.find((c) => c.type === 'display.lcd1602_i2c')!.id;

  it('mpy-lcd-hello: the published LCD shows the program’s text; the build requires i2c', async () => {
    const runs: { seq: string; serial: string; firstHelloMs: number }[] = [];
    for (let k = 0; k < 2; k++) {
      const t0 = Date.now();
      const { s, build } = await stack!.run(host, LCD_PY, LCD_REQ);
      expect(build.features).toEqual({
        internalPull: [],
        gpioInterrupt: [],
        restart: false,
        unsupported: [],
        requires: ['i2c', 'unmodelled'],
      });
      const shows = () => {
        const st = lcdStates(s, lcdId).at(-1);
        return st?.line1 === 'Hello, ESP32!   ' && /^Up: [1-9]\d* s +$/.test(String(st?.line2));
      };
      await waitEvent(s, shows, 240_000);
      const firstHelloMs = Date.now() - t0;
      const st = lcdStates(s, lcdId).at(-1)!;
      expect(st).toMatchObject({ backlight: true, displayOn: true, line1: 'Hello, ESP32!   ' });
      expect(String(st.line2)).toHaveLength(16);
      expect(serialText(s)).toContain("I2C scan: ['0x27']");
      expect(serialText(s)).toContain('LCD ready');
      expect(s.status().state).toBe('running');
      // The display sequence up to "Up: 1 s" (deterministic: no wall-clock input).
      const states = lcdStates(s, lcdId);
      const upTo = states.findIndex((x) => x.line2?.startsWith('Up: 1 s'));
      runs.push({
        seq: sha(JSON.stringify(states.slice(0, upTo + 1))),
        serial: sha(serialText(s).slice(0, serialText(s).indexOf('LCD ready'))),
        firstHelloMs,
      });
      evidence[`lcd${k}`] = { last: st, states: upTo + 1, wallMs: firstHelloMs };
      await stop(s);
    }
    expect(runs[1]!.seq).toBe(runs[0]!.seq);
    expect(runs[1]!.serial).toBe(runs[0]!.serial);
    evidence.lcdDeterminism = runs;
  });

  for (const [name, changes, scan, write, diagnostic] of [
    ['the LCD at 0x27, pulled up', {}, '[39]', 'WRITE ok', null],
    [
      'the pull-ups unpowered (PSU2 off)',
      { PSU2: { outputEnabled: false } },
      '[]',
      /WRITE \[Errno \d+\] E\w+/,
      'i2c_no_pullup',
    ],
    [
      'the module at 0x26',
      { [lcdId]: { address: 'i2c.0x26' } },
      '[38]',
      /WRITE \[Errno \d+\] E\w+/,
      null,
    ],
  ] as const)
    it(`scan()/writeto() with ${name}: the bus answers as the circuit allows`, async () => {
      const { s } = await stack!.run(host, PROBE, variant(LCD_REQ, changes));
      await serialMatches(s, /DONE\r\n/, 180_000);
      const out = serialText(s);
      expect(out).toContain(`SCAN ${scan}\r\n`);
      if (typeof write === 'string') expect(out).toContain(write);
      else expect(out).toMatch(write);
      const diags = s.log
        .since(0)
        .filter((e) => e.type === 'diagnostic')
        .map((e) => (e as { code: string }).code);
      if (diagnostic) expect(diags).toContain(diagnostic);
      expect(s.status().state).toBe('running');
      evidence[`probe:${name}`] = { serial: out.slice(out.indexOf('SCAN')), diagnostics: diags };
      await stop(s);
    });

  it('Build refusals by name; the session never starts', async () => {
    const at = (args: string, extra = '') =>
      `from machine import Pin, I2C\ni2c = I2C(${args})\n${extra}`;
    const cases = [
      [at('0, scl=Pin(22), sda=Pin(21), freq=400000'), ['i2c_frequency']],
      [at('0, scl=Pin(22), sda=Pin(21)'), ['i2c_frequency']],
      [at('1, scl=Pin(22), sda=Pin(21), freq=100000'), ['i2c_bus']],
      [
        at('0, scl=Pin(22), sda=Pin(21), freq=100000', 'print(i2c.readfrom(0x27, 1))\n'),
        ['i2c_operation'],
      ],
      [
        'from machine import Pin, SoftI2C\nb = SoftI2C(scl=Pin(22), sda=Pin(21), freq=100000)\n',
        ['i2c'],
      ],
    ] as const;
    const refused: Record<string, unknown> = {};
    for (const [src, unsupported] of cases) {
      const r = await stack!.build(src);
      expect(r.features?.unsupported, src).toEqual(unsupported);
      const lease = stack!.service.lease(principalFor(), r.artifact!.sha256, 600_000)!;
      const s = open(host, {
        ...LCD_REQ,
        protocol: PROTOCOL,
        artifact: { sha256: r.artifact!.sha256 },
        ticket: lease.ticket,
      });
      expect(s.status()).toMatchObject({
        state: 'failed',
        reason: 'unsupported_feature',
        detail: { unsupported },
      });
      refused[src] = s.status().detail;
    }
    // A build service whose runtime lacks the i2c capability: machine.I2C stays refused as `i2c`.
    const noI2c = new MpyStack(['unmodelled']);
    try {
      const r = await noI2c.build(LCD_PY);
      expect(r.features).toMatchObject({ unsupported: ['i2c'], requires: ['unmodelled'] });
    } finally {
      noI2c.cleanup();
    }
    evidence.refusals = refused;
  });
});
