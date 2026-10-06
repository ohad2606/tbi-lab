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
import ccMode from './data/cc-mode.json';
import diodePolarity from './data/diode-polarity.json';
import esp32Blink from './data/esp32-blink.json';
import esp32InputEcho from './data/esp32-input-echo.json';
import ledColours from './data/led-colours.json';
import ledCurrent from './data/led-current.json';
import nightLight from './data/night-light.json';
import lightSensor from './data/light-sensor.json';
import relayLoad from './data/relay-load.json';
import rgbMixer from './data/rgb-mixer.json';
import ohmsLaw from './data/ohms-law.json';
import pushButton from './data/push-button.json';
import voltageDivider from './data/voltage-divider.json';

export type ExampleProbe =
  | { kind: 'terminal'; component: string; terminal: string }
  | { kind: 'current'; component: string };

export interface Example {
  id: string;
  titleKey: MessageKey;
  summaryKey: MessageKey;
  document: ProjectDocument;
  probes: ExampleProbe[];
}

const doc = (json: unknown) => json as ProjectDocument;
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
    document: doc(ohmsLaw),
    probes: [I('R1')],
  },
  {
    id: 'voltage-divider',
    titleKey: 'example.voltage-divider.title',
    summaryKey: 'example.voltage-divider.summary',
    document: doc(voltageDivider),
    probes: [V('R2', 'a'), I('R1')],
  },
  {
    id: 'led-current',
    titleKey: 'example.led-current.title',
    summaryKey: 'example.led-current.summary',
    document: doc(ledCurrent),
    probes: [V('D1', 'anode'), I('D1')],
  },
  {
    id: 'led-colours',
    titleKey: 'example.led-colours.title',
    summaryKey: 'example.led-colours.summary',
    document: doc(ledColours),
    probes: [I('D1'), I('D2'), I('D3')],
  },
  // Sprint 10 (PM-6 revision): the new parts, each in a complete, explainable circuit.
  {
    id: 'rgb-mixer',
    titleKey: 'example.rgb-mixer.title',
    summaryKey: 'example.rgb-mixer.summary',
    document: doc(rgbMixer),
    probes: [I('R1'), I('R2'), I('R3')],
  },
  {
    id: 'light-sensor',
    titleKey: 'example.light-sensor.title',
    summaryKey: 'example.light-sensor.summary',
    document: doc(lightSensor),
    probes: [V('R1', 'a')],
  },
  {
    id: 'night-light',
    titleKey: 'example.night-light.title',
    summaryKey: 'example.night-light.summary',
    document: doc(nightLight),
    probes: [V('Q1', 'base'), I('D1')],
  },
  {
    id: 'relay-load',
    titleKey: 'example.relay-load.title',
    summaryKey: 'example.relay-load.summary',
    document: doc(relayLoad),
    probes: [I('D1'), I('BZ1')],
  },
  {
    id: 'diode-polarity',
    titleKey: 'example.diode-polarity.title',
    summaryKey: 'example.diode-polarity.summary',
    document: doc(diodePolarity),
    probes: [I('D1'), I('D2')],
  },
  {
    id: 'push-button',
    titleKey: 'example.push-button.title',
    summaryKey: 'example.push-button.summary',
    document: doc(pushButton),
    probes: [I('D1')],
  },
  {
    id: 'cc-mode',
    titleKey: 'example.cc-mode.title',
    summaryKey: 'example.cc-mode.summary',
    document: doc(ccMode),
    probes: [I('R2'), V('R2', 'a')],
  },
  {
    id: 'esp32-blink',
    titleKey: 'example.esp32-blink.title',
    summaryKey: 'example.esp32-blink.summary',
    document: doc(esp32Blink),
    probes: [I('D1')],
  },
  {
    id: 'esp32-input-echo',
    titleKey: 'example.esp32-input-echo.title',
    summaryKey: 'example.esp32-input-echo.summary',
    document: doc(esp32InputEcho),
    probes: [I('D1'), V('R1', 'b')],
  },
];

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
