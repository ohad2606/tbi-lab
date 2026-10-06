/**
 * The build identity, always visible (Sprint 10, owner requirement): a slim status line at the
 * bottom of the app with `v0.10-dev · 9c94329`; hover, focus or click shows the full identity.
 * It reads the identity compiled into the running code (buildInfo.ts), the same object as
 * /version.json. Technical tokens (version, commit, timestamp) are always left-to-right.
 */
import { useState } from 'preact/hooks';
import { BUILD_INFO, versionLabel } from '../buildInfo.js';
import { useAppState, useT } from './context.js';

export function VersionStatus() {
  const t = useT();
  const { locale } = useAppState();
  const [open, setOpen] = useState(false);
  const info = BUILD_INFO;
  if (!info) return <footer class="statusbar" dir={locale.dir} />;
  const label = versionLabel(info);
  const rows: [string, string, boolean][] = [
    [t('version.product'), info.product, true],
    [t('version.version'), `v${info.version}`, true],
    [t('version.environment'), info.environment, true],
    [t('version.commit'), info.commit + (info.dirty ? ' (+)' : ''), true],
    [t('version.builtAt'), info.builtAt, true],
    [t('version.runtime'), t('version.runtimeUnknown'), false],
  ];
  return (
    <footer class="statusbar" dir={locale.dir}>
      <div
        class={open ? 'version-status open' : 'version-status'}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        <button
          type="button"
          class="version-button"
          data-testid="app-version"
          data-commit={info.commit}
          aria-expanded={open}
          aria-label={t('version.aria', { version: label })}
          title={`${info.product} ${label}\n${info.environment} · ${info.commit}\n${info.builtAt}`}
          onClick={() => setOpen((o) => !o)}
        >
          <bdi dir="ltr">{label}</bdi>
        </button>
        <dl class="version-details" data-testid="app-version-details" role="note">
          {rows.map(([k, v, technical]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd dir={technical ? 'ltr' : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </footer>
  );
}
