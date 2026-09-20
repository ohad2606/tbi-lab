/**
 * PHASE 2 — does an existing classic-ESP32 GPIO implementation actually work?
 *
 * Reproduces, rather than trusts, the claim that the a159x36/lcgamboa QEMU lineage
 * implements real ESP32 GPIO. Runs REAL classic-ESP32 firmware (MicroPython
 * ESP32_GENERIC, Xtensa LX6) on the classic `esp32` machine. No C3/S3 substitution.
 *
 * Required proof:
 *   A. firmware configures a normal output GPIO and toggles it
 *   B. host code observes those transitions externally
 *   C. firmware configures a normal input GPIO
 *   D. host code injects low/high states
 *   E. firmware observes those states correctly
 *
 * Pins are chosen to span both register banks so a bank/indexing bug cannot hide:
 * GPIO2 and GPIO18 (bank 0, GPIO_OUT/GPIO_IN) and GPIO33/GPIO35 (bank 1,
 * GPIO_OUT1/GPIO_IN1).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOARD_RESERVED_PINS_MASK,
  Esp32Runtime,
  FLASH_IMAGE,
  QEMU_BINARY,
} from '../src/qemuRuntime.js';

/** Classic ESP32 GPIO registers, ESP32 TRM / ESP-IDF soc/gpio_reg.h. */
const GPIO_OUT_REG = 0x3ff44004;
const GPIO_OUT1_REG = 0x3ff44010;
const GPIO_OUT_W1TS_REG = 0x3ff44008;
const GPIO_ENABLE_REG = 0x3ff44020;

let esp: Esp32Runtime;

beforeAll(async () => {
  esp = await Esp32Runtime.start({
    qemuBinary: QEMU_BINARY,
    flashImage: FLASH_IMAGE,
    ignoreMask: BOARD_RESERVED_PINS_MASK,
  });
  await esp.repl('import machine');
}, 300_000);

afterAll(async () => {
  await esp?.stop();
});

describe('Phase 2A/2B: firmware-driven output observed externally', () => {
  it('runs real classic-ESP32 firmware', () => {
    expect(esp.bootLog).toContain('MicroPython');
    expect(esp.bootLog, 'must be the classic ESP32, not a C3/S3 substitute').toContain('ESP32');
    // The mask ROM banner proves the real boot path, not a shortcut loader.
    expect(esp.bootLog).toMatch(/rst:0x1|ets /);
  });

  it('observes GPIO2 transitions through the ordinary firmware API', async () => {
    await esp.repl('p2 = machine.Pin(2, machine.Pin.OUT)');
    await esp.repl('p2.value(1)');
    const high = await esp.link.waitForOutput(2, 1, 15_000);
    expect(high).toEqual({ pin: 2, level: 1 });

    await esp.repl('p2.value(0)');
    const low = await esp.link.waitForOutput(2, 0, 15_000);
    expect(low).toEqual({ pin: 2, level: 0 });

    // The device model must actually hold the state, not just emit an event.
    await esp.repl('p2.value(1)');
    await esp.link.waitForOutput(2, 1, 15_000);
    const outReg = await esp.evalNumber(`machine.mem32[${GPIO_OUT_REG}] & ${1 << 2}`);
    expect(outReg, 'GPIO_OUT bit 2 set').toBe(1 << 2);
    const enableReg = await esp.evalNumber(`machine.mem32[${GPIO_ENABLE_REG}] & ${1 << 2}`);
    expect(enableReg, 'GPIO_ENABLE bit 2 set').toBe(1 << 2);
  });

  it('observes a second output pin independently (GPIO18)', async () => {
    await esp.repl('p18 = machine.Pin(18, machine.Pin.OUT)');
    await esp.repl('p18.value(1)');
    expect(await esp.link.waitForOutput(18, 1, 15_000)).toEqual({ pin: 18, level: 1 });

    // Toggling GPIO18 must not disturb GPIO2.
    const out = await esp.evalNumber(`machine.mem32[${GPIO_OUT_REG}] & ${(1 << 2) | (1 << 18)}`);
    expect(out).toBe((1 << 2) | (1 << 18));

    await esp.repl('p18.value(0)');
    expect(await esp.link.waitForOutput(18, 0, 15_000)).toEqual({ pin: 18, level: 0 });
  });

  it('honours a direct GPIO_OUT_W1TS register write, not just the driver API', async () => {
    // Transitions are edge events, so drive a known level before expecting an edge.
    await esp.repl('p19 = machine.Pin(19, machine.Pin.OUT)');
    await esp.repl('p19.value(1)');
    await esp.link.waitForOutput(19, 1, 15_000);
    await esp.repl('p19.value(0)');
    await esp.link.waitForOutput(19, 0, 15_000);

    // Now bypass the driver entirely and poke the hardware register.
    await esp.repl(`machine.mem32[${GPIO_OUT_W1TS_REG}] = ${1 << 19}`);
    expect(await esp.link.waitForOutput(19, 1, 15_000)).toEqual({ pin: 19, level: 1 });
  });

  it('drives a bank-1 output (GPIO33) in GPIO_OUT1', async () => {
    await esp.repl('p33 = machine.Pin(33, machine.Pin.OUT)');
    await esp.repl('p33.value(1)');
    const out1 = await esp.evalNumber(`machine.mem32[${GPIO_OUT1_REG}] & ${1 << (33 - 32)}`);
    expect(out1, 'GPIO_OUT1 bit 1 (GPIO33) set').toBe(1 << (33 - 32));

    await esp.repl('p33.value(0)');
    const out1Cleared = await esp.evalNumber(`machine.mem32[${GPIO_OUT1_REG}] & ${1 << (33 - 32)}`);
    expect(out1Cleared).toBe(0);
  });
});

/**
 * Semantic fidelity against the ESP32 TRM, not merely "does something happen".
 *
 * On real hardware a pad only drives the net when its output enable is set (GPIO_ENABLE).
 * Source review predicts a159x36's model does NOT gate pin-drive events on GPIO_ENABLE,
 * while the lcgamboa/PICSimLab variant does. This test records the actual behaviour of the
 * runtime under test rather than assuming either.
 */
describe('Phase 2 fidelity: output-enable gating', () => {
  it('records whether a not-output-enabled pin still reports a drive', async () => {
    // GPIO21 left as an input; its output enable is clear.
    await esp.repl('p21 = machine.Pin(21, machine.Pin.IN)');
    const enable = await esp.evalNumber(`machine.mem32[${GPIO_ENABLE_REG}] & ${1 << 21}`);
    expect(enable, 'GPIO21 output enable is clear').toBe(0);

    const before = esp.link.received.filter((e) => e.pin === 21).length;
    // Write the output register for a pin that is not output-enabled.
    await esp.repl(`machine.mem32[${GPIO_OUT_W1TS_REG}] = ${1 << 21}`);
    await new Promise((r) => setTimeout(r, 400));
    const after = esp.link.received.filter((e) => e.pin === 21).length;

    const gated = after === before;
    console.log(
      `output-enable gating: writing GPIO_OUT_W1TS on a non-output pin ` +
        `${gated ? 'did NOT' : 'DID'} produce a drive event ` +
        `(${gated ? 'TRM-correct' : 'NOT TRM-correct: pad drives while configured as input'})`,
    );

    // Recorded as evidence either way; the Sprint 0 record states which runtime we chose
    // and why. A non-gated model would make an input pin appear to drive the network.
    expect(typeof gated).toBe('boolean');
  });
});

describe('Phase 2C/2D/2E: host-injected input observed by firmware', () => {
  it('reads an injected level on a bank-0 input (GPIO5)', async () => {
    await esp.repl('p5 = machine.Pin(5, machine.Pin.IN)');

    esp.link.setInput(5, 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('p5.value()'), 'firmware sees HIGH').toBe(1);

    esp.link.setInput(5, 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('p5.value()'), 'firmware sees LOW').toBe(0);
  });

  it('reads an injected level on a bank-1 input (GPIO35)', async () => {
    await esp.repl('p35 = machine.Pin(35, machine.Pin.IN)');

    esp.link.setInput(35, 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('p35.value()'), 'firmware sees HIGH on GPIO35').toBe(1);

    esp.link.setInput(35, 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('p35.value()'), 'firmware sees LOW on GPIO35').toBe(0);
  });

  it('keeps input pins independent of one another', async () => {
    esp.link.setInput(5, 1);
    esp.link.setInput(35, 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('p5.value()')).toBe(1);
    expect(await esp.evalNumber('p35.value()')).toBe(0);

    esp.link.setInput(5, 0);
    esp.link.setInput(35, 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('p5.value()')).toBe(0);
    expect(await esp.evalNumber('p35.value()')).toBe(1);
  });
});
