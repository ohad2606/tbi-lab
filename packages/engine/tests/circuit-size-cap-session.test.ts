/**
 * The circuit-size cap at session level: an oversize board is an explicit engine failure, and the
 * logic bound corner solves (logic/bounds.ts), whose ideal sources add one branch unknown per
 * replaced stage, never refuse or crash a circuit the main solve accepted.
 */
import { describe, expect, it } from 'vitest';
import { EngineSession, MAX_UNKNOWNS, type SolveOutcome } from '../src/index.js';
import { Bench } from './build.js';

const solve = (b: Bench) => new EngineSession(b.snapshot()).solve();

/** `n` 1 kΩ resistors in series from PSU1+ to GND: n − 1 nodes of their own. */
function chain(b: Bench, n: number): Bench {
  let from = 'PSU1.positive';
  for (let i = 0; i < n; i++) {
    const r = b.add('component.resistor');
    b.ohms(r, 1000).wire(from, `${r}.a`);
    from = `${r}.b`;
  }
  return b.wire(from, 'GND1.ref');
}

/**
 * An SN74LVC1G08 with both inputs at GND (Y LOW) and a 10 kΩ pull-up on Y, padded by a resistor
 * chain across the supply. Its bound check solves corners with Y replaced by an ideal source.
 */
function gateBench(padding: number): Bench {
  const b = new Bench();
  const g = b.add('logic.gate_and');
  const r = b.add('component.resistor');
  b.psu(3.3, 0.5).wire('PSU1.negative', 'GND1.ref');
  b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
  b.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref');
  b.ohms(r, 10_000).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, 'PSU1.positive');
  return padding ? chain(b, padding) : b;
}

const unknowns = (o: SolveOutcome) => {
  if (!o.ok) throw new Error(`refused: ${JSON.stringify(o.error)}`);
  return o.stats.unknowns;
};

describe('circuit size cap: session', () => {
  it('reports an oversize circuit as the engine error circuit_too_large, not a throw', () => {
    // MAX_UNKNOWNS + 1 resistors in series: MAX_UNKNOWNS + 1 nodes + the supply's branch.
    const b = new Bench();
    b.psu(5, 0.1).wire('PSU1.negative', 'GND1.ref');
    const o = solve(chain(b, MAX_UNKNOWNS + 1));
    expect(o.ok).toBe(false);
    expect(!o.ok && o.error).toEqual({
      code: 'circuit_too_large',
      detail: { limit: MAX_UNKNOWNS, actual: MAX_UNKNOWNS + 2 },
    });
  });
});

describe('circuit size cap: logic bound corner solves', () => {
  const base = unknowns(solve(gateBench(0)));
  /** Chain length that brings the main solve to `size` unknowns (n resistors add n − 1). */
  const paddingFor = (size: number) => size - base + 1;

  for (const size of [MAX_UNKNOWNS - 1, MAX_UNKNOWNS])
    it(`a gate circuit of ${size} unknowns is bounded like a small one (no throw)`, () => {
      const o = solve(gateBench(paddingFor(size)));
      expect(unknowns(o)).toBe(size);
    });

  it('a bound that fails is still refused at the cap, with the same finding', () => {
    // As review item 2 of Sprint 21: 3.3 V / 3.2 kΩ against a 1 mA limit is not guaranteed.
    const failing = (padding: number) => {
      const b = new Bench();
      const g = b.add('logic.gate_and');
      const r = b.add('component.resistor');
      b.psu(3.3, 0.001).wire('PSU1.negative', 'GND1.ref');
      b.wire('PSU1.positive', `${g}.vcc`).wire(`${g}.gnd`, 'GND1.ref');
      b.wire(`${g}.a`, 'GND1.ref').wire(`${g}.b`, 'GND1.ref');
      b.ohms(r, 3200).wire(`${g}.y`, `${r}.a`).wire(`${r}.b`, 'PSU1.positive');
      // The chain hangs on a second supply, so PSU1's current is the small circuit's.
      if (padding) {
        const rail = b.rail(5, 0.1);
        let from = `${rail}.positive`;
        for (let i = 0; i < padding; i++) {
          const x = b.add('component.resistor');
          b.ohms(x, 1000).wire(from, `${x}.a`);
          from = `${x}.b`;
        }
        b.wire(from, 'GND1.ref');
      }
      return solve(b);
    };
    const small = failing(0);
    expect(!small.ok && small.error.code).toBe('logic_supply_not_guaranteed');
    // The second supply adds its node and branch; n chain resistors add n − 1 nodes.
    const probe = failing(2);
    expect(!probe.ok && probe.error.code).toBe('logic_supply_not_guaranteed');
    const atCap = failing(MAX_UNKNOWNS - base - 2 + 1);
    expect(!atCap.ok && atCap.error).toEqual(!small.ok && small.error);
    // One more node and the MAIN solve is over the cap.
    const over = failing(MAX_UNKNOWNS - base - 2 + 2);
    expect(!over.ok && over.error).toEqual({
      code: 'circuit_too_large',
      detail: { limit: MAX_UNKNOWNS, actual: MAX_UNKNOWNS + 1 },
    });
  });
});
