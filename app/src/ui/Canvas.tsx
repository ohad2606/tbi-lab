/**
 * The schematic canvas: inline SVG in the DOM (roadmap §7.1), one <g> per component, wires
 * as polylines, a single viewBox camera. The canvas is a technical LTR space under every
 * locale: it is rendered inside dir="ltr" and nothing in it is mirrored.
 *
 * All editing goes through pure domain operations; this component only turns pointer and
 * keyboard input into those operations and renders the resulting document.
 */

import type { MutableRef } from 'preact/hooks';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  CATALOG,
  GRID,
  addComponent,
  addWire,
  deleteSelection,
  emptySelection,
  moveSelection,
  orthogonalRoute,
  rotateComponents,
  rotatePoint,
  snap,
  snapPoint,
  terminalPosition,
  wireRoute,
  type ComponentInstance,
  type ComponentTypeId,
  type Point,
  type ProjectDocument,
  type Selection,
  type WireTarget,
} from '@tbi-lab/domain';
import { catalogText, formatQuantity } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { SYMBOLS } from './symbols.js';

export interface CanvasApi {
  placeAtCenter(type: ComponentTypeId): void;
}

interface Props {
  placing: ComponentTypeId | null;
  onPlacingDone(): void;
  apiRef: MutableRef<CanvasApi | null>;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

type Hit =
  | { kind: 'component'; id: string }
  | { kind: 'terminal'; component: string; terminal: string }
  | { kind: 'wire'; id: string }
  | { kind: 'junction'; id: string }
  | { kind: 'empty' };

type Mode =
  | { kind: 'idle' }
  | { kind: 'press'; client: Point; world: Point }
  | { kind: 'drag'; world: Point; delta: Point }
  | { kind: 'rubber'; start: Point; current: Point; additive: boolean }
  | { kind: 'pan'; client: Point; camera: Camera }
  | {
      kind: 'wiring';
      from: WireTarget;
      fromPos: Point;
      vertices: Point[];
      cursor: Point;
      pressClient: Point | null;
    };

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const DRAG_THRESHOLD_PX = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function hitOf(target: EventTarget | null): Hit {
  const el = (target as Element | null)?.closest?.('[data-hit]') as HTMLElement | SVGElement | null;
  const d = el?.dataset;
  if (!d) return { kind: 'empty' };
  switch (d.hit) {
    case 'component':
      return { kind: 'component', id: d.id! };
    case 'terminal':
      return { kind: 'terminal', component: d.component!, terminal: d.terminal! };
    case 'wire':
      return { kind: 'wire', id: d.id! };
    case 'junction':
      return { kind: 'junction', id: d.id! };
    default:
      return { kind: 'empty' };
  }
}

/** World-space bounding box of a placed component (rotation applied). */
function componentBox(doc: ProjectDocument, c: ComponentInstance) {
  const p = doc.layout.components[c.id]!;
  const [x0, y0, x1, y1] = SYMBOLS[c.type].bbox;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
  ].map((q) => rotatePoint(q, p.rotation));
  const xs = corners.map((q) => q.x + p.x);
  const ys = corners.map((q) => q.y + p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** Nearest grid point on a wire's drawn route to `p`. */
function pointOnRoute(route: Point[], p: Point): Point {
  let best = route[0]!;
  let bestD = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const q =
      a.y === b.y
        ? { x: clamp(snap(p.x), Math.min(a.x, b.x), Math.max(a.x, b.x)), y: a.y }
        : { x: a.x, y: clamp(snap(p.y), Math.min(a.y, b.y), Math.max(a.y, b.y)) };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

const points = (ps: Point[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');

export function Canvas({ placing, onPlacingDone, apiRef }: Props) {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const doc = state.doc!;
  const readOnly = !!state.readOnly;
  const selection = state.selection;

  const svgRef = useRef<SVGSVGElement>(null);
  // 0 until the element is measured; the first fit waits for the real size.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [camera, setCamera] = useState<Camera>({ x: -400, y: -300, scale: 1 });
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [cursor, setCursor] = useState<Point | null>(null);
  const spaceHeld = useRef(false);
  const pointerDown = useRef(false);
  const fitted = useRef<string | null>(null);

  // Keep the camera sized to the element.
  useLayoutEffect(() => {
    const svg = svgRef.current!;
    const update = () => {
      const r = svg.getBoundingClientRect();
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  const toWorld = (clientX: number, clientY: number): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: camera.x + (clientX - r.left) / camera.scale,
      y: camera.y + (clientY - r.top) / camera.scale,
    };
  };

  const contentBounds = () => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of doc.components) {
      const b = componentBox(doc, c);
      xs.push(b.minX, b.maxX);
      ys.push(b.minY, b.maxY);
    }
    for (const w of doc.layout.wires) {
      for (const p of wireRoute(doc, w) ?? []) {
        xs.push(p.x);
        ys.push(p.y);
      }
    }
    return xs.length
      ? {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
        }
      : null;
  };

  const fit = () => {
    const b = contentBounds();
    if (!b) return setCamera({ x: -size.w / 2, y: -size.h / 2, scale: 1 });
    const margin = 80;
    const bw = b.maxX - b.minX + margin * 2;
    const bh = b.maxY - b.minY + margin * 2;
    const scale = clamp(Math.min(size.w / bw, size.h / bh), MIN_SCALE, 1.5);
    setCamera({
      scale,
      x: (b.minX + b.maxX) / 2 - size.w / scale / 2,
      y: (b.minY + b.maxY) / 2 - size.h / scale / 2,
    });
  };

  // Fit once per opened project, after the element has its real size.
  useEffect(() => {
    if (fitted.current !== doc.projectId && size.w > 1) {
      fitted.current = doc.projectId;
      fit();
    }
  }, [doc.projectId, size.w, size.h]);

  const zoomAt = (factor: number, sx = size.w / 2, sy = size.h / 2) => {
    setCamera((c) => {
      const scale = clamp(c.scale * factor, MIN_SCALE, MAX_SCALE);
      const wx = c.x + sx / c.scale;
      const wy = c.y + sy / c.scale;
      return { scale, x: wx - sx / scale, y: wy - sy / scale };
    });
  };

  const focusComponent = (id: string) =>
    requestAnimationFrame(() =>
      (
        svgRef.current?.querySelector(
          `[data-hit="component"][data-id="${id}"]`,
        ) as SVGElement | null
      )?.focus(),
    );

  const place = (type: ComponentTypeId, at: Point) => {
    const r = addComponent(doc, type, at);
    if (r.ok) store.apply(r, { ...emptySelection(), components: [r.id] });
    return r.ok ? r.id : null;
  };

  apiRef.current = {
    placeAtCenter(type) {
      if (readOnly) return;
      const center = snapPoint({
        x: camera.x + size.w / camera.scale / 2,
        y: camera.y + size.h / camera.scale / 2,
      });
      let at = center;
      const taken = (p: Point) =>
        Object.values(doc.layout.components).some((q) => q.x === p.x && q.y === p.y);
      for (let i = 1; taken(at) && i < 50; i++)
        at = { x: center.x + i * GRID * 2, y: center.y + i * GRID * 2 };
      const id = place(type, at);
      if (id) focusComponent(id);
    },
  };

  // Cancel an in-progress interaction if the tool changes underneath it.
  useEffect(() => {
    if (placing) setMode({ kind: 'idle' });
  }, [placing]);

  // ---------------------------------------------------------------------------------------------
  // Pointer input

  const toggleOrSelect = (hit: Hit, additive: boolean) => {
    const key =
      hit.kind === 'component' ? 'components' : hit.kind === 'wire' ? 'wires' : 'junctions';
    const id = (hit as { id: string }).id;
    const already = selection[key].includes(id);
    if (additive) {
      store.select({
        ...selection,
        [key]: already ? selection[key].filter((x) => x !== id) : [...selection[key], id],
      });
    } else if (!already) {
      store.select({ ...emptySelection(), [key]: [id] });
    }
  };

  const finishWire = (m: Extract<Mode, { kind: 'wiring' }>, hit: Hit, world: Point): boolean => {
    let to: WireTarget | null = null;
    if (hit.kind === 'terminal')
      to = { kind: 'terminal', component: hit.component, terminal: hit.terminal };
    else if (hit.kind === 'junction') to = { kind: 'junction', junction: hit.id };
    else if (hit.kind === 'wire') {
      const w = doc.layout.wires.find((x) => x.id === hit.id);
      const route = w && wireRoute(doc, w);
      if (route) to = { kind: 'wire', wire: hit.id, at: pointOnRoute(route, world) };
    }
    if (!to) return false;
    store.apply(addWire(doc, m.from, to, m.vertices), emptySelection());
    setMode({ kind: 'idle' });
    return true;
  };

  const onPointerDown = (e: PointerEvent) => {
    const svg = svgRef.current!;
    const world = toWorld(e.clientX, e.clientY);
    const hit = hitOf(e.target);
    pointerDown.current = true;
    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      svg.setPointerCapture(e.pointerId);
      setMode({ kind: 'pan', client: { x: e.clientX, y: e.clientY }, camera });
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || readOnly) return;
    svg.focus({ preventScroll: true });

    if (placing) {
      place(placing, world);
      onPlacingDone();
      return;
    }
    if (mode.kind === 'wiring') {
      if (!finishWire(mode, hit, world)) {
        setMode({ ...mode, vertices: [...mode.vertices, snapPoint(world)], pressClient: null });
      }
      return;
    }
    if (hit.kind === 'terminal') {
      const fromPos = terminalPosition(doc, hit.component, hit.terminal)!;
      svg.setPointerCapture(e.pointerId);
      setMode({
        kind: 'wiring',
        from: { kind: 'terminal', component: hit.component, terminal: hit.terminal },
        fromPos,
        vertices: [],
        cursor: fromPos,
        pressClient: { x: e.clientX, y: e.clientY },
      });
      return;
    }
    if (hit.kind === 'empty') {
      if (!e.shiftKey) store.select(emptySelection());
      svg.setPointerCapture(e.pointerId);
      setMode({ kind: 'rubber', start: world, current: world, additive: e.shiftKey });
      return;
    }
    toggleOrSelect(hit, e.shiftKey);
    svg.setPointerCapture(e.pointerId);
    setMode({ kind: 'press', client: { x: e.clientX, y: e.clientY }, world });
  };

  const onPointerMove = (e: PointerEvent) => {
    const world = toWorld(e.clientX, e.clientY);
    setCursor(snapPoint(world));
    switch (mode.kind) {
      case 'pan':
        setCamera({
          ...mode.camera,
          x: mode.camera.x - (e.clientX - mode.client.x) / mode.camera.scale,
          y: mode.camera.y - (e.clientY - mode.client.y) / mode.camera.scale,
        });
        break;
      case 'press':
        if (Math.hypot(e.clientX - mode.client.x, e.clientY - mode.client.y) > DRAG_THRESHOLD_PX) {
          setMode({
            kind: 'drag',
            world: mode.world,
            delta: snapPoint({ x: world.x - mode.world.x, y: world.y - mode.world.y }),
          });
        }
        break;
      case 'drag':
        setMode({
          ...mode,
          delta: snapPoint({ x: world.x - mode.world.x, y: world.y - mode.world.y }),
        });
        break;
      case 'rubber':
        setMode({ ...mode, current: world });
        break;
      case 'wiring':
        setMode({ ...mode, cursor: snapPoint(world) });
        break;
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    pointerDown.current = false;
    const world = toWorld(e.clientX, e.clientY);
    switch (mode.kind) {
      case 'pan':
      case 'press':
        setMode({ kind: 'idle' });
        break;
      case 'drag':
        if (mode.delta.x || mode.delta.y) store.apply(moveSelection(doc, selection, mode.delta));
        setMode({ kind: 'idle' });
        break;
      case 'rubber': {
        const x0 = Math.min(mode.start.x, mode.current.x);
        const x1 = Math.max(mode.start.x, mode.current.x);
        const y0 = Math.min(mode.start.y, mode.current.y);
        const y1 = Math.max(mode.start.y, mode.current.y);
        const inside = (p: Point) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        const picked: Selection = {
          components: doc.components
            .map((c) => c.id)
            .filter((id) => inside(doc.layout.components[id]!)),
          junctions: doc.layout.junctions.filter(inside).map((j) => j.id),
          wires: doc.layout.wires
            .filter((w) => (wireRoute(doc, w) ?? []).every(inside))
            .map((w) => w.id),
        };
        const base = mode.additive ? selection : emptySelection();
        const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])];
        store.select({
          components: merge(base.components, picked.components),
          wires: merge(base.wires, picked.wires),
          junctions: merge(base.junctions, picked.junctions),
        });
        setMode({ kind: 'idle' });
        break;
      }
      case 'wiring':
        // Drag-to-wire: releasing over a target after moving completes the wire.
        if (
          mode.pressClient &&
          Math.hypot(e.clientX - mode.pressClient.x, e.clientY - mode.pressClient.y) >
            DRAG_THRESHOLD_PX
        ) {
          const target = document.elementFromPoint(e.clientX, e.clientY);
          if (!finishWire(mode, hitOf(target), world)) setMode({ ...mode, pressClient: null });
        } else if (mode.pressClient) {
          setMode({ ...mode, pressClient: null });
        }
        break;
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = svgRef.current!.getBoundingClientRect();
    zoomAt(Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
  };

  // ---------------------------------------------------------------------------------------------
  // Keyboard input (layout-independent: physical key codes for letter shortcuts)

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      spaceHeld.current = true;
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (placing) onPlacingDone();
      else if (mode.kind !== 'idle') setMode({ kind: 'idle' });
      else store.select(emptySelection());
      return;
    }
    if (e.key === '+' || e.key === '=') return zoomAt(1.25);
    if (e.key === '-') return zoomAt(0.8);
    if (e.code === 'KeyF') return fit();
    const hasSelection =
      selection.components.length + selection.wires.length + selection.junctions.length > 0;
    const arrows: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const dir = arrows[e.key];
    if (dir) {
      e.preventDefault();
      const step = GRID * (e.shiftKey ? 5 : 1);
      if (hasSelection && !readOnly)
        store.apply(moveSelection(doc, selection, { x: dir.x * step, y: dir.y * step }));
      else
        setCamera((c) => ({
          ...c,
          x: c.x + (dir.x * step * 2) / c.scale,
          y: c.y + (dir.y * step * 2) / c.scale,
        }));
      return;
    }
    if (readOnly || !hasSelection) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      store.apply(deleteSelection(doc, selection), emptySelection());
      svgRef.current?.focus();
    } else if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey && selection.components.length) {
      store.apply(rotateComponents(doc, selection.components));
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') spaceHeld.current = false;
  };

  // ---------------------------------------------------------------------------------------------
  // Rendering

  const view =
    mode.kind === 'drag' && (mode.delta.x || mode.delta.y)
      ? (() => {
          const r = moveSelection(doc, selection, mode.delta);
          return r.ok ? r.doc : doc;
        })()
      : doc;

  const selected = useMemo(
    () => ({
      components: new Set(selection.components),
      wires: new Set(selection.wires),
      junctions: new Set(selection.junctions),
    }),
    [selection],
  );

  // Terminals with two or more wire ends get a junction dot, like a junction.
  const endCounts = new Map<string, number>();
  for (const w of view.layout.wires) {
    for (const end of [w.from, w.to]) {
      if (end.kind === 'terminal') {
        const k = `${end.component}\u0000${end.terminal}`;
        endCounts.set(k, (endCounts.get(k) ?? 0) + 1);
      }
    }
  }

  const viewW = Math.max(1, size.w) / camera.scale;
  const viewH = Math.max(1, size.h) / camera.scale;
  const hint = placing
    ? 'canvas.hint.placing'
    : mode.kind === 'wiring'
      ? 'canvas.hint.wiring'
      : 'canvas.hint.idle';

  return (
    <div class="canvas-wrap" dir="ltr">
      <svg
        ref={svgRef}
        class={`canvas mode-${placing ? 'placing' : mode.kind}`}
        data-testid="canvas"
        viewBox={`${camera.x} ${camera.y} ${viewW} ${viewH}`}
        tabIndex={0}
        aria-label={t('canvas.label')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={1.2} class="grid-dot" />
            <circle cx={GRID} cy={0} r={1.2} class="grid-dot" />
            <circle cx={0} cy={GRID} r={1.2} class="grid-dot" />
            <circle cx={GRID} cy={GRID} r={1.2} class="grid-dot" />
          </pattern>
        </defs>
        <rect
          x={camera.x}
          y={camera.y}
          width={viewW}
          height={viewH}
          fill="url(#grid)"
          class="grid"
        />

        <g class="wires">
          {view.layout.wires.map((w) => {
            const route = wireRoute(view, w);
            if (!route) return null;
            return (
              <g
                key={w.id}
                data-hit="wire"
                data-id={w.id}
                class={selected.wires.has(w.id) ? 'wire-group selected' : 'wire-group'}
              >
                <polyline class="wire-hit" points={points(route)} />
                <polyline class="wire" points={points(route)} />
              </g>
            );
          })}
        </g>

        <g class="components">
          {view.components.map((c) => (
            <ComponentView
              key={c.id}
              doc={view}
              component={c}
              selected={selected.components.has(c.id)}
              label={t('canvas.componentLabel', {
                ref: c.id,
                type: catalogText(state.locale, CATALOG[c.type].nameKey),
              })}
              onFocus={() => {
                if (!pointerDown.current && !selected.components.has(c.id)) {
                  store.select({ ...emptySelection(), components: [c.id] });
                }
              }}
            />
          ))}
        </g>

        <g class="terminals">
          {view.components.flatMap((c) =>
            CATALOG[c.type].terminals.map((term) => {
              const p = terminalPosition(view, c.id, term.id)!;
              const ends = endCounts.get(`${c.id}\u0000${term.id}`) ?? 0;
              return (
                <g key={`${c.id}.${term.id}`}>
                  {ends >= 2 && <circle class="junction-dot" cx={p.x} cy={p.y} r={4.5} />}
                  <g
                    class={ends > 0 ? 'terminal connected' : 'terminal'}
                    data-hit="terminal"
                    data-component={c.id}
                    data-terminal={term.id}
                  >
                    <circle class="terminal-hit" cx={p.x} cy={p.y} r={9} />
                    <circle class="terminal-mark" cx={p.x} cy={p.y} r={3.5} />
                  </g>
                </g>
              );
            }),
          )}
        </g>

        <g class="junctions">
          {view.layout.junctions.map((j) => (
            <g
              key={j.id}
              data-hit="junction"
              data-id={j.id}
              class={selected.junctions.has(j.id) ? 'junction selected' : 'junction'}
            >
              <circle class="junction-hit" cx={j.x} cy={j.y} r={8} />
              <circle
                class="junction-dot"
                cx={j.x}
                cy={j.y}
                r={4.5}
                aria-label={t('canvas.junctionLabel', { id: j.id })}
              />
            </g>
          ))}
        </g>

        {mode.kind === 'wiring' && (
          <polyline
            class="wire wire-preview"
            points={points(orthogonalRoute([mode.fromPos, ...mode.vertices, mode.cursor]))}
          />
        )}
        {mode.kind === 'rubber' && (
          <rect
            class="rubber-band"
            x={Math.min(mode.start.x, mode.current.x)}
            y={Math.min(mode.start.y, mode.current.y)}
            width={Math.abs(mode.current.x - mode.start.x)}
            height={Math.abs(mode.current.y - mode.start.y)}
          />
        )}
        {placing && cursor && (
          <g class="ghost" transform={`translate(${cursor.x} ${cursor.y})`}>
            {SYMBOLS[placing].draw()}
          </g>
        )}
      </svg>
      <div class="canvas-controls" role="group">
        <button
          type="button"
          class="icon-button"
          aria-label={t('canvas.zoomIn')}
          title={t('canvas.zoomIn')}
          onClick={() => zoomAt(1.25)}
        >
          +
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label={t('canvas.zoomOut')}
          title={t('canvas.zoomOut')}
          onClick={() => zoomAt(0.8)}
        >
          −
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label={t('canvas.zoomFit')}
          title={t('canvas.zoomFit')}
          onClick={fit}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" class="control-icon">
            <path d="M3 8V3h5M12 3h5v5M17 12v5h-5M8 17H3v-5" />
          </svg>
        </button>
      </div>
      {!readOnly && (
        <div class="canvas-hint" dir={state.locale.dir} data-testid="canvas-hint">
          {t(hint)}
        </div>
      )}
    </div>
  );
}

function ComponentView({
  doc,
  component: c,
  selected,
  label,
  onFocus,
}: {
  doc: ProjectDocument;
  component: ComponentInstance;
  selected: boolean;
  label: string;
  onFocus(): void;
}) {
  const { locale } = useAppState();
  const p = doc.layout.components[c.id]!;
  const box = componentBox(doc, c);
  const cx = (box.minX + box.maxX) / 2;
  const values = valueLabel(c, (q) => formatQuantity(locale, q));
  return (
    <g
      data-hit="component"
      data-id={c.id}
      data-type={c.type}
      data-selected={selected ? 'true' : 'false'}
      class={selected ? 'component selected' : 'component'}
      tabIndex={0}
      role="button"
      aria-label={values ? `${label}, ${values}` : label}
      onFocus={onFocus}
    >
      <rect
        class="focus-ring"
        x={box.minX - 8}
        y={box.minY - 8}
        width={box.maxX - box.minX + 16}
        height={box.maxY - box.minY + 16}
        rx={4}
      />
      <rect
        class="component-hit"
        x={box.minX - 4}
        y={box.minY - 4}
        width={box.maxX - box.minX + 8}
        height={box.maxY - box.minY + 8}
      />
      <g class="symbol" transform={`translate(${p.x} ${p.y}) rotate(${p.rotation})`}>
        {SYMBOLS[c.type].draw()}
      </g>
      {c.type !== 'component.ground' && (
        <text class="ref-label" x={cx} y={box.minY - 8} text-anchor="middle">
          {c.id}
        </text>
      )}
      {values && (
        <text
          class="value-label"
          x={cx}
          y={box.maxY + 20}
          text-anchor="middle"
          data-testid={`value-${c.id}`}
        >
          {values}
        </text>
      )}
    </g>
  );
}

/** Design values shown beside a symbol (never simulation results). */
function valueLabel(
  c: ComponentInstance,
  fmt: (q: { value: number; unit: 'ohm' | 'volt' | 'ampere' }) => string,
): string {
  const q = (k: string) => {
    const v = c.params[k];
    return v && typeof v === 'object' ? fmt(v) : '';
  };
  switch (c.type) {
    case 'component.resistor':
      return q('resistance');
    case 'instrument.lab_psu':
      return `${q('setpointVoltage')} / ${q('currentLimit')}`;
    default:
      return '';
  }
}
