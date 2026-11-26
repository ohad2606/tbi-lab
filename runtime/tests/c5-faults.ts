/**
 * Verdict of the C-5 fault drills (TBI_C5_FAULTS=1): the names of what did not recover or clean up.
 * A drill that did not run is not judged (the deployed crash drill needs two sessions).
 */
export interface DeployedFaults {
  stop?: { status: number; recreated?: number };
  crash?: { reported?: unknown; unitGone?: boolean; recreated?: number };
}
export function deployedFaultFailures({ stop, crash }: DeployedFaults): string[] {
  const failed: string[] = [];
  if (stop && !(stop.status < 300 && stop.recreated === 201)) failed.push('stop');
  if (crash && !(crash.reported && crash.unitGone === true && crash.recreated === 201))
    failed.push('crash');
  return failed;
}

export interface CapacityFaults {
  stop?: { state: string; runtimeGone: boolean };
  crash?: { state: string; runtimeGone: boolean };
}
/** Recovered: every replacement session that no later drill faulted is running at the end. */
export function capacityFaultFailures(
  { stop, crash }: CapacityFaults,
  sessions: { replaces?: number; fault?: string; state: string }[],
): string[] {
  const failed: string[] = [];
  if (stop && !(stop.state === 'ended' && stop.runtimeGone)) failed.push('stop');
  if (crash && !(crash.state === 'failed' && crash.runtimeGone)) failed.push('crash');
  const replaced = sessions.filter((s) => s.replaces !== undefined && !s.fault);
  if ((stop || crash) && !(replaced.length && replaced.every((s) => s.state === 'running')))
    failed.push('replacement');
  return failed;
}
