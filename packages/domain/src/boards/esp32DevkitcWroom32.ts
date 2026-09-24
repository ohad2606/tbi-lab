/**
 * Board capability map: ESP32-DevKitC V4 with an ESP32-WROOM-32 class module (runtime R1).
 *
 * The authoritative definition of what each header pin IS on the real board, and what the TBI Lab
 * classic-ESP32 runtime SUPPORTS on it. The product must expose only capabilities this map
 * explicitly guarantees; nothing may be inferred from a GPIO number range.
 *
 * Sources (fetched 2026-09-24):
 *   [DK]  Espressif, "ESP32-DevKitC V4 User Guide", esp-dev-kits documentation (latest), sections
 *         Header Block J2 / J3 and notes [1]-[3]. Header order, labels and GPIO numbers below are
 *         copied from those tables. Note [2]: D0, D1, D2, D3, CMD and CLK connect the ESP32 to the
 *         SPI flash; avoid using them. Note [3]: GPIO16/17 are usable on ESP32-WROOM and
 *         ESP32-SOLO-1 boards (reserved on WROVER boards) - this map is for WROOM-32.
 *   [DS]  Espressif, "ESP32 Series Datasheet" v5.3 (sha256 a7917e6b...29adf):
 *         section 3 Boot Configurations, Table 3-1 - strapping pins GPIO0, GPIO2, MTDI (GPIO12),
 *         MTDO (GPIO15), GPIO5; Appendix A (IO_MUX) note 2 - GPIO34..39 are input-only and have no
 *         output driver and no internal pull-up/pull-down; Appendix A IO_MUX table (wpu/wpd) and
 *         section 4.8.1 GPIO - the other digital pads have configurable internal pull-up/pull-down
 *         (R_PU/R_PD 45 kOhm typ., section 5.3 DC Characteristics); U0TXD/U0RXD are GPIO1/GPIO3.
 *   [RT]  TBI Lab runtime R1 (docs/runtime/R1-REPORT.md): what the simulator implements.
 */

export type HeaderId = 'J2' | 'J3';
export type PinRole = 'power' | 'ground' | 'enable' | 'gpio' | 'flash' | 'console-uart';
/** Hardware internal pull capability of the pad. */
export type InternalPull = 'up-down' | 'none';
/**
 * What the TBI Lab runtime supports on the pin:
 *   digital-io     pinMode INPUT/OUTPUT, digitalWrite, digitalRead, both closed-loop with the circuit
 *   digital-input  pinMode INPUT, digitalRead only (the pad has no output driver)
 *   none           not usable in simulation (see `reason`)
 */
export type SimulatorSupport = 'digital-io' | 'digital-input' | 'none';

export interface BoardPin {
  header: HeaderId;
  /** 1-based position on the header, as in [DK]. */
  position: number;
  /** Silkscreen label, as in [DK]. */
  headerLabel: string;
  /** ESP32 GPIO number, or null for power / ground / EN. */
  gpio: number | null;
  exposed: true;
  /** Hardware: usable as a digital input by user firmware. */
  digitalInput: boolean;
  /** Hardware: usable as a digital output by user firmware. */
  digitalOutput: boolean;
  internalPull: InternalPull;
  role: PinRole;
  /** Sampled at reset to configure boot (see [DS] section 3). */
  strapping: boolean;
  simulatorSupport: SimulatorSupport;
  /** Why simulator support is limited, or the caveat that applies. */
  reason?: string;
}

const STRAP_CAVEAT =
  'Strapping pin: on real hardware its level at reset selects boot behaviour. The simulator does not sample it from the circuit and always boots normally from flash; digital I/O after boot is supported.';
const FLASH_REASON =
  'Connected to the module SPI flash ([DK] note 2): not available to user firmware on this board.';
const CONSOLE_REASON =
  'UART0 console (U0TXD/U0RXD): reserved for the serial monitor, not offered as a GPIO.';
const INPUT_ONLY_REASON =
  'Input-only pad: no output driver and no internal pull-up/pull-down ([DS]).';

type Row = Omit<BoardPin, 'exposed'>;

const power = (header: HeaderId, position: number, headerLabel: string): Row => ({
  header,
  position,
  headerLabel,
  gpio: null,
  digitalInput: false,
  digitalOutput: false,
  internalPull: 'none',
  role: headerLabel === 'GND' ? 'ground' : headerLabel === 'EN' ? 'enable' : 'power',
  strapping: false,
  simulatorSupport: 'none',
  reason:
    headerLabel === 'EN'
      ? 'Chip enable / reset: full-chip reset is not supported by the simulator in V1.'
      : 'Supply pin, not a GPIO.',
});

const io = (
  header: HeaderId,
  position: number,
  headerLabel: string,
  gpio: number,
  extra: Partial<Row> = {},
): Row => ({
  header,
  position,
  headerLabel,
  gpio,
  digitalInput: true,
  digitalOutput: true,
  internalPull: 'up-down',
  role: 'gpio',
  strapping: false,
  simulatorSupport: 'digital-io',
  ...extra,
});

const inputOnly = (header: HeaderId, position: number, headerLabel: string, gpio: number): Row =>
  io(header, position, headerLabel, gpio, {
    digitalOutput: false,
    internalPull: 'none',
    simulatorSupport: 'digital-input',
    reason: INPUT_ONLY_REASON,
  });

const strap = (header: HeaderId, position: number, headerLabel: string, gpio: number): Row =>
  io(header, position, headerLabel, gpio, { strapping: true, reason: STRAP_CAVEAT });

const flash = (header: HeaderId, position: number, headerLabel: string, gpio: number): Row =>
  io(header, position, headerLabel, gpio, {
    digitalInput: false,
    digitalOutput: false,
    role: 'flash',
    simulatorSupport: 'none',
    reason: FLASH_REASON,
  });

const console0 = (header: HeaderId, position: number, headerLabel: string, gpio: number): Row =>
  io(header, position, headerLabel, gpio, {
    role: 'console-uart',
    simulatorSupport: 'none',
    reason: CONSOLE_REASON,
  });

/** Header J2 then J3, in [DK] order. */
const ROWS: Row[] = [
  power('J2', 1, '3V3'),
  power('J2', 2, 'EN'),
  inputOnly('J2', 3, 'VP', 36),
  inputOnly('J2', 4, 'VN', 39),
  inputOnly('J2', 5, 'IO34', 34),
  inputOnly('J2', 6, 'IO35', 35),
  io('J2', 7, 'IO32', 32),
  io('J2', 8, 'IO33', 33),
  io('J2', 9, 'IO25', 25),
  io('J2', 10, 'IO26', 26),
  io('J2', 11, 'IO27', 27),
  io('J2', 12, 'IO14', 14),
  strap('J2', 13, 'IO12', 12),
  power('J2', 14, 'GND'),
  io('J2', 15, 'IO13', 13),
  flash('J2', 16, 'D2', 9),
  flash('J2', 17, 'D3', 10),
  flash('J2', 18, 'CMD', 11),
  power('J2', 19, '5V'),
  power('J3', 1, 'GND'),
  io('J3', 2, 'IO23', 23),
  io('J3', 3, 'IO22', 22),
  console0('J3', 4, 'TX', 1),
  console0('J3', 5, 'RX', 3),
  io('J3', 6, 'IO21', 21),
  power('J3', 7, 'GND'),
  io('J3', 8, 'IO19', 19),
  io('J3', 9, 'IO18', 18),
  strap('J3', 10, 'IO5', 5),
  io('J3', 11, 'IO17', 17),
  io('J3', 12, 'IO16', 16),
  io('J3', 13, 'IO4', 4),
  strap('J3', 14, 'IO0', 0),
  strap('J3', 15, 'IO2', 2),
  strap('J3', 16, 'IO15', 15),
  flash('J3', 17, 'D1', 8),
  flash('J3', 18, 'D0', 7),
  flash('J3', 19, 'CLK', 6),
];

export interface BoardCapabilityMap {
  id: 'board.esp32_devkitc_wroom32';
  mcu: 'esp32';
  module: 'ESP32-WROOM-32';
  pins: readonly BoardPin[];
  /** Runtime-wide limits that apply to every pin ([RT]). */
  simulatorLimitations: readonly string[];
  sources: readonly string[];
}

export const ESP32_DEVKITC_WROOM32: BoardCapabilityMap = {
  id: 'board.esp32_devkitc_wroom32',
  mcu: 'esp32',
  module: 'ESP32-WROOM-32',
  pins: ROWS.map((r) => ({ ...r, exposed: true as const })),
  simulatorLimitations: [
    'Internal pull-up/pull-down (INPUT_PULLUP / INPUT_PULLDOWN) is not modelled: the hardware capability is listed in internalPull, but the runtime does not yet apply it to the circuit.',
    'GPIO interrupts (attachInterrupt) are not modelled.',
    'Peripheral signals routed through the GPIO matrix (PWM/LEDC, UART1/2, I2C, SPI, RMT...) do not drive pads.',
    'Analog functions (ADC, DAC, touch) are not modelled.',
    'Open-drain mode and drive-strength selection are not modelled (the approved V1 pin model uses maximum drive strength).',
    'Boot strapping levels are not sampled from the circuit; the chip always boots from flash.',
    'Full-chip reset (EN, esp_restart, watchdog) is not supported in V1.',
  ],
  sources: [
    'Espressif, ESP32-DevKitC V4 User Guide, esp-dev-kits documentation (latest; fetched page sha256 2829b9924eaf1b744a59d317534509a3baa4a35e99e309f40ea25642cc5a7028), Header Block J2/J3 and notes [1]-[3], fetched 2026-09-24',
    'Espressif, ESP32 Series Datasheet v5.3 (sha256 a7917e6b47528c9dcab06837a49d452e582751335797db879f1cf2d17cd29adf), section 3 Boot Configurations (Table 3-1), section 4.8.1 GPIO, Appendix A IO_MUX table and note 2',
    'TBI Lab runtime R1 report, docs/runtime/R1-REPORT.md',
  ],
};

/** The pin for a GPIO number, if the board exposes it. */
export function boardPinForGpio(map: BoardCapabilityMap, gpio: number): BoardPin | undefined {
  return map.pins.find((p) => p.gpio === gpio);
}
