/**
 * W1 preflight for C5b (alpha-deployed-recovery), run by the W1 driver BEFORE admission closes, with exactly the
 * environment C5b gets (the driver's c5b_env). Read-only; it starts no session.
 *
 * Alpha W1 retry (2026-11-11): C5b failed at its first line, 'TbiGpioProof ... is not provisioned', because the
 * harness resolved its firmware under a default runtime directory nothing had provisioned. This checks:
 * - TBI_RUNTIME_HOME is set and is the directory the driver names (TBI_C5B_EXPECT_HOME), and the harness uses it;
 * - TbiGpioProof loads from there through the same `artifact()` C5b calls, and its bytes hash to the pinned sha256;
 * - every pin the TbiGpioProof source reads is held by a resistor to a supply rail or ground in the circuit C5b
 *   and the C-5 gpio workload use (no undefined input: Runtime v5 refuses such a read), and C5b uses that circuit.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { programInputReads } from '@tbi-lab/domain';
import { RUNTIME_HOME, artifact } from '../harness/env.js';
import type { Circuit } from '../host/tests/r1-support.js';
import { gpioProofCircuit, legacyGpioProofCircuit } from './c5-circuits.js';

const PINNED = '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af';
const source = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** The pins `reads` whose pad is not attached to a resistor whose other end is wired to PSU1.positive or GND1.ref. */
function undefinedInputs(c: Circuit, reads: readonly number[]): number[] {
  const rails = new Set(['PSU1.positive', 'GND1.ref']);
  const end = (e: { kind: string; component?: string; terminal?: string }) =>
    e.kind === 'terminal' ? `${e.component}.${e.terminal}` : '';
  const wired = (a: string) =>
    c.doc.layout.wires.flatMap((w) =>
      end(w.from) === a ? [end(w.to)] : end(w.to) === a ? [end(w.from)] : [],
    );
  return reads.filter((gpio) => {
    const held = c.attachments.some((at) => {
      if (at.gpio !== gpio) return false;
      const comp = c.doc.components.find((x) => x.id === at.component);
      if (comp?.type !== 'component.resistor') return false;
      const other = `${at.component}.${at.terminal === 'a' ? 'b' : 'a'}`;
      return wired(other).some((t) => rails.has(t));
    });
    return !held;
  });
}

describe('C5b preflight (W1, before the close)', () => {
  it('runtime directory: the one the driver names, and the one the harness resolves', () => {
    const want = process.env.TBI_C5B_EXPECT_HOME;
    expect(want, 'TBI_C5B_EXPECT_HOME (set by the driver)').toBeTruthy();
    expect(process.env.TBI_RUNTIME_HOME).toBe(want);
    expect(RUNTIME_HOME).toBe(want);
  });

  it('TbiGpioProof loads from that directory and hashes to the pinned sha256', () => {
    const a = artifact('TbiGpioProof');
    expect(a.sha256).toBe(PINNED);
    expect(a.path).toBe(join(RUNTIME_HOME, 'artifacts', `${PINNED}.bin`));
    expect(createHash('sha256').update(readFileSync(a.path)).digest('hex')).toBe(PINNED);
    // C5b uploads exactly this image and leases it by the same id.
    expect(source('./alpha-deployed-recovery.runtime.test.ts')).toContain(
      `const R1_IMAGE = '${PINNED}'`,
    );
  });

  it('every input TbiGpioProof reads has a defined level in the circuit C5b and the gpio workload use', () => {
    const reads = programInputReads({
      language: 'arduino-cpp',
      profile: '',
      fileName: 'sketch.ino',
      text: source('../firmware/arduino/TbiGpioProof/TbiGpioProof.ino'),
    });
    expect(reads).toEqual({ pins: [5], unresolved: false });
    expect(undefinedInputs(gpioProofCircuit(), reads.pins)).toEqual([]);
    // The check is not vacuous: the circuit of the 2026-11-11 retry leaves GPIO5 undefined.
    expect(undefinedInputs(legacyGpioProofCircuit(), reads.pins)).toEqual([5]);
    const c5b = source('./alpha-deployed-recovery.runtime.test.ts');
    expect(c5b).toContain('circuit: PROOF.circuit');
    expect(c5b).toContain(': gpioProofCircuit();');
    expect(source('./c5-deployed.runtime.test.ts')).toContain(': gpioProofCircuit();');
  });
});
