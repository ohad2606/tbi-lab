# Sprint 10 — Architecture and scope record

**Branch:** `sprint-10` (worktree `~/projects/tbi-lab-s10`), from `7f09d74` = `main` =
`sprint-9-complete`. Sprint 9 is closed and is not reopened.

**Objective (owner, 2026-10-05):**
1. a realistic, physically scaled 3D representation;
2. simulation-engine capability and correctness;
3. expansion of the **approved** component catalog.

Ordering: electrical correctness first, then simulation behaviour, schematic semantics, realism,
polish.

---

## 1. Approved component-scope matrix (from the authoritative documents)

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
| I2C display (LCD via I2C) | **Explicitly deferred**: "ESP32 I2C/SPI with device models" is Future | §7, §20 |
| Parallel LCD wiring | Not pursued (owner direction: I2C is the display path) | owner |
| Transient analysis (product feature) | **Explicitly deferred — Future**. The roadmap: "Not in scope, ever, for V1: AC, transient, companion models" | §20; roadmap §8 |
| MicroPython | Not in V1 (PM-4); the board and environment separation stays | PM-4 |
| Arduino-family boards | Future ("additional MCU families") | §20 |

### Scope conflict (recorded, not resolved by implementation)

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

---

## 3. 3D: physical-scale model (the dedicated 3D effort)

**Rule (unchanged from Sprint 9):** the user places a part once, in the 2D Circuit view.
"2D layout → position"; "physical metadata → dimensions, height, geometry". 3D is never editable,
and no mesh or camera state is persisted.

**World scale (single convention, `physical.ts`):**
- 1 scene unit = **1 mm**.
- One 2D grid step (20 layout units) maps to **2.54 mm** (0.1 in, the breadboard/header pitch), so
  `MM_PER_LAYOUT_UNIT = 0.127`.

Consequences:
- a two-terminal part's terminals (80 units apart) are **10.16 mm** apart, the standard 0.4 in axial
  footprint;
- the ESP32's header positions (one grid step apart in 2D) fall exactly on its real **2.54 mm**
  pitch.

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
