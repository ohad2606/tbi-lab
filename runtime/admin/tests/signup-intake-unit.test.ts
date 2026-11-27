/**
 * BETA-G1 runbook precondition 5 ("isolate the intake"): static checks of the DRAFT intake unit
 * deploy/signup/tbi-signup.service.in. The unit is not rendered by any installer and not installed;
 * these tests fill its documented placeholders with fixture values in memory (nothing is written,
 * nothing runs under systemd). Enforcement can only be proven on a host (runbook: negative check
 * inside the sandbox).
 *
 * Asserts: shared-user model (exactly the admin unit's User=/Group=, no extra groups, UMask 0077);
 * only its own two secrets through LoadCredential, their source directory masked; the fail-closed
 * and optional InaccessiblePaths lists; ReadWritePaths exactly the store (+ optional funnel dir) and
 * containment against every masked path in both directions; own PID namespace with a fail-closed
 * ExecStart guard (executed here: it refuses outside a PID namespace); the hardening, system call
 * and network settings; off by default (the intake's own parser says so); no installer mentions it.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { intakeConfigFromEnv } from '../signup/intake-server.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const UNIT_FILE = join(ROOT, 'deploy', 'signup', 'tbi-signup.service.in');
const ADMIN_FILE = join(ROOT, 'deploy', 'dev-lab', 's8', 'tbi-admin.service.in');
const TEMPLATE = readFileSync(UNIT_FILE, 'utf8');

/** The documented placeholders (header of the unit) and the fixture values used here. */
const FIXTURE: Record<string, string> = {
  N: 'tbi',
  NODE: '/opt/fixture/node',
  BUNDLES: '/srv/tbi-lab/services/current',
  STORE: '/var/lib/tbi-lab/artifacts',
  SOURCE_HEADER: 'x-tbi-client-ip',
  TELEGRAM_CHAT_ID: '123456789',
  ADMIN_LINK: 'https://admin.example.com/admin/',
  TELEGRAM_EGRESS_ALLOW: '203.0.113.0/24',
};
const STORE_DIR = '/var/lib/tbi-signup';
const FUNNEL_DIR = '/var/lib/tbi-signup-funnel';
/** systemd's %d for a unit named tbi-signup.service. */
const OWN_CRED_DIR = '/run/credentials/tbi-signup.service';

const FAIL_CLOSED_MASKS = [
  '/var/lib/tbi-admin-auto',
  '/run/tbi-admin',
  '/run/credentials/tbi-admin.service',
  '/var/lib/tbi-mail',
  '/etc/tbi-signup',
  '/etc/tbi',
  '/var/lib/tbi-admin',
  '/var/log/tbi-admin',
];
const OPTIONAL_MASKS = [
  '/var/lib/tbi-lab/artifacts',
  '/var/lib/tbi-runtime',
  '/var/lib/tbi-build',
  '/var/lib/private',
  '/run/tbi-runtime',
  '/run/user',
  '/run/credentials/tbi-mailer.service',
];

const render = (t: string): string =>
  t.replace(/@([A-Z_]+)@/g, (m, k: string) => {
    const v = FIXTURE[k];
    if (v === undefined) throw new Error(`undocumented placeholder ${m}`);
    return v;
  });

/** Active (uncommented) directives per section, in order. */
function directives(unit: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
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
    if (!kv?.[1]) throw new Error(`unparsed line: ${line}`);
    out.push([section, kv[1], kv[2] ?? '']);
  }
  return out;
}

const UNIT = render(TEMPLATE);
const D = directives(UNIT);
const all = (key: string, section = 'Service'): string[] =>
  D.filter(([s, k]) => s === section && k === key).map(([, , v]) => v);
const words = (key: string, section = 'Service'): string[] =>
  all(key, section).flatMap((v) => v.split(/\s+/).filter(Boolean));
const within = (p: string, base: string): boolean => p === base || p.startsWith(`${base}/`);

/** Environment= of the unit, %d expanded as systemd does for this unit. */
function unitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const v of all('Environment')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(v);
    if (!m?.[1]) throw new Error(`bad Environment= ${v}`);
    env[m[1]] = (m[2] ?? '').replace(/%d/g, OWN_CRED_DIR);
  }
  return env;
}

function adminDirectives(): Array<[string, string, string]> {
  return directives(readFileSync(ADMIN_FILE, 'utf8'));
}

describe('BETA-G1 precondition 5: draft intake unit deploy/signup/tbi-signup.service.in', () => {
  it('is marked as a draft that is not rendered, not installed and never run', () => {
    const head = TEMPLATE.split('\n')[0] ?? '';
    expect(head).toMatch(/DRAFT unit, NOT rendered by any installer, NOT installed/);
    expect(TEMPLATE).toMatch(/never run on a host/);
  });

  it('no installer or deploy script mentions it', () => {
    const scripts: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(sh|mjs|js|ts|py)$/.test(e.name) || e.name === 'Makefile') scripts.push(p);
      }
    };
    walk(join(ROOT, 'deploy'));
    expect(scripts.some((p) => p.endsWith(join('s8', 'install.sh')))).toBe(true);
    for (const p of scripts) expect(readFileSync(p, 'utf8'), p).not.toMatch(/tbi-signup\.service/);
  });

  it('uses only the placeholders documented in its header', () => {
    const active = TEMPLATE.split('\n').filter((l) => !/^\s*[#;]/.test(l));
    const used = new Set(active.join('\n').match(/@[A-Z_]+@/g) ?? []);
    expect([...used].sort()).toEqual(
      Object.keys(FIXTURE)
        .map((k) => `@${k}@`)
        .sort(),
    );
    const header = TEMPLATE.split('[Unit]')[0] ?? '';
    for (const k of Object.keys(FIXTURE)) expect(header, k).toContain(`@${k}@`);
    expect(UNIT).not.toMatch(/@[A-Z_]*@/);
  });

  it('shared-user model: exactly the admin unit User= and Group=, no extra groups, UMask 0077', () => {
    const admin = adminDirectives();
    const adminUser = admin.filter(([s, k]) => s === 'Service' && k === 'User').map((x) => x[2]);
    expect(adminUser).toEqual(['tbi-admin']);
    expect(all('User')).toEqual(adminUser);
    expect(all('Group')).toEqual(['tbi-adminio']);
    expect(all('Group')).toEqual(
      admin.filter(([s, k]) => s === 'Service' && k === 'Group').map((x) => x[2]),
    );
    expect(all('SupplementaryGroups')).toEqual([]);
    expect(all('DynamicUser')).toEqual([]);
    expect(all('UMask')).toEqual(['0077']);
  });

  it('loads only its own two secrets as credentials; their source dir is masked', () => {
    const creds = all('LoadCredential').map((v) => {
      const [name, src] = v.split(':');
      return { name: name ?? '', src: src ?? '' };
    });
    expect(creds.map((c) => c.name).sort()).toEqual(['intake-hmac.key', 'intake-telegram.token']);
    const env = unitEnv();
    expect(env.TBI_SIGNUP_HMAC_FILE).toBe(`${OWN_CRED_DIR}/intake-hmac.key`);
    expect(env.TBI_SIGNUP_TELEGRAM_TOKEN_FILE).toBe(`${OWN_CRED_DIR}/intake-telegram.token`);
    const failClosed = words('InaccessiblePaths').filter((p) => !p.startsWith('-'));
    for (const c of creds) {
      expect(c.src.startsWith('/'), c.src).toBe(true);
      expect(
        failClosed.some((m) => within(c.src, m)),
        c.src,
      ).toBe(true);
      // Never another service's key (mail, verify, identity).
      expect(c.src).not.toMatch(/resend|verify|identity/);
    }
    for (const k of [
      'LoadCredentialEncrypted',
      'SetCredential',
      'SetCredentialEncrypted',
      'ImportCredential',
      'EnvironmentFile',
    ])
      expect(all(k), k).toEqual([]);
    for (const k of Object.keys(env))
      expect(k).not.toMatch(/RESEND|VERIFY_KEY|IDENTITY|AUTO_STATE|ADMIN_DIR|ACCESS_VIEW/);
    // Its own %d stays reachable: /run/credentials is never masked as a whole.
    for (const p of words('InaccessiblePaths').map((x) => x.replace(/^-/, ''))) {
      expect(within(OWN_CRED_DIR, p), p).toBe(false);
      expect(p).not.toBe('/run/credentials');
    }
  });

  it('masks the admin, mail, key and helper paths fail closed, the rest optionally', () => {
    const w = words('InaccessiblePaths');
    expect(w.filter((p) => !p.startsWith('-'))).toEqual(FAIL_CLOSED_MASKS);
    expect(w.filter((p) => p.startsWith('-')).map((p) => p.slice(1))).toEqual(OPTIONAL_MASKS);
    expect(w.every((p) => !p.startsWith('+'))).toBe(true);
  });

  it('masks are start-time only: bound to the admin, started only after its socket exists', () => {
    // BindsTo= + After=: stopped whenever the admin stops or restarts (also unexpectedly), so its
    // recreated /run dirs are never visible unmasked; nothing restarts the intake (fail closed).
    expect(words('After', 'Unit')).toContain('tbi-admin.service');
    expect(all('BindsTo', 'Unit')).toEqual(['tbi-admin.service']);
    for (const k of ['Requires', 'PartOf', 'Upholds', 'Requisite'])
      expect(all(k, 'Unit'), k).toEqual([]);
    expect(TEMPLATE).toMatch(
      /NOTHING restarts this unit after the admin\n# auto-restarts: it stays down \(fail closed\)/,
    );
    expect(TEMPLATE).toMatch(/restart the intake after any change\n# that recreates a masked path/);
    // The admin unit is Type=simple (After= does not wait for its RuntimeDirectory/credentials) and
    // restarts through failed/inactive (RestartMode=direct would skip the BindsTo= stop).
    const admin = adminDirectives();
    const adminSvc = (k: string) =>
      admin.filter(([s, kk]) => s === 'Service' && kk === k).map((x) => x[2]);
    expect(adminSvc('Type')).toEqual([]);
    expect(adminSvc('RestartMode')).toEqual([]);
    expect(adminSvc('Restart')).toEqual(['on-failure']);
    const listen = adminSvc('Environment').find((v) => v.startsWith('TBI_ADMIN_LISTEN='));
    expect(listen).toBe('TBI_ADMIN_LISTEN=unix:/run/@N@-admin/api.sock');
    expect(all('AssertPathExists', 'Unit')).toEqual(['/run/tbi-admin/api.sock']);
    expect(within('/run/tbi-admin/api.sock', '/run/tbi-admin')).toBe(true);
  });

  it('only allow-listed (section, key) pairs; no empty assignment except the capability sets', () => {
    const ALLOWED = new Set([
      'Unit:Description',
      'Unit:After',
      'Unit:Wants',
      'Unit:BindsTo',
      'Unit:AssertPathExists',
      'Unit:StartLimitIntervalSec',
      'Unit:StartLimitBurst',
      'Unit:AssertVersion',
      'Service:Type',
      'Service:User',
      'Service:Group',
      'Service:UMask',
      'Service:Environment',
      'Service:LoadCredential',
      'Service:BindReadOnlyPaths',
      'Service:ExecStart',
      'Service:Restart',
      'Service:RestartSec',
      'Service:RestartPreventExitStatus',
      'Service:ProtectSystem',
      'Service:ProtectHome',
      'Service:PrivateTmp',
      'Service:ReadWritePaths',
      'Service:InaccessiblePaths',
      'Service:PrivatePIDs',
      'Service:ProtectProc',
      'Service:ProcSubset',
      'Service:PrivateDevices',
      'Service:DevicePolicy',
      'Service:PrivateIPC',
      'Service:KeyringMode',
      'Service:ProtectKernelTunables',
      'Service:ProtectKernelModules',
      'Service:ProtectKernelLogs',
      'Service:ProtectControlGroups',
      'Service:ProtectClock',
      'Service:ProtectHostname',
      'Service:LimitCORE',
      'Service:NoNewPrivileges',
      'Service:CapabilityBoundingSet',
      'Service:AmbientCapabilities',
      'Service:RestrictSUIDSGID',
      'Service:RestrictNamespaces',
      'Service:LockPersonality',
      'Service:RestrictRealtime',
      'Service:SystemCallFilter',
      'Service:SystemCallArchitectures',
      'Service:SystemCallErrorNumber',
      'Service:MemoryMax',
      'Service:TasksMax',
      'Service:RestrictAddressFamilies',
      'Service:IPAddressDeny',
      'Service:IPAddressAllow',
      'Service:SocketBindAllow',
      'Service:SocketBindDeny',
      'Install:WantedBy',
    ]);
    for (const [sec, key] of D) expect(ALLOWED.has(`${sec}:${key}`), `${sec}:${key}`).toBe(true);
    // An empty assignment resets the list (an empty InaccessiblePaths= would drop every mask).
    for (const [sec, key, v] of D)
      if (v.trim() === '')
        expect(['CapabilityBoundingSet', 'AmbientCapabilities'], `${sec}:${key}`).toContain(key);
    // The parser itself rejects what the allow-list must catch.
    for (const bad of [
      'ExecStartPre=+/bin/true',
      'OpenFile=/etc/shadow',
      'JoinsNamespaceOf=x.service',
    ])
      expect(directives(`[Service]\n${bad}\n`)[0]?.[1]).toMatch(
        /^(ExecStartPre|OpenFile|JoinsNamespaceOf)$/,
      );
  });

  it('writes only the store (+ optional own funnel dir); containment both ways against every mask', () => {
    expect(all('ProtectSystem')).toEqual(['strict']);
    expect(all('ProtectHome')).toEqual(['yes']);
    expect(all('PrivateTmp')).toEqual(['yes']);
    expect(words('ReadWritePaths')).toEqual([STORE_DIR, `-${FUNNEL_DIR}`]);
    expect(unitEnv().TBI_SIGNUP_DIR).toBe(STORE_DIR);
    expect(unitEnv().TBI_FUNNEL_COUNTERS).toBeUndefined();
    expect(unitEnv().TBI_FUNNEL_DIR).toBeUndefined();
    for (const k of [
      'BindPaths',
      'StateDirectory',
      'RuntimeDirectory',
      'LogsDirectory',
      'CacheDirectory',
      'ConfigurationDirectory',
      'TemporaryFileSystem',
      'ReadOnlyPaths',
      'ExecPaths',
    ])
      expect(all(k), k).toEqual([]);
    const writable = [STORE_DIR, FUNNEL_DIR, OWN_CRED_DIR];
    const binds = all('BindReadOnlyPaths').map((v) => v.split(':')[1] ?? '');
    expect(binds).toEqual(['/opt/tbi-node', '/opt/tbi-build']);
    for (const m of [...FAIL_CLOSED_MASKS, ...OPTIONAL_MASKS])
      for (const p of [...writable, ...binds]) {
        expect(within(p, m), `${p} in ${m}`).toBe(false);
        expect(within(m, p), `${m} in ${p}`).toBe(false);
      }
  });

  it('own PID namespace, proc hidden, and the fail-closed version / namespace guard', () => {
    expect(all('PrivatePIDs')).toEqual(['yes']);
    expect(all('ProtectProc')).toEqual(['invisible']);
    expect(all('ProcSubset')).toEqual(['pid']);
    expect(all('AssertVersion', 'Unit')).toEqual(['systemd >= 257']);
    expect(all('Type')).toEqual(['exec']);
    const exec = all('ExecStart');
    expect(exec).toEqual([
      `/bin/sh -c 'if [ "$$$$" != 1 ]; then echo "tbi-signup: refusing to start: pid_namespace_missing"; exit 78; fi; exec /opt/tbi-node/bin/node /opt/tbi-build/signup-intake.mjs'`,
    ]);
    const m = /^\/bin\/sh -c '([^']*)'$/.exec(exec[0] ?? '');
    expect(m).not.toBeNull();
    // systemd turns "$$" into "$": the shell sees "$$" (its own PID).
    const script = (m?.[1] ?? '').replace(/\$\$/g, '$');
    expect(script).toMatch(
      /^if \[ "\$\$" != 1 \]; then .*exit 78; fi; exec \/opt\/tbi-node\/bin\/node /,
    );
    expect(script).toMatch(/exec \/opt\/tbi-node\/bin\/node \/opt\/tbi-build\/signup-intake\.mjs$/);
    expect(all('RestartPreventExitStatus')).toEqual(['78']);
    // Run the guard for real here (not PID 1 of a namespace): it refuses before any exec.
    const probe = script.replace(/exec \/opt\/tbi-node\/bin\/node .*$/, 'echo REACHED_EXEC');
    const r = spawnSync('/bin/sh', ['-c', probe], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r.status).toBe(78);
    expect(r.stdout).toBe('tbi-signup: refusing to start: pid_namespace_missing\n');
    expect(r.stdout).not.toContain('REACHED_EXEC');
  });

  it('keeps privileges, kernel surface and IPC closed', () => {
    for (const k of [
      'NoNewPrivileges',
      'RestrictSUIDSGID',
      'RestrictNamespaces',
      'LockPersonality',
      'RestrictRealtime',
      'PrivateIPC',
      'PrivateDevices',
      'ProtectKernelTunables',
      'ProtectKernelModules',
      'ProtectKernelLogs',
      'ProtectControlGroups',
      'ProtectClock',
      'ProtectHostname',
    ])
      expect(all(k), k).toEqual(['yes']);
    expect(all('CapabilityBoundingSet')).toEqual(['']);
    expect(all('AmbientCapabilities')).toEqual(['']);
    expect(all('KeyringMode')).toEqual(['private']);
    expect(all('DevicePolicy')).toEqual(['closed']);
    expect(all('LimitCORE')).toEqual(['0']);
    expect(all('DeviceAllow')).toEqual([]);
  });

  it('filters system calls: @system-service minus the privileged, resource, debug and cross-process calls', () => {
    expect(all('SystemCallFilter')).toEqual([
      '@system-service',
      '~@privileged @resources @debug @mount @obsolete process_vm_readv process_vm_writev pidfd_getfd kcmp',
    ]);
    expect(all('SystemCallArchitectures')).toEqual(['native']);
    expect(all('SystemCallErrorNumber')).toEqual(['EPERM']);
  });

  it('does not set MemoryDenyWriteExecute, RemoveIPC or PrivateNetwork, and says why', () => {
    for (const k of ['MemoryDenyWriteExecute', 'RemoveIPC', 'PrivateNetwork'])
      expect(all(k), k).toEqual([]);
    expect(TEMPLATE).toMatch(/# MemoryDenyWriteExecute stays off: Node's JIT/);
    expect(TEMPLATE).toMatch(/# RemoveIPC stays off: .*admin service's too/);
    expect(TEMPLATE).toMatch(/# PrivateNetwork stays off:/);
  });

  it('network: IPv4/IPv6 only, loopback + DNS stub + provider egress, binds exactly its listen port', () => {
    expect(all('RestrictAddressFamilies')).toEqual(['AF_INET AF_INET6']);
    expect(all('IPAddressDeny')).toEqual(['any']);
    expect(words('IPAddressAllow')).toEqual([
      '127.0.0.1/32',
      '::1/128',
      '127.0.0.53/32',
      FIXTURE.TELEGRAM_EGRESS_ALLOW,
    ]);
    expect(TEMPLATE).toMatch(/^IPAddressAllow=.* @TELEGRAM_EGRESS_ALLOW@$/m);
    expect(all('SocketBindDeny')).toEqual(['any']);
    const bind = all('SocketBindAllow');
    expect(bind).toHaveLength(1);
    const bm = /^ipv4:tcp:(\d+)$/.exec(bind[0] ?? '');
    expect(bm).not.toBeNull();
    // The intake's own parser, as enabled by a drop-in: loopback, the same port.
    const cfg = intakeConfigFromEnv({ ...unitEnv(), TBI_SIGNUP_INTAKE: '1' });
    expect(cfg.enabled).toBe(true);
    if (!cfg.enabled) return;
    expect(cfg.config.host).toBe('127.0.0.1');
    expect(cfg.config.port).toBe(Number(bm?.[1]));
    expect(cfg.config.dir).toBe(STORE_DIR);
    expect(cfg.config.web ?? null).toBeNull();
    expect(cfg.config.verify).toBe(false);
  });

  it('is off by default; restart, start limit and resource limits are set', () => {
    const env = unitEnv();
    expect(env.TBI_SIGNUP_INTAKE).toBe('0');
    expect(intakeConfigFromEnv(env)).toEqual({
      enabled: false,
      reason: 'TBI_SIGNUP_INTAKE is not 1 (feature off)',
    });
    for (const k of ['TBI_SIGNUP_WEB', 'TBI_SIGNUP_VERIFY', 'TBI_SIGNUP_NOTIFY'])
      expect(env[k], k).toBeUndefined();
    expect(all('Restart')).toEqual(['on-failure']);
    expect(all('StartLimitIntervalSec', 'Unit')).toEqual(['600']);
    expect(all('StartLimitBurst', 'Unit')).toEqual(['5']);
    expect(all('MemoryMax')).toEqual(['128M']);
    const tasks = Number(all('TasksMax')[0]);
    expect(tasks).toBeGreaterThanOrEqual(16);
    expect(tasks).toBeLessThanOrEqual(64);
    expect(all('WantedBy', 'Install')).toEqual(['multi-user.target']);
  });

  it('every Environment key is a setting the intake reads', () => {
    const src = readFileSync(join(ROOT, 'runtime', 'admin', 'signup', 'intake-server.ts'), 'utf8');
    for (const k of Object.keys(unitEnv()))
      expect(src.includes(`env.${k}`) || src.includes(`need('${k}')`), k).toBe(true);
  });

  it('has only the three sections and no line the parser cannot read', () => {
    // directives() throws on any line it cannot parse.
    expect(new Set(D.map(([s]) => s))).toEqual(new Set(['Unit', 'Service', 'Install']));
  });
});
