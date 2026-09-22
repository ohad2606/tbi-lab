# Sprint 2 — First Product Surface

**Status:** PLAN ONLY — awaiting PM approval. **Nothing in this document has been implemented.**
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
| CI | Pipeline running typecheck, lint, unit tests and the browser suite on every change |
| Boundary guard | A check that fails if production code imports from `experiments/` |

`experiments/` is **not touched**. Nothing is moved out of it; promoted logic is copied deliberately,
with the promotion recorded in the sprint report.

### 3.2 Schema slice (`packages/domain`) — schema v2 core

Per roadmap §6.1. Implemented in full for the types this sprint ships:

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
| T2 | CI pipeline: typecheck, lint, unit, browser; boundary guard | Single worker for browser tests (1-core host) |
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
| A11 | CI runs typecheck, lint, unit and browser tests on every change and is green |
| A12 | Production code contains **no import from `experiments/`**, enforced by the boundary check |
| A13 | The app shows nothing that does not work: no Run control, no simulation affordance |
| A14 | The sprint report records what was promoted from feasibility code and every decision taken |

## 9. Definition of Done

1. All acceptance criteria A1-A14 demonstrated on Chromium.
2. All pre-existing tests still pass (55 unit, 4 browser, 20 ESP32 untouched).
3. New tests per §6 exist and pass in CI.
4. Schema v2 core is documented in `packages/domain` with the roadmap §6.1 table as its reference,
   and is **not yet frozen** (freeze is end of Sprint 3).
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
| Risk: schema shaped only by the editor | Accepted deliberately — the engine is the second consumer in Sprint 3, which is why the freeze is then, not now |
| Risk: scope creep toward "just add the LED" | The catalog for this sprint is three components. The LED arrives with simulation in Sprint 3, where it can be shown truthfully |

## 11. PM decisions required

**None.** Sprint 2 is fully determined by the approved product scope and architecture. The framework
choice (React / Preact / vanilla TypeScript) is an engineering decision to be recorded, not a product
decision.

One PM answer will be needed **later, before Sprint 8**, and is noted here only so it is not
forgotten: the **pilot audience size**, which selects the capacity benchmark level (roadmap §16.3).
