# TBI Lab Sprint 11: primary-source datasheet facts

Fetch date: **2026-10-08**. The PDF is not stored in the repository (as in Sprint 10); its SHA-256
identifies the exact file read. "p." is the PDF page.

## ESP32 Series Datasheet (Espressif Systems), version 5.3

| Item | Value |
|---|---|
| Source URL | https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf |
| File | `esp32_datasheet_en.pdf`, 78 pages, "Datasheet Version 5.3" (the same version `packages/engine/src/esp32Gpio.ts` cites) |
| SHA-256 | `a7917e6b47528c9dcab06837a49d452e582751335797db879f1cf2d17cd29adf` |

| Fact | Value | Where |
|---|---|---|
| Absolute maximum, VDDA / VDD3P3 / VDD3P3_RTC / VDD3P3_CPU / VDD_SDIO, allowed input voltage | −0.3 V … 3.6 V | Table 5-1 "Absolute Maximum Ratings", p. 51 |
| Absolute maximum, cumulative IO output current | 1200 mA | Table 5-1, p. 51 |
| V_IH, high-level input voltage | min 0.75 × VDD, **max VDD + 0.3 V** (3.6 V at VDD = 3.3 V) | Table 5-3 "DC Characteristics (3.3 V, 25 °C)", p. 52 |
| V_IL, low-level input voltage | **min −0.3 V**, max 0.25 × VDD | Table 5-3, p. 52 |
| I_IH, I_IL input leakage | max 50 nA | Table 5-3, p. 52 |

Reading note (checked on the rendered pages at 110 dpi, not only the extracted text): in this PDF
the **minus sign does not render** (poppler reports missing fonts, "Unknown font tag 'F8'"); both
the rendered page and `pdftotext` show "0.3" in the Min column. The minus is inferred, and the
inference is forced by the same table: Table 5-1 lists the storage temperature as "40 … 150 °C",
which can only be −40 °C, and a V_IL **minimum** of +0.3 V would make 0 V an invalid logic low.
The product's lower limit therefore uses −0.3 V. The **upper** limit used (VDD + 0.3 V = 3.6 V) is
unambiguous on the page.

**Use in the product (Sprint 11, R1):** `gpio_input_overvoltage` (an input pad's solved voltage
outside −0.3 … 3.6 V) and `gpio_reverse_current` (an output pad forced beyond the same range by the
external circuit). Warnings only: they never change a solved value.
