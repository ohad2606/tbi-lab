# UX, accessibility and localization audit (overnight, 2026-10-13)

**Method.** A read-only review of the Sprint 13 Alpha workflows (OS-01 … OS-10 code), then targeted fixes, each with a reproducible test.

**Status:** fixed and tested locally (unit + browser); **not deployed**. No redesign and no new feature.

**OS-02 (GPU 3D timing)** is not assessed here: it waits for the owner's GPU measurement.

## Verified fine

- All Sprint 13 message keys exist in EN and HE with the same placeholders.
- No hard-coded English labels.
- The palette armed state has `aria-pressed` plus a non-colour check mark.
- New CSS uses logical properties.
- The slider is forced LTR.
- Build phase is `role=status`.
- I2C texts isolate their tokens.

## Findings and fixes (`8f2283e`, follow-up `72537e1`)

| ID | Pri | Finding | Fix | Test |
|---|---|---|---|---|
| V1 | **P1** | A blocked Run was natively `disabled`: unreachable by keyboard and touch, and its reason only in a hover `title` or a visually hidden span | `aria-disabled` (focusable); activating it shows the reason as a notice; still no runtime request | e2e "a blocked Run is reachable by keyboard and explains itself" |
| V2 | P2 | The value field's `aria-describedby` pointed at a hint that disappears when an error is shown | Points at the visible hint or error | covered by e2e field flows |
| V3 | P2 | The slider had the same accessible name as its field, and no description | "\<label\>, slider" (EN) / "\<label\>, מחוון" (HE), plus the description | i18n key-parity test |
| V4 | P2 | Hebrew: "+ 0.5 V" and "0.7 ×" not isolated LTR (read "V 0.5 +") | Wrapped LRI…PDI, as the existing messages do | — |
| V5 | P2 | Component ids in the Run-blocked and overlap notices not isolated (ordering of "U1, U2" in Hebrew) | `isolateLtr` | unit expectations; e2e |
| V6 | P2 | Hebrew "תצוגת ה־3D" vs the UI's "תלת־ממד" | Aligned | — |
| V7 | P2 | The document-level Escape also cancelled an armed placement while Escape was reverting a field, leaving the code editor, or closing a popover | Ignored inside fields, editors, menus and dialogs | e2e "Escape in a field belongs to the field" |
| V8 | P2 | Build disabled without a referenced reason when the service is unavailable; older-build note not announced | `aria-describedby`; `role=status` | — |

**Not changed** (P2, documented):

- **S1:** a repeated identical notice may not be re-announced.
- **S2:** the invalid placement preview is a visual cue only, for pointer users. Keyboard placement picks a free place.
- **S3:** "Current: current not known" reads redundantly in one template.
- **S4:** the queue position number is not locale-formatted.
- **S5:** the canvas controls group has no name; this predates Sprint 13.
