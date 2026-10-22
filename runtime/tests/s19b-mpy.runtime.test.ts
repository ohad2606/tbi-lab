/**
 * Sprint 19B, MicroPython M1 on the REAL stack: the GENUINE MicroPython ESP32_GENERIC v1.29.0
 * interpreter, its program delivered as main.py by the real build provider (MicroPythonProvider:
 * tbi-mklfs from the interpreter's own littlefs, the pinned interpreter image), run by the Session
 * Host on real QEMU Runtime v4 (capability `unmodelled`). Needs TBI_RUNTIME_HOME with the
 * MicroPython build home (provision.sh micropython-tools) and TBI_QEMU = a Runtime v4 binary.
 *
 * - GPIO and high-speed PWM: the LED on GPIO18 averages EXACTLY duty × its high-point current at
 *   each duty the program sets (8192 / 16384 / 32768 / 49152 of 65536);
 * - run-time refusals (Runtime v4 `U` frames), each at the access, named, before dead or crashed
 *   behaviour: ADC (`adc`), Pin.irq (`interrupt`), machine.freq lowered (`cpu_frequency`);
 * - no false refusal: the PWM program boots and runs to the end without any `U`;
 * - determinism: the same program, run twice, gives the same serial transcript and the same
 *   electrical sequence;
 * - the build is byte-reproducible and every artifact requires `unmodelled`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_MICROPYTHON_PROFILE } from '@tbi-lab/domain';
import type { SolveSuccess } from '@tbi-lab/engine';
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
import { open, reference } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';

const RT = process.env.TBI_RUNTIME_HOME ?? '';
const V4 = (process.env.TBI_QEMU ?? '').length > 0;
const store = RT ? mkdtempSync(join('/var/tmp', 's19b-mpy-store-')) : '';
const work = RT ? mkdtempSync(join('/var/tmp', 's19b-mpy-work-')) : '';
const host = realHost(RT ? { artifactsDir: store } : {});
afterAll(async () => {
  await host.shutdown();
  for (const d of [store, work]) if (d) rmSync(d, { recursive: true, force: true });
});

const A = principalFor();
let svc: BuildService | null = null;
const service = () =>
  (svc ??= new BuildService(
    [
      new MicroPythonProvider({
        profile: ESP32_MICROPYTHON_PROFILE,
        record: record as MicroPythonProfileRecord,
        home: join(RT, 'micropython'),
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

async function build(text: string) {
  const s = service();
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
const fixture = () =>
  JSON.parse(
    readFileSync(new URL('./fixtures/s15-led-fade-session.json', import.meta.url), 'utf8'),
  ) as {
    request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>;
  };

async function run(text: string): Promise<{ s: HostSession; req: CreateSessionRequest }> {
  const r = await build(text);
  const lease = service().lease(A, r.artifact!.sha256, 600_000)!;
  const req: CreateSessionRequest = {
    ...fixture().request,
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

const PWM = readFileSync(new URL('./fixtures/mpy/p1_blink_pwm.py', import.meta.url), 'utf8');
const ADC = readFileSync(new URL('./fixtures/mpy/p2_adc.py', import.meta.url), 'utf8');
const IRQ = readFileSync(new URL('./fixtures/mpy/p3_irq.py', import.meta.url), 'utf8');
const FREQ =
  "import machine, time\nprint('F0', machine.freq())\nmachine.freq(80000000)\nprint('F1')\nwhile True:\n    time.sleep_ms(100)\n";

describe.skipIf(!RT || !V4)(
  'MicroPython on the real stack (genuine interpreter, Runtime v4)',
  () => {
    const evidence: Record<string, unknown> = {};
    afterAll(() => recordEvidence('s19b-mpy', evidence));

    it('the build is byte-reproducible and requires the unmodelled capability', async () => {
      const a = await build(PWM);
      expect(a.features?.requires).toEqual(['unmodelled']);
      // Same text again: the same artifact (the build cache would answer: check the bytes directly).
      const img = readFileSync(join(store, `${a.artifact!.sha256}.bin`));
      expect(createHash('sha256').update(img).digest('hex')).toBe(a.artifact!.sha256);
      // The Sprint 18 probe image of the same program (independently built): identical.
      expect(a.artifact!.sha256.slice(0, 8)).toBe('c79cf6e4');
      evidence.pwmImage = a.artifact!.sha256;
    });

    it('GPIO + high-speed PWM: LED average = duty × high-point current, exactly; no refusal; deterministic', async () => {
      const transcripts: string[] = [];
      const sequences: string[] = [];
      for (let k = 0; k < 2; k++) {
        const { s, req } = await run(PWM);
        const led = req.circuit.components.find((c) => c.type === 'component.led')!.id;
        const high = reference(req, { 18: 'output-high' }).components[led]!.current!;
        const seen = new Map<number, number>();
        const seq: string[] = [];
        await waitEvent(
          s,
          (e) => {
            if (e.type === 'electrical') {
              const o = (e as unknown as { outcome: SolveSuccess }).outcome;
              const pin = o.pins?.find((p) => p.gpio === 18);
              const r = o.components[led];
              if (pin?.pwm && r?.current != null) {
                seen.set(pin.pwm.duty, r.current);
                seq.push(`${pin.pwm.duty}:${r.current}`);
              }
            }
            return serialText(s).includes('MP-DONE');
          },
          240_000,
        );
        for (const d of [8192, 16384, 32768, 49152].map((n) => n / 65536)) {
          expect(seen.has(d), `duty ${d}`).toBe(true);
          expect(seen.get(d)!).toBeCloseTo(d * high, 12);
        }
        expect(s.status().state).toBe('running'); // no U frame, no refusal
        transcripts.push(serialText(s).replace(/MP-(START|DONE) \d+/g, 'MP-$1'));
        sequences.push(seq.join(','));
        evidence[`pwm${k}`] = Object.fromEntries(seen);
        s.stop();
        await terminal(s);
      }
      expect(transcripts[0]).toBe(transcripts[1]);
      expect(sequences[0]).toBe(sequences[1]);
    });

    for (const [name, program, facility] of [
      ['ADC (machine.ADC.read_u16)', ADC, 'adc'],
      ['GPIO interrupt (Pin.irq)', IRQ, 'interrupt'],
      ['a lowered CPU clock (machine.freq(80 MHz))', FREQ, 'cpu_frequency'],
    ] as const)
      it(`${name} is refused by name at the access (${facility})`, async () => {
        const { s } = await run(program);
        const st = await terminal(s);
        expect(st).toMatchObject({
          state: 'failed',
          reason: 'unsupported_feature',
          detail: { unmodelled: facility },
        });
        const since = BigInt((st.detail as { since: string }).since);
        evidence[facility] = { since: since.toString(), serial: serialText(s).slice(-200) };
        // Refused before any dead or crashed behaviour reached the user: no guest panic, no result.
        expect(serialText(s)).not.toMatch(/Guru Meditation|IRQ-COUNT|ADC-VAL|F1/);
      });
  },
);
