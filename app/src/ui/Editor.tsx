import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentTypeId } from '@tbi-lab/domain';
import { Canvas, type CanvasApi } from './Canvas.js';
import { useAppState } from './context.js';
import { Inspector } from './Inspector.js';
import { Palette } from './Palette.js';
import { probeExists, sameTarget, type Probe, type ProbeInput } from './probes.js';

/**
 * The editing workspace: palette, canvas and inspector. Run/Stop live in the top bar.
 * Probes are presentation state of this workspace: they belong to the open project for this
 * session only and are never written into the project document.
 */
export function Editor() {
  const { doc, suggestedProbes } = useAppState();
  const [placing, setPlacing] = useState<ComponentTypeId | null>(null);
  const [probeMode, setProbeMode] = useState(false);
  const [probes, setProbes] = useState<Probe[]>([]);
  const nextProbe = useRef(1);
  const canvasApi = useRef<CanvasApi | null>(null);

  // A different project starts without probes, unless it was just opened from an example
  // that suggests some (presentation state only, never stored in the project).
  useEffect(() => {
    const suggested =
      suggestedProbes && suggestedProbes.projectId === doc?.projectId ? suggestedProbes.probes : [];
    setProbes(suggested.map((p) => ({ ...p, id: `probe${nextProbe.current++}` }) as Probe));
  }, [doc?.projectId]);
  // Probes whose target was deleted disappear with it.
  const live = doc ? probes.filter((p) => probeExists(p, doc)) : [];

  const addProbe = (input: ProbeInput) => {
    if (live.some((p) => sameTarget(p, input))) return;
    setProbes([...live, { ...input, id: `probe${nextProbe.current++}` } as Probe]);
  };

  return (
    <main class="workspace">
      <Palette
        placing={placing}
        onPick={(type, viaKeyboard) => {
          setProbeMode(false);
          if (viaKeyboard) {
            setPlacing(null);
            canvasApi.current?.placeAtCenter(type);
          } else {
            setPlacing((p) => (p === type ? null : type));
          }
        }}
      />
      <Canvas
        placing={placing}
        onPlacingDone={() => setPlacing(null)}
        apiRef={canvasApi}
        probeMode={probeMode}
        onProbeModeChange={(on) => {
          setProbeMode(on);
          if (on) setPlacing(null);
        }}
        probes={live}
        onProbe={addProbe}
      />
      <Inspector
        probes={live}
        onRemoveProbe={(id) => setProbes(live.filter((p) => p.id !== id))}
        onClearProbes={() => setProbes([])}
      />
    </main>
  );
}
