/**
 * The policy of a DEPLOYED instance, for the deployed acceptance tests (docs/ops/POLICY-BETA.md):
 * - which repository file it was installed with (install.sh TBI_S8_POLICY; default policy.json);
 * - the exact installed bytes, saved before a test changes them. Restoring installs those bytes and
 *   nothing else (never a repository file), and does nothing if the test changed nothing;
 * - what a test that needs Advanced prebuilt uploads may do under the installed default plan.
 * Changing the policy goes through the service-mutation gate (mutation-gate.ts). Pure logic and the
 * save / restore order are unit-tested in runtime/policy/tests/s8-installed-policy.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePolicy, type PolicyConfig } from '../policy/policy.js';
import { mutationAllowed } from './mutation-gate.js';

const DEFAULT_FILE = fileURLToPath(new URL('../../deploy/dev-lab/s8/policy.json', import.meta.url));

/** The repository policy the instance was installed with; empty counts as unset, as in install.sh. */
export const repoPolicyFile = (env: NodeJS.ProcessEnv = process.env): string =>
  env.TBI_S8_POLICY ? resolve(env.TBI_S8_POLICY) : DEFAULT_FILE;

const parse = (bytes: Buffer): PolicyConfig =>
  validatePolicy(JSON.parse(bytes.toString('utf8')) as unknown);

/**
 * `installed`: the default plan allows prebuilt uploads, the test runs as written.
 * `temporary`: it does not, and this run may change the instance (mutation gate).
 * `refused`: it does not, and nothing may be changed: only the refusal can be tested.
 */
export type PrebuiltMode = 'installed' | 'temporary' | 'refused';

export function prebuiltMode(installed: Buffer, mayMutate: boolean): PrebuiltMode {
  const p = parse(installed);
  if (p.plans[p.defaultPlan]!.capabilities.allowPrebuiltBinary) return 'installed';
  return mayMutate ? 'temporary' : 'refused';
}

/** The skip reason a dependent case reports (`context.skip`) in mode `refused`. */
export const skipNote = (mode: PrebuiltMode): string =>
  mode === 'refused'
    ? 'NOT TESTED: the installed default plan refuses prebuilt uploads; a temporary policy needs the mutation gate'
    : '';

/**
 * The installed policy with ONE change: unassigned principals (the fresh test users) get the
 * installed `preview` plan. Plan names, limits, assignments and global limits are kept.
 */
export function previewDefaultPolicy(installed: Buffer): Buffer {
  const p = parse(installed);
  if (!p.plans.preview?.capabilities.allowPrebuiltBinary)
    throw new Error('the installed policy has no preview plan that allows prebuilt uploads');
  return Buffer.from(JSON.stringify({ ...p, defaultPlan: 'preview' }));
}

/**
 * `policy` plus every plan name of the installed policy that it lacks (a copy of its default plan):
 * a metered Session Host refuses to start if TBI_HOST_SIM_PLAN_MAP names a plan the policy lacks.
 */
export function withInstalledPlanNames(policy: PolicyConfig, installed: Buffer): PolicyConfig {
  const c = structuredClone(policy);
  for (const name of Object.keys(parse(installed).plans))
    c.plans[name] ??= structuredClone(c.plans[c.defaultPlan]!);
  return c;
}

export interface Deps {
  /** `sudo -n <args>`. */
  sudo: (args: string[]) => { status: number | null; stdout: Buffer; stderr: Buffer };
  mayMutate: (instance: string) => boolean;
}

const REAL: Deps = {
  sudo: (args) => spawnSync('sudo', ['-n', ...args]),
  mayMutate: (instance) => mutationAllowed(instance),
};

export class InstalledPolicy {
  private changed = false;
  private dir: string | null = null;

  private constructor(
    readonly instance: string,
    /** The installed file as it was before this test, byte for byte. */
    readonly bytes: Buffer,
    private readonly deps: Deps,
  ) {}

  /** Saves the installed policy. Throws, before anything is changed, if it cannot be read. */
  static capture(instance: string, deps: Deps = REAL): InstalledPolicy {
    const bytes = InstalledPolicy.read(instance, deps);
    try {
      parse(bytes);
    } catch (e) {
      throw new Error(
        `the installed policy of ${instance} is not a valid policy (nothing was changed): ${(e as Error).message}`,
        { cause: e },
      );
    }
    return new InstalledPolicy(instance, bytes, deps);
  }

  private static read(instance: string, deps: Deps): Buffer {
    const r = deps.sudo(['cat', `/etc/${instance}/policy.json`]);
    if (r.status !== 0 || r.stdout.length === 0)
      throw new Error(
        `cannot read /etc/${instance}/policy.json (exit ${r.status}): ${String(r.stderr).trim()}`,
      );
    return r.stdout;
  }

  private run(args: string[]) {
    const r = this.deps.sudo(args);
    if (r.status !== 0)
      throw new Error(`sudo ${args.join(' ')} (exit ${r.status}): ${String(r.stderr).trim()}`);
  }

  private write(name: string, policy: Buffer | string) {
    this.dir ??= mkdtempSync(join(tmpdir(), 'tbi-policy-'));
    const file = join(this.dir, name);
    writeFileSync(file, policy, { mode: 0o600 });
    this.run(['install', '-m', '0400', file, `/etc/${this.instance}/policy.json`]);
  }

  private restart(units: string[]) {
    this.run(['systemctl', 'restart', ...units.map((u) => `${u}.service`)]);
  }

  /** Installs a temporary policy and restarts `units`. Refused without the mutation gate. */
  install(policy: Buffer | string, units: string[]): void {
    if (!this.deps.mayMutate(this.instance))
      throw new Error(`policy change on ${this.instance} refused: mutation gate`);
    if (!this.changed) {
      this.dir ??= mkdtempSync(join(tmpdir(), 'tbi-policy-'));
      const backup = join(this.dir, 'policy.before.json');
      writeFileSync(backup, this.bytes, { mode: 0o600 });
      console.log(`installed policy of ${this.instance} saved to ${backup}`);
      this.changed = true; // before the first change: a half-done one is restored too
    }
    this.write('policy.temporary.json', policy);
    this.restart(units);
  }

  /**
   * Puts the saved bytes back (checked by reading them again) and restarts `units`; false, doing
   * nothing, if this object changed nothing. Not gated again: it only undoes a gated change.
   */
  restore(units: string[]): boolean {
    if (!this.changed) return false;
    this.write('policy.before.json', this.bytes);
    if (!InstalledPolicy.read(this.instance, this.deps).equals(this.bytes))
      throw new Error(
        `policy of ${this.instance} NOT restored: restore it from ${this.dir}/policy.before.json`,
      );
    this.restart(units);
    this.changed = false;
    rmSync(this.dir!, { recursive: true, force: true });
    this.dir = null;
    return true;
  }
}
