/**
 * Sprint 19B (MicroPython M1): serial input paced at the line rate in virtual time
 * (runtime/harness/serialPacer.ts). 115200 baud 8N1 = 11 520 bytes/s = 11.52 bytes per 1 ms tick.
 */
import { describe, expect, it } from 'vitest';
import { SerialPacer } from '../../harness/serialPacer.js';

const MS = 1_000_000n;

describe('SerialPacer', () => {
  it('115200 8N1: 11 or 12 bytes per 1 ms tick, exactly 11 520 per second, in order, nothing lost', () => {
    const p = new SerialPacer();
    const data = Buffer.from(Array.from({ length: 20_000 }, (_, i) => i & 0xff));
    p.enqueue(data);
    expect(p.release(0n).length).toBe(0); // starts the line clock
    const got: Buffer[] = [];
    const sizes = new Set<number>();
    for (let t = 1n; t <= 1000n; t++) {
      const b = p.release(t * MS);
      sizes.add(b.length);
      got.push(b);
    }
    expect([...sizes].sort()).toEqual([11, 12]);
    expect(Buffer.concat(got).length).toBe(11_520);
    // The rest at the same rate; the whole stream arrives intact and in order.
    for (let t = 1001n; p.pending > 0; t++) got.push(p.release(t * MS));
    expect(Buffer.concat(got).equals(data)).toBe(true);
  });

  it('deterministic: the same bytes and times release the same chunks; no credit while idle', () => {
    const run = () => {
      const p = new SerialPacer();
      p.release(0n);
      const out: number[] = [];
      p.enqueue(Buffer.alloc(30, 1));
      for (let t = 1n; t <= 3n; t++) out.push(p.release(t * MS).length);
      // Idle for 100 ms, then a burst: still only the line rate (no saved-up credit).
      out.push(p.release(103n * MS).length);
      p.enqueue(Buffer.alloc(30, 2));
      out.push(p.release(104n * MS).length);
      return out;
    };
    expect(run()).toEqual(run());
    expect(run().at(-1)).toBeLessThanOrEqual(12);
  });

  it('other rates and framing; time may not go backwards', () => {
    const p = new SerialPacer(9600, 10); // 960 bytes/s
    p.enqueue(Buffer.alloc(5000));
    p.release(0n);
    expect(p.release(1000n * MS).length).toBe(960);
    expect(() => p.release(999n * MS)).toThrow();
    expect(() => new SerialPacer(0)).toThrow();
  });
});
