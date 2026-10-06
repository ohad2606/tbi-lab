/**
 * New-version detection (Sprint 10): a served /version.json with another commit is reported, the
 * same commit is not, failures are silent, and stopping leaves no listener or timer behind.
 */
import { describe, expect, it } from 'vitest';
import type { BuildInfo } from '../src/buildInfo.js';
import { startUpdateCheck, type UpdateCheckEnv } from '../src/updateCheck.js';

const build = (c: string): BuildInfo => ({
  product: 'TBI Lab',
  version: '0.10-dev',
  environment: 'dev-lab',
  commit: c.repeat(40).slice(0, 40),
  shortCommit: c.repeat(7).slice(0, 7),
  builtAt: '2026-10-06T00:00:00.000Z',
  dirty: false,
});

/** A fake browser: event targets that count listeners, a manual timer, a scripted fetch. */
function fakeEnv(served: () => unknown, ok = true) {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (t: string, f: () => void) =>
      (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
    removeEventListener: (t: string, f: () => void) => listeners.get(t)?.delete(f),
  };
  const timers = new Map<number, () => void>();
  let next = 1;
  const doc = { ...target, visibilityState: 'visible' as DocumentVisibilityState };
  let fetches = 0;
  const env: UpdateCheckEnv = {
    fetch: async () => {
      fetches++;
      return { ok, json: async () => served() };
    },
    window: target as unknown as UpdateCheckEnv['window'],
    document: doc as unknown as UpdateCheckEnv['document'],
    setInterval: (fn) => {
      timers.set(next, fn);
      return next++;
    },
    clearInterval: (id) => timers.delete(id as number),
  };
  const fire = (t: string) => [...(listeners.get(t) ?? [])].forEach((f) => f());
  const tick = () => [...timers.values()].forEach((f) => f());
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { env, fire, tick, count, timers, doc, settle, fetches: () => fetches };
}

describe('new-version detection', () => {
  it('reports a served build with another commit (on focus and on the timer)', async () => {
    const f = fakeEnv(() => build('b'));
    const seen: string[] = [];
    const stop = startUpdateCheck(build('a'), (s) => seen.push(s.shortCommit), f.env);
    f.fire('focus');
    await f.settle();
    expect(seen).toEqual(['bbbbbbb']);
    f.tick();
    await f.settle();
    expect(seen).toEqual(['bbbbbbb', 'bbbbbbb']); // the caller de-duplicates
    stop();
  });

  it('says nothing when the served build is the running one, or the response is bad', async () => {
    for (const served of [build('a'), { nonsense: true }, null]) {
      const f = fakeEnv(() => served);
      const seen: unknown[] = [];
      const stop = startUpdateCheck(build('a'), (s) => seen.push(s), f.env);
      f.fire('focus');
      f.tick();
      await f.settle();
      expect(seen).toEqual([]);
      stop();
    }
    const failing = fakeEnv(() => build('b'), false);
    const seen: unknown[] = [];
    const stop = startUpdateCheck(build('a'), (s) => seen.push(s), failing.env);
    failing.fire('focus');
    await failing.settle();
    expect(seen).toEqual([]);
    stop();
  });

  it('does not poll a hidden tab; becoming visible checks', async () => {
    const f = fakeEnv(() => build('b'));
    const seen: unknown[] = [];
    const stop = startUpdateCheck(build('a'), (s) => seen.push(s), f.env);
    f.doc.visibilityState = 'hidden';
    f.tick();
    await f.settle();
    expect(f.fetches()).toBe(0);
    f.doc.visibilityState = 'visible';
    f.fire('visibilitychange');
    await f.settle();
    expect(seen).toHaveLength(1);
    stop();
  });

  it('stop() leaves no listener and no timer (no polling leak)', async () => {
    const f = fakeEnv(() => build('b'));
    const stop = startUpdateCheck(build('a'), () => undefined, f.env);
    expect(f.count()).toBe(2);
    expect(f.timers.size).toBe(1);
    stop();
    expect(f.count()).toBe(0);
    expect(f.timers.size).toBe(0);
    f.fire('focus');
    await f.settle();
    expect(f.fetches()).toBe(0);
  });
});
