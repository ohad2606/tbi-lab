# TBI Lab — Sprint 0: Core Feasibility

**Status:** Gates A, C and D **PASS**. Gate B re-verdicted **PASS (native)** on the new evidence.
Browser-local classic ESP32: **FAIL for Sprint 0**, blocker measured and classified.
Phases 1-6 complete; final architecture report in section 14.
**Opened:** 2026-09-20
**Last updated:** 2026-09-20
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
| A | Electrical simulation feasibility | **PASS** — see 4.7 |
| B | ESP32 Classic feasibility | **PASS (native)** — re-verdicted, see 5.6 |
| C | MCU <-> electrical bridge | **PASS** — see 6.1 |
| D | Local-first persistence | **PASS** — see 7.1 |

| Phase 6 | Arduino compatibility | **Demonstrated** — see 14.1 |

Detailed evidence: `experiments/gate-a-electrical/README.md`, `experiments/gate-b-esp32/README.md`,
`experiments/gate-c-bridge/README.md`, `experiments/gate-d-persistence/README.md`,
`docs/research/classic-esp32-gpio-implementations.md`,
`docs/research/browser-local-classic-esp32.md`.

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

### 4.3 Tolerances (fixed before the tests were written; all asserted in code)

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

### 4.5 Gate A approach (approved 2026-09-20, executed)

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

### 4.6 API direction demonstrated (not final, not over-engineered)

`getNodeVoltage(nodeId)`, `getBranchCurrent(componentId)`, `setSupplyVoltage(supplyId, voltage)`,
`setCurrentLimit(supplyId, current)`, `stepSimulation(dt)` — implemented in
`experiments/gate-a-electrical/src/api.ts`. In a DC-only sprint `stepSimulation` re-solves the
quasi-static operating point; the signature exists so the later transient path is not designed out.

### 4.7 Gate A result: PASS

| Case | Expected | Result |
|------|----------|--------|
| 1. 5 V + 1 kOhm | 5 mA | 5 mA |
| 2. 12 V, 10 k / 10 k | 6 V | 6 V |
| 3. 9 V, 1 k + 2 k | 3 mA | 3 mA |
| 4. Open circuit | 0 A | 0 A exactly |
| 5. PSU 5 V / 100 mA into 10 Ohm | CC, ~100 mA, ~1 V | **CC**, 100 mA, 1 V |
| 6. Short circuit, current-limited PSU | CC at limit | **CC**, 100 mA, 100 uV across 1 mOhm |
| 7. LED + 220 Ohm from 5 V | documented model | 13.7200 mA at 1.9816 V |

Evidence against each acceptance criterion:

- **Automated tests execute** — 25 Node tests (`npm test`) plus 10 ngspice cross-checks and 2
  Chromium/Web-Worker specs (`npm run test:browser`). All passing.
- **Numerically correct within documented tolerances** — every tolerance is stated with its kind
  (absolute/relative) and unit in the test files and in the Gate A README.
- **Deterministic electrical calculation** — repeated solves are bit-identical; the browser
  reproduces the Node LED result bit-for-bit.
- **Credible browser path** — the solver runs in a Web Worker in Chromium 153 at **0.092 ms per
  nonlinear solve** (3000 solves in 275 ms), with the main thread verifiably still servicing its
  timer loop. Pure TypeScript: no WASM, no native dependency.

Two defects were found and fixed during bring-up, both recorded because they shaped the design:

1. Newton reported convergence while junction-voltage limiting was still active, because the
   linearisation point had stopped moving although it was not the solution. Convergence now
   requires limiting to be inactive.
2. A solution with a 9.8e24 A KCL residual was returned without complaint. The solver now
   substitutes every solution back into the **exact, non-linearised** device equations and
   **refuses to return** one that fails verification.

Cross-validation with ngspice 45.2 initially differed by 3.3e-7 on the LED case. That was traced
rather than tolerated, and both causes are now asserted in the test suite:

- **3.34e-7** — ngspice evaluates kT/q with **CODATA 2014** constants; we use the exact **2019 SI**
  values. (Identified by solving for the thermal voltage implied by ngspice's operating point; it
  matches CODATA 2014 to 1 part in 1e9.)
- **1.18e-8** — ngspice's default `RELTOL = 1e-3` stops Newton short of machine precision.

With both aligned, the two independent solvers agree to **~1e-16 relative**.

#### Documented approximations (Gate A)

- **LED parameter identification.** The Vishay TLHR5400 datasheet gives one typical forward point
  (V_F = 2 V at I_F = 20 mA), which cannot identify both I_S and N. N = 1.9 is assumed, I_S is
  fitted to the anchor, R_S is not modelled. The cost is quantified, not hidden: across
  N = 1.8 ... 2.5 the operating point moves only from 13.7157 mA to 13.7458 mA (**0.22 % spread**).
  Valid for roughly 1 mA - 20 mA. This is a parameter-identification limit, not a solver limit.
- **Ideal PSU.** No output impedance, no control-loop dynamics, instantaneous CV/CC transition, and
  it cannot sink current. Valid for DC steady-state operating points, which is all Sprint 0 claims.
- **gmin.** 1e-12 S in parallel with each junction (standard SPICE practice), included in the exact
  residual computation so it is part of the verified model rather than a hidden fudge.

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

### 5.5 Gate B result: CONDITIONAL PASS

Full evidence: `experiments/gate-b-esp32/README.md`. Reproducible probe:
`experiments/gate-b-esp32/gpio_probe.py` (exits non-zero while GPIO is unusable).

**What works.** Real classic-ESP32 firmware executes faithfully. Espressif QEMU
`esp-develop-9.2.2-20260417` (prebuilt aarch64, SHA256 `00de5985...f65339`, GPL-2.0) boots
MicroPython `ESP32_GENERIC` v1.29.0 (SHA256 `e67ad601...bd95f6`, MIT, used **only** as a test
artifact — this is not MicroPython support) through the mask ROM and second-stage bootloader to an
interactive REPL reporting `Generic ESP32 module with ESP32`. Cost on this 1-core host: **3.29 s to
REPL, ~209 MB peak RSS, ~0 % CPU when idle**, 72 MB of tooling. No local QEMU build was needed.

**What does not work — the blocking finding.** Espressif's classic-ESP32 **GPIO peripheral is a
stub**. In `hw/gpio/esp32_gpio.c` at that tag, `esp32_gpio_read()` handles only `GPIO_STRAP` and
returns 0 for every other register, `esp32_gpio_write()` has an **empty body**, and the device state
holds nothing but `strap_mode`. Experimentally, all four required capabilities fail:

| Required for Gate B PASS | Result |
|--------------------------|--------|
| Execute real classic ESP32 firmware | **PASS** |
| Expose firmware-driven GPIO output externally | **FAIL** |
| Accept an externally supplied GPIO input state | **FAIL** |
| Without substituting another ESP32 family member | **PASS** — classic `esp32` machine throughout |

Driving GPIO2 via the driver API, via `GPIO_OUT_W1TS`, and by direct register write all leave
`GPIO_OUT` reading `0x0`. The QEMU monitor reads `0x00000000`. A GDB-stub write to `GPIO_IN` returns
**`OK`** and does not stick — a host tool can believe it set an input level when nothing happened.

`IOMUX` (72 accesses during boot), `RTCIO`, `analog`, `APB control` and `I2S` are also unimplemented.
**`esp32s3_gpio.c` is a 49-line stub too**, so there is no GPIO argument for switching chip family —
and the MCU Rule forbids it regardless.

**Browser delivery is not a version bump.** The fork is on QEMU 9.2.2; upstream Emscripten/WASM
support landed in **10.1** and is experimental, limited to 32-bit guests through **TCI, QEMU's slow
interpreter**. A browser-local classic ESP32 needs Espressif's patches rebased onto a WASM-capable
upstream plus a WASM build plus validation. Browser startup/runtime cost is **unmeasured**; the
native figures above are a lower bound.

**Estimated gap, not implemented** (per the sprint rule): a real GPIO register block with backing
state, an external interface to carry pin levels in and out, and minimal IOMUX routing —
roughly **1-3 weeks** of focused QEMU device work for basic bidirectional digital GPIO, plus ongoing
maintenance of a carried patch against a GPLv2 fork. Not prototyped; treat as order-of-magnitude.

---

### 5.6 Gate B re-verdict: PASS (native execution) / FAIL (browser-local)

The original CONDITIONAL PASS rested on one blocker: Espressif's classic-ESP32 GPIO device is a
stub, so GPIO could be neither observed nor injected. That blocker is **gone**, and it was removed
with existing work rather than a rewrite:

- Real classic-ESP32 firmware executes (MicroPython and Arduino), through the mask ROM.
- GPIO is observable and injectable in both directions, across both register banks.
- The runtime is TRM-faithful after a 42-line correctness fix we made and verified.
- Arduino and MicroPython are both demonstrated, answering two Gate B "later support" questions
  with evidence instead of expectation.

**Gate B is therefore PASS for the native/desktop execution path.** Deliberately split out, because
conflating them would overstate the result:

**Browser-local classic ESP32 is FAIL for Sprint 0.** Evidence in
`docs/research/browser-local-classic-esp32.md`. It is not an architectural impossibility — QEMU's
own CI builds `xtensa-softmmu` for WebAssembly — but **no wasm-capable QEMU contains the classic
ESP32 machine**, and putting one there means rebasing **+19,292 lines across 237 files** from QEMU
9.2.2 to 10.1+, plus the ~1,150-line GPIO implementation, plus our patch and bridge. Browser
startup, memory and speed therefore remain **unmeasured**, because there is nothing to measure yet.

## 6. Gate C — MCU <-> Electrical Bridge

Gate B originally blocked this because Espressif's GPIO device is a stub. Following the PM decision
of 2026-09-20, existing classic-ESP32 GPIO implementations were investigated (Phase 2), a runtime
direction was chosen (Phase 3), and the bridge was then built (Phase 4).

### 6.1 Gate C result: PASS

Evidence: `experiments/gate-c-bridge/README.md`; survey in
`docs/research/classic-esp32-gpio-implementations.md`. Run with `npm run test:esp32` (16 tests).

**Runtime.** `a159x36/qemu @ esp-develop-9.2`, commit `03be9af0` (2026-07-07), GPL-2.0, built from
source on this ARM64 host. It is a fork of `espressif/qemu` on the **same QEMU 9.2.2 base** as our
Gate B baseline, and its `hw/gpio/esp32_gpio.c` is a full 1091-line implementation rather than
Espressif's 108-line stub. Classic `esp32` machine throughout; no C3/S3 substitution anywhere.

**Phase 2 — all five required capabilities proven** with real MicroPython ESP32_GENERIC firmware,
across both register banks (GPIO2/18/19 and GPIO5 in bank 0; GPIO33 via `GPIO_OUT1` and GPIO35 via
`GPIO_IN1`), using both the ordinary driver API and direct `GPIO_OUT_W1TS` register writes.

**An electrical defect was found and fixed.** The upstream model emitted pin-drive events without
gating on `GPIO_ENABLE`, so a pad configured as an *input* appeared to drive the net — precisely the
"visually convenient but electrically incorrect abstraction" the brief warned about. A 42-line patch
(`experiments/gate-c-bridge/qemu-patch/gpio-enable-gating.patch`) gates drive on the output enable,
masks the `GPIO_IN` mirror, and adds `esp32_gpios_dir` lines so a consumer learns when a pad goes
high impedance. The same test that detected the defect now reports TRM-correct.

**Phase 3 decision: Preference B for Sprint 0** (use the existing GPIO-capable fork as the
feasibility runtime, plus our correctness patch), **with Preference A recommended for production**.
Porting onto an Espressif 9.2.2 baseline is cheap in principle (~1,150 lines across three files on
an identical base) but Phase 5 may force the baseline to move to a wasm-capable QEMU 10.1+, so doing
it now risks discarded work without proving anything Gate C does not already prove.

**Phase 4 — the six required integration cases:**

| # | Case | Result |
|---|---|---|
| 1 | firmware drives HIGH into resistor + LED | V(io2) = 3.205059 V, I = 5.753982 mA |
| 2 | firmware drives LOW | V(io2) = 0 V, I = 0 A |
| 3 | external circuit below V_IL | V(io5) = 0.299995 V -> firmware reads LOW |
| 4 | external circuit above V_IH | V(io5) = 3.299950 V -> firmware reads HIGH |
| 5 | electrical state changed while firmware runs | firmware follows HIGH -> LOW -> HIGH |
| 6 | firmware changes output while running | 220 ohm -> 5.7540 mA; 1 kohm -> 1.4064 mA |

The pin voltage in case 1 is **not** the 3.3 V rail: it sags to 3.205 V because 5.754 mA through the
datasheet-derived 16.5 ohm driver resistance drops 0.095 V. Every pin constant comes from ESP32
Series Datasheet v5.3 Table 5-3 with the arithmetic shown in code, and tests assert the model
reproduces the datasheet's own V_OH and V_OL guarantees at their rated currents. Digital input uses
V_IH = 2.475 V and V_IL = 0.825 V, **holding the previous level inside the datasheet's undefined
band** as documented semantics.

Nothing is hardcoded for the test circuit: expected values come from an independent bisection solve
sharing no code path with the MNA solver (agreement asserted to 1e-6 relative), and case 6 changes a
component value the firmware knows nothing about while the result tracks it.

**Timing:** firmware register write -> host observation **< 1 ms**; electrical change -> solve and
push into the MCU **3 ms**. Semantics are event-driven and deterministic; Sprint 0 makes no
real-time claim.

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

### 7.1 Gate D result: PASS

Evidence: `experiments/gate-d-persistence/README.md`. Acceptance proof is real Chromium with real
IndexedDB (`browser/persistence.spec.ts`); `fake-indexeddb` is used only for 9 supplemental fast
tests and is explicitly not the evidence.

- **Reload:** create -> edit every field -> autosave -> **page reload** -> reopen the database ->
  `expect(restored).toEqual(edited)` as a whole-state deep equality. Restored rev 3 with 4
  components, 4 connections and PSU 3.3 V / 0.25 A. Autosave coalesced the edit burst into fewer
  physical writes than edits.
- **Browser restart:** with `chromium.launchPersistentContext` against a temporary profile, the
  browser is **closed entirely** and relaunched. The project restores deeply equal and `deviceId`
  is the same value, proving it is persisted rather than regenerated.
- All required fields round trip, and `updatedAt` survives as exact ISO-8601.

Defect found: `setTimeout` held as a field and invoked as a method throws `Illegal invocation` in
browsers. Node tests could not have caught it — a concrete argument for browser-based acceptance.

---

## 8. Repository Structure (as built)

Minimal. No monorepo tooling, no build framework, no app shell.

```
docs/sprints/SPRINT-0.md              # this file — authoritative sprint record
experiments/                          # feasibility code, explicitly disposable
  gate-a-electrical/
    README.md                         # engine survey, model provenance, tolerances, results
    src/                              # linalg, devices, circuit (MNA), api, models
    tests/                            # reference cases, solver units, sensitivity, ngspice
    browser/                          # Web Worker + Playwright proof
    tsconfig.browser.json
  gate-b-esp32/
    README.md                         # findings, artifact provenance, verdict
    gpio_probe.py                     # reproducible GPIO experiment (host stdlib only)
package.json / tsconfig.json          # single root: typescript + vitest
vitest.config.ts / playwright.config.ts
```

Tools and firmware live **outside** the repository in `/home/ubuntu/tbi-tools/`; no binaries,
toolchains or firmware images are committed. `dist-browser/`, `test-results/` and
`playwright-report/` are git-ignored.

`experiments/` is the boundary between feasibility code and future product code. Nothing in it is
assumed to survive into V1.

---

## 9. Dependencies (approved 2026-09-20, as installed)

| Dependency | Purpose | License | Scope | Status |
|------------|---------|---------|-------|--------|
| typescript 5.9 | typed experiment code | Apache-2.0 | dev | installed |
| vitest 3.2 | Node test runner | MIT | dev | installed |
| eecircuit-engine 1.8.0 | Gate A independent SPICE oracle | wrapper MIT | dev only | installed |
| @playwright/test + Chromium 153 | browser/Worker proofs (Gate A, later Gate D) | Apache-2.0 | dev | installed |
| Espressif QEMU prebuilt (aarch64) | Gate B | GPL-2.0 | local tool, outside git | installed |
| fake-indexeddb | Gate D supplemental unit tests | Apache-2.0 | dev | not yet needed |

**`eecircuit-engine` packaged-runtime licensing audit** (PM decision 4 required this rather than
trusting the wrapper's package license):

- Wrapper: **MIT**, © 2024 EElab.dev, `LICENSE` file present in the package.
- Packaged runtime: **ngspice 45.2**, "Compiled with KLU Direct Linear Solver", build date
  2026-09-05, banner © 1985-1994 Regents of the University of California and © 2001-2025 the
  ngspice team. Confirmed by running it, not by reading the README.
- ngspice itself is **BSD-3-Clause** since release 27 for files without their own header, but it is
  a mixed-licence codebase: `numparam`, `adms` and `tclspice` are **LGPL**, `cider` is old-BSD,
  `xspice` is public domain. The build configuration used to produce the WASM is **not published in
  the package**, so which of those components are actually linked in **cannot be determined from the
  artifact**. This is acceptable for a dev/test-only oracle and is **not** a basis for shipping it.

**System packages installed** for headless Chromium and QEMU (`--no-install-recommends`):
`libatk1.0-0t64`, `libatk-bridge2.0-0t64`, `libatspi2.0-0t64`, `libcups2t64`, `libdrm2`, `libgbm1`,
`libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libasound2t64`,
`libpango-1.0-0`, `libcairo2`, `libnss3`, `libnspr4`, `fonts-liberation`, `libsdl2-2.0-0`,
`libslirp0`, `libgcrypt20`, `libpixman-1-0`. Playwright's full dependency set (72 packages including
`xvfb` and CJK fonts) was **not** installed — only the libraries headless Chromium actually links.

No paid services. No Docker. No persistent daemons. No runtime dependencies for the solver itself.
System Python was not modified; the Gate B probe uses only the standard library.

---

## 10. Risks

| ID | Risk | Impact |
|----|------|--------|
| R1 | **GPLv2 distribution obligations** if QEMU-WASM is ever shipped to browsers: source-offer duty, and the combined-work question for our loader/glue code | Could invalidate the whole browser-local ESP32 path; needs a PM/legal decision before engineering effort is spent |
| R2 | Espressif fork is on QEMU 9.2.2; Emscripten support landed upstream in 10.1 | Browser build requires a patch rebase or port — significant, uncosted work |
| R3 | External GPIO observation/control in Espressif QEMU classic-ESP32 | **CONFIRMED ABSENT.** Device is a stub. Gate C is blocked; see 5.5 |
| R4 | Building ESP-IDF firmware locally needs a multi-GB toolchain | **AVOIDED** — a prebuilt classic-ESP32 image was sufficient; ESP-IDF not installed |
| R5 | QEMU-WASM startup and runtime cost in-browser is unmeasured | **STILL OPEN**, and now compounded by R2: there is no WASM build to measure |
| R6 | **Host is 1 CPU core**, weaker than the CLAUDE.md baseline implies | **MANAGED** — no native builds were needed; prebuilt artifacts used throughout |
| R7 | Playwright ARM64 browser availability | **RESOLVED** — Chromium 153 arm64 runs headless after installing 21 system libraries |
| R8 | The prebuilt QEMU tarball ships **no LICENSE/COPYING file** | Compliance gap if those binaries are ever redistributed. Internal use only today |
| R9 | ngspice WASM build configuration is not published in the package | Which mixed-licence ngspice components are linked cannot be determined from the artifact. Fine for a dev-only oracle; blocks any shipping decision |

---

## 11. Decisions

| ID | Decision | Status |
|----|----------|--------|
| D-001 | Gate A runs two independent tracks (own TS MNA solver + ngspice cross-check) rather than committing to a final engine | **Accepted**, executed |
| D-002 | PSU current limiting is modelled inside the electrical solver, mode determined by the solution, never by test-side clamping | **Accepted**, implemented as an active-set formulation |
| D-003 | LED uses a Shockley-equation model with cited parameters; no unexplained constant-Vf rule | **Accepted**; the single-anchor limitation is quantified, not hidden |
| D-004 | `espressif/esp-emulator` is rejected for V1 despite its ready browser/WASM path, because it does not support classic ESP32 | **Accepted**. Reinforced by Gate B: the S3 GPIO model is a stub too, so substitution would not even solve the GPIO problem |
| D-005 | Gate B prototyping uses Espressif's prebuilt aarch64 QEMU binaries; no native QEMU build on this host | **Accepted**, executed |
| D-006 | The solver verifies every solution against the exact non-linearised device equations and **refuses to return** one that fails, rather than reporting a plausible-looking number | **Accepted** (arising from a real defect found in bring-up) |
| D-007 | Physical constants are explicit in the device model, so cross-checks can distinguish "solvers disagree" from "solvers use different values of k and q" | **Accepted** |
| D-008 | MicroPython firmware is used as a **test artifact only** for Gate B; no MicroPython capability is implemented | **Accepted** |
| D-009 | Gate C not started: Gate B returned CONDITIONAL PASS and the sprint rule requires stopping before a major architectural workaround | **Accepted** |

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
- **LED model fidelity.** Current parameters rest on a single datasheet anchor with an assumed
  emission coefficient. A vendor SPICE model or bench I-V measurement would replace the assumption.
- **Sparse matrix storage.** The Gate A solver uses dense LU, which is ample for tens of nodes and
  wrong for thousands.
- **Contributing a GPIO device upstream.** If the GPIO peripheral is implemented for Espressif's
  QEMU fork, upstreaming it would remove the carried-patch maintenance burden — and would be a
  visible contribution to the ESP32 ecosystem.
- **ngspice as an optional "verification engine"** for users later, alongside our own solver.
- **`esp32.iomux`, `rtcio`, `analog`, `i2s`** are all unimplemented in the fork; any future
  peripheral work will hit these.
- **QEMU GDB stub returns `OK` for discarded MMIO writes.** Any future host-side tooling must
  verify by read-back rather than trusting the write acknowledgement.

---

## 14. Phase 7 — Final Sprint 0 architecture report

Compiled 2026-09-20. Every figure below is measured on this host unless marked *estimate*.

### 14.1 Architecture decision table

| Area | Verdict | Evidence | Confidence |
|---|---|---|---|
| **Gate A — DC simulation in the browser** | **PASS** | 7/7 reference cases; 25 Node tests; ngspice cross-check agrees to ~1e-16 once constants and convergence are aligned; runs in a Chromium Web Worker at 0.092 ms/solve, bit-identical to Node | High |
| **Gate B — classic ESP32, native** | **PASS** | MicroPython and Arduino firmware boot through the mask ROM; GPIO both directions, both register banks | High |
| **Gate B — classic ESP32, browser-local** | **FAIL (Sprint 0)** | ESP32 machine not in any wasm-capable QEMU (+19,292-line port); LX6 CPU core ported and measured in Chromium at ~10 MIPS, ~24x slower than silicon (est.) | High |
| **Gate C — MCU <-> electrical bridge** | **PASS** | All 6 integration cases on the real runtime; values match an independent solver to 1e-6 | High |
| **Gate D — local-first persistence** | **PASS** | Real Chromium + real IndexedDB; exact restore across reload and across a full browser restart | High |
| **Arduino support (Phase 6)** | **Demonstrated** | Official esp32 core 3.3.12, FQBN `esp32:esp32:esp32`; `digitalWrite`/`digitalRead` work through the bridge | High |
| **MicroPython support** | **Demonstrated** | Used as the Gate B/C test firmware throughout | High |
| **Overall V1 architecture as specified** | **Partially proven** | Everything proven except browser-local MCU execution | — |

### 14.2 Native classic ESP32 feasibility — PROVEN

| Metric | Measured |
|---|---|
| Boot to application (MicroPython) | **3.29 s** wall, ~3.1 s CPU |
| Peak RSS | **~209 MB** |
| CPU at idle | **~0 %** (guest executes `WAITI`) |
| Emulator footprint | 72 MB unpacked |
| GPIO output: firmware write -> host observation | **< 1 ms** |
| Electrical change -> solve -> level pushed to MCU | **3 ms** |
| Native QEMU build (this 1-core host) | ~50 min from scratch; **seconds** for an incremental device change |

### 14.3 Browser-local classic ESP32 feasibility — NOT ACHIEVED (now measured)

Updated 2026-09-22. QEMU 10.1 was built for WebAssembly on this host with the classic-ESP32 LX6
**CPU core** ported in, and a bare-metal LX6 benchmark was run in Chromium. That is CPU-only —
no ESP32 ROM, peripherals or GPIO — so it is **not** classic ESP32 firmware in the browser and is
not counted as a PASS. It measures the part of the problem porting cannot fix.

| Metric | Value |
|---|---|
| Xtensa target wasm-buildable? | **Yes — built and run here** (QEMU 10.1, Emscripten 3.1.69, ARM64 host) |
| Classic ESP32 **CPU core** in wasm | **Yes — ported (mechanical, ~20k generated lines) and verified correct in Chromium** |
| Classic ESP32 **machine/peripherals** in wasm | **No** — still needs the +19,292-line / 237-file port from 9.2.2 |
| GPIO in wasm | **No** — depends on the machine port, plus ~1,150 lines |
| Payload | **26.1 MB** wasm (**9.07 MB** gzip) + 339 KB JS (85 KB gzip) |
| Runtime initialisation | **1.0-1.3 s** after module import |
| Fixed overhead before guest compute | ~4.9-6.2 s |
| LX6 speed under wasm (TCI) | **~10 M instructions/s** |
| vs native QEMU (same source) | **~300x slower** (297x / 317x) |
| vs real 240 MHz ESP32 | **~24x slower** — *estimate*, assuming 1 instruction/cycle |
| Memory | ~390-460 MB attributable (Chromium peak 776-847 MB over a ~390 MB idle baseline) |
| Worker | **Yes** — QEMU runs in a pthread Worker; the page's main thread stayed responsive |
| Browser requirements | COOP/COEP cross-origin isolation (SharedArrayBuffer) — verified |

**Blocker classification, now measured:** (1) **porting effort** for the ESP32 machine and GPIO,
and (2) **Xtensa execution performance** — interpreted LX6 is ~24x slower than the real part.
Payload, memory, Worker hosting and browser security requirements were measured and are workable;
they are **not** the blocker. Full detail: `docs/research/browser-local-classic-esp32.md`,
Finding 6.

**Why this matters for B1.** Even after the ~20,000-line machine port, CPU-bound firmware would run
at roughly 1/24 of real time under upstream QEMU's wasm TCI. A translate-to-wasm JIT (as in
`ktock/qemu-wasm`, not upstream) might change that, and was not measured.

**Host caveat.** Everything shared one CPU core, so wall times are pessimistic for a multi-core
desktop; per-core interpretation speed dominates and would not change by an order of magnitude.

### 14.4 Performance measurements

| Subsystem | Measurement |
|---|---|
| DC solver, nonlinear circuit, browser Worker | **0.092 ms/solve** (3000 solves in 275 ms), main thread unblocked |
| DC solver determinism | Browser result **bit-identical** to Node |
| Solver vs ngspice, LED case | ~1e-16 relative, aligned; 3.3e-7 at both sides' defaults, fully attributed |
| ESP32 boot to app | 3.29 s |
| ESP32 emulator RSS | ~209 MB |
| LX6 CPU under QEMU-wasm in Chromium | ~10 M instr/s; ~300x slower than native QEMU; ~24x slower than silicon (est.) |
| QEMU-wasm payload | 26.1 MB wasm (9.07 MB gzip) + 339 KB JS |
| QEMU-wasm runtime init | 1.0-1.3 s |
| GPIO transport latency | < 1 ms |
| Solve + push to MCU | 3 ms |
| IndexedDB round trip | Sub-second including a full browser restart |

### 14.5 Licensing constraints

| Component | Licence | Status |
|---|---|---|
| Our solver, bridge host code, persistence | ours | unencumbered |
| `tbi_gpio_bridge.c`, our GPIO patch | **GPL-2.0** (derived from QEMU) | fine internally; part of the QEMU distribution question |
| QEMU (Espressif / a159x36 / lcgamboa) | **GPL-2.0** | **unresolved for production distribution** |
| ngspice via `eecircuit-engine` | wrapper MIT; ngspice BSD-3 with LGPL parts | dev/test oracle only; **build config not published in the artifact**, so linked components cannot be determined |
| MicroPython test image | MIT | test artifact only |
| Arduino ESP32 core 3.3.12 | LGPL-2.1 / Apache-2.0 | build-time only, not distributed by us |
| Velxio | **AGPL-3.0** | inspected as reference only; **nothing copied** |

**The open licensing question is unchanged and remains a PM decision:** shipping QEMU into a browser
is distribution of GPL-2.0 code, with source-offer obligations and a combined-work question for our
loader. Sprint 0 made no production licensing commitment. Two compliance gaps were logged: the
prebuilt Espressif QEMU tarball ships **no COPYING file**, and the ngspice WASM build configuration
is not published.

### 14.6 Maintenance burden

| Item | Burden |
|---|---|
| GPIO implementation | ~1,150-line carried patch against a GPLv2 fork Espressif rebases periodically |
| Our GPIO correctness fix | 42 lines. **Worth offering upstream** to a159x36/lcgamboa, which would remove it from our plate |
| `tbi_gpio_bridge.c` | 192 lines, ours, stable interface |
| Gate A solver | ours, no third-party runtime dependency |
| ngspice oracle | dev-only; can be dropped without affecting the product |
| Browser ESP32, if pursued | a ~20,000-line rebase plus permanent carry across QEMU releases — **the dominant long-term cost in this whole design** |

### 14.7 Unresolved blockers and open decisions

| # | Item | Needs |
|---|---|---|
| B1 | **Browser-local classic ESP32 is not feasible in Sprint 0.** Two measured obstacles: a ~20,000-line machine port, and interpreted LX6 at ~24x slower than real silicon. Alternatives: the port (plus a wasm JIT effort), or hybrid/server execution | **PM decision.** Sprint 0 did not fall back to a server, as instructed |
| B2 | GPL-2.0 distribution of QEMU into the browser or product | PM/legal decision before any browser-MCU engineering |
| B3 | Production QEMU baseline (Preference A port onto Espressif 9.2.2) deliberately deferred, since B1 may move the baseline | PM direction, sequenced after B1 |
| B4 | LED model rests on one datasheet anchor with an assumed emission coefficient (0.22 % spread over N = 1.8-2.5) | Vendor SPICE model or bench measurement |
| B5 | Pin model uses maximum-drive-strength datasheet figures; drive strength, open-drain and firmware-controlled pulls are not modelled | Later sprint |
| B6 | Bridge exposes 32 output lines (bank 0 only); GPIO32-39 outputs are not evented | Small extension to the patch |
| B7 | Arduino requires `FlashMode=dio`; QIO stalls in QEMU | Document for users, or fix the flash model |
| B8 | `IOMUX`, `RTCIO`, `analog`, `APB`, `I2S` unimplemented in the runtime | Out of Sprint 0 scope |
| B9 | Compliance gaps: no COPYING in the QEMU tarball; unpublished ngspice build config | Track if shipping |

### 14.8 What Sprint 0 answered

1. **Deterministic, physically valid DC simulation in the browser?** **Yes** — verified against an
   independent solver and against ngspice, running in a Worker without blocking the UI.
2. **Can the classic ESP32 execute in our intended architecture?** **Natively, yes** — real
   firmware, real GPIO, Arduino and MicroPython. **In the browser, not yet**, and the gap is
   measured rather than guessed.
3. **Can MCU and electrical state be exchanged both ways?** **Yes** — with a datasheet-derived pin
   model, on the real runtime, with no hardcoded results.
4. **Can a project be stored and restored locally without a server?** **Yes** — real IndexedDB,
   exact restore across reload and across a browser restart.

The one architectural assumption that did **not** survive contact with evidence is browser-local
MCU execution. Everything else in the V1 direction is now supported by reproducible tests.
