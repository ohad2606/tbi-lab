/**
 * Build identity (Sprint 10): one object per build, compiled into the app and published as
 * /version.json; deterministic for a commit and environment except the build timestamp.
 */
import { describe, expect, it } from 'vitest';
import { makeBuildInfo, versionJson } from '../buildInfo.config.js';
import { parseBuildInfo, versionLabel } from '../src/buildInfo.js';
import { parsePreviewName } from '../src/deployment.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';

const SHA = '9c94329691e69dabc42abc938f21b3a7388167d5';

describe('build identity', () => {
  it('carries product, version, environment, full and short commit, and a build timestamp', () => {
    const info = makeBuildInfo({
      version: '0.10-dev\n',
      commit: SHA,
      environment: 'dev-lab',
      builtAt: '2026-10-06T14:00:00Z',
    });
    expect(info).toEqual({
      product: 'TBI Lab',
      version: '0.10-dev',
      environment: 'dev-lab',
      commit: SHA,
      shortCommit: '9c94329',
      builtAt: '2026-10-06T14:00:00.000Z',
      dirty: false,
    });
    expect(versionLabel(info)).toBe('v0.10-dev · 9c94329');
    expect(parseBuildInfo(JSON.parse(versionJson(info)))).toEqual(info);
  });

  it('is deterministic for a commit and environment except the approved timestamp field', () => {
    const a = makeBuildInfo({
      version: '0.10-dev',
      commit: SHA,
      environment: 'dev-lab',
      builtAt: '2026-10-06T14:00:00Z',
    });
    const b = makeBuildInfo({
      version: '0.10-dev',
      commit: SHA,
      environment: 'dev-lab',
      builtAt: '2026-10-07T09:30:00Z',
    });
    expect({ ...a, builtAt: '' }).toEqual({ ...b, builtAt: '' });
    // The same inputs give the same bytes (the deployment's pre-build comparison relies on it).
    expect(versionJson(a)).toBe(
      versionJson(
        makeBuildInfo({
          version: '0.10-dev',
          commit: SHA,
          environment: 'dev-lab',
          builtAt: '2026-10-06T14:00:00Z',
        }),
      ),
    );
  });

  it('refuses malformed identities (never shows a wrong commit)', () => {
    expect(() => makeBuildInfo({ version: '0.10-dev', commit: 'abc' })).toThrow();
    expect(() => makeBuildInfo({ version: 'next', commit: SHA })).toThrow();
    expect(() =>
      makeBuildInfo({ version: '0.10-dev', commit: SHA, environment: 'Dev Lab' }),
    ).toThrow();
    expect(
      parseBuildInfo({
        ...makeBuildInfo({ version: '0.10-dev', commit: SHA }),
        shortCommit: '1234567',
      }),
    ).toBeNull();
    expect(parseBuildInfo(null)).toBeNull();
  });

  it('a local build from a dirty tree says so; the label marks it', () => {
    const info = makeBuildInfo({ version: '0.10-dev', commit: SHA, dirty: true });
    expect(versionLabel(info)).toBe('v0.10-dev · 9c94329+');
  });

  it('the label and details are technical tokens in every language (EN/HE): nothing to reverse', () => {
    const label = versionLabel(makeBuildInfo({ version: '0.10-dev', commit: SHA }));
    expect(label).toMatch(/^[\x20-\x7e·]+$/); // ASCII and the middle dot only: no bidi-sensitive text
    for (const k of Object.keys(en).filter((k) => k.startsWith('version.')))
      expect((he as Record<string, string>)[k], k).toBeTruthy();
  });

  it('a normal (non-preview) deployment has no preview name', () => {
    expect(parsePreviewName(undefined)).toBeNull();
    expect(parsePreviewName('')).toBeNull();
  });
});
