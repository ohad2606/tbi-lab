# TBI Lab external alpha — tester guide (draft for owner review)

Thank you for testing TBI Lab. This alpha is a working preview for five invited testers. Please
read this page once; it takes three minutes.

## What TBI Lab is

A desktop browser app that simulates electronics: a **Classic ESP32** (ESP32 DevKitC, WROOM-32)
running your Arduino sketch or MicroPython program, and the DC circuit around it. The voltages, currents and timing come
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

What is listed as supported here has been run on the simulator's real ESP32 emulator (QEMU) and
checked against the circuit simulation. Anything else is refused by name — at **Build**, or at the
moment the program uses it — never simulated approximately.

**Both languages**

- **Timing:** TBI Lab does not claim unrestricted microsecond timing (details in **What runs on the
  ESP32 → Timing**). A polled input can be seen up to about 13 µs late; programs that keep both CPU
  cores busy are not supported for µs timing.
- **Analog input** (ADC), DAC, touch, SPI, Wi-Fi, Bluetooth, sleep modes, restart, changing the
  CPU clock, internal pull-ups/pull-downs (use a real resistor) and drive strength are refused.
- **PWM** runs on the ESP32's high-speed LEDC: a load sees the average (duty × its ON current). A
  duty of 0 into a load is refused (not simulated yet).
- **GPIO interrupts:** rising, falling and change (both edges) are delivered; level-triggered
  interrupts are refused.
- **I²C:** bus 0 on GPIO21/22, writes to the LCD1602's PCF8574 backpack at up to 100 kHz. Reading
  the bus, and faster clocks, stop the run by name.
- **No serial input:** the serial monitor shows output only.

**Arduino C++** (arduino-esp32 3.3.12): `pinMode` / `digitalWrite` / `digitalRead`, `Serial`
output, `delay` / `millis` / `micros`, `pulseIn`, PWM with `analogWrite` or `ledcAttach` /
`ledcWrite` (LEDC fade and output inversion are refused), `attachInterrupt` (edges), `Wire`
writes. Libraries: only the managed LiquidCrystal_PCF8574 (see **Libraries** below); any other
library, for example DHT or LiquidCrystal_I2C, is refused at Build — the examples show the same
parts without them.

**MicroPython** (MicroPython 1.29): see **MicroPython** below for the full list.

**General**

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
| `machine.Signal` | Driving a pin. Reading back through a Signal is accepted only while every pin has a defined level (otherwise the run stops at the read) |
| `machine.PWM` (`freq`, `duty_u16`, `duty`) | The load sees the average; a duty of 0 into a load is not simulated and is refused |
| `Pin.irq` on rising / falling edges | Level-triggered interrupts are refused |
| `time.sleep`, `sleep_ms`, `sleep_us`, `ticks_ms`, `ticks_us`, `ticks_diff` | Simulation time; two runs give the same result |
| `machine.time_pulse_us(pin, level, timeout_us)` | Times a pulse on an input (for example the HC-SR04 echo); −2: no pulse started, −1: it did not end, within the timeout |
| `import dht`; `dht.DHT22(Pin(n))`: `measure()`, `temperature()`, `humidity()` | The interpreter's own DHT driver with the DHT22 / AM2302 part (not DHT11). A read that gets no answer raises `OSError` (ETIMEDOUT); the sensor answers at most once every 2 s |
| `machine.I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)`: `scan()`, `writeto()` | Bus 0 on GPIO22/21, at most 100 kHz (the LCD backpack's rating), written with literal values. Reads and `SoftI2C` are refused |
| `print()` | Shown in the serial monitor |
| Modules that may be imported: `time`, `sys`, `gc`, `micropython`, `math`, `cmath`, `struct`, `array`, `collections`, `json`, `re`, `binascii`, `errno` (and their `u…` names), `dht`, your own project modules, and the managed library below | Any other import is refused |

**Refused, by name, before or while it runs:** internal pull-ups/pull-downs (use a real resistor in
the circuit), `drive=`, `machine.ADC` (analog input), DAC, SPI, TouchPad, Timer, UART, RTC,
changing the CPU clock (`machine.freq(…)`), sleep modes, reset and the
watchdog, Wi-Fi / Bluetooth / network modules, `neopixel`, `onewire`, `input()` and
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
| ESP32: ultrasonic distance alarm | MicroPython: ultrasonic distance alarm |
| ESP32: temperature and humidity (DHT22) | MicroPython: temperature and humidity (DHT22) |
| ESP32: an AND gate with read-back | MicroPython: an AND gate with read-back |
| ESP32: an OR gate with a manual override | MicroPython: an OR gate with a manual override |
| ESP32: a quad AND gate IC driving LEDs | MicroPython: a quad AND gate IC driving LEDs |

The last three show datasheet limits: both versions are refused by name at the same point.

What happens when you change **Programming language**:

- **Nothing is lost.** The code you leave is kept in the project, byte for byte; switching back
  brings it back exactly as you left it (also after saving, reloading, export and import). There
  is no confirmation dialog because nothing is discarded. One **Undo** reverts the switch.
- **An example with a verified twin:** the twin's program opens ("its code is back exactly as you
  left it").
- **A project without a twin** — your own project that has never had code in that language, or a
  project created before twins existed: the MicroPython (or Arduino) **starter program** opens, and a notice says
  that no version in that language exists. The starter is not your program: it does nothing of
  yours until you write it. (Every built-in ESP32 example now has a twin.)
- Code is never translated or converted from one language to the other.

### Known MicroPython limits

- **HC-SR04 ultrasonic sensor:** `machine.time_pulse_us` reads the echo within about 2 µs of the
  simulated one from 2 cm to 4 m (13 µs at most, the same timing limit as Arduino's `pulseIn`);
  out of range it returns −2 at the timeout.
- **DHT22:** with `import dht`, every reading is exact across the sensor's range (−40 to 80 °C,
  0 to 100 %RH). Without the 10 kΩ pull-up the run stops by name. The DHT11 class is not
  validated (there is no DHT11 part).
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
are write-only (reading the display stops the run) and limited to a 100 kHz I²C clock.

MicroPython's built-in `dht` module is part of the interpreter, not a library: nothing is added
to the project for it. Every other part is used without a library (the examples show how), and
any other library is refused at Build.

## Reporting what you find

Where the editor's menu (☰) has **Report a problem…**, use it: it sends your description to the
TBI Lab team (it says exactly what is sent; never your project) and gives you a report ID to quote.
Otherwise use the feedback form linked in the app (it appears once the owner enables it) or the
address you were given. Please include what you expected, what happened, how to reproduce it, and the version
shown at the bottom right of the screen (for example `v0.10-dev · ba0f4a6`). Screenshots help.
