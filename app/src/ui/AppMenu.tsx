import { openCapabilities } from './Capabilities.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { SIGN_OUT_URL } from '../deployment.js';
import { useAppState, useStore, useT } from './context.js';
import { downloadProject } from './download.js';

/**
 * The editor's application menu: navigation, project files and the account action, kept out
 * of the circuit-work area of the top bar. One flat list; no hover behaviour. Escape, a click
 * outside, Tab, or choosing an item closes it.
 */
export function AppMenu({ chooseImport }: { chooseImport: () => void }) {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; start: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (focusButton: boolean) => {
    setOpen(false);
    setPlace(null);
    if (focusButton) button.current?.focus();
  };
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  // The top bar clips its overflow, so the list is fixed to the viewport under the button,
  // aligned to the button's inline start (the header's leading edge: left in LTR, right in RTL).
  const placeUnderButton = () => {
    const b = button.current;
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const rtl = getComputedStyle(b).direction === 'rtl';
    return {
      top: r.bottom + 4,
      start: rtl ? document.documentElement.clientWidth - r.right : r.left,
    };
  };
  // Placed when opened, so the list is never rendered unplaced (hidden) first.
  const openMenu = () => {
    setPlace(placeUnderButton());
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (open) setPlace(placeUnderButton());
  }, [state.locale]);

  // Focus the first item in the same commit that shows the list, before any key can arrive,
  // and never take focus back from an item the user already moved to (a post-paint effect
  // could run after an End key press and steal its focus: GitHub Actions 36328598866).
  useLayoutEffect(() => {
    if (!open) return;
    if (!menu.current?.contains(document.activeElement)) items()[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const onMenuKey = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') close(false);
    else if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
  };

  const run = (action: () => void) => () => {
    close(false);
    action();
  };
  const doc = state.doc;
  // The library's own order (most recently changed first), without the open project. Opening
  // one uses the Projects screen's path: simulation stopped, pending save flushed, then load.
  const recent = state.projects.filter((p) => p.projectId !== doc?.projectId).slice(0, 3);

  return (
    <div class="app-menu" onKeyDown={(e) => open && onMenuKey(e)}>
      <button
        ref={button}
        type="button"
        class="button button-quiet app-menu-button"
        data-testid="app-menu-button"
        aria-label={t('menu.button')}
        title={t('menu.button')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'app-menu-list' : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="control-icon">
          <path d="M2 4 H14 M2 8 H14 M2 12 H14" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          id="app-menu-list"
          class="app-menu-list"
          role="menu"
          aria-label={t('menu.button')}
          data-testid="app-menu"
          style={
            place
              ? { top: `${place.top}px`, insetInlineStart: `${place.start}px` }
              : { visibility: 'hidden' }
          }
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="menu-projects"
            onClick={run(() => void store.goHome())}
          >
            {t('topbar.projects')}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="menu-new-project"
            onClick={run(() => void store.goHome().then(focusNewProjectName))}
          >
            {t('menu.newProject')}
          </button>

          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="menu-import"
            onClick={run(chooseImport)}
          >
            {t('library.import.button')}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid="menu-capabilities"
            onClick={run(() => openCapabilities('firmware'))}
          >
            {t('menu.capabilities')}
          </button>
          {recent.length > 0 && (
            <>
              <div role="separator" class="app-menu-separator" />
              <div role="group" aria-labelledby="app-menu-recent-label" data-testid="menu-recent">
                <div id="app-menu-recent-label" class="app-menu-label" role="presentation">
                  {t('home.recent.heading')}
                </div>
                {recent.map((p) => (
                  <button
                    key={p.projectId}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    class="app-menu-recent"
                    dir="auto"
                    data-testid={`menu-recent-${p.projectId}`}
                    title={p.name}
                    aria-label={t('library.open', { name: p.name })}
                    onClick={run(() => void store.openProject(p.projectId))}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
          {doc && !state.readOnly && <div role="separator" class="app-menu-separator" />}
          {doc && !state.readOnly && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid="export-current"
              title={t('export.title')}
              onClick={run(() => void downloadProject(store, doc.projectId))}
            >
              {t('menu.export')}
            </button>
          )}
          {SIGN_OUT_URL && (
            <>
              <div role="separator" class="app-menu-separator" />
              {/* A plain top-level navigation to the deployment's sign-out endpoint. */}
              <a
                role="menuitem"
                tabIndex={-1}
                data-testid="sign-out"
                href={SIGN_OUT_URL}
                onClick={() => setOpen(false)}
              >
                {t('topbar.signOut')}
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "New project" leads to the Projects screen's own create form, ready to type a name. */
function focusNewProjectName() {
  requestAnimationFrame(() => {
    const field = document.querySelector<HTMLInputElement>('[data-testid="new-project-name"]');
    field?.focus();
    field?.select();
  });
}
