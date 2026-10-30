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
  ohm Ω/kΩ/MΩ; farad pF/nF/µF/mF; ampere mA/A; metre mm/cm/m; volt, lux, °C, %RH, % fixed.
  A unit is hidden only when none of its values is in the parameter's range
  (`displayUnitsFor`; a capacitor's 1 nF minimum keeps pF because 1000 pF is in range).
- Shown unit = deterministic: the largest unit whose number is ≥ 1 (`chooseDisplayUnit`); 0 shows
  in the base unit. The selected unit is UI state; after a commit it is re-derived from the stored
  value (choose kΩ, enter 1 → stored 1000 → shown "1 kΩ"; after a reload the same).
- number × unit → SI is exact in decimal (`parseEntry` → `exact`); display is the exact decimal
  shift (`shiftDecimal`), so the shown pair re-reads to the identical double.
- Changing the unit keeps the typed number (220 Ω → 220 kΩ), validated against the range first;
  out of range: inline error, nothing committed, the list reverts. Typing a number then choosing
  its unit is ONE edit (focus moving from the field to its own unit list does not commit).
- Convenience, explicit: a prefixed form typed or pasted into the number field (`4k7`, `4.7k`,
  `100u`, `2M2`, `4.7 kΩ`, `50 cm`) is converted by the exact parser and then shown as number +
  unit; it is never re-scaled by the selected unit. Typed text never reaches storage.
- EN/HE: unit-list `aria-label` (`valueControl.unit`), new `error.parse.invalid` wording (no longer
  "type 1k"), `error.parse.decimal_comma` example `1.5`.
- Hebrew bidi (owner screenshot 6, "nF 1 עד 10 mF"): the range hint and range errors are rendered by
  `LtrMessage`, which puts each quantity in a `<bdi dir="ltr">` element (CSS isolation), in
  addition to the U+2066/U+2069 isolates; an e2e measures the rendered glyph order.
- Live params (PSU, environment sliders) keep their behaviour (coalesced undo, live mirror).

Params with a unit list: PSU current limit (mA, A), resistor resistance (Ω, kΩ, MΩ), capacitor
capacitance (pF, nF, µF, mF), HC-SR04 distance (mm, cm, m), potentiometer resistance (Ω, kΩ, MΩ).
Fixed symbol: PSU setpoint (V), capacitor rated voltage (V), illuminance (lx), temperatures (°C),
humidity (%RH), wiper position (%).

Behaviour change to note: a plain number is now read in the unit SHOWN beside it. A distance
of 0.5 m shows as `50` `cm`; typing `0.3` there means 0.3 cm (out of range, refused), so the
e2e specs that typed metres or base units were updated to the new model (listed in the evidence).

## Phase 2: the potentiometer (`component.potentiometer`, schema v5)

Part: **Bourns PTV09A**, 9 mm rotary, linear taper. Datasheet PTV09.pdf REV. 01/25,
https://www.bourns.com/docs/Product-Datasheets/PTV09.pdf, SHA-256 `411cdb6a…f28558`; facts with
pages in `docs/sprints/s10-evidence/datasheets/FACTS.md` §12; provenance in
`packages/engine/PROVENANCE.md`.

- Terminals: end A (pin 1), wiper W (pin 2), end B (pin 3). Parameters: `model`
  (`model.potentiometer.bourns_ptv09a_linear`), `resistance` 1 kΩ … 1 MΩ (datasheet range,
  default 10 kΩ), `position` 0 … 100 % (new unit `percent`, live, slider, coalesced undo).
- Model (packages/engine/src/parts/potentiometer.ts): R_AW = R·p, R_WB = R·(1 − p),
  p = position/100: two linear resistors; a 0 Ω segment (0 % / 100 %) is an ideal closed contact.
- Ratings: total track dissipation > 0.05 W → `unrated` power row; > 20 V between any two terminals →
  `unrated` voltage row (an operating maximum; no absolute maximum is published).
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
| Wiper on an ESP32 digital input | **Supported (digital threshold only)** | Existing pad model; no ADC |
| `analogRead` / ADC of a wiper | **Refused** (by name, at Build) | ADC unsupported in V1 (unchanged) |
| Audio (A) / reverse-audio (C) / S-shaped (B1–B5) tapers | **Refused** (not offered) | Only graphs in the datasheet; not characterised |
| Resistance outside 1 kΩ … 1 MΩ | **Refused** (range) | Datasheet standard range |
| End (residual) resistance | **Not characterised** → idealised 0 Ω (ASSUMPTION POT-1) | Datasheet gives only a bound: "500 ohms or ±1 % max." |
| ±20 % tolerance | **Not characterised** → nominal value (ASSUMPTION POT-2) | As every other part |
| Power on part of the track (rheostat), max wiper current, contact resistance | **Not characterised** (no limit checked; stated in the part's limitations) | NOT FOUND in the datasheet |
| Shaft angle ↔ position (B0 curve end zones), electrical angle | **Not characterised** | Graph only; position is defined as the electrical share A–W |
| Temperature (derating above 50 °C, TCR) | **Not characterised** | Results at 25 °C (full rating) |

### Examples

1. `pot-divider` — 10 kΩ across 5 V, wiper probe; V_W = 5 V × (1 − p): checked at 0/25/50/100 %.
2. `pot-led-dimmer` — W–B as a rheostat in series with 220 Ω and the red LED on 5 V; LED current
   strictly rising in p (checked every 10 %), no rating row at any position, 13.72 mA at 100 %.
3. ESP32 pot example: **skipped.** It would only show the existing digital threshold model with a
   divider (already demonstrated by `esp32-night-light`), and a potentiometer next to an ESP32
   invites `analogRead`, which is refused; an example built around a refused facility would
   mislead. Proposed for the ADC sprint.

## Owner decisions (open)

- **OD-POT-1 (end resistance):** keep the 0 Ω idealisation at the track ends, or model a value
  (the datasheet gives only the bound 500 Ω / 1 %), or refuse exactly 0 % and 100 %.
- **OD-POT-2 (partial-track power):** the datasheet rates only the whole element (0.05 W). Keep the
  total-dissipation check plus the limitation text, or adopt the common industry rule (power
  proportional to the track fraction in use, i.e. max current √(P/R)) as a labelled assumption.
- **OD-POT-3 (resistance values):** the PTV09A is made in 1-2-5 values only (1k, 2k, 5k … 1M);
  the parameter currently accepts any value in 1 kΩ … 1 MΩ. Restrict to the list?
- **OD-POT-4 (metre display):** with the design's rule a 0.5 m distance shows as `50 cm` (an
  earlier owner request, OS-06, asked for plain metres). Keep, or pin metre to `m`?
- **OD-POT-5 (deploy):** rebuild/redeploy the DEV Session Host with this branch so ESP32 sessions
  accept the new type (the frontend alone is not enough).

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
