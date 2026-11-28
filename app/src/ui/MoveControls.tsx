/**
 * Editing the drawing without dragging (BETA-G3; WCAG 2.1.1, 2.5.7): buttons in the Inspector
 * that make the same edit as the arrow keys. Directions are physical (screen terms) and are
 * never mirrored in RTL.
 */
import { GRID, moveWireSegment, wireRoute, type Point, type Wire } from '@tbi-lab/domain';
import { isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { moveRouted } from './routing.js';
import {
  clampSegment,
  followSegment,
  isHorizontalSegment,
  isWireUnmoved,
  pickedSegment,
  routeKey,
  segmentDirections,
  type SegmentPick,
} from './segments.js';
import { useKeepFocus } from './useKeepFocus.js';
import { PAN_BUTTONS } from './viewPan.js';

export type Direction = (typeof PAN_BUTTONS)[number]['id'];

function DirectionButton({
  direction,
  label,
  testId,
  unavailable,
  onClick,
}: {
  direction: Direction;
  label: string;
  testId: string;
  /** Id of the text saying why a press does nothing yet; the button stays focusable. */
  unavailable?: string | undefined;
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
      aria-disabled={unavailable ? 'true' : undefined}
      aria-describedby={unavailable}
      onClick={onClick}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" class="control-icon">
        <path d={path} />
      </svg>
    </button>
  );
}

const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * A refused button move is said once, by the Properties status with the reason; the banner stays
 * visible but is not a second announcement.
 */
function useRefusal(announce: (text: string) => void) {
  const store = useStore();
  const t = useT();
  return (message: string) => {
    const n = store.state.notice;
    // Both are whole translated sentences; only the full stop between them is added.
    announce(n?.quiet ? `${message}. ${t(n.key, n.params)}` : message);
  };
}

/** One grid step for the selected part or junction (`id`), or for the whole multi-selection. */
export function MoveControls({
  id,
  announce,
  onReveal,
}: {
  id?: string | undefined;
  announce(text: string): void;
  onReveal(at: Point): void;
}) {
  const { doc, selection } = useAppState();
  const store = useStore();
  const t = useT();
  const refuse = useRefusal(announce);
  const group = useKeepFocus<HTMLDivElement>();
  if (!doc) return null;
  const params = {
    id: isolateLtr(id ?? ''),
    count: selection.components.length + selection.wires.length + selection.junctions.length,
  };
  const scope = id ? 'move' : 'move.group';
  return (
    <div
      ref={group}
      class="move-group"
      role="group"
      aria-labelledby="move-heading"
      data-testid="move-group"
    >
      <h3 id="move-heading">{t('move.title')}</h3>
      <div class="move-buttons" dir="ltr">
        {PAN_BUTTONS.map((b) => (
          <DirectionButton
            key={b.id}
            direction={b.id}
            testId={`move-${b.id}`}
            label={t(`${scope}.${b.id}`, params)}
            onClick={() => {
              const r = moveRouted(doc, selection, { x: b.dx * GRID, y: b.dy * GRID });
              // Wires alone may have nothing of their own to move: no empty undo step.
              const unchanged = r.ok && JSON.stringify(r.doc.layout) === JSON.stringify(doc.layout);
              if (unchanged) {
                // Only wires can be unchanged: shown with the reason, said once by the status.
                store.notify({ key: 'move.group.unchanged', tone: 'warning', quiet: true });
                return refuse(t(`${scope}.refused`, params));
              }
              if (!store.apply(r, undefined, { quiet: true }) || !r.ok)
                return refuse(t(`${scope}.refused`, params));
              // The moved item furthest in the direction of the move.
              const moved = [
                ...selection.components.map((c) => r.doc.layout.components[c]),
                ...r.doc.layout.junctions.filter((j) => selection.junctions.includes(j.id)),
              ].flatMap((p) => (p ? [p] : []));
              const along = (p: Point) => p.x * b.dx + p.y * b.dy;
              const at = moved.sort((p, q) => along(q) - along(p))[0];
              if (at) onReveal(at);
              // A selected wire that looks the same as before is not reported as moved
              // (compared with the document as stored, after the store's routing).
              const still = selection.wires.some((w) => isWireUnmoved(doc, store.state.doc!, w));
              const done = still && !id ? 'move.group.partial' : (`${scope}.done` as const);
              announce(t(`${done}.${b.id}`, params));
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
  onReveal,
}: {
  onReveal(at: Point): void;
  wire: Wire;
  pick: SegmentPick | null;
  onPick(pick: SegmentPick): void;
  announce(text: string): void;
}) {
  const { doc, selection } = useAppState();
  const store = useStore();
  const t = useT();
  const refuse = useRefusal(announce);
  const group = useKeepFocus<HTMLDivElement>();
  if (!doc) return null;
  const route = wireRoute(doc, wire);
  if (!route || route.length < 2) return null;
  const count = route.length - 1;
  const picked = pickedSegment(pick, wire.id, route);
  // A stale pick keeps the buttons (and their focus) in place; they only ask for a new choice.
  const index = picked ?? clampSegment(pick?.index, count);
  const directions = segmentDirections(isHorizontalSegment(route, index));
  const option = (i: number) =>
    t(`segment.option.${isHorizontalSegment(route, i) ? 'horizontal' : 'vertical'}`, {
      n: i + 1,
      m: count,
    });
  return (
    <div
      ref={group}
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
          value={picked === null ? '' : String(index)}
          onChange={(e) => {
            const i = Number(e.currentTarget.value);
            onPick({ wire: wire.id, index: i, route: routeKey(route) });
            onReveal(middle(route[i]!, route[i + 1]!));
          }}
        >
          {picked === null && (
            <option value="" disabled>
              {t('segment.choosePlaceholder')}
            </option>
          )}
          {Array.from({ length: count }, (_, i) => (
            <option key={i} value={String(i)}>
              {option(i)}
            </option>
          ))}
        </select>
      </label>
      {picked === null && (
        <p id="segment-stale" class="muted small" data-testid="segment-stale">
          {t('segment.stale')}
        </p>
      )}
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
              unavailable={picked === null ? 'segment-stale' : undefined}
              onClick={() => {
                if (picked === null) return announce(t('segment.stale'));
                const delta = { x: b.dx * GRID, y: b.dy * GRID };
                const r = moveWireSegment(doc, wire.id, index, delta);
                const changed =
                  !r.ok || JSON.stringify(r.doc.layout.wires) !== JSON.stringify(doc.layout.wires);
                if (!changed || !store.apply(r, selection, { quiet: true })) {
                  // `changed` false: nothing was applied, so any notice shown is an older one.
                  if (changed) refuse(t('segment.refused'));
                  else announce(t('segment.refused'));
                  return;
                }
                // The route as stored, which is what the next render compares the pick with.
                const stored = store.state.doc!;
                const after = wireRoute(
                  stored,
                  stored.layout.wires.find((w) => w.id === wire.id)!,
                );
                if (!after) return;
                const next = followSegment(route, index, delta, after);
                onPick({ wire: wire.id, index: next, route: routeKey(after) });
                onReveal(middle(after[next]!, after[next + 1]!));
                announce(t(`segment.done.${direction}`, { n: next + 1, m: after.length - 1 }));
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
