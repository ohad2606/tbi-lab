/**
 * RC4 packaging gate G3: the release profile is validated against the source it builds, and a
 * built frontend against its profile. Synthetic trees cover each refusal; the real profile is
 * checked against this repository's own source.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEnvironment, loadProfile, sourceViteSettings, validate } from '../release-config.mjs';
import { checkDist } from '../check-dist.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const RC4 = join(ROOT, 'deploy/release/rc4.release.json');
const RC4_REPORTS = join(ROOT, 'deploy/release/rc4-reports.release.json');
const TOOLS = { node: 'v24.21.0', npm: '11.19.0' };

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function tree(files) {
  const d = mkdtempSync(join(tmpdir(), 'tbi-relcfg-'));
  dirs.push(d);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}
const reads = (names) => names.map((n) => `import.meta.env.${n};`).join('\n');
const RC4_SETTINGS = Object.keys(loadProfile(RC4).vite);

describe('release profile vs source', () => {
  it('the RC4 profile pins exactly the settings this source reads, Active Minutes absent', () => {
    expect([...sourceViteSettings(ROOT).keys()].sort()).toEqual([...RC4_SETTINGS].sort());
    expect(RC4_SETTINGS).toHaveLength(8);
    expect(validate(loadProfile(RC4), ROOT, TOOLS)).toEqual([]);
    expect(validate(loadProfile(RC4_REPORTS), ROOT, TOOLS)).toEqual([]);
  });

  it('a setting the source reads but the profile does not pin is refused', () => {
    const src = tree({ 'app/src/a.ts': reads([...RC4_SETTINGS, 'VITE_NEW_THING']) });
    expect(validate(loadProfile(RC4), src, TOOLS)).toEqual([
      'unpinned setting VITE_NEW_THING (read by app/src/a.ts)',
    ]);
  });

  it('a pinned setting the source no longer reads is refused', () => {
    const src = tree({
      'app/src/a.ts': reads(RC4_SETTINGS.filter((n) => n !== 'VITE_BUILD_BASE')),
    });
    expect(validate(loadProfile(RC4), src, TOOLS)).toEqual([
      'pinned setting VITE_BUILD_BASE is not read by the source',
    ]);
  });

  it('Active Minutes in the source is refused: absent, not merely disabled', () => {
    const src = tree({
      'app/src/a.ts': reads([...RC4_SETTINGS, 'VITE_ACTIVITY_ENDPOINT']),
      'app/src/usage/activity.ts': 'export {};',
    });
    const errors = validate(loadProfile(RC4), src, TOOLS);
    expect(errors).toContain(
      'excluded setting VITE_ACTIVITY_ENDPOINT is read by the source (app/src/a.ts): the feature must be absent',
    );
    expect(errors).toContain('excluded path app/src/usage is present in the source');
  });

  it('Report a Problem switches must be explicit and agree (app and host)', () => {
    const src = tree({ 'app/src/a.ts': reads(RC4_SETTINGS) });
    const p = loadProfile(RC4);
    expect(
      validate({ ...p, vite: { ...p.vite, VITE_PROBLEM_REPORTS: null } }, src, TOOLS),
    ).toContain('VITE_PROBLEM_REPORTS must be pinned to "0" or "1"');
    expect(validate({ ...p, host: { TBI_REPORTS_DIR: '/var/lib/x' } }, src, TOOLS)).toContain(
      'host.TBI_REPORTS_DIR must be null when the app switch is off',
    );
    expect(
      validate({ ...p, vite: { ...p.vite, VITE_PROBLEM_REPORTS: '1' } }, src, TOOLS),
    ).toContain('host.TBI_REPORTS_DIR must be an absolute path when the app switch is on');
  });

  it('unpinned tools, an empty string, the feedback form and a non-dev-lab build are refused', () => {
    const src = tree({ 'app/src/a.ts': reads(RC4_SETTINGS) });
    const p = loadProfile(RC4);
    expect(validate(p, src, { node: 'v22.0.0', npm: '11.19.0' })).toEqual([
      'node: pinned v24.21.0, running v22.0.0',
    ]);
    expect(validate({ ...p, vite: { ...p.vite, VITE_PREVIEW_NAME: '' } }, src, TOOLS)).toEqual([
      'VITE_PREVIEW_NAME: use null for "unset" (an empty string can override a code default)',
    ]);
    expect(
      validate(
        { ...p, vite: { ...p.vite, VITE_FEEDBACK_URL: 'https://forms.example/x' } },
        src,
        TOOLS,
      ),
    ).toEqual([
      'VITE_FEEDBACK_URL must stay null (external form needs owner approval, Sprint 13 H7)',
    ]);
    expect(validate({ ...p, build: { ...p.build, TBI_BUILD_ENV: 'alpha' } }, src, TOOLS)).toEqual([
      'build.TBI_BUILD_ENV: the deployed build verifier expects dev-lab, not alpha',
    ]);
  });

  it('the build environment is the profile and the identity only; null settings are absent', () => {
    const env = buildEnvironment(loadProfile(RC4), {
      commit: 'a'.repeat(40),
      time: '2026-10-18T12:00:00Z',
      path: '/usr/bin',
      home: '/home/x',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      LC_ALL: 'C',
      TZ: 'UTC',
      TBI_BUILD_COMMIT: 'a'.repeat(40),
      TBI_BUILD_ENV: 'dev-lab',
      TBI_BUILD_TIME: '2026-10-18T12:00:00Z',
      VITE_BUILD_BASE: '/build',
      VITE_PROBLEM_REPORTS: '0',
      VITE_RUNTIME_BASE: '/runtime',
      VITE_SIGN_OUT_URL: '/oauth2/sign_out',
    });
    expect(() =>
      buildEnvironment(loadProfile(RC4), { commit: 'abc', time: 'now', path: '', home: '' }),
    ).toThrow(/40 hex/);
  });
});

describe('built frontend vs profile', () => {
  const sw = (v) =>
    `function gt(e){return typeof e==\`string\`&&e.trim()===\`1\`}var _t=gt(${v}),x=\`/build\`,y=\`/runtime\`,z=\`/oauth2/sign_out\`;`;
  const dist = (js, sources = ['../../src/main.tsx']) =>
    tree({
      'assets/index-x.js': js,
      'assets/index-x.js.map': JSON.stringify({ version: 3, sources, mappings: '' }),
    });

  it('accepts a build that matches its profile', () => {
    expect(checkDist(loadProfile(RC4), dist(sw('`0`'))).errors).toEqual([]);
    expect(checkDist(loadProfile(RC4_REPORTS), dist(sw('`1`'))).errors).toEqual([]);
  });

  it('refuses a switch compiled differently from the profile, or one it cannot locate', () => {
    expect(checkDist(loadProfile(RC4), dist(sw('`1`'))).errors).toEqual([
      'Report a Problem switch compiled as `1`, profile pins `0`',
    ]);
    expect(checkDist(loadProfile(RC4), dist(sw('void 0'))).errors).toEqual([
      'Report a Problem switch compiled as void 0, profile pins `0`',
    ]);
    expect(
      checkDist(loadProfile(RC4), dist('x=`/build`,y=`/runtime`,z=`/oauth2/sign_out`')).errors,
    ).toEqual(['Report a Problem switch: found 0 compiled switches, expected 1']);
  });

  it('refuses Active Minutes modules, excluded settings and uncompiled settings in the bundle', () => {
    const errors = checkDist(
      loadProfile(RC4),
      dist(`${sw('`0`')}import.meta.env.VITE_ACTIVITY_ENDPOINT`, ['../../src/usage/activity.ts']),
    ).errors;
    expect(errors).toContain(
      'index-x.js.map: bundles ../../src/usage/activity.ts (excluded: app/src/usage)',
    );
    expect(errors).toContain('bundle names excluded setting VITE_ACTIVITY_ENDPOINT');
    expect(errors).toContain('VITE_ACTIVITY_ENDPOINT was not compiled to a value');
  });
});
