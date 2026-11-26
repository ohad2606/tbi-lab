/**
 * K12 / BETA-G1 before-enable: the bounded shutdown steps of the two processes that hold funnel
 * counters (signup/intake-main.ts, main.ts). With the counters off (`counters` null) each helper
 * does exactly what the process did before them: no flush, no extra timer, the same waits.
 */

/** What the helpers need of the counters (FunnelCounters.flush, bounded by its own deadline). */
export interface Flushable {
  flush(withinMs: number): Promise<void>;
}

/** Intake: overall shutdown deadline (close + flush), well below the unit's stop timeout. */
export const INTAKE_STOP_MS = 1_500;
/** Intake: at most this long for close(); the rest of INTAKE_STOP_MS is left for the flush. */
export const INTAKE_CLOSE_MS = 1_000;
/** Admin: the flush after the drain (finished or timed out) gets at most this long. */
export const ADMIN_FLUSH_MS = 1_000;

/**
 * Resolves when `p` settles (either way) or after `ms`, whichever is first. Never rejects. The
 * deadline timer is cleared on settle; with `keepAlive` (default) it keeps the process alive until
 * then, so the steps after it run even when nothing else holds the event loop.
 */
export function within(p: unknown, ms: number, keepAlive = true): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<void>((r) => {
    timer = setTimeout(r, ms);
    if (!keepAlive) timer.unref?.();
  });
  return Promise.race([Promise.resolve(p).then(noop, noop), t]).finally(() => clearTimeout(timer));
}
const noop = () => undefined;

/**
 * Intake: close() -> flush(), under ONE deadline (`totalMs`). A close() that hangs is given up
 * after `closeMs`, so the flush (and the exit after it) always happens. Counters off: close() is
 * awaited as before (no bound added, no timer).
 */
export async function closeThenFlush(
  close: () => Promise<unknown>,
  counters: Flushable | null | undefined,
  o: { totalMs?: number; closeMs?: number } = {},
): Promise<void> {
  if (!counters) {
    await close();
    return;
  }
  const total = o.totalMs ?? INTAKE_STOP_MS;
  const start = performance.now();
  await within(close(), o.closeMs ?? INTAKE_CLOSE_MS);
  const left = Math.max(0, total - (performance.now() - start));
  await within(counters.flush(left), left);
}

/**
 * Admin: the drain (and the auto-approve stop) bounded by `drainMs` (unchanged), THEN the flush
 * with its own bound, whether the drain finished or timed out. Counters off: the drain wait only.
 */
export async function drainThenFlush(
  drain: () => Promise<unknown>,
  drainMs: number,
  counters: Flushable | null | undefined,
  flushMs: number = ADMIN_FLUSH_MS,
): Promise<void> {
  // Counters off: the drain deadline stays unref'd, as before.
  await within(drain(), drainMs, !!counters);
  if (counters) await within(counters.flush(flushMs), flushMs);
}
