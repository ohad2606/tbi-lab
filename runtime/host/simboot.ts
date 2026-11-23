/**
 * TBI-018 s3d-6: Session Host boot of sim metering (design docs/plans/S3D-HOST-WIRING-DESIGN.md §7, §9).
 * `runtime/host/main.ts` calls `hostSimFromEnv` after the host config is built and BEFORE the host is
 * constructed and listens. No TBI_HOST_SIM_* flag set = undefined, nothing read or created (today's host).
 * Metering still needs the owner: it is on only when TBI_HOST_SIM_PLANS_CONFIG names a config with
 * `metering.enabled: true`, and no deployment sets it (design §10 R-3).
 *
 * Any refusal throws HostSimBootError; main.ts exits with HOST_SIM_REFUSED_EXIT (78), which the
 * systemd units exclude from their restart policy (RestartPreventExitStatus=78), so a refusal never
 * hot-loops. Messages carry flag names and counts only: never a path, value, principal or ticket.
 */
import {
  HostSimBootError,
  bootSimPlans,
  type HostSimBootDeps,
  type HostSimPlans,
} from '../plans/hostboot.js';
import type { Clock } from '../plans/time.js';
import type { HostConfig, SimAdmissionConfig } from './config.js';
import { checkSimBounds } from './host.js';
import { TicketRegistry } from './queueTickets.js';

/** Most queue tickets the host keeps in memory (design §4 M2: global cap, oldest-first eviction). */
export const SIM_TICKET_CAP = 4096;
/** Most tickets of one principal: its waiting ticket, the one it replaced, and a little slack. */
export const SIM_TICKET_PER_PRINCIPAL = 4;

export interface HostSimBoot {
  /** what goes into HostConfig.simPlans / simAdmission */
  simPlans: HostSimPlans['adapter'];
  simAdmission: SimAdmissionConfig;
  /** the state-dir lock: release after the host shut down */
  lock: HostSimPlans['lock'];
  /** one operator line (counts and a file name inside the state dir only) */
  logLine: string;
}

/**
 * Builds the metered admission from the environment for `config` (which must already carry its
 * policy, leaseMs and housekeepingMs), or undefined when no sim flag is set. On a refusal after the
 * state lock was taken, the lock is released before throwing.
 */
export async function hostSimFromEnv(
  env: Record<string, string | undefined>,
  config: Pick<HostConfig, 'policy' | 'leaseMs' | 'housekeepingMs'>,
  deps: HostSimBootDeps = {},
): Promise<HostSimBoot | undefined> {
  const policy = config.policy;
  const sim = await bootSimPlans(
    env,
    config.leaseMs,
    {
      policyPlanNames: policy ? Object.keys(policy.config.plans) : undefined,
      housekeepingMs: config.housekeepingMs,
    },
    deps,
  );
  if (!sim) return undefined;
  try {
    const clock: Clock = deps.clock ?? { now: () => Date.now() };
    const simAdmission: SimAdmissionConfig = {
      planMap: sim.planMap,
      pollAfterS: sim.pollAfterS,
      tickets: new TicketRegistry({
        ttlMs: sim.config.queue.maxWaitMs + sim.config.queue.vanishMs,
        cap: SIM_TICKET_CAP,
        perPrincipalCap: SIM_TICKET_PER_PRINCIPAL,
        clock,
      }),
      beatMs: sim.beatMs,
      housekeepingMs: sim.housekeepingMs,
    };
    checkSimBounds({ ...config, simAdmission } as HostConfig);
    const c = sim.boot.compaction;
    const logLine = JSON.stringify({
      event: 'sim_boot',
      recovered: sim.boot.recovered,
      compaction: c.kind,
      ...(c.kind === 'done' ? { copy: c.copy } : {}),
    });
    return { simPlans: sim.adapter, simAdmission, lock: sim.lock, logLine };
  } catch (e) {
    sim.lock.release();
    const why = e instanceof Error ? e.message : 'error';
    throw new HostSimBootError(`sim admission config invalid (${why}); refusing to start`);
  }
}

/** The one stderr line for a refusal: the HostSimBootError text, or only the error class otherwise. */
export function simRefusalLine(e: unknown): string {
  if (e instanceof HostSimBootError) return `tbi-session-host: ${e.message}`;
  const name = e instanceof Error ? e.constructor.name : 'error';
  return `tbi-session-host: sim plans boot failed (${name}); refusing to start`;
}
