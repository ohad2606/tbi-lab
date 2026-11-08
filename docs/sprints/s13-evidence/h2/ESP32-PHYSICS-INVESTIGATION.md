# P0 physics investigation — ESP32 pad drive and the GPIO-to-GND short (2026-10-12)

Scope (PM, Sprint 13 review): verify the drive values and their electrical meaning, reproduce the
short, find root causes, propose electrically justified fixes with tests and impact. **No solver or
model change has been made**; the experiment below ran on a scratch edit that was reverted.

## 1. Sources (primary, Espressif)

| Document | Version | SHA-256 (prefix) |
|---|---|---|
| ESP32 Series Datasheet | v5.3 | `a7917e6b47528c9d` |
| ESP32 Technical Reference Manual | v5.8 | `4ba58e9fa0405ec2` |
| arduino-esp32 core (pinned) | 3.3.12 | provisioned toolchain |

## 2. Facts

| # | Fact | Where |
|---|---|---|
| F1 | I_OH **typ** 40 mA at V_OH ≥ 2.64 V (VDD3P3_CPU / VDD3P3_RTC domains), 20 mA (VDD_SDIO domain); I_OL **typ** 28 mA at V_OL = 0.495 V — all **"output drive strength set to the maximum"** | Datasheet Table 5-3 |
| F2 | Each digital output has a configurable drive strength: **0: ~5 mA, 1: ~10 mA, 2: ~20 mA, 3: ~40 mA. "The default value is 2."** The IO_MUX table lists `2'd2: 20 mA` for the GPIO pads | Datasheet Appendix A.1, note 8; Table IO_MUX "Drive Strength" |
| F3 | `FUN_DRV` (IO_MUX register) selects the strength 0–3, "a higher value corresponds with a higher strength"; reset value **0x2** | TRM Ch. 6, IO_MUX_x_REG |
| F4 | `pinMode()` → `gpio_config()`; the classic-ESP32 core never calls `gpio_set_drive_capability` (only the USB pads of chips with native USB) | `cores/esp32/esp32-hal-gpio.c`, `esp32-hal-tinyusb.c` |
| F5 | Table 5-1 publishes no per-pin absolute maximum and no short-circuit current | Datasheet Table 5-1 |
| F6 | The runtime bridge reports the pad's mode (input / output level), not `FUN_DRV` | Runtime v2 bridge protocol |

**Electrical meaning.** A drive-strength figure is an approximate **capability at a characterized
operating point** (Table 5-3: the source current at which the output still holds V_OH ≥ 2.64 V,
at strength 3). It is not a current limit and not a current source. A CMOS output stage is
non-linear: near the rail it behaves like a resistance; towards a short the transistors saturate
and the current is limited by the device. That short-circuit current is not published (F5).

**The product's pad model today** (`esp32Gpio.ts`): a Thévenin driver whose resistance is the
chord from (VDD, 0 A) to the characterized point: R_high = (3.3 − 2.64) / 0.040 = **16.5 Ω**,
R_low = 0.495 / 0.028 = **17.7 Ω** — the **strength-3** point, for every pin. Arduino sketches run
at **strength 2** (F2–F4). The model therefore over-states every output pad's drive by about 2×,
and GPIO16/17 (VDD_SDIO) by about 4×.

## 3. The GPIO-to-GND short — reproduced

GPIO5 on the ESP32 board; diagnostic run on the current engine:

| Mode | Wired directly to GND | Through 1 mΩ | Directly, with another powered circuit present |
|---|---|---|---|
| OUTPUT HIGH | V = 0, **I = 0 A** | V = 0.2 mV, I = 0.19999 A | V = 0, **I = 0 A** |
| OUTPUT LOW | 0 V, 0 A | 0 V, 0 A | 0 V, 0 A |
| INPUT | 0 V, 0 A | 0 V, 0 A | 0 V, 0 A |

**Root cause (a defect).** `GpioPin.current()` returns 0 when the pad's node IS the ground node
(`if (this.ip < 0) return 0;`): the pad has no unknown, so its stamp is correctly skipped, but its
current is then never evaluated, although the model defines it (I = V_th / R at V = 0). The
second path (no unknowns at all → no solve) also omits the pin devices. OUTPUT LOW and INPUT at
0 A are physically right (both ends at 0 V).

**But the "right" model value is not a valid result either.** 0.2 A is the linear chord
extrapolated to a dead short, far outside the characterized point (V = 0 vs ≥ 2.64 V), and the
real short-circuit current is unpublished (F5). Reporting it as a measurement would invent it.

## 4. Proposed fix (for approval; one change set, one re-baseline)

| # | Change | Justification |
|---|---|---|
| P1 | **Drive-strength-aware pad, default strength 2.** R from the "~20 mA" figure at the same Table 5-3 criteria: R_high = 0.66 V / 20 mA = **33 Ω**, R_low = 0.495 V / 14 mA = **35.4 Ω** (the sink point scaled by the same 20/40 ratio). GPIO16/17 (VDD_SDIO: half the CPU-domain figure at strength 3): 10 mA → R_high 66 Ω, R_low 70.7 Ω. These are **documented inferences** (the datasheet gives only approximate per-strength currents): they become model assumptions with the sources, shown in the board's model limitations | F1–F4: the drive firmware actually uses |
| P2 | **Validity region and unreliable result.** A pad's result is valid only between the rail and its characterized point (HIGH: V ≥ 2.64 V; LOW: V ≤ 0.495 V). Beyond it (an overloaded or shorted pad) the pin result and the operating point are marked **unreliable**, and the UI states that the current is beyond what the manufacturer characterizes, rather than presenting the chord value as fact. The `unrated` rating row stays | F5; PM: do not invent a short-circuit current |
| P3 | **Short defect.** `GpioPin.current()` evaluates the model at V = 0 when the node is ground; the no-unknowns path evaluates pin devices. The result is then flagged by P2 (a dead short is always outside the characterized region) | §3 root cause |
| P4 | **Explicit drive strength in sketches.** `gpio_set_drive_capability` is detected by the build service (a linked symbol) and refused as an unsupported feature until the runtime reports `FUN_DRV` (F6). Otherwise a sketch selecting strength 3 would be simulated at strength 2 | F6 |

**Tests (new):** the short matrix of §3 (all three modes, three topologies) with the expected
model value and the unreliable flag; the validity boundary on both sides of 2.64 V and 0.495 V;
GPIO16/17 vs GPIO5 resistances; the P4 refusal; the existing pad tests re-derived from the new
constants (they reference the constants, not literals, except those listed below).

## 5. Measured impact (scratch experiment with the strength-2 resistances, then reverted)

Unit suite: **7 of 1074 tests change**, each for a real reason:

| Test | Strength 3 (today) | Strength 2 | Consequence |
|---|---|---|---|
| Buzzer straight on a HIGH pad (engine and host) | 3.07 V — sounds | **2.88 V — below its 3.0 V threshold** | **the buzzer would be silent**: today's "sounds" result relies on the over-stated drive |
| Relay coil straight on a pad | 38.2 mA, 2.67 V | 32.0 mA | stays at rest in both (below the 3.75 V pull-in) |
| 8×8 matrix row on one pad (100 Ω columns) | over-loaded | 16.6 mA per path | still over-loaded |
| Output HIGH through 1 mΩ to GND | 0.200 A | 0.100 A | both are extrapolations → P2 marks them unreliable |
| Two pads fighting | > 90 mA | 48 mA | still warned |
| Cumulative 1200 mA test (8 shorted pads) | 1.6 A | 0.8 A | the test circuit must be rebuilt (needs > 12 shorted pads, or a different scenario) |

Runtime determinism (1 run each): **every pinned electrical fingerprint changes** — R-MCU-1 gate
(all 6 configurations), the 7 Sprint 12 determinism pins, the R1 determinism pins. The curated
examples' visible behaviour was not seen to change (LED loads keep their pads inside the valid
region), but their published operating points do.

**Release consequence.** P1–P3 are a change to the engine's electrical model: new baselines (R-MCU-1
at 50 runs, R1 and S12 determinism pins), the staging Gate B suites, and dev-lab Gate C — about
1.5–2 working days, best bundled with the hardening Gate C. The runtime (QEMU) is unchanged; P4
needs only the build service.

## 6. Recommendation

Approve P1–P4 as one change set before the alpha. Physics correctness takes precedence: the current
model makes at least one wiring (a buzzer straight on a pin) work in simulation that the default
pad drive does not support; a dead short reports 0 A today. Without approval, keep the model and
make the two known gaps explicit (the existing `esp32_drive` limitation plus a new one for direct
shorts).
