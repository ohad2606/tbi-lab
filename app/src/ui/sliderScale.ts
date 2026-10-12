/**
 * Environment slider scales (Sprint 13 OS-03/OS-06). A slider position maps to a canonical value
 * and back, so that dragging is monotonic and a value set by the slider puts the thumb exactly
 * where it was released (the previous mapping rounded to three significant digits, which neither
 * round-trips nor keeps a constant step: at 1 m on the HC-SR04 the thumb jumped back).
 *
 * - Linear: a "nice" step (1, 2 or 5 x 10^k) no larger than needed for at most MAX_STEPS
 *   positions; value = min + position x step, exact in decimal (rounded to the step's decimals);
 *   position = (value - min) / step. Round trip is exact for every position.
 * - Log (illuminance, 1 ... 10 000 lx): MAX_STEPS positions, geometric; values rounded to three
 *   significant digits (a light level is not set more finely), which is monotonic; the thumb
 *   position of a rounded value is the nearest position.
 */
export const MAX_STEPS = 1000;

export interface SliderScale {
  steps: number;
  value(position: number): number;
  position(value: number): number;
}

const decimals = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

export function niceStep(span: number, maxSteps = MAX_STEPS): number {
  const raw = span / maxSteps;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw - 1e-12) return m * p;
  return 10 * p;
}

export function sliderScale(min: number, max: number, scale: 'linear' | 'log'): SliderScale {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  if (scale === 'log') {
    const steps = MAX_STEPS;
    const ratio = Math.log(max / min);
    return {
      steps,
      value: (p) => clamp(Number((min * Math.exp((ratio * p) / steps)).toPrecision(3))),
      position: (v) =>
        Math.round(Math.min(1, Math.max(0, Math.log(clamp(v) / min) / ratio)) * steps),
    };
  }
  const step = niceStep(max - min);
  const steps = Math.ceil((max - min) / step - 1e-9);
  const d = decimals(step);
  return {
    steps,
    value: (p) => clamp(Number((min + Math.round(p) * step).toFixed(d))),
    position: (v) => Math.min(steps, Math.max(0, Math.round((clamp(v) - min) / step))),
  };
}

/**
 * Bounded live updates while dragging: at most one call per `intervalMs` (the first at once,
 * the latest pending one at the end of the interval), and `flush` delivers the final value
 * immediately (on release), so the last value is never lost.
 */
export function liveThrottle<T>(
  send: (v: T) => void,
  intervalMs: number,
  clock: {
    now: () => number;
    set: (f: () => void, ms: number) => unknown;
    clear: (h: unknown) => void;
  } = {
    now: () => Date.now(),
    set: (f, ms) => setTimeout(f, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
) {
  let last = -Infinity;
  let pending: { v: T } | null = null;
  let timer: unknown = null;
  const fire = () => {
    timer = null;
    if (!pending) return;
    last = clock.now();
    const { v } = pending;
    pending = null;
    send(v);
  };
  return {
    push(v: T) {
      pending = { v };
      const wait = last + intervalMs - clock.now();
      if (wait <= 0 && timer === null) fire();
      else if (timer === null) timer = clock.set(fire, Math.max(0, wait));
    },
    flush(v: T) {
      if (timer !== null) clock.clear(timer);
      timer = null;
      pending = null;
      last = clock.now();
      send(v);
    },
    /** Drop a pending value (the caller commits the final value itself). */
    cancel() {
      if (timer !== null) clock.clear(timer);
      timer = null;
      pending = null;
    },
  };
}
