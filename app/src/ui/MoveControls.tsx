/**
 * Editing the drawing without dragging (BETA-G3; WCAG 2.1.1, 2.5.7): buttons in the Inspector
 * that make the same edit as the arrow keys. Directions are physical (screen terms) and are
 * never mirrored in RTL.
 */
import { GRID } from '@tbi-lab/domain';
import { isolateLtr } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';
import { moveRouted } from './routing.js';
import { PAN_BUTTONS } from './viewPan.js';

export type Direction = (typeof PAN_BUTTONS)[number]['id'];

export function DirectionButton({
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
