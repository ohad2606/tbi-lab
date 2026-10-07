/**
 * The 3D view tab (Sprint 9): a derived 360° visualization of the circuit. It loads the 3D
 * renderer (and three.js) only when opened, re-derives the scene whenever the document changes,
 * and releases every GPU resource when closed. It never edits the project.
 *
 * If WebGL is unavailable (or the renderer cannot load) it shows a localized explanation; the
 * other views are unaffected.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { deriveScene } from '../views/scene3d/scene.js';
import type { LiveLevel, Viewer, ViewerStats } from '../views/scene3d/renderer.js';
import { rgbMix } from '../views/ledLooks.js';
import { useAppState, useT } from './context.js';

type Status = 'loading' | 'ready' | 'unavailable' | 'failed';

/** The reference-labels preference (per browser; never part of a project). */
const LABELS_KEY = 'tbi-lab.3d.labels';
const readLabels = () => {
  try {
    return localStorage.getItem(LABELS_KEY) !== 'off';
  } catch {
    return true;
  }
};

/** Shift + arrow pan step, as a fraction of the visible height. */
const PAN_STEP = 0.1;

export function ThreeView() {
  const { doc, locale, sim } = useAppState();
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  /** How long the bundled glTF assets took to fetch and parse (once per page), ms. */
  const [assetMs, setAssetMs] = useState<number | null>(null);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [labels, setLabels] = useState(readLabels);
  const scene = useMemo(() => (doc ? deriveScene(doc) : null), [doc]);
  const shownProject = useRef<string | null>(null);

  // Load the renderer once per opening; release everything on close.
  useEffect(() => {
    let cancelled = false;
    // The renderer chunk, then the bundled glTF assets (fetched once per page, never at start-up).
    import('../views/scene3d/renderer.js')
      .then(async (mod) => {
        await mod.loadAssets();
        setAssetMs(mod.assetLoadStats()?.ms ?? null);
        return mod;
      })
      .then((mod) => {
        if (cancelled || !host.current) return;
        try {
          viewer.current = mod.createViewer(host.current, (s) => setStats(s), {
            labels: readLabels(),
          });
          // Evidence capture (screenshots at fixed close-up cameras): the viewer is reachable from
          // the page only when this browser opted in. Never used by the product.
          try {
            if (localStorage.getItem('tbi-lab.3d.inspect') === '1')
              (host.current as unknown as { tbiViewer?: Viewer }).tbiViewer = viewer.current;
          } catch {
            /* storage unavailable */
          }
          setStatus('ready');
        } catch (e) {
          setStatus(e instanceof mod.WebGLUnavailableError ? 'unavailable' : 'failed');
        }
      })
      .catch(() => !cancelled && setStatus('failed'));
    return () => {
      cancelled = true;
      viewer.current?.dispose();
      viewer.current = null;
    };
  }, []);

  // The scene follows the document; a different project starts from the default camera.
  useEffect(() => {
    if (status !== 'ready' || !scene || !viewer.current) return;
    const resetCamera = shownProject.current !== doc?.projectId;
    shownProject.current = doc?.projectId ?? null;
    viewer.current.update(scene, { resetCamera });
  }, [scene, status]);

  // While running: LED glow from the solved forward current (visual cue only, as on the circuit
  // canvas). Off when stopped.
  const outcome = sim.status === 'running' && sim.outcome.ok ? sim.outcome : null;
  const levels: Record<string, LiveLevel> = {};
  if (outcome && doc)
    for (const c of doc.components)
      if (c.type === 'component.led') {
        const i = outcome.components[c.id]?.current ?? 0;
        if (i && i > 0) levels[c.id] = Math.min(1, Math.max(0.08, i / 0.02));
      } else if (c.type === 'display.led_matrix_8x8') {
        // Each dot's level from ITS solved current (full at 20 mA).
        const arr = outcome.components[c.id]?.array;
        if (arr && arr.currents.some((i) => i > 1e-6))
          levels[c.id] = {
            dots: arr.currents.map((i) => (i > 1e-6 ? Math.min(1, Math.max(0.15, i / 0.02)) : 0)),
          };
      } else if (c.type === 'component.rgb_led') {
        // The emitted colour is the mix of the SOLVED channel currents (never a chosen colour).
        const mix = rgbMix(outcome.components[c.id]?.currents ?? {});
        if (mix) levels[c.id] = { level: mix.intensity, color: mix.color };
      }
  const levelKey = JSON.stringify(levels);
  useEffect(() => {
    if (status === 'ready') viewer.current?.setLive(levels);
  }, [levelKey, status, scene]);

  if (!doc) return null;
  return (
    <div
      class="view3d-wrap"
      dir="ltr"
      data-testid="view3d"
      data-status={status}
      data-components={scene?.components.map((c) => c.id).join(' ')}
      data-wires={scene?.wires.length}
      data-quality={stats?.quality}
      data-geometries={stats?.geometries}
      data-textures={stats?.textures}
      data-gpu-bytes={stats ? stats.gpuBytes.geometry + stats.gpuBytes.textures : undefined}
      data-assets-ms={assetMs ?? undefined}
      data-render-ms={stats?.renderMs}
      data-labels={labels ? 'on' : 'off'}
      data-objects={stats?.objects}
      data-renders={stats?.renders}
      data-programs={stats?.programs}
      data-draw-calls={stats?.drawCalls}
      data-triangles={stats?.triangles}
      data-materials={stats?.materials}
      data-lit={Object.keys(levels).join(' ')}
      data-glow={Object.entries(levels)
        .flatMap(([id, l]) => (typeof l === 'object' && 'color' in l ? [`${id}:${l.color}`] : []))
        .join(' ')}
      data-leds={scene?.components
        .flatMap((c) => (c.visual.led ? [`${c.id}:${c.visual.led.package}`] : []))
        .join(' ')}
      data-target={stats?.target.join(',')}
      data-contacts={scene?.joints
        .filter((j) => j.kind === 'contact')
        .map((j) => j.terminals.join('+'))
        .join(' ')}
      data-open={scene?.joints
        .filter((j) => j.kind === 'open')
        .map((j) => j.terminals.join('+'))
        .join(' ')}
    >
      <div
        class="view3d-host"
        ref={host}
        role="img"
        aria-label={t('view3d.aria', { name: doc.name })}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown + - Home"
        tabIndex={status === 'ready' ? 0 : -1}
        data-testid="view3d-host"
        onKeyDown={(e) => {
          // The same camera actions as the buttons. Arrows are spatial: not mirrored under RTL.
          const v = viewer.current;
          if (!v) return;
          // Shift + arrows pan (the view moves the way the arrow points).
          const act: Record<string, () => void> = e.shiftKey
            ? {
                ArrowLeft: () => v.pan(-PAN_STEP, 0),
                ArrowRight: () => v.pan(PAN_STEP, 0),
                ArrowUp: () => v.pan(0, PAN_STEP),
                ArrowDown: () => v.pan(0, -PAN_STEP),
              }
            : {
                ArrowLeft: () => v.rotate(-Math.PI / 8),
                ArrowRight: () => v.rotate(Math.PI / 8),
                '+': () => v.zoom(1.25),
                '=': () => v.zoom(1.25),
                '-': () => v.zoom(0.8),
                Home: () => v.resetCamera(),
              };
          const run = act[e.key];
          if (!run || e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          run();
        }}
      />
      {status === 'loading' && (
        <div class="view3d-message" role="status" dir={locale.dir}>
          {t('view3d.loading')}
        </div>
      )}
      {(status === 'unavailable' || status === 'failed') && (
        <div class="view3d-message" role="alert" dir={locale.dir} data-testid="view3d-unavailable">
          {t(status === 'unavailable' ? 'view3d.unavailable' : 'view3d.loadFailed')}
        </div>
      )}
      {status === 'ready' && (
        <>
          <div class="canvas-controls" role="group" aria-label={t('view3d.controls')}>
            <button
              type="button"
              class="icon-button"
              aria-label={t('canvas.zoomIn')}
              title={t('canvas.zoomIn')}
              onClick={() => viewer.current?.zoom(1.25)}
            >
              +
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={t('canvas.zoomOut')}
              title={t('canvas.zoomOut')}
              onClick={() => viewer.current?.zoom(0.8)}
            >
              −
            </button>
            <button
              type="button"
              class="icon-button"
              data-testid="view3d-rotate-left"
              aria-label={t('view3d.rotateLeft')}
              title={t('view3d.rotateLeft')}
              onClick={() => viewer.current?.rotate(-Math.PI / 8)}
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                aria-hidden="true"
                class="control-icon"
              >
                <path d="M15 6a6.5 6.5 0 1 0 1.5 6M15 2v4h-4" />
              </svg>
            </button>
            <button
              type="button"
              class="icon-button"
              data-testid="view3d-rotate-right"
              aria-label={t('view3d.rotateRight')}
              title={t('view3d.rotateRight')}
              onClick={() => viewer.current?.rotate(Math.PI / 8)}
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                aria-hidden="true"
                class="control-icon"
              >
                <path d="M5 6a6.5 6.5 0 1 1-1.5 6M5 2v4h4" />
              </svg>
            </button>
            <button
              type="button"
              class="icon-button"
              data-testid="view3d-fit"
              aria-label={t('canvas.zoomFit')}
              title={t('canvas.zoomFit')}
              onClick={() => viewer.current?.fit()}
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                aria-hidden="true"
                class="control-icon"
              >
                <path d="M3 8V3h5M12 3h5v5M17 12v5h-5M8 17H3v-5" />
              </svg>
            </button>
            <button
              type="button"
              class="icon-button"
              data-testid="view3d-reset"
              aria-label={t('view3d.reset')}
              title={t('view3d.reset')}
              onClick={() => viewer.current?.resetCamera()}
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                aria-hidden="true"
                class="control-icon"
              >
                <path d="M3 10 10 3l7 7M5 8.5V17h10V8.5" />
              </svg>
            </button>
          </div>
          <div
            class="view3d-presets"
            role="group"
            aria-label={t('view3d.presets')}
            dir={locale.dir}
          >
            <button
              type="button"
              class="text-button"
              data-testid="view3d-labels"
              aria-pressed={labels}
              onClick={() => {
                const next = !labels;
                setLabels(next);
                viewer.current?.setLabels(next);
                try {
                  localStorage.setItem(LABELS_KEY, next ? 'on' : 'off');
                } catch {
                  /* preference not kept */
                }
              }}
            >
              {t('view3d.labels')}
            </button>
            {(['top', 'front', 'side', 'rear'] as const).map((p) => (
              <button
                key={p}
                type="button"
                class="text-button"
                data-testid={`view3d-view-${p}`}
                onClick={() => viewer.current?.view(p)}
              >
                {t(`view3d.view.${p}`)}
              </button>
            ))}
          </div>
          <div class="view-note" dir={locale.dir}>
            {t('view3d.note')}
          </div>
        </>
      )}
    </div>
  );
}
