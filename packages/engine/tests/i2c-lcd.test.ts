/**
 * Sprint 10 (internal): the I2C bus abstraction and the I2C LCD device semantics. Driven exactly
 * as a firmware library drives a PCF8574 backpack (the LiquidCrystal_I2C pattern: every expander
 * write is one I2C transaction; E is pulsed high then low around each nibble), at transaction
 * level and, separately, bit by bit on SDA/SCL.
 */
import { describe, expect, it } from 'vitest';
import { I2cBus, I2cBusError, I2cLineDecoder } from '../src/peripherals/i2c.js';
import { I2cLcd, Pcf8574, romA00 } from '../src/peripherals/hd44780.js';

const RS = 0x01;
const EN = 0x04;
const BL = 0x08;

/** The library-side protocol: nibble writes with an E pulse, as LiquidCrystal_I2C sends them. */
function lcdDriver(bus: I2cBus, address: number) {
  const tx = (v: number) =>
    expect(bus.write(address, [v | BL])).toEqual({ addressAck: true, acked: 1 });
  const write4 = (v: number) => {
    tx(v);
    tx(v | EN);
    tx(v & ~EN);
  };
  const send = (v: number, mode: number) => {
    write4((v & 0xf0) | mode);
    write4(((v << 4) & 0xf0) | mode);
  };
  return {
    begin() {
      tx(0);
      // HD44780U datasheet, "Initializing by Instruction" (4-bit): 0x3 three times, then 0x2.
      write4(0x30);
      write4(0x30);
      write4(0x30);
      write4(0x20);
      send(0x28, 0); // function set: 4-bit, 2 lines, 5x8
      send(0x0c, 0); // display on, cursor off, blink off
      send(0x01, 0); // clear
      send(0x06, 0); // entry mode: increment, no shift
      send(0x02, 0); // home
    },
    setCursor(col: number, row: number) {
      send(0x80 | (col + (row ? 0x40 : 0)), 0);
    },
    print(s: string) {
      for (const ch of s) send(ch.charCodeAt(0), RS);
    },
    command: (v: number) => send(v, 0),
  };
}

describe('I2C bus', () => {
  it('a target acknowledges its address and bytes; an absent address is not acknowledged', () => {
    const bus = new I2cBus();
    const port = new Pcf8574(0x27);
    bus.attach(port);
    expect(bus.write(0x27, [0x55, 0xaa])).toEqual({ addressAck: true, acked: 2 });
    expect(port.latch).toBe(0xaa);
    expect(bus.read(0x27, 1)).toEqual({ addressAck: true, bytes: [0xaa] });
    expect(bus.write(0x3f, [1])).toEqual({ addressAck: false, acked: 0 });
    // Nobody drives SDA: the pull-up reads as ones.
    expect(bus.read(0x3f, 2)).toEqual({ addressAck: false, bytes: [0xff, 0xff] });
  });

  it('refuses reserved addresses and address conflicts (a real bus would corrupt the transfer)', () => {
    const bus = new I2cBus();
    bus.attach(new Pcf8574(0x20));
    expect(() => bus.attach(new Pcf8574(0x20))).toThrow(I2cBusError);
    expect(() => bus.attach(new Pcf8574(0x78))).toThrow(I2cBusError);
    expect(() => bus.attach(new Pcf8574(0x03))).toThrow(I2cBusError);
  });

  it('line level: a bit-banged write is decoded per UM10204, ACKed on the ninth clock by the target', () => {
    const bus = new I2cBus();
    const port = new Pcf8574(0x27);
    bus.attach(port);
    const d = new I2cLineDecoder(bus);
    let sda: 0 | 1 = 1;
    const acks: (0 | 1)[] = [];
    const set = (scl: 0 | 1, s: 0 | 1) => {
      sda = s;
      return d.step(scl, s);
    };
    // START: SDA falls while SCL is high, then SCL low.
    set(1, 1);
    set(1, 0);
    set(0, 0);
    const sendByte = (b: number) => {
      for (let i = 7; i >= 0; i--) {
        const bit = ((b >> i) & 1) as 0 | 1;
        set(0, bit); // change while SCL low
        set(1, bit); // sampled on the rise
        set(0, bit);
      }
      // Ninth clock: the controller releases SDA; the bus reads the target's drive.
      const drive = set(0, 1);
      set(1, 1);
      acks.push((1 & drive) as 0 | 1);
      set(0, 1);
    };
    sendByte((0x27 << 1) | 0);
    sendByte(0x5a);
    // STOP: SDA rises while SCL is high.
    set(0, 0);
    set(1, 0);
    set(1, 1);
    expect(acks).toEqual([0, 0]);
    expect(port.latch).toBe(0x5a);
    expect(d.events.map((e) => e.kind)).toEqual(['start', 'address', 'data', 'stop']);
    expect(d.events[1]).toEqual({ kind: 'address', address: 0x27, read: false, ack: true });
    void sda;
  });

  it('line level: an address nobody answers is NACKed (SDA stays released)', () => {
    const bus = new I2cBus();
    const d = new I2cLineDecoder(bus);
    d.step(1, 1);
    d.step(1, 0);
    d.step(0, 0);
    const b = (0x27 << 1) | 0;
    for (let i = 7; i >= 0; i--) {
      const bit = ((b >> i) & 1) as 0 | 1;
      d.step(0, bit);
      d.step(1, bit);
      d.step(0, bit);
    }
    expect(d.step(0, 1)).toBe(1);
    expect(d.step(1, 1)).toBe(1);
    expect(d.events.at(-1)).toEqual({ kind: 'address', address: 0x27, read: false, ack: false });
  });
});

describe('I2C LCD (PCF8574 backpack + HD44780)', () => {
  it('the standard 4-bit initialisation, then text on both lines, shows exactly that text', () => {
    const bus = new I2cBus();
    const lcd = new I2cLcd(0x27, 16, 2);
    bus.attach(lcd.expander);
    const drv = lcdDriver(bus, 0x27);
    drv.begin();
    expect(lcd.controller.eightBit).toBe(false);
    expect(lcd.controller.twoLines).toBe(true);
    expect(lcd.controller.displayOn).toBe(true);
    expect(lcd.backlight).toBe(true);
    drv.print('TBI Lab');
    drv.setCursor(0, 1);
    drv.print('T=21.5 C RH=40%');
    expect(lcd.text()).toEqual(['TBI Lab         ', 'T=21.5 C RH=40% ']);
    // Clear empties both lines and homes the cursor.
    drv.command(0x01);
    drv.print('ok');
    expect(lcd.text()).toEqual(['ok              ', '                ']);
  });

  it('display off blanks the glass without losing DDRAM; a display shift moves the window', () => {
    const bus = new I2cBus();
    const lcd = new I2cLcd(0x27);
    bus.attach(lcd.expander);
    const drv = lcdDriver(bus, 0x27);
    drv.begin();
    drv.print('ABCDEFGHIJKLMNOPQ');
    drv.command(0x08); // display off
    expect(lcd.text()[0]).toBe(' '.repeat(16));
    drv.command(0x0c); // on again: content kept
    expect(lcd.text()[0]).toBe('ABCDEFGHIJKLMNOP');
    drv.command(0x18); // shift display left by one
    expect(lcd.text()[0]).toBe('BCDEFGHIJKLMNOPQ');
  });

  it('is deterministic and never acknowledges at the wrong address', () => {
    const run = () => {
      const bus = new I2cBus();
      const lcd = new I2cLcd(0x27);
      bus.attach(lcd.expander);
      const drv = lcdDriver(bus, 0x27);
      drv.begin();
      drv.print('repeat');
      return { text: lcd.text(), log: lcd.controller.log.length };
    };
    expect(run()).toEqual(run());
    const bus = new I2cBus();
    bus.attach(new I2cLcd(0x27).expander);
    expect(bus.write(0x3f, [0])).toEqual({ addressAck: false, acked: 0 });
  });

  it('maps character ROM A00 codes honestly (yen sign at 0x5C, katakana, undefined codes null)', () => {
    expect(romA00(0x41)).toBe('A');
    expect(romA00(0x5c)).toBe('¥');
    expect(romA00(0xb1)).toBe('ｱ');
    expect(romA00(0xf0)).toBeNull();
  });
});
