/**
 * TBI-019 G2: the single public way to open a component guide (mirrors `openGuide` of the Help
 * panel). Entry points (the Home card, the Inspector link, later the Help panel) call
 * `openComponentGuide(id, trigger)`; the host mounted by App answers. Kept apart from the panel so
 * an entry point never loads the panel (or the engine it evaluates with).
 */
type Listener = (id: string, trigger: HTMLElement | null) => void;
const listeners = new Set<Listener>();

/** Open guide `id`; focus returns to `trigger` when the panel closes. */
export function openComponentGuide(id: string, trigger: HTMLElement | null): void {
  for (const l of listeners) l(id, trigger);
}

export function onOpenComponentGuide(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
