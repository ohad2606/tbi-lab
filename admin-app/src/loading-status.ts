/**
 * Whether the app should be saying "loading" (WCAG 4.1.3). Any number of loaders share one status
 * region: it speaks once, while at least one of them is shown. Both changes wait a moment, so the
 * region is in the page before its text (screen readers often miss a region that arrives already
 * filled), a very short load says nothing, and loaders handing over to each other do not repeat.
 */
export function createLoadingStatus(delayMs: number) {
  const listeners = new Set<(shown: boolean) => void>();
  let active = 0;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const update = () => {
    if (active > 0 === shown) {
      clearTimeout(timer);
      timer = undefined;
    } else
      timer ??= setTimeout(() => {
        timer = undefined;
        shown = !shown;
        listeners.forEach((l) => l(shown));
      }, delayMs);
  };

  return {
    /** A loader appeared; call the result when it goes. */
    begin(): () => void {
      active++;
      update();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        active--;
        update();
      };
    },
    /** Told the current state at once, then every change; call the result to stop. */
    subscribe(listener: (shown: boolean) => void): () => void {
      listeners.add(listener);
      listener(shown);
      return () => void listeners.delete(listener);
    },
  };
}

export const loadingStatus = createLoadingStatus(150);
