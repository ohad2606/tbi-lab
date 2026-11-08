/**
 * Sprint 13 OS-03 / OS-06: environment slider scales and the bounded live-update throttle.
 * Every catalog environment parameter: monotonic over all positions, both ends reached, and a
 * value set by the slider maps back to the same position (the thumb stays where released).
 */
import { describe, expect, it } from 'vitest';
import { CATALOG } from '@tbi-lab/domain';
import { liveThrottle, niceStep, sliderScale } from '../src/ui/sliderScale.js';

const environment = Object.values(CATALOG).flatMap((t) =>
  t.params.flatMap((p) =>
    p.kind === 'quantity' && p.environment ? [{ type: t.type, p, scale: p.environment.scale }] : [],
  ),
);

describe('slider scales', () => {
  it('there are environment parameters (LDR illuminance, HC-SR04 distance, ...)', () => {
    const keys = environment.map((e) => `${e.type}.${e.p.key}`);
    expect(keys).toContain('component.photoresistor.illuminance');
    expect(keys).toContain('sensor.hc_sr04.distance');
  });

  for (const { type, p, scale } of environment) {
    it(`${type}.${p.key} (${scale ?? 'linear'}): monotonic, ends reached, round trip`, () => {
      const s = sliderScale(p.min, p.max, scale ?? 'linear');
      expect(s.value(0)).toBe(p.min);
      expect(s.value(s.steps)).toBe(p.max);
      let prev = -Infinity;
      for (let i = 0; i <= s.steps; i++) {
        const v = s.value(i);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
        if ((scale ?? 'linear') === 'linear') expect(s.position(v)).toBe(i);
        else expect(Math.abs(s.position(v) - i)).toBeLessThanOrEqual(1);
      }
    });
  }

  it('HC-SR04 distance moves in exact 5 mm steps (the old mapping jumped back near 1 m)', () => {
    const s = sliderScale(0.01, 5, 'linear');
    expect(niceStep(4.99)).toBe(0.005);
    expect(s.value(200)).toBe(1.01);
    expect(s.value(201)).toBe(1.015);
    expect(s.position(1.015)).toBe(201);
  });
});

describe('live throttle', () => {
  function fakeClock() {
    let now = 0;
    const timers: { at: number; f: () => void }[] = [];
    return {
      clock: {
        now: () => now,
        set: (f: () => void, ms: number) => {
          const t = { at: now + ms, f };
          timers.push(t);
          return t;
        },
        clear: (h: unknown) => void timers.splice(timers.indexOf(h as never), 1),
      },
      advance(ms: number) {
        now += ms;
        for (const t of [...timers].filter((x) => x.at <= now)) {
          timers.splice(timers.indexOf(t), 1);
          t.f();
        }
      },
    };
  }

  it('a 1 s drag at 120 Hz sends at most 11 values; the release value always arrives last', () => {
    const c = fakeClock();
    const sent: number[] = [];
    const th = liveThrottle<number>((v) => sent.push(v), 100, c.clock);
    for (let i = 0; i < 120; i++) {
      th.push(i);
      c.advance(1000 / 120);
    }
    th.flush(999);
    expect(sent.length).toBeLessThanOrEqual(12);
    expect(sent.at(-1)).toBe(999);
    // Values are sent in order (never an older value after a newer one).
    for (let i = 1; i < sent.length; i++) expect(sent[i]!).toBeGreaterThan(sent[i - 1]!);
  });

  it('a pending value is delivered at the end of its interval when the drag pauses', () => {
    const c = fakeClock();
    const sent: number[] = [];
    const th = liveThrottle<number>((v) => sent.push(v), 100, c.clock);
    th.push(1);
    th.push(2);
    expect(sent).toEqual([1]);
    c.advance(100);
    expect(sent).toEqual([1, 2]);
  });
});
