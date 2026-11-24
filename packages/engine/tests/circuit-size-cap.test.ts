import { describe, expect, it } from 'vitest';
import {
  Circuit,
  CircuitTooLargeError,
  MAX_UNKNOWNS,
  Resistor,
  VoltageSource,
} from '../src/index.js';

/** A resistor ladder with `n` rungs: n+1 nodes plus one source branch = n+2 unknowns. */
function ladder(n: number): Circuit {
  const c = new Circuit();
  c.add(new VoltageSource('V', 'n0', '0', 5));
  for (let i = 0; i < n; i++) c.add(new Resistor(`R${i}`, `n${i}`, `n${i + 1}`, 100));
  c.add(new Resistor('RL', `n${n}`, '0', 100));
  return c;
}

describe('circuit size cap', () => {
  it('exports a generous default limit', () => {
    expect(MAX_UNKNOWNS).toBe(400);
  });

  it('rejects an oversize circuit with a typed error before solving', () => {
    const c = ladder(MAX_UNKNOWNS); // MAX_UNKNOWNS + 1 nodes + 1 branch
    let err: unknown;
    try {
      c.solve();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CircuitTooLargeError);
    const e = err as CircuitTooLargeError;
    expect(e.limit).toBe(MAX_UNKNOWNS);
    expect(e.actual).toBe(MAX_UNKNOWNS + 2);
    expect(e.message).toBe(
      `Circuit too large: ${MAX_UNKNOWNS + 2} unknowns (nodes + branches) exceeds the limit of ${MAX_UNKNOWNS}. Simplify the circuit.`,
    );
  });

  it('still solves a circuit exactly at the limit', () => {
    const c = ladder(MAX_UNKNOWNS - 2); // MAX_UNKNOWNS - 1 nodes + 1 branch = MAX_UNKNOWNS
    const r = c.solve();
    expect(r.x.length).toBe(MAX_UNKNOWNS);
  });

  it('honours an override', () => {
    const c = ladder(5);
    expect(() => c.solve({ maxUnknowns: 3 })).toThrow(CircuitTooLargeError);
    expect(c.solve({ maxUnknowns: 100 }).x.length).toBe(7);
  });
});
