import { useT } from './context.js';
import { PAN_BUTTONS } from './viewPan.js';

/** Below this view height (px) the overlay controls form a row along the top. */
export const SHORT_VIEW_PX = 280;

/** The four pan buttons: the single-pointer alternative to dragging a view. */
export function PanButtons({
  view,
  onPan,
}: {
  /** Test id prefix. */
  view: 'canvas' | 'schematic' | 'view3d';
  onPan(dx: number, dy: number): void;
}) {
  const t = useT();
  return (
    <div class="view-pan">
      {PAN_BUTTONS.map((b) => (
        <button
          key={b.id}
          type="button"
          class="icon-button"
          data-testid={`${view}-pan-${b.id}`}
          aria-label={t(b.key)}
          title={t(b.key)}
          onClick={() => onPan(b.dx, b.dy)}
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" class="control-icon">
            <path d={b.path} />
          </svg>
        </button>
      ))}
    </div>
  );
}
