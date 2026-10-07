/**
 * The 3D view tab (Sprint 9): a derived 360° visualization of the circuit. It loads the 3D
 * renderer (and three.js) only when opened, re-derives the scene whenever the document changes,
 * and releases every GPU resource when closed. It never edits the project.
 *
 * If WebGL is unavailable (or the renderer cannot load) it shows a localized explanation; the
 * other views are unaffected.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { emptySelection } from '@tbi-lab/domain';
import { deriveScene, sceneObstacles, type SceneDescription } from '../views/scene3d/scene.js';
import { actuators, pick } from '../views/scene3d/pick.js';
import { controlKind, controlState, pressControl, toggleControl } from './controls.js';
import type { Obstacle } from '../views/scene3d/route3d.js';
import type { LiveLevel, Viewer, ViewerStats } from '../views/scene3d/renderer.js';
import { rgbMix } from '../views/ledLooks.js';
import { isSoftwareRenderer } from '../gpuInfo.js';
import { useAppState, useStore, useT } from './context.js';

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

/** A press that moves less than this (px) is a click (selection); more is a camera drag. */
const CLICK_SLOP = 5;
const NO_PRESS: readonly string[] = [];
/** The scene without the controls' positions: equal keys need no rebuild. */
const structuralKey = (s: SceneDescription) =>
  JSON.stringify(s, (k, v: unknown) => (k === 'closed' && typeof v === 'boolean' ? undefined : v));

export function ThreeView() {
  const { doc, locale, sim, selection } = useAppState();
  const store = useStore();
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  /** How long the bundled glTF assets took to fetch and parse (once per page), ms. */
  const [assetMs, setAssetMs] = useState<number | null>(null);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [labels, setLabels] = useState(readLabels);
  // Development diagnostics (hidden): open the app with #diag3d to see the renderer readout.
  const diagnostics = typeof location !== 'undefined' && /(^|[#&])diag3d\b/.test(location.hash);
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
  // A change of a control's state only (a switch flipped) does not rebuild the scene: the
  // actuator moves (setControls, below); anything else rebuilds it.
  const built = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'ready' || !scene || !viewer.current) return;
    const resetCamera = shownProject.current !== doc?.projectId;
    shownProject.current = doc?.projectId ?? null;
    const key = structuralKey(scene);
    if (resetCamera || built.current !== key) {
      built.current = key;
      viewer.current.update(scene, { resetCamera });
    }
    // Evidence and browser tests (opted in, as tbiViewer): the scene the view shows.
    const h = host.current as unknown as {
      tbiViewer?: Viewer;
      tbiScene?: SceneDescription;
      tbiActuators?: ReturnType<typeof actuators>;
    };
    if (h?.tbiViewer) {
      h.tbiScene = scene;
      h.tbiActuators = actuators(scene);
    }
  }, [scene, status]);

  // Physical controls: the ONE state both views show (the document's switch positions, the
  // session's pressed buttons; controls.ts). The 3D actuators move to match.
  const running = sim.status === 'running';
  const pressedNow = running ? sim.pressed : NO_PRESS;
  const closedMap = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const c of doc?.components ?? [])
      if (controlKind(c.type, true) === 'toggle') out[c.id] = controlState(doc!, [], c.id)!.on;
    return out;
  }, [doc]);
  const controlKey = JSON.stringify([closedMap, pressedNow]);
  useEffect(() => {
    if (status === 'ready') viewer.current?.setControls({ closed: closedMap, pressed: pressedNow });
  }, [controlKey, status, scene]);

  // Selection: the project's own (Circuit, Schematic, Inspector, 3D show the same), marked subtly.
  useEffect(() => {
    if (status === 'ready') viewer.current?.setSelection(selection);
  }, [selection, status, scene]);

  // Picking (limited 3D interaction): a click without a drag selects the part or wire under the
  // pointer, or clears the selection on empty bench; a drag is camera navigation. Nothing is
  // edited here: the Inspector edits what is selected, as in the Circuit view.
  const down = useRef<{ x: number; y: number } | null>(null);
  const volumes = useRef<{ scene: SceneDescription; obstacles: Obstacle[] } | null>(null);
  /** What is under a point of the view (with the actuators while a simulation runs). */
  const pickAt = (x: number, y: number, withActuators: boolean) => {
    const v = viewer.current;
    if (!v || !scene || !doc) return null;
    if (volumes.current?.scene !== scene)
      volumes.current = { scene, obstacles: sceneObstacles(doc, scene) };
    return pick(v.rayAt(x, y), scene, volumes.current.obstacles, v.wireShapes(), withActuators);
  };
  // Operating a physical control during a simulation (owner-approved): the lever toggles on
  // press; the button is held exactly while the pointer is down. The press never reaches the
  // camera controls (no orbit from an actuator), and is captured so its release always arrives.
  const held = useRef<{ id: string; pointer: number } | null>(null);
  const keyHeld = useRef<string | null>(null);
  const releaseHeld = () => {
    const h = held.current;
    if (!h) return;
    held.current = null;
    pressControl(store, h.id, false);
    try {
      host.current?.releasePointerCapture(h.pointer);
    } catch {
      /* already released */
    }
  };
  const releaseKey = () => {
    if (keyHeld.current) pressControl(store, keyHeld.current, false);
    keyHeld.current = null;
  };
  const onPointerDownCapture = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || !running || !doc) return;
    const hit = pickAt(e.clientX, e.clientY, true);
    if (hit?.kind !== 'actuator') return;
    e.stopPropagation();
    e.preventDefault();
    down.current = null;
    if (hit.control === 'toggle') {
      toggleControl(store, doc, hit.id);
      return;
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* not capturable (synthetic event) */
    }
    held.current = { id: hit.id, pointer: e.pointerId };
    pressControl(store, hit.id, true);
  };
  // Stopping (or the session ending) while held: nothing stays pressed.
  useEffect(() => {
    if (running) return;
    if (held.current) {
      try {
        host.current?.releasePointerCapture(held.current.pointer);
      } catch {
        /* gone */
      }
      held.current = null;
    }
    keyHeld.current = null;
    if (host.current) host.current.style.cursor = '';
  }, [running]);
  const hasActuators = useMemo(() => (scene ? actuators(scene).length > 0 : false), [scene]);
  const hover = useRef(0);
  const onPointerMove = (e: PointerEvent) => {
    if (!running || !hasActuators || e.buttons || held.current || hover.current) return;
    const { clientX, clientY } = e;
    hover.current = requestAnimationFrame(() => {
      hover.current = 0;
      const hit = pickAt(clientX, clientY, true);
      if (host.current) host.current.style.cursor = hit?.kind === 'actuator' ? 'pointer' : '';
    });
  };
  const onPointerDown = (e: PointerEvent) => {
    down.current = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (held.current && e.pointerId === held.current.pointer) return releaseHeld();
    const d = down.current;
    down.current = null;
    const v = viewer.current;
    if (!d || !v || !scene || !doc || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return;
    // Not running: an actuator is just part of its component (selection, never operation).
    const hit = pickAt(e.clientX, e.clientY, false);
    store.select(
      hit
        ? { ...emptySelection(), [hit.kind === 'component' ? 'components' : 'wires']: [hit.id] }
        : emptySelection(),
    );
  };

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
  // The selected part, when it is a physical control: operable from the keyboard, and named for
  // assistive technology by a synchronized control (the WebGL meshes are not focusable).
  const selectedId =
    selection.components.length === 1 && !selection.wires.length ? selection.components[0]! : null;
  const selectedPart = selectedId ? doc.components.find((c) => c.id === selectedId) : undefined;
  const control =
    selectedPart && controlKind(selectedPart.type, true)
      ? { id: selectedPart.id, ...controlState(doc, pressedNow, selectedPart.id)! }
      : null;
  const controlLabel =
    control &&
    t(`view3d.control.${control.kind}`, {
      id: control.id,
      state: t(
        control.kind === 'toggle'
          ? control.on
            ? 'switch.state.closed'
            : 'switch.state.open'
          : control.on
            ? 'switch.state.pressed'
            : 'switch.state.released',
      ),
    });
  // Parts the visual-only separation could not pull apart within its cap (separation.ts).
  const overlaps = scene?.separation.unresolved.length
    ? [...new Set(scene.separation.unresolved.flat())].sort().join(', ')
    : '';
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
      data-moved={scene?.separation.moved.map((m) => `${m.id}:${m.dx},${m.dz}`).join(' ')}
      data-controls={[
        ...Object.entries(closedMap).map(([id, on]) => `${id}:${on ? 'closed' : 'open'}`),
        ...pressedNow.map((id) => `${id}:pressed`),
      ].join(' ')}
      data-selected={[
        ...selection.components.map((c) => `C:${c}`),
        ...selection.wires.map((w) => `W:${w}`),
      ].join(' ')}
      data-wire-colors={scene?.wires.map((w) => `${w.id}:${w.color}`).join(' ')}
      data-open={scene?.joints
        .filter((j) => j.kind === 'open')
        .map((j) => j.terminals.join('+'))
        .join(' ')}
    >
      <div
        class="view3d-host"
        ref={host}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onPointerCancel={(e) => held.current?.pointer === e.pointerId && releaseHeld()}
        onLostPointerCapture={(e) => held.current?.pointer === e.pointerId && releaseHeld()}
        onKeyUp={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && keyHeld.current) releaseKey();
        }}
        onBlur={releaseKey}
        role="img"
        aria-label={t('view3d.aria', { name: doc.name })}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown + - Home"
        tabIndex={status === 'ready' ? 0 : -1}
        data-testid="view3d-host"
        onKeyDown={(e) => {
          // A selected switch or button: Space/Enter operates it while running (as in the
          // Circuit view; auto-repeat changes nothing).
          if ((e.key === ' ' || e.key === 'Enter') && control) {
            e.preventDefault();
            if (e.repeat || !running || !doc) return;
            if (control.kind === 'toggle') toggleControl(store, doc, control.id);
            else if (!keyHeld.current) {
              keyHeld.current = control.id;
              pressControl(store, control.id, true);
            }
            return;
          }
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
      {control && status === 'ready' && (
        <button
          type="button"
          class="visually-hidden"
          data-testid="view3d-control"
          role={control.kind === 'toggle' ? 'switch' : undefined}
          aria-checked={control.kind === 'toggle' ? control.on : undefined}
          aria-pressed={control.kind === 'momentary' ? control.on : undefined}
          aria-disabled={!running}
          aria-label={running ? controlLabel! : `${controlLabel} ${t('view3d.control.stopped')}`}
          onClick={(e) => {
            if (control.kind === 'toggle' && running) toggleControl(store, doc, control.id);
            e.preventDefault();
          }}
          onKeyDown={(e) => {
            if (control.kind !== 'momentary' || (e.key !== ' ' && e.key !== 'Enter')) return;
            e.preventDefault();
            if (e.repeat || !running || keyHeld.current) return;
            keyHeld.current = control.id;
            pressControl(store, control.id, true);
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') releaseKey();
          }}
          onBlur={releaseKey}
        >
          {controlLabel}
        </button>
      )}
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
          {diagnostics && stats && (
            <dl class="view3d-diag" dir="ltr" data-testid="view3d-diagnostics">
              {(
                [
                  ['view3d.diag.gpu', stats.gpu || '-'],
                  [
                    'view3d.diag.class',
                    t(
                      isSoftwareRenderer(stats.gpu)
                        ? 'view3d.diag.software'
                        : 'view3d.diag.hardware',
                    ),
                  ],
                  ['view3d.diag.tier', stats.quality],
                  ['view3d.diag.dpr', String(stats.pixelRatio)],
                  ['view3d.diag.drawCalls', String(stats.drawCalls)],
                  ['view3d.diag.triangles', String(stats.triangles)],
                  ['view3d.diag.materials', String(stats.materials)],
                  ['view3d.diag.textures', String(stats.textures)],
                  ['view3d.diag.geometries', String(stats.geometries)],
                  [
                    'view3d.diag.gpuMemory',
                    `${((stats.gpuBytes.geometry + stats.gpuBytes.textures) / 1048576).toFixed(1)} MB`,
                  ],
                  ['view3d.diag.frame', `${stats.renderMs} ms`],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt>{t(k)}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <div class="view-note" dir={locale.dir}>
            {t('view3d.note')}
            {running && hasActuators && (
              <div class="view-note-hint" data-testid="view3d-controls-hint">
                {t('view3d.controlsHint')}
              </div>
            )}
            {overlaps && (
              <div class="view-note-warning" role="status" data-testid="view3d-overlap">
                {t('view3d.overlap', { parts: overlaps })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
