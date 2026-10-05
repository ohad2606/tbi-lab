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
import type { Viewer, ViewerStats } from '../views/scene3d/renderer.js';
import { useAppState, useT } from './context.js';

type Status = 'loading' | 'ready' | 'unavailable' | 'failed';

export function ThreeView() {
  const { doc, locale, sim } = useAppState();
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const scene = useMemo(() => (doc ? deriveScene(doc) : null), [doc]);
  const shownProject = useRef<string | null>(null);

  // Load the renderer once per opening; release everything on close.
  useEffect(() => {
    let cancelled = false;
    import('../views/scene3d/renderer.js')
      .then((mod) => {
        if (cancelled || !host.current) return;
        try {
          viewer.current = mod.createViewer(host.current, (s) => setStats(s));
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
  const levels: Record<string, number> = {};
  if (outcome && doc)
    for (const c of doc.components)
      if (c.type === 'component.led') {
        const i = outcome.components[c.id]?.current ?? 0;
        if (i && i > 0) levels[c.id] = Math.min(1, Math.max(0.08, i / 0.02));
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
      data-geometries={stats?.geometries}
      data-textures={stats?.textures}
      data-objects={stats?.objects}
      data-lit={Object.keys(levels).join(' ')}
    >
      <div
        class="view3d-host"
        ref={host}
        role="img"
        aria-label={t('view3d.aria', { name: doc.name })}
        aria-keyshortcuts="ArrowLeft ArrowRight + - Home"
        tabIndex={status === 'ready' ? 0 : -1}
        data-testid="view3d-host"
        onKeyDown={(e) => {
          // The same camera actions as the buttons. Arrows are spatial: not mirrored under RTL.
          const v = viewer.current;
          if (!v) return;
          const act: Record<string, () => void> = {
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
          <div class="view-note" dir={locale.dir}>
            {t('view3d.note')}
          </div>
        </>
      )}
    </div>
  );
}
