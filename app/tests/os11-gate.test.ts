/**
 * OS-11 (P1): the app's background requests must never start a login at the gate. After the gate
 * session expired, a background request without `Accept: application/json` made oauth2-proxy start
 * a new login and overwrite the CSRF cookie of the user's own login in flight (403 "CSRF token
 * mismatch"; reproduced on the real proxy in runtime/tests/os11-gate.runtime.test.ts). These tests
 * pin the app side: every background request carries application/json, a 401 is reported once
 * as "signed out", and no code path calls fetch around the gate helper.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gateFetch,
  isSignedOut,
  onSignedOut,
  resetGateForTests,
  withGateAccept,
} from '../src/gate.js';
import { BuildClient } from '../src/programs/client.js';
import { RuntimeClient } from '../src/runtime/client.js';
import { probeRuntime } from '../src/runtimeInfo.js';

const accept = (init?: RequestInit) => new Headers(init?.headers).get('accept') ?? '';

describe('withGateAccept', () => {
  it('adds application/json, keeps an existing Accept first, never duplicates', () => {
    expect(accept(withGateAccept())).toBe('application/json');
    expect(accept(withGateAccept({ headers: { accept: 'text/event-stream' } }))).toBe(
      'text/event-stream, application/json',
    );
    expect(accept(withGateAccept({ headers: { Accept: 'application/json' } }))).toBe(
      'application/json',
    );
    expect(accept(withGateAccept({}, '*/*'))).toBe('*/*, application/json');
    // Other headers and fields survive.
    const i = withGateAccept({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(i.method).toBe('POST');
    expect(new Headers(i.headers).get('content-type')).toBe('application/json');
  });
});

describe('gateFetch and the signed-out signal', () => {
  beforeEach(() => resetGateForTests());
  it('a 401 is reported once; other statuses are not', async () => {
    const heard = vi.fn();
    onSignedOut(heard);
    const res = (status: number) => async () => new Response('{}', { status });
    await gateFetch('/x', {}, undefined, res(200));
    await gateFetch('/x', {}, undefined, res(404));
    expect(isSignedOut()).toBe(false);
    await gateFetch('/x', {}, undefined, res(401));
    await gateFetch('/x', {}, undefined, res(401));
    expect(isSignedOut()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('every default client goes through the gate helper', () => {
  const seen: { url: string; accept: string }[] = [];
  beforeEach(() => {
    resetGateForTests();
    seen.length = 0;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), accept: accept(init) });
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('runtime health, build service, Session Host: Accept carries application/json; 401 -> signed out', async () => {
    expect(await probeRuntime()).toBeNull();
    await new BuildClient()
      .build('esp32-arduino-3.3.12', [{ name: 'a.ino', text: '' }])
      .catch(() => undefined);
    await new RuntimeClient().request('GET', '/health').catch(() => undefined);
    expect(seen.map((s) => s.url)).toEqual([
      '/runtime/health',
      '/build/v1/builds',
      '/runtime/health',
    ]);
    for (const s of seen) expect(s.accept.split(/,\s*/)).toContain('application/json');
    expect(isSignedOut()).toBe(true);
  });
});

describe('no background request bypasses the gate helper', () => {
  // A new fetch( call in the app would bring the defect back: it must use gateFetch.
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  it('only gate.ts calls the global fetch', () => {
    const root = new URL('../src', import.meta.url).pathname;
    const offenders = files(root).filter(
      (f) =>
        !f.endsWith('/gate.ts') &&
        /(^|[^.\w])fetch\(/m.test(
          readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''),
        ),
    );
    expect(offenders).toEqual([]);
  });
});
