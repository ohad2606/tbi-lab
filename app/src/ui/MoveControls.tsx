/**
 * Editing the drawing without dragging (BETA-G3; WCAG 2.1.1, 2.5.7): buttons in the Inspector
 * that make the same edit as the arrow keys. Directions are physical (screen terms) and are
 * never mirrored in RTL.
 */
import { GRID, moveWireSegment, wireRoute, type Wire } from '@tbi-lab/domain';
import { isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { moveRouted } from './routing.js';
import {
  clampSegment,
  followSegment,
  isHorizontalSegment,
  segmentDirections,
  type SegmentPick,
} from './segments.js';
import { PAN_BUTTONS } from './viewPan.js';

export type Direction = (typeof PAN_BUTTONS)[number]['id'];

function DirectionButton({
  direction,
  label,
  testId,
  onClick,
}: {
  direction: Direction;
  label: string;
  testId: string;
  onClick(): void;
}) {
  const { path } = PAN_BUTTONS.find((b) => b.id === direction)!;
  return (
    <button
      type="button"
      class="icon-button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" class="control-icon">
        <path d={path} />
      </svg>
    </button>
  );
}

/** One grid step for the single selected part or junction. */
export function MoveControls({ id, announce }: { id: string; announce(text: string): void }) {
  const { doc, selection } = useAppState();
  const store = useStore();
  const t = useT();
  if (!doc) return null;
  const params = { id: isolateLtr(id) };
  return (
    <div class="move-group" role="group" aria-labelledby="move-heading" data-testid="move-group">
      <h3 id="move-heading">{t('move.title')}</h3>
      <div class="move-buttons" dir="ltr">
        {PAN_BUTTONS.map((b) => (
          <DirectionButton
            key={b.id}
            direction={b.id}
            testId={`move-${b.id}`}
            label={t(`move.${b.id}`, params)}
            onClick={() => {
              const moved = store.apply(
                moveRouted(doc, selection, { x: b.dx * GRID, y: b.dy * GRID }),
              );
              announce(t(moved ? `move.done.${b.id}` : 'move.refused', params));
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One wire segment: choose it, then move it one grid step across its own line. The same domain
 * edit as dragging it (the wire becomes manual; its ends and connections stay).
 */
export function SegmentMoveControls({
  wire,
  pick,
  onPick,
  announce,
}: {
  wire: Wire;
  pick: SegmentPick | null;
  onPick(pick: SegmentPick): void;
  announce(text: string): void;
}) {
  const { doc, selection } = useAppState();
  const store = useStore();
  const t = useT();
  if (!doc) return null;
  const route = wireRoute(doc, wire);
  if (!route || route.length < 2) return null;
  const count = route.length - 1;
  const index = clampSegment(pick?.wire === wire.id ? pick.index : undefined, count);
  const directions = segmentDirections(isHorizontalSegment(route, index));
  const option = (i: number) =>
    t(`segment.option.${isHorizontalSegment(route, i) ? 'horizontal' : 'vertical'}`, {
      n: i + 1,
      m: count,
    });
  return (
    <div
      class="move-group"
      role="group"
      aria-labelledby="segment-heading"
      data-testid="segment-group"
    >
      <h3 id="segment-heading">{t('segment.title')}</h3>
      <label class="segment-choice">
        <span>{t('segment.choose')}</span>
        <select
          data-testid="segment-select"
          value={String(index)}
          onChange={(e) => onPick({ wire: wire.id, index: Number(e.currentTarget.value) })}
        >
          {Array.from({ length: count }, (_, i) => (
            <option key={i} value={String(i)}>
              {option(i)}
            </option>
          ))}
        </select>
      </label>
      <div class="move-buttons" dir="ltr">
        {directions.map((direction, slot) => {
          const b = PAN_BUTTONS.find((x) => x.id === direction)!;
          return (
            // Keyed by position: focus stays even if the segment's orientation changes.
            <DirectionButton
              key={slot}
              direction={direction}
              testId={`segment-move-${direction}`}
              label={t(`segment.move.${direction}`)}
              onClick={() => {
                const delta = { x: b.dx * GRID, y: b.dy * GRID };
                const r = moveWireSegment(doc, wire.id, index, delta);
                const changed =
                  !r.ok || JSON.stringify(r.doc.layout.wires) !== JSON.stringify(doc.layout.wires);
                if (!changed || !store.apply(r, selection)) {
                  announce(t('segment.refused'));
                  return;
                }
                const after = r.ok
                  ? wireRoute(
                      r.doc,
                      r.doc.layout.wires.find((w) => w.id === wire.id)!,
                    )
                  : undefined;
                if (!after) return;
                const next = followSegment(route, index, delta, after);
                onPick({ wire: wire.id, index: next });
                announce(t(`segment.done.${direction}`, { n: next + 1, m: after.length - 1 }));
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
