/**
 * Sprint 29 (Workstream A): the MicroPython SUPPORT CONTRACT for the Classic ESP32 — every
 * hardware-facing API a program can reach, with one status and where it is decided:
 *
 * - `supported`: runs on the genuine interpreter in QEMU and its electrical effect is simulated
 *   (the evidence names the real-QEMU test);
 * - `refused`: never silently accepted — refused BY NAME at Build (the Build analysis, a
 *   `build.feature.*` text), when the session is created (`session`), or at the access while it
 *   runs (`run`: Runtime v5 `unmodelled` / the host's electrical checks);
 * - `unknown`: reachable, but not verified on the real stack; listed so it is never claimed (none
 *   remain after Sprint 29: Signal, PWM.duty() and level interrupts were verified).
 *
 * `probe` is a minimal program; `pyContract.test.ts` checks every probe against the Build
 * analysis (a supported or run-time entry must pass Build; a Build refusal must report exactly
 * its id), so the table cannot drift from the code. Language-neutral ids; the app localizes.
 */
export type ContractStatus = 'supported' | 'refused' | 'unknown';
export type DecidedAt = 'build' | 'session' | 'run';

export interface ContractEntry {
  /** Stable id (language-neutral). */
  id: string;
  /** The API as written in MicroPython (technical, LTR). */
  api: string;
  status: ContractStatus;
  /** Where a refusal (or a supported entry's checks) take effect. */
  at: DecidedAt;
  /** The refusal id the user sees (Build feature id, session field or run-time code). */
  refusal?: string;
  /** Capabilities of the runtime the program then requires. */
  requires?: string[];
  /** Conditions and limits of a supported entry, or the reason for a refusal. */
  note: string;
  /** The real-QEMU (or unit) test that proves it. */
  evidence: string;
  /** A minimal program exercising it (checked against the Build analysis). */
  probe: string;
}

const pin = 'from machine import Pin\n';

export const MICROPYTHON_CONTRACT: readonly ContractEntry[] = [
  {
    id: 'gpio_output',
    api: 'Pin(n, Pin.OUT); value(), on(), off()',
    status: 'supported',
    at: 'run',
    note: 'the pad drives the circuit (ESP32 V_OH/V_OL guarantees); a pad carrying a real load is checked against its ratings',
    evidence: 'runtime/tests/s24-mpy.runtime.test.ts "M1c blink"',
    probe: `${pin}p = Pin(4, Pin.OUT)\np.value(1)\np.on()\np.off()\n`,
  },
  {
    id: 'gpio_input',
    api: 'Pin(n, Pin.IN).value()',
    status: 'supported',
    at: 'run',
    requires: ['input-read'],
    note: 'the level the circuit gives the pad (V_IH/V_IL); a read of an undefined or unconnected pad ends the run by name (register-wide, Sprint 25)',
    evidence: 'runtime/tests/s24-mpy.runtime.test.ts "M2 button"; s29-mpy-monitor.runtime.test.ts',
    probe: `${pin}print(Pin(34, Pin.IN).value())\n`,
  },
  {
    id: 'gpio_internal_pull',
    api: 'Pin.PULL_UP / PULL_DOWN / PULL_HOLD, pull=',
    status: 'refused',
    at: 'session',
    refusal: 'internalPull',
    note: 'the internal pull resistance is not characterized for the simulation: use a real resistor in the circuit',
    evidence: 'runtime/tests/s19b-mpy.runtime.test.ts "an internal pull (Pin.PULL_UP) is refused"',
    probe: `${pin}Pin(4, Pin.IN, Pin.PULL_UP)\n`,
  },
  {
    id: 'gpio_drive_strength',
    api: 'Pin(..., drive=Pin.DRIVE_n)',
    status: 'refused',
    at: 'build',
    refusal: 'drive_strength',
    note: 'the drive strengths are not characterized',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: `${pin}Pin(4, Pin.OUT, drive=Pin.DRIVE_3)\n`,
  },
  {
    id: 'signal_drive',
    api: 'Signal(Pin(n, Pin.OUT), invert=...); on(), off()',
    status: 'supported',
    at: 'run',
    note: 'drives the pad like Pin (inverted when asked); reading back through Signal.value() is not resolved to a pin by the Build analysis, so the run watches every pad and is refused at the read while any pad is unconnected (fail closed)',
    evidence: 'runtime/tests/s29-mpy-contract.runtime.test.ts "machine.Signal(invert=True)"',
    probe: 'from machine import Pin, Signal\ns = Signal(Pin(4, Pin.OUT), invert=True)\ns.on()\n',
  },
  {
    id: 'pwm',
    api: 'PWM(Pin(n), freq=, duty_u16=|duty=); duty_u16(), duty(), freq()',
    status: 'supported',
    at: 'run',
    note: 'high-speed LEDC: the load sees the average (duty × the HIGH operating point); low-speed mode, other resolutions or a too-fast reconfiguration end the run by name (pwm_unsupported_mode, pwm_rate_exceeded); a duty of 0 into a load is refused',
    evidence:
      'runtime/tests/s19b-mpy.runtime.test.ts "GPIO + high-speed PWM"; s29-mpy-contract.runtime.test.ts "PWM.duty(512)"',
    probe:
      'from machine import Pin, PWM\nPWM(Pin(18), freq=1000, duty_u16=2048)\nPWM(Pin(19), freq=1000, duty=512)\n',
  },
  {
    id: 'irq_edge',
    api: 'Pin.irq(handler, trigger=Pin.IRQ_RISING | Pin.IRQ_FALLING)',
    status: 'supported',
    at: 'run',
    requires: ['gpio-irq'],
    note: 'edge interrupts delivered by Runtime v5 in order; latency up to one emulator slice (the cores run in turn)',
    evidence: 'runtime/tests/s25-irq.runtime.test.ts "MicroPython Pin.irq"',
    probe: `${pin}Pin(34, Pin.IN).irq(handler=lambda p: None, trigger=Pin.IRQ_RISING)\n`,
  },
  {
    id: 'irq_level',
    api: 'Pin.irq(trigger=<level type>), wake=',
    status: 'refused',
    at: 'run',
    refusal: 'unmodelled:interrupt',
    requires: ['gpio-irq'],
    note: 'level, NMI and wake-up interrupts are not modelled; refused at the register write, before the handler is armed (MicroPython 1.29 has no IRQ_*_LEVEL constants; a numeric level type reaches it)',
    evidence: 'runtime/tests/s29-mpy-contract.runtime.test.ts "Pin.irq with a level trigger"',
    probe: `${pin}Pin(34, Pin.IN).irq(handler=lambda p: None, trigger=4)\n`,
  },
  {
    id: 'timing',
    api: 'time.sleep, sleep_ms, sleep_us, ticks_ms, ticks_us, ticks_diff',
    status: 'supported',
    at: 'run',
    note: 'simulation time; deterministic (two runs give the same transcript and electrical sequence)',
    evidence:
      'runtime/tests/s19b-mpy.runtime.test.ts (determinism); s24-mpy.runtime.test.ts "M1c blink"',
    probe:
      'import time\ntime.sleep_ms(1)\nt = time.ticks_ms()\nprint(time.ticks_diff(time.ticks_ms(), t))\n',
  },
  {
    id: 'pulse_timing',
    api: 'machine.time_pulse_us(pin, level, timeout_us)',
    status: 'supported',
    at: 'run',
    requires: ['input-read'],
    note: 'times a pulse on an input from the edges the circuit gives it (e.g. the HC-SR04 echo): within ±2 µs measured, up to ≈ 13 µs late inside the other core’s interval (the timing contract, as pulseIn); −2 when no pulse starts within the timeout, −1 when it does not end; it measures from the call if the pin is already at the level',
    evidence: 'runtime/tests/mpy-distance.runtime.test.ts (2 cm to 4 m, −10/20/40 °C, timeouts)',
    probe: `${pin}from machine import time_pulse_us\nprint(time_pulse_us(Pin(18, Pin.IN), 1, 30000))\n`,
  },
  {
    id: 'i2c',
    api: 'I2C(0, scl=Pin(22), sda=Pin(21), freq<=100000); scan(), writeto()',
    status: 'supported',
    at: 'build',
    requires: ['i2c', 'i2c-clock'],
    note: 'literal arguments on bus 0 (GPIO22/21) up to 100 kHz, writes to the simulated LCD backpack; the programmed clock is also checked at every START',
    evidence:
      'runtime/tests/s24-i2c.runtime.test.ts "mpy-lcd-hello"; s26-multifile.runtime.test.ts',
    probe:
      "from machine import Pin, I2C\ni = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)\ni.scan()\ni.writeto(0x27, b'x')\n",
  },
  {
    id: 'i2c_frequency',
    api: 'I2C(..., freq>100000)',
    status: 'refused',
    at: 'build',
    refusal: 'i2c_frequency',
    note: 'faster than the PCF8574 backpack is rated for (100 kHz)',
    evidence: 'runtime/tests/s24-i2c.runtime.test.ts "Build refusals by name"',
    probe: 'from machine import Pin, I2C\nI2C(0, scl=Pin(22), sda=Pin(21), freq=400000)\n',
  },
  {
    id: 'i2c_read',
    api: 'I2C readfrom / readfrom_into / readfrom_mem / writeto_mem',
    status: 'refused',
    at: 'build',
    refusal: 'i2c_operation',
    note: 'no simulated part answers these',
    evidence: 'runtime/tests/s24-i2c.runtime.test.ts "Build refusals by name"',
    probe:
      'from machine import Pin, I2C\ni = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)\ni.readfrom(0x27, 1)\n',
  },
  {
    id: 'soft_i2c',
    api: 'SoftI2C',
    status: 'refused',
    at: 'build',
    refusal: 'i2c',
    note: 'bit-banged I2C is not verified on the runtime',
    evidence: 'runtime/builder/tests/py-features.test.ts "SoftI2C stays refused"',
    probe: 'from machine import Pin, SoftI2C\nSoftI2C(scl=Pin(22), sda=Pin(21))\n',
  },
  {
    id: 'adc',
    api: 'ADC(Pin(n)).read(), read_u16(), read_uv(), atten()',
    status: 'refused',
    at: 'run',
    refusal: 'unmodelled:adc',
    note: 'the emulator’s SAR ADC crashes the guest and no transfer function is characterized; refused at the access, before any value reaches the program (no Guru Meditation)',
    evidence:
      'runtime/tests/s19b-mpy.runtime.test.ts "ADC (machine.ADC.read_u16) is refused by name"',
    probe: 'from machine import Pin, ADC\nprint(ADC(Pin(34)).read_u16())\n',
  },
  {
    id: 'dac',
    api: 'DAC',
    status: 'refused',
    at: 'build',
    refusal: 'dac',
    note: 'not modelled',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'from machine import Pin, DAC\nDAC(Pin(25)).write(128)\n',
  },
  {
    id: 'spi',
    api: 'SPI, SoftSPI',
    status: 'refused',
    at: 'build',
    refusal: 'spi',
    note: 'not modelled',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'from machine import SPI\nSPI(1)\n',
  },
  {
    id: 'touch',
    api: 'TouchPad',
    status: 'refused',
    at: 'build',
    refusal: 'touch',
    note: 'capacitive sensing is not modelled',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'from machine import Pin, TouchPad\nTouchPad(Pin(4)).read()\n',
  },
  {
    id: 'timer',
    api: 'Timer, disable_irq, enable_irq',
    status: 'refused',
    at: 'build',
    refusal: 'interrupt',
    note: 'hardware timer interrupts are not modelled (use time.sleep_ms / ticks)',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'from machine import Timer\nTimer(0)\n',
  },
  {
    id: 'uart',
    api: 'UART',
    status: 'refused',
    at: 'build',
    refusal: 'library:machine.UART',
    note: 'UART0 is the serial monitor; other UARTs are not modelled',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'from machine import UART\nUART(1)\n',
  },
  {
    id: 'rtc',
    api: 'RTC',
    status: 'refused',
    at: 'build',
    refusal: 'library:machine.RTC',
    note: 'not modelled',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'from machine import RTC\nRTC()\n',
  },
  {
    id: 'cpu_frequency',
    api: 'machine.freq(hz)',
    status: 'refused',
    at: 'build',
    refusal: 'cpu_frequency',
    note: 'a lowered clock stalls the emulator, a raised one is not detectable at run time; reading machine.freq() is allowed',
    evidence: 'runtime/tests/s19b-mpy.runtime.test.ts "a CPU clock change … is refused at Build"',
    probe: 'import machine\nmachine.freq(80000000)\n',
  },
  {
    id: 'sleep_modes',
    api: 'lightsleep, deepsleep, sleep, wake_reason',
    status: 'refused',
    at: 'build',
    refusal: 'sleep',
    note: 'not modelled',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'import machine\nmachine.deepsleep(1000)\n',
  },
  {
    id: 'restart',
    api: 'machine.reset, soft_reset, WDT',
    status: 'refused',
    at: 'session',
    refusal: 'restart',
    note: 'a full-chip restart is not supported in V1',
    evidence: 'runtime/host/session.ts (restart refused at session creation)',
    probe: 'import machine\nmachine.reset()\n',
  },
  {
    id: 'dynamic_access',
    api: 'getattr with a computed name, vars(), globals(), exec, eval, sys.modules, …',
    status: 'refused',
    at: 'build',
    refusal: 'dynamic_access',
    note: 'the Build analysis reads written names only (Sprint 28 L7, fail closed)',
    evidence: 'runtime/tests/s19b-mpy.runtime.test.ts; runtime/builder/tests/py-features.test.ts',
    probe: "import machine\ngetattr(machine, 'P' + 'in')\n",
  },
  {
    id: 'serial_input',
    api: 'input(), sys.stdin',
    status: 'refused',
    at: 'build',
    refusal: 'serial_input',
    note: 'a session has no serial input path (the serial monitor shows output only): the program would wait forever',
    evidence: 'runtime/builder/tests/pyContract.test.ts',
    probe: 'print(input())\n',
  },
  {
    id: 'network',
    api: 'network, socket, bluetooth, espnow, …',
    status: 'refused',
    at: 'build',
    refusal: 'library:network',
    note: 'no network or radio in the simulator (and none from a compilation or run sandbox)',
    evidence: 'runtime/builder/tests/py-features.test.ts',
    probe: 'import network\n',
  },
];
