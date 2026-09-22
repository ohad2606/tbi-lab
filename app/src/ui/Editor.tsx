import { useRef, useState } from 'preact/hooks';
import type { ComponentTypeId } from '@tbi-lab/domain';
import { Canvas, type CanvasApi } from './Canvas.js';
import { Inspector } from './Inspector.js';
import { Palette } from './Palette.js';

/**
 * The editing workspace. Deliberately no Run control and no simulation affordance: the
 * electrical engine arrives in Sprint 3, and the product must not pretend otherwise.
 */
export function Editor() {
  const [placing, setPlacing] = useState<ComponentTypeId | null>(null);
  const canvasApi = useRef<CanvasApi | null>(null);
  return (
    <main class="workspace">
      <Palette
        placing={placing}
        onPick={(type, viaKeyboard) => {
          if (viaKeyboard) {
            setPlacing(null);
            canvasApi.current?.placeAtCenter(type);
          } else {
            setPlacing((p) => (p === type ? null : type));
          }
        }}
      />
      <Canvas placing={placing} onPlacingDone={() => setPlacing(null)} apiRef={canvasApi} />
      <Inspector />
    </main>
  );
}
