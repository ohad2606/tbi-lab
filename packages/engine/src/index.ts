export {
  ENGINE_VERSION,
  EngineSession,
  type ComponentResult,
  type EngineError,
  type EngineErrorCode,
  type LiveControl,
  type PsuControl,
  type SolveFailure,
  type SolveOutcome,
  type SolveStats,
  type SolveSuccess,
  type SupplyMode,
} from './session.js';
export { MODEL_CARDS, MODEL_VALID_CURRENT_A } from './registry.js';
export {
  MODEL_RATINGS,
  ratingWarnings,
  type AbsoluteMaximumRatings,
  type RatingCode,
  type RatingWarning,
} from './ratings.js';

// Low-level circuit API and the classic-ESP32 GPIO pin model, for the server-side MCU runtime
// (runtime R1): the same physics implementation the browser uses (ADR-008).
export { Circuit, ConvergenceError, type SolveResult } from './circuit.js';
export { Diode, LabPsu, Resistor, VoltageSource, type Device } from './devices.js';
export { DIODE_1N4148, LED_TLHR5400 } from './models.js';
export {
  G_INPUT_LEAKAGE_S,
  GpioPin,
  R_DRIVE_HIGH_OHM,
  R_DRIVE_LOW_OHM,
  R_PULL_OHM,
  V_IH_V,
  V_IL_V,
  VDD_V,
  interpretDigitalInput,
  type DigitalLevel,
  type PinMode,
} from './esp32Gpio.js';
