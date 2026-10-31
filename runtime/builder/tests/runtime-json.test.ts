/**
 * Sprint 25: the build service's runtime.json reader accepts every capability the bridge knows
 * (Runtime v5 adds gpio-irq, i2c-clock and input-read) and still fails closed on anything else.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../harness/protocol.js';
import { runtimeCapabilitiesFrom } from '../runtimeJson.js';

const dir = mkdtempSync(join(tmpdir(), 'tbi-runtime-json-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (body: unknown) => {
  const f = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(body));
  return f;
};

describe('runtime.json capabilities (build service start-up)', () => {
  it('Runtime v5 (39f2229a66d45e43): every capability is accepted, sorted', () => {
    const v5 = [
      'unmodelled',
      'sched-input',
      'pwm',
      'pad-func',
      'input-read',
      'i2c-clock',
      'i2c',
      'gpio-irq',
    ];
    expect(runtimeCapabilitiesFrom(file({ capabilities: v5 }))).toEqual([...CAPABILITIES]);
  });

  it('Runtime v4 and a pre-Sprint 12 runtime still load', () => {
    expect(
      runtimeCapabilitiesFrom(
        file({ capabilities: ['i2c', 'pad-func', 'pwm', 'sched-input', 'unmodelled'] }),
      ),
    ).toEqual(['i2c', 'pad-func', 'pwm', 'sched-input', 'unmodelled']);
    expect(runtimeCapabilitiesFrom(file({ runtimeId: 'x' }))).toEqual([]);
    expect(runtimeCapabilitiesFrom(undefined)).toEqual([]);
  });

  it('an unknown token or a malformed list fails closed', () => {
    expect(() => runtimeCapabilitiesFrom(file({ capabilities: ['i2c', 'adc'] }))).toThrow(
      /no valid "capabilities" list/,
    );
    expect(() => runtimeCapabilitiesFrom(file({ capabilities: 'i2c' }))).toThrow(/no valid/);
    expect(() => runtimeCapabilitiesFrom(file({ capabilities: [1] }))).toThrow(/no valid/);
  });
});
