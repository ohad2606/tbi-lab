export {
  ENGINE_VERSION,
  EngineSession,
  type ComponentResult,
  type EngineError,
  type EngineErrorCode,
  type LiveControl,
  type McuPinAttachment,
  type PinResult,
  type RuntimePinMode,
  type PsuControl,
  type SolveFailure,
  type SolveOutcome,
  type SolveStats,
  type SolveSuccess,
  type SupplyMode,
} from './session.js';
export { MODEL_CARDS, MODEL_VALID_CURRENT_A } from './registry.js';
export { partModel, partNumber, type PartModel } from './parts.js';
export { RGB_CHANNELS, RGB_RATINGS, RGB_VALID_CURRENT_A, type RgbChannel } from './parts/rgbLed.js';
export { CEM_1205_IC } from './parts/buzzer.js';
import { CEM_1205_IC as BUZZER_CARD } from './parts/buzzer.js';
/** The buzzer's rated tone (CEM-1205-IC: 2400 Hz), for an optional sound presentation. */
export const BUZZER_TONE_HZ = BUZZER_CARD.frequencyHz;
export {
  MODEL_RATINGS,
  RATING_UNIT,
  ratingWarnings,
  type AbsoluteMaximumRatings,
  type RatingCode,
  type RatingWarning,
} from './ratings.js';

// Low-level circuit API and the classic-ESP32 GPIO pin model, for the server-side MCU runtime
// (runtime R1): the same physics implementation the browser uses (ADR-008).
export { Circuit, ConvergenceError, type SolveResult } from './circuit.js';
export { Diode, LabPsu, Resistor, VoltageSource, type Device } from './devices.js';
export { DIODE_1N4148, LED_TLHR5400, RGB_WP154A4SUREQBFZGC } from './models.js';
export {
  G_INPUT_LEAKAGE_S,
  GpioPin,
  I_OH_A,
  I_OL_A,
  R_DRIVE_HIGH_OHM,
  R_DRIVE_LOW_OHM,
  R_PULL_OHM,
  V_IH_V,
  V_IL_V,
  V_PIN_MAX_V,
  V_PIN_MIN_V,
  VDD_V,
  interpretDigitalInput,
  type DigitalLevel,
  type PinMode,
} from './esp32Gpio.js';
