import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoadingStatus } from '../src/loading-status.js';

describe('loading status (WCAG 4.1.3: one announcement for any number of loaders)', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const setup = () => {
    const status = createLoadingStatus(100);
    const seen: boolean[] = [];
    status.subscribe((shown) => seen.push(shown));
    return { status, seen };
  };

  it('starts silent and speaks only after the delay, so the region exists empty first', () => {
    const { status, seen } = setup();
    status.begin();
    expect(seen).toEqual([false]);
    vi.advanceTimersByTime(99);
    expect(seen).toEqual([false]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([false, true]);
  });

  it('says nothing about a load that ends before the delay', () => {
    const { status, seen } = setup();
    status.begin()();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([false]);
  });

  it('stays on until the last of several loaders ends', () => {
    const { status, seen } = setup();
    const first = status.begin();
    const second = status.begin();
    vi.advanceTimersByTime(100);
    first();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([false, true]);
    second();
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([false, true, false]);
  });

  it('counts a release once, however often it is called', () => {
    const { status, seen } = setup();
    const first = status.begin();
    status.begin();
    first();
    first();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([false, true]);
  });

  it('does not repeat itself when one loader hands over to another', () => {
    const { status, seen } = setup();
    const first = status.begin();
    vi.advanceTimersByTime(100);
    first();
    vi.advanceTimersByTime(50);
    status.begin();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([false, true]);
  });

  it('is not postponed for ever by loaders that keep arriving', () => {
    const { status, seen } = setup();
    status.begin();
    vi.advanceTimersByTime(60);
    status.begin();
    vi.advanceTimersByTime(40);
    expect(seen).toEqual([false, true]);
  });

  it('speaks again for a later load, tells a late subscriber, and forgets a gone one', () => {
    const status = createLoadingStatus(100);
    const end = status.begin();
    vi.advanceTimersByTime(100);
    const seen: boolean[] = [];
    const off = status.subscribe((shown) => seen.push(shown));
    expect(seen).toEqual([true]);
    end();
    vi.advanceTimersByTime(100);
    status.begin();
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([true, false, true]);
    off();
    status.begin();
    expect(seen).toEqual([true, false, true]);
  });
});
