# Sprint 13 — Owner Smoke findings register (OS-01 … OS-09)

Registered 2026-10-12 from the PM decision "Owner Smoke Findings + Sprint 13 Physics Decision".
This is the Sprint 13 acceptance tracking record (the project tracks acceptance in these sprint
documents; no external issue tracker is used).

**Owner observations and reproduction steps.** The PM decision summarises each finding in one
line. The owner's own words and reproduction steps were **not included** in what engineering
received. Each row records the PM summary verbatim. The "Owner observation / repro" column stays
**requested** until the owner's notes arrive. Engineering's reproduction is recorded separately
and is not a substitute for the owner's.

**Status: OS-01..09 fixed on `sprint-13` (`2e9ab98`), OS-10 added and fixed later the same day, verified by unit, e2e and (where relevant) real-QEMU tests; NOT accepted — each needs the owner's retest (OS-02 on the owner's GPU machine).**

**Owner Smoke acceptance (Sprints 11/12): OPEN.** It is not claimed until the owner finishes the
remaining tests.

| ID | Pri | PM summary (verbatim) | Owner observation / repro | Slice | Status |
|---|---|---|---|---|---|
| OS-01 | P1 | Reusable engineering value control with numeric input and appropriate SI units. Preserve canonical physical values and support EN/HE. | requested | S-B controls | fixed, owner retest |
| OS-02 | P1 | Profile the reported 5–7 second 3D render on a minimal circuit; optimize the measured bottleneck. | requested ("5–7 s, minimal circuit") | S-D 3D | fixed, owner retest |
| OS-03 | P1 | LDR live visual and simulation updates during dragging, with bounded command frequency and guaranteed final value. | requested | S-B controls | fixed, owner retest |
| OS-04 | P0 | Prevent invalid component-body overlaps, consistently across Circuit and derived 3D views. | requested | S-C geometry | fixed, owner retest |
| OS-05 | P1 | Prevent wires from obscuring critical component displays where valid alternative routing exists. | requested | S-C geometry | fixed, owner retest |
| OS-06 | P1 | HC-SR04 slider units, range, monotonic interaction and live updates. | requested | S-B controls | fixed, owner retest |
| OS-07 | P1 | Remove horizontal overflow in the sensor property inspector without reducing the main workspace. | requested | S-B controls | fixed, owner retest |
| OS-08 | P0 | Correct Build/Run state management. Run must not be available while a build is in progress or when firmware is stale. | requested | S-A build/run | fixed, owner retest |
| OS-09 | P0 | Investigate reversed LCD VCC/SDA wiring, verify electrical diagnostics and provide an accurate actionable refusal or warning where supported. | requested | S-E diagnostics | fixed, owner retest |
| OS-10 | P1 | Improve selected-component visibility in the component palette (selected tile changes only its border; placement state insufficiently visible). Added by the PM 2026-10-12. | requested | S-B controls | fixed, owner retest |

## Slices (each independently testable)

| Slice | Items | Boundary |
|---|---|---|
| S-A build/run | OS-08 | `app/src/programs/state.ts`, `SimControls`, `AppStore.run` |
| S-B controls | OS-01, OS-03, OS-06, OS-07 | inspector value control, environment sliders, live mirror path |
| S-C geometry | OS-04, OS-05 | domain edit operations (footprints), router obstacles |
| S-D 3D | OS-02 | 3D open path, measured before/after |
| S-E diagnostics | OS-09 | LCD part model, I2C presence diagnostics |

## Per-item record

For each item, the root cause, the fix, the acceptance criteria and the regression tests are
recorded below as the work lands.

### OS-08 — Build/Run state (P0) — fixed in S-A, e2e pending the batch run

**Root causes** (engineering reproduction in code; owner steps requested):

1. **Build state was never consulted for Run.**
   - The Run button was disabled only while stopping (`SimControls.tsx`), and `AppStore.run()` had no build check.
   - So Run was clickable while building and with stale firmware. The refusal came only *after* the click (`mcu_build_required`, a failed run).
   - It never executed a stale artifact, but Run was available, which is the defect.
2. **The build/session exclusion (D-S7-9) held in one direction only.** Build was refused during a session, but nothing refused a Run (including the Advanced prebuilt Run) during a build.
3. **Editing during a build made the next Build click a silent no-op.** One build runs per program, and the click returned `false` without any message.

**Fix:**

- `AppStore.runBlocker()` is the single rule. Run is unavailable while any build is in progress, and for every board that runs its code without a current successful build of exactly that code (never built, edited since, or failed).
- `run()` enforces the rule for every caller. The button is disabled, with the reason as its accessible description and its tooltip (`data-blocked`).
- `runPrebuilt` is refused during a build.
- `ProgramBuilds.view()` reports `olderBuildRunning`. The Build button is disabled with a note until the older build ends.

**Acceptance criteria:**

- (a) Run is never enabled during a build.
- (b) Run is never enabled when the program's last successful build is not of the current code.
- (c) No runtime request is made in either case.
- (d) After a successful build of the current code, Run is enabled.
- (e) An edit during a build is explained, and Build works once the older build ends.

**Tests:**

- `app/tests/s13-run-gating.test.ts`, 6 tests: never built, during build, rebuild of the same code, stale after edit, failed build, prebuilt during build, edit mid-build.
- `app/e2e/s7.spec.ts`: Build-required flow updated to the disabled Run with its reason, including during the build.

**Design note:** previously, clicking Run with no build moved the focus to the Build button. A disabled control cannot do that, so the guidance is now the reason on the Run control plus the build status in the code view. The owner may want a visible hint in the toolbar too.

### OS-09 — reversed LCD VCC/SDA (P0) — fixed in S-E

**Engineering reproduction:** module VCC → the SDA pull-up net with GPIO21; module SDA → the PSU rail.

- The engine solved the module as unpowered (VCC ≈ 3.3 V, below 4.5 V). The only flag was the generic "outside model range" note.
- At runtime, Wire got NACKs. No diagnostic said why: `i2c_wiring` covered only SDA↔SCL swaps.
- The rail on SDA had no rating check.
- **Every** I2C diagnostic reached the user only as "Runtime warning: \<code\>".

**Root causes:**

1. No check of SDA/SCL against the PCF8574's published input limit.
2. The I2C presence check did not name a line that lands on the module's supply pin.
3. The UI had no text for the I2C diagnostic codes.

**Fix (physics from the datasheet only):**

- **Engine:** the LCD part checks SDA/SCL against the PCF8574 limiting value V_I ≤ V_DD + 0.5 V (NXP PCF8574 Rev. 5, Table 7; absolute). A breach is an `absolute` row on the `sda`/`scl` channel.
  - The input clamp current is **not** modelled. That is stated as the new limitation `lcd_input_clamp`, and no damage or current is invented.
- **Host:** `i2c_wiring` gets the reason `supply_pin`, with the line, the pad and the module pin (`vcc`/`gnd`).
- **UI:** specific EN/HE texts for `i2c_wiring` (`supply_pin`, `swapped`), `i2c_no_pullup`, `i2c_logic_level` and `i2c_rate_exceeded`.

**Acceptance criteria:**

- (a) The swap is named: which pad, which line, which module pin.
- (b) The module does not respond (NACK), as on a real bus.
- (c) The supply on SDA is flagged against the published absolute maximum.
- (d) No damage model and no invented current.
- (e) The text is localized in EN and HE.

**Tests:**

- `runtime/host/tests/r3-i2c.test.ts`: VCC/SDA swap → `i2c_wiring supply_pin` plus an absolute SDA row with limit = V_DD + 0.5.
- `runtime/tests/s12-r3.runtime.test.ts`: real QEMU, Wire NACK (4), the diagnostic, unpowered.
- `app/tests/s13-i2c-warnings.test.ts`: EN/HE texts.

### OS-04 — component-body overlaps (P0) — fixed in S-C

**Root cause:**

- Nothing in the edit path checked bodies. `addComponent`, `moveSelection` and `rotateComponents` accepted any position. The palette's "place at centre" avoided only an identical origin.
- The 3D view's visual-only separation (Sprint 10) pushed some colliding bodies apart in 3D. It is capped, and it leaves "unresolved" pairs. So 2D and 3D could disagree, and both could show overlapping parts.
- The two views use different sizes. The LCD module is 80 × 36 mm in 3D, but its symbol is about 37 × 15 mm.

**Fix:** one rule (`app/src/geometry/overlap.ts`) for both views. Two parts overlap if either of these holds:

- Their symbols overlap by more than 2 layout units on both axes.
- Their **physical** bodies collide at the transform the 3D view derives from the layout. This uses the 3D view's own collision volumes and test, so the real dimensions apply.

Exemptions:

- Parts joined terminal-to-terminal, or plugged together, are exempt from the physical test only, as in 3D.
- They are not exempt from the symbol test. A part dropped onto another also has coinciding terminals, and must still count.

Enforcement:

- `AppStore.apply` refuses any edit that **creates** an overlap for a part it adds, moves or rotates. The layout is unchanged, and the reason is named (`edit.overlap.circuit|3d|both`, EN/HE).
- Undo/redo and opening a project are restorations, not placements, and are not refused. Overlaps already present in a project are kept, and the 3D separation remains the safety net for them.
- Palette "add" searches for the nearest free place, ring by ring.

**Acceptance criteria:**

- (a) A part dropped, added or rotated onto another is refused, and the layout is unchanged.
- (b) A placement whose symbols are apart but whose real bodies collide is refused.
- (c) Parts joined at terminals are not overlaps.
- (d) Every layout the gate accepts needs **no** 3D separation (the views agree).
- (e) Existing overlaps don't block unrelated edits, and undo always works.

**Tests:** `app/tests/s13-overlap.test.ts` (9). All 22 curated examples are overlap-free.

**Not done:** there is no live red highlight during a drag. The refusal is shown on drop, as a notice.

### OS-05 — wires obscuring displays (P1) — fixed in S-C

**Root cause:** in the router (domain `route.ts`), crossing a body was a soft cost ranked 4th. Display faces were not obstacles at all. Stored routes were repaired only for criteria 1–2. A wire could therefore run over an LCD's text in 2D, and the 3D view (which follows the 2D route) arched it over the real screen.

**Fix:**

- A display face is a protected region, priced with the header bands (criterion 2, behind only terminal keep-out). A route around it always wins when one exists.
- The face is the union of the drawn face and the **physical** face as the 3D view shows it: the LCD bezel is 70.7 × 23.8 mm. The 8 × 8 matrix face is covered too.
- New wires, wires re-routed on a move, and stored wires repaired on open all obey it.
- Endpoints never change, so connectivity is unaffected.

**Acceptance criteria:**

- (a) A new wire whose shortest shape crosses a display goes around it.
- (b) A stored crossing wire is re-routed on open, clear in 2D **and** in 3D. Plan samples along the 3D wire against the real bezel: before 43, after 0.
- (c) Wires to the display's own pins still route.

**Tests:** `app/tests/s13-display-routing.test.ts` (4).

### OS-01 — engineering value control (P1) — S-B

**Root cause.** Value editing was inline in the inspector's `ParamField`, with no reusable control. Metre values were edited as `500m` beside the unit `m` ("500 m m"), because the metre's symbol is also the milli prefix.

**Fix:**

- **`ValueControl`** (`app/src/ui/ValueControl.tsx`) is the one control for every quantity.
  - It has a numeric field in the quantity's SI unit, parsed by the domain's exact parser (prefixes, `4k7` forms, unit suffixes).
  - It shows the unit symbol, the localized range, the error, and an optional slider.
  - It reports **canonical** values only.
- Metre fields are edited in plain metres (`0.5`). Displays stay `500 mm`.

**Tests:**

- The existing editor e2e (A5: unit-aware input stored as canonical SI).
- `app/tests/i18n.test.ts`: metre input form.
- The OS-06 e2e.

### OS-03 — LDR live updates while dragging (P1) — S-B

**Root cause.** The slider committed only on release (`onChange`), so nothing moved during a drag.

**Fix:**

- The slider follows the pointer. The field shows the value under the thumb. Values go out during the drag at **≤ 10 per second** (`liveThrottle`): the first at once, then at most one per 100 ms. The host allows 50 per second.
- The release cancels any pending value and always commits the final one.
- A drag is one undo step.
- The canvas shows the illuminance (and the HC-SR04 distance and the DHT22 readings) beside the part, live.

**Tests:**

- `app/tests/s13-slider-scale.test.ts`: the throttle bound, and the final value always last and in order.
- `app/e2e/s13-owner-smoke.spec.ts` OS-03: re-solves during the drag, ≤ 1 per 100 ms, final value stored.
- `app/e2e/s13-live-real.spec.ts`: the same under a real ESP32 session (night light).

### OS-06 — HC-SR04 slider (P1) — S-B

**Root cause:**

1. Display units: `500m` beside `m` (see OS-01).
2. Value mapping: three-significant-digit rounding was not round-trip stable. Near 1 m, positions mapped to the same value and the thumb snapped back, so dragging felt non-monotonic.
3. Not live (see OS-03).

**Fix:**

- Linear scales use a "nice" step: exact 5 mm for 0.01–5 m. Every position round-trips exactly, and the mapping is monotonic.
- Plain-metre input, live updates, and the distance shown on the canvas.

**Tests:**

- `s13-slider-scale.test.ts`: every catalog environment parameter is monotonic, reaches both ends, and round-trips.
- e2e OS-06: 5 mm keyboard steps, the label, plain metres.
- Real-QEMU distance-alarm drag in `s13-live-real.spec.ts`.

### OS-07 — sensor inspector horizontal overflow (P1) — S-B

**Reproduced** with a probe (54 combinations: 9 sensors × EN/HE × 1400/1280/1024 px):

- The model `<select>` sized itself to its longest option, 35–107 px past the panel (PIR, LCD, DHT22, at every width).
- A running simulation's "stop to change" note did not wrap in a checkbox row (PIR motion, LED matrix).
- The HC-SR04 and LDR did not overflow.

**Fix (CSS, the causes, not hidden overflow):**

- `.field` is a single `minmax(0, 1fr)` column.
- A field's `select` fills the field.
- A checkbox row wraps, and its note takes its own line.
- The workspace columns are unchanged.

**Tests.** e2e OS-07 checks six sensor cases, EN/HE, at 1400 and 1024 px, stopped and running. It requires no inspector overflow and an unchanged canvas width. It was red on the probe, and is green after the fix.

### OS-02 — 3D render time on a minimal circuit (P1) — S-D, owner retest required

**Profiled.** Evidence: `docs/sprints/s13-evidence/os02/OS02-3D-TIMING.md`. Each phase of the open is now instrumented (`data-open-ms`).

- The chunk, assets, derivation and scene build take under 0.5 s.
- The cost is **shader-program compilation**: 21 programs for a two-part circuit in the GPU tier, 30 with the ESP32. They were compiled synchronously on the main thread, and three.js waited for each program's link status.

**Fix:**

- The first scene compiles its programs in parallel without blocking the page (`compileAsync`, KHR_parallel_shader_compile), and is drawn once instead of twice.
- Production builds skip the synchronous error query.

**Measured on this host** (software WebGL only, so relative, not GPU seconds; cold medians):

| Tier | Circuit | First frame before → after |
|---|---|---|
| Full | ohms-law | 37.9 → 15.8 s |
| Full | esp32-blink | 56.9 → 22.4 s |
| Reduced | ohms-law | 1.33 → 0.57 s |
| Reduced | esp32-blink | 2.35 → 0.78 s |

A variant without parallel compilation measured no better than baseline, so it was rejected.

**Remaining:**

- An owner retest on a GPU is required.
- If the open still takes more than 2 s, the next step is to reduce the full tier's program count. That is a structural change and needs a PM decision.

### OS-10 — palette selection visibility (P1, added 2026-10-12) — S-B

**Root causes:**

1. **Styling.** The armed ("selected for placement") tile used the **same rule as hover**: a pale tint and the accent border. Selected looked like hovered.
2. **Escape after a click.** Escape cancels placement only in the canvas's key handler. After clicking a tile, the focus stays on the tile, so Escape never reached the canvas and the tile stayed armed.
3. **Starting a run.** The palette is disabled while a simulation runs, but starting one did not disarm a tile.

**Fix:**

- **Armed style:**
  - Its own fill token (`--palette-armed`), clearly stronger than hover.
  - A double-weight border and a bold label.
  - A **check mark** at the inline end, as a non-colour cue. It is decorative (`aria-hidden`); the state is already `aria-pressed`.
  - Text and icon colours are unchanged. Contrast on the fill: text about 12.5:1, check mark 5.7:1.
- **Hover** keeps the light tint. Disabled tiles keep their existing look. Selected-on-canvas is the canvas's own highlight.
- **Escape** disarms from anywhere. Starting a run disarms.
- **Placement preview.** The existing ghost now marks an **invalid** position: red, with a not-allowed cursor, wherever the OS-04 overlap rule would refuse the click. No new preview system.

**Acceptance tests:** `app/e2e/s13-owner-smoke.spec.ts` OS-10, 4 tests:

- The armed tile differs from resting and hover. Text colour is unchanged, the label is bold, and the check mark is at the inline end in EN and HE.
- Escape works with the focus on the tile. The probe tool disarms.
- The ghost is invalid over a part and valid on free space. A placement disarms.
- Keyboard: focus is visible, and Enter places at the view centre without arming.

**Screenshots:** `docs/sprints/s13-evidence/os10/` (EN, HE).
