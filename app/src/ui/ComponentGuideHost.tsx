/**
 * TBI-019 G2: mounts the component guide panel once (App). The panel's code (and the engine it
 * evaluates the guide's numbers with) loads on the first open, so start-up cost is unchanged.
 * Opening another guide while one is open replaces it and keeps the first opener as the focus
 * return target.
 */
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { onOpenComponentGuide } from './componentGuideOpen.js';

type Panel = ComponentType<{ guideId: string; trigger: HTMLElement | null; onClose: () => void }>;

export function ComponentGuideHost() {
  const [open, setOpen] = useState<{ id: string; el: HTMLElement | null } | null>(null);
  const [Panel, setPanel] = useState<Panel | null>(null);
  useEffect(
    () => onOpenComponentGuide((id, el) => setOpen((cur) => ({ id, el: cur?.el ?? el }))),
    [],
  );
  useEffect(() => {
    if (open && !Panel) void import('./GuidePanel.js').then((m) => setPanel(() => m.GuidePanel));
  }, [open, Panel]);
  if (!open || !Panel) return null;
  return <Panel guideId={open.id} trigger={open.el} onClose={() => setOpen(null)} />;
}
