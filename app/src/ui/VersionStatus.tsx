/**
 * The build identity, always visible (Sprint 10, owner requirement): a slim status line at the
 * bottom of the app with `v0.10-dev · 9c94329`; hover, focus or click shows the full identity.
 * The product footer (ProductFooter) shares the bar, at the inline start.
 * It reads the identity compiled into the running code (buildInfo.ts), the same object as
 * /version.json. Technical tokens (version, commit, timestamp) are always left-to-right.
 */
import { useState } from 'preact/hooks';
import { BUILD_INFO, versionLabel } from '../buildInfo.js';
import { probeGpu } from '../gpuInfo.js';
import { probeRuntime, type RuntimeIdentity } from '../runtimeInfo.js';
import { useAppState, useT } from './context.js';
import { ProductFooter } from './ProductFooter.js';
import { StatusActions } from './StatusActions.js';

export function VersionStatus() {
  const t = useT();
  const { locale } = useAppState();
  const [open, setOpen] = useState(false);
  // The 3D graphics this browser offers (probed once, when the details are first shown).
  const [gpu, setGpu] = useState<{ renderer: string; tier: string } | null>(null);
  // The ESP32 runtime's identity (its /health), fetched once when the details are first shown.
  const [runtime, setRuntime] = useState<RuntimeIdentity | null | undefined>(undefined);
  const showGpu = () => {
    if (runtime === undefined) {
      setRuntime(null);
      void probeRuntime().then((r) => r && setRuntime(r));
    }
    return gpu ?? setGpu(probeGpu() ?? { renderer: t('version.noWebgl'), tier: 'reduced' });
  };
  const info = BUILD_INFO;
  if (!info)
    return (
      <footer class="statusbar" dir={locale.dir} aria-label={t('footer.aria')}>
        <ProductFooter />
        <StatusActions />
      </footer>
    );
  const label = versionLabel(info);
  const rows: [string, string, boolean][] = [
    [t('version.product'), info.product, true],
    [t('version.version'), `v${info.version}`, true],
    [t('version.environment'), info.environment, true],
    [t('version.commit'), info.commit + (info.dirty ? ' (+)' : ''), true],
    [t('version.builtAt'), info.builtAt, true],
    runtime
      ? [t('version.runtime'), `v${runtime.version} · ${runtime.commit.slice(0, 7)}`, true]
      : [t('version.runtime'), t('version.runtimeUnknown'), false],
    [
      t('version.graphics'),
      gpu
        ? `${gpu.renderer} (${t(gpu.tier === 'full' ? 'version.tierFull' : 'version.tierReduced')})`
        : '…',
      true,
    ],
  ];
  return (
    <footer class="statusbar" dir={locale.dir} aria-label={t('footer.aria')}>
      <ProductFooter />
      <StatusActions />
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
          onClick={() => {
            showGpu();
            setOpen((o) => !o);
          }}
          onFocus={showGpu}
          onMouseEnter={showGpu}
        >
          <bdi dir="ltr">{label}</bdi>
        </button>
        <dl
          class="version-details"
          data-testid="app-version-details"
          data-runtime-commit={runtime?.commit}
          role="note"
        >
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
