/**
 * Schematic symbols, drawn in component-local schematic units at rotation 0. Terminal
 * positions come from the domain catalog; the drawings here must end their leads exactly on
 * those points. Symbols contain no text at all, so they read correctly at every rotation; the one
 * exception is a character display's own content (the LCD), which is part of the physical face
 * and turns with it.
 */

import {
  ESP32_DEVKITC_WROOM32,
  boardPinPosition,
  boardTerminalId,
  type ComponentTypeId,
} from '@tbi-lab/domain';

/** Visual state some symbols depict. Presentation only: never an electrical input. */
export interface SymbolState {
  /** Toggle switch: the persisted position. */
  closed?: boolean;
  /** Push button: held right now (transient runtime input). */
  pressed?: boolean;
  /** Relay: the armature position the solver settled (runtime result; rest position otherwise). */
  energized?: boolean;
  /** Buzzer: sounding in the solved operating point (runtime result). */
  sounding?: boolean;
  /** PIR sensor: the simulated motion in front of it (persisted environment parameter). */
  motion?: boolean;
  /** PIR sensor, ultrasonic module: its solved output level is high (runtime result). */
  outputHigh?: boolean;
  /**
   * Character LCD (Sprint 12): what the engine reports the display shows, verbatim (each line 16
   * characters, already mapped from the controller's character ROM). Absent: a blank, unlit panel.
   */
  lcd?: LcdView;
  /**
   * Servo (Sprint 15): the output shaft's angle the engine or the runtime reports (0..180 deg).
   * Absent: the rest position, 90 deg.
   */
  servoAngle?: number;
}

export interface LcdView {
  backlight: boolean;
  displayOn: boolean;
  lines: readonly [string, string];
}

/**
 * The LCD state from a part's solved `state` (the engine contract: powered, backlight, displayOn,
 * line1, line2), or undefined when there is none. Nothing is invented: an unpowered display, or
 * one whose controller has its display off, shows no characters.
 */
export function lcdView(state: Record<string, unknown> | undefined): LcdView | undefined {
  if (!state || typeof state.line1 !== 'string' || typeof state.line2 !== 'string')
    return undefined;
  const powered = state.powered === true;
  return {
    backlight: powered && state.backlight === true,
    displayOn: powered && state.displayOn === true,
    lines: [state.line1, state.line2],
  };
}

/** LCD 16x2 face (symbol units): the viewing window and the 5x8-dot character cells. */
export const LCD_COLS = 16;
export const LCD_CELL = { w: 9, h: 15, pitch: 10.5 } as const;
export const LCD_WINDOW = { x: -24, y: -29, w: 172, h: 38 } as const;
export const LCD_ROWS = [-18.5, -1.5] as const;
export const lcdCellX = (i: number) =>
  LCD_WINDOW.x + (LCD_WINDOW.w - LCD_COLS * LCD_CELL.pitch) / 2 + LCD_CELL.pitch * (i + 0.5);

/** The characters of one LCD line, one per cell (code points, never reordered). */
export const lcdChars = (line: string): string[] => Array.from(line).slice(0, LCD_COLS);

/** Module leads: from each left-side terminal (x0, y) in to the body edge at x1. */
const leftLeads = (x0: number, x1: number, ys: number[]) =>
  ys.map((y) => <line key={y} x1={x0} y1={y} x2={x1} y2={y} />);

export interface SymbolDef {
  /** Local bounding box [minX, minY, maxX, maxY] at rotation 0, including leads. */
  bbox: [number, number, number, number];
  draw: (state?: SymbolState) => preact.JSX.Element;
  /**
   * The operable part of a switch symbol (local coordinates). Pointer input there actuates
   * the switch instead of selecting or dragging the component.
   */
  actuator?: [number, number, number, number];
}

/** Two contact points of a switch, with leads to the terminals. */
const contacts = () => (
  <>
    <line x1={-40} y1={0} x2={-16} y2={0} />
    <line x1={16} y1={0} x2={40} y2={0} />
    <circle cx={-16} cy={0} r={2.5} class="contact" />
    <circle cx={16} cy={0} r={2.5} class="contact" />
  </>
);

/**
 * Classic ESP32 DevKitC (Sprint 6): board outline, WROOM module can, and one stub per header
 * position. Connectable pins run out to their terminal point; pins the simulator does not offer
 * (power, EN, flash, UART0 console, the other GND pins) are short dashed stubs that stop at the
 * board edge, so they visibly cannot be wired. Pin names are drawn by the canvas, upright.
 */
function esp32Board() {
  return (
    <>
      <rect x={-60} y={-196} width={120} height={392} rx={6} class="symbol-body" />
      <rect x={-22} y={-186} width={44} height={80} rx={3} class="board-module" />
      {ESP32_DEVKITC_WROOM32.pins.map((pin) => {
        const p = boardPinPosition(pin);
        const edge = p.x < 0 ? -60 : 60;
        const connectable = boardTerminalId(pin) !== undefined;
        return connectable ? (
          <line key={`${pin.header}${pin.position}`} x1={edge} y1={p.y} x2={p.x} y2={p.y} />
        ) : (
          <line
            key={`${pin.header}${pin.position}`}
            x1={edge}
            y1={p.y}
            x2={edge + (p.x < 0 ? -8 : 8)}
            y2={p.y}
            class="pin-unavailable"
          />
        );
      })}
    </>
  );
}

/** Emission arrows (the conventional LED mark), from (x, y) up and to the right. */
const emission = (x: number, y: number) => (
  <>
    <line x1={x} y1={y} x2={x + 8} y2={y - 8} />
    <polyline points={`${x + 4},${y - 8} ${x + 8},${y - 8} ${x + 8},${y - 4}`} />
    <line x1={x + 8} y1={y + 4} x2={x + 16} y2={y - 4} />
    <polyline points={`${x + 12},${y - 4} ${x + 16},${y - 4} ${x + 16},${y}`} />
  </>
);

/** LED matrix 8x8: dot centres (row-major), inside the 32 mm package outline. */
export const MATRIX_ROWS = Array.from({ length: 8 }, (_, i) => -70 + 20 * i);
export const MATRIX_COLS = Array.from({ length: 8 }, (_, j) => -80 + 20 * j);

/** RGB LED (common cathode): one emitter per channel, cathodes on a common bar. */
export const RGB_CHANNELS = [
  { id: 'red', y: -20 },
  { id: 'green', y: 0 },
  { id: 'blue', y: 20 },
] as const;
export const rgbTriangle = (y: number) => `-8,${y - 6} -8,${y + 6} 4,${y}`;

/** Servo (top view): the output shaft near the case's right end. */
export const SERVO_SHAFT = { x: 22, y: 0 } as const;
/** The rest angle a servo is drawn at when nothing reports its position (deg). */
export const SERVO_REST_DEG = 90;

/** The servo's shaft angle from its solved `state` (engine contract: `angleDeg`), if reported. */
export function servoAngle(state: Record<string, unknown> | undefined): number | undefined {
  const a = state?.angleDeg;
  return typeof a === 'number' && Number.isFinite(a) ? a : undefined;
}

/**
 * The horn's drawing rotation (SVG degrees) for a shaft angle: 0 deg points along +x, increasing
 * angles turn counter-clockwise as seen from above (the SG90 sheet: a longer pulse turns it
 * "left"), clamped to the 0..180 deg travel the model reports.
 */
export const servoHornRotation = (angleDeg: number | undefined): number =>
  -Math.min(180, Math.max(0, angleDeg ?? SERVO_REST_DEG));

export const SYMBOLS: Record<ComponentTypeId, SymbolDef> = {
  'component.rgb_led': {
    bbox: [-40, -30, 40, 28],
    draw: () => (
      <>
        {RGB_CHANNELS.map(({ id, y }) => (
          <g key={id}>
            <line x1={-40} y1={y} x2={-8} y2={y} />
            <polygon points={rgbTriangle(y)} class="led-body" />
            <line x1={4} y1={y - 6} x2={4} y2={y + 6} />
            <line x1={4} y1={y} x2={16} y2={y} />
          </g>
        ))}
        <line x1={16} y1={-20} x2={16} y2={20} />
        <line x1={16} y1={0} x2={40} y2={0} />
        {emission(20, -18)}
      </>
    ),
  },
  'component.capacitor': {
    bbox: [-40, -14, 40, 14],
    draw: () => (
      <>
        <line x1={-40} y1={0} x2={-5} y2={0} />
        <line x1={-5} y1={-13} x2={-5} y2={13} class="actuator-part" />
        <line x1={5} y1={-13} x2={5} y2={13} class="actuator-part" />
        <line x1={5} y1={0} x2={40} y2={0} />
      </>
    ),
  },
  'component.photoresistor': {
    bbox: [-40, -28, 40, 10],
    draw: () => (
      <>
        <line x1={-40} y1={0} x2={-24} y2={0} />
        <polyline points="-24,0 -20,-8 -12,8 -4,-8 4,8 12,-8 20,8 24,0" />
        <line x1={24} y1={0} x2={40} y2={0} />
        {/* Incoming light: arrows pointing AT the resistor (an LED's point away from it). */}
        <line x1={-18} y1={-26} x2={-8} y2={-14} />
        <polyline points="-12,-14 -8,-14 -8,-18" />
        <line x1={-2} y1={-26} x2={8} y2={-14} />
        <polyline points="4,-14 8,-14 8,-18" />
      </>
    ),
  },
  'component.buzzer': {
    bbox: [-40, -22, 40, 6],
    draw: (state) => (
      <>
        <line x1={-40} y1={0} x2={-12} y2={0} />
        <line x1={12} y1={0} x2={40} y2={0} />
        <path d="M -12 2 L -12 -4 A 12 12 0 0 1 12 -4 L 12 2 Z" class="symbol-body" />
        {/* + at the positive lead, as geometry (correct at every rotation). */}
        <line x1={-30} y1={-8} x2={-22} y2={-8} />
        <line x1={-26} y1={-12} x2={-26} y2={-4} />
        {state?.sounding && (
          <g class="buzz-wave">
            <path d="M 16 -16 A 8 8 0 0 1 16 -6" />
            <path d="M 21 -20 A 13 13 0 0 1 21 -2" />
          </g>
        )}
      </>
    ),
  },
  'component.bjt_npn': {
    bbox: [-40, -40, 26, 40],
    // NPN: base bar, collector up, emitter down with the arrow pointing out of the emitter.
    draw: () => (
      <>
        <circle cx={4} cy={0} r={20} class="symbol-body" />
        <line x1={-40} y1={0} x2={-6} y2={0} />
        <line x1={-6} y1={-13} x2={-6} y2={13} class="actuator-part" />
        <line x1={-6} y1={-6} x2={20} y2={-22} />
        <line x1={20} y1={-22} x2={20} y2={-40} />
        <line x1={-6} y1={6} x2={20} y2={22} />
        <line x1={20} y1={22} x2={20} y2={40} />
        <polygon points="20,22 10,21 15,14" class="diode-body" />
      </>
    ),
  },
  'display.led_matrix_8x8': {
    bbox: [-100, -140, 80, 140],
    // The package: its 16 pins as on the part (front and rear edges; the canvas names each pin's
    // row or column line), the dot grid on the black face. Each dot glows by its own solved
    // current (Canvas), never from stored state.
    draw: () => (
      <>
        <rect x={-100} y={-100} width={180} height={200} rx={4} class="matrix-face" />
        {MATRIX_COLS.map((x) => (
          <g key={x}>
            <line x1={x} y1={100} x2={x} y2={140} />
            <line x1={x} y1={-100} x2={x} y2={-140} />
          </g>
        ))}
        {MATRIX_ROWS.flatMap((y) =>
          MATRIX_COLS.map((x) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r={6} class="matrix-dot" />
          )),
        )}
      </>
    ),
  },
  'sensor.pir_hc_sr501': {
    bbox: [-60, -40, 50, 40],
    // Module board with the Fresnel dome; pin marks: ground bars at GND, an output arrow at OUT,
    // + at VCC. Clicking the dome toggles the simulated motion in front of it.
    actuator: [-12, -32, 42, 32],
    draw: (state) => (
      <>
        <rect x={-40} y={-36} width={88} height={72} rx={4} class="symbol-body" />
        <line x1={-60} y1={-20} x2={-40} y2={-20} />
        <line x1={-60} y1={0} x2={-40} y2={0} />
        <line x1={-60} y1={20} x2={-40} y2={20} />
        <line x1={-34} y1={-26} x2={-34} y2={-14} />
        <line x1={-31} y1={-24} x2={-31} y2={-16} />
        <polyline points="-36,-4 -30,0 -36,4" class={state?.outputHigh ? 'pir-out-high' : ''} />
        <line x1={-36} y1={20} x2={-28} y2={20} />
        <line x1={-32} y1={16} x2={-32} y2={24} />
        <circle cx={15} cy={0} r={25} class="pir-dome" />
        <circle cx={15} cy={0} r={16} class="pir-dome-ring" />
        <circle cx={15} cy={0} r={7} class="pir-dome-ring" />
        {state?.motion && (
          <g class="pir-motion">
            <path d="M 44 -22 A 30 30 0 0 1 44 22" />
            <path d="M 38 -14 A 20 20 0 0 1 38 14" />
          </g>
        )}
      </>
    ),
  },
  'sensor.hc_sr04': {
    bbox: [-60, -50, 46, 30],
    // The module board, header on the left (VCC, TRIG, ECHO, GND as on the part; the canvas names
    // each pin), and its two transducers (transmitter, receiver). The ECHO lead is marked while
    // the solved output is high.
    draw: (state) => (
      <>
        <rect x={-44} y={-50} width={90} height={80} rx={4} class="symbol-body" />
        {leftLeads(-60, -44, [-40, -20, 20])}
        <line x1={-60} y1={0} x2={-44} y2={0} class={state?.outputHigh ? 'pin-out-high' : ''} />
        {[-29, 9].map((y) => (
          <g key={y}>
            <circle cx={22} cy={y} r={17} class="us-can" />
            <circle cx={22} cy={y} r={11} class="us-mesh" />
          </g>
        ))}
      </>
    ),
  },
  'sensor.dht22': {
    bbox: [-60, -50, 30, 30],
    // The white case, pins on the left (VDD, DATA, NC, GND as on the part), the vent grille.
    draw: () => (
      <>
        <rect x={-44} y={-50} width={74} height={80} rx={3} class="symbol-body" />
        {leftLeads(-60, -44, [-40, -20, 0, 20])}
        {[-40, -30, -20, -10, 0, 10].flatMap((y) =>
          [-6, 6].map((x) => (
            <rect key={`${x},${y}`} x={x} y={y} width={10} height={6} rx={1} class="dht-vent" />
          )),
        )}
      </>
    ),
  },
  'display.lcd1602_i2c': {
    bbox: [-80, -58, 152, 38],
    // The module: the I2C backpack's header on the left (GND, VCC, SDA, SCL; the canvas names each
    // pin), the bezel and the 16x2 character window. Lit and filled ONLY from the engine's result.
    draw: (state) => {
      const lcd = state?.lcd;
      return (
        <>
          <rect x={-64} y={-58} width={216} height={96} rx={3} class="symbol-body" />
          {leftLeads(-80, -64, [-40, -20, 0, 20])}
          <rect x={-28} y={-37} width={178} height={54} rx={2} class="lcd-bezel" />
          <rect
            x={LCD_WINDOW.x}
            y={LCD_WINDOW.y}
            width={LCD_WINDOW.w}
            height={LCD_WINDOW.h}
            class={lcd?.backlight ? 'lcd-window lcd-lit' : 'lcd-window'}
          />
          {LCD_ROWS.flatMap((y) =>
            Array.from({ length: LCD_COLS }, (_, i) => (
              <rect
                key={`${i},${y}`}
                x={lcdCellX(i) - LCD_CELL.w / 2}
                y={y - LCD_CELL.h / 2}
                width={LCD_CELL.w}
                height={LCD_CELL.h}
                class="lcd-cell"
              />
            )),
          )}
          {lcd?.displayOn && (
            // Verbatim, one character per cell, always left to right (dir is LTR in every locale).
            <g class="lcd-text" direction="ltr" data-testid="lcd-text">
              {lcd.lines.flatMap((line, row) =>
                lcdChars(line).map((ch, i) =>
                  ch === ' ' ? null : (
                    <text
                      key={`${row}.${i}`}
                      x={lcdCellX(i)}
                      y={LCD_ROWS[row]! + 5}
                      text-anchor="middle"
                      direction="ltr"
                    >
                      {ch}
                    </text>
                  ),
                ),
              )}
            </g>
          )}
        </>
      );
    },
  },
  'component.servo_sg90': {
    bbox: [-60, -28, 52, 28],
    // Top view: the case with its two mounting tabs, the three-wire lead on the left (GND, +V,
    // signal, in the connector's order), the gear tower and the horn on the output shaft. The horn
    // shows the angle the engine reports (rest: 90 deg), never a commanded or invented one.
    draw: (state) => (
      <>
        <rect x={-52} y={-12} width={104} height={24} rx={2} class="servo-tab" />
        <rect x={-44} y={-28} width={88} height={56} rx={3} class="symbol-body servo-case" />
        {leftLeads(-60, -44, [-20, 0, 20])}
        <circle cx={SERVO_SHAFT.x} cy={SERVO_SHAFT.y} r={13} class="servo-tower" />
        <g
          class="servo-horn"
          transform={`rotate(${servoHornRotation(state?.servoAngle)} ${SERVO_SHAFT.x} ${SERVO_SHAFT.y})`}
        >
          <rect x={SERVO_SHAFT.x - 6} y={SERVO_SHAFT.y - 4} width={32} height={8} rx={4} />
          <circle cx={SERVO_SHAFT.x} cy={SERVO_SHAFT.y} r={6} />
        </g>
        <circle cx={SERVO_SHAFT.x} cy={SERVO_SHAFT.y} r={2} class="servo-screw" />
      </>
    ),
  },
  'component.relay': {
    bbox: [-60, -28, 60, 40],
    // Coil and change-over contact; the dashed link is mechanical, not electrical. The blade shows
    // the armature position the solver settled (rest = on NC).
    draw: (state) => {
      const tip = state?.energized ? { x: 38, y: 1 } : { x: 37, y: -18 };
      return (
        <>
          <line x1={-60} y1={-20} x2={-32} y2={-20} />
          <line x1={-32} y1={-20} x2={-32} y2={-12} />
          <line x1={-60} y1={20} x2={-32} y2={20} />
          <line x1={-32} y1={20} x2={-32} y2={12} />
          <rect x={-44} y={-12} width={24} height={24} class="symbol-body" />
          <line x1={-44} y1={12} x2={-20} y2={-12} />
          <line
            x1={-20}
            y1={0}
            x2={(20 + tip.x) / 2}
            y2={(8 + tip.y) / 2}
            class="mechanical-link"
          />
          <line x1={20} y1={40} x2={20} y2={8} />
          <circle cx={20} cy={8} r={2.5} class="contact" />
          <line x1={20} y1={8} x2={tip.x} y2={tip.y} class="relay-blade" />
          <circle cx={40} cy={-20} r={2.5} class="contact" />
          <line x1={40} y1={-20} x2={60} y2={-20} />
          <circle cx={40} cy={0} r={2.5} class="contact" />
          <line x1={40} y1={0} x2={60} y2={0} />
        </>
      );
    },
  },
  'board.esp32_devkitc_wroom32': {
    bbox: [-80, -196, 80, 196],
    draw: esp32Board,
  },
  'component.resistor': {
    bbox: [-40, -10, 40, 10],
    draw: () => (
      <>
        <line x1={-40} y1={0} x2={-24} y2={0} />
        <polyline points="-24,0 -20,-8 -12,8 -4,-8 4,8 12,-8 20,8 24,0" />
        <line x1={24} y1={0} x2={40} y2={0} />
      </>
    ),
  },
  'component.led': {
    bbox: [-40, -26, 40, 14],
    draw: () => (
      <>
        <line x1={-40} y1={0} x2={-12} y2={0} />
        {/* Diode triangle pointing from anode to cathode, with the cathode bar. */}
        <polygon points="-12,-12 -12,12 12,0" class="led-body" />
        <line x1={12} y1={-12} x2={12} y2={12} />
        <line x1={12} y1={0} x2={40} y2={0} />
        {/* Emission arrows: the conventional LED mark, not an illumination display. */}
        <line x1={-2} y1={-14} x2={6} y2={-22} />
        <polyline points="2,-22 6,-22 6,-18" />
        <line x1={6} y1={-10} x2={14} y2={-18} />
        <polyline points="10,-18 14,-18 14,-14" />
      </>
    ),
  },
  'component.diode': {
    bbox: [-40, -12, 40, 12],
    draw: () => (
      <>
        <line x1={-40} y1={0} x2={-12} y2={0} />
        <polygon points="-12,-12 -12,12 12,0" class="diode-body" />
        <line x1={12} y1={-12} x2={12} y2={12} />
        <line x1={12} y1={0} x2={40} y2={0} />
      </>
    ),
  },
  'component.push_button': {
    bbox: [-40, -28, 40, 6],
    actuator: [-22, -30, 22, 2],
    // Normally open: the bridging bar sits above the contacts and touches them only while held.
    draw: (state) => {
      const y = state?.pressed ? -3 : -12;
      return (
        <>
          {contacts()}
          <line x1={-20} y1={y} x2={20} y2={y} class="actuator-part" />
          <line x1={0} y1={y} x2={0} y2={y - 12} class="actuator-part" />
          <line x1={-8} y1={y - 12} x2={8} y2={y - 12} class="actuator-part" />
        </>
      );
    },
  },
  'component.toggle_switch': {
    bbox: [-40, -24, 40, 6],
    actuator: [-20, -26, 22, 4],
    // SPST: the blade pivots on the left contact and rests on the right one when closed.
    draw: (state) => (
      <>
        {contacts()}
        <line
          x1={-16}
          y1={0}
          x2={state?.closed ? 16 : 13}
          y2={state?.closed ? 0 : -18}
          class="actuator-part"
        />
      </>
    ),
  },
  'component.ground': {
    bbox: [-16, -20, 16, 12],
    draw: () => (
      <>
        <line x1={0} y1={-20} x2={0} y2={0} />
        <line x1={-16} y1={0} x2={16} y2={0} />
        <line x1={-10} y1={6} x2={10} y2={6} />
        <line x1={-4} y1={12} x2={4} y2={12} />
      </>
    ),
  },
  'instrument.lab_psu': {
    bbox: [-40, -40, 40, 40],
    draw: () => (
      <>
        <rect x={-40} y={-40} width={60} height={80} rx={4} class="symbol-body" />
        <line x1={20} y1={-20} x2={40} y2={-20} />
        <line x1={20} y1={20} x2={40} y2={20} />
        {/* + and − drawn as geometry, not text, so they stay correct under rotation. */}
        <line x1={4} y1={-20} x2={14} y2={-20} />
        <line x1={9} y1={-25} x2={9} y2={-15} />
        <line x1={4} y1={20} x2={14} y2={20} />
        {/* DC mark (⎓): a solid line over a dashed line. */}
        <line x1={-30} y1={-3} x2={-10} y2={-3} />
        <line x1={-30} y1={4} x2={-24} y2={4} />
        <line x1={-23} y1={4} x2={-17} y2={4} />
        <line x1={-16} y1={4} x2={-10} y2={4} />
      </>
    ),
  },
};
