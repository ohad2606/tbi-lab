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
import type { ComponentTypeId, ProjectDocument } from '@tbi-lab/domain';
import type { MessageKey } from '../i18n/messages.en.js';

export type ExampleProbe =
  | { kind: 'terminal'; component: string; terminal: string }
  | { kind: 'current'; component: string };

export interface Example {
  id: string;
  titleKey: MessageKey;
  summaryKey: MessageKey;
  probes: ExampleProbe[];
  /**
   * OS-12: the part types the example's circuit uses (ground excluded), for search and the
   * category filters on the Projects screen. The documents load lazily, so this small list lives
   * in the start-up catalog; a unit test keeps it equal to the document (examples-discover.test).
   */
  parts: readonly ComponentTypeId[];
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
    parts: ['component.resistor', 'instrument.lab_psu'],
  },
  {
    id: 'voltage-divider',
    titleKey: 'example.voltage-divider.title',
    summaryKey: 'example.voltage-divider.summary',
    probes: [V('R2', 'a'), I('R1')],
    parts: ['component.resistor', 'instrument.lab_psu'],
  },
  {
    id: 'led-current',
    titleKey: 'example.led-current.title',
    summaryKey: 'example.led-current.summary',
    probes: [V('D1', 'anode'), I('D1')],
    parts: ['component.led', 'component.resistor', 'instrument.lab_psu'],
  },
  {
    id: 'led-colours',
    titleKey: 'example.led-colours.title',
    summaryKey: 'example.led-colours.summary',
    probes: [I('D1'), I('D2'), I('D3')],
    parts: ['component.led', 'component.resistor', 'instrument.lab_psu'],
  },
  // Sprint 10 (PM-6 revision): the new parts, each in a complete, explainable circuit.
  {
    id: 'rgb-mixer',
    titleKey: 'example.rgb-mixer.title',
    summaryKey: 'example.rgb-mixer.summary',
    probes: [I('R1'), I('R2'), I('R3')],
    parts: [
      'component.resistor',
      'component.rgb_led',
      'component.toggle_switch',
      'instrument.lab_psu',
    ],
  },
  {
    id: 'light-sensor',
    titleKey: 'example.light-sensor.title',
    summaryKey: 'example.light-sensor.summary',
    probes: [V('R1', 'a')],
    parts: ['component.photoresistor', 'component.resistor', 'instrument.lab_psu'],
  },
  {
    id: 'night-light',
    titleKey: 'example.night-light.title',
    summaryKey: 'example.night-light.summary',
    probes: [V('Q1', 'base'), I('D1')],
    parts: [
      'component.bjt_npn',
      'component.led',
      'component.photoresistor',
      'component.resistor',
      'instrument.lab_psu',
    ],
  },
  {
    id: 'pir-alarm',
    titleKey: 'example.pir-alarm.title',
    summaryKey: 'example.pir-alarm.summary',
    probes: [V('U1', 'out'), I('BZ1')],
    parts: [
      'component.bjt_npn',
      'component.buzzer',
      'component.resistor',
      'instrument.lab_psu',
      'sensor.pir_hc_sr501',
    ],
  },
  {
    id: 'led-matrix',
    titleKey: 'example.led-matrix.title',
    summaryKey: 'example.led-matrix.summary',
    probes: [I('R1'), I('R2')],
    parts: [
      'component.resistor',
      'component.toggle_switch',
      'display.led_matrix_8x8',
      'instrument.lab_psu',
    ],
  },
  {
    id: 'rc-fade',
    titleKey: 'example.rc-fade.title',
    summaryKey: 'example.rc-fade.summary',
    probes: [V('C1', 'a'), I('D1')],
    parts: [
      'component.capacitor',
      'component.led',
      'component.resistor',
      'component.toggle_switch',
      'instrument.lab_psu',
    ],
  },
  {
    id: 'relay-load',
    titleKey: 'example.relay-load.title',
    summaryKey: 'example.relay-load.summary',
    probes: [I('D1'), I('BZ1')],
    parts: [
      'component.buzzer',
      'component.led',
      'component.push_button',
      'component.relay',
      'component.resistor',
      'instrument.lab_psu',
    ],
  },
  {
    id: 'diode-polarity',
    titleKey: 'example.diode-polarity.title',
    summaryKey: 'example.diode-polarity.summary',
    probes: [I('D1'), I('D2')],
    parts: ['component.diode', 'component.resistor', 'instrument.lab_psu'],
  },
  {
    id: 'push-button',
    titleKey: 'example.push-button.title',
    summaryKey: 'example.push-button.summary',
    probes: [I('D1')],
    parts: ['component.led', 'component.push_button', 'component.resistor', 'instrument.lab_psu'],
  },
  {
    id: 'cc-mode',
    titleKey: 'example.cc-mode.title',
    summaryKey: 'example.cc-mode.summary',
    probes: [I('R2'), V('R2', 'a')],
    parts: ['component.resistor', 'component.toggle_switch', 'instrument.lab_psu'],
  },
  {
    id: 'esp32-blink',
    titleKey: 'example.esp32-blink.title',
    summaryKey: 'example.esp32-blink.summary',
    probes: [I('D1')],
    parts: ['board.esp32_devkitc_wroom32', 'component.led', 'component.resistor'],
  },
  {
    id: 'esp32-input-echo',
    titleKey: 'example.esp32-input-echo.title',
    summaryKey: 'example.esp32-input-echo.summary',
    probes: [I('D1'), V('R1', 'b')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.led',
      'component.push_button',
      'component.resistor',
      'component.toggle_switch',
      'instrument.lab_psu',
    ],
  },
  // Sprint 10 (realism benchmark): every part family the 3D view is judged on, in one valid circuit.
  {
    id: 'esp32-bench',
    titleKey: 'example.esp32-bench.title',
    summaryKey: 'example.esp32-bench.summary',
    probes: [I('D1'), I('D3'), I('D4')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.diode',
      'component.led',
      'component.push_button',
      'component.resistor',
      'component.toggle_switch',
      'instrument.lab_psu',
    ],
  },
  // Sprint 11 (R1): the Sprint 10 parts with the ESP32 (same firmware as the input echo).
  {
    id: 'esp32-motion-relay',
    titleKey: 'example.esp32-motion-relay.title',
    summaryKey: 'example.esp32-motion-relay.summary',
    probes: [I('D2')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.bjt_npn',
      'component.buzzer',
      'component.diode',
      'component.led',
      'component.relay',
      'component.resistor',
      'instrument.lab_psu',
      'sensor.pir_hc_sr501',
    ],
  },
  {
    id: 'esp32-night-light',
    titleKey: 'example.esp32-night-light.title',
    summaryKey: 'example.esp32-night-light.summary',
    probes: [I('R1')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.photoresistor',
      'component.resistor',
      'component.rgb_led',
      'instrument.lab_psu',
    ],
  },
  // Sprint 12 (R2/R3): the ultrasonic module, the DHT22 and the I2C LCD with the ESP32
  // (library-free sketches).
  {
    id: 'esp32-distance-alarm',
    titleKey: 'example.esp32-distance-alarm.title',
    summaryKey: 'example.esp32-distance-alarm.summary',
    probes: [V('R1', 'a'), I('D1')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.led',
      'component.resistor',
      'instrument.lab_psu',
      'sensor.hc_sr04',
    ],
  },
  {
    id: 'esp32-thermo-hygrometer',
    titleKey: 'example.esp32-thermo-hygrometer.title',
    summaryKey: 'example.esp32-thermo-hygrometer.summary',
    probes: [V('R1', 'b')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.resistor',
      'instrument.lab_psu',
      'sensor.dht22',
    ],
  },
  {
    id: 'esp32-lcd-hello',
    titleKey: 'example.esp32-lcd-hello.title',
    summaryKey: 'example.esp32-lcd-hello.summary',
    probes: [V('R1', 'b'), V('R2', 'b')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.resistor',
      'display.lcd1602_i2c',
      'instrument.lab_psu',
    ],
  },
  // Sprint 15 (R4): LEDC PWM — an LED dimmed by its duty, an SG90 swept by pulse width.
  {
    id: 'esp32-led-fade',
    titleKey: 'example.esp32-led-fade.title',
    summaryKey: 'example.esp32-led-fade.summary',
    probes: [I('D1')],
    parts: ['board.esp32_devkitc_wroom32', 'component.led', 'component.resistor'],
  },
  {
    id: 'esp32-servo-sweep',
    titleKey: 'example.esp32-servo-sweep.title',
    summaryKey: 'example.esp32-servo-sweep.summary',
    probes: [V('M1', 'vcc')],
    parts: ['board.esp32_devkitc_wroom32', 'component.servo_sg90', 'instrument.lab_psu'],
  },
  // Sprint 19B (Exploration Foundation X1): ESP32 + logic gate + read-back.
  {
    id: 'esp32-logic-and',
    titleKey: 'example.esp32-logic-and.title',
    summaryKey: 'example.esp32-logic-and.summary',
    probes: [V('U2', 'y'), I('D1')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.led',
      'component.push_button',
      'component.resistor',
      'instrument.lab_psu',
      'logic.gate_and',
    ],
  },
  // Exploration Foundation L3 interop: ESP32 → packaged gate (SN74LVC08A) → LEDs.
  {
    id: 'esp32-logic-quad-and',
    titleKey: 'example.esp32-logic-quad-and.title',
    summaryKey: 'example.esp32-logic-quad-and.summary',
    probes: [V('U2', 'y1'), I('D1'), I('D2')],
    parts: [
      'board.esp32_devkitc_wroom32',
      'component.led',
      'component.push_button',
      'component.resistor',
      'instrument.lab_psu',
      'logic.quad_and',
    ],
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
