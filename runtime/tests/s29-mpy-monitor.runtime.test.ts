/**
 * Sprint 29 (M4, real stack): mpy-adder-monitor on the genuine MicroPython interpreter in QEMU.
 *
 * Switches + logic + firmware in one session: the toggle switches A/B (session mirror commands)
 * feed a half adder of real single gates (four single gates — OR, NAND, AND for the sum, AND for the carry — solved by the engine
 * within the datasheet bounds); the ESP32 reads A, B, S and C on GPIO32..35 and prints each new
 * state; its PWM LED on GPIO18 shows the sum. Asserted per state: the line the program printed
 * (computed by the guest from the levels it READ), the pads' voltages, and the LED's average
 * current = the engine's own value at that duty.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import type { CreateSessionRequest } from '../host/protocol.js';
import { waitEvent } from '../host/tests/support.js';
import { realHost } from './r2-support.js';
import { MpyStack, RT, V4, electrical, example, serialMatches } from './s24-support.js';
import { recordEvidence } from '../harness/env.js';

const stack = RT && V4 ? new MpyStack() : null;
const host = realHost(stack ? { artifactsDir: stack.store, leaseMs: 600_000 } : {});
afterAll(async () => {
  await host.shutdown();
  stack?.cleanup();
});

/** The duty_u16 levels of mpy_adder_monitor.py for the sums 0, 1, 2. */
const LEVELS = [2048, 24576, 63488] as const;

function engineWith(
  req: CreateSessionRequest,
  closed: Record<string, boolean>,
  led: 'output-high' | 'output-low',
): SolveSuccess {
  const e = new EngineSession(req.circuit, { pins: req.attachments });
  let rev = 2;
  for (const [id, c] of Object.entries(closed)) {
    const err = e.applyControl(id, { closed: c }, rev++);
    if (err) throw new Error(JSON.stringify(err));
  }
  for (const g of [32, 33, 34, 35]) e.setPinMode(g, 'input');
  e.setPinMode(18, led);
  const o = e.solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
}

describe.skipIf(!stack)('Sprint 29 M4: MicroPython reads a logic half adder (real QEMU)', () => {
  it('each switch state: the guest prints the sum it read, it equals A + B, and the PWM LED averages duty × the engine’s ON current', async () => {
    const { text, request } = example('mpy-adder-monitor', 's29-mpy-adder-monitor-session.json');
    const { s, req } = await stack!.run(host, text, request);
    const led = req.circuit.components.find((c) => c.type === 'component.led')!.id;
    const states: Record<string, unknown>[] = [];
    let seq = 1;
    let rev = 2;
    const set = (closed: Record<string, boolean>) => {
      for (const [id, c] of Object.entries(closed))
        expect(
          s.submit({
            category: 'mirror',
            seq: seq++,
            projectRevision: rev++,
            component: id,
            control: { closed: c },
          }),
        ).toMatchObject({ accepted: true });
    };
    const check = async (a: boolean, b: boolean, closed: Record<string, boolean>) => {
      const sum = +a + +b;
      const c = +(a && b);
      const sBit = +(a !== b);
      const line = new RegExp(`A=${+a} B=${+b} -> C=${c} S=${sBit} = ${sum} ok\\r\\n`);
      await serialMatches(s, line, 120_000);
      // The LED's average at this state's duty (the guest sets it right after printing).
      const duty = LEVELS[sum]! / 65536;
      const on = engineWith(req, closed, 'output-high').components[led]!.current!;
      const off = engineWith(req, closed, 'output-low').components[led]!.current!;
      const want = duty * on + (1 - duty) * off;
      const got = await waitEvent(
        s,
        (e) =>
          e.type === 'electrical' &&
          Math.abs(
            ((e as unknown as { outcome: SolveSuccess }).outcome.components[led]?.current ?? -1) -
              want,
          ) <=
            want * 1e-3 + 1e-9,
        120_000,
      ).then(() => electrical(s).at(-1)!.o);
      const pin = (g: number) => got.pins!.find((p) => p.gpio === g)!.voltage;
      // The pads the guest read: guaranteed HIGH ≥ 0.75 × VDD, LOW ≤ 0.25 × VDD.
      for (const [g, v] of [
        [32, a],
        [33, b],
        [34, a !== b],
        [35, a && b],
      ] as const)
        if (v) expect(pin(g), `GPIO${g}`).toBeGreaterThan(0.75 * 3.3);
        else expect(pin(g), `GPIO${g}`).toBeLessThan(0.25 * 3.3);
      expect(got.components.U3!.logic!.gates[0]!.output.level).toBe(a !== b ? 'high' : 'low');
      expect(got.components.U4!.logic!.gates[0]!.output.level).toBe(a && b ? 'high' : 'low');
      states.push({
        a,
        b,
        printed: `A=${+a} B=${+b} -> C=${c} S=${sBit} = ${sum} ok`,
        duty: LEVELS[sum],
        ledA: got.components[led]!.current,
        wantA: want,
        gpio34: pin(34),
        gpio35: pin(35),
      });
    };
    // As shipped: A closed, B open.
    await check(true, false, { SW1: true, SW2: false });
    set({ SW2: true });
    await check(true, true, { SW1: true, SW2: true });
    set({ SW1: false });
    await check(false, true, { SW1: false, SW2: true });
    set({ SW2: false });
    await check(false, false, { SW1: false, SW2: false });
    expect(s.status().state).toBe('running');
    s.stop();
    await waitEvent(
      s,
      (e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'),
      30_000,
    );
    await s.done();
    recordEvidence('s29-mpy-adder-monitor', { states });
  }, 900_000);
});
