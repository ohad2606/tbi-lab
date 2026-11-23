/** TBI-019 G5: the in-memory registry of the learner's copy per guide. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGuideCopies,
  forgetGuideCopy,
  lookupGuideCopy,
  rememberGuideCopy,
} from './guideCopies.js';

beforeEach(clearGuideCopies);

describe('guide copy registry', () => {
  it('finds nothing before anything is remembered', () => {
    expect(lookupGuideCopy('led-resistor', ['p1'])).toBeUndefined();
  });

  it('remembers a copy per guide and finds it while the project exists', () => {
    rememberGuideCopy('led-resistor', 'p1');
    rememberGuideCopy('button', 'p2');
    expect(lookupGuideCopy('led-resistor', ['p2', 'p1'])).toBe('p1');
    expect(lookupGuideCopy('button', new Set(['p2']))).toBe('p2');
  });

  it('forgets the mapping when the project was deleted', () => {
    rememberGuideCopy('led-resistor', 'p1');
    expect(lookupGuideCopy('led-resistor', ['other'])).toBeUndefined();
    // Gone for good, even if an id with that name shows up again.
    expect(lookupGuideCopy('led-resistor', ['p1'])).toBeUndefined();
  });

  it('a fresh copy replaces the mapping', () => {
    rememberGuideCopy('led-resistor', 'p1');
    rememberGuideCopy('led-resistor', 'p3');
    expect(lookupGuideCopy('led-resistor', ['p1', 'p3'])).toBe('p3');
  });

  it('forget removes the mapping', () => {
    rememberGuideCopy('button', 'p2');
    forgetGuideCopy('button');
    expect(lookupGuideCopy('button', ['p2'])).toBeUndefined();
  });

  it('never touches web storage', () => {
    const spy = vi.fn();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { l: g.localStorage, s: g.sessionStorage };
    const trap = { setItem: spy, getItem: spy, removeItem: spy };
    g.localStorage = trap;
    g.sessionStorage = trap;
    try {
      rememberGuideCopy('led-resistor', 'p1');
      lookupGuideCopy('led-resistor', ['p1']);
      forgetGuideCopy('led-resistor');
    } finally {
      g.localStorage = saved.l;
      g.sessionStorage = saved.s;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
