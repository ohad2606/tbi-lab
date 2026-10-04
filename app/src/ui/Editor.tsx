import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentTypeId } from '@tbi-lab/domain';
import { Canvas, type CanvasApi } from './Canvas.js';
import { useAppState, useT } from './context.js';
import { CodeView } from './CodeView.js';
import { SchematicView } from './SchematicView.js';
import { Inspector } from './Inspector.js';
import { McuTerminal } from './McuTerminal.js';
import { requiresMcuRuntime } from '../runtime/snapshot.js';
import { Palette } from './Palette.js';
import { probeExists, sameTarget, type Probe, type ProbeInput } from './probes.js';

type View = 'circuit' | 'schematic' | 'code';
/** Views every project has; Code joins them for a project with a programmable board. */
const VIEWS: View[] = ['circuit', 'schematic'];
const VIEW_LABEL = {
  circuit: 'program.tab.circuit',
  schematic: 'view.tab.schematic',
  code: 'program.tab.code',
} as const;

/**
 * The editing workspace: palette, canvas and inspector. Run/Stop live in the top bar.
 * Probes are presentation state of this workspace: they belong to the open project for this
 * session only and are never written into the project document.
 */
export function Editor() {
  const { doc, suggestedProbes, sim } = useAppState();
  const t = useT();
  // The board whose program this project authors (V1: at most one), and which view shows.
  const programBoard = doc
    ? Object.keys(doc.programs).find((id) => doc.components.some((c) => c.id === id))
    : undefined;
  const [view, setView] = useState<View>('circuit');
  const [focusBuild, setFocusBuild] = useState(0);
  useEffect(() => setView('circuit'), [doc?.projectId]);
  // Run refused for want of a current build: take the user to the code and its Build action.
  const refusal = sim.status === 'failed' && sim.failure.kind === 'mcu' ? sim.failure.code : null;
  useEffect(() => {
    if (refusal === 'mcu_build_required' && programBoard) {
      setView('code');
      setFocusBuild((n) => n + 1);
    }
  }, [refusal, sim]);
  const showCode = view === 'code' && !!programBoard;
  const views: View[] = programBoard ? [...VIEWS, 'code'] : VIEWS;
  const active: View = views.includes(view) ? view : 'circuit';
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
      <div class="workspace-center">
        <div
          class="view-tabs"
          role="tablist"
          aria-label={t('view.tabs')}
          onKeyDown={(e) => {
            // Arrow keys move between tabs, in reading order (mirrored under RTL).
            const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
            if (!step) return;
            e.preventDefault();
            const forward = document.documentElement.dir === 'rtl' ? -step : step;
            const next = views[(views.indexOf(active) + forward + views.length) % views.length]!;
            setView(next);
            (e.currentTarget as HTMLElement)
              .querySelector<HTMLElement>(`[data-testid="view-${next}"]`)
              ?.focus();
          }}
        >
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              class="view-tab"
              data-testid={`view-${v}`}
              aria-selected={active === v}
              tabIndex={active === v ? 0 : -1}
              onClick={() => setView(v)}
            >
              {t(VIEW_LABEL[v])}
              {v === 'code' && (
                <span class="view-tab-file technical" dir="ltr">
                  {doc!.programs[programBoard!]!.fileName}
                </span>
              )}
            </button>
          ))}
        </div>
        {showCode && <CodeView boardId={programBoard!} focusBuild={focusBuild} />}
        {active === 'schematic' && (
          <div class="view-slot">
            <SchematicView />
          </div>
        )}
        <div class="canvas-slot" hidden={active !== 'circuit'}>
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
        </div>
      </div>
      {/* The side column: properties, and under them the ESP32 terminal for ESP32 projects. */}
      <div class="side-column">
        <Inspector
          probes={live}
          onRemoveProbe={(id) => setProbes(live.filter((p) => p.id !== id))}
          onClearProbes={() => setProbes([])}
        />
        {doc && requiresMcuRuntime(doc) && <McuTerminal />}
      </div>
    </main>
  );
}
