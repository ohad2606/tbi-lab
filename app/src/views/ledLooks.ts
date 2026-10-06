/**
 * How each curated LED model card looks (Sprint 10): its emission colour (the datasheet's colour
 * name: dominant wavelength 612-630 nm red, 581-594 nm yellow, 562-575 nm green) and its package
 * (5 mm tinted diffused / 3 mm clear), shared by the circuit canvas glow and the 3D view.
 * Presentation only: the electrical model is chosen by the engine's registry, never here.
 */
import type { LED_PACKAGES } from './scene3d/physical.js';

export interface LedLook {
  /** Emission colour (CSS). */
  color: string;
  package: keyof typeof LED_PACKAGES;
  /** Water-clear lens (otherwise tinted diffused). */
  clear: boolean;
}

export const LED_LOOKS: Readonly<Record<string, LedLook>> = {
  'model.led.vishay_tlhr5400': { color: '#e53935', package: 't1_34', clear: false },
  'model.led.vishay_tlhy5400': { color: '#fbc02d', package: 't1_34', clear: false },
  'model.led.vishay_tlhg4900': { color: '#43c64a', package: 't1', clear: true },
};

/** The look of an LED model card; an unknown card shows as the red 5 mm part. */
export const ledLook = (model: unknown): LedLook =>
  LED_LOOKS[String(model)] ?? LED_LOOKS['model.led.vishay_tlhr5400']!;

/**
 * RGB LED channel colours (Sprint 10), from the Kingbright WP154A4SUREQBFZGC dominant
 * wavelengths: hyper red 630 nm, green 525 nm, blue 465 nm (datasheet page 2).
 */
export const RGB_LOOKS: Readonly<Record<'red' | 'green' | 'blue', string>> = {
  red: '#f2261b',
  green: '#18d65a',
  blue: '#2b5cff',
};

/**
 * The colour an RGB LED shows for its solved channel currents: each channel's colour weighted by
 * its current relative to the datasheet test current (20 mA), mixed additively. A visual cue
 * only (not a photometric model); it never feeds the simulation. Null when no channel conducts.
 */
export function rgbMix(currents: Partial<Record<'red' | 'green' | 'blue', number | null>>): {
  color: string;
  intensity: number;
} | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let peak = 0;
  for (const ch of ['red', 'green', 'blue'] as const) {
    const i = currents[ch] ?? 0;
    if (!(i > 1e-6)) continue;
    const w = Math.min(1, i / 0.02);
    peak = Math.max(peak, w);
    const hex = RGB_LOOKS[ch];
    r += w * parseInt(hex.slice(1, 3), 16);
    g += w * parseInt(hex.slice(3, 5), 16);
    b += w * parseInt(hex.slice(5, 7), 16);
  }
  if (peak === 0) return null;
  // Normalise the brightest component to full scale (hue from the mix, brightness from `peak`),
  // after removing most of the common grey the channel colours add, so a mix keeps its hue.
  const grey = Math.min(r, g, b) * 0.8;
  r -= grey;
  g -= grey;
  b -= grey;
  const m = Math.max(r, g, b);
  const hex = (v: number) =>
    Math.round((255 * v) / m)
      .toString(16)
      .padStart(2, '0');
  return { color: `#${hex(r)}${hex(g)}${hex(b)}`, intensity: Math.max(0.08, peak) };
}
