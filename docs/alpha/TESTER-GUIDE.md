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

## Reporting what you find

Use the feedback form linked in the app (it appears once the owner enables it) or the address you
were given. Please include what you expected, what happened, how to reproduce it, and the version
shown at the bottom right of the screen (for example `v0.10-dev · ba0f4a6`). Screenshots help.
