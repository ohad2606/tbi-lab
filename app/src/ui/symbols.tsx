/**
 * Schematic symbols, drawn in component-local schematic units at rotation 0. Terminal
 * positions come from the domain catalog; the drawings here must end their leads exactly on
 * those points. Symbols contain no text at all, so they read correctly at every rotation.
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
}

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

/** RGB LED (common cathode): one emitter per channel, cathodes on a common bar. */
export const RGB_CHANNELS = [
  { id: 'red', y: -20 },
  { id: 'green', y: 0 },
  { id: 'blue', y: 20 },
] as const;
export const rgbTriangle = (y: number) => `-8,${y - 6} -8,${y + 6} 4,${y}`;

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
