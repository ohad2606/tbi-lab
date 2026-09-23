# Sprint 3 — Real Electrical Vertical Slice

**Status:** CLOSED — approved; A17 passed on GitHub Actions (§14).
**Date:** 2026-09-23 · **Milestone:** B · **Base:** `99f90b6` (final Sprint 2 closure commit), local branch `sprint-3`
**Authority:** PM Sprint 3 directive (2026-09-23), `docs/product/V1-IMPLEMENTATION-ROADMAP.md`
(approved, RC-1..RC-7), `docs/architecture/V1-ARCHITECTURE.md` + ADR-001..009, product scope,
`CLAUDE.md`.

> **Rebased (§13).** Sprint 3 was first built on `b79e42f` while Sprint 2 closure was pending.
> After the Sprint 2 CI fixes (`14a575e`, `c6f2e0b`; A11 passed in GitHub Actions run
> `35832013633`) and the closure record `99f90b6`, the four Sprint 3 commits were rebased onto
> `99f90b6`, not recreated.

---

## 1. Goal

Turn the Sprint 2 schematic editor into a real DC electronics simulator. A user draws a small
approved circuit, presses **Run**, and sees values that come from the proven physical solver,
running in a browser Web Worker. No fake values, and no simulation on the main thread.

## 2. Scope

**In:** the production electrical engine (promoted Gate A logic) and its boundary. The Mode A
Web Worker host. The LED component. The PSU output-off model. Run/Stop. Live PSU setpoint,
limit and output-enable while running. Refusal of structural edits while running.
Floating-island and solver diagnostics. Minimal result display (canvas + inspector). A
numerically tested resistance range. The Hebrew electrical glossary. Worker failure handling.
Performance measurements.

**Out (unchanged from the directive):** diode, button, switch, ESP32, QEMU, build service, auth,
export/import, probes as an instrument system, the final PSU panel, undo/redo, net-naming UI,
keyboard wiring, capacitor/transient/AC, meters and scopes, PWM/ADC/DAC/I2C/SPI, radio,
breadboard, sync, AI. The catalog stays closed: PSU, ground, resistor and LED are the only
types in the product so far.

## 3. What was built

| Area | Where | What |
|---|---|---|
| Electrical engine | `packages/engine` | Gate A `linalg`, `circuit`, `devices`, `models` **promoted** (logic unchanged, see `PROVENANCE.md`). New `EngineSession`: compile from a snapshot, disabled-output model, reference analysis, structured errors, live PSU controls, LED model-range flag |
| Snapshot | `packages/domain/src/snapshot.ts` | `createSnapshot(doc)`: an immutable, layout-free, language-neutral projection with `snapshotId` and `projectRevision`. `topologyKey` and `liveChanges` support the running-edit rules |
| LED | `packages/domain` catalog, `app` symbol | `component.led` (refs `D1`, `D2`…), terminals `anode`/`cathode`, curated `model` enum with one datasheet card (Vishay TLHR5400) |
| Worker host | `app/src/sim/worker.ts`, `protocol.ts` | Mode A: load / control / stop messages in, typed outcomes out. The solver is **only** in the worker chunk |
| Controller | `app/src/sim/controller.ts` | stopped → starting → running / failed; stale-response guard; crash and timeout handling; timings |
| App integration | `app/src/state/app.ts` | Run/Stop, a structural-edit lock checked by content, live PSU mirroring after persistence |
| UI | `SimControls`, `NoticeBar`, `Canvas`, `Inspector` | Run/Stop + status, localized diagnostics, runtime labels on the canvas, a separate "Simulation result" inspector section, LED brightness cue, running outline |
| Glossary | `app/src/i18n/glossary.ts` | The single source of truth for electrical terms; bundles reference `[[term]]` |

## 4. Electrical model decisions

| Topic | Decision |
|---|---|
| **PSU output off (A7)** | An **open circuit**: the supply contributes no element to the solved topology. It carries exactly zero current, and its terminal voltage is whatever the rest of the circuit imposes. It is not a 0 V source and no leakage is added. Tested: OFF gives exactly 0 A; the same circuit ON solves correctly; OFF differs from an enabled 0 V supply (the 0 V supply is stiff, can't sink, goes CC; OFF floats to the external 5 V) |
| **GND** | All ground symbols are the single reference node |
| **Floating island (A8)** | A group of wired parts with no path to GND is refused with `floating_circuit`, naming its components and nets. If it floats only because a supply is off, the message names that supply. No ground is inserted, no leakage is added, no voltages are fabricated |
| **No GND wired** | `no_ground`, with its own message |
| **Parts with nothing wired** | Not part of the circuit: listed as "not connected, not simulated", with no values |
| **Enabled PSU shorted by a wire** | `psu_shorted` (a product-scope invalid-connection case) |
| **Contradictory sources** | `singular_circuit` ("no unique solution") or `no_convergence` |
| **LED** | The Gate A Shockley card (TLHR5400, N = 1.9, I_S fitted to the datasheet anchor), unchanged. Current outside the card's documented 1–20 mA range is **flagged**, never altered |
| **LED visual** | Symbol fill opacity = I/20 mA (clamped). A visual cue only; documented as such in the inspector |

## 5. Resistance range (A15)

**Tested and supported: 1 mΩ – 1 GΩ, the full existing input range.** No change to validation
policy or to the schema. Evidence (`packages/engine/tests/range.test.ts`):

- every decade as a single load, in CV and CC at 0.001–30 V and 1 mA–5 A;
- all 169 decade pairs as a divider (ratios up to 1e12);
- LED + series resistor at every decade against an independent bisection;
- 200 seeded random ladders.

Every case passes the solver's own exact-equation verification and matches the analytic answer
to **1e-9 relative**, the Gate A tolerance.

## 6. Hebrew terminology

Adopted as directed. The terms live in `glossary.ts`, which is the source of truth: ground =
**אדמה (GND)**, net = **רשת**, terminal = **הדק**, junction = **צומת**, component = **רכיב**,
pin = **פין**. Messages reference these as `[[term]]`, and a test forbids "הארקה" anywhere in the
Hebrew bundle. CV and CC stay as the professional terms. Canvas, numbers, units and identifiers
stay LTR.

## 7. Acceptance criteria — results

| # | Result | Evidence |
|---|---|---|
| A1 | **Pass** | `packages/engine` is the one production engine. `experiments/` is unchanged and never imported (boundary check + ESLint rule) |
| A2 | **Pass** | `packages/engine/tests/reference.test.ts`: the seven cases at the **original** tolerances, and every value **bit-identical** to the frozen Gate A engine (`gate-a-golden.json`) |
| A3 | **Pass** | The Worker is observed at runtime (`page.on('worker')`, `simulation.spec` A3/A4). Solver code is absent from the main bundle and present only in `worker-*.js`. 0 long tasks during repeated 30-part runs |
| A4 | **Pass** | UI-drawn 5 V → 1 kΩ → GND: R1 shows **5 mA**; PSU **5 V · 5 mA · CV** |
| A5 | **Pass** | UI-drawn 5 V → 220 Ω → LED → GND: **1.982 V · 13.72 mA**, equal to the engine run in Node on the same stored project (and bit-identical to Gate A in the engine tests) |
| A6 | **Pass** | 5 V / 100 mA into 10 Ω: **1 V · 100 mA · CC**, with no error shown |
| A7 | **Pass** | Output OFF: PSU **0 V · 0 A · OFF**, LED **0 V · 0 A**. Enabling it live re-solves to 1.982 V · 13.72 mA. Engine tests: exactly 0 A when OFF, distinct from an enabled 0 V supply |
| A8 | **Pass** | A closed R2–D1 loop off GND is refused: "…floating circuit with no connection to GND: R2, D1…", also in Hebrew. No raw solver text, and no values shown |
| A9 | **Pass** | Stored project bytes are identical before Run, while running and after Stop. Stop removes every runtime label and result section |
| A10 | **Pass** | Output-enable and setpoint changes while running: IndexedDB holds the new value at revision n+1, the worker reports `appliedRevision` n+1, and results re-solve (`data-solves` 2). Unit test: persist first, then control with that revision |
| A11 | **Pass** | While running, placing, wiring, deleting and editing resistance are refused ("Stop the simulation to change the circuit…"), enforced by comparing topology, not by call site. Layout edits and live PSU controls stay allowed |
| A12 | **Pass** | `sim-restart.spec`: browser process closed during a run; reopens **stopped** with no runtime labels, byte-identical project, and runs again |
| A13 | **Pass** | Runtime labels are identical in English and Hebrew; switching language while running writes nothing; result text is LTR |
| A14 | **Pass** | The worker script is replaced with one that throws: status "Could not run", "The simulation stopped unexpectedly. The project is not affected…". No stack or internals shown, project bytes unchanged, Stop and a retried Run work. Unit tests: crash and timeout |
| A15 | **Pass** | §5 |
| A16 | **Pass** | Only Run/Stop exist (no Pause/Step/Reset). No runtime value is shown before Run. Every asserted UI value equals the production engine's output on the same stored project |
| A17 | **Pass on GitHub Actions** (run `35838206319` on `b95387c`, §14). *At first report: local only* | Every CI-equivalent step passes locally (§8). Remote CI for Sprint 3 is **pending**: Sprint 3 is not pushed, by instruction |

## 8. Tests and CI-equivalent run

| Suite | Count | Result |
|---|---:|---|
| `packages/engine` (reference + bit-identity, product path, OFF model, diagnostics, live controls, range) | 34 | pass |
| `packages/domain` | 108 (+4) | pass |
| `app` unit (incl. controller/store simulation with the real engine, glossary) | 52 (+16) | pass |
| `app` Chromium acceptance (`npm run test:e2e`) | 36: 26 from Sprint 3 (Sprint 2 A13 superseded by A16) + 10 Sprint 2 commit-race regressions | pass |
| Sprint 0/1 unit, unchanged | 55 | pass |
| Sprint 0 browser, unchanged | 4 | pass |
| Real classic-ESP32 | 20 | pass (re-run after the rebase; not a product CI dependency) |

CI-equivalent steps run locally, as in `.github/workflows/ci.yml`: `npm ci`, `typecheck`, `lint`
(ESLint, Prettier, boundary), `npm test`, `test:e2e`, `test:browser`. The CI workflow needs no
change: the engine tests run in `npm test`, the Worker/UI tests in `test:e2e`, and nothing
touches the ESP32 toolchain.

## 9. Performance (measured, not promised)

1-core ARM64 dev host, headless Chromium (`test-results/sprint3-worker-performance.json`):

| Measurement | 5 V / 1 kΩ | 5 V / 220 Ω / LED | 30 parts (28 R + 2 LED) |
|---|---:|---:|---:|
| Worker start (first Run) | 54 ms | 43 ms | reused |
| Snapshot transfer to worker (warm median) | 0.3 ms | 0.2 ms | 0.2 ms |
| Solve in worker (compile + solve + verification) | 0.2 ms | 0.4 ms | 1.5 ms |
| Result to main thread | 8.8 ms | 9.7 ms | 7.3 ms |
| **Run → result, warm median** | **13.5 ms** | **13.7 ms** | **14 ms** |
| First Run incl. worker start | 64 ms | 54 ms | — |

- Live PSU change → re-solved result: median **9.7 ms**.
- Main thread during 11 runs of the 30-part circuit: **0 long tasks** (> 50 ms).
- **Investigated: "result to main thread".** A control measurement moving a result-sized object
  from a bare worker to an idle page takes **0.3 ms** (median). The 7–10 ms above is therefore
  not transfer cost. It is the main thread still rendering the "Starting…" state when the result
  arrives, on a single core that the worker shares. The solve itself matches Sprint 0's ~0.1 ms
  evidence (0.2–0.4 ms including compile and verification; the timer resolution is 0.1 ms).
- The Sprint 2 drag baseline (30 components) is unchanged and still recorded separately.

## 10. Schema changes

**Additive only; `schemaVersion` stays 2; no migration.** Every Sprint 2 document validates
unchanged.

- New component type `component.led` (typeVersion 1).
- New parameter kind: language-neutral **enum** token (`ParamValue` gains `string`), used by the
  LED `model`.
- Catalog metadata `live: true` on PSU setpoint, limit and output enable.
- No change to project identity, component/terminal/net identity, value representation, layout
  or revision semantics. No runtime data is persisted.

## 11. Dependencies

**None added.** The engine is pure TypeScript from Gate A. The Worker is the platform API,
bundled by the existing Vite.

## 12. Report

### 12.1 Deviations from the directive

1. Sprint 3 was built before the Sprint 2 closure and later rebased onto it (§13).
2. Run/Stop state is shown in the top bar. There is no separate PSU panel (Sprint 4).

Two behaviours first listed here as deviations were **approved by the PM** (§12.4).

### 12.2 Promotions

See `packages/engine/PROVENANCE.md`. The four Gate A files were promoted with logic unchanged;
`CurrentSource` and the ngspice-only constants were dropped. One ESLint suppression marks a
verbatim line.

### 12.3 Risks for Sprint 4

| Risk | Note |
|---|---|
| Switch model conditioning | Push button and toggle switch need open/closed resistances that stay well-conditioned. The measured 1e-12 divider ratios suggest headroom, but the chosen values must be tested the same way |
| Diode card | A general-purpose card (e.g. 1N4148) must be datasheet-sourced with a documented validity range, like the LED |
| Live edits beyond the PSU | Switch positions are live by the product scope. The live-param mechanism is catalog-driven (`live: true`), but a switch changes topology inside the model; it must re-solve, not recompile silently |
| Result display density | Canvas runtime labels can overlap wires in dense layouts. Probes (Sprint 4) should replace always-on labels |
| LED model range | Circuits beyond 20 mA are flagged; users may still push the model. A second, datasheet-sourced card would help |
| Remote CI | Sprint 3 has not run on GitHub yet (not pushed, by instruction). The Sprint 2 closure showed that real CI finds timing issues local runs miss |
| Button vs switch semantics | Decided by the PM (§12.4). The button is a transient runtime command and never touches the project; the switch is a live persistent edit, and `live: true` + `liveChanges` already carry it |

### 12.4 Decisions for the PM

**PM decisions recorded 2026-09-23 (approved):**

- **Unwired components.** A component with no electrical connection at all may be omitted from
  the solve with a clear "not connected / not simulated" notice. A partially wired component or a
  connected floating island is **never** skipped: it goes through normal topology validation and
  the floating diagnostics. This is already the implemented behaviour (engine `notConnected` vs
  `floating_circuit`).
- **Resistor value while running.** Changing it requires Stop in V1. No live resistor mutation;
  live persistent edits stay deliberately narrow (PSU setpoint, current limit, output enable).
- **Future interaction semantics (Sprint 4; decided, not implemented):**
  - *Push button* press/release is a **transient runtime interaction**, not persisted project
    state.
  - *Toggle switch* position is **persistent project state**. When it changes during Run, the
    browser persists first, then mirrors the change to the runtime and triggers a re-solve
    (architecture §2.2, category 2).

**Needed before Sprint 4? No.** No PM decision blocks Sprint 4.

### 12.9 Sprint 2 closure status

| Step | Status |
|---|---|
| Sprint 2 CI fixes pushed | `14a575e` (commit race), `c6f2e0b` (mount-effect race; durable test waits) |
| A11 on GitHub Actions | **PASS**, run `35832013633` on `c6f2e0b` (both jobs) |
| Closure record pushed | `99f90b6` (`docs/sprints/SPRINT-2.md` §13) |
| Tag `sprint-2-complete` | Targets the final closure commit once its own CI run is confirmed green |

## 13. Rebase onto the Sprint 2 closure

The four Sprint 3 commits were **rebased** (not recreated) from `b79e42f` onto `99f90b6`.

**Textual conflicts: none.** The Sprint 2 fixes and the Sprint 3 changes touched different lines.
Because a clean textual merge does not prove a correct result, the merged code was checked
semantically:

| Area | Result after rebase |
|---|---|
| `Inspector.tsx` `ParamField` | Keeps the Sprint 2 fixes: commit of `e.currentTarget.value` on Enter and Blur, field state initialised from the stored value, reset only when the stored value or component changes (never on mount), no-op re-commit. Also keeps the Sprint 3 behaviour: running-lock for non-live params, locked hint, enum field, results section |
| `TopBar.tsx`, `Home.tsx` | Sprint 2 raw-value commit fixes kept; Sprint 3 Run/Stop controls present |
| `app/e2e/helpers.ts` | Keeps both `waitForStoredProject` and the durable `createProject` wait (Sprint 2), plus the return-to-Projects navigation (Sprint 3). `waitForStoredProject` gained an optional project-name filter for tests that hold several projects |

**Sprint 3 test synchronization brought up to the Sprint 2 standard.** Sprint 3 specs were
written before the harness fix and used the save indicator as proof of persistence:

- `drawLoop` now waits until the drawn and configured circuit (values, output enable, wires) is
  durable in IndexedDB. Several tests take byte baselines right after it.
- The live-edit test waits for the exact persisted change (output enabled; setpoint 3.3 V)
  before comparing revisions and recomputing the engine truth.

No assertion was weakened, and no sleeps were added.

**Evidence changed by the rebase:** only the test counts (§8, +10 commit-race regressions) and
the ESP32 re-run. Every electrical value, acceptance result and performance figure in this
report is unchanged: the engine and simulation code are identical to before the rebase.

## 14. Closure (added 2026-09-23)

Sprint 3 (`b95387ca0776d17d939eb0c5d0c1079cdcc834c5`) was pushed to `main` as a fast-forward
from the Sprint 2 closure. GitHub Actions run **`35838206319`** passed both jobs: the fast job
(typecheck, lint, unit), and browser acceptance (`npm run test:e2e` and
`npm run test:browser`). **A17 = PASS.** Sprint 3 was approved by the PM.
