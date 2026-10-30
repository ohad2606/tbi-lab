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
import { checkBranding, checkDist } from '../check-dist.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const RC4 = join(ROOT, 'deploy/release/rc4.release.json');
const RC4_REPORTS = join(ROOT, 'deploy/release/rc4-reports.release.json');
const DEV_LAB = join(ROOT, 'deploy/release/dev-lab.release.json');
const TOOLS = { node: 'v24.21.0', npm: '11.19.0', trackedFiles: () => [] };
const GIT = { node: 'v24.21.0', npm: '11.19.0' }; // the real tracked-file listing (git)

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
    expect(RC4_SETTINGS).toHaveLength(9);
    expect(validate(loadProfile(RC4), ROOT, GIT)).toEqual([]);
    expect(validate(loadProfile(RC4_REPORTS), ROOT, GIT)).toEqual([]);
    expect(validate(loadProfile(DEV_LAB), ROOT, GIT)).toEqual([]);
  });

  it('DEV branding only in the DEV-Lab profile, which differs from rc4 in nothing else', () => {
    const rc4 = loadProfile(RC4);
    const devLab = loadProfile(DEV_LAB);
    expect(rc4.vite.VITE_TBI_ENV).toBeNull();
    expect(loadProfile(RC4_REPORTS).vite.VITE_TBI_ENV).toBeNull();
    expect(devLab.vite.VITE_TBI_ENV).toBe('dev');
    expect({
      ...devLab,
      release: rc4.release,
      vite: { ...devLab.vite, VITE_TBI_ENV: null },
    }).toEqual(rc4);
    const src = tree({ 'app/src/a.ts': reads(RC4_SETTINGS) });
    expect(validate({ ...rc4, vite: { ...rc4.vite, VITE_TBI_ENV: 'dev' } }, src, TOOLS)).toEqual([
      'VITE_TBI_ENV must be null outside a DEV-Lab profile (release rc4)',
    ]);
    expect(
      validate({ ...devLab, vite: { ...devLab.vite, VITE_TBI_ENV: null } }, src, TOOLS),
    ).toEqual(['VITE_TBI_ENV must be "dev" in a DEV-Lab profile']);
    const { VITE_TBI_ENV: _unpinned, ...vite } = rc4.vite;
    expect(validate({ ...rc4, vite }, src, TOOLS)).toContain(
      'VITE_TBI_ENV must be pinned (null, or "dev" for DEV-Lab)',
    );
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
    expect(validate(p, src, { ...TOOLS, node: 'v22.0.0' })).toEqual([
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

  it('a tracked .env file, or a tree whose tracked files cannot be listed, is refused (review)', () => {
    const src = tree({ 'app/src/a.ts': reads(RC4_SETTINGS) });
    const p = loadProfile(RC4);
    expect(validate(p, src, { ...TOOLS, trackedFiles: () => ['app/.env.production'] })).toEqual([
      'tracked env file app/.env.production would add build settings',
    ]);
    expect(validate(p, src, { ...TOOLS, trackedFiles: () => ['app/.env.example'] })).toEqual([]);
    // Not a git tree (or git missing / refusing it): fails closed instead of assuming "no files".
    const errors = validate(p, src, GIT);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^cannot list the tracked files of /);
  });

  it('the build environment is the profile and the identity only; null settings are absent', () => {
    const env = buildEnvironment(loadProfile(RC4), {
      commit: 'a'.repeat(40),
      time: '2026-10-18T12:00:00Z',
      path: '/usr/bin',
      home: '/home/x',
      npmrcDir: '/out/p.npmrc',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      NPM_CONFIG_USERCONFIG: '/out/p.npmrc/user.npmrc',
      NPM_CONFIG_GLOBALCONFIG: '/out/p.npmrc/global.npmrc',
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

/** A minimal branded entry HTML + manifest + icons (PNG headers only: checkBranding reads IHDR). */
function branding(dev, { sizes = {} } = {}) {
  const png = (wh) => {
    const b = Buffer.alloc(24);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(wh, 16);
    b.writeUInt32BE(wh, 20);
    return b;
  };
  const icon = (name, wh) => [`assets/${name}-0123abcd.png`, png(sizes[name] ?? wh)];
  const files = Object.fromEntries([
    icon('favicon-16', 16),
    icon('favicon-32', 32),
    icon('apple-touch-icon-180', 180),
    icon('icon-192', 192),
    icon('icon-512', 512),
    icon('maskable-192', 192),
    icon('maskable-512', 512),
  ]);
  const name = dev ? 'TBI Lab DEV' : 'TBI Lab';
  files['assets/manifest-0123abcd.webmanifest'] = JSON.stringify({
    name,
    short_name: name,
    icons: [192, 512].flatMap((n) =>
      ['icon', 'maskable'].map((k) => ({
        src: `/assets/${k}-${n}-0123abcd.png`,
        sizes: `${n}x${n}`,
        purpose: k === 'icon' ? 'any' : 'maskable',
      })),
    ),
  });
  files['index.html'] = `<html ${dev ? 'data-tbi-env="dev" ' : ''}lang="en"><head>
<title>${dev ? '[DEV] ' : ''}TBI Lab</title>
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16-0123abcd.png">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32-0123abcd.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon-180-0123abcd.png">
<link rel="manifest" href="/assets/manifest-0123abcd.webmanifest" crossorigin="use-credentials">
</head></html>`;
  return files;
}

describe('built frontend branding vs profile', () => {
  it('production profiles: icons, manifest and no DEV marker; DEV-Lab: every DEV marker', () => {
    expect(checkBranding(loadProfile(RC4), tree(branding(false)))).toEqual([]);
    expect(checkBranding(loadProfile(RC4_REPORTS), tree(branding(false)))).toEqual([]);
    expect(checkBranding(loadProfile(DEV_LAB), tree(branding(true)))).toEqual([]);
  });

  it('refuses DEV branding in a production package, and a DEV package without it', () => {
    expect(checkBranding(loadProfile(RC4), tree(branding(true)))).toEqual([
      'production branding expected, but the build has the [DEV] title',
      'production branding expected, but the build has data-tbi-env="dev"',
      'production branding expected, but the build has DEV in the manifest names',
    ]);
    expect(checkBranding(loadProfile(DEV_LAB), tree(branding(false)))).toEqual([
      'DEV profile, but the build lacks the [DEV] title',
      'DEV profile, but the build lacks data-tbi-env="dev"',
      'DEV profile, but the build lacks DEV in the manifest names',
    ]);
  });

  it('refuses an icon whose pixels do not match its declared size, or a missing manifest icon', () => {
    expect(
      checkBranding(loadProfile(RC4), tree(branding(false, { sizes: { 'icon-512': 256 } }))),
    ).toEqual(['manifest any /assets/icon-512-0123abcd.png: declared 512x512, is 256x256']);
    const files = branding(false);
    delete files['assets/maskable-192-0123abcd.png'];
    expect(checkBranding(loadProfile(RC4), tree(files))).toEqual([
      'manifest maskable /assets/maskable-192-0123abcd.png: missing (or not a content-hashed asset)',
    ]);
  });
});

describe('built frontend vs profile', () => {
  const sw = (v) =>
    `function gt(e){return typeof e==\`string\`&&e.trim()===\`1\`}var _t=gt(${v}),x=\`/build\`,y=\`/runtime\`,z=\`/oauth2/sign_out\`;`;
  const dist = (js, sources = ['../../src/main.tsx']) =>
    tree({
      ...branding(false),
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

  it('refuses a source map carrying a bundler asset placeholder (G2, nondeterministic order)', () => {
    const d = tree({
      ...branding(false),
      'assets/index-x.js': sw('`0`'),
      'assets/index-x.js.map': JSON.stringify({
        version: 3,
        sources: ['../../src/assets/brand/logo.png'],
        sourcesContent: ['export default import.meta.ROLLDOWN_FILE_URL_WPGYjwIlzWVNM1bYhOc83w'],
        mappings: '',
      }),
    });
    expect(checkDist(loadProfile(RC4), d).errors).toEqual([
      'index-x.js.map: carries a bundler asset placeholder (nondeterministic)',
    ]);
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
