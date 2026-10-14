/**
 * The admission limits of a DEPLOYED instance, resolved from the installed policy the way the
 * services resolve them: `cpus` is the CPU count the service process may use (its affinity, capped
 * by a cgroup CPU quota if one is set), so the deployed suites assert the host's real limits instead
 * of the 1-vCPU values of the DEV host.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });

interface Policy {
  defaultPlan: string;
  plans: Record<string, { runtime: { maxSessions: number }; build: { maxActive: number } }>;
  global: {
    build: { deferWhileLiveSessionsAtLeast: number | 'cpus' };
    runtime: { maxLiveSessions: number | 'cpus' };
  };
}

/** Number of CPUs in a list such as `0-5` or `0,2-3`. */
const countCpus = (list: string) =>
  list
    .trim()
    .split(',')
    .map((r) => r.split('-').map(Number))
    .reduce((n, [a, b]) => n + (b === undefined ? 1 : b - a! + 1), 0);

/** The CPUs available to the main process of `unit`. */
export function serviceCpus(unit: string): number {
  const pid = sudo('systemctl', 'show', '-p', 'MainPID', '--value', unit).stdout.trim();
  if (!pid || pid === '0') throw new Error(`${unit} is not running`);
  const list = /^Cpus_allowed_list:\s*(.+)$/m.exec(sudo('cat', `/proc/${pid}/status`).stdout)?.[1];
  if (!list) throw new Error(`no CPU affinity for ${unit}`);
  let cpus = countCpus(list);
  const max = sudo('cat', `/sys/fs/cgroup/system.slice/${unit}.service/cpu.max`).stdout.trim();
  const [quota, period] = max.split(' ');
  if (quota && quota !== 'max') cpus = Math.min(cpus, Math.ceil(Number(quota) / Number(period)));
  return cpus;
}

export function deployedLimits(instance: string, policyPath: string) {
  const p = JSON.parse(readFileSync(policyPath, 'utf8')) as Policy;
  const resolve = (v: number | 'cpus', unit: string) => (v === 'cpus' ? serviceCpus(unit) : v);
  const plan = p.plans[p.defaultPlan]!;
  return {
    /** Live sessions one user of the default plan may hold. */
    perUser: plan.runtime.maxSessions,
    /** Live sessions on the host (all users). */
    maxLive: resolve(p.global.runtime.maxLiveSessions, `${instance}-session-host`),
    /** Live sessions at which a queued build is held (nothing stopped). */
    deferAt: resolve(p.global.build.deferWhileLiveSessionsAtLeast, `${instance}-build`),
  };
}
