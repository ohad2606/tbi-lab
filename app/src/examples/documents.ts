/**
 * The curated example documents (Sprint 10: split from catalog.ts into their own lazily loaded
 * chunk). Product data authored by app/tests/exampleRecipes.ts.
 */
import type { ProjectDocument } from '@tbi-lab/domain';
import { EXAMPLES, type Example } from './catalog.js';
import ccMode from './data/cc-mode.json';
import diodePolarity from './data/diode-polarity.json';
import esp32Blink from './data/esp32-blink.json';
import esp32InputEcho from './data/esp32-input-echo.json';
import esp32Bench from './data/esp32-bench.json';
import esp32MotionRelay from './data/esp32-motion-relay.json';
import esp32NightLight from './data/esp32-night-light.json';
import esp32DistanceAlarm from './data/esp32-distance-alarm.json';
import esp32ThermoHygrometer from './data/esp32-thermo-hygrometer.json';
import esp32LcdHello from './data/esp32-lcd-hello.json';
import esp32LedFade from './data/esp32-led-fade.json';
import esp32ServoSweep from './data/esp32-servo-sweep.json';
import esp32LogicAnd from './data/esp32-logic-and.json';
import esp32LogicQuadAnd from './data/esp32-logic-quad-and.json';
import esp32LogicOverride from './data/esp32-logic-override.json';
import logicAndSwitches from './data/logic-and-switches.json';
import logicCascade from './data/logic-cascade.json';
import ledColours from './data/led-colours.json';
import ledCurrent from './data/led-current.json';
import ledMatrix from './data/led-matrix.json';
import nightLight from './data/night-light.json';
import lightSensor from './data/light-sensor.json';
import relayLoad from './data/relay-load.json';
import rgbMixer from './data/rgb-mixer.json';
import ohmsLaw from './data/ohms-law.json';
import pirAlarm from './data/pir-alarm.json';
import pushButton from './data/push-button.json';
import rcFade from './data/rc-fade.json';
import voltageDivider from './data/voltage-divider.json';
import mpyBlink from './data/mpy-blink.json';
import mpyButton from './data/mpy-button.json';
import mpyFade from './data/mpy-fade.json';
import mpyLcdHello from './data/mpy-lcd-hello.json';

export const EXAMPLE_DOCUMENTS: Record<string, ProjectDocument> = {
  'ohms-law': ohmsLaw as unknown as ProjectDocument,
  'voltage-divider': voltageDivider as unknown as ProjectDocument,
  'led-current': ledCurrent as unknown as ProjectDocument,
  'led-colours': ledColours as unknown as ProjectDocument,
  'rgb-mixer': rgbMixer as unknown as ProjectDocument,
  'light-sensor': lightSensor as unknown as ProjectDocument,
  'night-light': nightLight as unknown as ProjectDocument,
  'pir-alarm': pirAlarm as unknown as ProjectDocument,
  'led-matrix': ledMatrix as unknown as ProjectDocument,
  'rc-fade': rcFade as unknown as ProjectDocument,
  'relay-load': relayLoad as unknown as ProjectDocument,
  'diode-polarity': diodePolarity as unknown as ProjectDocument,
  'push-button': pushButton as unknown as ProjectDocument,
  'cc-mode': ccMode as unknown as ProjectDocument,
  'esp32-blink': esp32Blink as unknown as ProjectDocument,
  'esp32-input-echo': esp32InputEcho as unknown as ProjectDocument,
  'esp32-bench': esp32Bench as unknown as ProjectDocument,
  'esp32-motion-relay': esp32MotionRelay as unknown as ProjectDocument,
  'esp32-night-light': esp32NightLight as unknown as ProjectDocument,
  'esp32-distance-alarm': esp32DistanceAlarm as unknown as ProjectDocument,
  'esp32-thermo-hygrometer': esp32ThermoHygrometer as unknown as ProjectDocument,
  'esp32-lcd-hello': esp32LcdHello as unknown as ProjectDocument,
  'esp32-led-fade': esp32LedFade as unknown as ProjectDocument,
  'esp32-servo-sweep': esp32ServoSweep as unknown as ProjectDocument,
  'esp32-logic-and': esp32LogicAnd as unknown as ProjectDocument,
  'esp32-logic-quad-and': esp32LogicQuadAnd as unknown as ProjectDocument,
  'logic-and-switches': logicAndSwitches as unknown as ProjectDocument,
  'logic-cascade': logicCascade as unknown as ProjectDocument,
  'esp32-logic-override': esp32LogicOverride as unknown as ProjectDocument,
  'mpy-blink': mpyBlink as unknown as ProjectDocument,
  'mpy-button': mpyButton as unknown as ProjectDocument,
  'mpy-fade': mpyFade as unknown as ProjectDocument,
  'mpy-lcd-hello': mpyLcdHello as unknown as ProjectDocument,
};

/** The examples with their documents (tests and tools; the app loads documents lazily). */
export const EXAMPLES_WITH_DOCUMENTS: readonly (Example & { document: ProjectDocument })[] =
  EXAMPLES.map((e) => ({ ...e, document: EXAMPLE_DOCUMENTS[e.id]! }));
