# Sprint 4 — Complete the Non-MCU Laboratory Core

**Status:** TECHNICALLY COMPLETE — pushed to `main`; A17 passed on GitHub Actions (run `35889275941`, §19). Tag `sprint-4-complete` pending PM verification of this closure commit's CI.
**Date:** 2026-09-23 · **Base:** `113b7f7` (Sprint 3 closure, tag `sprint-3-complete`) · **Product baseline:** `5f875a4` · **Final test baseline:** `f359718`
**Authority:** PM Sprint 4 directive (2026-09-23), `docs/product/V1-IMPLEMENTATION-ROADMAP.md`,
`docs/architecture/V1-ARCHITECTURE.md` + ADRs, product scope, PM decisions recorded in
`SPRINT-3.md` §12.4, `CLAUDE.md`.

---

## 0. Phase 0 — Sprint 3 closure

`SPRINT-3.md` still said "Remote CI for Sprint 3 is pending" at the time of the directive, so the
directive's second path applied: the smallest documentation-only closure commit, **`113b7f7`**
(`docs(sprint-3): record A17 PASS on GitHub Actions (run 35838206319) and closure`), was made and
pushed to `main` as a fast-forward from `b95387c`. Only `SPRINT-3.md` changed; earlier evidence
was not rewritten.

**`sprint-3-complete` exists** and points at `113b7f7`. The PM confirmed the closure commit's own
GitHub Actions run, **`35838914523`**, as green (fast job, Chromium acceptance, `test:e2e`,
`test:browser`). The annotated tag was then created and pushed, and its remote target was
verified (`refs/tags/sprint-3-complete^{}` = `113b7f7ab311a006cdd41741989015862dd8b629`). Sprint 4
is built on that commit. *At first report the tag did not exist yet, because this host cannot read
the private repository's CI.*

## 1. Goal and outcome

Complete the approved non-MCU V1 laboratory: every non-MCU catalog item, interaction with
switches while running, observational probes, a real PSU panel, undo/redo, and clearer circuit
validation, on the one production engine. The product stays DC operating-point only,
browser-local, deterministic, local-first and bilingual.

After Sprint 4 the palette holds **PSU, Ground, Resistor, LED, Diode, Push button, Toggle
switch**. The only V1 catalog item still absent is the classic ESP32 DevKit (MCU track).

## 2. What was built

| Area | Where | What |
|---|---|---|
| Diode | `packages/engine/src/models.ts`, `registry.ts`; domain catalog; `app` symbol | `component.diode` with the datasheet-sourced 1N4148 card; same nonlinear device and Newton solver as the LED |
| Push button | engine `session.ts` (`setMomentary`), worker protocol `momentary`, controller, store `press`, canvas | NO momentary SPST. Pressed state lives only in the runtime and the canvas |
| Toggle switch | catalog param `closed` (`live: true`), store live mirroring, engine `applyControl` | SPST, persistent position, live while running |
| Switch model | engine `session.ts` | Open = no element; closed = ideal 0 V branch (spanning forest). No R_on/R_off, no leakage |
| Runtime categories | domain `snapshot.ts` `classifyEdit` → `layout` / `live` / `structural`; protocol `control` vs `momentary` | One classifier drives the running lock, undo while running and the mirroring path |
| Probes | `app/src/ui/probes.ts`, canvas probe tool, inspector "Probes" | Terminal/net voltage to GND and component branch current, read from the solved result |
| PSU panel | `Inspector.tsx` `PsuPanel` | Settings (editable) apart from a measured display (V, I, OFF/CV/CC) |
| Undo/redo | `app/src/state/app.ts`, domain `historyTarget`, top bar, global shortcuts | Session-only history of persistent project edits |
| Circuit checks | `packages/domain/src/checks.ts`, inspector "Circuit checks", canvas markers | Not connected, partially wired, floating island, no GND, supply shorted by a wire, wire over an unconnected terminal |
| Dense results | canvas | Runtime labels only for the PSU, the selected part and probed parts; switch state always visible |
| Localization | glossary + bundles | All new UI in English and Hebrew |

## 3. Diode (A1, A2)

**Device:** Vishay **1N4148** small-signal switching diode, model token
`model.diode.vishay_1n4148`.

**Source:** Vishay Semiconductors, _1N4148 Small Signal Fast Switching Diodes_, Document 81857,
Rev. 1.6, 07-Nov-2024 (https://www.vishay.com/docs/81857/1n4148.pdf, SHA-256
`aefe8540…46a44b7`, not committed). Vishay publishes no SPICE model for this part, so the card
is fitted to the datasheet itself.

**Anchors:** Fig. 1 (_Typical Forward Voltage vs. Junction Temperature_) at T_j = 25 °C, read from
the PDF's **vector path data** and calibrated against the figure's own gridlines, not from
pixels: 0.4990 V @ 0.1 mA, 0.6105 V @ 1 mA, 0.7306 V @ 10 mA, 0.8775 V @ 100 mA.
`packages/engine/tools/extract_1n4148.py` (standard library only) reproduces them from the PDF.

**Model:** Shockley + series resistance, V_F = N·Vt·ln(I/I_S + 1) + I·R_S, least squares over the
four anchors, Vt from CODATA 2019 at 298.15 K:

| N | I_S | R_S |
|---|---|---|
| 1.924182 | 4.210299 nA | 0.379873 Ω |

Anchor residuals: −0.86 / +1.81 / −1.04 / +0.09 mV. Three independent Fig. 2 points (6–22 µA,
not used in the fit) agree within 5.2 mV. The datasheet table limits hold: model V_F(10 mA) =
0.730 V (max 1 V), model |I_R(20 V)| ≈ 4.2 nA (max 25 nA).

**Assumptions and limits:** The datasheet does not uniquely determine I_S, N and R_S; they are
the fit above. 25 °C only. DC only (no capacitance or reverse recovery). Forward validity 0.1–100
mA: outside it, results are flagged `outsideModelRange` and the numbers are left unchanged.
Reverse bias is Shockley saturation current plus the documented gmin (1e-12 S). **Breakdown is
not modelled.** The 1N4148's V_BR ≥ 100 V is far above the 30 V PSU maximum.

**Numerical evidence** (`packages/engine/tests/diode.test.ts`). The reference solves the same
equation by bisection and shares no code with the MNA/Newton solver:

| Circuit | Engine | Reference agreement |
|---|---|---|
| 5 V → 1 kΩ → D (forward) | V_D = 685.84 mV, I = 4.3142 mA, CV | ≤ 1e-9 relative (V and I); KCL residual 2e-16 A |
| 5 V → 1 kΩ → D reversed | V_D = −4.9999958 V, I = −4.2153 nA | ≤ 1e-6 relative (nA-scale current) |
| 5 V / 10 mA limit → 10 Ω → D | CC, I = 10 mA, V_D = 729.56 mV | V_D equals the closed-form V_F(10 mA) within 1e-9 V |
| Series sweep 10 Ω … 1 MΩ | forward | every point ≤ 1e-9 relative |
| Polarity reversal | forward conducts > 4 mA, reverse < 10 nA | electrically distinct |
| 30 V → 10 Ω → D | > 100 mA | flagged `outsideModelRange` |

The fit is refitted independently in the test and must match the card to 1e-9. Rotation moves
the terminals but never swaps anode and cathode identity (domain test). In the browser, a drawn
forward diode shows > 0.6 V and > 4 mA, and the reversed diode shows nA only, both equal to the
engine run on the stored project (`sprint4.spec` A1/A2).

## 4. Switches (A3–A7)

### 4.1 Electrical model

- **Open** (toggle `closed: false`, or a button that is not pressed): the switch contributes **no
  element**. This is the same honest open-circuit treatment as a PSU with its output off.
- **Closed:** an ideal 0 V `VoltageSource` branch between `a` and `b` (the Gate A element, unchanged).
  Its branch current is the switch current, and the contact voltage is exactly 0 V.
- Closed switches that form a loop (switches in parallel): only a spanning forest gets a branch,
  so the matrix stays non-singular. The circuit values stay exact, and the redundant switch
  reports its current as **"not defined"** (`null`), because an ideal loop does not define how
  current divides. Nothing is invented.
- Closed switches directly across an enabled PSU: refused as `psu_shorted`, naming the switches.
- An open switch that cuts part of the circuit off from GND: the normal `floating_circuit`
  diagnostic.
- No R_on/R_off constants, no leakage, no tolerance changes.

### 4.2 Runtime categories (explicit in code)

`classifyEdit(before, after)` in `packages/domain/src/snapshot.ts` is the single classifier:

| Category | Examples | While running |
|---|---|---|
| `layout` | move, rotate, wire routing (geometry only) | allowed; no re-solve |
| `live` (persistent) | PSU setpoint / limit / output enable; toggle `closed` | allowed: **persist first**, then mirror with the new `projectRevision`, then the Worker re-solves |
| `structural` | place, delete, wire, resistor value, diode model | refused ("Stop the simulation…") |
| transient (not an edit) | push-button press/release | never touches the document; worker message `momentary` with no revision |

Which parameters are live comes from catalog metadata (`live: true`), not from per-component
checks in the UI. The worker protocol keeps the two paths apart: `control` (persistent, carries
`projectRevision`) and `momentary` (transient, no revision). The engine refuses a momentary
input on a toggle and a persistent `closed` control on a button (`switch.test.ts`).

### 4.3 Push button (A3, A4)

- Normally-open momentary SPST. **No parameters.** `momentary: true` in the catalog.
- Held = closed, released = open. Each transition sends `momentary` to the Worker, which
  re-solves.
- The press is **never** written to the project. It creates no revision, no autosave and no
  history entry (browser test: bytes and revision identical after 9+ press/release solves; unit
  test: store and history untouched).
- Released on Stop, on Run (fresh start), on a Worker crash, and on reopen or restart (it was
  never stored).
- Input: pointer down presses, and pointer up, `pointercancel`, `lostpointercapture` and focus
  loss (`focusout`) release, so it cannot stick (browser-tested: pointer up, pointer cancel, key-up
  and focus loss). **Keyboard:** Space held on the focused
  button presses and key-up releases (momentary, not a latch). Blur while held also releases.
- Only works while running. Stopped, the button shows a hint that it acts while running.

### 4.4 Toggle switch (A5, A6)

- SPST; persistent boolean parameter `closed` (default open), `live: true`.
- Stopped: click on its lever (or Space when focused, or the inspector checkbox) → project edit
  → new revision → autosave → history entry.
- Running: the same edit is **persisted first**. The runtime is then mirrored with the new
  revision and the Worker re-solves. The Worker never owns the position (browser test: IndexedDB
  holds `closed: true` at revision n+1 before `appliedRevision` n+1 is reported, and
  `data-solves` advances).
- Reopen restores the saved position. Undo/redo treat it as an ordinary edit.

### 4.5 Numerical stability (A7)

`packages/engine/tests/switch.test.ts` (13 tests):

- open: exactly 0 A everywhere in the switched path;
- closed: exact Ohm's-law current and exactly 0 V across the contact;
- every resistor decade **1 mΩ … 1 GΩ**, open and closed, exact to 1e-9 relative (the Gate A
  tolerance, unchanged);
- CC through a closed switch; a switch in series with an LED;
- series switches (conducts only when all closed); parallel closed switches (exact; redundant
  current `null`);
- a closed switch across the supply → `psu_shorted`; an open switch isolating an ungrounded part →
  floating diagnostic;
- **1,000 alternating live toggle transitions** and **1,000 button press/release cycles** with an
  LED. Each result is **bit-identical** to a fresh solve of the same state (no drift, no
  hysteresis).

## 5. PSU panel (A8)

Selecting the PSU shows one panel with two visibly separate parts:

- **Measured output** (a dark instrument display, `psu-display`): output voltage, output current
  and the mode badge **OFF / CV / CC**. Before Run it shows "—" (no value is shown before a
  solve). Mode is text in a bordered badge plus a spelled-out description, not colour alone.
  **CC is labelled as normal operation** ("the supply is limiting current — not a fault"). No
  error is shown.
- **Settings** (ordinary fields): voltage setpoint, current limit, output enabled, with allowed
  ranges. They are live while running (persist first, then re-solve).

OFF is still the Sprint 3 open-circuit model (0 A; no element). Browser test: OFF → 0 A · OFF;
10 Ω at 5 V / 100 mA → 1 V · 100 mA · CC with no error; 10 Ω at 5 V / 1 A → 5 V · 500 mA · CV.
It is a single channel only: no tracking, no sequences, no AC.

## 6. Probes (A9)

- A probe tool on the canvas (toolbar button, `aria-pressed`). In probe mode:
  - click a **terminal** → its potential relative to GND, `V(R2.b)`;
  - click a **wire** → its net's potential relative to GND, `V(N_3)`;
  - click a **part** → that part's defined branch current, `I(R1)`: resistor a→b, LED/diode
    anode→cathode, closed switch a→b, PSU delivered current.
- There is no "current of an arbitrary wire", because the engine defines no such branch. Readings
  are pinned on the canvas and listed in the inspector's **Probes** section, where each can be
  removed.
- **Observational only:** the engine never sees a probe. No element, resistance or load is
  added. Browser test: R1's current is bit-identical with and without probes, and the stored
  project bytes are unchanged.
- **Not persisted** (UI state of the open project for this session), as the directive preferred.
  No schema change. Probes on deleted parts disappear. Not running → "—".
- Not called a multimeter; no resistance measurement; no waveform UI.

## 7. Undo / redo (A10, A11)

- Covers every persistent project edit: place, move, rotate, delete, wire (including the
  junction and net changes an edit causes), resistor and other properties while stopped, PSU
  settings, toggle position. History is capped at 100 steps.
- **Mechanism:** an undo or redo does not restore an old document. It commits a **new** document
  through the normal path (validate → persist → autosave). `historyTarget(current, target)` takes
  the target's content, keeps the current revision metadata, and takes the **maximum** of every
  `idCounters` entry.
  - `localRevision` only increases. Undo commits revision n+1; it never decrements or reuses an
    old number (browser test: redo lands at r+3 after r → undo → redo).
  - IDs are never reissued. After placing R2, undoing it and placing again, the new part is R3.
    Redo brings back the same R2 id.
- **Session-only:** reopening a project, New, Open and Home start with empty history.
- **Excluded:** language, Run/Stop, simulation results, push-button presses, selection, zoom and
  pan, probes.
- **While running:** undo/redo is allowed only when the step classifies as `live` (PSU setting,
  toggle), and it follows the same persist-first → mirror → re-solve path. A structural step is
  refused with the "Stop the simulation" notice and changes nothing (unit test).
- **Keyboard:** Ctrl/Cmd+Z undo; Ctrl/Cmd+Shift+Z and Ctrl+Y redo. Shortcuts are ignored inside
  text fields, so native input undo stays local to the field. Top bar Undo/Redo buttons.

## 8. Validation layer (A12, A13)

`checkCircuit(doc)` (`packages/domain/src/checks.ts`) is pure: it never changes the circuit. It
shows results in an inspector **Circuit checks** list and as canvas markers when stopped:

| Check | Severity | Meaning |
|---|---|---|
| `not_connected` | info | Nothing wired: omitted from the solve with the Sprint 3 "not connected / not simulated" notice. Does not block Run |
| `partially_wired` | warning | Names the open terminals. The part is **not** skipped: it enters the normal solve and diagnostics |
| `floating_island` | warning | A wired group that cannot reach GND even with every switch closed. At Run the engine refuses it (`floating_circuit`) and names it |
| `no_ground` | warning | Wired parts but no wired GND |
| `psu_shorted_by_wire` | warning | A supply's own terminals on one net |
| `wire_over_terminal` | warning | A wire drawn across a terminal it is **not** connected to. The marker shows it, and the connection is **not** made |

- Connections still come only from explicit wire endpoints. Crossings without a junction dot and
  wires over terminals are never connected (browser test: after drawing across R1.a, the stored
  `connections` have no R1.a).
- Invalid terminal and connection operations (a wire from an endpoint to itself, unknown
  components, terminals, wires or junctions) are refused by the Sprint 2 editing operations
  (`same_endpoint`, `unknown_*`), and the document is left unchanged. Out-of-policy parameters
  are refused (`param_type`, `out_of_range`), and the fields show the allowed range. Combinations the engine cannot solve come back as
  localized diagnostics (`psu_shorted`, `singular_circuit`, `no_convergence`,
  `floating_circuit`).
- The checks are conservative helpers; the engine at Run has the final word (it knows supply
  outputs and switch states).

## 9. Ground semantics (A14)

**Rule: every GND symbol is the same single reference node (0 V).** Two GND symbols that are not
wired to each other are still one node. The document keeps them as separate ground-role nets
(the drawing is not altered), and the snapshot and engine map every ground-role net to the one
reference. This is conventional schematic practice. It is signal/reference ground, not protective
earth: the Hebrew label stays **אדמה (GND)**, and "הארקה" is forbidden by test.

Evidence: engine test (two separate ground-role nets in the snapshot; the loop PSU1+ → R → GND2
… GND1 → PSU1− gives 5 mA) and browser test A14 (R1 shows 5 mA with the loop closed only through
two GND symbols).

## 10. Dense-result UX

- Always visible: component state that matters, i.e. switch open/closed text, the LED brightness
  cue, PSU `V · I · mode`, and running outline.
- On demand: numeric values for other parts appear on **selection**, on a **probe**, and in the
  inspector. A 30-part circuit no longer shows 30 value labels.
- Probe labels sit clear of the part's reference and value labels. There is no automatic label
  placement engine.

## 11. Accessibility

- Buttons and toggles are focusable canvas parts. **Space** acts on them (toggle flips; button is
  momentary: press on key-down, release on key-up or focus loss). Their accessible names include
  state ("closed" / "open" / "pressed").
- Probe tool is `aria-pressed`. Undo and Redo are real buttons with disabled state. All have
  visible focus.
- State is never colour-only: switch state and PSU mode are text; check markers are rings at
  the exact terminal, paired with the worded list in the inspector; mode badges have borders and
  words.
- Hebrew RTL chrome; the canvas, values, units and identifiers stay LTR.

## 12. Localization (A15)

All new strings are in `messages.en.ts` and `messages.he.ts`. New glossary terms: diode = דיודה,
push button = לחצן, toggle switch = מתג, probe = נקודת מדידה. CV/CC/OFF, SI units and
identifiers stay as technical tokens.

Browser tests:

- **Parity.** The same circuit (diode, button, toggle, PSU panel, probes, checks) read in English
  and Hebrew gives identical values, modes and states after stripping bidi marks. Switching
  language writes nothing (bytes identical), and canvas direction stays `ltr`.
- **Completeness.** Every visible word in the new Sprint 4 surfaces in Hebrew is Hebrew or an
  allowed technical token (`V`, `I`, `CV`, `CC`, `OFF`, `GND`, `SW1`, `1N4148`, units…).

Changing language changes no diode orientation or model, no toggle state, no project byte and no
result.

## 13. Acceptance criteria — results

| # | Result | Evidence |
|---|---|---|
| A1 | **Pass** | §3: real Shockley + R_S device in the one engine, sourced from a Vishay datasheet with reproducible extraction; provenance in `packages/engine/PROVENANCE.md` |
| A2 | **Pass** | §3 table: forward, reverse, polarity, sweep and CC agree with an independent bisection to 1e-9 relative (1e-6 for nA reverse current). Browser values equal the engine run on the stored project |
| A3 | **Pass** | `sprint4.spec` A3/A4: `I(R1) = 0 A` → held (pointer) `5 mA` → released `0 A`. The same with Space held, and pointer cancel and focus loss release it. Each transition re-solves in the Worker (`data-solves` ≥ 9) |
| A4 | **Pass** | Same test: stored bytes (and so revision) identical after all presses, checked after waiting past the autosave debounce (a fixed wait that proves an absence of writes, not a race fix; A15 uses the same kind); undo history holds only real edits; a new Run starts released. Unit tests: store refuses to press non-momentary parts, and history is untouched |
| A5 | **Pass** | `sprint4.spec` A5/A6: toggle → `closed: true` at revision r0+1 in IndexedDB; reopen shows it closed |
| A6 | **Pass** | Same test + `history.test`: while running, IndexedDB updates first, then `appliedRevision` = new revision, then re-solve (`5 mA` ↔ `0 A`, `data-solves` 2) |
| A7 | **Pass** | §4.5: all decades 1 mΩ–1 GΩ exact; 1,000 toggle transitions and 1,000 button cycles bit-identical to fresh solves; tolerances unchanged |
| A8 | **Pass** | §5: `sprint4.spec` A8 (none / OFF / CC / CV with measured V and I; CC not an error) |
| A9 | **Pass** | §6: `V(R2.b) = 2.5 V`, `I(R1) = 2.5 mA` on a divider; R1's current bit-identical with probes; bytes unchanged; "—" when stopped |
| A10 | **Pass** | §7: `history.test` (all edit kinds, id non-reuse, autosave), domain `historyTarget` tests, `sprint4.spec` A10/A11 (buttons + keyboard, monotonic revisions) |
| A11 | **Pass** | §7: presses, language, Run/Stop, results, selection and probes never enter history or the document (unit + browser) |
| A12 | **Pass** | §8: `sprint4.spec` A12/A13 (unwired D1 noted and omitted while Run proceeds in CV; partially wired R1 flagged) and "A12 floating" (connected island → `floating_circuit`, never skipped) |
| A13 | **Pass** | §8: wire drawn across R1.a is flagged on canvas and in the list, and the stored connections still lack R1.a; domain tests |
| A14 | **Pass** | §9 |
| A15 | **Pass** | §12: parity and completeness browser tests. The parity test's baseline was corrected in `f359718` (§19); no product change |
| A16 | **Pass** | Domain test: the catalog is exactly PSU, Ground, Resistor, LED, Diode, Push button, Toggle switch. No other types added |
| A17 | **Pass on GitHub Actions** (run `35889275941` on `f359718`, §19). *At first report: local only* | All Sprint 2 race tests and Sprint 3 electrical acceptance tests pass (§14), locally and in CI. The earlier run `35884629891` failed only on an A15 test-ordering defect (§19) |
| A18 | **Pass** | No change to `.github/workflows/ci.yml`. Nothing in `npm test`, `test:e2e` or `test:browser` touches the ESP32 toolchain. `tools/extract_1n4148.py` is not run in CI |

## 14. Tests and CI-equivalent run

| Suite | Count | Sprint 3 | Result |
|---|---:|---:|---|
| `packages/engine` (reference + bit-identity, product path, OFF model, diagnostics, live controls, range; **new:** diode 9, switch 13, multiple GND 1) | 57 | 34 | pass |
| `packages/domain` (**new:** `sprint4.test.ts` 13: catalog, polarity under rotation, button has no persisted state, toggle persistence, `historyTarget`, checks) | 121 | 108 | pass |
| `app` unit (**new:** `history.test.ts` 8, `ids.test.ts` 2) | 62 | 52 | pass |
| Sprint 0/1 unit (`experiments/`), unchanged | 55 | 55 | pass |
| **Unit total** (`npm test`, 25 files) | **295** | 249 | pass |
| `app` Chromium acceptance (`npm run test:e2e`): all Sprint 2 race tests and Sprint 3 electrical acceptance tests, plus **new** `sprint4.spec` (11), `sprint4-performance.spec` (1) and `insecure-context.spec` (1) | **49** | 36 | pass |
| Sprint 0 browser (`npm run test:browser`), unchanged | 4 | 4 | pass |

Every CI-equivalent step passes locally on the final tree, as in `.github/workflows/ci.yml`:
`typecheck`, `lint` (ESLint, Prettier, experiments/ boundary), `npm test`, `test:e2e`,
`test:browser`. The workflow file is unchanged. The real-ESP32 suite was not re-run; nothing it
depends on changed.

**Existing tests changed, never weakened:**

- Sprint 3 specs now select a part before reading its canvas values, because values for
  unselected parts moved to selection/probe/inspector (§10).
- The PSU mode is read from the panel's `data-mode`.
- Result helpers accept `null` currents.
- The Sprint 3 LED browser tests select D1.

No assertion was relaxed, and no sleeps were added to fix races. The only fixed waits in the new
specs (A4, A15) prove that nothing is written.

## 15. Performance (measured, not promised)

1-core ARM64 dev host (4 GB), headless Chromium. Measured on the final tree
(`test-results/sprint4-performance.json`, `sprint3-worker-performance.json`,
`sprint2-interaction-baseline.json`). No SLAs are asserted.

**Sprint 3 measurements re-run on Sprint 4** (same spec, same circuits):

| Measurement | Sprint 3 (report) | Sprint 4 |
|---|---:|---:|
| 5 V / 1 kΩ, Run → result, warm median | 13.5 ms | 14.6 ms |
| 5 V / 220 Ω / LED, Run → result, warm median | 13.7 ms | 13.6 ms |
| 30 parts (28 R + 2 LED), Run → result, warm median | 14 ms | 14.9 ms |
| 30 parts, solve in worker | 1.5 ms | 0.9 ms |
| Live PSU change → re-solved result, median | 9.7 ms | 10.7 ms |
| First Run incl. worker start (1 kΩ) | 64 ms | 61 ms |
| Raw worker → page transfer, median | 0.3 ms | 0.1 ms |
| Long tasks (> 50 ms) during 11 Stop/Run cycles of 30 parts | 0 | 0–1 (max 52–98 ms; see below) |
| Drag, 30 parts + 29 wires, per move incl. frame (Sprint 2 baseline) | median 33–34, p95 50–69 ms | median 33, p95 49–51 ms |

**New Sprint 4 measurements**. A 30-part circuit: 6 toggle legs and 5 push-button legs with
LEDs, diodes and resistors, 40 wires.

| Measurement | Result |
|---|---:|
| Run → result: first (worker start) / warm median / warm solve | 80–102 ms / 14–17.5 ms / 1.8–3.2 ms |
| Push-button transition (press or release → re-solved result on screen), 40 transitions | median 118–119 ms, p95 134–140 ms |
| Toggle while running (persist → mirror → re-solve → on screen), 20 transitions | median 76–88 ms, p95 95–168 ms |
| Undo of a property edit (→ persisted → on screen), 10 operations | median 51–57 ms, p95 70–77 ms |

The interaction timings are measured from the Playwright side and include its polling round trips
(each `expect.poll` step is tens of milliseconds on this host). They are upper bounds on
user-visible latency, not solver cost; the solve itself is 2–3 ms.

**Regression investigated, not masked.** The first Sprint 4 run of the Sprint 3 spec showed
**10 long tasks (up to 107 ms)** during Stop/Run cycling, where Sprint 3 had 0. A trace found
three causes, all fixed:

1. The top bar re-wrapped when the status text changed width. That resized the canvas and forced
   a 33 ms layout. The top bar is now no-wrap with a stable status width.
2. `Intl.NumberFormat` was constructed on every value render. It is now cached per locale and
   options.
3. Circuit checks were recomputed on every Stop and twice per render. They are now cached per
   document, and the section stays mounted.

After the fixes, the spec's run shows 0–1 long task per 11 cycles (52–98 ms when present), and
an independent 3 × 11-cycle run showed 0. The cause of the remaining occasional long task was
not isolated further. It is recorded here, not hidden.

## 16. Schema changes

**Additive only; `schemaVersion` stays 2; no migration** (logged in `packages/domain/SCHEMA.md`).

- `component.diode` (typeVersion 1): terminals `anode`/`cathode`, enum `model` =
  `model.diode.vishay_1n4148`. References `D<n>` share the LED counter.
- `component.push_button` (typeVersion 1): terminals `a`/`b`, **no parameters**; catalog metadata
  `momentary: true`. The pressed state is not in the schema.
- `component.toggle_switch` (typeVersion 1): terminals `a`/`b`, boolean `closed` (default
  `false`, `live: true`). References `SW<n>` share one counter with the button.
- Nothing else persisted: no history, probes, checks or runtime state. There is no change to
  identity, net, layout or revision semantics. Every Sprint 2/3 document validates unchanged.

## 17. Dependencies

**None added.** The extraction tool uses the Python standard library only and is a dev-time
reproduction script, not a dependency. ngspice is not used.

## 18. Report

### 18.1 Deviations from the directive

1. **`sprint-3-complete` was created after Sprint 4 was built** (§0). Sprint 4 was built on the
   closure commit `113b7f7` before its CI was confirmed; the tag now points at that same commit.
2. **Redundant parallel closed switches report "not defined" current.** This is the honest result
   for ideal contacts in a loop. The circuit values are exact.
3. **Pre-Run circuit checks are advisory.** The engine at Run remains authoritative. `floating_island`
   treats every switch as possibly closed, so it only flags islands that float in every switch
   state; a switch-dependent float is reported by the engine at Run.
4. **Button keyboard key is Space** (held). Enter does not press it, to keep momentary semantics
   unambiguous.

### 18.2 Product defects found and fixed during the sprint

- Redo restored the wrong document (undo pushed the undone document instead of the entry).
  Fixed, and the test was strengthened.
- A held button could stay pressed after focus moved away (the release listened to non-bubbling
  `blur`). Fixed with `focusout`, and tested.
- **Startup failure on non-secure origins** (found while setting up the dev preview). The app
  generated ids with `crypto.randomUUID`, which browsers expose only on HTTPS or localhost. Over
  plain HTTP on a hostname or LAN address, startup threw and the page stayed on "Loading…". Ids
  now come from `crypto.getRandomValues` (`app/src/ids.ts`; same 32-hex format, 128 random bits).
  A browser regression removes `randomUUID` before load; it fails without the fix.
- Performance regression on Stop/Run cycling (§15): top-bar re-wrap, a `NumberFormat` built per
  render, and checks recomputed per render. All three fixed.

### 18.3 Risks for Sprint 5

| Risk | Note |
|---|---|
| CI timing | CI found one timing-dependent test in Sprint 4 (A15, §19), as in earlier sprints. New tests must wait for the exact durable state they compare against, never for the save indicator or a delay |
| Single-core timing | The button/toggle browser timings include Playwright polling. On CI hardware they may differ; no SLA is asserted |
| Diode temperature | 25 °C only. A future thermal feature would need Fig. 1's temperature slope (the extraction already reads those lines) |
| Keyboard wiring (Sprint 5) | Switch actuators take Space on focused parts. Keyboard wiring must not conflict with that key |
| Export/import (Sprint 5) | Must carry the three new types. The pressed state and history must stay out of the export |
| Probes are not persisted | If users expect probes to survive reopen, that is an additive schema decision for later |
| Parallel ideal switches | "Not defined" current may surprise learners. Needs good copy, not a fake split |

### 18.4 Decisions for the PM

**No PM decision blocks Sprint 5.**

The one open action is procedural: the PM verifies this closure commit's CI, and then
`sprint-4-complete` is created on it.

## 19. Closure (added 2026-09-23)

| Step | Result |
|---|---|
| Sprint 4 pushed to `main` | `113b7f7..5f875a4`, fast-forward: the six Sprint 4 commits, unchanged. **Product implementation is complete at `5f875a4`** |
| GitHub Actions run `35884629891` on `5f875a4` | **Red**: fast job passed; Chromium acceptance 48/49; `test:browser` skipped. Only failure: A15 parity |
| A15 test correction | `f359718` (test only, fast-forward to `main`) |
| GitHub Actions run **`35889275941`** on `f359718` | **Green**: fast job, Chromium acceptance (`npm run test:e2e`, `npm run test:browser`). **A17 = PASS**, verified by the PM |

**Why `35884629891` failed.** A15 flipped SW1, a legitimate persistent edit that is saved
through the 300 ms autosave debounce. The test then captured the stored project bytes without
waiting for that save. On the CI runner the capture ran before the toggle's write landed
(stored revision 8, SW1 open). The write then landed as revision 9, SW1 closed, and the
"switching language writes nothing" check compared the two different engineering states.

An instrumented local reproduction showed that the toggle's write was the only write in the
sequence, and that three locale switches after the toggle was durable wrote nothing. Delaying the
toggle's save reproduced the CI failure exactly.

**The fix changed the test only.** A15 now waits until `SW1.closed = true` is durable, captures
the bytes and English results after all intended edits, and then switches locale only. No
assertion was removed. Two were added: the captured bytes equal the durable edited state, and
the English baseline is 5 mA, CV, closed.

**No product behaviour was changed.** Toggle position remains persistent project state, and a
locale switch still writes nothing. Local evidence for `f359718`: 295 unit, 49 app browser, 4
Sprint 0 browser tests pass; both A15 tests pass 10/10 each; the corrected A15 passes with the
autosave delay stretched to 1.5 s.

**All Sprint 4 acceptance criteria A1–A18 are PASS.**

**No Sprint 5 work exists in this baseline.** Every commit from `113b7f7` to this closure is
Sprint 4 implementation (`79657a6`…`5f875a4`), the A15 test correction (`f359718`) or Sprint 4
documentation. No Sprint 5 branch existed when the implementation baseline `5f875a4` was made.

### 19.1 Product Alpha handoff (to Sprint 5)

Sprint 4 hands Sprint 5 a complete non-MCU laboratory core: the closed seven-part catalog, the
one production engine with the 1N4148 and switch models, live and transient runtime interaction,
probes, the PSU panel, undo/redo, circuit checks, and English/Hebrew parity. These electrical and
runtime semantics are settled; Sprint 5 builds on them and does not reopen them without evidence
of a defect.

Carried into Sprint 5 as Product Alpha work (PM visual review, accepted as polish backlog, no
redesign):

- top-bar hierarchy (navigation, simulation controls, save state, language);
- sidebar hierarchy, so that empty sections (probes, checks) do not dominate;
- small catalog spacing and icon consistency;
- result density in larger circuits;
- the §18.3 risks: export/import must carry the three new types and exclude the pressed state and
  history; Space stays reserved for switch actuators.

`sprint-4-complete` goes on this closure commit once the PM confirms its GitHub Actions run.
