/** Sprint 25 (Runtime v5): input-read and gpio-irq in the Arduino and MicroPython feature reports. */
import { describe, expect, it } from 'vitest';
import { analyzeFeatures } from '../features.js';
import { analyzeMicroPython } from '../pyFeatures.js';

const V4 = ['i2c', 'pad-func', 'pwm', 'sched-input', 'unmodelled'];
const V5 = ['gpio-irq', 'i2c', 'input-read', 'pad-func', 'pwm', 'sched-input', 'unmodelled'];
const button =
  'const int BTN = 5;\nvoid setup(){ pinMode(BTN, INPUT); pinMode(2, OUTPUT); }\nvoid loop(){ digitalWrite(2, digitalRead(BTN)); }';
const isr =
  'volatile int n;\nvoid IRAM_ATTR hit(){ n++; }\nvoid setup(){ pinMode(4, INPUT); attachInterrupt(digitalPinToInterrupt(4), hit, RISING); }\nvoid loop(){}';

describe('Arduino feature report', () => {
  it('Runtime v4: no input reads; an interrupt is declared (refused by the host and the app)', () => {
    const f = analyzeFeatures({ source: button, symbols: [], libraries: [], capabilities: V4 });
    expect(f.inputReads).toBeUndefined();
    expect(f.requires).toBeUndefined();
    const g = analyzeFeatures({
      source: isr,
      symbols: ['__attachInterruptFunctionalArg'],
      libraries: [],
      capabilities: V4,
    });
    expect(g.gpioInterrupt).toEqual([4]);
  });

  it('Runtime v5: the read pins, input-read required; an edge interrupt requires gpio-irq and is not refused', () => {
    expect(
      analyzeFeatures({ source: button, symbols: [], libraries: [], capabilities: V5 }),
    ).toMatchObject({
      requires: ['input-read'],
      inputReads: { pins: [5], unresolved: false },
    });
    const g = analyzeFeatures({
      source: isr,
      symbols: ['__attachInterruptFunctionalArg'],
      libraries: [],
      capabilities: V5,
    });
    expect(g).toMatchObject({
      gpioInterrupt: [],
      requires: ['gpio-irq', 'input-read'],
      inputReads: { pins: [4], unresolved: false },
    });
  });

  it('Runtime v5: an interrupt on a pin that cannot be told watches every wired pad', () => {
    const g = analyzeFeatures({
      source: 'void setup(){ attachInterrupt(pin, hit, FALLING); }',
      symbols: ['__attachInterruptFunctionalArg'],
      libraries: [],
      capabilities: V5,
    });
    expect(g.inputReads).toEqual({ pins: [], unresolved: true });
  });
});

describe('MicroPython feature report', () => {
  const prog =
    'from machine import Pin\nb = Pin(34, Pin.IN)\nb.irq(trigger=Pin.IRQ_RISING, handler=lambda p: None)\n';
  it('Runtime v4: no input reads, no gpio-irq (Pin.irq is refused at run by the runtime)', () => {
    const f = analyzeMicroPython(prog, V4);
    expect(f.inputReads).toBeUndefined();
    expect(f.requires ?? []).not.toContain('gpio-irq');
  });
  it('Runtime v5: Pin.irq requires gpio-irq; the pins are watched', () => {
    expect(analyzeMicroPython(prog, V5)).toMatchObject({
      requires: ['gpio-irq', 'input-read'],
      inputReads: { pins: [34], unresolved: false },
    });
  });
});
