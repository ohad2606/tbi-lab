# Sprint 24 — genuine MicroPython: errors, examples, digital input, hardware I2C (DEV)

Base `0389c47` (DEV-Lab), Runtime v4 `cd778dc17d8edcdd` (unchanged: no QEMU patch in this sprint).
Evidence and measurements: `~/tbi-s24/evidence/m1-*/NOTE.md`, `m2-*/`, `m3-*/` on tbi-lab-srv.

## M1 — errors you can act on, and examples

- **Build syntax check.** `mpy-cross`, the interpreter's own compiler, built from the same pinned
  v1.29.0 source release as the image (`provision.sh mpy-cross`: version header fixed by
  `MICROPY_GIT_TAG` and `MPY_CROSS_SOURCE_DATE_EPOCH`, host paths mapped; two builds byte-identical,
  sha256 `e95b1043…84d5` on aarch64), pinned in `profiles/esp32-micropython-1.29.json` and copied into
  the MicroPython build home by `micropython-tools`. The build service runs it as one more
  allow-listed tool of the build-job sandbox (`build-job.ts`), with the sandbox's limits; it only
  compiles (`-march=xtensawin`, the ESP32 native emitter; output discarded). A compile error is a
  Build failure (`compile_error`) with `main.py`, the line and the compiler's own message in the
  Problems list. The image is unchanged (main.py stays source; byte-reproducible). The tool missing
  or changed: the toolchain does not verify and the profile is not offered (fail closed, reason
  logged). Deploy note: the MicroPython home bound at `/opt/tbi-micropython` must be re-provisioned.
- **Cache.** A cached build whose `profileHash` differs from the provider's (new check, analysis
  version, runtime capabilities) is built again (`service.ts cachedResult`). Arduino's record is
  unchanged, so its cache is unaffected.
- **Program end.** When main.py ends, the genuine interpreter prints its traceback (if any) and its
  REPL banner and `>>> `; the session keeps running. The ESP32 terminal shows a non-blocking notice
  ("Your program stopped with an error on line N" with the traceback, or "Your program finished"),
  EN/HE, derived from the serial text and saying so (`app/src/programs/programEnd.ts`). Only the
  exact ending (banner + prompt as the LAST output) counts; a program printing that text itself and
  then printing nothing more would look the same (documented residual). The session state is never
  changed by it.
- **Examples** (`mpy-blink`, `mpy-button`, `mpy-fade`): on their Arduino twins' circuits, verified
  on real QEMU by circuit results (`runtime/tests/s24-mpy.runtime.test.ts`).

## M2 — digital input

- Real-QEMU coverage: `Pin(34, Pin.IN)` with an external 10 kΩ pull-down reads the circuit; the
  program drives GPIO4 from it; the LED current follows press/release exactly, equal to the Arduino
  twin (TbiBanks) on the same request.
- Finding F-S24-M2-1 (owner decision): a floating ESP32 input reads LOW only because of the pad's
  input-leakage conductance to GND, a numerical reference (data-sheet magnitude, no direction), not a
  characterised behaviour; Arduino and MicroPython alike. Simulation unchanged. Added: a non-blocking
  circuit check `gpio_input_floating` (EN/HE) for a pin the program reads as an input whose net,
  with every switch open, nothing holds. Options in `~/tbi-s24/evidence/m2-input/FINDING-floating-input.md`.

## M3 — hardware I2C with the LCD1602 (PCF8574)

- `machine.I2C` allowed on a runtime announcing `i2c` (patch 0008), only as
  `I2C(0, scl=Pin(22), sda=Pin(21), freq=<literal ≤ 100000>)`: the bus and pads Arduino Wire was
  verified on (Sprint 12 T-R3-1), and the PCF8574's rated clock (NXP data sheet p.1, FACTS.md §10;
  `PCF8574_MAX_SCL_HZ` in the engine). Builds then `requires: [i2c, unmodelled]`. Refused at Build
  by name: `i2c_frequency` (missing, computed, > 100 kHz, also in `.init(freq=…)`), `i2c_bus`,
  `i2c_pins`, `i2c_option` (`timeout=`, extra arguments), `i2c_operation` (`readfrom*`,
  `writeto_mem`, `readfrom_mem*`: the LCD model does not model reads of the controller, R/W = 1;
  indirect use). `SoftI2C` stays `i2c`. `scan()`, `writeto()`, `writevto()` run, with the same
  electrical gating at every START as Wire (wiring, pull-ups, power, address).
- Example `mpy-lcd-hello`: a pure-Python HD44780-over-PCF8574 driver; verified on real QEMU by the
  published LCD state.
- Gap reported, not changed: Arduino `Wire.setClock()` / `Wire.begin(sda, scl, freq)` frequencies
  are not checked against the rated 100 kHz.

## Independent review of M1–M3 (fixes)

Review: `~/tbi-s24/evidence/review-m1-m3.md` (NO-GO on H1 before these fixes).

- **H1 (HIGH) fixed.** An I2C call after `;` on an import line escaped every M3 rule (a read on
  bus 1 at 400 kHz then returned the PCF8574's own latch: invented data). The analysis now splits
  statements at `;` (outside strings and brackets) for every rule, and any `I2C` token no known
  name accounts for is `i2c_operation`. The same split also closes `x = 1; import socket`.
- **M1 fixed.** Backslash line continuations are joined before matching.
- **M2 fixed.** With I2C in the program, `exec`, `eval`, `compile`, `setattr`, `__dict__`,
  `__getattribute__` and a `getattr` whose name is not a string literal are `i2c_operation`.
- **M4 fixed.** `gpio_input_floating` no longer warns for a pin given an internal pull
  (`INPUT_PULLUP`, `Pin.PULL_UP`, …) or set as an output and read back.
- **L2 fixed.** `.init(scl=…, sda=…)` with other pins than 22/21 is `i2c_pins`.
- Analysis version 3 (cached MicroPython builds are re-analysed).
- **Open (PM decision, M3):** Arduino `Wire.requestFrom` has been allowed since Sprint 12 and
  returns the PCF8574 output latch, which the HD44780 model does not drive during a read; the
  MicroPython rules refuse reads. Arduino is unchanged here.
- **Residual (L1, L3, L4):** the program-end notice is a heuristic over serial text; the
  mpy-cross pin is arm64 and toolchain-specific (a re-provision with another compiler fails closed
  at service start); mpy-cross and the board may disagree on rare corner cases (the board stays
  authoritative at Run).
