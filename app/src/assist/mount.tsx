/**
 * Sprint 27 (DEV-Lab builds only): the Circuit Debugger's host, mounted once by App. It listens for
 * the top-bar button and loads the panel's code on the first open, so the editor's start-up cost
 * is unchanged. Only DEV-Lab builds include it (deployment.ts ASSIST_ENABLED).
 */
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useAppState } from '../ui/context.js';
import { onOpenAssist } from './open.js';

type Panel = ComponentType<{ onClose: () => void; trigger: HTMLElement | null }>;

export function AssistHost() {
  const [trigger, setTrigger] = useState<{ el: HTMLElement | null } | null>(null);
  const [Panel, setPanel] = useState<Panel | null>(null);
  const { screen } = useAppState();
  useEffect(() => onOpenAssist((el) => setTrigger({ el })), []);
  useEffect(() => {
    if (trigger && !Panel)
      void import('./AssistPanel.js').then((m) => setPanel(() => m.AssistPanel));
  }, [trigger, Panel]);
  if (!trigger || !Panel || screen !== 'editor') return null;
  return <Panel trigger={trigger.el} onClose={() => setTrigger(null)} />;
}
