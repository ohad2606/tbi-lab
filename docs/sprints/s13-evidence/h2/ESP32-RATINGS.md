# H2 — ESP32 electrical limits verified against the manufacturer (2026-10-12)

Source: Espressif **ESP32 Series Datasheet, Version 5.3**, downloaded from
`https://documentation.espressif.com/esp32_datasheet_en.pdf` (redirect of the espressif.com
link), SHA-256 `a7917e6b47528c9d…`, text extracted with `pdftotext -layout`. The PDF does not
render minus signs (missing fonts; see `docs/sprints/s11-evidence/datasheets/FACTS.md`).

| Fact | Table | Kind | Product use (Sprint 13) |
|---|---|---|---|
| VDDA, VDD3P3, VDD3P3_RTC, VDD3P3_CPU, VDD_SDIO allowed input voltage −0.3 … 3.6 V | 5-1 Absolute Maximum Ratings | **absolute** (supply domains only) | the board is supplied from its own 3.3 V model; not a user input |
| Cumulative IO output current 1200 mA | 5-1 | **absolute** | new row `gpio_cumulative_current` (absolute) |
| No per-pin voltage or current absolute maximum | 5-1 | — | per-pin rows are `unrated` |
| V_IH 0.75 VDD … VDD + 0.3 V; V_IL −0.3 V … 0.25 VDD | 5-3 DC Characteristics | characteristic | `gpio_input_overvoltage` / `gpio_output_overvoltage`: `unrated` |
| I_OH **typ** 40 mA (VDD3P3_CPU, VDD3P3_RTC domains), **20 mA (VDD_SDIO domain)**, at V_OH ≥ 2.64 V, max drive strength; footnote 2: falls from ~40 to ~29 mA as more pins source in the domain | 5-3 | typical characteristic | `gpio_source_current`, contention, shorts: `unrated`, limit per domain |
| I_OL **typ** 28 mA at V_OL = 0.495 V | 5-3 | typical characteristic | `gpio_sink_current`: `unrated` |
| VDD_SDIO domain pins on the DevKitC header: GPIO16 (chip pin 25), GPIO17 (chip pin 27) | pin layout / IO_MUX | — | `SDIO_DOMAIN_GPIOS` |

Corrections made (warnings only; no solved value changes):
- "drive rating" → "typical drive"; per-pin rows no longer claim damage ("may be damaged"); they are
  `unrated`: the manufacturer publishes no damage threshold; the risk is unknown, not zero.
- GPIO16/17 judged against 20 mA, not 40 mA.
- New absolute check: total output current > 1200 mA.
- "ESP32 pins are not 5 V tolerant" → "not specified for 5 V" (the datasheet's input range).

**Findings for PM decision (not changed):**
1. **Pad driver model, GPIO16/17.** The electrical pad model (`esp32Gpio.ts`) derives one driver
   resistance from the 40 mA point for every pin; for the VDD_SDIO domain the datasheet's
   characteristic is 20 mA, so GPIO16/17 are modelled as stronger drivers than specified. Fixing it
   changes solved values for circuits on those pins (and possibly determinism pins): a physics-model
   change. Documented as a model limitation (`limitation.esp32_drive`) meanwhile.
2. **A pad wired directly to GND (no resistor) reports 0 A.** The short is flagged
   (`gpio_short_ground`), but the solver attaches the pad to the ground node itself, so the reported
   current and voltage are 0 instead of the driver-limited ≈ 200 mA (with a 1 mΩ link the current
   is correct: `gpio-conflicts.test.ts`). Pre-existing since Sprint 10; to investigate.
