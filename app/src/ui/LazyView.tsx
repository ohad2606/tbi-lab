/**
 * Loads a view module on first use (Sprint 9): the generated Schematic and 3D views are not part
 * of the editor's startup bundle. A failed load shows a localized message in place of the view;
 * the rest of the workspace is unaffected.
 */

import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useT } from './context.js';

const cache = new Map<() => Promise<ComponentType>, ComponentType>();

export function LazyView({ load }: { load: () => Promise<ComponentType> }) {
  const t = useT();
  const [View, setView] = useState<ComponentType | null>(() => cache.get(load) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (View) return;
    let live = true;
    load().then(
      (v) => {
        cache.set(load, v);
        if (live) setView(() => v);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [load]);
  if (View) return <View />;
  return (
    <div class="view3d-message" role={failed ? 'alert' : 'status'}>
      {t(failed ? 'view.loadFailed' : 'view.loading')}
    </div>
  );
}
