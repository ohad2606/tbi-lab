export {
  ENGINE_VERSION,
  EngineSession,
  type ComponentResult,
  type EngineError,
  type EngineErrorCode,
  type LiveControl,
  type McuPinAttachment,
  type PinResult,
  type PwmComponentFigures,
  type PwmPadFigures,
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
  V_OH_CHAR_V,
  V_OL_CHAR_V,
  outsideCharacterizedRegion,
  interpretDigitalInput,
  type DigitalLevel,
  type PinMode,
} from './esp32Gpio.js';
// Sprint 12 (R2/R3): sensor and display protocol semantics, and the R2 part models' DC constants.
export { HC_SR04, hcsr04Echo, speedOfSound, type Echo } from './peripherals/hcsr04.js';
export { dht22Frame, decodeDht22, dht22Waveform } from './peripherals/dht22.js';
export { I2cBus, I2cBusError, type I2cTarget } from './peripherals/i2c.js';
export {
  BACKPACK_STANDARD,
  Hd44780,
  I2cLcd,
  Pcf8574,
  romA00,
  type BackpackWiring,
} from './peripherals/hd44780.js';
export { HC_SR04_DC, hcsr04TrigLevel } from './parts/ultrasonic.js';
export { DHT22_DC } from './parts/dht22.js';
export { LCD1602_DC, PCF8574_VIH_FRACTION, PCF8574_VIL_FRACTION } from './parts/lcd.js';
// Sprint 15 (R4): the SG90's pulse semantics and its electrical side.
export { Servo, SG90, type ServoSpec } from './peripherals/servo.js';
export { SG90_ELECTRICAL, servoPowered, servoSignalLevel } from './parts/servo.js';
// Sprint 19B (Exploration Foundation L1): single logic gates.
export {
  LVC1G_CARDS,
  evaluate,
  inputRowAt,
  outputGuaranteeAt,
  outputStageAt,
  quiescentAt,
  TABULATED_VCC_TOLERANCE_V,
  type LogicCard,
  type LogicFunction,
} from './logic/lvc1g.js';
export { GATE_TYPES, gateOutput, type LogicLevel } from './parts/logicGate.js';
export { logicFeedback, unknownClosure } from './logic/topology.js';
export {
  buildBounds,
  evaluateBounds,
  ESP32_V_OL_MAX_V,
  type LogicBoundSpec,
} from './logic/bounds.js';
// Exploration Foundation L3 (packaged logic) and L2 (logic state inspection).
export {
  LOGIC_PACKAGE_CARDS,
  LVC08A_CARD,
  type LogicPackageCard,
  type LogicUnit,
} from './logic/lvc08a.js';
export { packageRatings } from './parts/logicPackage.js';
export type { LogicInspection, LogicPinState } from './parts/logicInspection.js';
// Sprint 19B (F2): resistor power ratings from a verified datasheet series.
export {
  DEFAULT_RESISTOR_SERIES,
  RATING_AMBIENT_C,
  RESISTOR_SERIES,
  deratedPowerW,
  resistorRating,
  type ResistorSeries,
} from './resistorRating.js';
