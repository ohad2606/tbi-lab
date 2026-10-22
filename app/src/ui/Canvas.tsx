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
  placementBlock,
  addWire,
  deleteSelection,
  emptySelection,
  moveWireSegment,
  ESP32_DEVKITC_WROOM32,
  boardPinPosition,
  boardTerminalId,
  autoRoute,
  autoRouteVertices,
  contacts,
  endPosition,
  routeObstacles,
  rotatePoint,
  snap,
  snapPoint,
  terminalPosition,
  wireCrossings,
  wireRoute,
  type ComponentInstance,
  type Quantity,
  type ComponentTypeId,
  type Point,
  type ProjectDocument,
  type Rotation,
  type Selection,
  type WireTarget,
} from '@tbi-lab/domain';
import {
  catalogText,
  formatQuantity,
  isMessageKey,
  isolateLtr,
  type LocaleInfo,
  type MessageKey,
} from '../i18n/i18n.js';
import type { ComponentResult } from '@tbi-lab/engine';
import { formatAngle, formatResult } from '../sim/format.js';
import { useAppState, useStore, useT } from './context.js';
import { checksFor } from './checks.js';
import {
  MATRIX_COLS,
  MATRIX_ROWS,
  RGB_CHANNELS,
  SERVO_REST_DEG,
  SYMBOLS,
  lcdView,
  rgbTriangle,
  servoAngle,
  type SymbolState,
} from './symbols.js';
import { bodyOverlaps } from '../geometry/overlap.js';
import { componentBox, componentBoxes, movePreview, moveRouted, rotateRouted } from './routing.js';
import { RGB_LOOKS, ledLook } from '../views/ledLooks.js';
import { resolveWireColors } from '../views/wireColors.js';
import { pressControl, toggleControl } from './controls.js';
import type { GpioLevel } from '../runtime/view.js';
import { warningsFor } from '../sim/ratings.js';
import { probeAnchor, probeTargetName, readProbe, type Probe, type ProbeInput } from './probes.js';

export interface CanvasApi {
  placeAtCenter(type: ComponentTypeId): void;
}

interface Props {
  placing: ComponentTypeId | null;
  onPlacingDone(): void;
  apiRef: MutableRef<CanvasApi | null>;
  /** Probe tool active: clicks pin observational readouts instead of editing. */
  probeMode: boolean;
  onProbeModeChange(on: boolean): void;
  probes: Probe[];
  onProbe(input: ProbeInput): void;
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
  | { kind: 'actuator'; id: string }
  | { kind: 'empty' };

type Mode =
  | { kind: 'idle' }
  | { kind: 'press'; client: Point; world: Point; wire?: string }
  | { kind: 'drag'; world: Point; delta: Point }
  /** Dragging one straight segment of a single selected wire (Sprint 5). */
  | { kind: 'segment'; wire: string; segment: number; world: Point; delta: Point }
  | { kind: 'rubber'; start: Point; current: Point; additive: boolean }
  | { kind: 'pan'; client: Point; camera: Camera }
  | {
      kind: 'wiring';
      from: WireTarget;
      fromPos: Point;
      vertices: Point[];
      cursor: Point;
      pressClient: Point | null;
    }
  /** A push button held with the pointer (transient runtime input). */
  | { kind: 'button'; id: string };

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
    case 'actuator':
      return { kind: 'actuator', id: d.id! };
    default:
      return { kind: 'empty' };
  }
}

/** Nearest grid point on a wire's drawn route to `p`. */
/**
 * Radius of a wire bridge in schematic units: at least ~5 screen pixels at any zoom, and always
 * between 6 and 9 units, i.e. under half the 20-unit grid pitch, so two hops on one segment or a
 * hop and a parallel wire can never touch.
 */
export function hopRadius(scale: number): number {
  return Math.min(9, Math.max(6, 5 / scale));
}

/**
 * The drawn path of a wire: its orthogonal route, with a semicircular hop in a vertical segment
 * wherever it crosses another wire unconnected. The hop bulges toward +x, whichever way the
 * segment runs.
 */
function wirePath(route: Point[], hops: Point[] | undefined, r: number): string {
  let d = `M${route[0]!.x} ${route[0]!.y}`;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    if (hops && a.x === b.x) {
      const down = b.y > a.y;
      const here = hops
        .filter((h) => h.x === a.x && h.y > Math.min(a.y, b.y) && h.y < Math.max(a.y, b.y))
        .sort((p, q) => (down ? p.y - q.y : q.y - p.y));
      for (const h of here) {
        const y1 = down ? h.y - r : h.y + r;
        const y2 = down ? h.y + r : h.y - r;
        d += ` L${a.x} ${y1} A${r} ${r} 0 0 ${down ? 1 : 0} ${a.x} ${y2}`;
      }
    }
    d += ` L${b.x} ${b.y}`;
  }
  return d;
}

/** Just the hop arc at a crossing (drawn again on top, over a casing). */
function hopArc(c: Point, r: number): string {
  return `M${c.x} ${c.y - r} A${r} ${r} 0 0 1 ${c.x} ${c.y + r}`;
}

/** Index of the route segment nearest to `p`. */
function nearestSegment(route: Point[], p: Point): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const q = {
      x: clamp(p.x, Math.min(a.x, b.x), Math.max(a.x, b.x)),
      y: clamp(p.y, Math.min(a.y, b.y), Math.max(a.y, b.y)),
    };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

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

export function Canvas({
  placing,
  onPlacingDone,
  apiRef,
  probeMode,
  onProbeModeChange,
  probes,
  onProbe,
}: Props) {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const doc = state.doc!;
  const readOnly = !!state.readOnly;
  const simActive = state.sim.status === 'running' || state.sim.status === 'starting';
  const simRunning = state.sim.status === 'running';
  const pressed = new Set(state.sim.status === 'running' ? state.sim.pressed : []);
  const outcome = state.sim.status === 'running' ? state.sim.outcome : null;
  const selection = state.selection;

  const svgRef = useRef<SVGSVGElement>(null);
  // 0 until the element is measured; the first fit waits for the real size.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [camera, setCamera] = useState<Camera>({ x: -400, y: -300, scale: 1 });
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [cursor, setCursor] = useState<Point | null>(null);
  // Sprint 13 OS-10: the placement preview says whether a click here would be accepted (the
  // OS-04 overlap rule the edit applies); evaluated once per grid point, not per pointer event.
  const ghostValid = useMemo(() => {
    if (!placing || !cursor || !doc) return true;
    const r = addComponent(doc, placing, cursor);
    return r.ok && bodyOverlaps(r.doc, new Set([r.id])).length === 0;
  }, [doc, placing, cursor?.x, cursor?.y]);
  const spaceHeld = useRef(false);
  const heldByKey = useRef<string | null>(null);
  const pointerDown = useRef(false);
  const fitted = useRef<string | null>(null);
  // Obstacles for routing a NEW wire: existing wire segments, terminals and junctions, and the
  // component bodies. The preview and the committed wire use the same route.
  const routeObs = useMemo(() => routeObstacles(doc, componentBoxes(doc)), [doc]);

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
    // Room for labels, which sit outside the parts' boxes (upright parts label to the side).
    const marginX = 150;
    const marginY = 90;
    const bw = b.maxX - b.minX + marginX * 2;
    const bh = b.maxY - b.minY + marginY * 2;
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
    // The palette offers only what this project's board runtime can simulate (Sprint 10); an
    // armed placement never bypasses that after the project changed.
    if (placementBlock(doc, type)) return null;
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
      // Sprint 13 OS-04: the nearest place to the centre where the new part overlaps nothing
      // (the same rule the edit gate applies), searched ring by ring in a fixed order.
      const free = (p: Point) => {
        const r = addComponent(doc, type, p);
        return r.ok && bodyOverlaps(r.doc, new Set([r.id])).length === 0;
      };
      let at = center;
      search: for (let ring = 1; !free(at) && ring <= 24; ring++)
        for (let dy = -ring; dy <= ring; dy++)
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const p = { x: center.x + dx * GRID * 2, y: center.y + dy * GRID * 2 };
            if (free(p)) {
              at = p;
              break search;
            }
          }
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
    const end = to.kind === 'wire' ? to.at : endPosition(doc, to);
    if (!end) return false;
    // Wire routing integrity: the new wire is AUTOMATIC. The points the user clicked are its
    // waypoints (kept as constraints); the router's corners are its current route, recomputed
    // canonically after every layout change (store `routeLayout`).
    const vertices = autoRouteVertices([m.fromPos, ...m.vertices, end], routeObs);
    store.apply(addWire(doc, m.from, to, vertices, { waypoints: m.vertices }), emptySelection());
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

    if (probeMode) {
      // Observation only: a probe never edits the project or the circuit.
      if (hit.kind === 'terminal')
        onProbe({ kind: 'terminal', component: hit.component, terminal: hit.terminal });
      else if (hit.kind === 'component' || hit.kind === 'actuator')
        onProbe({ kind: 'current', component: hit.id });
      else if (hit.kind === 'wire') {
        const w = doc.layout.wires.find((x) => x.id === hit.id);
        const end = w && [w.from, w.to].find((x) => x.kind === 'terminal');
        const net =
          end?.kind === 'terminal'
            ? doc.connections.find(
                (c) => c.component === end.component && c.terminal === end.terminal,
              )?.net
            : undefined;
        const route = w && wireRoute(doc, w);
        if (net && route) onProbe({ kind: 'net', net, at: pointOnRoute(route, world) });
      }
      return;
    }
    if (hit.kind === 'actuator') {
      const c = doc.components.find((x) => x.id === hit.id);
      const toggle = c && CATALOG[c.type].toggleParam;
      if (c && toggle) {
        // PERSISTENT edit (controls.ts, the action the 3D view uses too): the browser document
        // first (revision, autosave, undo); while running it is mirrored to the session.
        toggleControl(store, doc, c.id, { select: true });
        return;
      }
      if (c?.type === 'component.push_button' && simRunning) {
        // TRANSIENT runtime input: held while the pointer is down, never persisted.
        svg.setPointerCapture(e.pointerId);
        pressControl(store, c.id, true);
        setMode({ kind: 'button', id: c.id });
        return;
      }
      toggleOrSelect({ kind: 'component', id: hit.id }, e.shiftKey);
      return;
    }
    if (placing && simActive) {
      onPlacingDone(); // the palette is disabled while running; nothing is placed
      return;
    }
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
    if (hit.kind === 'terminal' && simActive) {
      // While running, wiring is structural and not allowed: a terminal selects its part.
      toggleOrSelect({ kind: 'component', id: hit.component }, e.shiftKey);
      return;
    }
    if (hit.kind === 'terminal' && !simActive) {
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
    setMode({
      kind: 'press',
      client: { x: e.clientX, y: e.clientY },
      world,
      ...(hit.kind === 'wire' && !e.shiftKey ? { wire: hit.id } : {}),
    });
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
          // A press on a wire that is the only thing selected drags that wire's segment;
          // anything else moves the selection as before.
          const route = mode.wire
            ? wireRoute(
                doc,
                doc.layout.wires.find((w) => w.id === mode.wire)!,
              )
            : undefined;
          const onlyThisWire =
            !!mode.wire &&
            selection.components.length === 0 &&
            selection.junctions.length === 0 &&
            selection.wires.length === 1 &&
            selection.wires[0] === mode.wire;
          if (route && onlyThisWire) {
            setMode({
              kind: 'segment',
              wire: mode.wire!,
              segment: nearestSegment(route, mode.world),
              world: mode.world,
              delta: snapPoint({ x: world.x - mode.world.x, y: world.y - mode.world.y }),
            });
            break;
          }
          setMode({
            kind: 'drag',
            world: mode.world,
            delta: snapPoint({ x: world.x - mode.world.x, y: world.y - mode.world.y }),
          });
        }
        break;
      case 'drag':
      case 'segment':
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

  /** Release a held push button on every way a press can end (up, cancel, capture lost). */
  const releaseButton = () => {
    if (mode.kind !== 'button') return;
    pressControl(store, mode.id, false);
    setMode({ kind: 'idle' });
  };

  const onPointerUp = (e: PointerEvent) => {
    pointerDown.current = false;
    const world = toWorld(e.clientX, e.clientY);
    switch (mode.kind) {
      case 'button':
        releaseButton();
        break;
      case 'pan':
      case 'press':
        setMode({ kind: 'idle' });
        break;
      case 'drag':
        if (mode.delta.x || mode.delta.y) store.apply(moveRouted(doc, selection, mode.delta));
        setMode({ kind: 'idle' });
        break;
      case 'segment':
        if (mode.delta.x || mode.delta.y) {
          const r = moveWireSegment(doc, mode.wire, mode.segment, mode.delta);
          // A drag along the segment's own axis changes nothing: no edit, no revision.
          if (r.ok && JSON.stringify(r.doc.layout.wires) !== JSON.stringify(doc.layout.wires)) {
            store.apply(r, selection);
          }
        }
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

  /** The switch component that has keyboard focus, if any. */
  const focusedSwitch = (e: KeyboardEvent) => {
    const el = (e.target as Element | null)?.closest?.(
      '[data-hit="component"]',
    ) as SVGElement | null;
    const c = el ? doc.components.find((x) => x.id === el.dataset.id) : undefined;
    return c && (c.type === 'component.push_button' || CATALOG[c.type].toggleParam) ? c : undefined;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      const sw = focusedSwitch(e);
      const toggle = sw && CATALOG[sw.type].toggleParam;
      if (sw && toggle && !readOnly) {
        if (!e.repeat) toggleControl(store, doc, sw.id);
        return;
      }
      if (sw?.type === 'component.push_button') {
        // Momentary: held exactly while the key is down; auto-repeat changes nothing.
        if (!e.repeat && simRunning) {
          heldByKey.current = sw.id;
          pressControl(store, sw.id, true);
        }
        return;
      }
      spaceHeld.current = true;
      return;
    }
    if (e.key === 'Escape') {
      if (probeMode) onProbeModeChange(false);
      else if (placing) onPlacingDone();
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
        store.apply(moveRouted(doc, selection, { x: dir.x * step, y: dir.y * step }));
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
      store.apply(rotateRouted(doc, selection.components));
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== ' ') return;
    spaceHeld.current = false;
    if (heldByKey.current) {
      pressControl(store, heldByKey.current, false);
      heldByKey.current = null;
    }
  };

  // A button can never stay stuck: losing focus, or the simulation stopping, releases it.
  const releaseKeyHeld = () => {
    if (heldByKey.current) {
      pressControl(store, heldByKey.current, false);
      heldByKey.current = null;
    }
  };
  useEffect(() => {
    if (!simRunning) {
      heldByKey.current = null;
      if (mode.kind === 'button') setMode({ kind: 'idle' });
    }
  }, [simRunning]);

  // ---------------------------------------------------------------------------------------------
  // Rendering

  // Wire routing integrity: the drag preview is bounded (movePreview: the moved parts' automatic
  // wires by the short shapes only) and recomputed only when the snapped offset changes; the drop
  // commits the canonical routing.
  const dragDx = mode.kind === 'drag' ? mode.delta.x : 0;
  const dragDy = mode.kind === 'drag' ? mode.delta.y : 0;
  const dragView = useMemo(() => {
    if (!dragDx && !dragDy) return null;
    const r = movePreview(doc, selection, { x: dragDx, y: dragDy });
    return r.ok ? r.doc : doc;
  }, [doc, selection, dragDx, dragDy]);
  const view =
    mode.kind === 'drag' && dragView
      ? dragView
      : mode.kind === 'segment' && (mode.delta.x || mode.delta.y)
        ? (() => {
            const r = moveWireSegment(doc, mode.wire, mode.segment, mode.delta);
            return r.ok ? r.doc : doc;
          })()
        : doc;

  // Unconnected crossings of the drawing being shown (including a live drag preview).
  const crossings = useMemo(() => wireCrossings(view), [view]);
  // The same resolved colours as the 3D view (wireColors.ts).
  const wireColors = useMemo(() => resolveWireColors(view), [view]);
  const hopR = hopRadius(camera.scale);
  const hopsOver = useMemo(() => {
    const m = new Map<string, Point[]>();
    for (const c of crossings) m.set(c.over, [...(m.get(c.over) ?? []), c]);
    return m;
  }, [crossings]);

  const selected = useMemo(
    () => ({
      components: new Set(selection.components),
      wires: new Set(selection.wires),
      junctions: new Set(selection.junctions),
    }),
    [selection],
  );

  // Terminals with two or more wire ends get a junction dot, like a junction; so does a direct
  // terminal-to-terminal contact (a real connection, drawn as one).
  const contactAt = new Map<string, string>();
  for (const w of contacts(view))
    for (const end of [w.from, w.to])
      if (end.kind === 'terminal') contactAt.set(`${end.component}\u0000${end.terminal}`, w.id);
  const endCounts = new Map<string, number>();
  for (const w of view.layout.wires) {
    for (const end of [w.from, w.to]) {
      if (end.kind === 'terminal') {
        const k = `${end.component}\u0000${end.terminal}`;
        endCounts.set(k, (endCounts.get(k) ?? 0) + 1);
      }
    }
  }

  // Canvas values are deliberately sparse (dense-result UX): supplies always, other parts
  // only when selected or probed. Details live in the inspector and on probes.
  const probedParts = new Set(
    probes.filter((p) => p.kind === 'current').map((p) => (p as { component: string }).component),
  );
  const overstressed = new Set(
    outcome?.ok
      ? warningsFor(doc, outcome)
          .filter((w) => w.kind === 'absolute')
          .map((w) => w.component)
      : [],
  );
  const issues = simActive ? [] : checksFor(doc);
  const markers = issues.flatMap((i) =>
    i.code === 'terminals_touching'
      ? [{ code: i.code, component: i.components[0]!, terminal: i.terminals![0]! }]
      : i.code === 'partially_wired' || i.code === 'wire_over_terminal'
        ? (i.terminals ?? []).map((term) => ({
            code: i.code,
            component: i.components[0]!,
            terminal: term,
          }))
        : [],
  );
  const viewW = Math.max(1, size.w) / camera.scale;
  const viewH = Math.max(1, size.h) / camera.scale;
  const hint = probeMode
    ? 'canvas.hint.probe'
    : simActive
      ? 'canvas.hint.running'
      : placing
        ? 'canvas.hint.placing'
        : mode.kind === 'wiring'
          ? 'canvas.hint.wiring'
          : selection.wires.length === 1 &&
              selection.components.length === 0 &&
              selection.junctions.length === 0
            ? 'canvas.hint.wire'
            : 'canvas.hint.idle';

  return (
    <div class={simActive ? 'canvas-wrap running' : 'canvas-wrap'} dir="ltr">
      <svg
        ref={svgRef}
        class={`canvas mode-${probeMode ? 'probe' : placing ? 'placing' : mode.kind}`}
        data-testid="canvas"
        viewBox={`${camera.x} ${camera.y} ${viewW} ${viewH}`}
        tabIndex={0}
        aria-label={t('canvas.label')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={releaseButton}
        onLostPointerCapture={releaseButton}
        // focusout bubbles from the focused part (blur would not): any focus loss releases.
        onFocusOut={releaseKeyHeld}
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
                data-color={wireColors.get(w.id)?.color ?? 'neutral'}
                data-color-source={wireColors.get(w.id)?.source}
                class={selected.wires.has(w.id) ? 'wire-group selected' : 'wire-group'}
                style={{ '--wire-color': wireColors.get(w.id)?.hex }}
              >
                <polyline class="wire-hit" points={points(route)} />
                <path class="wire" d={wirePath(route, hopsOver.get(w.id), hopR)} />
              </g>
            );
          })}
        </g>

        {/* Bridges (line hops) at unconnected crossings: visual only, never topology. The
            arc is redrawn over a canvas-coloured casing so it reads as passing OVER the
            other wire. Junction dots, not bridges, mark real connections. */}
        <g class="wire-bridges">
          {crossings.map((c) => (
            <g
              key={`${c.over}.${c.under}.${c.x}.${c.y}`}
              class={selected.wires.has(c.over) ? 'wire-bridge selected' : 'wire-bridge'}
              style={{ '--wire-color': wireColors.get(c.over)?.hex }}
              data-testid="wire-bridge"
              data-over={c.over}
              data-under={c.under}
              data-x={c.x}
              data-y={c.y}
            >
              <path class="wire-bridge-casing" d={hopArc(c, hopR)} />
              <path class="wire" d={hopArc(c, hopR)} />
            </g>
          ))}
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
              result={outcome?.ok ? outcome.components[c.id] : undefined}
              showRuntime={
                c.type === 'instrument.lab_psu' ||
                selected.components.has(c.id) ||
                probedParts.has(c.id)
              }
              symbolState={{
                closed: c.params.closed === true,
                motion: c.params.motion === true,
                // Solved module state (Sprint 10): presentation only.
                outputHigh: outcome?.ok
                  ? outcome.components[c.id]?.state?.output === 'high'
                  : false,
                pressed: pressed.has(c.id),
                // Solved part states (Sprint 10): presentation of the result, never an input.
                energized: outcome?.ok
                  ? outcome.components[c.id]?.state?.energized === true
                  : false,
                sounding: outcome?.ok ? outcome.components[c.id]?.state?.sounding === true : false,
                // Sprint 12: the LCD shows exactly what the engine reports (blank without it).
                lcd:
                  c.type === 'display.lcd1602_i2c' && outcome?.ok
                    ? lcdView(outcome.components[c.id]?.state)
                    : undefined,
                // Sprint 19B: a logic gate's solved output level (X marked on the symbol).
                gateOutput:
                  c.type.startsWith('logic.') && outcome?.ok
                    ? (outcome.components[c.id]?.state?.gateOutput as string | undefined)
                    : undefined,
                // Sprint 15: the servo's horn at the angle the engine or the runtime reports.
                servoAngle:
                  c.type === 'component.servo_sg90' && outcome?.ok
                    ? servoAngle(outcome.components[c.id]?.state)
                    : undefined,
              }}
              overstressed={overstressed.has(c.id)}
              pinLevels={
                'runtime' in state.sim && state.sim.runtime?.board === c.id
                  ? state.sim.runtime.gpio
                  : undefined
              }
            />
          ))}
        </g>

        <g class="terminals">
          {view.components.flatMap((c) =>
            CATALOG[c.type].terminals.map((term) => {
              const p = terminalPosition(view, c.id, term.id)!;
              const ends = endCounts.get(`${c.id}\u0000${term.id}`) ?? 0;
              const contact = contactAt.get(`${c.id}\u0000${term.id}`);
              return (
                <g key={`${c.id}.${term.id}`}>
                  {(ends >= 2 || contact) && (
                    <circle
                      class={contact ? 'junction-dot contact-dot' : 'junction-dot'}
                      data-testid={contact ? `contact-${c.id}.${term.id}` : undefined}
                      data-contact={contact}
                      cx={p.x}
                      cy={p.y}
                      r={4.5}
                    />
                  )}
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

        <g class="check-markers">
          {markers.map((m) => {
            const p = terminalPosition(view, m.component, m.terminal);
            if (!p) return null;
            return (
              <circle
                key={`${m.code}.${m.component}.${m.terminal}`}
                class={`check-marker check-${m.code}`}
                data-testid={`check-marker-${m.component}.${m.terminal}`}
                data-code={m.code}
                cx={p.x}
                cy={p.y}
                r={11}
              />
            );
          })}
        </g>

        <g class="probes">
          {probes.map((p) => {
            const at = probeAnchor(p, view);
            if (!at) return null;
            const reading = readProbe(p, view, outcome?.ok ? outcome : null);
            const value =
              reading.value === null
                ? t('probe.noValue')
                : formatResult(state.locale, reading.value, reading.quantity);
            const label = t(p.kind === 'current' ? 'probe.currentLabel' : 'probe.voltageLabel', {
              point: probeTargetName(p),
              value,
            });
            return (
              <g
                key={p.id}
                class={`probe probe-${p.kind}`}
                data-testid={`probe-${probeTargetName(p)}`}
              >
                <path class="probe-pin" d={`M${at.x} ${at.y} l8 -14 h4 l-8 14 z`} />
                {/* A current probe sits on the part's centre: its label goes above the part's
                    reference label, or, for an upright part (whose labels are on its right),
                    to its left. A voltage label sits up and to the left of its pin. */}
                <text class="probe-label" {...probeLabelAt(p, at, view)}>
                  {label}
                </text>
              </g>
            );
          })}
        </g>

        {mode.kind === 'wiring' && (
          <polyline
            class="wire wire-preview"
            points={points(autoRoute([mode.fromPos, ...mode.vertices, mode.cursor], routeObs))}
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
          <g
            class={ghostValid ? 'ghost' : 'ghost ghost-invalid'}
            data-testid="placement-ghost"
            data-valid={ghostValid ? 'true' : 'false'}
            transform={`translate(${cursor.x} ${cursor.y})`}
          >
            {SYMBOLS[placing].draw()}
          </g>
        )}
      </svg>
      <div class="canvas-controls" role="group">
        <button
          type="button"
          class={probeMode ? 'icon-button active' : 'icon-button'}
          data-testid="canvas-probe"
          aria-pressed={probeMode}
          aria-label={t('probe.tool')}
          title={t('probe.tool')}
          onClick={() => onProbeModeChange(!probeMode)}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" class="control-icon">
            <path d="M3 17 L9 11 M9 11 l6 -8 l2 2 l-8 6 z" />
          </svg>
        </button>
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
  result,
  showRuntime,
  symbolState,
  overstressed,
  pinLevels,
}: {
  doc: ProjectDocument;
  component: ComponentInstance;
  selected: boolean;
  label: string;
  onFocus(): void;
  /** Solved values while a simulation runs; runtime state, never part of the document. */
  result: ComponentResult | undefined;
  showRuntime: boolean;
  symbolState: SymbolState;
  /** Solved operating point beyond the part's datasheet absolute maximum (warning only). */
  overstressed: boolean;
  /** ESP32 board only, while a session runs: live pad levels (ephemeral runtime view). */
  pinLevels?: Record<number, GpioLevel>;
}) {
  const { locale } = useAppState();
  const t = useT();
  const runtime = result && showRuntime ? runtimeLabel(result, locale, t) : '';
  const def = SYMBOLS[c.type];
  const switchState =
    c.type === 'component.toggle_switch'
      ? t(symbolState.closed ? 'switch.state.closed' : 'switch.state.open')
      : c.type === 'component.push_button'
        ? t(symbolState.pressed ? 'switch.state.pressed' : 'switch.state.released')
        : '';
  const p = doc.layout.components[c.id]!;
  const box = componentBox(doc, c);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const values = valueLabel(c, (q) => formatQuantity(locale, q));
  // A two-terminal part turned upright has its wires above and below it: its labels go beside
  // the body instead of across those wires (Sprint 5 result-density polish).
  const upright =
    (p.rotation === 90 || p.rotation === 270) &&
    CATALOG[c.type].terminals.length === 2 &&
    c.type !== 'component.ground';
  const side = upright ? { x: box.maxX + 10, anchor: 'start' } : { x: cx, anchor: 'middle' };
  const below = values || switchState;
  // A character display's content, for assistive technology: verbatim, as an LTR run.
  const screen =
    c.type === 'display.lcd1602_i2c' && symbolState.lcd
      ? symbolState.lcd.displayOn && symbolState.lcd.lines.some((l) => l.trim())
        ? t('lcd.screen', {
            line1: isolateLtr(symbolState.lcd.lines[0].trimEnd()),
            line2: isolateLtr(symbolState.lcd.lines[1].trimEnd()),
          })
        : t('lcd.blank')
      : '';
  return (
    <g
      data-hit="component"
      data-id={c.id}
      data-type={c.type}
      data-selected={selected ? 'true' : 'false'}
      class={`component${selected ? ' selected' : ''}${overstressed ? ' overstressed' : ''}`}
      data-overstressed={overstressed ? 'true' : undefined}
      tabIndex={0}
      role="button"
      aria-label={[label, values, switchState, screen].filter(Boolean).join(', ')}
      data-closed={c.type === 'component.toggle_switch' ? String(symbolState.closed) : undefined}
      data-pressed={c.type === 'component.push_button' ? String(symbolState.pressed) : undefined}
      data-energized={c.type === 'component.relay' ? String(!!symbolState.energized) : undefined}
      data-motion={c.type === 'sensor.pir_hc_sr501' ? String(!!symbolState.motion) : undefined}
      data-output={
        c.type === 'sensor.pir_hc_sr501' || c.type === 'sensor.hc_sr04'
          ? symbolState.outputHigh
            ? 'high'
            : 'low'
          : undefined
      }
      data-backlight={
        c.type === 'display.lcd1602_i2c' ? String(!!symbolState.lcd?.backlight) : undefined
      }
      data-sounding={c.type === 'component.buzzer' ? String(!!symbolState.sounding) : undefined}
      data-angle={
        c.type === 'component.servo_sg90'
          ? String(symbolState.servoAngle ?? SERVO_REST_DEG)
          : undefined
      }
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
        {/* Components sit ON TOP of wires: an opaque knock-out behind the line-art symbol, so a
            wire routed across a part is drawn passing behind it rather than through it. */}
        <rect
          class="symbol-knockout"
          x={def.bbox[0]}
          y={def.bbox[1]}
          width={def.bbox[2] - def.bbox[0]}
          height={def.bbox[3] - def.bbox[1]}
        />
        {def.draw(symbolState)}
        {def.actuator && (
          <rect
            class="actuator"
            data-hit="actuator"
            data-id={c.id}
            data-testid={`actuator-${c.id}`}
            x={def.actuator[0]}
            y={def.actuator[1]}
            width={def.actuator[2] - def.actuator[0]}
            height={def.actuator[3] - def.actuator[1]}
          />
        )}
        {c.type === 'component.led' && result && result.current !== null && result.current > 0 && (
          // Visual cue only: opacity follows the solved forward current (full at 20 mA). It is
          // not a photometric model and feeds nothing back into the simulation.
          <polygon
            class="led-glow"
            points="-12,-12 -12,12 12,0"
            style={{
              fill: ledLook(c.params.model).color,
              fillOpacity: Math.min(1, Math.max(0.08, (result.current ?? 0) / 0.02)),
            }}
          />
        )}
        {c.type === 'component.rgb_led' &&
          result?.currents &&
          // Each channel's emitter glows by ITS solved current, in its datasheet colour: the mix
          // the eye sees is whatever the circuit drives, never a selected colour.
          RGB_CHANNELS.map(({ id, y }) => {
            const i = result.currents?.[id] ?? 0;
            return i !== null && i > 1e-6 ? (
              <polygon
                key={id}
                class="led-glow rgb-glow"
                data-channel={id}
                points={rgbTriangle(y)}
                style={{
                  fill: RGB_LOOKS[id],
                  fillOpacity: Math.min(1, Math.max(0.08, i / 0.02)),
                }}
              />
            ) : null;
          })}
        {c.type === 'display.led_matrix_8x8' &&
          result?.array &&
          // Each dot glows by ITS solved forward current (full at 20 mA): what the circuit drives.
          result.array.currents.map((i, k) =>
            i > 1e-6 ? (
              <circle
                key={k}
                class="led-glow matrix-glow"
                data-dot={`${Math.floor(k / result.array!.cols) + 1}.${(k % result.array!.cols) + 1}`}
                cx={MATRIX_COLS[k % result.array!.cols]}
                cy={MATRIX_ROWS[Math.floor(k / result.array!.cols)]}
                r={6}
                style={{ fillOpacity: Math.min(1, Math.max(0.15, i / 0.02)) }}
              />
            ) : null,
          )}
      </g>
      {c.type === 'board.esp32_devkitc_wroom32' && (
        <BoardPins rotation={p.rotation} at={p} levels={pinLevels} />
      )}
      {c.type === 'display.led_matrix_8x8' && (
        <LinePins type={c.type} rotation={p.rotation} at={p} inward={matrixInward} />
      )}
      {SIDE_PIN_TYPES.has(c.type) && (
        <LinePins type={c.type} rotation={p.rotation} at={p} inward={sideInward} />
      )}
      {c.type !== 'component.ground' && (
        <text
          class="ref-label"
          x={side.x}
          y={upright ? cy - 6 : box.minY - 8}
          text-anchor={side.anchor}
        >
          {c.id}
        </text>
      )}
      {values && (
        <text
          class="value-label"
          x={side.x}
          y={upright ? cy + 14 : box.maxY + 20}
          text-anchor={side.anchor}
          data-testid={`value-${c.id}`}
        >
          {values}
        </text>
      )}
      {switchState && (
        <text
          class="switch-state"
          x={side.x}
          y={upright ? cy + 14 : box.maxY + 18}
          text-anchor={side.anchor}
        >
          {switchState}
        </text>
      )}
      {runtime && (
        <text
          class="runtime-label"
          x={side.x}
          y={upright ? cy + (below ? 34 : 14) : box.maxY + (values ? 42 : switchState ? 36 : 22)}
          text-anchor={side.anchor}
          data-testid={`result-${c.id}`}
        >
          {runtime}
        </text>
      )}
    </g>
  );
}

/** Solved values shown on the canvas while running. Styled apart from design values. */
function runtimeLabel(
  r: ComponentResult,
  locale: LocaleInfo,
  t: (key: MessageKey) => string,
): string {
  const i =
    r.current === null ? t('sim.results.undefined') : formatResult(locale, r.current, 'ampere');
  const v =
    r.voltage === null ? t('sim.results.undefined') : formatResult(locale, r.voltage, 'volt');
  switch (r.type) {
    case 'component.resistor':
    case 'component.push_button':
    case 'component.toggle_switch':
      return i;
    case 'component.led':
    case 'component.diode':
      return `${v} · ${i}`;
    case 'instrument.lab_psu':
      return `${v} · ${i} · ${t(`sim.badge.${r.mode ?? 'off'}`)}`;
    case 'component.servo_sg90': {
      // Its position, not its supply current (not modelled, never shown as 0 A).
      const angle = servoAngle(r.state);
      return angle === undefined ? '' : formatAngle(locale, angle);
    }
    default: {
      // Sprint 10 parts: their named currents ("R 12.1 mA · G 0 A · B 3.2 mA"), else V · I.
      if (r.currents) {
        return Object.entries(r.currents)
          .map(([k, val]) => {
            const short = `sim.part.short.${k}`;
            const label = isMessageKey(short) ? t(short) : t(`sim.part.current.${k}` as MessageKey);
            return `${label} ${val === null ? t('sim.results.undefined') : formatResult(locale, val, 'ampere')}`;
          })
          .join(' · ');
      }
      return r.voltage !== null || r.current !== null ? `${v} · ${i}` : '';
    }
  }
}

/** Design values shown beside a symbol (never simulation results). */
function valueLabel(c: ComponentInstance, fmt: (q: Quantity) => string): string {
  const q = (k: string) => {
    const v = c.params[k];
    return v && typeof v === 'object' ? fmt(v) : '';
  };
  switch (c.type) {
    case 'component.resistor':
      return q('resistance');
    case 'component.capacitor':
      return q('capacitance');
    case 'instrument.lab_psu':
      return `${q('setpointVoltage')} / ${q('currentLimit')}`;
    // Sprint 13 OS-03/OS-06: the simulated environment a sensor is set to, visible on the
    // circuit and updated live while its slider is dragged.
    case 'component.photoresistor':
      return q('illuminance');
    case 'sensor.hc_sr04':
      return q('distance');
    case 'sensor.dht22':
      return `${q('temperature')} · ${q('humidity')}`;
    default:
      return '';
  }
}

function probeLabelAt(p: Probe, at: Point, doc: ProjectDocument) {
  const end = 'end' as const;
  const start = 'start' as const;
  if (p.kind === 'net') return { x: at.x - 6, y: at.y - 18, 'text-anchor': end };
  const placement = doc.layout.components[p.component];
  const rotation = placement?.rotation ?? 0;
  if (p.kind === 'current') {
    return rotation === 90 || rotation === 270
      ? { x: at.x - 18, y: at.y + 4, 'text-anchor': end }
      : { x: at.x, y: at.y - 52, 'text-anchor': 'middle' as const };
  }
  // A terminal's wire leaves in its outward direction: keep the label off that line.
  const c = doc.components.find((x) => x.id === p.component);
  const offset = c && CATALOG[c.type].terminals.find((t) => t.id === p.terminal)?.offset;
  const out = offset ? rotatePoint(offset, rotation) : { x: -1, y: 0 };
  if (Math.abs(out.x) >= Math.abs(out.y)) {
    // Wire runs sideways: the label sits just above it, extending outward.
    return out.x < 0
      ? { x: at.x - 4, y: at.y - 10, 'text-anchor': end }
      : { x: at.x + 4, y: at.y - 10, 'text-anchor': start };
  }
  // Wire runs up or down: the label sits beside the terminal, clear of it.
  return { x: at.x + 14, y: out.y < 0 ? at.y - 4 : at.y + 16, 'text-anchor': start };
}

/** LED matrix pins (front and rear edges): the name sits 50 units in from the pin. */
const matrixInward = (o: Point): Point => ({ x: o.x, y: o.y - Math.sign(o.y) * 50 });
/** Module headers on the left edge (Sprint 12): the name sits just inside the body. */
const sideInward = (o: Point): Point => ({ x: o.x + 34, y: o.y });
/** Modules whose header pins are named on the canvas (their silkscreen tokens). */
const SIDE_PIN_TYPES: ReadonlySet<ComponentTypeId> = new Set<ComponentTypeId>([
  'sensor.hc_sr04',
  'sensor.dht22',
  'display.lcd1602_i2c',
  'component.servo_sg90',
]);

/**
 * A package's pin names as the lines they carry (Sprint 10, the LED matrix: R5, C2, ...; Sprint
 * 12, module headers: TRIG, ECHO, SDA, ...): technical tokens, drawn upright just inside each
 * pin, always LTR. Presentation only.
 */
function LinePins({
  type,
  rotation,
  at,
  inward,
}: {
  type: ComponentTypeId;
  rotation: Rotation;
  at: Point;
  inward: (offset: Point) => Point;
}) {
  return (
    <g class="board-pins" aria-hidden="true">
      {CATALOG[type].terminals.map((t) => {
        const label = rotatePoint(inward(t.offset), rotation);
        return (
          <text
            key={t.id}
            class={type === 'display.led_matrix_8x8' ? 'pin-label matrix-pin-label' : 'pin-label'}
            x={at.x + label.x}
            y={at.y + label.y + 3}
            text-anchor="middle"
            direction="ltr"
          >
            {t.id.toUpperCase()}
          </text>
        );
      })}
    </g>
  );
}

/**
 * ESP32 DevKitC pin names and, while a session runs, a live level dot on each driven or read pad
 * (Sprint 6). Drawn upright at any rotation (symbols carry no text), always LTR: pin names are
 * technical silkscreen tokens. Presentation only: never an electrical input.
 */
function BoardPins({
  rotation,
  at,
  levels,
}: {
  rotation: Rotation;
  at: Point;
  levels: Record<number, GpioLevel> | undefined;
}) {
  return (
    <g class="board-pins" aria-hidden="true">
      {ESP32_DEVKITC_WROOM32.pins.map((pin) => {
        const local = boardPinPosition(pin);
        const inward = local.x < 0 ? -40 : 40;
        const label = rotatePoint({ x: inward, y: local.y }, rotation);
        const dot = rotatePoint({ x: local.x < 0 ? -70 : 70, y: local.y }, rotation);
        const live = pin.gpio !== null ? levels?.[pin.gpio] : undefined;
        const usable = boardTerminalId(pin) !== undefined;
        return (
          <g key={`${pin.header}${pin.position}`}>
            <text
              class={usable ? 'pin-label' : 'pin-label pin-label-unavailable'}
              x={at.x + label.x}
              y={at.y + label.y + 3}
              text-anchor="middle"
              direction="ltr"
            >
              {pin.headerLabel}
            </text>
            {live && (
              <circle
                class={
                  // Sprint 15 (R4): a switching PWM pad is neither HIGH nor LOW. Sprint 17C: nor is
                  // a duty-0 or unsupported one, whose level is not established (O-R4-1).
                  live.pwm?.kind === 'wave'
                    ? 'pin-level pin-pwm'
                    : live.pwm?.kind === 'zero' || live.pwm?.kind === 'unsupported'
                      ? 'pin-level pin-unknown'
                      : live.level
                        ? 'pin-level pin-high'
                        : 'pin-level pin-low'
                }
                data-testid={`pin-level-${pin.gpio}`}
                data-level={String(live.level)}
                data-pwm={live.pwm?.kind}
                cx={at.x + dot.x}
                cy={at.y + dot.y}
                r={4}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}
