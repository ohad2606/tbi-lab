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
