/**
 * Sprint 11 (R1), slice 1 (RGB LED): the Sprint 10 parts driven by / feeding ESP32 pads, solved by the one engine with
 * the pads attached exactly as the Session Host attaches them (build.ts boardBench). Each result is
 * checked against an INDEPENDENT reference: the same circuit with every pad replaced by its
 * datasheet-derived Thevenin equivalent (3.3 V behind 16.5 Ω for HIGH), built from ordinary parts.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  R_DRIVE_HIGH_OHM,
  VDD_V,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
import { Bench, boardBench } from './build.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(`expected success, got ${o.error.code}`);
  return o;
};
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-15, Math.abs(b));

// ---------------------------------------------------------------------------------------------
// Slice 1 — RGB LED (Kingbright WP154A4SUREQBFZGC, common cathode), on/off per channel.

const CHANNELS = [
  { name: 'red', gpio: 4, ohms: 220 },
  { name: 'green', gpio: 16, ohms: 100 },
  { name: 'blue', gpio: 27, ohms: 100 },
] as const;

/** GPIO4/16/27 -> 220/100/100 Ω -> red/green/blue; common cathode to GND. */
function rgbOnPads() {
  let led = '';
  const bb = boardBench((b, u) => {
    led = b.add('component.rgb_led');
    b.psu(3.3, 0.1);
    for (const ch of CHANNELS) {
      const r = b.add('component.resistor');
      b.ohms(r, ch.ohms).wire(`${u}.gpio${ch.gpio}`, `${r}.a`).wire(`${r}.b`, `${led}.${ch.name}`);
    }
    b.wire(`${led}.cathode`, 'GND1.ref');
  });
  return { ...bb, led };
}

/** Reference for one channel ON: a 3.3 V supply behind (16.5 Ω + R) into that channel only. */
function rgbReference(channel: (typeof CHANNELS)[number]): number {
  const b = new Bench();
  const led = b.add('component.rgb_led');
  const r = b.add('component.resistor');
  b.psu(VDD_V, 0.1).ohms(r, R_DRIVE_HIGH_OHM + channel.ohms);
  b.wire('PSU1.positive', `${r}.a`).wire(`${r}.b`, `${led}.${channel.name}`);
  b.wire(`${led}.cathode`, 'GND1.ref').wire('PSU1.negative', 'GND1.ref');
  return ok(new EngineSession(b.snapshot()).solve()).components[led]!.currents![channel.name]!;
}

describe('RGB LED on ESP32 pads (slice 1)', () => {
  const refs = Object.fromEntries(CHANNELS.map((c) => [c.name, rgbReference(c)]));

  it('each of the 8 on/off colours: every channel current equals its independent reference', () => {
    const { projected, pins, led } = rgbOnPads();
    const s = new EngineSession(projected, { pins });
    for (let bits = 0; bits < 8; bits++) {
      CHANNELS.forEach((ch, k) =>
        s.setPinMode(ch.gpio, bits & (1 << k) ? 'output-high' : 'output-low'),
      );
      const out = ok(s.solve());
      CHANNELS.forEach((ch, k) => {
        const i = out.components[led]!.currents![ch.name]!;
        if (bits & (1 << k))
          expect(rel(i, refs[ch.name]!), `${bits}:${ch.name}`).toBeLessThan(1e-9);
        else expect(Math.abs(i), `${bits}:${ch.name}`).toBeLessThan(1e-9);
      });
    }
    // Plausible magnitudes: red a few mA through 220 Ω; green/blue dimmer (higher V_F).
    expect(refs.red!).toBeGreaterThan(4e-3);
    expect(refs.green!).toBeGreaterThan(1e-3);
    expect(refs.blue!).toBeGreaterThan(1e-3);
  });

  it('a channel straight from a pad (no resistor): pad and LED over-current warnings, value still solved', () => {
    const bb = boardBench((b, u) => {
      const led = b.add('component.rgb_led');
      b.psu(3.3, 0.1).wire(`${u}.gpio4`, `${led}.red`).wire(`${led}.cathode`, 'GND1.ref');
    });
    const s = new EngineSession(bb.projected, { pins: bb.pins });
    s.setPinMode(4, 'output-high');
    const out = ok(s.solve());
    const i = out.components.D1!.currents!.red!;
    expect(i).toBeGreaterThan(0.04);
    const codes = ratingWarnings(bb.full, out).map((w) => w.code);
    expect(codes).toContain('gpio_source_current');
    expect(codes).toContain('forward_current');
  });
});
