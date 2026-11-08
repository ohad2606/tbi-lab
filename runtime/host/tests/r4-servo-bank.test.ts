/**
 * Sprint 17C (review V4/V6), the servo bank on its own: a waveform that started long before a
 * servo saw it is expanded from its last cycle boundary (not replayed from its start, which hit
 * the edge-expansion bound after ~17 minutes at 50 Hz), and a suspension (a PWM state awaiting
 * refusal) discards the pulse in progress instead of measuring a truncated one.
 */
import { describe, expect, it } from 'vitest';
import type { SimulationSnapshot } from '@tbi-lab/domain';
import type { SolveSuccess } from '@tbi-lab/engine';
import { LedcTracker, ns, type Waveform } from '../pwm.js';
import { ServoBank } from '../servos.js';

/** 50 Hz on APB, 16 bit (div 6250/256), duty `d`, counter started at 0. */
function wave(d: number): Extract<Waveform, { kind: 'wave' }> {
  const t = new LedcTracker();
  t.timer(0n, 0, { kind: 'reset' });
  t.timer(0n, 0, { kind: 'run', clockHz: 80_000_000, div: 6250, res: 16 });
  t.channel(0n, 71, { kind: 'on', timer: 0, hpoint: 0, duty: d });
  t.advance(1n);
  const w = t.waveform(71);
  if (w.kind !== 'wave') throw new Error(JSON.stringify(w));
  return w;
}
const point = (signal: number): SolveSuccess =>
  ({
    ok: true,
    components: { M1: { terminals: { vcc: 5, gnd: 0, signal } } },
  }) as unknown as SolveSuccess;
const snapshot = { components: [{ id: 'M1', type: 'component.servo_sg90' }] } as SimulationSnapshot;
const MS = 1_000_000n;

describe('ServoBank (Sprint 17C)', () => {
  it('review V6: a 20-minute-old waveform is fed from its last cycle, not replayed', () => {
    const bank = new ServoBank(snapshot);
    const w = wave(4915); // 1499.94 us
    const now = 20n * 60_000n * MS;
    bank.sync(now);
    bank.observe(now, point(0), [{ gpio: 18, w, since: ns(0n), high: point(3.3) }]);
    expect(() => bank.sync(now + 100n * MS)).not.toThrow();
    const st = bank.state('M1')!;
    expect(st.signal).toBe('pulses');
    expect(st.pulseUs).toBeCloseTo(1499.94, 1);
  });

  it('review V4: a suspension discards the pulse in progress; the next full pulse counts', () => {
    const bank = new ServoBank(snapshot);
    const w1 = wave(6554); // 2000.12 us -> 180 deg
    bank.sync(0n);
    bank.observe(0n, point(0), [{ gpio: 18, w: w1, since: ns(0n), high: point(3.3) }]);
    bank.sync(100n * MS);
    expect(bank.state('M1')!.commandedDeg).toBe(180);
    // 0.5 ms into the next pulse the signal becomes unknown, then the pad reads low again: before
    // the fix a 500 us "pulse" (-> 0 deg) was measured.
    bank.sync(100n * MS + 500_000n);
    bank.suspend(100n * MS + 500_000n);
    expect(bank.state('M1')!.signal).toBe('undefined');
    bank.sync(101n * MS);
    bank.observe(101n * MS, point(0), []);
    bank.sync(200n * MS);
    expect(bank.state('M1')!.commandedDeg).toBe(180);
  });
});
