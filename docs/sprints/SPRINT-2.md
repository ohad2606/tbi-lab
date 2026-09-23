# Sprint 2 — First Product Surface

**Status:** CLOSED — A11 passed on GitHub Actions (§13). Authorized with roadmap corrections
RC-1..RC-7 (`docs/product/V1-IMPLEMENTATION-ROADMAP.md`, "Roadmap closure").
**Date:** 2026-09-22 · **Milestone:** A · **Baseline:** `v1-product-scope-complete` (`09d5089`)

**Authority:** `docs/product/V1-PRODUCT-SCOPE.md` (approved), `docs/architecture/V1-ARCHITECTURE.md`
+ ADR-001..008, `docs/product/V1-IMPLEMENTATION-ROADMAP.md`, `CLAUDE.md`.

---

## 1. Goal

**Turn TBI Lab from documents into a product.**

A real browser application in which a person creates a local project, draws a small circuit on a
professional schematic canvas, and finds it exactly as they left it after closing the browser
completely — working equally in Hebrew and English.

This sprint deliberately puts the **highest-risk product work first** (schematic interaction and net
semantics) and refuses to spend itself on invisible infrastructure.

## 2. User-visible outcome

At the sprint review, a person can be handed the application and do this without help:

1. Open TBI Lab and create a project named in Hebrew or English.
2. Place a lab PSU, a ground and two resistors on the canvas.
3. Move, rotate and delete components; select several at once.
4. Wire terminal to terminal; see junction dots where wires genuinely join, and see that a crossing
   is **not** a connection.
5. Set resistance values with unit-aware input (`220`, `1k`, `4k7`).
6. Watch "All changes saved" appear without pressing anything.
7. Switch the interface to Hebrew: the chrome mirrors, the circuit does not move, identifiers and
   numbers stay LTR.
8. Close the browser entirely, reopen it, and find the project intact.

**There is no simulation in this sprint, and the product must not pretend otherwise.** No Run
control is shown.

## 3. Included scope

### 3.1 Repository and production boundary

| Item | Detail |
|---|---|
| `app/` | The browser application (Vite + TypeScript). The first production code in the repository |
| `packages/domain/` | Project schema v2 core, types, validation, migration registry, catalog metadata. Pure data: no UI, no I/O, no locale |
| Workspaces | npm workspaces + TypeScript project references. **No monorepo tool** |
| Lint / format | ESLint + Prettier with a minimal shared config, applied to production code (experiments stay as they are) |
| CI | Pipeline on every change: install, typecheck, lint, unit tests, schema/domain tests, he/en locale key checks, and the browser editor/persistence suite where practical. **Must not depend on the ESP32 toolchain** (`/home/ubuntu/tbi-tools/`, ~9.8 GB, unversioned): the real-ESP32 suite is a separate provisioned job introduced after R1 (RC-4) |
| Boundary guard | A check that fails if production code imports from `experiments/` |

`experiments/` is **not touched**. Nothing is moved out of it; promoted logic is copied deliberately,
with the promotion recorded in the sprint report.

### 3.2 Schema slice (`packages/domain`) — schema v2 core (**frozen at Sprint 2 DoD**)

Per roadmap §6.1. Sprint 2 is the first sprint that persists real product data, so this model is
**not disposable** (RC-1). At Sprint 2 DoD the core is stable: project identity/schema version,
component instance identity, stable language-neutral type ids, terminals, nets, engineering
values/units, position/rotation and revision metadata. From Sprint 3 on, changes are additive or
backward-compatible where possible, with an explicit migration whenever persistence semantics change.
Implemented in full for the types this sprint ships:

| Element | Sprint 2 content |
|---|---|
| `schemaVersion` | `2`, with a version check on open and a migration registry (no migrations exist yet) |
| Components | `id`, `type`, `typeVersion`, `params` — for `instrument.lab_psu`, `component.ground`, `component.resistor` |
| Nets | Stable ids, optional user name (verbatim, never translated), `role: "ground"` support |
| Connections | `{component, terminal, net}` with terminal ids from the type definition |
| Values | `{value, unit}` with canonical unit ids (`ohm`, `volt`, `ampere`) |
| Layout | Separate map: `{x, y, rotation}` per component, excluded from any future snapshot |
| Revision metadata | `localRevision`, `cloudRevision: null`, `baseRevision: null`, `updatedAt`, `deviceId` — carried from the proven Gate D shape |
| Catalog metadata | Type definitions: terminals, parameter schemas with units and ranges, translation **keys** (not strings), symbol reference |
| Validation | Structural validation with structured errors (unknown type, unknown terminal, duplicate id, dangling connection) |

**Not in this sprint:** MCU/firmware fields, `runConfig`, export package format, annotations beyond a
plain note field if it is free.

### 3.3 Application shell slice (`app/`)

| Item | Detail |
|---|---|
| Layout | Workspace canvas, a component palette for the three types, an inspector panel, a top bar with project name, language switch and save state |
| Project lifecycle | New project, open from the local list, rename; recent projects list |
| Direction handling | RTL chrome for Hebrew, LTR chrome for English, with the canvas always LTR |
| Framework | React + Vite recommended (engineering decision at sprint start; Preact or vanilla TS acceptable if justified against roadmap §7.1 criteria) |
| No dead controls | Nothing that does not work in this sprint is shown — no greyed-out Run button |

### 3.4 Canvas slice — editor increments E1-E11 (roadmap §7.2)

Coordinate system and grid; camera (zoom, pan, zoom-to-fit); placement with automatic references
(`R1`, `R2`…); selection incl. shift-click and rubber band; movement by drag and arrow keys with
attached wires following; 90° rotation; terminal hit targets; wire creation with orthogonal routing;
**junction and net semantics**; deletion with net settling; and a basic property inspector (E12
basic).

**Net semantics are the correctness core of this sprint:**

- wires meeting at a shared point form **one** net;
- a junction dot is drawn wherever three or more segments meet;
- a crossing without a shared point is **not** a connection;
- deleting a component or segment re-settles the affected nets with no dangling references;
- every edit leaves the document structurally valid (validated in tests after every operation).

### 3.5 Localization slice

| Item | Detail |
|---|---|
| Infrastructure | Key catalogue, bundle loading, `Intl`-based number formatting, direction handling |
| Coverage | **Complete** English and Hebrew for everything this sprint ships: menus, dialogs, project actions, the three component names, property labels, units, save-state and validation messages |
| Rules | No hard-coded user-facing string; technical identifiers, pin labels, units and numbers stay LTR; user-authored text is never translated |
| Switch behaviour | Immediate, remembered per device, **never** written into the project |

### 3.6 Persistence slice

| Item | Detail |
|---|---|
| Promoted | Gate D `store.ts` (IndexedDB wrapper) and `autosave.ts` (debounced autosave), copied into `app/` and cleaned up |
| Added | Project index for the recent list, schema-version check on open, migration hook, save-state reporting ("All changes saved" / "Saving…" / "Could not save"), and quota/failure handling that never loses the in-memory document silently |
| Acceptance | Exact restore after a real full-browser restart, as Gate D proved for the feasibility shape |

## 4. Excluded scope

**Explicitly not in Sprint 2:** any simulation or solver integration; Run/Stop controls; LED, diode,
push button, toggle switch; the ESP32 in any form; undo/redo; probes; PSU instrument panel;
export/import; example projects; connection **validation rules** beyond structural validity (Sprint
4); wire editing/rerouting; copy-paste; any server component, protocol, authentication or build
service; accessibility work beyond keyboard basics and visible focus; visual design polish beyond
the legibility principles.

## 5. Engineering tasks

| # | Task | Notes |
|---|---|---|
| T1 | Workspace layout, `app/` and `packages/domain/`, TS project references, lint/format | Keep `experiments/` scripts working unchanged |
| T2 | CI pipeline: install, typecheck, lint, unit/domain, locale keys, browser; boundary guard | Single worker for browser tests (1-core host). No ESP32 toolchain dependency (RC-4) |
| T3 | `packages/domain`: schema v2 core types, validation, migration registry | Pure functions, fully unit-tested |
| T4 | `packages/domain`: catalog definitions for PSU, ground, resistor (terminals, params, units, translation keys, symbol ids) | Data, not code paths |
| T5 | App shell: layout, palette, inspector, top bar, project lifecycle, recent list | |
| T6 | Locale infrastructure and complete he/en bundles for shipped strings | Acceptance criterion, not polish |
| T7 | Canvas: coordinates, grid, camera, rendering of symbols (SVG) | E1-E3 |
| T8 | Canvas: placement, selection, movement, rotation, deletion | E4-E7, E11 |
| T9 | Canvas: terminals, wire creation, junctions and net settling | E8-E10 — the highest-risk task; start it early |
| T10 | Property inspector with unit-aware parsing and formatting | E12 basic |
| T11 | Persistence: promote store + autosave, add index, versioning, save-state | |
| T12 | Tests per §6 | Written with the features, not after |
| T13 | Sprint report: what was promoted, decisions taken, measurements, what changed against this plan | Follows the Sprint 0/1 convention |

**Suggested order:** T1-T4 (foundation, ~1 day) -> T7-T9 (canvas, the risk) -> T5-T6 (shell +
locale) -> T10-T11 -> T12 throughout -> T13.

## 6. Test requirements

| Level | Tests |
|---|---|
| **Unit** (`packages/domain`) | Schema validation accepts valid documents and rejects each malformed case with a structured error; reference assignment is unique and never reuses a deleted id; unit parsing (`220`, `1k`, `4k7`, `1.5k`, invalid input) is exact and locale-independent; net merge/settle operations preserve structural validity; migration registry runs and refuses a newer `schemaVersion` |
| **Unit** (`app` logic) | Autosave debounce coalesces a burst into fewer writes; save-state transitions; locale catalogue has **no missing key in either language** (a test that fails on any untranslated key) |
| **Browser** (Playwright, Chromium) | Place three components and wire them; junction is created where wires meet; a crossing does **not** connect; delete settles nets; move and rotate keep wires attached; rubber-band selection; unit-aware property edit persists; **language switch does not change the document bytes**; RTL chrome with LTR canvas verified by layout assertions; **full browser restart restores the project exactly** (persistent context, as Gate D did); keyboard-only path for place/select/move/delete |
| **Performance** | Interaction timing budget recorded for a 30-component circuit (baseline established this sprint, asserted from Sprint 3 on) |

**Evidence rule:** every existing test keeps passing. The Sprint 0/1 suites (55 unit, 20 ESP32, 4
browser) must remain green and untouched.

## 7. Repository changes expected

```
app/                      new — browser application
packages/domain/          new — schema, catalog metadata, validation, migrations
.github/workflows/        new — CI (or the chosen CI location)
eslint/prettier config    new — production code only
package.json              modified — workspaces, scripts (dev, build, test:app, lint)
experiments/**            UNCHANGED
docs/sprints/SPRINT-2.md  this plan, plus a sprint report at the end
```

## 8. Acceptance criteria

The sprint is complete when **all** of the following are demonstrated:

| # | Criterion |
|---|---|
| A1 | A new project can be created, named (including in Hebrew), and appears in the recent list |
| A2 | PSU, ground and resistors can be placed, moved, rotated, selected (singly and by rubber band) and deleted |
| A3 | Wires connect terminal to terminal; junctions form where wires meet; crossings do not connect; deletion leaves no dangling reference |
| A4 | After every editing operation, the project document validates structurally (asserted in tests) |
| A5 | Resistance is edited with unit-aware input and stored as `{value, unit}` in canonical SI |
| A6 | Autosave writes without user action and the save-state indicator reflects reality |
| A7 | **Closing the browser completely and reopening restores the project exactly** |
| A8 | The UI is complete in English **and** Hebrew, with no missing key and no hard-coded string |
| A9 | Hebrew mirrors the chrome while the canvas, identifiers, numbers and units stay LTR, and **no project byte changes** on switch |
| A10 | Core actions are reachable by keyboard with visible focus |
| A11 | CI runs install, typecheck, lint, unit/domain, locale-key and browser tests on every change, is green, and does not depend on the ESP32 toolchain |
| A12 | Production code contains **no import from `experiments/`**, enforced by the boundary check |
| A13 | The app shows nothing that does not work: no Run control, no simulation affordance |
| A14 | The sprint report records what was promoted from feasibility code and every decision taken |

## 9. Definition of Done

1. All acceptance criteria A1-A14 demonstrated on Chromium.
2. All pre-existing tests still pass (55 unit, 4 browser, 20 ESP32 untouched).
3. New tests per §6 exist and pass in CI.
4. Schema v2 core is documented in `packages/domain` with the roadmap §6.1 table as its reference,
   and is **frozen** at the end of this sprint (RC-1). Sprint 3 may extend it additively for engine
   needs; it may not casually replace it.
5. No product capability outside the approved V1 scope was introduced.
6. The sprint report is committed, including: promoted code, decisions (framework choice and why),
   the interaction performance baseline, anything deferred, and any PM decision surfaced.
7. Work is committed locally and **not pushed** until PM review, per the standing convention.

## 10. Dependencies and risks

| Item | Note |
|---|---|
| **Dependency: none blocking** | Sprint 2 needs no server, no QEMU, no firmware, no network. It can start immediately after approval |
| Risk: wiring and net semantics harder than estimated | The mitigation is ordering: T9 starts early, and its acceptance tests are written first |
| Risk: framework choice debated mid-sprint | Decide in the first hours against roadmap §7.1 criteria; record it in the sprint report |
| Risk: Hebrew treated as a later pass | A8/A9 are acceptance criteria; a screen without Hebrew is not done |
| Risk: schema shaped only by the editor | Mitigated: the core is shaped against the engine's documented needs (nets -> nodes, `role: "ground"`, canonical SI values) because it freezes at this sprint's DoD; Sprint 3 extends it additively only |
| Risk: scope creep toward "just add the LED" | The catalog for this sprint is three components. The LED arrives with simulation in Sprint 3, where it can be shown truthfully |

## 11. PM decisions required

**None.** Sprint 2 is fully determined by the approved product scope and architecture. The framework
choice (React / Preact / vanilla TypeScript) is an engineering decision to be recorded, not a product
decision.

No PM decision on pilot audience size is required yet (RC-6). Capacity benchmarking stays
parameterized; the decision is made before Sprint 8 completion from measured data (roadmap §16.3).

---

## 12. Sprint report

**Outcome: all acceptance criteria A1-A14 demonstrated on Chromium, with one qualification on A11
(CI is defined and its exact steps pass in a clean clone, but it has not run on GitHub, because
Sprint 2 is not pushed).** No PM decision was needed during the sprint. No stop condition (§11 of
the PM direction) was hit.

### 12.1 What exists now

A real TBI Lab application (`app/`) on top of a pure domain package (`packages/domain/`):

- **Project home:** create a project (name in any language, stored verbatim), a recent-projects
  list, and a note that projects live in this browser. The last project reopens on launch.
- **Workspace:** top bar (Projects, editable project name, save state, language), component palette
  (lab PSU, ground, resistor), schematic canvas, and a property inspector.
- **Canvas:** grid, zoom (wheel, buttons, keys), pan (middle-drag, Space+drag, arrows with nothing
  selected) and fit-to-view. Click-to-place with automatic references. Select by click,
  shift-click or rubber band. Move by drag or arrows, with wires following. Rotate in 90° steps (R,
  or the inspector). Delete (Delete/Backspace, or the inspector).
- **Wiring:** click a terminal, optionally click empty space to add bends, then click a terminal,
  junction or wire. Drag-to-wire also works. Routing is orthogonal. Ending on a wire splits it and
  creates a junction. Junction dots are drawn where three or more wire ends meet, including at a
  terminal with two wires. **Crossings are never connections.** Unconnected terminals are open
  circles; connected ones are filled.
- **Inspector:** reference and localized type; unit-aware value fields (`220`, `1k`, `4k7`, `1.5k`,
  `4R7`, `100mA`, `3.3V`) with range and specific localized errors; the PSU's output-enabled
  setting.
- **Persistence:** IndexedDB with debounced autosave and a save-state indicator ("All changes saved"
  / "Saving…" / "Could not save" + retry). A failed write never drops the in-memory document.
- **Localization:** complete English and Hebrew. Hebrew mirrors the chrome; the canvas, identifiers,
  numbers, units and value fields stay LTR.
- **Honesty:** there is no Run control, no simulation affordance and no computed value anywhere.
  Values beside symbols are design values only.

Screenshots of the English and Hebrew workspace and the Hebrew home were taken during acceptance.
They are not committed, to keep binaries out of the repository.

### 12.2 Acceptance criteria

| # | Result | Evidence |
|---|---|---|
| A1 | **Pass** | `app/e2e/editor.spec.ts` "A1": Hebrew-named project is created, persisted and listed |
| A2 | **Pass** | editor.spec "A2-A4" and "A2: move and rotate…": place, move (drag), rotate (R), rubber band, shift-click, delete |
| A3 | **Pass** | editor.spec "A2-A4": terminal-to-terminal net; wire ending mid-wire creates a junction and joins nets; geometric crossing at (40,60) stays two nets; deleting R2 removes its wires, dissolves the junction, leaves no reference to R2 |
| A4 | **Pass** | Browser: the persisted document is validated by the domain validator after every step. Unit: 5 seeds × 400 random edits, validated after each (`packages/domain/tests/fuzz.test.ts`) |
| A5 | **Pass** | editor.spec "A5": `4k7` -> `{value: 4700, unit: "ohm"}`; `220`; `3.3` V; invalid and out-of-range inputs refused with no write |
| A6 | **Pass** | editor.spec "A6", `app/tests/autosave.test.ts` (burst coalescing, saving->saved, failure->error->retry) |
| A7 | **Pass** | `app/e2e/restart.spec.ts`: persistent profile, browser process closed and relaunched. The document is byte-identical, the last project reopens by itself in the remembered language, and wires and values render |
| A8 | **Pass** | `app/tests/i18n.test.ts`: identical key sets, placeholders, catalog keys, and a TSX scan for hard-coded strings (with a self-test that it catches each form). `locale.spec.ts`: no untranslated word on any Hebrew screen |
| A9 | **Pass** | locale.spec "A9": he -> en -> he leaves the stored JSON byte-identical and the viewBox, wire points and component position (relative to the canvas) unchanged. Computed direction is `ltr` for the canvas, value labels, value inputs and references under Hebrew |
| A10 | **Pass** | `app/e2e/keyboard.spec.ts`: Tab to palette, Enter places at view centre, focus lands on the new component with a visible focus ring; arrows move, R rotates, Tab/Shift+Tab move between components, Delete deletes |
| A11 | **Pass on GitHub Actions** (run `35832013633`, §13). *At first report: pass locally, not yet run on GitHub* | `.github/workflows/ci.yml`: install, typecheck, lint (+ boundary), unit/domain/locale tests, browser suites. No dependency on `/home/ubuntu/tbi-tools` (RC-4). The identical steps pass from a clean clone (§12.4) |
| A12 | **Pass** | `scripts/check-boundaries.mjs` (in `npm run lint`) plus an ESLint `no-restricted-imports` rule. Verified to fail on a planted violation |
| A13 | **Pass** | editor.spec "A13": no Run/Simulate/Start/Stop/Play control or text |
| A14 | **Pass** | This report (§12.3 promotions, §12.5 decisions) |

### 12.3 Promoted from feasibility code

| From | To | Changes |
|---|---|---|
| `experiments/gate-d-persistence/src/store.ts` | `app/src/persistence/store.ts` | Project index store for the recent list; document + index written in **one** transaction; `load` returns raw data (validation/migration happen in the domain) |
| `experiments/gate-d-persistence/src/autosave.ts` | `app/src/persistence/autosave.ts` | Save-state reporting; failed writes keep the newest document and are retried; injectable cancel. The Gate D `Illegal invocation` fix is carried |
| Revision metadata of `experiments/gate-d-persistence/src/projectState.ts` | `packages/domain/src/schema.ts` | Fields only (`localRevision`, `cloudRevision`, `baseRevision`, `updatedAt`, `deviceId`). The feasibility component shape was **not** promoted, as the roadmap required |

`experiments/` is unchanged (`git diff` against the roadmap tag is empty for it).

### 12.4 Tests

| Suite | Count | Result |
|---|---:|---|
| `packages/domain` unit (schema, units, editing/nets, validation incl. 2,000 corrupted documents, migration, fuzz) | 104 | pass |
| `app` unit (locale bundles + hard-coded-string scan, formatting, autosave, IndexedDB store, app store) | 36 | pass |
| `app` browser acceptance, Chromium (`npm run test:e2e`) | 14 | pass |
| **New in Sprint 2** | **154** | **all pass** |
| Sprint 0/1 unit (unchanged) | 55 | pass |
| Sprint 0 browser (unchanged) | 4 | pass |
| Real classic-ESP32 integration (unchanged, run locally with the provisioned toolchain) | 20 | pass (80.8 s) |

**Clean-clone CI rehearsal:** the committed tree was cloned into an empty directory and the
workflow's steps were run in order there: `npm ci`, `typecheck`, `lint`, `npm test`, `test:e2e`,
`test:browser`. All passed. The GitHub run itself happens on the first push.

### 12.5 Engineering decisions

| Decision | Choice and reason |
|---|---|
| UI stack | **Preact 10 + Vite 8**, inline SVG canvas, no graphics or diagram framework, in-house localization. See **ADR-009**. Production bundle: 69 KB JS (24 KB gzip), 7.5 KB CSS |
| Workspaces | npm workspaces. `@tbi-lab/domain` exports its TypeScript source, so it has no build step, and each project is typechecked separately. **Deviation:** TypeScript project references were not needed |
| Connectivity model | **Wires reference terminals/junctions; geometry never connects.** `nets` + `connections` are the canonical netlist, re-derived after every edit, with stable net ids. This keeps a future breadboard view possible (PM-1) |
| Where wires live | `layout.wires` / `layout.junctions`, next to `layout.components`. Layout (and so wires) stays out of simulation snapshots, and the netlist carries connectivity |
| Reference ids | `idCounters` in the document guarantees that a deleted reference is never reused, even after reload |
| Grid and coordinates | Integer schematic units on a 20-unit grid; clockwise rotation in 90° steps |
| Routing | Orthogonal, horizontal leg first. Splitting a wire and dissolving a two-wire junction both preserve the drawn path exactly (tested) |
| New project content | Opens with PSU1 and GND1 placed and unwired (product scope §10.3, §14.1) |
| Parameter ranges (input validation, not physics) | Resistance 1 mΩ-1 GΩ; PSU setpoint 0-30 V; current limit 1 mA-5 A. Defaults 1 kΩ, 5 V, 100 mA, **output disabled**, like a real bench supply at power-on |
| Newer-schema projects | Opened read-only if their core still validates under v2 rules; otherwise reported as not displayable. Never written |
| Letter shortcuts | Physical key codes (`KeyR`, `KeyF`), so they work on a Hebrew keyboard layout |
| Preferences | Locale and last-opened project live in `localStorage` per device, never in a project |

### 12.6 Schema v2 core — status

**Frozen** (RC-1), documented in `packages/domain/SCHEMA.md`. It stabilizes project identity and
`schemaVersion`, component instance identity, language-neutral type ids with `typeVersion`,
terminals, nets (role, verbatim user name), connections, SI values with canonical units, position
and rotation, wires and junctions, revision metadata, and id counters. The migration registry is in
place and empty; a newer schema is refused for writing. **Differences from the architecture's
illustrative example (§3.2, "not a frozen wire format"):** added `format`, `createdAt` and
`idCounters`; `layout` is `{components, wires, junctions}` rather than a bare placement map.

### 12.7 Measurements

| Measurement | Value (1-core ARM64 dev host) |
|---|---|
| Drag interaction, 30 components + 29 wires, 40 moves, per move incl. rendered frame | median 33-34 ms, p95 50-69 ms, max 55-80 ms (two runs). **Baseline for Sprint 3** |
| Production bundle | 69.2 KB JS / 24 KB gzip; 7.5 KB CSS |
| App browser suite wall time | ~32 s (14 specs, 1 worker) |

### 12.8 Deviations from this plan

1. TypeScript project references were not used (see §12.5); the typecheck and dependency direction
   are enforced per project instead.
2. A new project starts with PSU1 + GND1 already placed (product scope §10.3). All three types can
   still be placed from the palette.
3. **Keyboard wiring is not implemented.** The Sprint 2 plan's keyboard path covers
   place/select/move/rotate/delete. Wiring by keyboard is a product-scope V1 requirement (§16.2);
   it belongs to E15 "complete" (Sprint 5).
4. Net naming is supported by the schema and the domain (`renameNet`, tested) but has **no UI**
   yet; there was no Sprint 2 task for it.
5. CI has not run on GitHub (Sprint 2 not pushed). See A11.

### 12.9 Remaining risks for Sprint 3

| Risk | Note |
|---|---|
| **Disabled PSU output** | New PSUs default to `outputEnabled: false`. Gate A's `LabPsu` has no enable state. Sprint 3 must model a disabled output truthfully (e.g. as an open source). It must not be treated as a 0 V source, and the circuit it leaves floating must not be solved into invented values |
| **Floating islands** | User circuits routinely contain parts not connected to the reference (e.g. a lone resistor). The engine refuses singular systems. Sprint 3 needs a clear, localized refusal naming the floating parts; the product scope places this rule in §15.2 |
| **Input ranges vs solver conditioning** | The 1 mΩ-1 GΩ resistance range is an input rule chosen without solver evidence. Sprint 3 must verify conditioning across it. Narrowing it later would make stored values invalid and need a migration, which the freeze makes expensive |
| **Wire over an unconnected terminal** | A wire can pass visually over a terminal without connecting (correct by the reference model, and shown by the open terminal mark), but it is ambiguous to a reader. Candidate Sprint 4 validation/visual rule |
| **Hebrew terminology sign-off** | Translations are complete and consistent, but terms such as "הארקה" (ground), "רשת" (net) and "הדק" (terminal) should be confirmed for the controlled glossary before more strings are added |
| **CI on GitHub** | First real run happens at the first push; runner differences (fonts, timing) could surface there |
| **Engine as second schema consumer** | The schema is frozen before the engine consumes it. The netlist shape was designed for compile-from-snapshot (nets -> nodes, `role: "ground"`, SI values), but any Sprint 3 need must be met **additively** |

---

## 13. Closure: real CI evidence (added 2026-09-23)

A11 was not closed by the local clean-clone rehearsal (§12.4). It was closed by real
GitHub Actions runs, and those runs found two defects the local runs had not.

| Commit | GitHub Actions run | Result |
|---|---|---|
| `b79e42f` (Sprint 2 implementation) | `35789744836` | **Fail**: fast job passed; browser job 11 passed, 3 failed (A5 setpoint persisted as 5 V, Hebrew `1,5k` validation error missing, A7 R2 restored as 1 kΩ) |
| `14a575e` (closure fix 1) | `35828605417` | **Fail**: fast job passed; all 8 new commit-race regressions passed; the same 3 acceptance tests still failed |
| `c6f2e0bbfb0742b1a164fb4ee581cac11f34095a` (closure fix 2) | **`35832013633`** | **Success**: both jobs passed (install/typecheck/lint/unit-domain-localization; browser acceptance on Chromium, including `npm run test:e2e` and `npm run test:browser`) |

**A11 = PASS**, on commit `c6f2e0bbfb0742b1a164fb4ee581cac11f34095a`, run `35832013633`.

### Defects found by real CI

1. **Product commit/mount timing races** (fixed in `14a575e` and `c6f2e0b`).
   - Property fields, the project name and the new-project form committed component state
     rather than the input's actual value. A fast Enter or Blur could commit the previous
     value. They now commit the element's value.
   - The property field also started empty and filled its value (and cleared errors) in a
     post-paint effect. Text and its validation error entered right after the field appeared
     were then wiped. The field now starts from the stored value and resets only when that
     value or the component changes.
   - Regressions: `app/e2e/commit-race.spec.ts`. They dispatch input and commit in a single
     task, including a Hebrew-first mount case, and each failed on the code before its fix.
2. **Acceptance-harness persistence race** (fixed in `c6f2e0b`). `waitSaved()` read only the
   save indicator, which can still show the previous "saved" state right after an edit. Tests
   then read IndexedDB or restarted the browser before the autosave landed. The new
   `waitForStoredProject(page, predicate)` polls the real IndexedDB until the specific
   expected change is durable. Every post-mutation read now uses it; `waitSaved()` only means
   "no save pending". No sleeps were added.

Local stress runs before the final push: A5 ×10, Hebrew ×10, A7 restart ×10 and all 10
commit-race tests ×5 all passed.
