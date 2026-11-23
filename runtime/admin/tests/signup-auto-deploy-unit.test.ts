/**
 * BETA-G1 slice 7: deploy wiring of auto-approve in the admin service unit
 * (deploy/dev-lab/s8/tbi-admin.service.in). The unit is rendered with the REAL `render_raw` function
 * of install.sh (extracted and run in bash, non-root, no sudo, nothing installed), in the only mode
 * that installs the admin service (TBI_S23_ADMIN=1).
 *
 * Asserts: installing the unit does not enable auto-approve; the control-state dir is a systemd
 * StateDirectory with mode 0700 owned by the unit's user; no writable path is added besides it; the
 * hardening stays; no other unit in the repo can write it; the chosen path's parents pass the
 * autoStateDirCheck ancestor rules on this host.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoApproveConfigFromEnv } from '../signup/autoApprove.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const S8 = join(ROOT, 'deploy', 'dev-lab', 's8');
const TEMPLATE = join(S8, 'tbi-admin.service.in');
const INSTALL = readFileSync(join(S8, 'install.sh'), 'utf8');
const STATE_DIR = '/var/lib/tbi-admin-auto';
/** The planned intake unit (SIGNUP-AUTOMATION-DESIGN §7 item 2); not in the repo yet. */
const INTAKE_UNIT = join(ROOT, 'deploy', 'signup', 'tbi-signup.service.in');

function renderRawFn(): string {
  const m = /^render_raw\(\) \{\n[\s\S]*?\n\}\n/m.exec(INSTALL);
  if (!m) throw new Error('render_raw() not found in install.sh');
  return m[0];
}

/** Renders the template exactly as install.sh does for the dev-lab instance (fixture values). */
function render(mode: { admin: 0 | 1; feedback?: 0 | 1 } = { admin: 1 }): string {
  const vars: Record<string, string> = {
    N: 'tbi',
    U: 'tbi-',
    G: 'tbi-gate',
    STORE: '/var/lib/tbi-lab/artifacts',
    BUNDLES: '/srv/tbi-lab/services/current',
    ARDUINO: '/opt/fixture/arduino',
    MICROPYTHON: '/opt/fixture/micropython',
    NODE: '/opt/fixture/node',
    RUNTIME: '/opt/fixture/runtime',
    SOCK_RUNTIME_GID: '901',
    SOCK_BUILD_GID: '902',
    ARTIFACTS_GID: '903',
    JOB_UID: '904',
    CAP_MB: '256',
    HOST_MAX: '4',
    SOCK_ADMIN_GID: '905',
    ASSIST_GID: '906',
    ASSIST_ALLOW_MOCK: '0',
    S23_ADMIN: String(mode.admin),
    S23_FEEDBACK: String(mode.feedback ?? 0),
  };
  const assign = Object.entries(vars)
    .map(([k, v]) => `${k}='${v}'`)
    .join('\n');
  return execFileSync(
    'bash',
    ['-c', `set -euo pipefail\n${assign}\n${renderRawFn()}render_raw "$1"`, 'render', TEMPLATE],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
  );
}

/** Active (uncommented) directives of the [Service] section, in order. */
function serviceDirectives(unit: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let section = '';
  for (const raw of unit.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1] ?? '';
      continue;
    }
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (kv?.[1] !== undefined && section === 'Service') out.push([kv[1], kv[2] ?? '']);
  }
  return out;
}

const all = (d: Array<[string, string]>, key: string): string[] =>
  d.filter(([k]) => k === key).map(([, v]) => v);
/** Space-separated path list values, with systemd's `-` (ignore missing) and `+` prefixes removed. */
const paths = (d: Array<[string, string]>, key: string): string[] =>
  all(d, key)
    .flatMap((v) => v.split(/\s+/))
    .filter(Boolean)
    .map((p) => p.replace(/^[-+]+/, ''));

function unitEnv(d: Array<[string, string]>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const v of all(d, 'Environment')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(v);
    if (m?.[1] !== undefined) env[m[1]] = m[2] ?? '';
  }
  return env;
}

const within = (p: string, base: string): boolean => p === base || p.startsWith(`${base}/`);

describe('BETA-G1 deploy: tbi-admin.service.in auto-approve wiring', () => {
  const unit = render();
  const d = serviceDirectives(unit);

  it('renders with no unrendered placeholder (install.sh would refuse it)', () => {
    expect(unit).not.toMatch(/@[A-Z_]*@/);
  });

  it('does NOT enable auto-approve by default (flag, cap and cut-off are not set)', () => {
    const env = unitEnv(d);
    expect(env.TBI_SIGNUP_AUTO_APPROVE).toBeUndefined();
    expect(env.TBI_SIGNUP_AUTO_DAILY_CAP).toBeUndefined();
    expect(env.TBI_SIGNUP_AUTO_SINCE).toBeUndefined();
    // The same parser the admin service uses: off, silently (no config error, no log line).
    expect(autoApproveConfigFromEnv(env)).toEqual({
      enabled: false,
      reason: 'TBI_SIGNUP_AUTO_APPROVE is not set (feature off)',
    });
    // No EnvironmentFile could switch it on behind the template's back.
    expect(all(d, 'EnvironmentFile')).toEqual([]);
  });

  it('install.sh modes never uncomment the auto-approve lines', () => {
    for (const mode of [{ admin: 0 as const }, { admin: 0 as const, feedback: 1 as const }]) {
      const env = unitEnv(serviceDirectives(render(mode)));
      expect(env.TBI_SIGNUP_AUTO_APPROVE).toBeUndefined();
      expect(env.TBI_SIGNUP_AUTO_DAILY_CAP).toBeUndefined();
    }
  });

  it('documents the enabling lines commented out, with the cap left to the owner (no value picked)', () => {
    const commented = unit.split('\n').filter((l) => /^#\s*Environment=TBI_SIGNUP_AUTO_/.test(l));
    expect(commented.some((l) => /TBI_SIGNUP_AUTO_APPROVE=1$/.test(l))).toBe(true);
    const cap = commented.find((l) => l.includes('TBI_SIGNUP_AUTO_DAILY_CAP='));
    expect(cap).toBeDefined();
    expect(cap).not.toMatch(/=\d+\s*$/);
    // Uncommenting the lines as they are still leaves auto-approve OFF (fail closed): the
    // placeholder is not a number, so the parser reports a config error.
    const env = unitEnv(d);
    for (const l of commented) {
      const m = /^#\s*Environment=([A-Z0-9_]+)=(.*)$/.exec(l);
      if (m?.[1] !== undefined) env[m[1]] = m[2] ?? '';
    }
    const cfg = autoApproveConfigFromEnv(env);
    expect(cfg.enabled).toBe(false);
    expect(cfg).toMatchObject({ error: true });
  });

  it('creates the control-state dir through systemd: one StateDirectory, mode 0700, owned by User=', () => {
    expect(all(d, 'StateDirectory')).toEqual(['tbi-admin-auto']);
    expect(all(d, 'StateDirectoryMode')).toEqual(['0700']);
    // StateDirectory is owned by User=/Group= (systemd.exec); a DynamicUser would move it under
    // /var/lib/private behind a symlink, which autoStateDirCheck refuses.
    expect(all(d, 'User')).toEqual(['tbi-admin']);
    expect(all(d, 'DynamicUser')).toEqual([]);
    expect(unitEnv(d).TBI_SIGNUP_AUTO_STATE_DIR).toBe(STATE_DIR);
    expect(isAbsolute(STATE_DIR) && normalize(STATE_DIR) === STATE_DIR).toBe(true);
    // With the owner's flag and cap set, the parser accepts the configured dir as it is.
    const cfg = autoApproveConfigFromEnv({
      ...unitEnv(d),
      TBI_SIGNUP_AUTO_APPROVE: '1',
      TBI_SIGNUP_AUTO_DAILY_CAP: '1',
    });
    expect(cfg).toMatchObject({ enabled: true, stateDir: STATE_DIR });
  });

  it('adds no writable path besides the state dir and keeps the hardening', () => {
    // Writable before this slice: the spool (ReadWritePaths) and the socket dir (RuntimeDirectory).
    expect(paths(d, 'ReadWritePaths')).toEqual(['/var/lib/tbi-admin/spool']);
    expect(all(d, 'RuntimeDirectory')).toEqual(['tbi-admin']);
    for (const k of [
      'BindPaths',
      'LogsDirectory',
      'CacheDirectory',
      'ConfigurationDirectory',
      'TemporaryFileSystem',
    ])
      expect(all(d, k)).toEqual([]);
    const expectYes = [
      'NoNewPrivileges',
      'PrivateTmp',
      'PrivateDevices',
      'PrivateIPC',
      'ProtectHome',
      'ProtectKernelTunables',
      'ProtectKernelModules',
      'ProtectKernelLogs',
      'ProtectControlGroups',
      'ProtectClock',
      'ProtectHostname',
      'RestrictNamespaces',
      'RestrictRealtime',
      'RestrictSUIDSGID',
      'LockPersonality',
      'PrivateNetwork',
    ];
    for (const k of expectYes) expect(all(d, k), k).toEqual(['yes']);
    expect(all(d, 'ProtectSystem')).toEqual(['strict']);
    expect(all(d, 'RestrictAddressFamilies')).toEqual(['AF_UNIX']);
    expect(all(d, 'IPAddressDeny')).toEqual(['any']);
    expect(all(d, 'CapabilityBoundingSet')).toEqual(['']);
    expect(all(d, 'AmbientCapabilities')).toEqual(['']);
    expect(all(d, 'UMask')).toEqual(['0007']);
  });

  it('keeps the state dir apart from the helper tree, the stores and every other path rule', () => {
    for (const base of [
      '/var/lib/tbi-admin',
      '/var/lib/tbi-signup',
      '/var/lib/tbi-lab/artifacts',
      '/var/lib/private',
    ]) {
      expect(within(STATE_DIR, base), base).toBe(false);
      expect(within(base, STATE_DIR), base).toBe(false);
    }
    for (const k of ['InaccessiblePaths', 'ReadOnlyPaths', 'ReadWritePaths', 'BindReadOnlyPaths'])
      for (const p of paths(d, k).map((x) => x.split(':')[0] ?? x)) {
        expect(within(STATE_DIR, p), `${k} ${p}`).toBe(false);
        expect(within(p, STATE_DIR), `${k} ${p}`).toBe(false);
      }
  });

  it('no other unit in the repo runs as the admin user or can write the state dir', () => {
    const units: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.service(\.in)?$/.test(e.name) && p !== TEMPLATE) units.push(p);
      }
    };
    walk(join(ROOT, 'deploy'));
    expect(units.length).toBeGreaterThan(5);
    for (const u of units) {
      const ud = serviceDirectives(readFileSync(u, 'utf8'));
      expect(all(ud, 'User'), u).not.toContain('tbi-admin');
      expect(all(ud, 'StateDirectory').join(' '), u).not.toContain('admin-auto');
      for (const k of ['ReadWritePaths', 'BindPaths'])
        for (const p of paths(ud, k).map((x) => x.split(':')[0] ?? x))
          expect(within(STATE_DIR, p) || within(p, STATE_DIR), `${u} ${k} ${p}`).toBe(false);
    }
  });

  // The intake unit is a later deploy slice; this skip is visible in the count until it lands.
  it.skipIf(!existsSync(INTAKE_UNIT))('the intake unit has the state dir inaccessible', () => {
    const ud = serviceDirectives(readFileSync(INTAKE_UNIT, 'utf8'));
    expect(all(ud, 'User')).not.toContain('tbi-admin');
    expect(paths(ud, 'InaccessiblePaths').some((p) => within(STATE_DIR, p))).toBe(true);
  });

  it("the state dir's parents pass the autoStateDirCheck ancestor rules on this host", () => {
    // Same rules as autoStateDirCheck: a real directory (no symlink), owned by root (the admin
    // uid does not own /var/lib), not group/world-writable unless sticky. systemd creates only
    // the last component; its parents are the host's.
    for (let p = dirname(STATE_DIR); ; p = dirname(p)) {
      const st = lstatSync(p);
      expect(st.isDirectory(), p).toBe(true);
      expect(st.uid, p).toBe(0);
      expect((st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0, p).toBe(true);
      expect(realpathSync(p), p).toBe(p);
      if (dirname(p) === p) break;
    }
  });
});
