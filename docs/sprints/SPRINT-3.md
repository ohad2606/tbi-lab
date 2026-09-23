# Sprint 3 — Real Electrical Vertical Slice

**Status:** EXECUTED — local only, awaiting PM review. Not pushed; no `sprint-3-complete` tag.
**Date:** 2026-09-23 · **Milestone:** B · **Base:** `b79e42f` (Sprint 2), on local branch `sprint-3`
**Authority:** PM Sprint 3 directive (2026-09-23), `docs/product/V1-IMPLEMENTATION-ROADMAP.md`
(approved, RC-1..RC-7), `docs/architecture/V1-ARCHITECTURE.md` + ADR-001..009, product scope,
`CLAUDE.md`.

> **Sprint 2 closure is still pending.** The PM directive asks for Sprint 2 to be closed on
> GitHub first: push, observe the real Actions run, record A11, then tag `sprint-2-complete`.
> `b79e42f` **was pushed** (remote `main` = `b79e42f`). The repository is private, and this
> host has only an SSH deploy key, which cannot read Actions results. The GitHub CLI is
> installed (`~/.local/bin/gh`) but not signed in. The remote CI run therefore has **not
> been observed**, so Sprint 2 A11 is still open and `sprint-2-complete` has **not** been
> created. Sprint 3 was built on a separate local branch so that the Sprint 2 baseline
> stays untouched until that closure is done. See §12.9.

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
| A17 | **Local only** | Every CI-equivalent step passes locally (§8). Remote CI for Sprint 3 is **pending**: Sprint 3 is not pushed, by instruction |

## 8. Tests and CI-equivalent run

| Suite | Count | Result |
|---|---:|---|
| `packages/engine` (reference + bit-identity, product path, OFF model, diagnostics, live controls, range) | 34 | pass |
| `packages/domain` | 108 (+4) | pass |
| `app` unit (incl. controller/store simulation with the real engine, glossary) | 52 (+16) | pass |
| `app` Chromium acceptance (`npm run test:e2e`) | 26 (+12; Sprint 2 A13 superseded by A16) | pass |
| Sprint 0/1 unit, unchanged | 55 | pass |
| Sprint 0 browser, unchanged | 4 | pass |
| Real classic-ESP32 | 20 | not re-run: `experiments/` and the runtime are untouched, and the suite is not a product CI dependency |

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

1. **Sprint 2 closure is incomplete** (remote CI not observable). Sprint 3 was therefore
   developed on local branch `sprint-3` rather than on top of a `sprint-2-complete` tag, which
   does not exist yet. It can be rebased onto the tag once the closure is done.
2. **Parts with nothing wired** are reported as "not connected, not simulated" rather than
   refusing the run. Only wired floating islands are refused. Nothing is invented for them, but it
   is a behaviour choice worth PM confirmation (§12.4).
3. **Resistance edits while running** are refused (Stop first). Only PSU settings are live. The
   product scope suggests live parameter edits; this sprint kept the simplest safe behaviour.
4. Run/Stop state is shown in the top bar. There is no separate PSU panel (Sprint 4).

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
| Remote CI | Neither Sprint 2 nor Sprint 3 has a GitHub run yet (§12.9) |

### 12.4 Decisions for the PM

- **Needed before Sprint 4? No.** Sprint 4 is not blocked.
- **To confirm (non-blocking):** (a) wholly unwired parts are skipped with a notice rather than
  refusing the run; (b) resistance changes need Stop in V1 (the scope suggests live changes).
- **Operational:** GitHub access for this host (`gh auth login`, or equivalent) is needed to
  observe CI and to complete the Sprint 2 closure.

### 12.9 Sprint 2 closure status

| Step | Status |
|---|---|
| Working tree clean, `b79e42f` pushed fast-forward to `main` | **Done** (remote `main` = `b79e42f`) |
| Observe the GitHub Actions run for `b79e42f` | **Blocked**: private repo, deploy key only, `gh` not signed in |
| Update Sprint 2 A11 with the real remote result | Pending the above |
| Tag `sprint-2-complete` | **Not created**, deliberately, until A11 is closed |
