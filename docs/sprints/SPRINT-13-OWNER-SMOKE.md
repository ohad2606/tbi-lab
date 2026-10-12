# Sprint 13 — Owner Smoke findings register (OS-01 … OS-09)

Registered 2026-10-12 from the PM decision "Owner Smoke Findings + Sprint 13 Physics Decision".
This is the Sprint 13 acceptance tracking record (the project tracks acceptance in these sprint
documents; no external issue tracker is used).

**Owner observations and reproduction steps.** The PM decision summarises each finding in one
line. The owner's own words and reproduction steps were **not included** in what engineering
received. Each row records the PM summary verbatim. The "Owner observation / repro" column stays
**requested** until the owner's notes arrive. Engineering's reproduction is recorded separately
and is not a substitute for the owner's.

**Owner Smoke acceptance (Sprints 11/12): OPEN.** It is not claimed until the owner finishes the
remaining tests.

| ID | Pri | PM summary (verbatim) | Owner observation / repro | Slice | Status |
|---|---|---|---|---|---|
| OS-01 | P1 | Reusable engineering value control with numeric input and appropriate SI units. Preserve canonical physical values and support EN/HE. | requested | S-B controls | open |
| OS-02 | P1 | Profile the reported 5–7 second 3D render on a minimal circuit; optimize the measured bottleneck. | requested ("5–7 s, minimal circuit") | S-D 3D | open |
| OS-03 | P1 | LDR live visual and simulation updates during dragging, with bounded command frequency and guaranteed final value. | requested | S-B controls | open |
| OS-04 | P0 | Prevent invalid component-body overlaps, consistently across Circuit and derived 3D views. | requested | S-C geometry | open |
| OS-05 | P1 | Prevent wires from obscuring critical component displays where valid alternative routing exists. | requested | S-C geometry | open |
| OS-06 | P1 | HC-SR04 slider units, range, monotonic interaction and live updates. | requested | S-B controls | open |
| OS-07 | P1 | Remove horizontal overflow in the sensor property inspector without reducing the main workspace. | requested | S-B controls | open |
| OS-08 | P0 | Correct Build/Run state management. Run must not be available while a build is in progress or when firmware is stale. | requested | S-A build/run | open |
| OS-09 | P0 | Investigate reversed LCD VCC/SDA wiring, verify electrical diagnostics and provide an accurate actionable refusal or warning where supported. | requested | S-E diagnostics | open |

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
