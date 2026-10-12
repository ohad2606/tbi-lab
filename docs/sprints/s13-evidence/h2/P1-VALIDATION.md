# P1 (default pad drive strength): validation status — STOPPED for PM review (2026-10-12)

The PM approved P1 on one condition: "validate the proposed parameters and document their
derivation and uncertainty". The rule is: stop "if a physics assumption cannot be validated". It
cannot be validated from published sources, so the model is **not** changed. P2, P3 and P4 are
implemented (`cc2f0e4`). They do not depend on P1's numbers.

## What the sources say (ESP32 Series Datasheet v5.3, sha `a7917e6b…`)

| Statement | Conditions stated |
|---|---|
| Table 5-3: I_OH typ 40 mA, VDD3P3_CPU/RTC; 20 mA, VDD_SDIO | V_OH ≥ 2.64 V, "output drive strength set to the maximum" |
| Table 5-3: I_OL typ 28 mA | V_OL = 0.495 V, maximum drive strength |
| Appendix A, note 8: "0: ~5 mA, 1: ~10 mA, 2: ~20 mA, 3: ~40 mA. The default value is 2." | **None**: no voltage, no source/sink direction, no power domain |

I found no Espressif IBIS model or other published I–V data. The ESP-IDF headers and the TRM give
only the register encoding (`FUN_DRV`, reset 2). Search record:

- ibis.org model directory: no Espressif entry
- the Espressif hardware design guidelines: no drive I–V data

## The proposed parameters and the inference each needs

| Parameter | Proposed | Inference needed (not stated by Espressif) |
|---|---|---|
| R_high, strength 2 | 33 Ω = 0.66 V / 20 mA | that "~20 mA" is measured at the same V_OH ≥ 2.64 V criterion as Table 5-3 |
| R_low, strength 2 | 35.4 Ω = 0.495 V / 14 mA | that sink capability scales by the same 20/40 ratio (no strength-2 sink figure exists) |
| GPIO16/17, strength 2 | 66 Ω / 70.7 Ω | that the VDD_SDIO domain's halving at strength 3 also holds at strength 2 |

**Uncertainty.** These figures are bounded only by consistency, not by a source:

- "~20 mA" is approximate, and its voltage condition is unknown.
- If it were measured nearer the rail, R_high would be lower. If it were measured at a deeper droop, R_high would be higher.
- No published number bounds the error.

## Effect of each option on results already measured (scratch, reverted; `ESP32-PHYSICS-INVESTIGATION.md` §5)

| Case | Today (strength-3 values) | P1 as proposed |
|---|---|---|
| Buzzer straight on a HIGH pad | 3.07 V, sounds | 2.88 V, silent (below its 3.0 V) |
| Relay coil on a pad | 38.2 mA | 32.0 mA (both at rest) |
| Every pinned fingerprint | — | changes, about 1.5–2 days of re-baselining |

With P2 now in place, both cases are honest at strength 3 on their own terms: the buzzer pad
sits at 3.07 V, inside the strength-3 chord's characterized region. What remains is whether
strength 3 is the right curve. The model-limitations text says so explicitly (EN/HE): pins use the
maximum-strength characteristic, and sketches run at the default.

## Options for the PM

| | Option | Physics status | Effort |
|---|---|---|---|
| **A (recommended)** | **Bench measurement**, then derive strength-2 parameters from it (protocol below), documented as a measurement on one DevKitC with its uncertainty | validated, for the measured sample | owner: about 1 h with a multimeter; engineering: about 2 days including the re-baseline |
| B | Adopt the proposed inference with an explicit uncertainty statement and the P2 flag widened to the inferred region | **not validated**: the PM's condition is not met | about 2 days |
| C | Keep the strength-3 model for the alpha (current state), with the limitation stated, and revisit after measurement | knowingly optimistic drive, disclosed | none |

## Bench protocol (also settles R4 O-R4-1, the duty-0 level)

Equipment:

- ESP32-DevKitC (WROOM-32), USB-powered.
- Arduino core 3.3.12.
- A multimeter.
- Resistors: 22, 33, 47, 68, 100 and 220 Ω (±1 %, actual values measured first).

1. **Source curve.** Sketch: `pinMode(5, OUTPUT); digitalWrite(5, HIGH);`. For each resistor
   from GPIO5 to GND, measure V(GPIO5) and V(3V3). Repeat on GPIO17 (VDD_SDIO domain).
2. **Sink curve.** `digitalWrite(5, LOW)`. Connect each resistor from 3V3 to GPIO5, and measure
   V(GPIO5) and V(3V3).
3. **Duty 0 (R4).** `analogWrite(2, 0)` with the pin unloaded and with a 10 kΩ load. Measure DC
   V(GPIO2). Then `ledcAttach(2, 5000, 12); ledcWrite(2, 0)`. Measure again.
4. **Record.** Board marking, ambient temperature, the exact sketch, and photos of the setup.
   The derived R_high and R_low are chord fits through the measured points. Their spread across
   the resistor values is the stated uncertainty.

Until the PM decides: no P1 change. P2 marks extrapolated pad results. P4 refuses any explicit
drive-strength selection.
