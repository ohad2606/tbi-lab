/**
 * "A new version is available" (Sprint 10, approved): shown when the server serves a different
 * build than the one this tab runs (updateCheck.ts). Reload is the user's choice, never automatic,
 * and is held back while it would interrupt something: a running simulation or ESP32 session, a
 * firmware build, or changes not yet saved. "Later" hides it until a still newer build appears.
 * The commit is a technical token: always left-to-right.
 */
import { useEffect, useState } from 'preact/hooks';
import { BUILD_INFO, versionLabel, type BuildInfo } from '../buildInfo.js';
import { startUpdateCheck } from '../updateCheck.js';
import { useAppState, useStore, useT } from './context.js';
import { gateFetch } from '../gate.js';

const DISMISSED = 'tbi-lab.update.dismissed';

export function UpdateBanner() {
  const t = useT();
  const store = useStore();
  const { sim, saveState } = useAppState();
  const [served, setServed] = useState<BuildInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(DISMISSED);
    } catch {
      return null;
    }
  });
  const [buildBusy, setBuildBusy] = useState(() => store.builds?.busy ?? false);

  useEffect(() => {
    const running = BUILD_INFO;
    if (!running) return;
    return startUpdateCheck(
      running,
      (s) => setServed((prev) => (prev?.commit === s.commit ? prev : s)),
      {
        fetch: (url, init) => gateFetch(url, init),
        window,
        document,
        setInterval: (fn, ms) => window.setInterval(fn, ms),
        clearInterval: (id) => window.clearInterval(id as number),
      },
    );
  }, []);
  useEffect(() => {
    const builds = store.builds;
    if (!builds) return;
    return builds.subscribe(() => setBuildBusy(builds.busy));
  }, [store]);

  if (!served || served.commit === dismissed) return null;
  const simBusy =
    sim.status === 'running' || sim.status === 'starting' || sim.status === 'stopping';
  const unsaved = saveState !== 'saved';
  const busy = simBusy || buildBusy || unsaved;
  const reason = simBusy
    ? t('update.busySimulation')
    : buildBusy
      ? t('update.busyBuild')
      : unsaved
        ? t('update.busySaving')
        : null;
  return (
    <div
      class="banner banner-info update-banner"
      role="status"
      data-testid="update-banner"
      data-served={served.commit}
    >
      <strong>{t('update.available')}</strong>
      <span class="update-version">
        <bdi dir="ltr" data-testid="update-version">
          {versionLabel(served)}
        </bdi>
      </span>
      {reason && (
        <span class="small" data-testid="update-busy">
          {reason}
        </span>
      )}
      <span class="update-actions">
        <button
          type="button"
          class="button button-primary"
          data-testid="update-reload"
          disabled={busy}
          onClick={() => void store.flush().then(() => location.reload())}
        >
          {t('update.reload')}
        </button>
        <button
          type="button"
          class="button"
          data-testid="update-later"
          onClick={() => {
            setDismissed(served.commit);
            try {
              sessionStorage.setItem(DISMISSED, served.commit);
            } catch {
              /* per-tab only */
            }
          }}
        >
          {t('update.later')}
        </button>
      </span>
    </div>
  );
}
