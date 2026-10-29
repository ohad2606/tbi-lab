#!/usr/bin/env node
/**
 * RC4 release configuration (packaging gate G3): every setting that changes a release build is
 * pinned in a profile (deploy/release/*.release.json), checked against the source being built,
 * and handed to the build as its ENTIRE environment, so nothing comes from the machine.
 *
 *   release-config.mjs check  <profile> <srcdir>                  validate; print the effective config
 *   release-config.mjs env    <profile> <srcdir> <commit> <time> <npmrc-dir>
 *                                         validate; print the build environment (one KEY=VALUE per
 *                                         line, for env -i); <npmrc-dir> holds the empty npmrc files
 *
 * Rules (each one fails the build, none is a warning):
 * - The profile pins EXACTLY the VITE_* settings the app source reads: an unpinned setting (one a
 *   new feature adds) or a pinned one the source no longer reads is an error.
 * - A setting is a string (passed) or null (guaranteed unset: the app's own default applies, and
 *   for the optional features that default is "off").
 * - Excluded features (Active Minutes for RC4) must be absent from the source, not merely off.
 * - Report a Problem: VITE_PROBLEM_REPORTS is "0" or "1", and the host switch (TBI_REPORTS_DIR)
 *   is null exactly when the app switch is "0".
 * - Sprint 23C administration: when the source reads VITE_ADMIN_UI, it is "off", "reports" or "full"
 *   and equals the host's TBI_ADMIN_MODE; every admin host switch is pinned (a value or null).
 *   `reports` (feedback only): an owner principal file, reports on, and no access view or admin
 *   directory. `full`: the access view and the admin directory, no owner file, and the dedicated
 *   admin service pinned in the profile's `admin` section (Sprint 23C, on the same helper files).
 * - The external feedback form stays off (Sprint 13 H7: no build sets it without owner approval).
 * - Node and npm are the pinned versions; no tracked .env file can add settings behind the
 *   profile's back.
 * Values are configuration, not secrets; the effective configuration is recorded with the package.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const PROFILE_KEYS = ['release', 'node', 'npm', 'build', 'vite', 'host', 'excluded'];
/** Sprint 23C: the dedicated admin service's settings, with the full administration only. */
const OPTIONAL_KEYS = ['admin'];
const ADMIN_SERVICE_KEYS = [
  'TBI_ADMIN_LISTEN',
  'TBI_ACCESS_VIEW',
  'TBI_ADMIN_DIR',
  'TBI_RUNTIME_HEALTH',
];
const SCAN_ROOTS = [
  'app/src',
  'app/index.html',
  'app/vite.config.ts',
  'app/buildInfo.config.ts',
  'packages',
];
/** Host switches a profile may pin; TBI_REPORTS_DIR first (always pinned). */
const HOST_KEYS = [
  'TBI_REPORTS_DIR',
  'TBI_ACCESS_VIEW',
  'TBI_ADMIN_DIR',
  'TBI_ADMIN_MODE',
  'TBI_OWNER_PRINCIPAL_FILE',
  'TBI_OBSERVATIONS_DIR',
];
const ADMIN_MODES = ['off', 'reports', 'full'];
const SCAN_EXT = /\.(ts|tsx|mts|js|mjs|html)$/;
const VITE_NAME = /\bVITE_[A-Z0-9_]+\b/g;
const HEX40 = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** A value is passed through `env -i` and recorded: printable, no newline, no '='-free surprises. */
const SAFE_VALUE = /^[\x20-\x7e]{0,256}$/;

class ConfigError extends Error {}

export function loadProfile(path) {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  const keys = Object.keys(p)
    .filter((k) => !OPTIONAL_KEYS.includes(k))
    .sort();
  if (keys.join() !== [...PROFILE_KEYS].sort().join())
    throw new ConfigError(
      `profile keys must be exactly ${PROFILE_KEYS.join(', ')} (and optionally ${OPTIONAL_KEYS.join(', ')}); got ${Object.keys(p).sort().join(', ')}`,
    );
  return p;
}

/** Every file under the scanned roots, skipping dependencies and build output. */
function sourceFiles(srcdir) {
  const out = [];
  const walk = (abs) => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort())
        if (name !== 'node_modules' && name !== 'dist' && !name.startsWith('.'))
          walk(join(abs, name));
    } else if (SCAN_EXT.test(abs)) out.push(abs);
  };
  for (const r of SCAN_ROOTS) if (existsSync(join(srcdir, r))) walk(join(srcdir, r));
  return out;
}

/** The VITE_* settings the app source reads, with the files that read each. */
export function sourceViteSettings(srcdir) {
  const found = new Map();
  for (const f of sourceFiles(srcdir))
    for (const m of readFileSync(f, 'utf8').matchAll(VITE_NAME)) {
      const files = found.get(m[0]) ?? new Set();
      files.add(relative(srcdir, f));
      found.set(m[0], files);
    }
  return found;
}

/** All problems with `profile` for the tree at `srcdir` (empty: valid). */
export function validate(profile, srcdir, tools = currentTools()) {
  const errors = [];
  const err = (m) => errors.push(m);

  // `rc4`, or a named variant such as `rc4-s23` (within alertd v4's RELEASE pattern).
  if (!/^rc\d+(-[a-z0-9]+)*$/.test(profile.release) || profile.release.length > 64)
    err(`release: bad name ${profile.release}`);
  if (tools.node !== profile.node) err(`node: pinned ${profile.node}, running ${tools.node}`);
  if (tools.npm !== profile.npm) err(`npm: pinned ${profile.npm}, running ${tools.npm}`);

  const b = profile.build ?? {};
  if (Object.keys(b).sort().join() !== 'TBI_BUILD_ENV,TZ')
    err('build: must pin exactly TBI_BUILD_ENV and TZ (commit and time are arguments)');
  if (b.TBI_BUILD_ENV !== 'dev-lab')
    err(`build.TBI_BUILD_ENV: the deployed build verifier expects dev-lab, not ${b.TBI_BUILD_ENV}`);
  if (b.TZ !== 'UTC') err('build.TZ must be UTC');

  // The pinned VITE settings are exactly those the source reads.
  const inSource = sourceViteSettings(srcdir);
  const pinned = profile.vite ?? {};
  const excluded = profile.excluded ?? { settings: [], paths: [] };
  for (const [name, files] of inSource)
    if (excluded.settings.includes(name))
      err(
        `excluded setting ${name} is read by the source (${[...files].join(', ')}): the feature must be absent`,
      );
    else if (!(name in pinned)) err(`unpinned setting ${name} (read by ${[...files].join(', ')})`);
  for (const name of Object.keys(pinned)) {
    if (!inSource.has(name)) err(`pinned setting ${name} is not read by the source`);
    const v = pinned[name];
    if (v !== null && (typeof v !== 'string' || !SAFE_VALUE.test(v)))
      err(`${name}: a value is a printable string or null`);
    if (v === '')
      err(`${name}: use null for "unset" (an empty string can override a code default)`);
  }
  for (const p of excluded.paths ?? [])
    if (existsSync(join(srcdir, p))) err(`excluded path ${p} is present in the source`);

  // Report a Problem: both switches, explicit and consistent.
  const reports = pinned.VITE_PROBLEM_REPORTS;
  if (reports !== '0' && reports !== '1') err('VITE_PROBLEM_REPORTS must be pinned to "0" or "1"');
  const host = profile.host ?? {};
  // Sprint 23B/23C: the admin host switches are optional for a source without the admin UI (the
  // RC4 profiles name none of them); TBI_REPORTS_DIR is always pinned.
  const hostKeys = Object.keys(host);
  if (!hostKeys.includes('TBI_REPORTS_DIR') || hostKeys.some((k) => !HOST_KEYS.includes(k)))
    err(`host: must pin TBI_REPORTS_DIR, and optionally ${HOST_KEYS.slice(1).join(', ')} only`);
  if (reports === '0' && host.TBI_REPORTS_DIR !== null)
    err('host.TBI_REPORTS_DIR must be null when the app switch is off');
  if (
    reports === '1' &&
    !(typeof host.TBI_REPORTS_DIR === 'string' && host.TBI_REPORTS_DIR.startsWith('/'))
  )
    err('host.TBI_REPORTS_DIR must be an absolute path when the app switch is on');

  const abs = (v) => typeof v === 'string' && v.startsWith('/');
  for (const k of [
    'TBI_ACCESS_VIEW',
    'TBI_ADMIN_DIR',
    'TBI_OWNER_PRINCIPAL_FILE',
    'TBI_OBSERVATIONS_DIR',
  ])
    if (k in host && host[k] !== null && !abs(host[k]))
      err(`host.${k} must be null or an absolute path`);
  if (inSource.has('VITE_ADMIN_UI')) {
    // Sprint 23C: the app's and the host's admin modes are pinned, explicitly and together; every
    // admin host switch is pinned (a value or null), and only the combinations below exist.
    const ui = pinned.VITE_ADMIN_UI;
    const mode = host.TBI_ADMIN_MODE;
    if (!ADMIN_MODES.includes(ui))
      err('VITE_ADMIN_UI must be pinned to "off", "reports" or "full"');
    for (const k of HOST_KEYS)
      if (!(k in host)) err(`host.${k} must be pinned (a value or null) with the admin switch`);
    if ('TBI_ADMIN_MODE' in host && !ADMIN_MODES.includes(mode))
      err('host.TBI_ADMIN_MODE must be "off", "reports" or "full"');
    if (ADMIN_MODES.includes(ui) && ADMIN_MODES.includes(mode) && ui !== mode)
      err(`VITE_ADMIN_UI ${ui} needs host.TBI_ADMIN_MODE ${ui}, not ${mode}`);
    if (mode === 'off' || mode === 'reports')
      for (const k of ['TBI_ADMIN_DIR'])
        if (host[k] !== null) err(`host.${k} must be null when host.TBI_ADMIN_MODE is ${mode}`);
    if (
      mode !== 'reports' &&
      'TBI_OWNER_PRINCIPAL_FILE' in host &&
      host.TBI_OWNER_PRINCIPAL_FILE !== null
    )
      err('host.TBI_OWNER_PRINCIPAL_FILE is for host.TBI_ADMIN_MODE reports only');
    if (mode === 'reports') {
      if (host.TBI_ACCESS_VIEW !== null)
        err('host.TBI_ACCESS_VIEW must be null when host.TBI_ADMIN_MODE is reports (no helper)');
      if (!abs(host.TBI_OWNER_PRINCIPAL_FILE))
        err(
          'host.TBI_OWNER_PRINCIPAL_FILE must be an absolute path when host.TBI_ADMIN_MODE is reports',
        );
      if (reports !== '1') err('host.TBI_ADMIN_MODE reports needs VITE_PROBLEM_REPORTS "1"');
    }
    // Sprint 23C: the full host reads the access view and writes observations only; the helper's
    // base directory (spool, results) is the admin service's, never the host's.
    if (mode !== 'full' && 'TBI_OBSERVATIONS_DIR' in host && host.TBI_OBSERVATIONS_DIR !== null)
      err('host.TBI_OBSERVATIONS_DIR is for host.TBI_ADMIN_MODE full only');
    if (mode === 'full') {
      if (!(abs(host.TBI_ACCESS_VIEW) && abs(host.TBI_OBSERVATIONS_DIR)))
        err('host.TBI_ADMIN_MODE full needs host.TBI_ACCESS_VIEW and host.TBI_OBSERVATIONS_DIR');
      if (host.TBI_ADMIN_DIR !== null)
        err('host.TBI_ADMIN_DIR must be null: the spool and results are the admin service’s');
    }
    // Sprint 23C (D1): the account administration is the dedicated admin service's, so the full
    // mode needs it, pinned, on the same helper files; no other mode has it.
    const svc = profile.admin;
    if (mode === 'full') {
      if (svc === null || typeof svc !== 'object' || Array.isArray(svc))
        err('admin: the admin service must be pinned when host.TBI_ADMIN_MODE is full');
      else {
        if (Object.keys(svc).sort().join() !== [...ADMIN_SERVICE_KEYS].sort().join())
          err(`admin: must pin exactly ${ADMIN_SERVICE_KEYS.join(', ')}`);
        const unixAbs = (v) => typeof v === 'string' && /^unix:\/[\x21-\x7e]+$/.test(v);
        if (!unixAbs(svc.TBI_ADMIN_LISTEN))
          err('admin.TBI_ADMIN_LISTEN must be a unix socket (unix:/...)');
        if (!unixAbs(svc.TBI_RUNTIME_HEALTH))
          err('admin.TBI_RUNTIME_HEALTH must be the Session Host health socket (unix:/...)');
        if (svc.TBI_ACCESS_VIEW !== host.TBI_ACCESS_VIEW)
          err('admin.TBI_ACCESS_VIEW must equal host.TBI_ACCESS_VIEW');
        if (!abs(svc.TBI_ADMIN_DIR)) err('admin.TBI_ADMIN_DIR must be an absolute path');
        else if (host.TBI_OBSERVATIONS_DIR !== `${svc.TBI_ADMIN_DIR}/observations`)
          err('host.TBI_OBSERVATIONS_DIR must be admin.TBI_ADMIN_DIR/observations');
      }
    } else if ('admin' in profile && svc !== null)
      err('admin: the admin service is for host.TBI_ADMIN_MODE full only');
  }

  if ('VITE_FEEDBACK_URL' in pinned && pinned.VITE_FEEDBACK_URL !== null)
    err('VITE_FEEDBACK_URL must stay null (external form needs owner approval, Sprint 13 H7)');

  // No tracked env file can add settings outside the profile.
  // No tracked env file can add settings outside the profile; not knowing the files is an error.
  let tracked;
  try {
    tracked = (tools.trackedFiles ?? gitTrackedFiles)(srcdir);
  } catch (e) {
    err(`cannot list the tracked files of ${srcdir}: ${e.message.split('\n')[0]}`);
    tracked = [];
  }
  for (const f of tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.example')))
    err(`tracked env file ${f} would add build settings`);

  return errors;
}

/** The files git tracks in `srcdir`; throws when git cannot say (the check then fails closed). */
function gitTrackedFiles(srcdir) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: srcdir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\0').filter(Boolean);
}

export function currentTools() {
  const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  return { node: process.version, npm };
}

/** The complete environment of the frontend build: profile + identity, nothing inherited. */
export function buildEnvironment(profile, { commit, time, path, home, npmrcDir }) {
  if (!HEX40.test(commit)) throw new ConfigError(`commit must be 40 hex, not ${commit}`);
  if (!ISO_UTC.test(time))
    throw new ConfigError(`build time must be YYYY-MM-DDTHH:MM:SSZ, not ${time}`);
  if (typeof npmrcDir !== 'string' || !npmrcDir.startsWith('/'))
    throw new ConfigError('the npmrc directory must be an absolute path');
  const env = {
    PATH: path,
    HOME: home,
    // npm reads no user or global configuration: only the lockfile and the project decide. Two
    // distinct empty files (npm refuses one file, e.g. /dev/null, loaded as both).
    NPM_CONFIG_USERCONFIG: `${npmrcDir}/user.npmrc`,
    NPM_CONFIG_GLOBALCONFIG: `${npmrcDir}/global.npmrc`,
    LC_ALL: 'C',
    TZ: profile.build.TZ,
    TBI_BUILD_COMMIT: commit,
    TBI_BUILD_ENV: profile.build.TBI_BUILD_ENV,
    TBI_BUILD_TIME: time,
  };
  for (const [k, v] of Object.entries(profile.vite)) if (v !== null) env[k] = v;
  return env;
}

/** What the package records: every setting, set or explicitly unset. No secrets exist in it. */
export function effectiveConfig(profile, srcdir) {
  return {
    release: profile.release,
    node: profile.node,
    npm: profile.npm,
    build: profile.build,
    vite: Object.fromEntries(
      Object.keys(profile.vite)
        .sort()
        .map((k) => [k, profile.vite[k] ?? '(unset)']),
    ),
    host: Object.fromEntries(Object.entries(profile.host).map(([k, v]) => [k, v ?? '(unset)'])),
    ...(profile.admin ? { admin: profile.admin } : {}),
    excluded: profile.excluded,
    sourceSettings: [...sourceViteSettings(srcdir).keys()].sort(),
  };
}

function main(argv) {
  const [cmd, profilePath, srcdir, commit, time, npmrcDir] = argv;
  if (!['check', 'env'].includes(cmd) || !profilePath || !srcdir) {
    console.error('usage: release-config.mjs check|env <profile> <srcdir> [<commit> <time>]');
    return 2;
  }
  const profile = loadProfile(profilePath);
  const errors = validate(profile, srcdir);
  if (errors.length) {
    for (const e of errors) console.error(`release-config: ${e}`);
    return 1;
  }
  if (cmd === 'check') {
    process.stdout.write(`${JSON.stringify(effectiveConfig(profile, srcdir), null, 2)}\n`);
    return 0;
  }
  const env = buildEnvironment(profile, {
    commit,
    time,
    path: process.env.PATH,
    home: process.env.HOME,
    npmrcDir,
  });
  for (const [k, v] of Object.entries(env)) process.stdout.write(`${k}=${v}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-config: ${e.message}`);
    process.exitCode = 1;
  }
}
