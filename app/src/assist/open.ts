/**
 * Sprint 27: opening the Circuit Debugger panel (DEV-Lab only). The top-bar button asks; the panel
 * host, mounted once, answers. Kept apart from the panel so the button does not load the panel.
 */
const listeners = new Set<(trigger: HTMLElement | null) => void>();

export function openAssist(trigger: HTMLElement | null): void {
  for (const l of listeners) l(trigger);
}

export function onOpenAssist(listener: (trigger: HTMLElement | null) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
