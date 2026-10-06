/**
 * New-version detection (Sprint 10, approved): a tab left open across a deploy keeps running the
 * code it loaded; this notices that the server now serves a different build so the UI can offer a
 * reload. It never reloads by itself.
 *
 * The running build's identity is compiled in (buildInfo.ts); the served one is /version.json
 * (no-store, written by the same build step). They are compared by full commit only.
 * Checks: when the window gains focus or the tab becomes visible, and every few minutes while the
 * tab is visible. A failed or malformed response is ignored (offline, signed out: no false alarm).
 * `stop()` removes every listener and the timer.
 */
import { parseBuildInfo, type BuildInfo } from './buildInfo.js';

/** The interval between background checks while the tab is visible. */
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface UpdateCheckEnv {
  fetch: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

/**
 * Start checking. `onNewer` is called with the served build each time a check finds one that
 * differs from `running` (callers de-duplicate). Returns `stop`.
 */
export function startUpdateCheck(
  running: BuildInfo,
  onNewer: (served: BuildInfo) => void,
  env: UpdateCheckEnv,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): () => void {
  let stopped = false;
  let inFlight = false;
  const check = async () => {
    if (stopped || inFlight || env.document.visibilityState === 'hidden') return;
    inFlight = true;
    try {
      const res = await env.fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) return;
      const served = parseBuildInfo(await res.json());
      if (!stopped && served && served.commit !== running.commit) onNewer(served);
    } catch {
      /* offline, signed out, malformed: say nothing */
    } finally {
      inFlight = false;
    }
  };
  const onFocus = () => void check();
  const onVisibility = () => env.document.visibilityState === 'visible' && void check();
  env.window.addEventListener('focus', onFocus);
  env.document.addEventListener('visibilitychange', onVisibility);
  const timer = env.setInterval(() => void check(), intervalMs);
  return () => {
    stopped = true;
    env.window.removeEventListener('focus', onFocus);
    env.document.removeEventListener('visibilitychange', onVisibility);
    env.clearInterval(timer);
  };
}
