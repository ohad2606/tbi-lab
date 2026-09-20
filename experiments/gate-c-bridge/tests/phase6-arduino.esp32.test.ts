/**
 * PHASE 6 — Arduino compatibility proof.
 *
 * Shows that ordinary Arduino-style GPIO firmware executes through the runtime selected in
 * Phase 3, using the normal Arduino API (pinMode / digitalWrite / digitalRead) rather than
 * register pokes. This is a compatibility check only: no Arduino IDE, no compiler UI, and
 * no Arduino capability is being built into the product.
 *
 * Firmware: `arduino/TbiGpioProof/TbiGpioProof.ino`, compiled by arduino-cli 1.5.1 with the
 * official esp32:esp32 core 3.3.12 for FQBN **esp32:esp32:esp32** (the classic ESP32,
 * Xtensa LX6). arduino-cli emitted a 4 MB merged flash image directly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARDUINO_FLASH_IMAGE,
  BOARD_RESERVED_PINS_MASK,
  Esp32Runtime,
  QEMU_BINARY,
} from '../src/qemuRuntime.js';

let esp: Esp32Runtime;

beforeAll(async () => {
  esp = await Esp32Runtime.start({
    qemuBinary: QEMU_BINARY,
    flashImage: ARDUINO_FLASH_IMAGE,
    ignoreMask: BOARD_RESERVED_PINS_MASK,
    readyMarker: 'TBI-ARDUINO-READY',
  });
}, 300_000);

afterAll(async () => {
  await esp?.stop();
});

describe('Arduino firmware on the classic ESP32 runtime', () => {
  it('boots real Arduino-core firmware through the mask ROM', () => {
    expect(esp.bootLog, 'mask ROM / bootloader banner').toMatch(/rst:0x1|ets /);
    expect(esp.bootLog, 'sketch reached setup()').toContain('TBI-ARDUINO-READY');
  });

  it('drives GPIO from pinMode/digitalWrite and the host observes the pattern', async () => {
    // The sketch's loop is A HIGH -> B HIGH -> A LOW -> B LOW. Wait for a full cycle.
    await esp.link.waitForOutput(2, 1, 20_000);
    await esp.link.waitForOutput(18, 1, 20_000);
    await esp.link.waitForOutput(2, 0, 20_000);
    await esp.link.waitForOutput(18, 0, 20_000);

    const seen = esp.link.received.filter((e) => e.pin === 2 || e.pin === 18);
    expect(seen.length, 'transitions observed').toBeGreaterThanOrEqual(4);

    // Both pins must be present and distinguishable: not one pin echoed twice.
    expect(seen.some((e) => e.pin === 2)).toBe(true);
    expect(seen.some((e) => e.pin === 18)).toBe(true);

    // Each pin alternates rather than repeating a level.
    for (const pin of [2, 18]) {
      const levels = seen.filter((e) => e.pin === pin).map((e) => e.level);
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i], `GPIO${pin} alternates`).not.toBe(levels[i - 1]);
      }
    }
    console.log(
      'Arduino GPIO pattern observed: ' +
        seen.slice(0, 8).map((e) => `GPIO${e.pin}=${e.level}`).join(' '),
    );
  });

  it('reads a host-injected level through digitalRead()', async () => {
    esp.link.setInput(5, 1);
    const high = await esp.waitForSerial('IN=1', 20_000);
    expect(high).toContain('IN=1');

    esp.link.setInput(5, 0);
    const low = await esp.waitForSerial('IN=0', 20_000);
    expect(low).toContain('IN=0');
    console.log('Arduino digitalRead() followed host-injected levels: 1 then 0');
  });
});
