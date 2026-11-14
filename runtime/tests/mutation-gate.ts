/**
 * Execution gate for tests that CHANGE a deployed instance (staging `tbi-s8`, DEV-Lab `tbi`):
 * restarting or stopping its services, installing configuration or policy under /etc/<instance>,
 * or killing QEMU / session units with systemctl. Such a test runs only when BOTH hold:
 *
 *   1. `TBI_ALLOW_SERVICE_MUTATION` names the instance (comma-separated list, e.g. `tbi-s8`), and
 *   2. the caller holds the host-wide pipeline lock (`deploy/ops/pipeline-lock.mjs check` exits 0).
 *
 * Otherwise the test is SKIPPED with the reason below; nothing is touched. Default runs of the
 * runtime suite (`npm run test:runtime`, the kits' run-gates scripts) therefore never restart a
 * shared service or rewrite its configuration (incidents 2026-11-13, evidence rc2
 * STAGING-INCIDENTS.md). The classification of every such test is in docs/ops/TEST-SAFETY.md, and
 * scripts/tests/mutation-gate.test.mjs fails if a runtime test or e2e spec calls a mutating
 * systemctl / install command without using this gate.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MUTATION_ENV = 'TBI_ALLOW_SERVICE_MUTATION';

/** The instances the environment allows to be changed. */
export function allowedTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[MUTATION_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const LOCK = fileURLToPath(new URL('../../deploy/ops/pipeline-lock.mjs', import.meta.url));

/** True only if the caller holds the pipeline lock (the lock tool's own `check`). */
export function holdsPipelineLock(): boolean {
  return spawnSync(process.execPath, [LOCK, 'check'], { stdio: 'ignore' }).status === 0;
}

/** May a test change instance `target`? (opt-in naming it AND the pipeline lock held) */
export function mutationAllowed(target: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!target || !allowedTargets(env).includes(target)) return false;
  return holdsPipelineLock();
}

/** The skip reason a gated test reports. */
export function mutationSkipReason(target: string, what: string): string {
  return `${what} on ${target || '(no instance named)'}: refused unless ${MUTATION_ENV}=${target || '<instance>'} and the pipeline lock is held`;
}
