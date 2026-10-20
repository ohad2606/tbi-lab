/**
 * Sprint 18F: the time a build has taken so far, next to "Building…" (a real clock since the
 * request, never an estimate or a progress bar). Not a live region: the phase text announces the
 * change once; a number changing every second would be read out every second.
 */
import { useEffect, useState } from 'preact/hooks';
import { useT } from './context.js';

/** Whole seconds since `since` (epoch ms), updated every second; null without a build. */
export function useElapsedSeconds(since: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === undefined ? null : Math.max(0, Math.floor((now - since) / 1000));
}

/** The elapsed seconds of a running build, from 2 s on (a cache hit never shows one). */
export function BuildElapsed({ since }: { since: number | undefined }) {
  const t = useT();
  const seconds = useElapsedSeconds(since);
  if (seconds === null || seconds < 2) return null;
  return (
    <span class="build-elapsed technical" dir="ltr" aria-hidden="true" data-testid="build-elapsed">
      {t('build.elapsed', { seconds: String(seconds) })}
    </span>
  );
}
