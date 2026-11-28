/**
 * The professional schematic view (Sprint 9): a READ-ONLY drawing generated from the project's
 * connectivity (views/schematic/layout.ts) every time the document changes. It has no state of
 * its own beyond its camera; clicking a part selects that component (selection is session state,
 * shared with the circuit editor and the inspector — never project data).
 *
 * Like the circuit canvas it is a technical LTR space under every locale: reference designators,
 * pin names, values and net names are never mirrored.
 */

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PanButtons, SHORT_VIEW_PX } from './PanButtons.js';
import { panCamera } from './viewPan.js';
import {
  CATALOG,
  emptySelection,
  type ComponentInstance,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { catalogText, formatQuantity, isolateLtr, type LocaleInfo } from '../i18n/i18n.js';
import { MODEL_CARDS, partNumber } from '@tbi-lab/engine';
import { useAppState, useStore, useT } from './context.js';
import { EndSeveralContext } from './selectionKeys.js';
import {
  schematicLayout,
  type Direction,
  type SchMark,
  type SchModule,
  type SchPart,
  type SchematicLayout,
} from '../views/schematic/layout.js';
import { fitCamera, overlayBoxes } from './fitCamera.js';
import { revealDelta, type Box } from './revealDelta.js';
import { SCHEMATIC_SYMBOLS, type SchematicSymbolKey } from '../views/schematic/symbols.js';

interface Camera {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.2;
/** "Fit" may go further out: the whole of a wide drawing in a small view. */
const FIT_MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Drawing units between a module's body and its focus ring. */
const RING_GAP = 5;
export function SchematicView() {
  const { doc, selection, locale } = useAppState();
  const store = useStore();
  const t = useT();
  const endSeveral = useContext(EndSeveralContext);
  const layout = useMemo(() => (doc ? schematicLayout(doc) : null), [doc]);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [camera, setCamera] = useState<Camera | null>(null);
  const drag = useRef<{ x: number; y: number; camera: Camera } | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The controls and the note, measured after each render: a fitted drawing stays clear of them.
  const [overlays, setOverlays] = useState<Box[]>([]);
  useLayoutEffect(() => {
    const svg = wrap.current?.querySelector(':scope > svg');
    if (!svg) return;
    const next = overlayBoxes(svg, [controls.current, note.current]);
    setOverlays((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  });

  const fitted = (): Camera | null => {
    if (!layout) return null;
    const around = (x0: number, y0: number, x1: number, y1: number): Box => ({
      left: Math.min(x0, x1),
      right: Math.max(x0, x1),
      top: Math.min(y0, y1),
      bottom: Math.max(y0, y1),
    });
    const items = [
      ...layout.parts.map((p) => {
        const h = partHalf(p);
        return around(p.x - h.w, p.y - h.h, p.x + h.w, p.y + h.h);
      }),
      ...layout.modules.map((m) =>
        around(m.x - RING_GAP, m.y - RING_GAP, m.x + m.width + RING_GAP, m.y + m.height + RING_GAP),
      ),
      ...layout.wires.flatMap((w) =>
        w.points.slice(1).map((p, i) => around(w.points[i]!.x, w.points[i]!.y, p.x, p.y)),
      ),
    ];
    const b = layout.bounds;
    return fitCamera(
      items,
      size,
      overlays,
      { marginX: 40, marginY: 40, pad: 8, min: FIT_MIN_SCALE, max: 1.3 },
      around(b.minX, b.minY, b.maxX, b.maxY),
    );
  };
  // A different project (or the first layout) is shown whole.
  useEffect(() => setCamera(null), [doc?.projectId]);
  const cam = camera ?? fitted();

  if (!doc || !layout || !cam) return null;
  const viewW = size.w / cam.scale;
  const viewH = size.h / cam.scale;
  const short = size.h < SHORT_VIEW_PX;

  const zoomAt = (factor: number, cx = size.w / 2, cy = size.h / 2) => {
    // A drawing fitted below the minimum can be zoomed back out to that fit; never zooms in.
    const floor = Math.min(MIN_SCALE, cam.scale, fitted()?.scale ?? MIN_SCALE);
    const scale = clamp(cam.scale * factor, floor, MAX_SCALE);
    const wx = cam.x + cx / cam.scale;
    const wy = cam.y + cy / cam.scale;
    setCamera({ scale, x: wx - cx / scale, y: wy - cy / scale });
  };
  // Arrows and buttons move the view that way (as in the Circuit view); never mirrored in RTL.
  const pan = (dx: number, dy: number) => setCamera((c) => panCamera(c ?? cam, size, dx, dy));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Enter and Space are not listed: they stay with the focused part.
    const act: Record<string, () => void> = {
      ArrowLeft: () => pan(-1, 0),
      ArrowRight: () => pan(1, 0),
      ArrowUp: () => pan(0, -1),
      ArrowDown: () => pan(0, 1),
      '+': () => zoomAt(1.25),
      '=': () => zoomAt(1.25),
      '-': () => zoomAt(0.8),
      Home: () => setCamera(null),
    };
    const run = act[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  };
  /**
   * A part that gets keyboard focus outside the view, or under the controls or the note, is
   * brought into view. A pointer focus is not `:focus-visible`: clicking never moves the view.
   */
  const reveal = (el: SVGGElement) => {
    if (drag.current || !el.matches(':focus-visible')) return;
    const { dx, dy } = revealDelta(
      el.getBoundingClientRect(),
      el.ownerSVGElement!.getBoundingClientRect(),
      controls.current!.getBoundingClientRect(),
      note.current!.getBoundingClientRect(),
      short,
    );
    if (!dx && !dy) return;
    setCamera({ scale: cam.scale, x: cam.x + dx / cam.scale, y: cam.y + dy / cam.scale });
  };
  const selected = new Set(selection.components);
  const select = (id: string) => {
    store.select({ ...emptySelection(), components: [id] });
    endSeveral(t('multi.partChosen', { ref: isolateLtr(id) }));
  };
  const byId = new Map(doc.components.map((c) => [c.id, c]));
  const supplies = new Set(layout.marks.filter((m) => m.kind === 'rail').map((m) => m.supply));

  return (
    <div
      class={`schematic-wrap${short ? ' view-short' : ''}`}
      ref={wrap}
      dir="ltr"
      data-testid="schematic-view"
    >
      <svg
        class="schematic"
        role="group"
        aria-label={t('schematic.aria', { name: doc.name })}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Plus = - Home"
        tabindex={0}
        onKeyDown={onKeyDown}
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
            onReveal={reveal}
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
            onReveal={reveal}
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
      <div
        class="canvas-controls schematic-controls"
        ref={controls}
        role="group"
        aria-label={t('schematic.controls')}
      >
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
        <PanButtons view="schematic" onPan={pan} />
      </div>
      <div class="view-note" ref={note} dir={locale.dir}>
        {t('schematic.note')}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------

/** Half the size of a two-pin part's hit target. */
const partHalf = (p: SchPart) => (p.vertical ? { w: 16, h: 44 } : { w: 44, h: 16 });

function PartView({
  p,
  c,
  selected,
  onSelect,
  onReveal,
  locale,
}: {
  p: SchPart;
  c: ComponentInstance;
  selected: boolean;
  onSelect(id: string): void;
  onReveal(el: SVGGElement): void;
  locale: LocaleInfo;
}) {
  const sym = SCHEMATIC_SYMBOLS[c.type];
  // A value (resistance, supply voltage), or for an LED or diode its part number (the model
  // card's datasheet part: a technical, language-neutral token, like a pin name).
  const value =
    sym.kind === 'two-pin' && sym.valueParam
      ? quantityText(c, sym.valueParam, locale)
      : c.type === 'component.led' || c.type === 'component.diode'
        ? (MODEL_CARDS[String(c.params.model)]?.name ?? '')
        : (partNumber(c.params.model) ?? '');
  const name = catalogText(locale, CATALOG[c.type].nameKey);
  // Vertical parts carry their labels beside the body, clear of its widest feature.
  const side = p.x + (LABEL_OFFSET[p.key] ?? 16);
  const transform = `translate(${p.x} ${p.y}) rotate(${p.vertical ? 90 : 0}) scale(${p.mirror ? -1 : 1} 1)`;
  return (
    <g
      class={`sch-part${selected ? ' selected' : ''}`}
      data-part={c.id}
      data-key={p.key}
      tabindex={0}
      role="button"
      aria-label={[c.id, name, value].filter(Boolean).join(', ')}
      aria-pressed={selected}
      onClick={() => onSelect(c.id)}
      onFocus={(e) => onReveal(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(c.id);
        }
      }}
    >
      <rect
        class="sch-hit"
        x={p.x - partHalf(p).w}
        y={p.y - partHalf(p).h}
        width={2 * partHalf(p).w}
        height={2 * partHalf(p).h}
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
  photoresistor: 26,
  capacitor: 20,
  buzzer: 18,
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
  onReveal,
  locale,
}: {
  m: SchModule;
  c: ComponentInstance;
  selected: boolean;
  onSelect(id: string): void;
  onReveal(el: SVGGElement): void;
  locale: LocaleInfo;
}) {
  const name = catalogText(locale, CATALOG[c.type].nameKey);
  return (
    <g
      class={`sch-part sch-module${selected ? ' selected' : ''}`}
      data-part={c.id}
      data-key="module"
      tabindex={0}
      role="button"
      aria-label={`${c.id}, ${name}`}
      aria-pressed={selected}
      onClick={() => onSelect(c.id)}
      onFocus={(e) => onReveal(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(c.id);
        }
      }}
    >
      <rect
        class="sch-focus-ring"
        x={m.x - RING_GAP}
        y={m.y - RING_GAP}
        width={m.width + 2 * RING_GAP}
        height={m.height + 2 * RING_GAP}
        rx={3 + RING_GAP}
      />
      <rect class="sch-module-body" x={m.x} y={m.y} width={m.width} height={m.height} rx={3} />
      <text class="sch-ref" x={m.x + m.width / 2} y={m.y - 10} text-anchor="middle">
        {c.id}
      </text>
      <text class="sch-module-name" x={m.x + m.width / 2} y={m.y + 18} text-anchor="middle">
        {m.partName}
      </text>
      {partNumber(c.params.model) && (
        // The datasheet part (a language-neutral technical token), as two-pin parts show it.
        <text class="sch-value" x={m.x + m.width / 2} y={m.y + 32} text-anchor="middle">
          {partNumber(c.params.model)}
        </text>
      )}
      {m.glyph !== 'mcu' && (
        <g
          class="sch-symbol sch-glyph"
          data-glyph={m.glyph}
          transform={`translate(${m.x + m.width / 2} ${m.y + Math.max(52, m.height / 2 + 10)}) scale(${Math.min(1.6, Math.max(1, (m.height - 40) / 60))})`}
        >
          {moduleGlyph(m.glyph)}
        </g>
      )}
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

/**
 * The conventional symbol inside a multi-pin part's block, centred on (0, 0), about 80 x 44 units.
 * Drawn from the same line-art vocabulary as the two-pin symbols; pin names are on the block edge.
 */
function moduleGlyph(glyph: SchModule['glyph']) {
  switch (glyph) {
    case 'rgb_led.cc':
      // Three emitters (R, G, B) whose cathodes join the common cathode bar.
      return (
        <>
          {[-14, 0, 14].map((y) => (
            <g key={y}>
              <line x1={-30} y1={y} x2={-10} y2={y} />
              <polygon points={`-10,${y - 5} -10,${y + 5} 0,${y}`} class="led-body" />
              <line x1={0} y1={y - 5} x2={0} y2={y + 5} />
              <line x1={0} y1={y} x2={14} y2={y} />
            </g>
          ))}
          <line x1={14} y1={-14} x2={14} y2={14} />
          <line x1={14} y1={0} x2={30} y2={0} />
        </>
      );
    // Sprint 19B: logic gates (distinctive shapes), inputs left, output right.
    case 'logic.and':
    case 'logic.nand':
      return (
        <>
          <path d="M -18 -14 H -2 A 14 14 0 0 1 -2 14 H -18 Z" />
          {glyph === 'logic.nand' && <circle cx={15} cy={0} r={3} />}
        </>
      );
    case 'logic.or':
    case 'logic.nor':
    case 'logic.xor':
      return (
        <>
          <path d="M -18 -14 Q 2 -14 14 0 Q 2 14 -18 14 Q -10 0 -18 -14 Z" />
          {glyph === 'logic.nor' && <circle cx={17} cy={0} r={3} />}
          {glyph === 'logic.xor' && <path d="M -23 -14 Q -15 0 -23 14" fill="none" />}
        </>
      );
    case 'logic.not':
      return (
        <>
          <path d="M -14 -12 L -14 12 L 8 0 Z" />
          <circle cx={11} cy={0} r={3} />
        </>
      );
    case 'relay.spdt':
      // Coil (box) mechanically linked (dashed) to a change-over contact: COM, NC (rest), NO.
      return (
        <>
          <rect x={-34} y={-10} width={16} height={20} />
          <line x1={-26} y1={-22} x2={-26} y2={-10} />
          <line x1={-26} y1={10} x2={-26} y2={22} />
          <line x1={-18} y1={0} x2={6} y2={-4} class="sch-mechanical" />
          <circle cx={6} cy={10} r={2} />
          <line x1={6} y1={10} x2={26} y2={-8} />
          <circle cx={28} cy={-10} r={2} />
          <circle cx={28} cy={10} r={2} />
          <line x1={6} y1={10} x2={6} y2={22} />
        </>
      );
    case 'potentiometer':
      return (
        <>
          <polyline points="-24,0 -20,-8 -12,8 -4,-8 4,8 12,-8 20,8 24,0" />
          <line x1={0} y1={-24} x2={0} y2={-12} />
          <polygon points="-5,-18 5,-18 0,-10" class="sch-arrow" />
        </>
      );
    case 'bjt.npn':
      return (
        <>
          <circle cx={4} cy={0} r={18} />
          <line x1={-26} y1={0} x2={-6} y2={0} />
          <line x1={-6} y1={-11} x2={-6} y2={11} />
          <line x1={-6} y1={-5} x2={12} y2={-16} />
          <line x1={-6} y1={5} x2={12} y2={16} />
          <polygon points="12,16 4,15 8,9" class="sch-arrow" />
        </>
      );
    case 'pir':
      // Sensor dome over a module body with a digital output.
      return (
        <>
          <rect x={-26} y={-2} width={52} height={14} />
          <path d="M -16 -2 A 16 14 0 0 1 16 -2" />
          <polyline points="30,10 36,10 36,2 42,2" />
        </>
      );
    case 'led_matrix':
      return (
        <>
          {[0, 1, 2, 3].flatMap((r) =>
            [0, 1, 2, 3].map((c) => (
              <circle key={`${r}.${c}`} cx={-15 + c * 10} cy={-15 + r * 10} r={3} />
            )),
          )}
        </>
      );
    case 'ultrasonic':
      // The two transducers (transmitter, receiver) on the module.
      return (
        <>
          <rect x={-30} y={-14} width={60} height={28} />
          <circle cx={-13} cy={0} r={10} />
          <circle cx={13} cy={0} r={10} />
        </>
      );
    case 'dht22':
      // The sensor case and its vent grille.
      return (
        <>
          <rect x={-14} y={-20} width={28} height={40} />
          {[-12, -4, 4, 12].map((y) => (
            <line key={y} x1={-8} y1={y} x2={8} y2={y} />
          ))}
        </>
      );
    case 'lcd':
      // A two-line character display.
      return (
        <>
          <rect x={-34} y={-14} width={68} height={28} />
          {[-5, 5].flatMap((y) =>
            [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <rect key={`${i}.${y}`} x={-28 + i * 7} y={y - 3} width={5} height={6} />
            )),
          )}
        </>
      );
    case 'servo':
      // Sprint 15: the motor (circle) driving the output shaft and its horn, with the arc of travel.
      return (
        <>
          <circle cx={-14} cy={0} r={14} />
          <line x1={0} y1={0} x2={18} y2={0} />
          <circle cx={18} cy={0} r={3} />
          <line x1={18} y1={0} x2={18} y2={-16} />
          <path d="M 30 0 A 12 12 0 0 0 18 -12" />
          <polyline points="22,-15 18,-12 22,-9" />
        </>
      );
    default:
      return null;
  }
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
    case 'photoresistor':
      return (
        <>
          <line x1={-40} y1={0} x2={-24} y2={0} />
          <polyline points="-24,0 -20,-8 -12,8 -4,-8 4,8 12,-8 20,8 24,0" />
          <line x1={24} y1={0} x2={40} y2={0} />
          <line x1={-18} y1={-24} x2={-8} y2={-12} />
          <polyline points="-12,-12 -8,-12 -8,-16" />
          <line x1={-2} y1={-24} x2={8} y2={-12} />
          <polyline points="4,-12 8,-12 8,-16" />
        </>
      );
    case 'capacitor':
      return (
        <>
          <line x1={-40} y1={0} x2={-5} y2={0} />
          <line x1={-5} y1={-13} x2={-5} y2={13} />
          <line x1={5} y1={-13} x2={5} y2={13} />
          <line x1={5} y1={0} x2={40} y2={0} />
        </>
      );
    case 'buzzer':
      return (
        <>
          <line x1={-40} y1={0} x2={-12} y2={0} />
          <line x1={12} y1={0} x2={40} y2={0} />
          <path d="M -12 2 L -12 -4 A 12 12 0 0 1 12 -4 L 12 2 Z" />
          <line x1={-30} y1={-8} x2={-22} y2={-8} />
          <line x1={-26} y1={-12} x2={-26} y2={-4} />
        </>
      );
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
