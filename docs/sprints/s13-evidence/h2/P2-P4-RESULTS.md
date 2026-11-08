# Physics P2–P4: implemented, before/after, affected regressions (2026-10-12)

PM decision: approve P1–P4.

- **P2–P4 are implemented** (`cc2f0e4`, `7a0005e`).
- **P1 is stopped.** Its parameters cannot be validated from published sources: `P1-VALIDATION.md`.
- **The pad model is still the strength-3 chord.** No calculated value has changed except the defective 0 A short.

## Electrical reference

ESP32 Series Datasheet v5.3:

| Source | Content |
|---|---|
| Table 5-3 | V_OH ≥ 2.64 V at I_OH (40 mA; 20 mA VDD_SDIO); V_OL = 0.495 V at I_OL 28 mA; maximum drive strength |
| Table 5-1 | No per-pin or short-circuit current |

The pad model is a Thévenin chord from the rail to the characterized point. Between the rail and that point the model is anchored by the datasheet. Beyond it, the value is an extrapolation.

## Before / after (calculated by the engine)

| Case | Before | After |
|---|---|---|
| OUTPUT HIGH, pad wired straight to GND | **0 A** (defect) | Model current 3.3 V / 16.5 Ω = 0.200 A, **`outsideModelRange`**. The warning `gpio_short_ground` is kept and marked `unreliable`. The UI shows "current not known (beyond the range the manufacturer characterizes)", never 0.2 A and never 0 A |
| Same, through 1 mΩ | 0.19999 A shown as a value | Same number, flagged. The UI says not known |
| Same, board only: board + ground symbol, nothing else | Run refused: `empty_circuit`; the pad at the ground symbol was `invalid_attachment` | Solved as above |
| OUTPUT LOW or INPUT on GND (all topologies) | 0 A | 0 A, unflagged (exact: both ends at 0 V) |
| OUTPUT HIGH into 22 Ω | 85.7 mA shown | 85.7 mA, flagged (pad 1.89 V < 2.64 V). The row is `unreliable` |
| OUTPUT HIGH into 66.5 Ω / 65.5 Ω | 39.8 / 40.2 mA | Inside / outside: the boundary is exactly the datasheet point |
| OUTPUT LOW sinking from 3.3 V via 101 / 99 Ω | — | Inside / outside (crossover 100.18 Ω) |
| Cumulative 1200 mA row computed from extrapolated pads | Shown as a value | Marked `unreliable` |
| `gpio_set_drive_capability` in a sketch | Simulated at the model's strength | **Refused at Build** (`drive_strength`). Verified: a positive control links the symbol; the TbiLcd (Wire) and probe ELFs do not |
| LED loads, all curated examples | Unchanged | Unchanged. Every ESP32 example was checked with all attached pads HIGH and then LOW: no pad is outside the region, and there are no unreliable rows |

The UI text and model limitations (EN/HE) state the maximum-strength characteristic, the default strength sketches run at, and that the current beyond the characteristic is not known.

## Tests

| Level | Test |
|---|---|
| Unit | `packages/engine/tests/s13-pad-validity.test.ts` (13): 3 modes × 3 topologies, board only, ground attachment, both boundaries, cumulative |
| Unit | `gpio-conflicts.test.ts`, strengthened with the flags |
| Unit | `app/tests/s13-pad-validity-ui.test.ts`: EN/HE row text |
| Unit | `runtime/builder/tests/features.test.ts`: P4 |
| Real QEMU | `runtime/tests/s13-pad-short.runtime.test.ts`: TbiGpioProof drives GPIO2 on GND; HIGH flagged at the model current, LOW 0 A |
| End to end | `app/e2e/s13-pad-short.spec.ts` (EN/HE): the warning names the short, the current is not shown; Build → Run path |

## Pinned fingerprints

P2 adds fields only when a pad is outside the region. P3 changes a value only for a pad on GND. Neither occurs in a pinned scenario. Verified by the pinned runtime suites in the final CI: see the Sprint 13 report.

## No fabricated short-circuit current

Espressif publishes none (Table 5-1). The product reports the condition, the model's extrapolation, and the explicit statement that the real current is not known. It does not present an invented number.
