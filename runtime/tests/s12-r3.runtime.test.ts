/**
 * Sprint 12 (R3) on the REAL runtime (Runtime v2, patches 0007-0008): ESP32 I2C with Arduino Wire.
 *
 * Harness level (TbiI2cProbe, the feasibility probe's firmware, promoted): the bus phases go to
 * targets this test provides: 0x27 is the engine's own I2C LCD model (PCF8574 + HD44780), 0x50 a
 * register file that NACKs data byte 0xEE.
 * - T-R3-1: Wire.begin(21, 22) routes exactly pads 21/22 to I2C0 SDA/SCL, open drain; while routed
 *   they emit no G frames.
 * - T-R3-3/-4/-5: scan (only 0x27 and 0x50; 0x48 no longer answers), write, read, repeated START,
 *   100-byte write, address and data NACK (endTransmission returns 4 on core 3.3.12: the IDF
 *   driver reports ESP_ERR_INVALID_STATE for both, measured in the probe).
 * - D-9: a 4-byte write takes its 100 kHz bus time (36 SCL periods), not zero.
 * Session Host level (TbiLcd): the LCD shows the firmware's text in the published result, the
 * backlight follows P3, and a 5 V module with 3.3 V pull-ups is refused at the bus (T-R3-6/-7).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { I2cLcd } from '@tbi-lab/engine';
import { createSessionOverlay } from '../harness/artifacts.js';
import { QEMU, artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import type { Command } from '../harness/protocol.js';
import { runSession } from '../harness/session.js';
import { ticketFor } from '../identity/test-gate.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { stopped } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

describe('R3: Wire on the real runtime (harness level)', () => {
  it('pad functions, scan, transfers, NACKs and bus time (T-R3-1, -3, -4, -5, D-9)', async () => {
    assertProvisioned();
    const fw = artifact('TbiI2cProbe');
    const ov = createSessionOverlay(fw.path, fw.sha256);
    const lcd = new I2cLcd(0x27);
    const regs = Array.from({ length: 256 }, (_, i) => i ^ 0x5a);
    let addr = -1;
    let first = false;
    let ptr = 0;
    let serial = '';
    const funcs: string[] = [];
    const gOnI2c: string[] = [];
    const phases: { vns: bigint; op: string }[] = [];
    const routed = new Set<number>();
    try {
      const r = await runSession(
        { qemu: QEMU, flash: ov.flash, dir: ov.dir, wallTimeoutMs: 600_000 },
        {
          serial: (_v, b) => void (serial += b.toString('latin1')),
          func: (e) => {
            funcs.push(`${e.pad} ${e.func} ${e.openDrain ? 'od' : 'pp'}`);
            if (e.func.startsWith('i2c')) routed.add(e.pad);
            else routed.delete(e.pad);
            return [];
          },
          pad: (e) => {
            if (routed.has(e.pad)) gOnI2c.push(`${e.vns} ${e.pad}`);
            return [];
          },
          i2c: (e): Command[] => {
            const p = e.phase;
            phases.push({ vns: e.vns, op: p.op });
            if (p.op === 'S') {
              addr = p.addr;
              first = true;
              return [{ type: 'K', ack: addr === 0x27 || addr === 0x50 }];
            }
            if (p.op === 'W') {
              if (addr === 0x27) return [{ type: 'K', ack: lcd.expander.writeByte(p.byte) }];
              if (first) {
                first = false;
                ptr = p.byte;
                return [{ type: 'K', ack: true }];
              }
              if (p.byte === 0xee) return [{ type: 'K', ack: false }];
              regs[ptr++ & 0xff] = p.byte;
              return [{ type: 'K', ack: true }];
            }
            if (p.op === 'R')
              return [
                { type: 'D', byte: addr === 0x27 ? lcd.expander.readByte() : regs[ptr++ & 0xff]! },
              ];
            return [];
          },
          tick: (v) =>
            serial.includes('PROBE-END') || v >= 20_000_000_000n ? [{ type: 'Q' }] : [],
        },
      );
      expect(r.outcome, r.diagnostics).toBe('completed');
      expect(r.caps).toEqual(['i2c', 'pad-func', 'sched-input']);
    } finally {
      ov.discard();
    }
    const results = serial.split(/\r?\n/).filter((l) => /^P-\d+ /.test(l));
    // The first transaction: S, three data bytes, P (probe P-2).
    const s0 = phases.findIndex((p) => p.op === 'S');
    const p0 = phases.findIndex((p, i) => i > s0 && p.op === 'P');
    const busNs = Number(phases[p0]!.vns - phases[s0]!.vns);
    recordEvidence('s12-r3-wire', {
      runtimeId: runtimeInfo().runtimeId,
      results,
      lcd: lcd.text(),
      firstTransactionNs: busNs,
      funcsI2c: funcs.filter((f) => /^2[12] /.test(f)),
      gWhileRouted: gOnI2c.length,
    });
    // T-R3-1: only 21/22 take I2C functions, open drain.
    expect(funcs.filter((f) => f.includes('i2c'))).toEqual(
      expect.arrayContaining(['21 i2c0-sda od', '22 i2c0-scl od']),
    );
    expect(new Set(funcs.filter((f) => f.includes('i2c')).map((f) => f.split(' ')[0]))).toEqual(
      new Set(['21', '22']),
    );
    expect(gOnI2c).toEqual([]);
    for (const id of ['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6', 'P-7', 'P-8', 'P-9'])
      expect(
        results.find((l) => l.startsWith(`${id} `)),
        id,
      ).toMatch(/ PASS /);
    expect(results.find((l) => l.startsWith('P-8 '))).toContain('acks=[27 50]');
    expect(lcd.text()[0]).toBe('Hello' + ' '.repeat(11));
    // D-9: 4 bytes x 9 SCL periods at 100 kHz = 360 us (plus START/STOP setup and hold).
    expect(busNs).toBeGreaterThanOrEqual(360_000);
    expect(busNs).toBeLessThan(450_000);
  });
});

/** PSU1 (lcdV) -> LCD VCC; PSU2 3.3 V -> 4.7 kΩ pull-ups on SDA/SCL; GPIO21/22. */
function lcdCircuit(lcdV: number, vccSdaSwapped = false) {
  // Sprint 13 OS-09: optionally the module's VCC and SDA pins swapped.
  const pin = (t: 'vcc' | 'sda' | 'scl') =>
    vccSdaSwapped && t === 'vcc' ? 'sda' : vccSdaSwapped && t === 'sda' ? 'vcc' : t;
  const c = new Circuit().psu(lcdV);
  const lcd = c.add('display.lcd1602_i2c');
  const p2 = c.add('instrument.lab_psu');
  c.set(p2, 'setpointVoltage', { value: 3.3, unit: 'volt' }).set(p2, 'outputEnabled', true);
  c.wire(`${p2}.negative`, 'GND1.ref');
  c.wire('PSU1.positive', `${lcd}.${pin('vcc')}`).wire(`${lcd}.gnd`, 'GND1.ref');
  for (const [line, gpio] of [
    ['sda', 21],
    ['scl', 22],
  ] as const) {
    const r = c.add('component.resistor');
    c.ohms(r, 4700)
      .wire(`${r}.a`, `${p2}.positive`)
      .wire(`${r}.b`, `${lcd}.${pin(line)}`);
    c.pad(gpio, `${lcd}.${pin(line)}`);
  }
  return { c, lcd };
}

async function lcdSession(
  lcdV: number,
  vccSdaSwapped = false,
): Promise<{ s: HostSession; lcd: string }> {
  assertProvisioned();
  const { c, lcd } = lcdCircuit(lcdV, vccSdaSwapped);
  const fw = artifact('TbiLcd');
  const s = open(host, { ...c.request(fw.sha256), ticket: ticketFor(fw.sha256) });
  expect(s.state).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  await waitEvent(s, () => serialText(s).includes('LCD-DARK'), 180_000);
  return { s, lcd };
}

const lcdStates = (s: HostSession, id: string) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'electrical')
    .map(
      (e) =>
        (
          e as unknown as {
            outcome: { components: Record<string, { state: Record<string, unknown> }> };
          }
        ).outcome.components[id]!.state,
    );

describe('R3: the I2C LCD through the Session Host', () => {
  it('in-spec wiring: the published LCD shows the text, then the backlight goes off (T-R3-6, -7)', async () => {
    const { s, lcd } = await lcdSession(4.5);
    // The last state is published at the next window after LCD-DARK.
    await waitEvent(s, () => lcdStates(s, lcd).at(-1)?.backlight === false, 30_000);
    const states = lcdStates(s, lcd);
    await stopped(s);
    expect(serialText(s)).toMatch(/^LCD 0\r?$/m);
    const shown = states.find((st) => st.line2 === 'T=21.5C' + ' '.repeat(9));
    expect(shown).toMatchObject({
      powered: true,
      backlight: true,
      displayOn: true,
      line1: 'Hello, ESP32!   ',
    });
    expect(states.at(-1)).toMatchObject({ backlight: false, line1: 'Hello, ESP32!   ' });
  });

  it('5 V module with 3.3 V pull-ups: Wire gets NACKs (4) and i2c_logic_level explains why', async () => {
    const { s } = await lcdSession(5);
    const diags = s.log
      .since(0)
      .filter((e) => e.type === 'diagnostic')
      .map((e) => (e as { code: string }).code);
    await stopped(s);
    expect(serialText(s)).toMatch(/^LCD 4\r?$/m);
    expect(diags).toContain('i2c_logic_level');
  });

  it('Sprint 13 OS-09: VCC and SDA swapped: NACKs (4), i2c_wiring names SDA on the VCC pin; unpowered', async () => {
    const { s, lcd } = await lcdSession(4.5, true);
    const diags = s.log
      .since(0)
      .filter((e) => e.type === 'diagnostic')
      .map((e) => e as unknown as { code: string; detail: Record<string, unknown> });
    const states = lcdStates(s, lcd);
    await stopped(s);
    expect(serialText(s)).toMatch(/^LCD 4\r?$/m);
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: 'i2c_wiring',
        detail: expect.objectContaining({ line: 'sda', terminal: 'vcc', reason: 'supply_pin' }),
      }),
    );
    for (const st of states) expect(st.powered).toBe(false);
  });
});
