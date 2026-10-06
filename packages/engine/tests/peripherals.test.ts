/**
 * Sprint 10 (internal): device semantics for parts the deployed ESP32 runtime cannot drive yet
 * (servo control pulses, ultrasonic echo timing, DHT22 single-wire frames). Deterministic and
 * MCU-agnostic; checked against the datasheet figures they cite.
 */
import { describe, expect, it } from 'vitest';
import { SG90, Servo } from '../src/peripherals/servo.js';
import { HC_SR04, hcsr04Echo, speedOfSound } from '../src/peripherals/hcsr04.js';
import { decodeDht22, dht22Frame, dht22Waveform } from '../src/peripherals/dht22.js';

const ms = (v: number) => BigInt(Math.round(v * 1e6));

/** A 50 Hz pulse train of a given width, from `t0` ms for `frames` frames. */
function drive(s: Servo, widthUs: number, frames: number, t0 = 0) {
  for (let k = 0; k < frames; k++) {
    const rise = t0 + 20 * k;
    s.edge(ms(rise), 1);
    s.edge(ms(rise) + BigInt(Math.round(widthUs * 1000)), 0);
  }
  return t0 + 20 * frames;
}

describe('SG90 servo: position only from the control signal', () => {
  it('1.0 / 1.5 / 2.0 ms pulses command 0 / 90 / 180 degrees; the output slews at 600 deg/s', () => {
    const s = new Servo();
    expect(s.angleDeg).toBe(90);
    let t = drive(s, 1000, 1);
    expect(s.commandedDeg).toBe(0);
    // The command takes effect at the pulse's end (1 ms); 49 ms later at 600 deg/s the output has
    // moved 29.4 degrees towards 0 (it started at 90).
    s.advanceTo(ms(t + 30));
    expect(s.angleDeg).toBeCloseTo(90 - 600 * 0.049, 6);
    t = drive(s, 1000, 20, t + 30);
    expect(s.angleDeg).toBe(0);
    t = drive(s, 2000, 30, t);
    expect(s.angleDeg).toBe(180);
    drive(s, 1500, 30, t);
    expect(s.angleDeg).toBe(90);
  });

  it('is bounded, ignores invalid pulses and changes within the deadband, and holds without pulses', () => {
    const s = new Servo();
    let t = drive(s, 2400, 20);
    expect(s.commandedDeg).toBe(180); // clamped to the travel
    t = drive(s, 3000, 5, t); // invalid width: ignored
    expect(s.commandedDeg).toBe(180);
    t = drive(s, 1500, 20, t);
    const before = s.commandedDeg;
    t = drive(s, 1505, 5, t); // 5 us < 10 us deadband
    expect(s.commandedDeg).toBe(before);
    s.advanceTo(ms(t + 5000)); // no pulses for 5 s: holds
    expect(s.angleDeg).toBe(90);
    expect(SG90.deadbandUs).toBe(10);
  });

  it('is deterministic', () => {
    const run = () => {
      const s = new Servo();
      drive(s, 1234, 7);
      return [s.angleDeg, s.commandedDeg, s.pulses.length];
    };
    expect(run()).toEqual(run());
  });
});

describe('HC-SR04 echo timing', () => {
  it('echo width = 2 d / c: about 58 us per cm at 340 m/s, after the 8-cycle burst', () => {
    const e = hcsr04Echo(0n, 10, 1.0, 20)!;
    expect(e.widthUs).toBeCloseTo((2 / speedOfSound(20)) * 1e6, 6);
    expect(e.widthUs / 100).toBeGreaterThan(57);
    expect(e.widthUs / 100).toBeLessThan(59);
    expect(Number(e.riseNs)).toBe(HC_SR04.burstUs * 1000);
    // Warmer air is faster: a shorter echo for the same distance.
    expect(hcsr04Echo(0n, 10, 1.0, 35)!.widthUs).toBeLessThan(e.widthUs);
  });
  it('no echo for a short trigger or outside 2 cm - 4 m (none is invented)', () => {
    expect(hcsr04Echo(0n, 5, 1.0)).toBeNull();
    expect(hcsr04Echo(0n, 10, 0.01)).toBeNull();
    expect(hcsr04Echo(0n, 10, 4.5)).toBeNull();
  });
});

describe('DHT22 frames', () => {
  it("reproduces the datasheet's worked example (65.2 %RH, 35.1 degC, checksum 0xEE)", () => {
    expect(dht22Frame(65.2, 35.1)).toEqual([0x02, 0x8c, 0x01, 0x5f, 0xee]);
    expect(decodeDht22([0x02, 0x8c, 0x01, 0x5f, 0xee])).toEqual({ rh: 65.2, tempC: 35.1 });
  });
  it('encodes negative temperatures with the sign bit, rejects bad checksums and out-of-range values', () => {
    const f = dht22Frame(40, -10.1)!;
    expect(f[2]! & 0x80).toBe(0x80);
    expect(decodeDht22(f)).toEqual({ rh: 40, tempC: -10.1 });
    expect(decodeDht22([...f.slice(0, 4), (f[4]! + 1) & 0xff])).toBeNull();
    expect(dht22Frame(101, 20)).toBeNull();
  });
  it('drives the response and 40 bits with the datasheet timing (27 us = 0, 70 us = 1)', () => {
    const w = dht22Waveform(dht22Frame(65.2, 35.1)!);
    expect(w.slice(0, 2)).toEqual([
      [0, 80],
      [1, 80],
    ]);
    expect(w.length).toBe(2 + 80 + 1);
    // First bit of 0x02 is 0; the 7th is 1.
    expect(w[3]).toEqual([1, 27]);
    expect(w[2 + 2 * 6 + 1]).toEqual([1, 70]);
  });
});
