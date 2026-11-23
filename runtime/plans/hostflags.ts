/**
 * TBI-018 s3d-1: the Session Host's sim-plans environment flags (design S3D-HOST-WIRING-DESIGN §9).
 * No imports on purpose. s3d-6: the s3d-1 "not wired" refusal is gone (main.ts boots the flags through
 * runtime/host/simboot.ts); only `bootSimPlans` (hostboot.ts) reads the values.
 */
export const HOST_SIM_FLAGS = [
  'TBI_HOST_SIM_PLANS_CONFIG',
  'TBI_HOST_SIM_PLANS_STATE',
  'TBI_HOST_SIM_PLAN_MAP',
  'TBI_HOST_SIM_BEAT_MS',
  'TBI_HOST_SIM_HOUSEKEEPING_MS',
  'TBI_HOST_SIM_POLL_S',
] as const;
export type HostSimFlag = (typeof HOST_SIM_FLAGS)[number];

/**
 * Exit code of a host that refuses to start because of the sim-plans flags or state (EX_CONFIG). Distinct
 * from every other host exit (0 on stop, 1 on an uncaught error) so a unit can exclude it from its
 * restart policy (`RestartPreventExitStatus`, design §7 M6).
 */
export const HOST_SIM_REFUSED_EXIT = 78;

/** Names (never values) of the sim-plans flags present in `env`. Present = defined, even empty. */
export function hostSimFlagsSet(env: Record<string, string | undefined>): HostSimFlag[] {
  return HOST_SIM_FLAGS.filter((f) => env[f] !== undefined);
}
