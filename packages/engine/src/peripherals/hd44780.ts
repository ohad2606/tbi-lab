/**
 * Character-LCD semantics for the I2C LCD (Sprint 10, internal): an HD44780-compatible controller
 * behind a PCF8574 I/O expander, the common "I2C backpack". Pure, deterministic device logic, MCU-
 * and firmware-agnostic; it is driven through the I2C bus abstraction (i2c.ts).
 *
 * Sources (see packages/engine/PROVENANCE.md, Sprint 10):
 * - Hitachi HD44780U datasheet (ADE-207-272(Z), '99.9, Rev. 0.0): instruction set (Table 6),
 *   4-bit interface (two transfers per byte, high nibble first, latched on E falling), the state
 *   after the internal reset, the DDRAM address map of a 2-line display (line 1 0x00-0x27, line 2
 *   0x40-0x67) and character generator ROM code A00.
 * - NXP/TI PCF8574 datasheets: 7-bit address 0100 A2 A1 A0 (0x20-0x27); a write latches the 8-bit
 *   quasi-bidirectional port; a read returns the port pins.
 * - The backpack's port-to-LCD wiring (P0 RS, P1 R/W, P2 E, P3 backlight, P4-P7 D4-D7) is a
 *   module convention, not a chip property: it is a parameter (`BACKPACK_STANDARD`).
 *
 * Not modelled (documented limits): instruction execution time and the busy flag (the controller
 * accepts each instruction immediately), reading the controller (R/W = 1), the contrast
 * potentiometer, and character ROM codes outside ASCII and the JIS X 0201 katakana range.
 */

import type { I2cTarget } from './i2c.js';

/** Port bits of the backpack wiring. */
export interface BackpackWiring {
  rs: number;
  rw: number;
  e: number;
  backlight: number;
  /** Port bits carrying D4, D5, D6, D7. */
  data: readonly [number, number, number, number];
}

/** The common PCF8574 backpack wiring. */
export const BACKPACK_STANDARD: BackpackWiring = {
  rs: 0,
  rw: 1,
  e: 2,
  backlight: 3,
  data: [4, 5, 6, 7],
};

/** PCF8574: an 8-bit quasi-bidirectional port at address 0x20 | A2A1A0. */
export class Pcf8574 implements I2cTarget {
  /** The output latch; all ones (weak high) after power-on. */
  latch = 0xff;
  constructor(
    readonly address: number,
    private readonly onWrite: (port: number) => void = () => {},
  ) {}
  begin(): boolean {
    return true;
  }
  writeByte(byte: number): boolean {
    this.latch = byte & 0xff;
    this.onWrite(this.latch);
    return true;
  }
  /** Pins read back their own latch (nothing else drives them in this model). */
  readByte(): number {
    return this.latch;
  }
  end(): void {}
}

const DDRAM_SIZE = 0x80;

/** HD44780 controller state, as the instruction set defines it. */
export class Hd44780 {
  /** Interface data length: true after reset (8-bit) until a function set selects 4-bit. */
  eightBit = true;
  /** N: two display lines. */
  twoLines = false;
  /** D, C, B. */
  displayOn = false;
  cursorOn = false;
  blinkOn = false;
  /** Entry mode: I/D (increment) and S (shift display). */
  increment = true;
  shiftOnEntry = false;
  /** Address counter, and whether it points into DDRAM or CGRAM. */
  ac = 0;
  private target: 'ddram' | 'cgram' = 'ddram';
  /** Display shift, in characters (left shift positive). */
  shift = 0;
  readonly ddram = new Uint8Array(DDRAM_SIZE).fill(0x20);
  readonly cgram = new Uint8Array(64);
  /** 4-bit mode: the high nibble of a byte being transferred. */
  private pendingHigh: number | null = null;
  /** Instructions received (for tests and diagnostics). */
  readonly log: { rs: 0 | 1; value: number }[] = [];

  /**
   * One bus cycle latched on E's falling edge: RS, and the 4 or 8 data bits. In 8-bit mode with
   * only D4-D7 wired (the backpack), D0-D3 read high: the HD44780U's data pins have pull-up MOS
   * transistors (datasheet, pin functions).
   */
  latch(rs: 0 | 1, d7to4: number, d3to0 = 0x0f): void {
    if (this.eightBit) {
      this.execute(rs, ((d7to4 & 0x0f) << 4) | (d3to0 & 0x0f));
      return;
    }
    if (this.pendingHigh === null) {
      this.pendingHigh = d7to4 & 0x0f;
      return;
    }
    const value = (this.pendingHigh << 4) | (d7to4 & 0x0f);
    this.pendingHigh = null;
    this.execute(rs, value);
  }

  private execute(rs: 0 | 1, v: number): void {
    this.log.push({ rs, value: v });
    if (rs === 1) return this.writeData(v);
    if (v & 0x80) {
      this.target = 'ddram';
      this.ac = v & 0x7f;
    } else if (v & 0x40) {
      this.target = 'cgram';
      this.ac = v & 0x3f;
    } else if (v & 0x20) {
      // Function set: DL, N, F (F only matters for 1-line 5x10 displays).
      const wasEight = this.eightBit;
      this.eightBit = (v & 0x10) !== 0;
      this.twoLines = (v & 0x08) !== 0;
      // Switching to 4-bit mid-byte: the next transfer starts a new byte.
      if (wasEight && !this.eightBit) this.pendingHigh = null;
    } else if (v & 0x10) {
      // Cursor or display shift: S/C (bit 3), R/L (bit 2).
      const display = (v & 0x08) !== 0;
      const right = (v & 0x04) !== 0;
      if (display) this.shift += right ? -1 : 1;
      else this.moveAc(right ? 1 : -1);
    } else if (v & 0x08) {
      this.displayOn = (v & 0x04) !== 0;
      this.cursorOn = (v & 0x02) !== 0;
      this.blinkOn = (v & 0x01) !== 0;
    } else if (v & 0x04) {
      this.increment = (v & 0x02) !== 0;
      this.shiftOnEntry = (v & 0x01) !== 0;
    } else if (v & 0x02) {
      // Return home: AC = 0, shift undone; DDRAM unchanged.
      this.target = 'ddram';
      this.ac = 0;
      this.shift = 0;
    } else if (v & 0x01) {
      // Clear display: spaces everywhere, AC = 0, I/D = increment, shift undone.
      this.ddram.fill(0x20);
      this.target = 'ddram';
      this.ac = 0;
      this.shift = 0;
      this.increment = true;
    }
  }

  private writeData(v: number): void {
    if (this.target === 'cgram') {
      this.cgram[this.ac & 0x3f] = v & 0x1f;
      this.ac = (this.ac + (this.increment ? 1 : -1)) & 0x3f;
      return;
    }
    this.ddram[this.ac] = v;
    this.moveAc(this.increment ? 1 : -1);
    if (this.shiftOnEntry) this.shift += this.increment ? 1 : -1;
  }

  /** DDRAM address counter steps within the valid ranges (2-line: 0x00-0x27 and 0x40-0x67). */
  private moveAc(step: 1 | -1): void {
    if (!this.twoLines) {
      this.ac = (this.ac + step + 80) % 80;
      return;
    }
    let a = this.ac + step;
    if (a === 0x28) a = 0x40;
    else if (a === 0x68) a = 0x00;
    else if (a === 0x3f) a = 0x27;
    else if (a === -1) a = 0x67;
    this.ac = a;
  }

  /** Character codes shown in a window of `cols` x `rows` (2-line addressing), display shift applied. */
  cells(cols: number, rows: number): number[][] {
    const out: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) {
        if (!this.displayOn) {
          row.push(0x20);
          continue;
        }
        const pos = (((c + this.shift) % 40) + 40) % 40;
        // A 4-line module continues lines 1/2 at column 20 (lines 3/4).
        const base = r % 2 === 0 ? 0x00 : 0x40;
        const extra = r >= 2 ? 20 : 0;
        row.push(this.ddram[base + ((pos + extra) % 40)]!);
      }
      out.push(row);
    }
    return out;
  }
}

/**
 * Character generator ROM A00 to Unicode, for text display: ASCII 0x20-0x7D except 0x5C (a yen
 * sign in A00) and 0x7E/0x7F (arrows); JIS X 0201 katakana 0xA1-0xDF. CGRAM codes (0x00-0x0F,
 * custom characters drawn from `cgram`) and the remaining ROM codes have no text form: `null`.
 */
export function romA00(code: number): string | null {
  if (code === 0x5c) return '¥';
  if (code === 0x7e) return '→';
  if (code === 0x7f) return '←';
  if (code >= 0x20 && code <= 0x7d) return String.fromCharCode(code);
  if (code >= 0xa1 && code <= 0xdf) return String.fromCharCode(0xff61 + code - 0xa1);
  if (code === 0xa0) return ' ';
  return null;
}

/** An I2C LCD module: PCF8574 backpack + HD44780 + backlight. */
export class I2cLcd {
  readonly controller = new Hd44780();
  readonly expander: Pcf8574;
  backlight = false;
  private lastE = 0;

  constructor(
    address: number,
    readonly cols = 16,
    readonly rows = 2,
    private readonly wiring: BackpackWiring = BACKPACK_STANDARD,
  ) {
    this.expander = new Pcf8574(address, (port) => this.onPort(port));
  }

  private onPort(port: number): void {
    const bit = (n: number) => ((port >> n) & 1) as 0 | 1;
    const w = this.wiring;
    this.backlight = bit(w.backlight) === 1;
    const e = bit(w.e);
    // Data is latched on E's falling edge, writes only (R/W low).
    if (this.lastE === 1 && e === 0 && bit(w.rw) === 0) {
      const nibble = w.data.reduce((n, b, i) => n | (bit(b) << i), 0);
      this.controller.latch(bit(w.rs), nibble);
    }
    this.lastE = e;
  }

  /** The visible text, one string per row (unknown ROM codes shown as U+FFFD). */
  text(): string[] {
    return this.controller
      .cells(this.cols, this.rows)
      .map((row) => row.map((c) => romA00(c) ?? '�').join(''));
  }
}
