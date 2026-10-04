/**
 * Policy (Sprint 8, D-S8-8): named plans and global limits, kept OUT of application logic and out
 * of the data model. A plan is only a set of numbers and capabilities; principals map to plans;
 * changing a value never needs a data migration (stored data holds facts and timestamps only).
 *
 * Sprint 8 ships two plans: `preview` (every signed-in user of the private preview) and `system`
 * (operator principals named in the policy file). Commercial plans (Free/Basic/Pro) are later
 * work: they are new entries in `plans`, nothing else.
 *
 * Source: the JSON file named by TBI_POLICY_FILE (deploy/dev-lab/s8/policy.json), validated at
 * start; without it, the built-in defaults below (conservative, for a 1-vCPU preview host).
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { Principal } from '../identity/principal.js';

/** At most `count` events in any `windowMs`. */
export interface RateRule {
  count: number;
  windowMs: number;
}

export interface Plan {
  /** Every API request of a principal (cheap routes included): an anti-hammering backstop. */
  requests: RateRule;
  build: {
    /** Builds of this principal compiling at once. */
    maxActive: number;
    /** Builds of this principal waiting in the queue. */
    maxQueued: number;
    /** Compilations submitted (cache hits and lookups are not counted). */
    submissions: RateRule;
    /** Failed builds (compile errors, timeouts) before a cool-down… */
    failures: RateRule;
    /** …during which new submissions are refused. */
    cooldownMs: number;
  };
  runtime: {
    /** Live sessions of this principal. */
    maxSessions: number;
    /** Session creations. */
    creations: RateRule;
    /** Upper bound of one session's lifetime (the host's own limit may be lower). */
    maxLifetimeMs: number;
  };
  storage: {
    /** Artifacts this principal holds grants on (shared/system ones are not counted). */
    maxArtifacts: number;
    /** Bytes of those artifacts (a blob shared with others counts for each holder). */
    maxBytes: number;
    /** Unused private grants are dropped after this many days of inactivity. */
    retentionDays: number;
    /** Advanced prebuilt uploads. */
    prebuiltUploads: RateRule;
  };
  capabilities: {
    allowPrebuiltBinary: boolean;
  };
}

export interface GlobalPolicy {
  build: {
    /** Builds waiting in the shared queue (all principals). */
    maxQueued: number;
    /** A queued build that cannot start within this time fails as `capacity_timeout`. */
    maxQueueWaitMs: number;
    /**
     * Live sessions at which new builds stop STARTING (they wait in the queue; nothing running is
     * ever stopped): `cpus` = the number of CPUs, since a live session needs about one CPU and a
     * build beside it halves both (Sprint 8 Phase 0 measurement).
     */
    deferWhileLiveSessionsAtLeast: number | 'cpus';
  };
  runtime: {
    /** Live sessions on this host (all principals): `cpus` = one per CPU (real time). */
    maxLiveSessions: number | 'cpus';
  };
  resources: {
    /** Below this much free disk, new builds, uploads and sessions are refused. */
    minFreeDiskMb: number;
    /** Below this much available memory, new builds and sessions are refused. */
    minAvailableMemoryMb: number;
  };
  retention: {
    /** How often unused grants are swept. */
    sweepIntervalMs: number;
  };
}

export interface PolicyConfig {
  version: 1;
  defaultPlan: string;
  plans: Record<string, Plan>;
  /** principal → plan name (e.g. operator principals → `system`). */
  assignments: Record<string, string>;
  global: GlobalPolicy;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Built-in defaults: the `preview` and `system` plans and the global limits for this host. */
export const DEFAULT_POLICY: PolicyConfig = {
  version: 1,
  defaultPlan: 'preview',
  plans: {
    preview: {
      requests: { count: 600, windowMs: MIN },
      build: {
        maxActive: 1,
        maxQueued: 1,
        submissions: { count: 20, windowMs: 10 * MIN },
        failures: { count: 10, windowMs: 10 * MIN },
        cooldownMs: 5 * MIN,
      },
      runtime: {
        maxSessions: 1,
        creations: { count: 20, windowMs: 10 * MIN },
        maxLifetimeMs: 30 * MIN,
      },
      storage: {
        maxArtifacts: 32,
        maxBytes: 128 * 1024 * 1024,
        retentionDays: 30,
        prebuiltUploads: { count: 10, windowMs: 60 * MIN },
      },
      capabilities: { allowPrebuiltBinary: true },
    },
    system: {
      requests: { count: 6000, windowMs: MIN },
      build: {
        maxActive: 1,
        maxQueued: 3,
        submissions: { count: 200, windowMs: 10 * MIN },
        failures: { count: 100, windowMs: 10 * MIN },
        cooldownMs: MIN,
      },
      runtime: {
        maxSessions: 4,
        creations: { count: 200, windowMs: 10 * MIN },
        maxLifetimeMs: 30 * MIN,
      },
      storage: {
        maxArtifacts: 256,
        maxBytes: 1024 * 1024 * 1024,
        retentionDays: 365,
        prebuiltUploads: { count: 100, windowMs: 60 * MIN },
      },
      capabilities: { allowPrebuiltBinary: true },
    },
  },
  assignments: {},
  global: {
    build: { maxQueued: 3, maxQueueWaitMs: 10 * MIN, deferWhileLiveSessionsAtLeast: 'cpus' },
    runtime: { maxLiveSessions: 'cpus' },
    resources: { minFreeDiskMb: 1024, minAvailableMemoryMb: 256 },
    retention: { sweepIntervalMs: 60 * MIN },
  },
};

const isInt = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function checkRate(r: unknown, where: string): void {
  const o = r as RateRule;
  if (!o || !isInt(o.count, 0, 1_000_000) || !isInt(o.windowMs, 1000, 31 * DAY))
    throw new Error(`policy: bad rate rule ${where}`);
}

/** Throws with the first problem found: a policy that does not validate is never used. */
export function validatePolicy(p: unknown): PolicyConfig {
  const c = p as PolicyConfig;
  if (!c || c.version !== 1) throw new Error('policy: version must be 1');
  if (!c.plans || typeof c.plans !== 'object') throw new Error('policy: plans missing');
  if (!c.plans[c.defaultPlan]) throw new Error('policy: defaultPlan is not a plan');
  for (const [name, plan] of Object.entries(c.plans)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`policy: bad plan name ${name}`);
    const w = (k: string) => `${name}.${k}`;
    checkRate(plan.requests, w('requests'));
    if (!isInt(plan.build?.maxActive, 0, 64) || !isInt(plan.build?.maxQueued, 0, 64))
      throw new Error(`policy: bad ${w('build')}`);
    checkRate(plan.build.submissions, w('build.submissions'));
    checkRate(plan.build.failures, w('build.failures'));
    if (!isInt(plan.build.cooldownMs, 0, DAY))
      throw new Error(`policy: bad ${w('build.cooldownMs')}`);
    if (!isInt(plan.runtime?.maxSessions, 0, 256)) throw new Error(`policy: bad ${w('runtime')}`);
    checkRate(plan.runtime.creations, w('runtime.creations'));
    if (!isInt(plan.runtime.maxLifetimeMs, 1000, DAY))
      throw new Error(`policy: bad ${w('runtime.maxLifetimeMs')}`);
    if (
      !isInt(plan.storage?.maxArtifacts, 0, 1_000_000) ||
      !isInt(plan.storage?.maxBytes, 0, 2 ** 46) ||
      !isInt(plan.storage?.retentionDays, 1, 3650)
    )
      throw new Error(`policy: bad ${w('storage')}`);
    checkRate(plan.storage.prebuiltUploads, w('storage.prebuiltUploads'));
    if (typeof plan.capabilities?.allowPrebuiltBinary !== 'boolean')
      throw new Error(`policy: bad ${w('capabilities')}`);
  }
  for (const [principal, plan] of Object.entries(c.assignments ?? {}))
    if (!/^p_[A-Za-z0-9_-]{26}$/.test(principal) || !c.plans[plan])
      throw new Error(`policy: bad assignment ${principal}`);
  const g = c.global;
  const cpusOr = (v: unknown) => v === 'cpus' || isInt(v, 0, 1024);
  if (
    !g ||
    !isInt(g.build?.maxQueued, 0, 1024) ||
    !isInt(g.build?.maxQueueWaitMs, 1000, DAY) ||
    !cpusOr(g.build?.deferWhileLiveSessionsAtLeast) ||
    !cpusOr(g.runtime?.maxLiveSessions) ||
    !isInt(g.resources?.minFreeDiskMb, 0, 2 ** 30) ||
    !isInt(g.resources?.minAvailableMemoryMb, 0, 2 ** 30) ||
    !isInt(g.retention?.sweepIntervalMs, 1000, 31 * DAY)
  )
    throw new Error('policy: bad global limits');
  return { ...c, assignments: c.assignments ?? {} };
}

export class Policy {
  readonly cpus: number;
  constructor(
    readonly config: PolicyConfig = DEFAULT_POLICY,
    cpus = availableParallelism(),
  ) {
    validatePolicy(config);
    this.cpus = cpus;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Policy {
    const file = env.TBI_POLICY_FILE;
    return new Policy(
      file ? validatePolicy(JSON.parse(readFileSync(file, 'utf8'))) : DEFAULT_POLICY,
    );
  }

  planName(principal: Principal): string {
    return this.config.assignments[principal] ?? this.config.defaultPlan;
  }

  plan(principal: Principal): Plan {
    return this.config.plans[this.planName(principal)]!;
  }

  /** The global limits with `cpus` resolved for this host. */
  get maxLiveSessions(): number {
    const v = this.config.global.runtime.maxLiveSessions;
    return v === 'cpus' ? this.cpus : v;
  }

  get deferBuildsAtLiveSessions(): number {
    const v = this.config.global.build.deferWhileLiveSessionsAtLeast;
    return v === 'cpus' ? this.cpus : v;
  }

  /** The shortest retention of any plan (a sweep need not look at anything newer). */
  get minRetentionMs(): number {
    return Math.min(...Object.values(this.config.plans).map((p) => p.storage.retentionDays)) * DAY;
  }
}
