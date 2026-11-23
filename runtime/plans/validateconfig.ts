/**
 * TBI-018 s3d-8: OFFLINE validator of the Session Host's sim-plans configuration (design
 * S3D-HOST-WIRING-DESIGN §12 item 8). It answers "would the host boot metered with this environment?"
 * and reports EVERY problem at once (the host refuses with the first one only).
 *
 * Same rules as the host, not a copy of them: the flag/config checks are `checkSimFlags`, the state
 * directory rules `stateDirProblems`, the lock decision `inspectStateLock` (runtime/plans/hostboot.ts,
 * which the host's bootSimPlans uses), the interval bounds `checkSimBounds` (runtime/host/host.ts, as
 * simboot.ts calls it), and the host facts come from the same env readers as `main.ts`
 * (`hostTunablesFromEnv`, `defaultConfig`, `Policy.fromEnv`).
 *
 * It NEVER starts a host, never creates, writes, locks or repairs anything: the state directory is
 * only lstat'ed / access-checked, the lock files and the journal are only read. A torn or corrupt
 * journal is reported (the operator tool is sim-journal-repair.mjs). Output carries flag names, codes
 * and counts only: never a value, a path, file content or a principal.
 *
 * Differences from the host, by design (the validator is stricter, never looser):
 *  - a missing state directory is a problem (`state_dir_missing`); the host would create it 0700;
 *  - a state directory the current user cannot write is a problem (`state_dir_not_writable`); the host
 *    would refuse at the lock step;
 *  - a live lock is a problem (`state_locked`): a host runs on the directory, a second boot refuses.
 */
import { accessSync, constants as fsc, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Policy } from '../policy/policy.js';
import { defaultConfig, hostTunablesFromEnv, type HostConfig } from '../host/config.js';
import { checkSimBounds } from '../host/host.js';
import {
  checkSimFlags,
  inspectStateLock,
  SIM_JOURNAL_FILE,
  stateDirProblems,
  type SimProblem,
} from './hostboot.js';
import { HOST_SIM_FLAGS } from './hostflags.js';
import { journalReplays } from './repairjournal.js';
import type { SimEvent } from './simminutes.js';
import { JournalStore } from './store.js';

export interface SimConfigReport {
  /** `off`: no TBI_HOST_SIM_* flag set (the host would boot unmetered; nothing to validate) */
  status: 'ok' | 'problems' | 'off';
  problems: SimProblem[];
  /** informational, never a problem (names and sources only) */
  notes: string[];
}

export interface ValidateDeps {
  /** uid the state directory must belong to; default process.getuid() (run as the host's user) */
  uid?: number;
  /** liveness probe for the lock's pid; default process.kill(pid, 0) (read-only signal 0) */
  alive?: (pid: number) => boolean;
}

/**
 * Interval bounds as simboot.ts enforces them (checkSimBounds over the host config with the boot's
 * beat and housekeeping; endWaitMs has no flag, so the host default applies unless one is given).
 */
export function simBoundsProblems(
  host: Pick<HostConfig, 'leaseMs' | 'housekeepingMs'>,
  sim: { beatMs?: number; housekeepingMs?: number; endWaitMs?: number },
): SimProblem[] {
  try {
    checkSimBounds({ ...host, simAdmission: sim } as HostConfig);
    return [];
  } catch (e) {
    const why = e instanceof Error ? e.message : 'error';
    return [
      {
        code: 'sim_bounds',
        message: `sim admission config invalid (${why}); refusing to start`,
      },
    ];
  }
}

/** Read-only journal check: torn tail / corrupt / does not replay. Nothing written. */
async function journalProblems(dir: string): Promise<SimProblem[]> {
  const file = join(dir, SIM_JOURNAL_FILE);
  if (!existsSync(file)) return [];
  const refusal = 'sim plans state unusable; refusing to start';
  try {
    const loaded = await new JournalStore<SimEvent>(file).load();
    if (loaded.problem?.kind === 'torn_tail')
      return [
        {
          code: 'journal_torn',
          message: refusal,
          detail: `torn tail after ${loaded.events.length} events: run sim-journal-repair.mjs (report only) with the host stopped`,
        },
      ];
    if (loaded.problem)
      return [
        {
          code: 'journal_corrupt',
          message: refusal,
          detail: 'corruption before the last record: never repaired; rollback and investigate',
        },
      ];
    if (!(await journalReplays(file)).ok)
      return [
        {
          code: 'journal_corrupt',
          message: refusal,
          detail: 'the journal does not replay: never repaired; rollback and investigate',
        },
      ];
    return [];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return [
      {
        code: 'journal_corrupt',
        message: refusal,
        detail: `journal unreadable${typeof code === 'string' && /^E[A-Z]+$/.test(code) ? ` (${code})` : ''}`,
      },
    ];
  }
}

/**
 * Validates the sim-plans environment `env` as the Session Host's main.ts would boot it. Pure apart from
 * reads (config file, policy file, state directory metadata, lock files, journal).
 */
export async function validateSimConfig(
  env: Record<string, string | undefined>,
  deps: ValidateDeps = {},
): Promise<SimConfigReport> {
  const notes: string[] = [];
  if (!HOST_SIM_FLAGS.some((f) => env[f] !== undefined))
    return { status: 'off', problems: [], notes };

  // Host facts exactly as main.ts builds them (tunables, defaults, policy).
  const tunables = hostTunablesFromEnv(env);
  const lease = env.TBI_HOST_LEASE_MS;
  if (lease !== undefined && tunables.leaseMs === undefined)
    notes.push('TBI_HOST_LEASE_MS is not a whole number: the host ignores it and uses its default');
  notes.push(
    `host lease from ${tunables.leaseMs !== undefined ? 'TBI_HOST_LEASE_MS' : 'the host default'}`,
  );
  const host = defaultConfig({
    qemu: '',
    artifactsDir: '',
    ticketKey: Buffer.alloc(0),
    ...tunables,
  });
  const problems: SimProblem[] = [];
  let policyPlanNames: string[] | undefined;
  try {
    policyPlanNames = Object.keys(Policy.fromEnv(env as NodeJS.ProcessEnv).config.plans);
    notes.push(`policy from ${env.TBI_POLICY_FILE ? 'TBI_POLICY_FILE' : 'the built-in default'}`);
  } catch (e) {
    problems.push({
      code: 'policy_unusable',
      message: 'TBI_POLICY_FILE unusable: the host would not start',
      detail: e instanceof SyntaxError ? 'not valid JSON' : undefined,
    });
  }

  const flags = checkSimFlags(env, host.leaseMs, {
    policyPlanNames,
    housekeepingMs: host.housekeepingMs,
  });
  // A policy that cannot be read is already reported; "no policy" would only repeat it.
  for (const p of flags?.problems ?? [])
    if (!(p.code === 'no_policy' && policyPlanNames === undefined)) problems.push(p);
  if (flags?.ok)
    problems.push(
      ...simBoundsProblems(host, {
        beatMs: flags.ok.beatMs,
        housekeepingMs: flags.ok.housekeepingMs,
      }),
    );

  // State directory: checked whenever it is named, even when the flags have other problems.
  const dir = env.TBI_HOST_SIM_PLANS_STATE;
  if (dir !== undefined && dir !== '') {
    const dirProblems = stateDirProblems(dir, deps.uid ?? process.getuid?.(), { create: false });
    problems.push(...dirProblems);
    const isDir = !dirProblems.some((p) =>
      ['state_dir_path', 'state_dir_missing', 'state_dir_not_dir', 'state_dir_unusable'].includes(
        p.code,
      ),
    );
    if (isDir) {
      try {
        accessSync(dir, fsc.R_OK | fsc.W_OK | fsc.X_OK);
      } catch {
        problems.push({
          code: 'state_dir_not_writable',
          message: 'sim state lock unusable; refusing to start',
          detail: 'the state directory is not readable/writable by this user',
        });
      }
      problems.push(...inspectStateLock(dir, deps.alive));
      problems.push(...(await journalProblems(dir)));
    }
  }
  return {
    status: problems.length > 0 ? 'problems' : 'ok',
    problems: problems.map((p) =>
      p.detail === undefined ? { code: p.code, message: p.message } : p,
    ),
    notes,
  };
}
