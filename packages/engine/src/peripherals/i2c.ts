/**
 * I2C bus semantics (Sprint 10, PM-6 revision: the I2C-only display decision).
 *
 * MCU-agnostic and language-agnostic by design: nothing here knows Arduino's `Wire`, ESP-IDF or
 * MicroPython's `machine.I2C`. A runtime that produces bus activity (a future I2C peripheral bridge
 * in the ESP32 runtime, or line levels decoded from GPIO edges) drives the same targets, so every
 * firmware environment gets the same device behaviour.
 *
 * Two entry points:
 * - transaction level (`I2cBus.write` / `I2cBus.read`): what an MCU's I2C controller performs —
 *   START, address + R/W, bytes with their ACK/NACK, STOP;
 * - line level (`I2cLineDecoder`): SDA/SCL samples in time order, decoded per the I2C-bus
 *   specification (NXP UM10204): START = SDA falling while SCL is high, STOP = SDA rising while SCL
 *   is high, data sampled on SCL rising, MSB first, the ninth clock carrying ACK (SDA low).
 *
 * Electrical preconditions (pull-ups present, the target powered) are the circuit's business: the
 * caller attaches a target only while its module is powered and the bus has pull-ups. A target
 * that is not attached never acknowledges, exactly as an absent device.
 *
 * Internal in Sprint 10: the deployed ESP32 runtime does not model the I2C controller (its
 * builder refuses `Wire`), so no product feature drives this yet.
 */

/** A device on the bus (the target side of the protocol). */
export interface I2cTarget {
  /** 7-bit address (0x08..0x77; reserved addresses are refused at attach). */
  readonly address: number;
  /** The address byte matched: return true to acknowledge. */
  begin(direction: 'write' | 'read'): boolean;
  /** The controller wrote a byte: return true to acknowledge it. */
  writeByte(byte: number): boolean;
  /** The controller reads a byte (the target drives SDA). */
  readByte(): number;
  /** STOP (or a repeated START addressing someone else). */
  end(): void;
}

export interface WriteResult {
  /** Some target acknowledged its address. */
  addressAck: boolean;
  /** Data bytes acknowledged before the first NACK (all of them on success). */
  acked: number;
}

export interface ReadResult {
  addressAck: boolean;
  /** Bytes read; with no target answering, SDA stays released (pulled high): 0xFF. */
  bytes: number[];
}

export class I2cBusError extends Error {}

export class I2cBus {
  private readonly targets: I2cTarget[] = [];

  attach(target: I2cTarget): void {
    const a = target.address;
    // 0x00-0x07 and 0x78-0x7F are reserved by the I2C-bus specification (UM10204 Table 4).
    if (!Number.isInteger(a) || a < 0x08 || a > 0x77)
      throw new I2cBusError(`invalid 7-bit address 0x${a.toString(16)}`);
    if (this.targets.some((t) => t.address === a))
      // Two devices on one address both answer: the transfer is corrupted on a real bus.
      throw new I2cBusError(`address conflict at 0x${a.toString(16)}`);
    this.targets.push(target);
  }

  detach(target: I2cTarget): void {
    const i = this.targets.indexOf(target);
    if (i >= 0) this.targets.splice(i, 1);
  }

  /** The target at an address, if any (for the line decoder). */
  target(address: number): I2cTarget | undefined {
    return this.targets.find((t) => t.address === address);
  }

  /** START, address+W, bytes until the first NACK, STOP. */
  write(address: number, bytes: readonly number[]): WriteResult {
    const t = this.target(address);
    if (!t || !t.begin('write')) return { addressAck: false, acked: 0 };
    let acked = 0;
    for (const b of bytes) {
      if (!t.writeByte(b & 0xff)) break;
      acked++;
    }
    t.end();
    return { addressAck: true, acked };
  }

  /** START, address+R, `count` bytes (the controller ACKs all but the last), STOP. */
  read(address: number, count: number): ReadResult {
    const t = this.target(address);
    if (!t || !t.begin('read')) return { addressAck: false, bytes: new Array(count).fill(0xff) };
    const bytes: number[] = [];
    for (let i = 0; i < count; i++) bytes.push(t.readByte() & 0xff);
    t.end();
    return { addressAck: true, bytes };
  }
}

/** One decoded bus event (line level). */
export type I2cLineEvent =
  | { kind: 'start'; repeated: boolean }
  | { kind: 'stop' }
  | { kind: 'address'; address: number; read: boolean; ack: boolean }
  | { kind: 'data'; value: number; ack: boolean; from: 'controller' | 'target' };

/**
 * Line-level decoder and target-side driver. The caller steps it with the CONTROLLER's open-drain
 * outputs (1 = released) in time order; the bus line is the wired-AND of the controller's SDA and
 * the target's drive. `step` returns the target's SDA drive from now until the next step, so the
 * caller reads SDA back as `controllerSda & drive` (exactly what an open-drain bus with a pull-up
 * does). Timing follows UM10204: SDA may change only while SCL is low; it is sampled on SCL rising;
 * the receiver acknowledges by pulling SDA low through the ninth clock.
 */
export class I2cLineDecoder {
  private scl: 0 | 1 = 1;
  private line: 0 | 1 = 1;
  /** Target drive: 1 released, 0 pulling SDA low. */
  private drive: 0 | 1 = 1;
  private inFrame = false;
  /** SCL rising edges in the current byte: 0..8 data, 9 after the acknowledge clock. */
  private clock = 0;
  private shift = 0;
  private phase: 'address' | 'write' | 'read' | 'idle' = 'idle';
  private current: I2cTarget | undefined;
  /** The target acknowledges the byte just received (address or write data). */
  private ack = false;
  /** Read phase: the byte the target is sending, and whether the controller acknowledged it. */
  private outByte = 0xff;
  private controllerAck = false;
  readonly events: I2cLineEvent[] = [];

  constructor(private readonly bus: I2cBus) {}

  step(scl: 0 | 1, controllerSda: 0 | 1): 0 | 1 {
    const line = (controllerSda & this.drive) as 0 | 1;
    if (this.scl === 1 && scl === 1 && line !== this.line && this.drive === 1) {
      // SDA changed while SCL is high: a START (falling) or STOP (rising) condition.
      if (line === 0) this.onStart();
      else this.onStop();
    } else if (this.scl === 0 && scl === 1) {
      this.onRise(line);
    } else if (this.scl === 1 && scl === 0) {
      this.onFall();
    }
    this.scl = scl;
    this.line = (controllerSda & this.drive) as 0 | 1;
    return this.drive;
  }

  private onStart() {
    const repeated = this.inFrame;
    if (repeated) this.current?.end();
    this.events.push({ kind: 'start', repeated });
    this.inFrame = true;
    this.phase = 'address';
    this.clock = 0;
    this.shift = 0;
    this.current = undefined;
    this.drive = 1;
  }

  private onStop() {
    if (this.inFrame) {
      this.current?.end();
      this.events.push({ kind: 'stop' });
    }
    this.inFrame = false;
    this.phase = 'idle';
    this.current = undefined;
    this.drive = 1;
  }

  private onRise(line: 0 | 1) {
    if (this.phase === 'idle') return;
    if (this.clock < 8) {
      this.shift = ((this.shift << 1) | line) & 0xff;
      this.clock++;
      if (this.clock === 8) this.byteReceived();
      return;
    }
    if (this.clock === 8) {
      // The acknowledge clock.
      this.clock = 9;
      if (this.phase === 'read') {
        this.controllerAck = line === 0;
        this.events.push({
          kind: 'data',
          value: this.outByte,
          ack: this.controllerAck,
          from: 'target',
        });
      }
    }
  }

  private byteReceived() {
    const byte = this.shift;
    if (this.phase === 'address') {
      const address = byte >> 1;
      const read = (byte & 1) === 1;
      const t = this.bus.target(address);
      this.ack = !!t && t.begin(read ? 'read' : 'write');
      this.events.push({ kind: 'address', address, read, ack: this.ack });
      this.current = this.ack ? t : undefined;
    } else if (this.phase === 'write') {
      this.ack = this.current!.writeByte(byte);
      this.events.push({ kind: 'data', value: byte, ack: this.ack, from: 'controller' });
    } else {
      this.ack = false; // read phase: the controller acknowledges, not the target
    }
  }

  private onFall() {
    if (this.phase === 'idle') return;
    if (this.clock === 8) {
      // After the eighth bit: the receiving target pulls SDA low to acknowledge; a sending
      // target releases SDA for the controller's acknowledge.
      this.drive = this.phase !== 'read' && this.ack ? 0 : 1;
      return;
    }
    if (this.clock === 9) {
      this.drive = 1;
      this.clock = 0;
      this.shift = 0;
      if (this.phase === 'address') {
        if (!this.ack) this.phase = 'idle';
        else if (
          this.events.at(-1)?.kind === 'address' &&
          (this.events.at(-1) as { read: boolean }).read
        ) {
          this.phase = 'read';
          this.loadNext();
        } else this.phase = 'write';
      } else if (this.phase === 'write' && !this.ack) {
        this.phase = 'idle'; // a NACKed byte ends the transfer; the controller sends STOP
      } else if (this.phase === 'read') {
        if (this.controllerAck) this.loadNext();
        else this.phase = 'idle';
      }
      return;
    }
    if (this.phase === 'read' && this.clock > 0 && this.clock < 8)
      this.drive = ((this.outByte >> (7 - this.clock)) & 1) as 0 | 1;
  }

  /** Read phase: fetch the target's next byte and present its MSB. */
  private loadNext() {
    this.outByte = this.current!.readByte() & 0xff;
    this.drive = ((this.outByte >> 7) & 1) as 0 | 1;
  }
}
