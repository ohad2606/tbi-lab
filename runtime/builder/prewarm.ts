/**
 * Capacity A4: the prewarm pass (BuildService.prewarm) repeated for the life of the process, so a
 * curated build that failed, or whose image is gone, is built again without a restart.
 */
import type { BuildRequest } from './protocol.js';
import type { BuildService } from './service.js';

export const PREWARM_INTERVAL_MS = 10 * 60_000;
/**
 * Builds a process spends on a curated source that keeps failing, with a doubling number of
 * passes between them (BuildService.prewarm; a success, a user's build included, resets it).
 */
export const PREWARM_ATTEMPTS = 6;

/**
 * Run a pass now, then one `intervalMs` after the previous one ENDED (passes never overlap). One
 * counts-only line per pass. Returns stop(): no further pass or build is started.
 */
export function startPrewarm(
  service: BuildService,
  requests: readonly BuildRequest[],
  opts: { intervalMs?: number; pollMs?: number; log?: (line: string) => void } = {},
): () => void {
  const log = opts.log ?? ((l: string) => void process.stdout.write(`${l}\n`));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pass = async () => {
    try {
      const built = await service.prewarm(requests, {
        stopped: () => stopped,
        ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      });
      if (!stopped)
        log(JSON.stringify({ event: 'prewarm', built, missing: service.missing(requests) }));
    } catch (e) {
      process.stderr.write(`prewarm: ${(e as Error).message}\n`);
    }
    if (!stopped) {
      timer = setTimeout(() => void pass(), opts.intervalMs ?? PREWARM_INTERVAL_MS);
      timer.unref?.();
    }
  };
  void pass();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
