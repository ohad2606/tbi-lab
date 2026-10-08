# Sprint 10 — Architecture and scope record

**Branch:** `sprint-10` (worktree `~/projects/tbi-lab-s10`), from `7f09d74` = `main` =
`sprint-9-complete`. Sprint 9 is closed and is not reopened.

**Objective (owner, 2026-10-05):**
1. a realistic, physically scaled 3D representation;
2. simulation-engine capability and correctness;
3. expansion of the **approved** component catalog.

Ordering: electrical correctness first, then simulation behaviour, schematic semantics, realism,
polish.

> **Current state (2026-10-08, Sprint 10 closure).** This file is the architecture record written at
> the start of the sprint; the sections below keep that record. Where it was overtaken:
> - **Catalog:** PM-6 was revised on 2026-10-06 (`V1-PRODUCT-SCOPE.md` §6.0); the catalog is **open
>   to the approved families**. Sprint 10 exposed eight new types for local circuits (refused in
>   ESP32 projects until runtime Phase R1); §1's "closed at eight types" is the original record.
> - **Transient:** limited transient simulation is **part of V1** (PM-9, scope §6.0a): the
>   capacitor runs time-stepped in local circuits through `EngineSession.advance()`; ESP32 transient
>   integration is not supported (V1 roadmap). §2's "not exposed" describes the first, internal step.
> - **I2C:** ESP32 I2C with the I2C LCD is a **V1 planned capability** (PM-11), runtime Phase R3.
> - **3D:** a derived physical view (PM-10, scope §4.4): inspection, navigation, selection, the
>   shared Inspector and operating approved controls during Run; **no topology editing**.
> - **Scale:** one grid step is **3.175 mm** (§3, corrected).
> - Delivered / deferred items: `SPRINT-10.md` Part V.

---

## 1. Approved component-scope matrix (from the authoritative documents)

*Original record (2026-10-05), superseded by the PM-6 revision (2026-10-06) and PM-9..PM-11
(2026-10-08); see the current-state note above.*

Sources:
- `docs/product/V1-PRODUCT-SCOPE.md` §6 and §20, and the decision table PM-1…PM-8;
- `docs/product/V1-IMPLEMENTATION-ROADMAP.md` (scope guard, risk 12);
- every sprint record up to Sprint 9.

**No later document changes PM-6.** The V1 catalog is **closed at eight types**: "No component
may be added during implementation without an explicit scope decision — this includes
transistors, sensors, relays, 555 timers, motors and any other part that seems small at the
time."

| Component / capability | Status | Authority |
|---|---|---|
| Lab DC power supply | **Implemented** | §6.1 |
| Ground / reference | **Implemented** | §6.1 |
| Resistor | **Implemented** | §6.1 |
| LED — red TLHR5400 | **Implemented** | §6.1 |
| Diode — 1N4148 | **Implemented** | §6.1 |
| Push button (momentary) | **Implemented** | §6.1 |
| Toggle switch (SPST) | **Implemented** | §6.1 |
| Classic ESP32 DevKitC (Arduino/C++) | **Implemented** | §6.1, PM-2 |
| **LED: 1–2 additional colour cards, each datasheet-sourced** | **Approved for current development** (listed as "New engine work" for the LED row; never done) | §6.1 LED row; roadmap "LED" row |
| GPIO 32/33 outputs (bank-1 bridge) | Approved V1 pre-release fix; runtime/QEMU work, outside this frontend/engine sprint | §20 |
| Potentiometer (+ ADC) | **Approved but later: V1.1** (PM-6) | §6.1, §20 |
| Multimeter incl. resistance mode | Approved but later: V1.1 (PM-3) | §9.3 |
| Serial input, GPIO timeline | Approved but later: V1.1 | §20 |
| Capacitor / inductor | **Explicitly deferred** until transient can be modelled honestly (PM-6) | §6.1, §20 |
| Transistors (BJT/MOSFET) | **Explicitly deferred — Future** | §6.1, §20 |
| Relay | Explicitly deferred — Future | §6.1 |
| Sensors (LDR/photoresistor, thermistor, DHT temperature/humidity, PIR, ultrasonic) | Explicitly deferred — Future | §6.1, §20 |
| 555 timer, op-amps, logic ICs | Explicitly deferred — Future | §6.1, §20 |
| RGB LED | **Not yet decided** (not listed; under PM-6 a new type needs a scope decision) | PM-6 |
| Buzzer, servo, LED matrix, multi-position switch | **Not yet decided** (not listed; servo/buzzer also need PWM/LEDC, which is Future) | PM-6, §20 |
| I2C display (LCD via I2C) | **Explicitly deferred**: "ESP32 I2C/SPI with device models" is Future. *Now: V1 planned, runtime Phase R3 (PM-11, 2026-10-08)* | §7, §20 |
| Parallel LCD wiring | Not pursued (owner direction: I2C is the display path) | owner |
| Transient analysis (product feature) | **Explicitly deferred — Future**. The roadmap: "Not in scope, ever, for V1: AC, transient, companion models". *Now: limited transient (local capacitor circuits) is in V1 (PM-9, 2026-10-08)* | §20; roadmap §8 |
| MicroPython | Not in V1 (PM-4); the board and environment separation stays | PM-4 |
| Arduino-family boards | Future ("additional MCU families") | §20 |

### Scope conflict — RESOLVED by the PM on 2026-10-06

The PM revised PM-6 (`docs/product/V1-PRODUCT-SCOPE.md` §6.0). The closed eight-item catalog is
superseded. The approved families may be added; the potentiometer remains V1.1; transient-dependent
parts wait for honest time-domain simulation; displays are I2C only. The original record follows,
unchanged.

### Scope conflict (as recorded before the decision)

The Sprint 10 brief names catalog expansion (RGB LED, transistors, capacitors, relay, buzzer,
sensors, servo, 555, I2C LCD…). The same brief directs that the authoritative documents decide.
Those documents close the catalog. Adding any new component **type** would therefore change
approved scope.

Per the brief's stop rule, this is recorded as a **PM decision required (PM-6 revision)**. Sprint 10
continues with every unaffected phase:
- **Catalog expansion is limited to what is approved:** the datasheet-sourced LED colour cards.
- **No new component type is exposed.**
- **Engine work for deferred devices (capacitor, transient) is internal only:** an unexposed,
  tested engine primitive that a future, approved component can build on. No catalog type, no UI,
  no project data.
- **If the PM revises PM-6,** the engine primitive below and the physical 3D layer are the
  intended foundation.

---

## 2. Simulation engine: current architecture (inspected)

`packages/engine` holds:
- `circuit.ts`: the MNA DC solver;
- `devices.ts`: resistor, voltage source, lab PSU and Shockley diode;
- `esp32Gpio.ts`: the GPIO pad model;
- `session.ts`: the snapshot → engine boundary;
- `models.ts` and `registry.ts`: datasheet model cards.

| Aspect | Current state |
|---|---|
| Analysis | **DC operating point only.** Modified nodal analysis, dense LU. |
| Electrical primitives | Linear resistor; ideal voltage source; lab PSU (CV/CC, an active-set complementarity outer loop); Shockley diode with series resistance (LED and diode cards); switch = two documented resistances (10 mΩ / 100 MΩ); ESP32 GPIO pad (Thevenin output 3.3 V behind 16.5/17.68 Ω; input leakage; no internal pulls at runtime). |
| Nonlinear solving | Newton–Raphson with junction-voltage limiting and gmin, inside the PSU active-set loop. Convergence is declared only when no device is limiting. Every result is **verified against the exact, non-linearised equations** (KCL, branch residuals) and refused if they fail. Singular systems are refused, never patched. |
| Digital/analog boundary | Firmware (QEMU, server Session Host) sets each pad's mode (input / output-high / output-low). The engine solves the analog network with the pads as devices. Input reads use V_IL/V_IH with hysteresis (hold between thresholds). The firmware never sees the network directly. |
| Time / state | **None.** A solve is a pure function of the netlist; "time" exists only as a sequence of independent operating points as firmware changes pad modes. The `Device` interface has no state between solves (`resetState` clears Newton state). |
| Numerical limits | Dense LU, O(n³), ample for V1 sizes. Diode cards valid in documented current ranges (out-of-range use is flagged). No breakdown modelled. |
| Missing for deferred devices | Capacitor/inductor need **time integration** (companion models, a timestep, state, initial conditions). Transistors need new nonlinear models with validation against an independent reference. Relays need coil→contact coupling plus usually time. Sensors need ADC or a digital protocol. Servo/buzzer need PWM/LEDC. I2C displays need an I2C device bridge. |

### Sprint 10 engine step: an internal time-domain core (unexposed)

Implemented as a reusable primitive. It is **not** a product feature:
- **Device contract, additive:**
  - an optional `TimeStep` in the stamp options (`dt`, integration method), absent for DC, so
    every existing device and every existing DC result is untouched;
  - optional `acceptStep(x)`, `initialize(x)` and `timeDerivativeState` hooks for stateful devices.
- **`Capacitor` device:**
  - in DC it is an open circuit (a gmin-sized conductance keeps a capacitor-only node solvable,
    exactly like SPICE's gmin);
  - in a step it uses the backward-Euler or trapezoidal companion model (G = C/dt or 2C/dt
    with history current).
- **`Circuit.transient()` stepper:**
  - a deterministic fixed-step integrator;
  - initial condition from the DC operating point (or an explicit zero state);
  - each step solved with the **same** Newton, active-set and verification machinery;
  - a bounded number of steps; reproducible.
- **Validation:**
  - against analytic RC charge and discharge, with error order checked (BE first order,
    trapezoidal second order);
  - an RC + LED discharge cross-checked against **ngspice** (`eecircuit-engine`, Gate A's
    independent reference);
  - all existing DC tests unchanged.
- **Not exposed:** no catalog type, no snapshot field, no UI, no session API change. Exposure
  needs the PM-6 revision and the product-level transient decision.
- *Later in Sprint 10 (Part B):* the capacitor was exposed for local circuits through the session
  path `EngineSession.advance()` (backward Euler, fixed 1 ms step, Run/Stop restart at t = 0);
  `Circuit.transient()` above remains a test-only primitive. Product decision: PM-9 (2026-10-08).

---

## 3. 3D: physical-scale model (the dedicated 3D effort)

**Rule (unchanged from Sprint 9):** the user places a part once, in the 2D Circuit view.
"2D layout → position"; "physical metadata → dimensions, height, geometry". 3D never edits the
circuit's topology or layout, and no mesh or camera state is persisted. (Since Parts L and M, 3D
can select parts and wires for the shared Inspector and operate the toggle switch and push button
during Run; operating the toggle is the same undoable parameter change as in the Circuit view.
PM-10.)

**World scale (single convention, `physical.ts`):**
- 1 scene unit = **1 mm**.
- One 2D grid step (20 layout units) maps to **3.175 mm** (1/8 in), so
  `MM_PER_LAYOUT_UNIT = 0.15875`. *(Corrected: the first Sprint 10 version used 2.54 mm; it was
  changed so the ESP32 symbol's pin columns land exactly on the real DevKitC header rows, 25.40 mm
  apart, and parts beside the board in 2D stand beside it in 3D.)*

Consequences:
- a two-terminal part's terminals (80 units apart) are **12.7 mm** (0.5 in) apart, a standard axial
  lead spacing;
- along the ESP32 header the real pin pitch is **2.54 mm** while the grid is 3.175 mm: each pin's 3D
  attach point is the real pin, and the wire's 3D end follows it (`scene.ts`).

**Physical metadata** (per model, millimetres, documented sources or "representative"):
- body dimensions;
- lead diameter and length;
- lead spacing;
- mounting height;
- PCB thickness;
- header pitch and pin geometry;
- package orientation cues;
- the **attach point** where a wire meets each terminal (`x, y, z`).

The renderer reads only this metadata and the scene description. No scale constant lives in
renderer code.

**Electrical alignment:**
- Each terminal's attach point lies on the part's physical lead or pin.
- For two-terminal parts it is the 2D terminal position at lead-end height.
- For the ESP32 it is the top of the real header pin. The rows are 25.4 mm apart, while the 2D
  symbol has them 20.32 mm apart, so the wire's 3D end is moved onto the physical pin along its
  final straight run.
- The cross-view agreement test reads the 3D geometry back and must still equal the domain netlist.

**Instruments:** the bench supply is drawn as a recognisable bench unit at **reduced, symbolic
scale**. A true-size supply (~300 mm) cannot sit in a 2D-placed circuit; this is stated in the UI
documentation, not hidden.

**Performance design:**
- shared geometries per shape key and shared materials per viewer;
- instanced header pins;
- one shadow-casting key light with a shadow camera fitted to the content;
- lazy loading kept: three.js and models stay out of the startup bundle.

---

## 4. Not changed

- Backends, the build/runtime/QEMU path, artifacts, leases and Session Host semantics.
- The project schema (`schemaVersion` 3). Direct contacts stay zero-length wires.
- The dev-lab demo (Sprint 9, `198ca92`), until the owner approves a promotion.
- Production stays deferred.

---

## 5. After the PM-6 revision (2026-10-06): architecture for the approved families

### 5.1 Part models (engine)

The eight original types keep their dedicated, frozen session path (Gate A golden values and every
DC result unchanged). Every type added since is a **part model** (`packages/engine/src/parts.ts`):

- `elements(ctx, state)`: engine devices with any number of nodes, and **ideal contacts** (a 0 V
  branch when closed, nothing when open) that join the existing short and redundant-loop analysis
  of the switches;
- `report(...)`: language-neutral results: `current`, `voltage`, terminal potentials, named
  `currents` (RGB channels, a BJT's terminals, a relay coil), `state` (relay armature, buzzer
  sounding, PIR output, BJT region) and `array` (matrix dot currents);
- `ratings(...)`: datasheet absolute-maximum checks (warnings only);
- `liveParams`: parameters a running session accepts (`LiveControl.params`);
- `cards`: the model ids the part accepts, with their manufacturer part number.

The **reference analysis** follows the elements: a device joins its nodes, a closed contact its two
nodes, an open contact nothing. A relay's coil and contacts are therefore separate islands, as in
the part.

**Discrete state** (`initialState` / `nextState`): a relay armature, a module being powered. The
session solves, derives each part's implied state, and re-solves until nothing changes (bounded:
32 passes, cycle detection). It starts from the state the previous solve left, so hysteresis is
real; a circuit that never settles (a relay interrupting its own coil) is refused with
`no_steady_state`, never shown in a transitory state.

**Time-dependent parts** (`timeDependent`, `history`): a circuit holding one runs **time-stepped**
(`EngineSession.advance(dt)`, backward Euler). History is committed only for accepted steps, kept
separate from the discrete-state fixed point. Every session starts at t = 0 with all histories empty
(capacitors discharged).

### 5.2 Time and Run/Stop

| Circuit | Run | Live controls | Stop |
| --- | --- | --- | --- |
| No time-dependent part | One DC solve per request, exactly as before | Re-solve | Drop the session |
| With a capacitor | t = 0, discharged; the Worker advances 1 ms steps paced to wall-clock time, at most 25 ms CPU per 50 ms tick (simulated time slows rather than skipping steps), posting each tick's state | Apply from the next step (backward Euler handles the step change without ringing) | Drop the session and its time |
| With an ESP32 | The Session Host's MCU time drives the circuit (unchanged) | Mirrored (unchanged) | Ends the session |

A time-dependent part in an ESP32 project is refused at Run (`mcu_component_unsupported`): the
deployed runtime does not know it, and MCU time and circuit time are not coupled for it yet.

### 5.3 Sensors and the simulated environment

A sensor's input is its **simulated environment**, declared in the catalog as an environment
parameter (`environment` on a quantity or boolean parameter, always live): the light on a
photoresistor (lux, logarithmic slider), the motion in front of a PIR module. It is:

- persisted like a toggle position (reproducible projects), language-neutral, in SI units;
- edited in the inspector's **Simulated environment** section, or on the canvas through the part's
  actuator (`toggleParam`: clicking the PIR dome);
- mirrored to a running session as a live control; the part model reads it like any parameter.

No sensor output is hard-coded: each part model computes its electrical behaviour from the
environment value. Future sensors (temperature/humidity, distance) declare their own environment
parameters on the same path; their device protocols are already modelled internally (5.5).

### 5.4 Diagnostics

`ratingWarnings` covers the datasheet ratings of every part model, plus the ESP32 pads:
contention (opposite drives on one net), an output HIGH on GND, an output LOW on a supply +, and
pad current beyond I_OH 40 mA / I_OL 28 mA. They are amber warnings; the run continues and the
solved values are unchanged.

### 5.5 Peripherals and buses (internal)

`packages/engine/src/peripherals/` holds MCU- and language-agnostic device semantics:

- `i2c.ts`: an I2C bus with 7-bit addressing (reserved addresses and conflicts refused), at
  transaction level (what an MCU's I2C controller does) and line level (SDA/SCL decoding per NXP
  UM10204, including the target's ACK);
- `hd44780.ts`: PCF8574 expander + HD44780 controller (4-bit initialisation, instruction set, DDRAM
  map, ROM A00), i.e. the I2C LCD;
- `servo.ts`, `hcsr04.ts`, `dht22.ts`: the servo's pulse decoding, the ultrasonic echo timing, the
  DHT22 frame.

Nothing in them knows Arduino or MicroPython: a runtime that produces bus transactions or pad
edges drives the same objects. **What blocks exposure** is the runtime, not these models (5.6).

### 5.6 Runtime constraint (recorded)

The deployed classic-ESP32 runtime (QEMU bridge, R1/R2) reports digital pad levels and applies
input changes at 1 ms command ticks. Its builder refuses `ledc*`/`analogWrite` (PWM), `Wire`/I2C,
ADC and interrupts. So:

| Part | Needs from the runtime |
| --- | --- |
| Servo | LEDC (PWM) routed to pads, with edge timestamps to the Session Host |
| I2C LCD | The I2C controller modelled in QEMU and bridged as bus transactions (or line-level SDA/SCL with sub-ms input injection) |
| HC-SR04, DHT22 | Input injection with microsecond timing (today: 1 ms ticks) |
| Any Sprint 10 part in an ESP32 project | A Session Host built with this engine (the deployed one predates the part models) |

These are Sprint 8 backend changes; per the standing constraints they are not made in this sprint.

### 5.7 3D: pins under a part's body

Leaded parts keep the Sprint 10 rule (leads splayed to the 2D terminal positions). Packages whose
pins sit under their body (relay, PIR module, LED matrix) are wired at their **real pins**: each wire
comes in along the pin's own perpendicular, drops just outside the body (at a 2D pin stub's row when
the symbol has one) and runs in at pin level. Drop points and pin-level runs are obstacles for every
other wire. Crossing wires keep a full level (1.6 mm) apart; the earlier rule only kept their
heights unequal, which a test caught. Cross-view agreement holds for every new part at every rotation.
