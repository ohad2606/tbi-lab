import { useLayoutEffect, useRef } from 'preact/hooks';

/**
 * Removed (undo took the selection away) while holding focus: focus goes to the Properties heading,
 * unless the action that removed it already put focus somewhere else.
 */
export function useKeepFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(
    () => () => {
      if (!ref.current?.contains(document.activeElement)) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        document.getElementById('inspector-heading')?.focus();
      });
    },
    [],
  );
  return ref;
}
