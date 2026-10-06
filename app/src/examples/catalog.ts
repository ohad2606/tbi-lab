/**
 * The curated Product Alpha examples (Sprint 5), and the two Classic ESP32 examples (Sprint 6),
 * which run through the R2 Session Host with a prebuilt firmware.
 *
 * Each example is PRODUCT DATA: an ordinary schema v2 project document in ./data (authored by
 * app/tests/exampleRecipes.ts through the normal editing operations). Opening an example
 * creates a fresh, independent local project from it (new identity, name in the current UI
 * language); it then runs through the same production engine as any other project, with no
 * special physics path and no hidden simulation state.
 *
 * `probes` are suggested measurement points: editor presentation state, applied when the
 * example is opened and never stored in the project.
 */
import type { ProjectDocument } from '@tbi-lab/domain';
import type { MessageKey } from '../i18n/messages.en.js';

export type ExampleProbe =
  | { kind: 'terminal'; component: string; terminal: string }
  | { kind: 'current'; component: string };

export interface Example {
  id: string;
  titleKey: MessageKey;
  summaryKey: MessageKey;
  probes: ExampleProbe[];
}
const I = (component: string): ExampleProbe => ({ kind: 'current', component });
const V = (component: string, terminal: string): ExampleProbe => ({
  kind: 'terminal',
  component,
  terminal,
});

export const EXAMPLES: readonly Example[] = [
  {
    id: 'ohms-law',
    titleKey: 'example.ohms-law.title',
    summaryKey: 'example.ohms-law.summary',
    probes: [I('R1')],
  },
  {
    id: 'voltage-divider',
    titleKey: 'example.voltage-divider.title',
    summaryKey: 'example.voltage-divider.summary',
    probes: [V('R2', 'a'), I('R1')],
  },
  {
    id: 'led-current',
    titleKey: 'example.led-current.title',
    summaryKey: 'example.led-current.summary',
    probes: [V('D1', 'anode'), I('D1')],
  },
  {
    id: 'led-colours',
    titleKey: 'example.led-colours.title',
    summaryKey: 'example.led-colours.summary',
    probes: [I('D1'), I('D2'), I('D3')],
  },
  // Sprint 10 (PM-6 revision): the new parts, each in a complete, explainable circuit.
  {
    id: 'rgb-mixer',
    titleKey: 'example.rgb-mixer.title',
    summaryKey: 'example.rgb-mixer.summary',
    probes: [I('R1'), I('R2'), I('R3')],
  },
  {
    id: 'light-sensor',
    titleKey: 'example.light-sensor.title',
    summaryKey: 'example.light-sensor.summary',
    probes: [V('R1', 'a')],
  },
  {
    id: 'night-light',
    titleKey: 'example.night-light.title',
    summaryKey: 'example.night-light.summary',
    probes: [V('Q1', 'base'), I('D1')],
  },
  {
    id: 'pir-alarm',
    titleKey: 'example.pir-alarm.title',
    summaryKey: 'example.pir-alarm.summary',
    probes: [V('U1', 'out'), I('BZ1')],
  },
  {
    id: 'led-matrix',
    titleKey: 'example.led-matrix.title',
    summaryKey: 'example.led-matrix.summary',
    probes: [I('R1'), I('R2')],
  },
  {
    id: 'rc-fade',
    titleKey: 'example.rc-fade.title',
    summaryKey: 'example.rc-fade.summary',
    probes: [V('C1', 'a'), I('D1')],
  },
  {
    id: 'relay-load',
    titleKey: 'example.relay-load.title',
    summaryKey: 'example.relay-load.summary',
    probes: [I('D1'), I('BZ1')],
  },
  {
    id: 'diode-polarity',
    titleKey: 'example.diode-polarity.title',
    summaryKey: 'example.diode-polarity.summary',
    probes: [I('D1'), I('D2')],
  },
  {
    id: 'push-button',
    titleKey: 'example.push-button.title',
    summaryKey: 'example.push-button.summary',
    probes: [I('D1')],
  },
  {
    id: 'cc-mode',
    titleKey: 'example.cc-mode.title',
    summaryKey: 'example.cc-mode.summary',
    probes: [I('R2'), V('R2', 'a')],
  },
  {
    id: 'esp32-blink',
    titleKey: 'example.esp32-blink.title',
    summaryKey: 'example.esp32-blink.summary',
    probes: [I('D1')],
  },
  {
    id: 'esp32-input-echo',
    titleKey: 'example.esp32-input-echo.title',
    summaryKey: 'example.esp32-input-echo.summary',
    probes: [I('D1'), V('R1', 'b')],
  },
];

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/**
 * The example DOCUMENTS live in their own chunk (Sprint 10: they are about 60 kB of minified data
 * the app does not need to start). It is loaded when an example is opened, and prefetched when the
 * browser is idle after start-up (`prefetchExamples`), so opening an example still works offline
 * once the app has loaded. The metadata above (titles, probes) stays in the start-up bundle.
 */
let documents: Promise<Record<string, ProjectDocument>> | null = null;
const loadDocuments = () =>
  (documents ??= import('./documents.js')
    .then((m) => m.EXAMPLE_DOCUMENTS)
    .catch((e) => {
      documents = null; // a failed fetch may be retried
      throw e;
    }));

export async function loadExampleDocument(id: string): Promise<ProjectDocument | undefined> {
  return (await loadDocuments())[id];
}

export function prefetchExamples(): void {
  void loadDocuments().catch(() => undefined);
}
