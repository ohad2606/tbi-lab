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
const RC4_S23 = join(ROOT, 'deploy/release/rc4-s23.release.json');
const RC4_S23_FEEDBACK = join(ROOT, 'deploy/release/rc4-s23-feedback.release.json');
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
  it('the rc4-s23-feedback profile pins exactly the settings this source reads, Active Minutes absent', () => {
    const p = loadProfile(RC4_S23_FEEDBACK);
    const settings = Object.keys(p.vite);
    expect([...sourceViteSettings(ROOT).keys()].sort()).toEqual([...settings].sort());
    expect(settings).toHaveLength(9);
    expect(validate(p, ROOT, GIT)).toEqual([]);
    expect(p.release).toBe('rc4-s23-feedback');
    expect(p.release).toMatch(/^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/);
    // Feedback on, the administration reduced to the reports, no helper anywhere.
    expect(p.vite.VITE_PROBLEM_REPORTS).toBe('1');
    expect(p.vite.VITE_ADMIN_UI).toBe('reports');
    expect(p.host).toEqual({
      TBI_REPORTS_DIR: '/var/lib/@N@-runtime/state/reports',
      TBI_ACCESS_VIEW: null,
      TBI_ADMIN_DIR: null,
      TBI_ADMIN_MODE: 'reports',
      TBI_OWNER_PRINCIPAL_FILE: '/etc/@N@-owner/owner.principal',
    });
  });

  it('release names: rcN or a named variant, nothing else', () => {
    const src = tree({ 'app/src/a.ts': reads(RC4_SETTINGS) });
    const p = loadProfile(RC4);
    for (const ok of ['rc4', 'rc4-s23', 'rc5-a-b'])
      expect(validate({ ...p, release: ok }, src, TOOLS)).toEqual([]);
    for (const bad of ['RC4', 'rc4_s23', 'rc4-', 'release', 'rc4-S23', `rc4-${'a'.repeat(70)}`])
      expect(validate({ ...p, release: bad }, src, TOOLS)).toEqual([`release: bad name ${bad}`]);
  });

  it('Sprint 23B/23C: the RC4 and rc4-s23 profiles are unchanged and fail closed on this source', () => {
    // rc4 and rc4-reports build the RC4 commit, rc4-s23 the s23b commit; on this tree each fails
    // closed on the admin switches it does not pin.
    expect(RC4_SETTINGS).toHaveLength(8);
    const pins = [
      'TBI_ACCESS_VIEW',
      'TBI_ADMIN_DIR',
      'TBI_ADMIN_MODE',
      'TBI_OWNER_PRINCIPAL_FILE',
    ].map((k) => `host.${k} must be pinned (a value or null) with the admin switch`);
    for (const p of [RC4, RC4_REPORTS])
      expect(validate(loadProfile(p), ROOT, GIT)).toEqual([
        'unpinned setting VITE_ADMIN_UI (read by app/src/deployment.ts)',
        'VITE_ADMIN_UI must be pinned to "off", "reports" or "full"',
        ...pins,
      ]);
    expect(validate(loadProfile(RC4_S23), ROOT, GIT)).toEqual([
      'VITE_ADMIN_UI must be pinned to "off", "reports" or "full"',
      ...pins.slice(2),
    ]);
  });

  it('Sprint 23C: the app and host admin modes are pinned together; inconsistent combinations are refused', () => {
    const src = tree({ 'app/src/a.ts': reads([...RC4_SETTINGS, 'VITE_ADMIN_UI']) });
    const p = loadProfile(RC4_S23_FEEDBACK);
    const v = (vite, host) =>
      validate({ ...p, vite: { ...p.vite, ...vite }, host: { ...p.host, ...host } }, src, TOOLS);
    expect(v({}, {})).toEqual([]);
    // Every value of the app switch is spelled out.
    for (const bad of [null, '1', '0', 'Reports', 'on'])
      expect(v({ VITE_ADMIN_UI: bad }, {})).toContain(
        'VITE_ADMIN_UI must be pinned to "off", "reports" or "full"',
      );
    // reports mode: never with the helper's directory or view; needs the owner file and reports.
    expect(v({}, { TBI_ADMIN_DIR: '/var/lib/tbi-admin' })).toContain(
      'host.TBI_ADMIN_DIR must be null when host.TBI_ADMIN_MODE is reports',
    );
    expect(v({}, { TBI_ACCESS_VIEW: '/var/lib/tbi-admin/view/access.json' })).toContain(
      'host.TBI_ACCESS_VIEW must be null when host.TBI_ADMIN_MODE is reports (no helper)',
    );
    expect(v({}, { TBI_OWNER_PRINCIPAL_FILE: null })).toContain(
      'host.TBI_OWNER_PRINCIPAL_FILE must be an absolute path when host.TBI_ADMIN_MODE is reports',
    );
    expect(v({}, { TBI_OWNER_PRINCIPAL_FILE: 'owner.principal' })).toContain(
      'host.TBI_OWNER_PRINCIPAL_FILE must be null or an absolute path',
    );
    expect(v({ VITE_PROBLEM_REPORTS: '0' }, { TBI_REPORTS_DIR: null })).toContain(
      'host.TBI_ADMIN_MODE reports needs VITE_PROBLEM_REPORTS "1"',
    );
    // The app's mode is the host's mode, both ways.
    expect(v({ VITE_ADMIN_UI: 'full' }, {})).toContain(
      'VITE_ADMIN_UI full needs host.TBI_ADMIN_MODE full, not reports',
    );
    expect(v({ VITE_ADMIN_UI: 'off' }, {})).toContain(
      'VITE_ADMIN_UI off needs host.TBI_ADMIN_MODE off, not reports',
    );
    expect(v({}, { TBI_ADMIN_MODE: 'full' })).toContain(
      'VITE_ADMIN_UI reports needs host.TBI_ADMIN_MODE reports, not full',
    );
    expect(v({}, { TBI_ADMIN_MODE: null })).toContain(
      'host.TBI_ADMIN_MODE must be "off", "reports" or "full"',
    );
    // Every admin host switch pinned (a value or null), none other.
    const { TBI_ACCESS_VIEW: _a, ...noView } = p.host;
    expect(validate({ ...p, host: noView }, src, TOOLS)).toContain(
      'host.TBI_ACCESS_VIEW must be pinned (a value or null) with the admin switch',
    );
    expect(v({}, { TBI_OTHER: '/x' })).toContain(
      'host: must pin TBI_REPORTS_DIR, and optionally TBI_ACCESS_VIEW, TBI_ADMIN_DIR, TBI_ADMIN_MODE, TBI_OWNER_PRINCIPAL_FILE only',
    );
    // off: nothing of the administration on the host.
    const off = { TBI_ADMIN_MODE: 'off', TBI_OWNER_PRINCIPAL_FILE: null };
    expect(v({ VITE_ADMIN_UI: 'off' }, off)).toEqual([]);
    expect(
      v({ VITE_ADMIN_UI: 'off' }, { ...off, TBI_ADMIN_DIR: '/a', TBI_ACCESS_VIEW: '/v' }),
    ).toContain('host.TBI_ADMIN_DIR must be null when host.TBI_ADMIN_MODE is off');
    expect(v({ VITE_ADMIN_UI: 'off' }, { TBI_ADMIN_MODE: 'off' })).toContain(
      'host.TBI_OWNER_PRINCIPAL_FILE is for host.TBI_ADMIN_MODE reports only',
    );
    // full: the access view and the admin directory, no owner file.
    const full = {
      TBI_ADMIN_MODE: 'full',
      TBI_OWNER_PRINCIPAL_FILE: null,
      TBI_ACCESS_VIEW: '/var/lib/tbi-admin/view/access.json',
      TBI_ADMIN_DIR: '/var/lib/tbi-admin',
    };
    expect(v({ VITE_ADMIN_UI: 'full' }, full)).toEqual([]);
    expect(v({ VITE_ADMIN_UI: 'full' }, { ...full, TBI_ADMIN_DIR: null })).toContain(
      'host.TBI_ADMIN_MODE full needs host.TBI_ACCESS_VIEW and host.TBI_ADMIN_DIR',
    );
    expect(v({ VITE_ADMIN_UI: 'full' }, { ...full, TBI_ACCESS_VIEW: null })).toContain(
      'host.TBI_ADMIN_DIR needs host.TBI_ACCESS_VIEW',
    );
    expect(v({ VITE_ADMIN_UI: 'full' }, { ...full, TBI_OWNER_PRINCIPAL_FILE: '/etc/x' })).toContain(
      'host.TBI_OWNER_PRINCIPAL_FILE is for host.TBI_ADMIN_MODE reports only',
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

  it('refuses a source map carrying a bundler asset placeholder (G2, nondeterministic order)', () => {
    const d = tree({
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

  it('Sprint 23C: the administration switch is located exactly once and must be the pinned value', () => {
    const admin = (v, name = 'Xt') =>
      `function ${name}(e){let t=typeof e==\`string\`?e.trim():\`\`;return t===\`full\`?\`full\`:t===\`reports\`?\`reports\`:\`off\`}var Zt=${name}(${v});`;
    const p = loadProfile(RC4_S23_FEEDBACK);
    expect(checkDist(p, dist(sw('`1`') + admin('`reports`'))).errors).toEqual([]);
    expect(checkDist(p, dist(sw('`1`') + admin('`full`'))).errors).toEqual([
      'administration switch compiled as `full`, profile pins `reports`',
    ]);
    expect(checkDist(p, dist(sw('`1`') + admin('void 0'))).errors).toEqual([
      'administration switch compiled as void 0, profile pins `reports`',
    ]);
    expect(checkDist(p, dist(sw('`1`'))).errors).toEqual([
      'administration switch: found 0 compiled switches, expected 1',
    ]);
    expect(
      checkDist(p, dist(sw('`1`') + admin('`reports`') + admin('`full`', 'Yt'))).errors,
    ).toEqual(['administration switch: found 2 compiled switches, expected 1']);
    // Neither switch is taken for the other.
    const only = checkDist(p, dist(admin('`reports`'))).errors;
    expect(only).toContain('Report a Problem switch: found 0 compiled switches, expected 1');
    expect(only.filter((e) => e.startsWith('administration'))).toEqual([]);
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
