/**
 * Sprint 19B (MicroPython M1, serial reliability): serial input at the LINE RATE, in virtual time.
 *
 * The bridge hands queued bytes to the emulated UART as fast as its FIFO accepts them; a real
 * link cannot deliver faster than its baud rate, and a guest driver sized for that rate loses a
 * faster burst (Sprint 18 probe P4: a 1000-byte burst lost; the same bytes at 11 bytes per 1 ms
 * tick received intact). The pacer releases at most the bytes the line could carry since the
 * last release: baud / bitsPerByte per second (115200 8N1: 10 bits, 11.52 bytes per ms), with an
 * exact rational accumulator (no drift, no rounding gain), the remainder queued. Deterministic:
 * a pure function of the bytes queued and the virtual times asked.
 */
export class SerialPacer {
  private queue: Buffer[] = [];
  private queued = 0;
  /** Virtual time of the last release (ns) and the carried fraction, in bits·ns units. */
  private lastNs: bigint | null = null;
  private carryBitNs = 0n;

  constructor(
    readonly baud = 115_200,
    /** Start + data + parity + stop bits per byte (8N1: 10). */
    readonly bitsPerByte = 10,
  ) {
    if (!(Number.isInteger(baud) && baud > 0 && Number.isInteger(bitsPerByte) && bitsPerByte > 0))
      throw new Error('SerialPacer: baud and bitsPerByte must be positive integers');
  }

  /** Bytes waiting for the line. */
  get pending(): number {
    return this.queued;
  }

  enqueue(bytes: Buffer): void {
    if (bytes.length) {
      this.queue.push(bytes);
      this.queued += bytes.length;
    }
  }

  /**
   * The bytes the line carries up to virtual time `vns` (ns; non-decreasing). The first call
   * starts the line clock and releases nothing (no time has passed on the line yet).
   */
  release(vns: bigint): Buffer {
    if (this.lastNs === null || vns < this.lastNs) {
      if (this.lastNs !== null) throw new Error('SerialPacer: virtual time went backwards');
      this.lastNs = vns;
      return Buffer.alloc(0);
    }
    // bits that fit = baud * dt / 1e9; bytes = bits / bitsPerByte. Kept exact in bit·ns.
    const budget = BigInt(this.baud) * (vns - this.lastNs) + this.carryBitNs;
    this.lastNs = vns;
    const perByte = BigInt(this.bitsPerByte) * 1_000_000_000n;
    let n = Number(budget / perByte);
    if (n >= this.queued) {
      // The line idles: no credit accumulates while nothing is waiting.
      n = this.queued;
      this.carryBitNs = 0n;
    } else this.carryBitNs = budget - BigInt(n) * perByte;
    return this.take(n);
  }

  private take(n: number): Buffer {
    if (n <= 0) return Buffer.alloc(0);
    const all = Buffer.concat(this.queue);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.queue = rest.length ? [Buffer.from(rest)] : [];
    this.queued = rest.length;
    return Buffer.from(out);
  }
}
