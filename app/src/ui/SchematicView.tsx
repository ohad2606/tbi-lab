/**
 * The professional schematic view (Sprint 9): a READ-ONLY drawing generated from the project's
 * connectivity (views/schematic/layout.ts) every time the document changes. It has no state of
 * its own beyond its camera; clicking a part selects that component (selection is session state,
 * shared with the circuit editor and the inspector — never project data).
 *
 * Like the circuit canvas it is a technical LTR space under every locale: reference designators,
 * pin names, values and net names are never mirrored.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  CATALOG,
  emptySelection,
  type ComponentInstance,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { catalogText, formatQuantity, type LocaleInfo } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import {
  schematicLayout,
  type Direction,
  type SchMark,
  type SchModule,
  type SchPart,
  type SchematicLayout,
} from '../views/schematic/layout.js';
import { SCHEMATIC_SYMBOLS, type SchematicSymbolKey } from '../views/schematic/symbols.js';

interface Camera {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function SchematicView() {
  const { doc, selection, locale } = useAppState();
  const store = useStore();
  const t = useT();
  const layout = useMemo(() => (doc ? schematicLayout(doc) : null), [doc]);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [camera, setCamera] = useState<Camera | null>(null);
  const drag = useRef<{ x: number; y: number; camera: Camera } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitCamera = (): Camera | null => {
    if (!layout) return null;
    const b = layout.bounds;
    const pad = 40;
    const w = b.maxX - b.minX + 2 * pad;
    const h = b.maxY - b.minY + 2 * pad;
    const scale = clamp(Math.min(size.w / w, size.h / h), MIN_SCALE, 1.3);
    return {
      scale,
      x: (b.minX + b.maxX) / 2 - size.w / scale / 2,
      y: (b.minY + b.maxY) / 2 - size.h / scale / 2,
    };
  };
  // A different project (or the first layout) is shown whole.
  useEffect(() => setCamera(null), [doc?.projectId]);
  const cam = camera ?? fitCamera();

  if (!doc || !layout || !cam) return null;
  const viewW = size.w / cam.scale;
  const viewH = size.h / cam.scale;

  const zoomAt = (factor: number, cx = size.w / 2, cy = size.h / 2) => {
    const scale = clamp(cam.scale * factor, MIN_SCALE, MAX_SCALE);
    const wx = cam.x + cx / cam.scale;
    const wy = cam.y + cy / cam.scale;
    setCamera({ scale, x: wx - cx / scale, y: wy - cy / scale });
  };
  const selected = new Set(selection.components);
  const select = (id: string) => store.select({ ...emptySelection(), components: [id] });
  const byId = new Map(doc.components.map((c) => [c.id, c]));
  const supplies = new Set(layout.marks.filter((m) => m.kind === 'rail').map((m) => m.supply));

  return (
    <div class="schematic-wrap" ref={wrap} dir="ltr" data-testid="schematic-view">
      <svg
        class="schematic"
        role="img"
        aria-label={t('schematic.aria', { name: doc.name })}
        viewBox={`${cam.x} ${cam.y} ${viewW} ${viewH}`}
        data-parts={layout.parts.map((p) => p.component).join(' ')}
        data-modules={layout.modules.map((m) => m.component).join(' ')}
        onWheel={(e) => {
          e.preventDefault();
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-part]')) return;
          drag.current = { x: e.clientX, y: e.clientY, camera: cam };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setCamera({
            ...d.camera,
            x: d.camera.x - (e.clientX - d.x) / d.camera.scale,
            y: d.camera.y - (e.clientY - d.y) / d.camera.scale,
          });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <g class="sch-wires">
          {layout.wires.map((w, i) => (
            <polyline
              key={i}
              class="sch-wire"
              data-node={w.node}
              points={w.points.map((p) => `${p.x},${p.y}`).join(' ')}
            />
          ))}
        </g>
        {layout.modules.map((m) => (
          <ModuleView
            key={m.component}
            m={m}
            c={byId.get(m.component)!}
            selected={selected.has(m.component)}
            onSelect={select}
            locale={locale}
          />
        ))}
        {layout.parts.map((p) => (
          <PartView
            key={p.component}
            p={p}
            c={byId.get(p.component)!}
            selected={selected.has(p.component)}
            onSelect={select}
            locale={locale}
          />
        ))}
        <g class="sch-marks">
          {layout.marks.map((m, i) => (
            <MarkView key={i} m={m} doc={doc} locale={locale} multiSupply={supplies.size > 1} />
          ))}
        </g>
        <g class="sch-junctions">
          {layout.junctions.map((p) => (
            <circle key={`${p.x},${p.y}`} class="sch-junction" cx={p.x} cy={p.y} r={3.5} />
          ))}
        </g>
      </svg>
      <div class="canvas-controls" role="group" aria-label={t('schematic.controls')}>
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
          data-testid="schematic-fit"
          aria-label={t('canvas.zoomFit')}
          title={t('canvas.zoomFit')}
          onClick={() => setCamera(null)}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" class="control-icon">
            <path d="M3 8V3h5M12 3h5v5M17 12v5h-5M8 17H3v-5" />
          </svg>
        </button>
      </div>
      <div class="view-note" dir={locale.dir}>
        {t('schematic.note')}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------

function PartView({
  p,
  c,
  selected,
  onSelect,
  locale,
}: {
  p: SchPart;
  c: ComponentInstance;
  selected: boolean;
  onSelect(id: string): void;
  locale: LocaleInfo;
}) {
  const sym = SCHEMATIC_SYMBOLS[c.type];
  const value =
    sym.kind === 'two-pin' && sym.valueParam ? quantityText(c, sym.valueParam, locale) : '';
  const name = catalogText(locale, CATALOG[c.type].nameKey);
  // Vertical parts carry their labels beside the body, clear of its widest feature.
  const side = p.x + (LABEL_OFFSET[p.key] ?? 16);
  const transform = `translate(${p.x} ${p.y}) rotate(${p.vertical ? 90 : 0}) scale(${p.mirror ? -1 : 1} 1)`;
  return (
    <g
      class={`sch-part${selected ? ' selected' : ''}`}
      data-part={c.id}
      data-key={p.key}
      tabIndex={0}
      role="button"
      aria-label={[c.id, name, value].filter(Boolean).join(', ')}
      aria-pressed={selected}
      onClick={() => onSelect(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(c.id);
        }
      }}
    >
      <rect
        class="sch-hit"
        x={p.x - (p.vertical ? 16 : 44)}
        y={p.y - (p.vertical ? 44 : 16)}
        width={p.vertical ? 32 : 88}
        height={p.vertical ? 88 : 32}
      />
      <g class="sch-symbol" transform={transform}>
        {drawSymbol(p.key, c)}
      </g>
      {p.key === 'source.dc' && sym.kind === 'two-pin' && (
        // Polarity marks drawn upright (outside the rotation): + toward the positive pin.
        <g class="sch-symbol">
          {(() => {
            const at = (t: string) => {
              const q = p.pins[t]!;
              return { x: p.x + (q.x - p.x) * 0.24, y: p.y + (q.y - p.y) * 0.24 };
            };
            const plus = at(sym.a);
            const minus = at(sym.b);
            return (
              <>
                <line x1={plus.x - 4} y1={plus.y} x2={plus.x + 4} y2={plus.y} />
                <line x1={plus.x} y1={plus.y - 4} x2={plus.x} y2={plus.y + 4} />
                <line x1={minus.x - 4} y1={minus.y} x2={minus.x + 4} y2={minus.y} />
              </>
            );
          })()}
        </g>
      )}
      {p.vertical ? (
        <>
          <text class="sch-ref" x={side} y={p.y - 4}>
            {c.id}
          </text>
          {value && (
            <text class="sch-value" x={side} y={p.y + 13}>
              {value}
            </text>
          )}
        </>
      ) : (
        <>
          <text class="sch-ref" x={p.x} y={p.y - 20} text-anchor="middle">
            {c.id}
          </text>
          {value && (
            <text class="sch-value" x={p.x} y={p.y + 28} text-anchor="middle">
              {value}
            </text>
          )}
        </>
      )}
    </g>
  );
}

const LABEL_OFFSET: Partial<Record<SchematicSymbolKey, number>> = {
  'source.dc': 26,
  led: 26,
  diode: 18,
  'switch.push': 28,
  'switch.toggle': 24,
};

function ModuleView({
  m,
  c,
  selected,
  onSelect,
  locale,
}: {
  m: SchModule;
  c: ComponentInstance;
  selected: boolean;
  onSelect(id: string): void;
  locale: LocaleInfo;
}) {
  const name = catalogText(locale, CATALOG[c.type].nameKey);
  return (
    <g
      class={`sch-part sch-module${selected ? ' selected' : ''}`}
      data-part={c.id}
      data-key="module"
      tabIndex={0}
      role="button"
      aria-label={`${c.id}, ${name}`}
      aria-pressed={selected}
      onClick={() => onSelect(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(c.id);
        }
      }}
    >
      <rect class="sch-module-body" x={m.x} y={m.y} width={m.width} height={m.height} rx={3} />
      <text class="sch-ref" x={m.x + m.width / 2} y={m.y - 10} text-anchor="middle">
        {c.id}
      </text>
      <text class="sch-module-name" x={m.x + m.width / 2} y={m.y + 18} text-anchor="middle">
        {m.partName}
      </text>
      {m.pins.map((pin) => (
        <g key={pin.terminal} data-pin={pin.terminal}>
          <line class="sch-pin" x1={pin.inner.x} y1={pin.inner.y} x2={pin.at.x} y2={pin.at.y} />
          <text
            class="sch-pin-name"
            x={pin.side === 'left' ? pin.inner.x + 6 : pin.inner.x - 6}
            y={pin.inner.y + 4}
            text-anchor={pin.side === 'left' ? 'start' : 'end'}
          >
            {pin.name}
          </text>
        </g>
      ))}
    </g>
  );
}

function MarkView({
  m,
  doc,
  locale,
  multiSupply,
}: {
  m: SchMark;
  doc: ProjectDocument;
  locale: LocaleInfo;
  multiSupply: boolean;
}) {
  const { x, y } = m.at;
  if (m.kind === 'ground')
    return (
      <g class="sch-mark sch-ground" data-mark="ground">
        <line x1={x} y1={y} x2={x} y2={y + 12} />
        <line x1={x - 12} y1={y + 12} x2={x + 12} y2={y + 12} />
        <line x1={x - 7} y1={y + 17} x2={x + 7} y2={y + 17} />
        <line x1={x - 3} y1={y + 22} x2={x + 3} y2={y + 22} />
      </g>
    );
  if (m.kind === 'rail') {
    const psu = doc.components.find((c) => c.id === m.supply);
    const v = psu ? quantityText(psu, 'setpointVoltage', locale) : '';
    const label = `+${v}${multiSupply ? ` (${m.supply})` : ''}`;
    return (
      <g class="sch-mark sch-rail" data-mark="rail" data-supply={m.supply}>
        <line x1={x} y1={y} x2={x} y2={y - 14} />
        <line x1={x - 10} y1={y - 14} x2={x + 10} y2={y - 14} />
        <text class="sch-rail-label" x={x} y={y - 20} text-anchor="middle">
          {label}
        </text>
      </g>
    );
  }
  return <NetLabel at={m.at} dir={m.dir} name={m.name ?? m.node} />;
}

function NetLabel({
  at,
  dir,
  name,
}: {
  at: { x: number; y: number };
  dir: Direction;
  name: string;
}) {
  const { x, y } = at;
  const pos =
    dir === 'left'
      ? { x: x - 8, y: y + 4, anchor: 'end' }
      : dir === 'right'
        ? { x: x + 8, y: y + 4, anchor: 'start' }
        : dir === 'down'
          ? { x, y: y + 16, anchor: 'middle' }
          : { x, y: y - 6, anchor: 'middle' };
  return (
    <g class="sch-mark sch-net" data-mark="net" data-net={name}>
      <circle cx={x} cy={y} r={2} class="sch-net-dot" />
      <text class="sch-net-label" x={pos.x} y={pos.y} text-anchor={pos.anchor}>
        {name}
      </text>
    </g>
  );
}

function quantityText(c: ComponentInstance, key: string, locale: LocaleInfo): string {
  const v = c.params[key];
  return v && typeof v === 'object' ? formatQuantity(locale, v) : '';
}

/**
 * Conventional symbols in local units: horizontal, pin `a` at (−40, 0), pin `b` at (+40, 0).
 * No text inside symbols (they rotate); + and − are geometry.
 */
function drawSymbol(key: SchematicSymbolKey, c: ComponentInstance) {
  switch (key) {
    case 'resistor':
      return (
        <>
          <line x1={-40} y1={0} x2={-24} y2={0} />
          <polyline points="-24,0 -20,-8 -12,8 -4,-8 4,8 12,-8 20,8 24,0" />
          <line x1={24} y1={0} x2={40} y2={0} />
        </>
      );
    case 'led':
    case 'diode':
      return (
        <>
          <line x1={-40} y1={0} x2={-12} y2={0} />
          <polygon points="-12,-12 -12,12 12,0" class="sch-fill" />
          <line x1={12} y1={-12} x2={12} y2={12} />
          <line x1={12} y1={0} x2={40} y2={0} />
          {key === 'led' && (
            <>
              <line x1={-2} y1={-14} x2={6} y2={-22} />
              <polyline points="2,-22 6,-22 6,-18" />
              <line x1={6} y1={-10} x2={14} y2={-18} />
              <polyline points="10,-18 14,-18 14,-14" />
            </>
          )}
        </>
      );
    case 'switch.push':
      return (
        <>
          <line x1={-40} y1={0} x2={-16} y2={0} />
          <line x1={16} y1={0} x2={40} y2={0} />
          <circle cx={-16} cy={0} r={2.5} class="sch-fill" />
          <circle cx={16} cy={0} r={2.5} class="sch-fill" />
          <line x1={-20} y1={-10} x2={20} y2={-10} />
          <line x1={0} y1={-10} x2={0} y2={-20} />
          <line x1={-6} y1={-20} x2={6} y2={-20} />
        </>
      );
    case 'switch.toggle': {
      const closed = c.params.closed === true;
      return (
        <>
          <line x1={-40} y1={0} x2={-16} y2={0} />
          <line x1={16} y1={0} x2={40} y2={0} />
          <circle cx={-16} cy={0} r={2.5} class="sch-fill" />
          <circle cx={16} cy={0} r={2.5} class="sch-fill" />
          <line x1={-16} y1={0} x2={closed ? 16 : 13} y2={closed ? -2 : -16} />
        </>
      );
    }
    case 'source.dc':
      return (
        <>
          <line x1={-40} y1={0} x2={-18} y2={0} />
          <circle cx={0} cy={0} r={18} />
          <line x1={18} y1={0} x2={40} y2={0} />
        </>
      );
    default:
      return <rect x={-24} y={-10} width={48} height={20} />;
  }
}

export type { SchematicLayout };
