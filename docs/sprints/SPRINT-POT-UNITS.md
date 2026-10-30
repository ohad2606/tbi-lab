# Sprint POT-UNITS (DEV, 2026-10-30): value + unit editing, and the potentiometer

Branch `dev-pot-units` from `0389c47` (the build deployed on DEV-Lab). Design:
`~/tbi-pot/DESIGN.md` Phases 1 and 2 (Phase 3, routing, is a separate brief). Evidence:
`~/tbi-pot/evidence/{p1-units,p2-pot}/NOTE.md` (outside the repo).

## PM decision changed (owner directive, 2026-10-30)

`docs/product/V1-PRODUCT-SCOPE.md` deferred the potentiometer to V1.1 together with the ADC
(PM-6). The owner now prioritises the potentiometer **as a passive part**. It ships as
`component.potentiometer`; **the ADC stays refused** (`capabilities.ts` `adc`,
`runtime/builder/features.ts`). Next to an ESP32 a wiper is read only through the existing
digital input-threshold model. The scope document records the change at both places.

## Phase 1: value + unit dropdown

Storage was already canonical (`{ value: SI number, unit: UnitId }`), so **no data migration**: old
projects load unchanged. Only the editor changed.

- `ValueControl` (app/src/ui/ValueControl.tsx): a plain number field plus a `<select>` of display
  units when a quantity has more than one useful unit; a fixed symbol otherwise.
- Display-unit sets are data in `packages/domain/src/units.ts` (`DISPLAY_UNITS`):
  ohm Ω/kΩ/MΩ; farad pF/nF/µF/mF; ampere mA/A; metre, volt, lux, °C, %RH, % fixed (metre per OS-06, OD-POT-4).
  A unit is hidden only when none of its values is in the parameter's range
  (`displayUnitsFor`; a capacitor's 1 nF minimum keeps pF because 1000 pF is in range).
- Shown unit = deterministic: the largest unit whose number is ≥ 1 (`chooseDisplayUnit`); 0 shows
  in the base unit. The selected unit is UI state; after a commit it is re-derived from the stored
  value (choose kΩ, enter 1 → stored 1000 → shown "1 kΩ"; after a reload the same).
- number × unit → SI is exact in decimal (`parseEntry` → `exact`); display is the exact decimal
  shift (`shiftDecimal`), so the shown pair re-reads to the identical double.
- Unit choice (review M1): if the number was TYPED since it was last committed or shown, the
  chosen unit applies to the typed number and commits (220 + kΩ → 220 kΩ), validated first; out of
  range: inline error, nothing committed, the list reverts. If the number was NOT edited, a unit
  choice only re-expresses the same stored value (2 mA → 0.002 A) and commits nothing, so a unit
  change alone (mouse or arrow keys on a focused list) never changes a value, live or not.
  Typing a number then choosing its unit is ONE edit: the field's blur towards its own unit list
  (focus, or a pointer pressed on the list where the browser does not focus it: review L3) does
  not commit in the old unit; Enter/blur commit only a typed number.
- Exponent notation (review L2) is a plain number in the shown unit: `1e3` with kΩ is 1 MΩ.
- Convenience, explicit: a prefixed form typed or pasted into the number field (`4k7`, `4.7k`,
  `100u`, `2M2`, `4.7 kΩ`) is converted by the exact parser and then shown as number +
  unit; it is never re-scaled by the selected unit. Typed text never reaches storage.
- EN/HE: unit-list `aria-label` (`valueControl.unit`), new `error.parse.invalid` wording (no longer
  "type 1k"), `error.parse.decimal_comma` example `1.5`.
- Hebrew bidi (owner screenshot 6, "nF 1 עד 10 mF"): the range hint and range errors are rendered by
  `LtrMessage`, which puts each quantity in a `<bdi dir="ltr">` element (CSS isolation), in
  addition to the U+2066/U+2069 isolates; an e2e measures the rendered glyph order.
- Live params (PSU, environment sliders) keep their behaviour (coalesced undo, live mirror).

Params with a unit list: PSU current limit (mA, A), resistor resistance (Ω, kΩ, MΩ), capacitor
capacitance (pF, nF, µF, mF), potentiometer resistance (Ω, kΩ, MΩ).
Fixed symbol: HC-SR04 distance (m, shown and typed in plain metres exactly as before, OS-06), PSU setpoint (V), capacitor rated voltage (V), illuminance (lx), temperatures (°C),
humidity (%RH), wiper position (%).

Behaviour change to note: a plain number is now read in the unit SHOWN beside it (a resistor
showing `1` `kΩ` reads `220` as 220 kΩ), so the e2e specs and the `setValue` helper that typed
base-unit numbers into list fields were updated. A fixed-symbol quantity keeps its pre-sprint
range text (`formatQuantity`). Distances are unaffected (OD-POT-4 below).

## Phase 2: the potentiometer (`component.potentiometer`, schema v5)

Part: **Bourns PTV09A**, 9 mm rotary, linear taper. Datasheet PTV09.pdf REV. 01/25,
https://www.bourns.com/docs/Product-Datasheets/PTV09.pdf, SHA-256 `411cdb6a…f28558`; facts with
pages in `docs/sprints/s10-evidence/datasheets/FACTS.md` §12; provenance in
`packages/engine/PROVENANCE.md`.

- Terminals: end A (pin 1), wiper W (pin 2), end B (pin 3). Parameters: `model`
  (`model.potentiometer.bourns_ptv09a_linear`), `resistance` 1 kΩ … 1 MΩ (datasheet range,
  default 10 kΩ), `position` 0 … 100 % (new unit `percent`, live, slider, coalesced undo) on a
  **0.01 % grid** (review M2: arbitrarily small segments made the solver fail): the UI rounds a
  typed position to 0.01 % and shows it; the domain refuses an off-grid value by name
  (`setParam` → `off_grid`, `validateProject` → `off_grid_param`, `liveControlProblem` →
  `invalid_value` with `detail: 'off_grid'`; EN/HE `error.param.off_grid`). Both examples solve at
  0.01 % and 99.99 % with 1 kΩ and 1 MΩ.
- Model (packages/engine/src/parts/potentiometer.ts): R_AW = R·p, R_WB = R·(1 − p),
  p = position/100: two linear resistors; a 0 Ω segment (0 % / 100 %) is an ideal closed contact.
- Ratings (all `unrated`: outside the datasheet's specified/rated condition, never a damage claim):
  - total track dissipation > 0.05 W → power row;
  - **derived rated-condition track current (review H1)**, no new number: at the rated
    whole-track dissipation the track current is uniform, I_rated = √(P_rated / R_total)
    (7.07 mA for 1 kΩ, 2.24 mA for 10 kΩ, 0.224 mA for 1 MΩ). A segment (A–W, W–B) or the wiper
    contact carrying more than I_rated dissipates more heat per unit track length than any rated
    condition → a `track_current` row per segment/wiper ("outside the datasheet's rated
    condition", EN/HE, quantities LTR-isolated). This is a conservative warning, not a damage
    threshold; damage behaviour stays open (OD-POT-2). It closes the fail-open case the review
    found (5 V through 100 Ω into a 2 % rheostat: 41.7 mA, 34.7 mW < 0.05 W, previously no row);
  - > 20 V between any two terminals → voltage row (an operating maximum; no absolute maximum).
- Results: voltage A–B, currents A→W, W→B and into the wiper, R_AW, R_WB, total dissipation, wiper
  voltage to GND; the canvas shows `W <voltage>` while running and `<R> · <position>` as the design
  value.
- Schema v5: new type + unit ⇒ `SCHEMA_VERSION = 5`, identity migration 4 → 5, so a v4 build
  opens a v5 file as "made by a newer version" (by name) instead of "invalid". All example JSON were
  regenerated (only the two `schemaVersion` fields changed).
- ESP32: allowed as a passive part (no `mcuRuntime: false`); in `PWM_AVERAGED_TYPES` (two linear
  resistors are instantaneous at PWM rates, as a resistor). The live position is mirrored to the
  Session Host like the photoresistor's light level. **Deploy note:** the DEV Session Host must be
  rebuilt from this branch before a running ESP32 session can mirror a potentiometer (the deployed
  host does not know the type).
- UI: palette (Passive), 2D symbol (resistor + wiper arrow), schematic (module block "POT" with pins
  1 (A), 3 (B), 2 (W) and a potentiometer glyph), 3D model PTV09A-2 (body 10.0 × 6.8 mm, shaft
  axis 10 mm, Ø6 shaft L = 15 mm, pins 2.5 mm pitch), discover rule (passive, basic), EN/HE texts
  and glossary terms `potentiometer`, `wiper`.

### Classification

| Behaviour | Status | Why |
|---|---|---|
| Linear divider / rheostat, any position 0 … 100 %, R 1 kΩ … 1 MΩ | **Supported** | Two linear resistors; numerics checked against closed forms (rel 1e-9) |
| Live position change while running (local engine and ESP32 mirror) | **Supported** | `liveParams: ['position']`; engine, Session Host and e2e tests |
| Total dissipation > 0.05 W, voltage > 20 VDC | **Supported (warning)** | Datasheet p.1; `unrated`: no damage threshold published |
| Segment or wiper current above √(0.05 W / R) (rheostat use) | **Supported (warning)** | Derived from the datasheet's rated condition; `unrated`, conservative, not a damage threshold |
| Position off the 0.01 % grid | **Refused** (by name, `off_grid`) | Resolution; keeps every segment ≥ 0.01 % of R |
| Wiper on an ESP32 digital input | **Supported (digital threshold only)** | Existing pad model; no ADC |
| `analogRead` / ADC of a wiper | **Refused** (by name, at Build) | ADC unsupported in V1 (unchanged) |
| Audio (A) / reverse-audio (C) / S-shaped (B1–B5) tapers | **Refused** (not offered) | Only graphs in the datasheet; not characterised |
| Resistance outside 1 kΩ … 1 MΩ | **Refused** (range) | Datasheet standard range |
| End (residual) resistance | **Not characterised** → idealised 0 Ω (ASSUMPTION POT-1) | Datasheet gives only a bound: "500 ohms or ±1 % max." |
| ±20 % tolerance | **Not characterised** → nominal value (ASSUMPTION POT-2) | As every other part |
| Damage behaviour of a segment or the wiper above the rated condition; contact resistance | **Not characterised** (warned, not modelled) | NOT FOUND in the datasheet (OD-POT-2) |
| Shaft angle ↔ position (B0 curve end zones), electrical angle | **Not characterised** | Graph only; position is defined as the electrical share A–W |
| Temperature (derating above 50 °C, TCR) | **Not characterised** | Results at 25 °C (full rating) |

### Examples

1. `pot-divider` — 10 kΩ across 5 V, **end A (pin 1) at GND, end B at +5 V** (review L4: "turn up
   = more volts", as the datasheet's V_1-2/V_1-3 taper axis); wiper probe; V_W = 5 V × p, checked
   at 0/25/50/100 %.
2. `pot-led-dimmer` (redesigned, review H1) — the W–B segment of a **1 kΩ** pot as a rheostat in
   series with **470 Ω** and the red LED on 5 V. I_rated = √(0.05 W / 1 kΩ) = 7.07 mA; the
   engine sweep (every 1 % plus 0.01, 0.1, 99.9, 99.99 %) gives LED current 2.12 mA at 0 % rising
   strictly to **6.50 mA at 100 %**, below I_rated: no rating row of any kind at any position. This
   is the brightest design with an E24 series resistor: 430 Ω gives 7.09 mA at 100 % and a
   `track_current` (wiper) row (tested). The previous design (10 kΩ + 220 Ω) carried up to 6× the
   rated-condition current near the B end.
3. ESP32 pot example: **skipped.** It would only show the existing digital threshold model with a
   divider (already demonstrated by `esp32-night-light`), and a potentiometer next to an ESP32
   invites `analogRead`, which is refused; an example built around a refused facility would
   mislead. Proposed for the ADC sprint.

## Owner decisions (open)

- **OD-POT-1 (end resistance):** keep the 0 Ω idealisation at the track ends, or model a value
  (the datasheet gives only the bound 500 Ω / 1 %), or refuse exactly 0 % and 100 %.
- **OD-POT-2 (partial-track damage behaviour):** the datasheet rates only the whole element
  (0.05 W). Decided now: a conservative warning at the rated-condition track current √(P/R)
  (above). Still open: whether any DAMAGE/failure behaviour may be claimed above it (needs a
  manufacturer source; none is used).
- **OD-POT-3 (resistance values):** the PTV09A is made in 1-2-5 values only (1k, 2k, 5k … 1M);
  the parameter currently accepts any value in 1 kΩ … 1 MΩ. Restrict to the list?
- **OD-POT-4 (metre display): RESOLVED 2026-10-30** — the earlier owner decision OS-06 stands:
  `metre` is a fixed-symbol unit again (no list); 0.5 m shows as `0.5` `m` and typing `0.3`
  commits 0.3 m, exactly as before 0389c47. The e2e changes that existed only for the cm/mm
  display were reverted (s12-parts, s12-real, s13-journey-real, s13-export-real, the distance
  parts of s13-live-real and s13-owner-smoke OS-06, which now also checks the stored 0.3 m).
- **OD-POT-5 (deploy):** rebuild/redeploy the DEV Session Host with this branch so ESP32 sessions
  accept the new type (the frontend alone is not enough).

## Deployment (review M3)

- Frontend and Session Host must be deployed **together** from the same commit: the host must
  know `component.potentiometer` (and `percent`) for ESP32 sessions with a potentiometer; plain
  v5 circuits without one keep working on the old host (it accepts schemaVersion 1–1000).
- **One-way schema step.** Any project edited in this build is stored as v5. **Rollback caveat:**
  rolling DEV-Lab back to 0389c47 makes every v5-saved project open **read-only** ("made by a
  newer version"), and v5 files are refused on import as newer; projects containing a
  potentiometer cannot be opened for editing or simulated at all on 0389c47. Rolling back is
  safe for data (nothing is rewritten) but not transparent to users; plan it as such.

## Review notes (2026-10-30)

- L5: the 3D pin order (pins 1-2-3 left to right facing the shaft) is not independently
  verifiable from the datasheet (its PCB layout shows t1-t2-t3 left to right but not the shaft
  side). The 2D canvas (A left, W top, B right) and the schematic follow the datasheet schematic.
- L1: every quantity in the new Hebrew potentiometer limitation, rating-row and example strings is
  an LTR isolate (U+2066/U+2069); older strings are unchanged.

## Future / Backlog

- ESP32 potentiometer example together with the ADC sprint.
- Audio taper once a tabulated curve is available.
- Show the wiper angle on the 3D shaft.

## Verification (DEV host, 2026-10-30)

- `npm run typecheck`: pass. `npm run lint` (eslint, prettier, boundaries): pass.
- `npx vitest run` (full): 192 files, 1866 tests, all pass. New: `packages/domain/tests/units.test.ts`
  (display units), `app/tests/units-ux.test.ts`, `packages/domain/tests/schema-v5-pot.test.ts`,
  `packages/engine/tests/potentiometer.test.ts`, `runtime/host/tests/pot-mirror.test.ts`, example
  numerics in `app/tests/examples.test.ts`.
- Playwright (CI=1, serial): `pot-units.spec.ts` (new), editor, os12-examples, s12-parts, sprint4,
  s13-owner-smoke, s9-sync, locale, commit-race, restart, sprint5, simulation, sim-restart,
  maintenance, sprint5-prepush, s10, s10-parts, s11-r1, sprint5-performance, s10-3d-assets: all
  pass (after fixes; first run had 4 failures, listed in the evidence note). The real-runtime specs
  (s12-real, s13-journey-real, s13-live-real, s13-export-real) were updated but not run (they need
  the real Session Host + QEMU). The full Playwright suite was not run.

### OD-POT-4 follow-up (metre fixed again)

typecheck and lint pass; vitest units, units-ux, i18n, examples, s13-slider-scale, schema-v5-pot:
190 tests pass; Playwright (CI=1) s13-owner-smoke, s12-parts, pot-units, editor: 27 passed. The
real-runtime specs restored to their 0389c47 form were not run (real Session Host needed).

### Review fixes (H1, M1, M2, M3, L1–L5) verification

typecheck and lint pass; full vitest 192 files / 1873 tests pass; Playwright (CI=1, one suite at a
time): pot-units 4, editor 7, os12-examples 2, s13-owner-smoke 13, locale 4, sprint5 11 — all pass.
