# TBI Lab external alpha — tester guide (draft for owner review)

Thank you for testing TBI Lab. This alpha is a working preview for five invited testers. Please
read this page once; it takes three minutes.

## What TBI Lab is

A desktop browser app that simulates electronics: a **Classic ESP32** (ESP32 DevKitC, WROOM-32)
running your Arduino sketch, and the DC circuit around it. The voltages, currents and timing come
from the simulation engine. When something cannot be simulated honestly, TBI Lab refuses it and
says why; it never fakes a result.

## Getting in

1. Open the alpha address you received, with a desktop browser (Chrome, Edge or Firefox), on a
   screen at least 1024 pixels wide.
2. Sign in with the Google account whose address you gave us. Other accounts are refused.
3. The Projects screen shows a short **Getting started** guide: three steps from an example to a
   running simulation.

## Things to try

| # | Try | You should see |
|---|---|---|
| 1 | Open **ESP32 distance alarm** → Code → **Build** → **Run** | The serial monitor prints the distance; the LED stays off at 0.5 m |
| 2 | While running, select the HC-SR04 and set the distance to 0.1 m | The printed distance follows; the LED turns on |
| 3 | **ESP32 thermo-hygrometer**: change the temperature while running | The firmware prints exactly the new value |
| 4 | **ESP32 LCD hello** | The LCD shows the text the firmware wrote over I2C, in 2D and 3D |
| 5 | Edit a sketch, Build again, Run | Your change runs |
| 6 | Switch the language (English / עברית) | The same project, the same results; code stays left-to-right |
| 7 | Build your own small circuit | Wrong wiring is explained, not hidden |
| 8 | Open the menu → **What runs on the ESP32** | What is supported, limited and refused, and why |

## Known limits of this alpha

- **Timing:** TBI Lab does not claim unrestricted microsecond timing (details in **What runs on the
  ESP32 → Timing**). Sketches that keep both CPU cores busy are not supported for µs timing.
- **Not yet supported:** PWM / `analogWrite`, GPIO interrupts, analog input, Wi-Fi, Bluetooth,
  internal pull-ups, third-party Arduino libraries (for example DHT or LiquidCrystal_I2C; the
  examples show the same parts without them). A sketch that needs them is refused before Run.
- **Your projects live in your browser.** Use **Export** (Projects screen or menu) to keep a copy;
  **Import** restores it in any browser.
- **Warnings:** a part pushed beyond its published absolute maximum is marked "may be damaged";
  outside its specified operating range you get a separate notice. Where the manufacturer
  publishes no damage threshold, the risk is unknown — treat it as unsafe.
- **Shared service:** if the simulator is busy, wait a moment and press Run again.

## MicroPython

The ESP32 can also be programmed in **MicroPython**. It is the genuine MicroPython 1.29 interpreter
running on the emulated ESP32 (the same emulator and circuit simulation as Arduino sketches), not a
translation or an imitation. Choose the language in the **Code** tab with **Programming language**:
**Arduino C++** or **MicroPython**. The MicroPython program is `main.py`; you can add further `.py`
modules and packages to the project.

### What MicroPython programs can use

| Supported | Notes |
|---|---|
| `machine.Pin` as output (`value()`, `on()`, `off()`) and input (`Pin(n, Pin.IN).value()`) | Inputs read the level the circuit gives the pin. Reading a pin whose level is undefined or not connected stops the run and says so |
| `machine.Signal` | Driving only; reading back through a Signal makes the run watch every pin |
| `machine.PWM` (`freq`, `duty_u16`, `duty`) | The load sees the average; a duty of 0 into a load is not simulated and is refused |
| `Pin.irq` on rising / falling edges | Level-triggered interrupts are refused |
| `time.sleep`, `sleep_ms`, `sleep_us`, `ticks_ms`, `ticks_us`, `ticks_diff` | Simulation time; two runs give the same result |
| `machine.I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)`: `scan()`, `writeto()`, `writevto()` | Bus 0 on GPIO22/21, at most 100 kHz (the LCD backpack's rating), written with literal values. Reads and `SoftI2C` are refused |
| `print()` | Shown in the serial monitor |
| Modules: `time`, `sys`, `gc`, `micropython`, `math`, `cmath`, `struct`, `array`, `collections`, `json`, `re`, `binascii`, `errno` (and their `u…` names), your own project modules, and the managed library below | Any other import is refused |

**Refused, by name, before or while it runs:** internal pull-ups/pull-downs (use a real resistor in
the circuit), `drive=`, `machine.ADC` (analog input), DAC, SPI, TouchPad, Timer, UART, RTC,
`machine.time_pulse_us`, changing the CPU clock (`machine.freq(…)`), sleep modes, reset and the
watchdog, Wi-Fi / Bluetooth / network modules, `dht`, `neopixel`, `onewire`, `input()` and
`sys.stdin` (the serial monitor is output only), and looking names up at run time (`getattr` with
a computed name, `exec`, `eval`, …). The message names what was refused.

### MicroPython examples, and switching an example's language

Examples written in MicroPython start with "MicroPython:" in the examples list. These examples have
a **verified twin**: the same circuit, part for part, with a program in each language, both run on
the real emulator:

| Arduino C++ | MicroPython |
|---|---|
| ESP32: blink an LED | MicroPython: blink an LED |
| ESP32: fade an LED with PWM | MicroPython: fade an LED with PWM |
| ESP32: potentiometer as a digital input | MicroPython: potentiometer as a digital input |
| ESP32: hello on a 16×2 I2C LCD | MicroPython: hello on an I2C LCD |
| ESP32: LCD with a managed library (three files) | MicroPython: LCD with a managed library (two files) |
| ESP32: logic feedback and a relay | MicroPython: logic feedback and a relay |
| ESP32: switch input to LED output | MicroPython: switch input to LED output |
| ESP32 bench: inputs and indicators | MicroPython bench: inputs and indicators |
| ESP32: motion alarm through a relay | MicroPython: motion alarm through a relay |
| ESP32: RGB night light with a light sensor | MicroPython: RGB night light with a light sensor |
| ESP32: sweep an SG90 servo with PWM | MicroPython: sweep an SG90 servo with PWM |
| ESP32: a push button lights an LED | MicroPython: a push button lights an LED |
| ESP32: watching a logic half adder | MicroPython: an ESP32 watches a logic half adder |

What happens when you change **Programming language**:

- **Nothing is lost.** The code you leave is kept in the project, byte for byte; switching back
  brings it back exactly as you left it (also after saving, reloading, export and import). There
  is no confirmation dialog because nothing is discarded. One **Undo** reverts the switch.
- **An example with a verified twin:** the twin's program opens ("its code is back exactly as you
  left it").
- **An example without a twin** (for example **ESP32: ultrasonic distance alarm**, the DHT22
  thermo-hygrometer), or your own project that has never had
  code in that language: the MicroPython (or Arduino) **starter program** opens, and a notice says
  that no version in that language exists (for an example: none has been verified). The starter is
  not the example's program: it does not do what the example does until you write it.
- Code is never translated or converted from one language to the other.
- A project created from an example before language switching existed carries no twin: switching
  opens the starter.

### Known MicroPython limits

- **HC-SR04 ultrasonic sensor:** there is no MicroPython version of the distance alarm. Timing the
  echo pulse needs `machine.time_pulse_us`, which is refused: its accuracy on the simulator has not
  been validated for the product. Use the Arduino version (`pulseIn`), which is supported.
- **DHT22:** MicroPython's `dht` module is refused, so there is no MicroPython thermo-hygrometer.
- **Analog input** (`machine.ADC`) is refused in MicroPython, as `analogRead` is in Arduino.
- There is no serial input: programs cannot read from the serial monitor.

### Libraries

TBI Lab does not install libraries. It offers **managed libraries**: a short list of exact,
pinned versions that are already on the build service. Placing a part that has one makes it
available in **Code → Managed libraries**, with its licence, what was validated, and a usage
example. Today there is one per language, both for the **LCD1602 I²C display**:

| Language | Library | Use |
|---|---|---|
| Arduino C++ | LiquidCrystal_PCF8574 2.2.0 | `#include <LiquidCrystal_PCF8574.h>` |
| MicroPython | python_lcd (I2cLcd) | `from machine_i2c_lcd import I2cLcd` (and `lcd_api`) |

Only the validated operations are claimed (Arduino: `begin`, `setBacklight`, `clear`, `home`,
`setCursor`, `print`; MicroPython: `I2cLcd`, `clear`, `move_to`, `putstr`, `backlight_on`). Both
are write-only (reading the display stops the run) and limited to a 100 kHz I²C clock. Every other
part is used without a library (the examples show how), and any other library is refused at
Build.

## Reporting what you find

Where the editor's menu (☰) has **Report a problem…**, use it: it sends your description to the
TBI Lab team (it says exactly what is sent; never your project) and gives you a report ID to quote.
Otherwise use the feedback form linked in the app (it appears once the owner enables it) or the
address you were given. Please include what you expected, what happened, how to reproduce it, and the version
shown at the bottom right of the screen (for example `v0.10-dev · ba0f4a6`). Screenshots help.
