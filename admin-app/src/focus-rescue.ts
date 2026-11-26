/**
 * WCAG 2.4.3: content that held focus can be replaced (a failed reload, a lost sign-in), which
 * drops focus on <body>. Then, and only then, it goes to the screen's heading.
 */

/** Where the user's focus is, or was when its node was removed; null once the user left it. */
let held: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    held = e.target instanceof HTMLElement ? e.target : null;
  });
  document.addEventListener('focusout', (e) => {
    const left = e.target;
    // Judged after the render in progress: a removed node is then no longer connected.
    queueMicrotask(() => {
      if (held === left && held?.isConnected && document.activeElement === document.body)
        held = null;
    });
  });
}

/** Call after content was replaced. Does nothing on a first load or while focus is somewhere. */
export function rescueFocus(): void {
  // A frame later: a closing confirmation restores its opener first, if that still exists.
  requestAnimationFrame(() => {
    if (!held || held.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const heading = document.querySelector<HTMLElement>('main h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
  });
}
