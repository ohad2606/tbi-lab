/**
 * R1.10: UART0 serial. Guest output and input travel in the same ordered, simulation-timestamped
 * bridge stream as GPIO (no stdout parsing); buffers are bounded; guest serial and QEMU
 * diagnostics never mix. MicroPython provides a guest that consumes serial input.
 */
import { Circuit, GpioPin } from '@tbi-lab/engine';
import { describe, expect, it } from 'vitest';
import { runCircuitSession, serialLines } from '../harness/circuitSession.js';
import { QEMU, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';

const REPL =
  'from machine import Pin\r\np=Pin(32,Pin.OUT)\r\np.value(1)\r\nprint(6*7)\r\np.value(0)\r\n';

function micropython(input: string, atNs = 3_000_000_000n, endNs = 5_000_000_000n) {
  const fw = artifact('micropython');
  const c = new Circuit();
  const pin = c.add(new GpioPin('IO32', 'io32', 'input'));
  let sent = false;
  return runCircuitSession({
    qemu: QEMU,
    artifact: fw.path,
    artifactSha256: fw.sha256,
    circuit: c,
    pads: [{ pad: 32, pin, node: 'io32', input: false }],
    endNs,
    onTick: (vns) => {
      if (sent || vns < atNs) return [];
      sent = true;
      return [{ type: 'R', bytes: Buffer.from(input, 'latin1') }];
    },
  });
}

describe('R1.10 UART0 serial', () => {
  assertProvisioned();

  it('MicroPython REPL: serial input from the host is executed; output and GPIO interleave in simulation-time order', async () => {
    const r = await micropython(REPL);
    expect(r.session.outcome).toBe('completed');
    const lines = serialLines(r.serialTimeline);
    const text = lines.map((l) => l.text);
    expect(text.some((t) => t.startsWith('MicroPython v1.29.0'))).toBe(true);
    expect(text).toContain('42');
    const ev = r.padEvents.filter((e) => e.pad === 32);
    expect(ev.map((e) => `${e.drive}${e.level}`)).toEqual(['10', '11', '10']);
    // `42` leaves UART0 after GPIO32 went HIGH and before it went LOW again.
    const at42 = lines.find((l) => l.text === '42')!.vns;
    expect(at42).toBeGreaterThan(ev[1]!.vns);
    expect(at42).toBeLessThan(ev[2]!.vns);
    // Serial frames are in non-decreasing simulation time (the session also enforces this).
    for (let i = 1; i < r.serialTimeline.length; i++) {
      expect(r.serialTimeline[i]!.vns >= r.serialTimeline[i - 1]!.vns).toBe(true);
    }
    recordEvidence('serial-micropython', {
      lines,
      pad32: ev,
      serialTimedSha256: r.serialTimedSha256,
    });
  });

  it('serial input and output are deterministic (two runs, identical timed transcript)', async () => {
    const [a, b] = [await micropython(REPL), await micropython(REPL)];
    expect(a.serialTimedSha256).toBe(b.serialTimedSha256);
    expect(a.timelineSha256).toBe(b.timelineSha256);
  });

  it('guest serial and QEMU diagnostics are separate streams', async () => {
    const r = await micropython('print("tbi-guest-text")\r\n', 3_000_000_000n, 3_500_000_000n);
    expect(r.session.serial.toString()).toContain('tbi-guest-text');
    expect(r.session.diagnostics).not.toContain('tbi-guest-text');
    expect(r.session.diagnostics).not.toContain('MicroPython');
    expect(r.session.serial.toString()).not.toContain('Adding SPI flash device'); // a QEMU diagnostic
  });

  it('host-side serial capture is bounded: overflow is counted, the session continues', async () => {
    const fw = artifact('micropython');
    const c = new Circuit();
    const r = await runCircuitSession({
      qemu: QEMU,
      artifact: fw.path,
      artifactSha256: fw.sha256,
      circuit: c,
      pads: [],
      endNs: 2_000_000_000n,
      session: { serialLimitBytes: 64 },
    });
    expect(r.session.outcome).toBe('completed');
    expect(r.session.serial.length).toBe(64);
    expect(r.session.serialOverflow).toBeGreaterThan(100);
  });

  it('runtime-side serial input is bounded: more than 4096 pending bytes fails closed', async () => {
    const r = await micropython('#'.repeat(5000), 3_000_000_000n);
    expect(r.session.outcome).toBe('protocol_error_runtime');
    expect(r.session.exitCode).toBe(3);
    expect(r.session.diagnostics).toMatch(/oversized serial input/);
  });
});
