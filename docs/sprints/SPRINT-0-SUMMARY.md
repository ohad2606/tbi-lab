# TBI Lab — Sprint 0 Summary

**Core Feasibility · 2026-09-20 to 2026-09-22 · Closed**

Executive and technical summary for engineering and product stakeholders. The authoritative record,
with every measurement, tolerance and decision, is [`SPRINT-0.md`](SPRINT-0.md).

---

## What Sprint 0 set out to answer

Before building any product UI or production architecture, four questions had to be answered with
evidence:

1. Can we run **deterministic, physically valid DC circuit simulation in the browser**?
2. Can the **classic/original ESP32** realistically execute in our intended architecture?
3. Can the **MCU runtime and the electrical simulation exchange state in both directions**?
4. Can a project be **stored and restored locally** without depending on a server?

## Result

| Gate | Question | Verdict |
|---|---|---|
| **A** | DC simulation in the browser | **PASS** |
| **B** | Classic ESP32 feasibility | **CONDITIONAL PASS** |
| **C** | MCU <-> electrical bridge | **PASS** |
| **D** | Local-first persistence | **PASS** |

Gate B breakdown:

| Gate B sub-result | Verdict |
|---|---|
| Classic ESP32 native execution | PASS |
| Bidirectional GPIO runtime | PASS |
| Arduino compatibility | PASS |
| MicroPython compatibility | PASS |
| Browser-local classic ESP32 for the intended architecture | **FAIL** |
| Selected V1 direction | **Hybrid / server-side** |

Gate B is a CONDITIONAL PASS by the sprint's own definition: a classic-ESP32 path that needs
hybrid or server execution is conditional, not a full pass.

**In one sentence:** everything in the V1 direction is now backed by reproducible tests, except
running the ESP32 *inside the browser* — V1 runs it in a co-located server simulation session
instead.

---

## Key measurements

| Area | Measurement |
|---|---|
| DC solver in a browser Web Worker | **0.07-0.09 ms** per nonlinear solve; page main thread unblocked |
| Solver determinism | Browser result **bit-identical** to Node |
| Solver vs ngspice (independent reference) | agreement to **~1e-16** once physical constants are aligned |
| Classic ESP32 boot to application (native emulation) | **3.3 s**, ~209 MB |
| GPIO: firmware write -> host sees it | **< 1 ms** |
| Electrical change -> solve -> level pushed to the MCU | **3 ms** |
| Project restore | exact, across page reload **and** full browser restart |
| ESP32 CPU in the browser (WASM experiment) | ~10 M instructions/s: **~300x slower than native**, **~24x slower than the real chip** (estimate) |
| WASM experiment payload / memory | 26.1 MB (9.1 MB gzip); **~390-460 MB** memory |

**Test suite:** 55 Node tests, 4 browser tests, 19 tests against the real classic-ESP32 runtime and
2 WASM measurement tests — all passing.

---

## Gate A — Electrical solver (PASS)

A TypeScript solver (Modified Nodal Analysis) of our own, with no third-party runtime dependency.

- **All 7 required reference circuits correct** within explicitly stated tolerances: 5 V/1 kOhm,
  12 V divider, 9 V series, open circuit, lab PSU in current limit (5 V / 100 mA into 10 Ohm ->
  100 mA at 1 V), short circuit, and LED + resistor.
- **The lab PSU's current limit is part of the electrical model**, chosen by the solution itself —
  not a clamp applied to the result afterwards.
- **The LED is a real device model** (Shockley equation), fitted to a Vishay datasheet. The one
  assumed parameter was quantified: it moves the result by only 0.22 %.
- **Independently verified against ngspice.** An initial 3.3e-7 difference was traced to the two
  tools using different editions of the physical constants — not a physics disagreement.
- **The solver refuses to return a wrong answer.** Bring-up found it could return a solution with
  a 9.8e24 A error without complaint; every solution is now checked against the exact equations
  and rejected if it fails.

Detail: [`experiments/gate-a-electrical/README.md`](../../experiments/gate-a-electrical/README.md)

## Gate B — Classic ESP32 (CONDITIONAL PASS)

**Native execution works.** Real classic-ESP32 firmware — both **MicroPython** and **Arduino**
(official ESP32 core, `pinMode`/`digitalWrite`/`digitalRead`) — boots through the chip's own ROM in
QEMU and runs.

**The GPIO problem was solved with existing work, not a rewrite.** Espressif's own emulator treats
GPIO as a stub: writes vanish, and a debugger write even reports success while changing nothing.
Existing community implementations were evaluated instead; one was built from source and verified
against Espressif's register definitions (20 of 20 match).

**An electrical defect in that implementation was found and fixed.** A pin configured as an
*input* was reported as if it were *driving* the circuit — which would have fed a phantom voltage
into our solver. A 42-line fix made it match the chip's reference manual, confirmed by the same
test that found the problem.

No other ESP32 variant (C3/S3/…) was substituted at any point.

Detail: [`experiments/gate-b-esp32/README.md`](../../experiments/gate-b-esp32/README.md),
[`docs/research/classic-esp32-gpio-implementations.md`](../research/classic-esp32-gpio-implementations.md)

## Gate C — MCU <-> electrical bridge (PASS)

Real ESP32 firmware and our solver exchange state in **both directions**, on the real runtime.

- **Output:** firmware sets a pin HIGH -> the solver sees current flow through a resistor and LED.
- **Input:** a simulated circuit changes a voltage -> the firmware reads the new logic level.
- **The pin is modelled as real hardware, not an ideal 3.3 V source.** Its values come from the
  ESP32 datasheet: a driven-high pin feeding an LED measures **3.205 V, not 3.3 V**, because of the
  driver's internal resistance — exactly as the physical chip behaves.
- **Input thresholds come from the datasheet** (2.475 V / 0.825 V); between them the pin keeps its
  previous state rather than guessing.
- **Nothing is hardcoded.** Expected values come from an independent calculation, and changing a
  resistor the firmware knows nothing about changes the result accordingly.

Detail: [`experiments/gate-c-bridge/README.md`](../../experiments/gate-c-bridge/README.md)

## Gate D — Local-first persistence (PASS)

Proven in a **real browser with real IndexedDB**, not a simulation of one.

- A project is created, edited, auto-saved, and restored **exactly** after a page reload.
- It is restored again after the **browser is closed entirely and reopened**, and the device
  identity survives that restart.
- The saved state already carries the fields future sync will need (local/cloud/base revisions,
  device id, timestamps). **No cloud sync was built.**

Detail: [`experiments/gate-d-persistence/README.md`](../../experiments/gate-d-persistence/README.md)

---

## The browser (WASM) experiment — and why it failed for V1

The team asked for a serious attempt, not an assumption. So the emulator was actually built for the
browser and run in Chromium.

**What worked:** the ESP32's processor core, compiled to WebAssembly, runs in the browser, in a
background Worker, and computes correct results. Download size (~9 MB compressed), start-up (~1 s)
and browser security requirements were all workable.

**Why it fails for V1 — two measured obstacles:**

1. **Speed.** In the browser the ESP32's processor runs about **24x slower than the real chip**
   (estimate) and ~300x slower than the same emulator running natively. CPU-heavy firmware would
   run far slower than real time.
2. **Scope of the remaining port.** That experiment covers the *processor only* — no ROM, no
   peripherals, no GPIO. Bringing the full ESP32 machine to the browser means moving roughly
   **19,300 lines across 237 files** of emulator code to a newer emulator version, plus the GPIO
   work, and maintaining it indefinitely.

Memory use was also substantial: ~390-460 MB for the processor-only experiment.

Market check: Velxio, the most visible "ESP32 in your browser" product, also runs its ESP32
emulation **on a server** and streams it to the browser, per Espressif's own developer portal.

Detail: [`docs/research/browser-local-classic-esp32.md`](../research/browser-local-classic-esp32.md)
(Finding 6 has the measurements)

---

## Decision B1 — V1 runs the ESP32 on a server, co-located with the simulation

- **V1 uses a hybrid / server-side classic ESP32 runtime.**
- For a project that contains an ESP32, one **server simulation session** runs the ESP32
  emulator, the MCU/electrical bridge **and** the electrical solver **together**. Pin changes never
  travel across the internet between the emulator and the solver, so simulation timing does not
  depend on network latency.
- The **browser** keeps the product UI, editing, project state, local-first saving, and displaying
  simulation results.
- **Projects without a microcontroller** keep running the electrical solver **entirely in the
  browser**.
- An ESP32 project **may need an online simulation session** in V1.
- Browser-local ESP32 becomes an **R&D item**, with all measurements preserved.
- **Recorded only.** No production server was built in Sprint 0.

## Decision B2 — QEMU licensing (GPL-2.0)

- QEMU is **approved in principle as a server-side V1 component**.
- It is **not** approved for shipping to browsers.
- QEMU runs as a **separate process behind an explicit interface**, not linked into application
  code. The Sprint 0 bridge already works this way.
- Every change we make to QEMU keeps its exact upstream provenance and licence information.
- The missing COPYING file in Espressif's prebuilt emulator package is recorded as a packaging
  finding; the authoritative source-tree licensing is used for our records.
- **Formal legal/licence review is required before commercial distribution.**
- The ngspice reference engine stays **development/test-only**.

---

## Future / R&D (not V1)

| Item | Why it is parked |
|---|---|
| Browser-local classic ESP32 | ~24x slower than the real chip and a ~19,300-line port; revisit if browser emulation technology changes |
| Faster in-browser emulation (translate-to-WASM JIT) | Could change the speed picture; not measured |
| Production emulator baseline | Move the GPIO work onto a maintained Espressif baseline — natural next step now that QEMU stays server-side |
| Offer the GPIO fix upstream | Removes a patch we would otherwise maintain ourselves |
| LED model accuracy | Based on one datasheet point; needs a vendor model or bench measurement |
| Pin drive strength, open-drain, firmware-controlled pull-ups | Not modelled yet |
| GPIO 32-39 output events | Bridge currently reports bank-0 outputs only |
| Arduino flash mode | Must build with DIO; QIO stalls in the emulator |
| Other peripherals (ADC, PWM, UART, I2C, SPI …) | Out of Sprint 0 scope by design |

## Where to read more

| Topic | Document |
|---|---|
| Authoritative sprint record, all decisions | [`docs/sprints/SPRINT-0.md`](SPRINT-0.md) (final report: section 14; decisions: section 15) |
| Electrical solver | [`experiments/gate-a-electrical/README.md`](../../experiments/gate-a-electrical/README.md) |
| ESP32 runtime and GPIO | [`experiments/gate-b-esp32/README.md`](../../experiments/gate-b-esp32/README.md) |
| GPIO implementations survey | [`docs/research/classic-esp32-gpio-implementations.md`](../research/classic-esp32-gpio-implementations.md) |
| MCU <-> electrical bridge | [`experiments/gate-c-bridge/README.md`](../../experiments/gate-c-bridge/README.md) |
| Persistence | [`experiments/gate-d-persistence/README.md`](../../experiments/gate-d-persistence/README.md) |
| Browser (WASM) experiment | [`docs/research/browser-local-classic-esp32.md`](../research/browser-local-classic-esp32.md) |
