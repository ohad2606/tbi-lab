# Electrical engine — provenance

`packages/engine` is the one production electrical engine (ADR-008). Its numerical core was
**promoted** in Sprint 3 from the Gate A feasibility implementation at tag `sprint-1-complete`.
The originals under `experiments/gate-a-electrical/` remain unchanged as frozen evidence. They
are not maintained and never imported by production code.

| Production file           | Source                                                                               | Changes                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/linalg.ts`           | `experiments/gate-a-electrical/src/linalg.ts`                                        | Provenance header only                                                                                                                                                         |
| `src/circuit.ts`          | `experiments/gate-a-electrical/src/circuit.ts`                                       | Provenance header only                                                                                                                                                         |
| `src/devices.ts`          | `experiments/gate-a-electrical/src/devices.ts`                                       | Provenance header; `CurrentSource` removed (not used by any product component)                                                                                                 |
| `src/models.ts`           | `experiments/gate-a-electrical/src/models.ts`                                        | Provenance header; the ngspice-only `CODATA_2014` constants and deprecated aliases removed (the oracle cross-check stays in `experiments/`)                                    |
| `src/registry.ts`         | new                                                                                  | Model-card ids -> cards; documented validity range per card                                                                                                                    |
| `src/session.ts`          | new (informed by `experiments/gate-a-electrical/src/api.ts`, which was not promoted) | Compile from snapshot, disabled-output model, reference analysis, structured errors, live PSU controls. Sprint 4: diode, switches, live toggle control, transient button input |
| `tools/extract_1n4148.py` | new (Sprint 4)                                                                       | Reproduces the 1N4148 anchors and fit from the manufacturer PDF (standard library only; not a runtime or CI dependency)                                                        |

**Evidence that promotion changed no number:** `tests/gate-a-golden.json` holds the Gate A
engine's outputs as IEEE-754 bit patterns, captured by running the frozen feasibility engine.
`tests/reference.test.ts` re-runs the seven reference cases at the original tolerances and
requires every value to be bit-identical. The LED circuit built through the product path
(project document -> snapshot -> session) is bit-identical as well.

## Modelling decisions added in Sprint 3

| Decision                          | Model                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PSU output off**                | The supply contributes **no element** to the solved topology: an open circuit (infinite impedance) between its terminals. It carries exactly zero current, and its terminal voltage is whatever the rest of the circuit imposes (undefined if nothing does). It is not a 0 V source, and no leakage is added. An island that is referenced only through an off supply is reported as floating, with the supply named |
| **GND**                           | Every `component.ground` terminal is the single reference node. Nets with `role: "ground"` are that node                                                                                                                                                                                                                                                                                                             |
| **Unwired terminal**              | Its own node, reached only through its component. A resistor with one end open carries zero current and its open end sits at the other end's potential (Gate A case 4)                                                                                                                                                                                                                                               |
| **Unwired component**             | A component with no wired terminal is not part of the circuit. It is reported as not connected and not simulated. No values are invented for it                                                                                                                                                                                                                                                                      |
| **Floating island**               | A group of elements with no path to GND in the solved topology is refused as `floating_circuit`, naming its components and nets. No ground is inserted and no leakage is added                                                                                                                                                                                                                                       |
| **Enabled PSU shorted by a wire** | Refused as `psu_shorted`: an ideal wire across an ideal source has no meaningful operating point                                                                                                                                                                                                                                                                                                                     |
| **Circuit entirely on GND**       | Zero unknowns: every potential and every current is exactly 0                                                                                                                                                                                                                                                                                                                                                        |
| **LED model range**               | `outsideModelRange` flags conduction outside the card's documented 1-20 mA range. The numbers remain the exact solution of the documented model                                                                                                                                                                                                                                                                      |

## Tested resistance range

**1 mΩ .. 1 GΩ, the full catalog input range, is supported** (`tests/range.test.ts`):

- every decade as a single load, in CV and CC at extreme setpoints and limits;
- all 169 decade pairs as a divider (ratios up to 1e12);
- LED + series resistor at every decade against an independent bisection;
- 200 seeded random ladders.

All cases pass the solver's own exact-equation verification and agree with the analytic answer to
1e-9 relative, the Gate A tolerance.

## Added in Sprint 4

`devices.ts`, `circuit.ts` and `linalg.ts` are unchanged: the diode reuses the Gate A `Diode`
device (Shockley + series resistance, the same Newton infrastructure as the LED) and the switch
reuses the Gate A ideal `VoltageSource` element.

### 1N4148 diode card (`model.diode.vishay_1n4148`)

| Item              | Value                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source            | Vishay Semiconductors, _1N4148 Small Signal Fast Switching Diodes_, Document 81857, Rev. 1.6, 07-Nov-2024, https://www.vishay.com/docs/81857/1n4148.pdf (SHA-256 `aefe85400a427ed886a4e1c88205ceabb9f9b38044b29c6acee4bb00146a44b7`; the PDF is not committed) |
| Anchors           | Fig. 1 _Typical Forward Voltage vs. Junction Temperature_, read at T_j = 25 °C from the PDF's **vector** path data, calibrated against the figure's own gridlines: V_F = 0.4990 V @ 0.1 mA, 0.6105 V @ 1 mA, 0.7306 V @ 10 mA, 0.8775 V @ 100 mA               |
| Fit               | Least squares of V_F = N·Vt·ln(I/I_S + 1) + I·R_S, Vt from CODATA 2019 at 298.15 K: **N = 1.924182, I_S = 4.210299 nA, R_S = 0.379873 Ω**                                                                                                                      |
| Residuals         | −0.86 / +1.81 / −1.04 / +0.09 mV at the four anchors                                                                                                                                                                                                           |
| Independent check | Three Fig. 2 points of the 25 °C curve at 6–22 µA (not used in the fit) agree within 5.2 mV                                                                                                                                                                    |
| Table limits      | Model V_F(10 mA) = 0.730 V ≤ 1 V max; model \|I_R(20 V)\| ≈ 4.2 nA ≤ 25 nA max                                                                                                                                                                                 |
| Validity          | Forward 0.1–100 mA at 25 °C (flagged `outsideModelRange` outside it, numbers unchanged). Reverse bias: Shockley saturation current + gmin only. **Breakdown (V_BR ≥ 100 V) is not modelled**, and 100 V exceeds every V1 PSU setpoint (≤ 30 V)                 |
| Assumptions       | The datasheet does not uniquely define I_S, N and R_S: they are the three-parameter fit above. Temperature fixed at 25 °C. No capacitance or recovery (DC only)                                                                                                |

`tools/extract_1n4148.py` reproduces every number above from the PDF, and
`tests/diode.test.ts` refits the anchors independently and compares circuits against a bisection
solution of the same equation, sharing no code with the MNA solver.

### Switch model (push button and toggle switch)

No `R_on`/`R_off` constants and no leakage:

- **Open** (toggle `closed: false`, or a button not pressed): the switch contributes **no
  element**, like a PSU with its output off.
- **Closed**: an ideal 0 V `VoltageSource` branch between `a` and `b`. Its branch current is the
  switch current. When closed switches form a loop (switches in parallel), only a spanning forest
  gets a branch; the redundant switches report current `null` ("not defined") because an ideal
  loop does not define how current divides.
- A closed-switch path across an enabled PSU is refused as `psu_shorted`, naming the switches.
- An open switch that isolates part of the circuit from GND gives the normal floating diagnostic.

Tested (`tests/switch.test.ts`): exact open/closed results for every resistor decade 1 mΩ–1 GΩ,
CC through a closed switch, a switch in series with an LED, series and parallel switches, and
1,000 live toggle transitions and 1,000 button cycles, each bit-identical to a fresh solve. The
solver tolerances are unchanged.

### Ground

Every `component.ground` terminal is the one reference node, even when two GND symbols are not
wired to each other (`tests/session.test.ts`, "A14").

## Added in Sprint 5 (pre-push): datasheet absolute maximum ratings

`src/ratings.ts` records the absolute maximum ratings from the same datasheets as the model
cards. The solver never uses them. They only let the product warn, never change a number:

| Model                       | Source                                                                                                              | I_F max                     | V_R max | P max                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------- | ------------------------------ |
| `model.led.vishay_tlhr5400` | Vishay TLHR540./TLHY540., Document 83012, Rev. 2.7 (25-Jan-2024), fetched 2026-09-24 (SHA-256 `5dc7a75d…8ed50`)     | 30 mA (DC, T_amb ≤ 65 °C)   | 6 V     | 100 mW (T_amb ≤ 65 °C)         |
| `model.diode.vishay_1n4148` | Vishay 1N4148, Document 81857, Rev. 1.6 (07-Nov-2024), the same file as the model card (SHA-256 `aefe8540…46a44b7`) | 300 mA (forward continuous) | 75 V    | 500 mW (l = 4 mm, T_L ≤ 25 °C) |

`ratingWarnings(snapshot, outcome)` flags a solved operating point above any of these.
Resistors have no documented rating in V1 (no power-rating parameter exists), so they are
never flagged. Adding one would need a parameter and a decision about what rating a generic
resistor has, which is a PM decision, not an invented limit.

## Added in runtime R1

| Production file    | Source                                                                                            | Changes                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/esp32Gpio.ts` | `experiments/gate-c-bridge/src/pinModel.ts` (Gate C, tag `sprint-1-complete`; approved pin model) | Provenance header; imports point at `./devices.js`; Prettier formatting. Constants and logic unchanged |

The classic-ESP32 pin model (output 3.3 V behind 16.5 Ω high / 17.679 Ω low, input leakage,
V_IL 0.825 V, V_IH 2.475 V with the previous level held in between) is used by the MCU runtime
harness (`runtime/harness`) to close the MCU ↔ electrical loop through this engine, the one
engine (ADR-008). The runtime tests (`runtime/tests/electrical.runtime.test.ts`) check every solve in
the loop against the pin equations exactly (1e-9 V).

## Added in Sprint 10

**LED colour cards** (product scope §6.1, LED row: the approved "1–2 more colour cards from
datasheets"). They are built like `LED_TLHR5400`: one typical anchor, N fixed by the same documented
assumption, I_S fitted exactly, R_S not modelled, valid 1–20 mA.

| Model id                    | Anchor and ratings source                                                                                                                                          | Abs. max                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `model.led.vishay_tlhy5400` | Vishay TLHR540./TLHY540., Document 83012, Rev. 2.7 (25-Jan-2024): V_F typ. 2.4 V at 20 mA (GaAsP on GaP). The same file as the red card (SHA-256 `5dc7a75d…8ed50`) | 30 mA, 6 V, 100 mW (T_amb ≤ 65 °C) |
| `model.led.vishay_tlhg4900` | Vishay TLHR4900, TLHG4900, Document 83009, Rev. 2.7 (21-Jul-2022): V_F typ. 2.4 V at 20 mA (GaP on GaP, 3 mm clear); fetched 2026-10-05 (SHA-256 `585526b8…d306b`) | 30 mA, 6 V, 100 mW (T_amb ≤ 60 °C) |

**Internal time-domain core** (`src/circuit.ts` `Circuit.transient`, `src/devices.ts` `Capacitor`,
`TimeStep`).

- **Additive.** `StampOptions.step` is absent for DC, so every existing device and DC result is
  unchanged; the Gate A golden values stay bit-identical (`tests/reference.test.ts`).
- **Not exposed.** No catalog type, snapshot field, session API or UI uses it (product scope PM-6:
  capacitors wait until transient can be modelled honestly; this is the engine step towards that,
  pending a PM decision).
- **Integration.**
  - Backward Euler or trapezoidal companion models, with a fixed step.
  - Time zero is either the DC operating point, or the discharged state (each capacitor held at
    0 V by a backward-Euler step of length dt·1e-9).
  - A declared discontinuity is integrated with backward Euler (SPICE breakpoint practice).
- **Validation (`tests/transient.test.ts`):**
  - closed-form RC charge and discharge;
  - convergence order (trapezoidal second order, backward Euler first order);
  - charge conservation to 1e-15 C;
  - determinism and bounds;
  - an RC + LED discharge against ngspice (`eecircuit-engine`, the Gate A oracle) within 2e-4
    relative.

## Added in Sprint 10, after the PM-6 revision (2026-10-06)

New component types are **part models** (`src/parts.ts`, one file per part in `src/parts/`). The
eight original types keep their frozen session path; the Gate A golden values are unchanged.
Datasheets were retrieved 2026-10-06; full fact sheets with page references are in
`docs/sprints/s10-evidence/datasheets/FACTS.md`.

| Part (model id)                                      | Source (SHA-256 prefix)                                  | Model                                                                                                                                                                                      | Assumptions / limits                                                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RGB LED `model.rgb_led.kingbright_wp154a4sureqbfzgc` | Kingbright DSAJ8687 Rev V.11A, 03/25/2025 (`2433a903…`)  | Three `Diode`s, common cathode. Per channel: anchored least-squares Shockley + R_S (`fitAnchoredShockleyRs`) through the page 2 typical V_F at 20 mA (exact) and page 3 I-V graph readings | Graph readings ±10 mV. Valid 2–30 mA (green 2–25 mA). Breakdown not modelled. Cross-checked against ngspice (1e-6)                                                                                          |
| Photoresistor `model.ldr.senba_gl5528`               | Senba GL55 series manual (`02b4172e…`)                   | Resistor R = R10 (E/10 lx)^-γ, E a live environment parameter                                                                                                                              | R10 = 14.14 kΩ (geometric centre of 10–20 kΩ); γ = 0.6 (manufacturer; a generic sheet says 0.7 and 8–20 kΩ: conflict recorded). Characterised 1–100 lx; outside is flagged. No response time or temperature |
| Buzzer `model.buzzer.cui_cem_1205_ic`                | Same Sky / CUI CEM-1205-IC, 09/11/2024 (`a4a26a0f…`)     | Piecewise-linear load (`src/pwl.ts`) through the page 2 V-I graph readings (3/4/5/6 V: 13.3/22.5/27.6/30.0 mA); sounds at 3.0–6.0 V forward                                                | Below 3 V and reverse: outside the model, not sounding; reverse conducts only gmin. Sound is presentation only                                                                                              |
| Relay `model.relay.songle_srd_05vdc_sl_c`            | Songle SRD datasheet via circuitbasics.com (`9967e9a6…`) | Coil 70 Ω resistor; ideal COM–NC / COM–NO contacts; armature = discrete state: picks up at ≥ 3.75 V (75 % max pull-in), drops out at ≤ 0.5 V (10 % min drop-out)                           | Guaranteed limits, not typical thresholds. Contact resistance (100 mΩ max), timing and coil inductance not modelled. A relay that interrupts its own coil is refused (`no_steady_state`)                    |

**Engine additions:** `PartModel` registry; ideal contacts in the short/loop analysis; a bounded
discrete-state fixed point (32 passes, cycle detection); `LiveControl.params` for declared live
parameters; `PwlLoad`; ESP32 pad diagnostics in `ratingWarnings` (I_OH 40 mA / I_OL 28 mA from the
same datasheet table as the pad model).

**Internal, not exposed:** `src/peripherals/i2c.ts` (I2C bus, transaction and line level, per
NXP UM10204) and `src/peripherals/hd44780.ts` (PCF8574 backpack + HD44780 4-bit controller, Hitachi
ADE-207-272(Z)). No product path drives them yet: the deployed ESP32 runtime does not model the I2C
controller.
