# TBI Lab — Sprint 0: Core Feasibility

**Status:** PLANNING — execution plan awaiting PM approval. No gate work started.
**Opened:** 2026-09-20
**Sprint type:** Technical feasibility. Not product development.

---

## 1. Sprint Goal

Prove or disprove the fundamental technical feasibility of TBI Lab before any product UI or
production architecture is built. Four questions must be answered:

1. Can we perform deterministic, physically valid DC circuit simulation in the browser?
2. Can the classic/original ESP32 realistically execute in our intended architecture?
3. Can the MCU runtime and electrical simulation exchange state in both directions?
4. Can a project be stored locally and restored reliably without depending on a server?

## 2. Scope Discipline

Explicitly NOT built in Sprint 0: product UI, authentication, cloud sync, Oracle integration, AI,
billing, production backend, component library, PCB functionality, mobile support, AC simulation,
oscilloscope UI, multimeter UI, Arduino-IDE-style environment, MicroPython support, sensors, relays,
555 UI, visual component artwork.

No infrastructure beyond what the four questions require. Experimental/disposable code is acceptable
and is kept separate from future product code (see section 8).

---

## 3. Gate Status Summary

| Gate | Subject | Status |
|------|---------|--------|
| A | Electrical simulation feasibility | NOT STARTED — plan drafted, awaiting approval |
| B | ESP32 Classic feasibility | RESEARCH ONLY — no toolchain installed; see 5.2 |
| C | MCU <-> electrical bridge | BLOCKED by Gate B (by sprint rule) |
| D | Local-first persistence | NOT STARTED |

---

## 4. Gate A — Electrical Simulation Feasibility

### 4.1 Acceptance criteria (from PM brief)

PASS only if: automated tests execute; numerical results are correct within documented tolerances;
results come from deterministic electrical calculation; the approach has a credible browser
execution path.

### 4.2 Required reference cases

| # | Case | Expected |
|---|------|----------|
| 1 | 5 V source + 1 kOhm | I = 5 mA |
| 2 | 12 V, 10 k / 10 k divider | V(mid) = 6 V |
| 3 | 9 V, 1 k + 2 k series | I = 3 mA |
| 4 | Open circuit | I = 0 A |
| 5 | Lab PSU 5 V setpoint, 100 mA limit, 10 Ohm load | CC mode, ~100 mA, ~1 V across load |
| 6 | Short circuit with current-limited PSU | CC mode, I = limit |
| 7 | LED + resistor | documented, technically valid device model |

### 4.3 Proposed tolerances (to be fixed before tests are written)

| Case | Reference | Tolerance |
|------|-----------|-----------|
| 1, 2, 3 | closed-form analytic | relative error <= 1e-9 |
| 4 | analytic zero | absolute <= 1e-12 A |
| 5, 6 | analytic in CC mode | relative error <= 1e-3, plus solver must report mode = CC |
| 7 | independent SPICE reference with identical model parameters | relative error <= 5e-3 on branch current |
| all nonlinear | Newton-Raphson convergence | KCL residual <= 1e-12 A, iteration count recorded |

Every tolerance is asserted in code. "Looks reasonable" is not an accepted result.

### 4.4 Candidate approaches evaluated

| Approach | Capability | Browser/WASM | ARM64 dev | License | Maintenance | Integration | Perf | Transient later |
|----------|-----------|--------------|-----------|---------|-------------|-------------|------|-----------------|
| Own TypeScript MNA + Newton-Raphson DC solver | DC linear + nonlinear (diode/LED), CV/CC source model | Native TS, runs in Worker, no WASM needed | Architecture-neutral | Ours (no third-party obligation) | Ours | None | Microseconds for <100 nodes | Yes — companion-model (backward Euler / trapezoidal) is the standard extension |
| `eecircuit-engine` (ngspice compiled to WASM, TS wrapper) | Full SPICE: DC/AC/transient, real device models | Yes — purpose-built for browser | Architecture-neutral (prebuilt WASM) | Wrapper MIT; ngspice BSD-3-Clause with LGPL parts (numparam, adms, tclspice), Old BSD (cider), public domain (xspice) | Active: v1.8.0 published 2026-09-05, prerelease tags through 2026-09-19, zero runtime deps | Netlist-in / result-out; no fine-grained node API | Unmeasured; 43 MB unpacked package needs delivery-cost review | Yes — native SPICE capability |
| circuitjs1 (Falstad/Sharp) | Interactive DC/AC/transient | Yes (GWT -> JS) | Neutral | GPLv2 | Active | Whole application, not an embeddable engine | n/a | Yes |
| Xyce / other native SPICE | Very high | No credible browser path | Heavy build | Mixed | Active | High | n/a | Yes |

### 4.5 Proposed Gate A approach (PENDING APPROVAL)

Two-track, deliberately not committing to a final engine (per brief):

- **Track A1 — own TS MNA solver** as the experiment vehicle. Sparse-free dense LU for Sprint 0 sizes,
  Newton-Raphson with junction-voltage limiting for nonlinear devices. This directly answers "can we
  do deterministic physically valid DC in the browser" with zero licensing entanglement and a clean
  Worker boundary.
- **Track A2 — ngspice/WASM as an independent cross-validation oracle** (development/test only, not a
  shipping decision). The same seven cases are run through ngspice netlists and compared against A1.
  Agreement between two independently implemented solvers is the strongest available evidence of
  physical validity; disagreement is reported, not smoothed over.

Device models to be documented in-repo before use:

- **Resistor:** Ohm's law, linear stamp.
- **Ideal voltage source:** MNA branch-current formulation.
- **LED / diode:** Shockley equation `I = Is * (exp(V_j / (n * Vt)) - 1)` with series resistance `Rs`,
  `Vt = kT/q` at a stated temperature, solved by Newton-Raphson. Concrete `Is`, `n`, `Rs` values will
  be taken from a cited manufacturer or published SPICE model and recorded with the source. No
  unexplained constant-forward-voltage rule.
- **Laboratory PSU:** ideal CV/CC supply. The supply is a device in the electrical model whose
  operating mode is determined *by the solution* (CV while `I <= Ilimit`, CC otherwise), resolved
  inside the Newton loop. Current limiting is never applied by post-processing or by test-side
  clamping. The idealisation (no output impedance, no loop dynamics, instantaneous mode transition)
  is documented as an explicit approximation valid for DC steady-state operating points.

### 4.6 API direction to demonstrate (not final, not over-engineered)

`getNodeVoltage(nodeId)`, `getBranchCurrent(componentId)`, `setSupplyVoltage(supplyId, voltage)`,
`setCurrentLimit(supplyId, current)`, `stepSimulation(dt)`. In a DC-only sprint `stepSimulation`
re-solves the quasi-static operating point; the signature exists so the later transient path is not
designed out.

---

## 5. Gate B — ESP32 Classic Feasibility

### 5.1 Rule

V1 MCU target is the original/classic ESP32 (dual-core Xtensa LX6) of common DevKit boards.
Silent substitution of C3/S3/C6/S2/H2/P4 or any other part is forbidden.

### 5.2 Research findings (desk research only — nothing installed)

| Option | Classic ESP32? | Browser path | ARM64 dev host | License | State | Verdict |
|--------|----------------|--------------|----------------|---------|-------|---------|
| **espressif/qemu** (Espressif QEMU fork) | **Yes** — `esp32` machine, dual-core LX6, ROM + IDF bootloader boot | **Not today.** Upstream QEMU gained Emscripten/WASM support in 10.1 (32-bit TCI). This fork is based on QEMU **9.2.2** (latest release `esp-develop-9.2.2-20260417`). A browser build needs an ESP32-patch rebase onto 10.1+, or a WASM port of the fork. | **Yes — prebuilt `aarch64-linux-gnu` xtensa binaries are published**, so local prototyping needs no native build on this 1-core host | **GPLv2** (+ LGPL-2.1 parts) | Actively released (2024, 2025, Apr 2026) | Primary candidate for classic ESP32 |
| **espressif/esp-emulator** | **No** — C3/C5/C6/H2/P4/S31 (RISC-V) and S3 (Xtensa LX7) only | **Yes** — ships official `wasm` artifacts with a JS API; GPIO exposed over a control channel | Prebuilt linux-arm64 | Apache-2.0 | New (Espressif, few commits) | **Excluded for V1** — would require substituting the MCU. Recorded as a PM decision point, not adopted. |
| **Wokwi** | Yes | Yes (its own site/extension) | n/a | Proprietary, no self-hosting/embedding | Active commercial product | Excluded by licensing and cost rules |
| **Renode** (Antmicro) | Xtensa ISA support exists (added for Sound Open Firmware); classic ESP32 platform support **unverified** | No supported browser delivery path (.NET runtime) | Yes | MIT | Active | Unlikely; low priority to verify |
| **Ebiroll/qemu_esp32** | Yes (community fork, older base, GPIO-focused) | No | Yes (source build) | GPLv2 | Community, dated | Reference material for GPIO wiring only |
| **Custom Xtensa LX6 interpreter (TS/WASM)** | Would be, by construction | Yes | Yes | Ours | n/a | Months of work + ROM/peripheral gaps. Not Sprint 0. |

Espressif QEMU classic-ESP32 emulation covers, per Espressif's own toolchain docs: CPU and memory,
SPI flash, UART (TCP-redirected), eFuse blocks, timer-group watchdogs (RTC WDT *not* emulated),
hardware crypto (AES/SHA/RSA), Opencores Ethernet MAC, SD/MMC host, PSRAM (2/4 MB, MMU/bank
switching *not* emulated), and a virtual RGB panel that does not exist on real hardware. Firmware
must be supplied as a **single merged flash image** (bootloader + partition table + application at
their offsets), not as separate binaries.

### 5.3 Questions the gate must still answer experimentally

Can real classic ESP32 firmware execute; expected browser startup cost; runtime CPU/memory cost;
**whether GPIO state can be observed and controlled externally** (the documentation found so far
covers only `strap_mode` configuration — this is currently *unverified* and is the main Gate C
risk); whether Arduino and MicroPython firmware are realistically supportable later; which
peripherals are realistically emulated; licensing and distribution obligations; remaining gaps.

### 5.4 Acceptance

PASS / CONDITIONAL PASS / FAIL. On CONDITIONAL PASS or FAIL, stop before any major architectural
workaround and request PM direction.

**Current expectation, stated honestly in advance:** the evidence so far points to **CONDITIONAL
PASS** — classic ESP32 firmware execution is well supported on the desktop/ARM64 host, but there is
no ready-made browser-local classic-ESP32 runtime today, so a browser path requires real engineering
(QEMU rebase + WASM port) or a hybrid. The gate will be run to confirm or refute this, not to
rationalise it.

---

## 6. Gate C — MCU <-> Electrical Bridge

Not begun until Gate B establishes a usable MCU runtime direction.

Must prove both directions with a reproducible test:

- **Output:** ESP32 GPIO output -> electrical interface model -> electrical network/load, with the
  solver receiving the GPIO-driven state.
- **Input:** electrical node voltage -> digital state -> MCU GPIO input, derived from the actual
  simulated node voltage (logic thresholds from the ESP32 datasheet, recorded in the repo).

No hardcoded outcomes tied to the test circuit. Room left for ADC/PWM/UART/I2C/SPI later; none of
them implemented in Sprint 0.

---

## 7. Gate D — Local-First Persistence

Minimal browser-local structured persistence proof: create project state -> modify -> autosave ->
reload/reopen -> restore identical state, demonstrated by automated or otherwise reproducible test.

Test state carries enough structure to prove future usefulness: `projectId`, `schemaVersion`,
`revision`, `components`, `nets/connections`, `powerSupply` settings. Sync-ready metadata fields are
*designed* but not acted on: `localRevision`, `cloudRevision`, `baseRevision`, `updatedAt`,
`deviceId`. No cloud sync, no CRDT, no realtime collaboration.

---

## 8. Proposed Repository Structure (PENDING APPROVAL)

Minimal. No monorepo tooling, no build framework, no app shell.

```
docs/sprints/SPRINT-0.md        # this file — authoritative sprint record
experiments/                    # feasibility code, explicitly disposable
  gate-a-electrical/
  gate-b-esp32/                 # scripts + notes only; no binaries committed
  gate-c-bridge/
  gate-d-persistence/
package.json                    # single root: typescript + vitest
tsconfig.json
```

`experiments/` is the boundary between feasibility code and future product code. Nothing in it is
assumed to survive into V1.

---

## 9. Proposed Dependencies (PENDING APPROVAL)

| Dependency | Purpose | License | Scope |
|------------|---------|---------|-------|
| typescript | typed experiment code | Apache-2.0 | dev |
| vitest | test runner for all gates | MIT | dev |
| eecircuit-engine | Gate A independent SPICE cross-check | MIT (ngspice: BSD-3 + LGPL parts) | dev only; 43 MB unpacked — reviewed before install |
| fake-indexeddb | Gate D automated persistence test in Node | Apache-2.0 | dev |
| playwright (optional) | Gate D real-browser reload verification | Apache-2.0 | dev; only if ARM64 Chromium installs cleanly, else manual reproducible check |
| Espressif QEMU prebuilt (aarch64) | Gate B smoke test | GPLv2 | local tool, **not committed to git** |

No paid services. No Docker unless a specific experiment materially requires it. No runtime
dependencies for the solver itself.

---

## 10. Risks

| ID | Risk | Impact |
|----|------|--------|
| R1 | **GPLv2 distribution obligations** if QEMU-WASM is ever shipped to browsers: source-offer duty, and the combined-work question for our loader/glue code | Could invalidate the whole browser-local ESP32 path; needs a PM/legal decision before engineering effort is spent |
| R2 | Espressif fork is on QEMU 9.2.2; Emscripten support landed upstream in 10.1 | Browser build requires a patch rebase or port — significant, uncosted work |
| R3 | External GPIO observation/control in Espressif QEMU classic-ESP32 is unverified | Direct Gate C blocker if absent |
| R4 | Building ESP-IDF firmware locally needs a multi-GB toolchain on a 1-core / 3.8 GB host | Slow; a prebuilt merged flash image may be preferable for the smoke test |
| R5 | QEMU-WASM startup and runtime cost in-browser is unmeasured | May force a hybrid architecture, which needs PM approval |
| R6 | **Host is 1 CPU core**, weaker than the CLAUDE.md baseline implies | Any native compilation is slow; avoid builds where prebuilt artifacts exist |
| R7 | Playwright ARM64 browser availability | Gate D may fall back to `fake-indexeddb` + documented manual browser check |

---

## 11. Decisions

| ID | Decision | Status |
|----|----------|--------|
| D-001 | Gate A runs two independent tracks (own TS MNA solver + ngspice cross-check) rather than committing to a final engine | Proposed |
| D-002 | PSU current limiting is modelled inside the electrical solver, mode determined by the solution, never by test-side clamping | Proposed |
| D-003 | LED uses a Shockley-equation model with cited parameters; no unexplained constant-Vf rule | Proposed |
| D-004 | `espressif/esp-emulator` is rejected for V1 despite its ready browser/WASM path, because it does not support classic ESP32 | Proposed |
| D-005 | Gate B prototyping uses Espressif's prebuilt aarch64 QEMU binaries; no native QEMU build on this host | Proposed |

---

## 12. Blockers / Open Questions for PM

| # | Question |
|---|----------|
| Q1 | Approve downloading Espressif's prebuilt aarch64 QEMU (tens of MB, kept out of git) for the Gate B smoke test? |
| Q2 | Firmware source for the Gate B smoke test: (a) install ESP-IDF locally (multi-GB, slow on 1 core), (b) use an existing prebuilt merged classic-ESP32 flash image purely as a test artifact, or (c) PM supplies a `.bin`? |
| Q3 | Is GPLv2 code shipped into the browser acceptable in principle (R1)? A "no" removes the QEMU browser path before any effort is spent on it. |
| Q4 | Approve `eecircuit-engine` as a dev-only cross-check dependency (43 MB unpacked)? |
| Q5 | Gate D: attempt Playwright for a real-browser reload test, or accept `fake-indexeddb` plus a documented manual browser check? |

---

## 13. Future / Backlog

Findings recorded, deliberately NOT implemented in Sprint 0:

- `espressif/esp-emulator` (Apache-2.0) has an official browser/WASM build with an exposed GPIO
  control channel. It covers ESP32-C3/C5/C6/H2/P4/S31/S3 but **not** classic ESP32. If the PM ever
  reconsiders the V1 MCU target, this is the cheapest browser-local MCU path available.
- ngspice/WASM could later serve as an optional "advanced/verification" engine alongside our own
  solver, including AC and transient analysis.
- Transient simulation via companion models (backward Euler / trapezoidal) is a natural extension of
  the Gate A solver.
- Renode (MIT) may be worth a second look if it gains a classic ESP32 platform.
