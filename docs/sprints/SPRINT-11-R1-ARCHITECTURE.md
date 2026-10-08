# Sprint 11 — R1 architecture: the Sprint 10 parts in ESP32 projects

**Status:** **APPROVED WITH CONDITIONS** (PM, 2026-10-08): the conditions are binding design
additions, §6. **Slices 0–6 implemented** (2026-10-08; record: `SPRINT-11.md` Part C): six parts
enabled for ESP32 projects (RGB LED, buzzer, PIR, 2N3904, relay, photoresistor); the 8×8 matrix
measured and kept local-only; the capacitor refused. Deployment (slice 7) not authorised.
**Branch:** `sprint-11` (worktree `~/projects/tbi-lab-s11`), from `465b330` = `main` =
`sprint-10-complete`. Sprint 10 is closed and is not reopened.
**Companion documents:** [SPRINT-11-IMPLEMENTATION-PLAN.md](SPRINT-11-IMPLEMENTATION-PLAN.md) ·
[SPRINT-11-TEST-MATRIX.md](SPRINT-11-TEST-MATRIX.md) ·
[ADR-010](../architecture/adr/ADR-010-esp32-part-support-and-live-part-parameters.md) ·
the earlier deployment plan [PHASE-R1-DEPLOYMENT-PLAN.md](../runtime/PHASE-R1-DEPLOYMENT-PLAN.md)
(still valid for the deployment mechanics; this document supersedes its §1–§3 where they differ).

**Objective (PM, Sprint 11):** make the Sprint 10 local-only components usable in ESP32 Classic
Arduino projects where technically appropriate. Real electrical behaviour, deterministic runtime
contracts, session isolation and the one authoritative electrical engine are preserved.

**Out of scope (PM constraints):** R2 microsecond timing, R3 I2C/LCD, R4 PWM/servo, ESP32
transient (capacitor), ADC, any new toolchain or dependency, a second physics engine, potentiometer,
555, Wi-Fi, other controllers, production.

---

## 0. Baseline (verified 2026-10-08)

| Item | Value | How verified |
|---|---|---|
| Sprint 10 | **Closed**: tag `sprint-10-complete` (object `197e13d`) peels to `465b330` = remote `main` = remote `sprint-10` | `git ls-remote` |
| dev-lab frontend | `7da5c8b` (`dirty: false`) | `/version.json` through the gate's internal socket |
| Session Host runtime | `80448f9` (`tbi-lab.session/2`, `0.10-dev`), 0 sessions | Session Host `/health` (its unix socket) |
| Services release | `services/current` → `80448f9`; `tbi-session-host` started 2026-10-07 20:25:25 UTC, `tbi-build` 20:24:03 UTC | `readlink`, `systemctl` |
| QEMU | binary `538af3d7…f9df`, runtime id `33e35e4ac5e798d7` | SPRINT-10.md W.4 |
| Build service | byte-identical to `c31d62e` | SPRINT-10.md P |
| Working trees | `sprint-10` clean; `sprint-11` created from `465b330` | `git status` |
| ADRs | ADR-001…009; relevant: 004 (co-location), 007 (time contract), 008 (one engine, two hosts) | `docs/architecture/adr/` |

---

## 1. What the inspection found

### 1.1 How an ESP32 run works today (facts)

- **Output path.** QEMU publishes every pad (drive, level) change as a synchronous bridge frame
  `G <vns> <pad> <drive> <level>` and blocks until the host replies (`runtime/qemu/patches/0004…`,
  `runtime/harness/protocol.ts:30-50`). `HostSession.onPad` sets the engine pin mode and **re-solves
  the circuit on every attached pad event** (`runtime/host/session.ts:445-472`).
- **Input path.** After each solve, `solveAndInject` turns every attached input pad's voltage into
  a logic level with `interpretDigitalInput` (V_IH 2.475 V, V_IL 0.825 V, the previous level held in
  between; initial "previous" = 0) and injects `I pad level` only on change, at zero elapsed
  virtual time (`session.ts:422-439`; `packages/engine/src/esp32Gpio.ts:31-34, 84-88`).
- **Commands from the browser** (mirrors, button presses) are queued and applied at the next 1 ms
  tick (`COMMAND_QUANTUM_US = 1000`, `runtime/host/protocol.ts:31`; `onTick`, `session.ts:487-504`),
  followed by one solve and injection.
- **Results to the browser.** Every 10 ms of simulation time the host publishes a `gpio` event
  (final level and transition count per pad), the **whole latest `SolveOutcome`** when it changed
  (`electrical`), and serial output (`session.ts:548-576`; `config.ts:89`). The browser stores it as
  `sim.outcome`, the same object a local run produces (`app/src/runtime/controller.ts:376-394`).
- **One engine, two hosts (ADR-008).** The host builds one `EngineSession` per run from the
  browser's circuit snapshot plus the pad attachments (`session.ts:271`). The engine attaches pads
  generically; it has no notion of "allowed with a board" (`packages/engine/src/session.ts:50-58`).
- **Discrete state persists** across solves for the whole session (relay armature, PIR powered;
  `engine/src/session.ts:296-301`); each solve iterates to a fixed point (≤ 32 passes). **The host
  never calls `advance()`** (no simulated-time stepping of parts).

### 1.2 Why the eight parts are refused today (facts)

One catalog flag, `mcuRuntime: false` (`packages/domain/src/catalog.ts:89-93`; set at :176, 210,
234, 257, 291, 327, 362, 394), enforced in three places:
1. **Placement:** `placementBlock()` (`catalog.ts:621-643`) → palette disabled
   (`app/src/ui/Palette.tsx:43, 73-84`), drop refused (`app/src/ui/Canvas.tsx:351`).
2. **Run (browser):** `buildSessionRequest` → `mcu_component_unsupported` before anything is sent
   (`app/src/runtime/snapshot.ts:128-133`).
3. **Host:** `prepare()` → `electrical_error {code: 'unsupported_component'}`
   (`runtime/host/session.ts:256-268`), using the catalog bundled into the host build.

### 1.3 The gaps R1 must close (facts)

| Gap | Where | Effect today |
|---|---|---|
| **Live part parameters cannot reach a running board.** `MirrorControl` and `validateCommand` accept only `setpointVoltage`, `currentLimit`, `outputEnabled`, `closed` | `runtime/host/protocol.ts:96-101, 299-318` | The browser already sends `control.params` for live parameters (`app/src/state/app.ts:840-864`); the host answers 400 → the client fails the session as a transport refusal → the user sees **"the runtime service is not reachable"** (wrong message). The engine already accepts `params` restricted to each part's declared `liveParams` (`engine/src/session.ts:390-402`: `motion` for PIR, `illuminance` for the LDR) |
| **No ADC.** QEMU's SENS (SAR ADC), ANA and RTCIO are `unimp` devices; the bridge carries digital levels only; the builder refuses `analogRead` (`runtime/builder/features.ts:29`) | QEMU source, `harness/protocol.ts:9-17` | `analogRead` cannot be honest in R1 |
| **No PWM/LEDC on pads.** GPIO-matrix routing is storage only; the builder refuses `ledcWrite`, `analogWrite` (`features.ts:30`); `tone()` is LEDC-based (to verify against a built ELF) | patch 0003; R1-REPORT.md:389 | PWM brightness, colour mixing, `tone()` impossible |
| **No time stepping on the host** | `session.ts:259-272` | A capacitor would be an open circuit: excluded |
| **The board supplies no power.** Only `gpioN` and one `gnd` are connectable (`catalog.ts:96-114`); the runtime projection replaces the board with a ground (`snapshot.ts:164-173`) | — | 5 V parts (PIR ≥ 4.5 V, relay coil, buzzer from 5 V) need the lab PSU in the circuit |
| **No pad over-voltage diagnostics.** Pad warnings cover output current, contention and shorts only (`packages/engine/src/ratings.ts:197-218`) | — | A 5 V divider into an input, or 5 V pushed into an output-HIGH pad, would look fine. With 5 V parts now beside the board, this is the main *physics-honesty* risk of R1 |
| **No per-solve wall budget.** Work is bounded by iteration caps only (Newton 200, active set 32, state passes 32); all sessions share one Node event loop | `circuit.ts:125-126`; `harness/session.ts:338-347` | A dense circuit (the matrix) switching often stretches wall time (never virtual time) and can delay other sessions |
| **Part models are outside the R-MCU-1 gate harness**, which uses the low-level `Circuit` (`runtime/harness/closedLoop.ts:71`); the gate test's header still names runtime id `979f09d739382157` while the deployed id is `33e35e4ac5e798d7` | `runtime/tests/gate.runtime.test.ts:23` | ADR-007 requires every new bridge or peripheral feature to extend the release gate |

---

## 2. Capability matrix

Legend — **Supported** (works in an ESP32 project after R1, honestly) · **Feasible, bounded**
(supported with a stated limit) · **Blocked** (cannot be honest without R2/R3/R4/transient/ADC) ·
**Deferred** (PM scope).

| Part | Local solver | ESP32 electrical integration after R1 | Firmware-visible behaviour | R1 verdict |
|---|---|---|---|---|
| **RGB LED** (WP154A4SUREQBFZGC, common cathode) | 3 fitted dice, per-channel currents, ratings | Each channel from a GPIO output through a resistor; the solved channel currents drive the 2D/3D colour (already generic in `sim.outcome`) | Output only: `digitalWrite` per channel → **8 on/off colours** | **Supported** (on/off). PWM mixing **blocked** (R4) |
| **Buzzer** (CEM-1205-IC, active) | PWL V–I curve, `sounding` 3–6 V | Recommended: low-side NPN switch from PSU 5 V. Directly on a GPIO it solves ≈ 3.07 V / 13.9 mA: sounds, but marginally (stated) | Output only: on/off. A bit-banged square wave shows only each 10 ms window's last state | **Supported** (on/off). `tone()` **blocked** (builder `pwm` refusal) |
| **NPN 2N3904** | Gummel–Poon DC (ngspice 1e-6 V) | GPIO → base resistor; emitter to GND; load from PSU | Output driver; as an inverter into an input it needs a pull-up to **3.3 V** (a 5 V pull-up is flagged by the new diagnostic) | **Supported** |
| **Relay** (SRD-05VDC-SL-C) | 70 Ω coil, hysteresis 3.75 / 0.5 V, separate contact circuit | Coil from PSU 5 V through a 2N3904 driven by a GPIO. A GPIO directly on the coil solves 2.67 V / 38 mA: **does not pull in** (correct) | Coil = output; a contact into an input needs an external pull-up to 3.3 V | **Supported**. No operate/release time, no inductive kick (stated). A self-interrupting coil → `no_steady_state` → the run ends with that reason (honest; see §8) |
| **PIR** (HC-SR501) | Discrete `powered` (VCC ≥ 4.5 V); 3.3 V output behind 1 kΩ when motion | VCC from PSU 5 V, GND common, OUT to an input (34/35/36/39 ideal) | **Input:** HIGH with motion, LOW without | **Supported** with the `control.params` mirror (motion toggled live). No retrigger/hold time (stated) |
| **LDR** (GL5528) | R(E) power law, `illuminance` live | Divider (with a fixed resistor) from a **3.3 V** source to an input | **Input, digital threshold only**, with the pad's real hold band (e.g. 10 kΩ to GND, LDR to 3.3 V: HIGH above ≈ 111 lx, LOW below ≈ 2.9 lx, held in between) | **Feasible, bounded**: digital threshold. `analogRead` **blocked** (ADC: QEMU SENS unimplemented) |
| **8×8 LED matrix** (1088AS) | 64 dice, `array` of currents | 16 lines from GPIO outputs through resistors; 20 output-capable pins exist (using strapping pins 0/2/5/12/15 for a full 16) | Output only. **Static patterns exact.** Multiplexed scanning: each edge is a fresh DC solve; the browser sees the last state per 10 ms window (no persistence of vision); each edge costs a 64-diode solve | **Measured, NOT enabled — stays local-only** (slice 6, 2026-10-08): the p99 per-event solve gate (2 ms) failed (static 5.9–8.1 ms, scanning 3.0–3.4 ms); scanning runs at ≈0.022× real time. Evidence `s11-evidence/r1-matrix-perf.md`. Scanned images **deferred** (edge timing, R4-class) |
| **Capacitor** | Time-stepped (backward Euler) | — | — | **Blocked** in ESP32 projects (no host time stepping; ESP32 transient is a V1 roadmap item) |
| Servo, I2C LCD, HC-SR04, DHT22 | Engine models only | — | — | **Blocked** (R4, R3, R2) — not in R1 |
| 555, potentiometer, Wi-Fi, other boards | — | — | — | **Deferred** (PM scope) |

---

## 3. Proposed architecture

### 3.1 Principle: no new physics, no new bridge frames

R1 adds **no** QEMU patch, bridge frame, runtime id, toolchain or dependency. Everything the parts
need already exists: the engine's part models (shared with the browser, ADR-008), the digital pad
contract (ADR-007), the mirror command path. R1 is a **capability release** plus **one additive
protocol field** plus **diagnostics**.

### 3.2 ESP32 support is declared once, enforced in three places, with one engine backstop

- **Catalog (single source of truth).** Seven parts drop `mcuRuntime: false`; the capacitor keeps
  it. The three existing guards (placement, browser Run, host prepare) read the same flag, so they
  stay consistent by construction.
- **Engine backstop (new).** The host additionally refuses any circuit whose `EngineSession`
  reports `timeDependent` (`engine/src/session.ts:329`), whatever the catalog says:
  `electrical_error {code: 'unsupported_component', reason: 'time_dependent'}`. A future catalog
  mistake can then never run a capacitor as an open circuit under a board.
- **Specific wording.** The palette note and Run error for the capacitor say *why* ("time-dependent
  parts are simulated only in circuits without an ESP32"), with EN/HE keys; the generic
  `part_needs_runtime` text is kept for anything else flagged later.
- *Not proposed:* a capability enum or a `/health` capability list. The deployment order (host
  before frontend, §10) makes runtime discovery unnecessary for R1; it can be added when phases
  start shipping independently (PM question Q4).

### 3.3 Changed contract: live part parameters in the mirror (ADR-010)

`tbi-lab.session/2` stays (no version bump). Additive change:

```
MirrorControl = { setpointVoltage?, currentLimit?, outputEnabled?, closed?,
                  params?: { [key: string]: number | boolean | string } }   // NEW
```

- **Validation at the host** (`validateCommand`): `params` is a plain object of **1–8 keys**, keys
  match `^[a-z][a-zA-Z0-9]{0,31}$`, values are finite numbers, booleans or strings ≤ 32 chars. The
  engine then accepts only the part's declared `liveParams` and its catalog range (`applyControl`);
  anything else → `mirror_failed` (the existing refusal path), never a silent no-op.
- **Ordering:** unchanged. A params mirror is an ordinary mirror: monotonic `projectRevision`,
  queued, applied at the next 1 ms tick in client order, followed by one solve and input injection.
- **Old clients** never send `params`; **new clients against an old host** get a 400 — avoided by
  the deployment order, and reported correctly (below).
- **Client error mapping (fix):** a 400 on a *command* (not on create) maps to `mirror_failed`
  (or `command_refused`), never to `session_create_failed` / "service not reachable".

### 3.4 GPIO pin and direction semantics (unchanged, restated)

- Outputs: 3.3 V behind 16.5 Ω (HIGH) / 17.68 Ω (LOW). Inputs: 66 MΩ leakage; V_IH 2.475 V,
  V_IL 0.825 V, hold in between; initial previous level 0. Internal pulls are **not** modelled (the
  host refuses firmware that uses them) → examples use external resistors.
- Input-only pads 34/35/36/39: ideal for PIR and LDR inputs. A drive attempt on them is forced to
  input with the existing `output_on_input_only_pad` warning.
- Strapping pins (0, 2, 5, 12, 15) are usable as GPIO in the simulator (the existing caveat); the
  matrix examples avoid GPIO12 (boot-voltage strap on real boards).
- The board is **not** a power source: 5 V and 3.3 V rails come from the lab PSU. A HIGH GPIO may
  serve as a weak 3.3 V reference for dividers (stated in examples).

### 3.5 New pad diagnostics (engine, informational only)

Two warnings, computed in `ratings.ts` from the solved operating point, **never changing a value**
(the §15.1 rule: physically valid but noteworthy):
1. **`gpio_input_overvoltage`:** an **input** pad's solved voltage above VDD + 0.3 V (3.6 V) or
   below −0.3 V (datasheet v5.3 Table 5-3, the specified input range).
2. **`gpio_output_overvoltage`:** an **output** pad forced beyond the same range by the external
   circuit (e.g. a 5 V pull-up lifting an output-HIGH pad above 3.6 V: current is pushed into the
   driver). *(Named `gpio_reverse_current` in the first draft; implemented as a pad-voltage check
   against the same datasheet range, which is what the datasheet specifies.)*

They apply to local and host runs alike (one engine). Exact values and the reading of the PDF:
§6.3 and `docs/sprints/s11-evidence/datasheets/FACTS.md`.

### 3.6 Electrical solver interaction

Unchanged mechanism: the host's `EngineSession` holds the parts; each pad event → `setPinMode` →
`solve()` (fixed point over discrete states) → inject changed input levels. The new parts change
only *what* is solved:
- **Stateless nonlinear** (RGB, NPN, buzzer, matrix): one Newton solve per event.
- **Discrete state** (relay, PIR): fixed point ≤ 32 passes; state persists across events.
- **Environment** (motion, illuminance): only through the params mirror, at a tick.
- **Time-dependent** (capacitor): refused (§3.2).

### 3.7 Input/output event ordering (unchanged, restated)

Within virtual time:
1. Firmware writes a pad → `G` frame → mode set, solve, `I` injections in the same reply, applied
   **before the next guest instruction** (zero elapsed virtual time).
2. Browser commands → applied at the next 1 ms tick boundary, in client order, then one solve and
   injection.
3. Publication to the browser every 10 ms of simulation time (aggregates).
Consequence: a PIR output change caused by a motion mirror is seen by firmware at the first
instruction after the tick at which the mirror applies; deterministic for a given command schedule.

### 3.8 ADC feasibility and constraints

**Not feasible in R1.** It needs a SENS/APB_SARADC model in QEMU, an analog bridge frame (pad
voltage → ADC code) and therefore a new runtime id, new fingerprints and a builder policy change.
The LDR is supported as a **digital threshold input**; the builder's `adc` refusal stays.
Recommendation: a separate approved phase (PM question Q2) if analog sensing is wanted in V1.

### 3.9 Unsupported operation handling

| Situation | Handling |
|---|---|
| Capacitor in an ESP32 project | Placement blocked (specific note); Run refused before sending; host refuses (catalog + engine backstop) |
| `analogRead`, `analogWrite`, `ledcWrite`, `tone()`, `dacWrite` | Builder refusal (unchanged) → the run is refused with the feature named |
| Internal pulls in firmware | Host refusal (unchanged) |
| A live param the part does not declare, or out of range | `mirror_failed` (session ends with that reason) |
| An over-voltage on a pad | Warning (new); the run continues |
| A circuit with no steady state (self-interrupting relay) | Run ends `electrical_error` with `no_steady_state` and the component named (existing) — message reviewed to be specific |
| New frontend on an old host | Host refusal `unsupported_component` (explicit, never wrong values); avoided by the deployment order |

### 3.10 Failure and cleanup semantics (unchanged)

Any solve failure fails the session closed (`Q`), removes its private directory and releases the
admission slot; a refused mirror fails the session with `mirror_failed`. No new failure paths are
introduced besides the engine backstop at prepare (same as the existing guard).

### 3.11 Determinism and reproducibility

- No QEMU, bridge or firmware change → the R1/R2/S8 fingerprints must reproduce **unchanged**
  (rerun, not re-baselined).
- The fixed point is deterministic (component order, bounded passes).
- **New:** a pinned Session Host event-stream hash for a part-model workload (RGB + NPN/relay +
  PIR/LDR inputs, driven by the TbiBanks firmware), so part models enter the release gate as
  ADR-007 requires. The stale runtime-id header in `gate.runtime.test.ts` is checked and corrected.
- `scripts/runtime-sync/engine-ab.ts`: the original eight types stay bit-identical; new allow-list
  entries only for the new ESP32 examples and for the new diagnostics.

### 3.12 Resource and session isolation

- **Unchanged:** admission (preview plan 1 session per user, host cap `min(cpus, 4)`, creation rate
  20/10 min, 30 min lifetime), QEMU unit limits (MemoryMax 384M, CPUQuota 100 %, TasksMax 80),
  Session Host limits (MemoryMax 512M, TasksMax 256), authorization (gate, run tickets), policy and
  keys.
- **Measured (new):** host solve time per pad event for the heaviest R1 circuits (matrix static and
  scanned, relay switching). **Stop condition** if p99 per-event solve exceeds the budget agreed with
  the PM (proposed 2 ms on the dev-lab host) — then the matrix stays local-only (Q3).
- **Not added in R1:** a per-solve wall budget or edge-rate limit (R3-class `edge_rate_exceeded`);
  proposed only if the measurement says so.

### 3.13 Schema compatibility

No schema change (`SCHEMA_VERSION` 3), no migration. Environment values are ordinary persisted
params. ESP32 projects holding the parts could so far exist only through import (refused at Run);
after R1 they run. The forward-compatibility debt (older builds reject Sprint 10 files) is
**unchanged** — R1 neither fixes nor worsens it.

### 3.14 Performance implications

- Browser: none beyond rendering already-supported outcome fields.
- Host: one Newton solve per pad event (as today), heavier per event for the matrix (16 nodes,
  64 diodes) and NPN/relay fixed points. Measured before the matrix is enabled (§3.12).
- Publication volume: unchanged cadence; the `electrical` payload grows with the parts' fields
  (matrix `array` of 64 currents) — measured, expected small.

### 3.15 Rollback and deployment validation

Mechanics as in PHASE-R1 §4/§8, updated to Sprint 10 tooling (`publish-runtime.sh`,
`rollback-runtime.sh` already exist):
1. Staging host (`tbi-s8-session-host`) → full runtime suite.
2. dev-lab host (restart `tbi-session-host` only; `tbi-build` untouched, builder bytes unchanged) →
   suite with `TBI_S8_INSTANCE=tbi` → the **current frontend `7da5c8b` keeps working**.
3. dev-lab frontend (`publish-frontend.sh`) → live checks.
4. Rollback order: frontend first (to `7da5c8b`), then host (to `80448f9`). Unchanged runtime id; no
   state to undo.

---

## 4. Files and modules expected to change

| Area | Files |
|---|---|
| Domain | `packages/domain/src/catalog.ts` (flags; capacitor reason), tests `packages/domain/tests/sprint4.test.ts` |
| Engine | `packages/engine/src/ratings.ts` (two pad diagnostics), `esp32Gpio.ts` (absolute-maximum constants), engine tests (`gpio-conflicts`, new `mcu-parts.test.ts` with pad attachments for every R1 part) |
| Host | `runtime/host/protocol.ts` (`MirrorControl.params`, validation), `runtime/host/session.ts` (engine backstop for time-dependent circuits), host tests (`models.test.ts`, protocol tests) |
| Runtime tests | new `runtime/tests/r1-parts.runtime.test.ts` (+ fixtures `runtime/tests/fixtures/r1-*.json`), gate extension (pinned part-model event hash) |
| App | `app/src/runtime/client.ts` / `controller.ts` (command 400 → `mirror_failed`), `app/src/ui/Palette.tsx` + i18n (capacitor reason), possibly `app/src/views/scene3d` relay/buzzer live state (3D shows LEDs today; relay blade and buzzer are 2D only — no change unless the PM asks) |
| App tests | `app/tests/parts-s10.test.ts`, `mcu-simulation.test.ts`, `runtime-client.test.ts`, `runtime-fixtures.test.ts`, e2e `app/e2e/s10-parts.spec.ts` (refusals → capacitor only), new e2e for ESP32 projects with the parts (mocked host) |
| Examples (optional, Q5) | new `app/src/examples/data/esp32-*.json` reusing the **input-echo/TbiBanks sketch text** (already a global system source: no build-service change) |
| Docs | this set; `SPRINT-11.md` record; scope §6.0a delivery table; `datasheets/FACTS.md` (ESP32 absolute maxima) |
| Deploy | none new (`publish-runtime.sh`, `rollback-runtime.sh`, `publish-frontend.sh`) |

**Not changed:** QEMU and its patches, `runtime/harness` bridge protocol, `runtime/builder`
(policy and bytes), `runtime/policy`, units, Caddy, oauth2-proxy, the project schema.

---

## 5. Questions for the PM

See the implementation plan §4 (Q1–Q7). **Answered 2026-10-08:** Q1 params mirror — yes;
Q2 LDR digital threshold only, ADC tracked as separate V1 work; Q3 static matrix patterns,
conditional on measured performance; Q5 two curated, tested ESP32 examples; Q6 pin warnings —
yes; Q7 one controlled deployment sequence after implementation and validation (not yet
authorised). Q4 (no `/health` capability field) is replaced by the compatibility matrix of §6.2.

---

## 6. PM conditions (2026-10-08) — binding design additions

### 6.1 Protocol safety for live-parameter commands

Every check is explicit: a refused command returns a named reason, never a silent no-op.

| Check | Where | Rejection |
|---|---|---|
| Session ownership | `SessionHost.get` (principal + session token, constant-time) — unchanged | 404 (indistinguishable from "no such session") |
| Structure: `params` is an object of 1–8 keys, key pattern, value is a finite number / boolean / string ≤ 32 chars | `validateCommand` | 400 `control.params` |
| Payload size: serialised `params` ≤ 512 bytes; command body ≤ 8 KiB (was 64 KiB; existing commands are < 300 B) | `validateCommand`, `http.ts` | 400 / 413 |
| Part identity: the component exists in the session's circuit | `submit` (existing) | 409 `unknown_component` |
| Allowed names: each key is a **live** parameter the component's catalog type declares; `params` only on part models, `closed` only on toggles, PSU keys only on the PSU | `submit` (new, from the shared domain rule `liveControlError`) | 409 `unsupported_control` |
| Type and range: the value's kind and the catalog's `min`/`max` (e.g. illuminance 1–10 000 lux; motion boolean) | `submit` and again in the engine's `applyControl` (same domain rule) | 409 `invalid_value` (new) / `mirror_failed` at apply |
| Frequency: at most `maxCommandsPerSecond` (default 50) commands per session per wall-clock second, on top of the existing per-principal request rate (600/min preview) | `submit` (new) | 409 `rate_limited` (new) |
| Ordering and revisions | `submit`, `apply` — unchanged | 409 `stale_revision`, `duplicate_revision`, `late`, `out_of_order`, `queue_full` |

**Browser side:** mirrors are **coalesced per component** while one is in flight (latest values,
latest revision; revision gaps are allowed by the protocol), so ordinary UI use never approaches the
limits. A command refused by the host's validator (400) is reported as `command_refused` and a
frequency rejection as `commands_rate_limited` — never as "the runtime service is not reachable".

**Backward compatibility:** the protocol string stays `tbi-lab.session/2`; all additions are
optional. Every message an older client sends is accepted unchanged (tested against recorded Sprint
10 client fixtures). The new rejection reasons are additive values of `CommandRejection`; an older
client treats any rejection as a failed mirror, as before.

### 6.2 Frontend–host compatibility matrix

| Frontend | Host | Status | Required behaviour | How it is tested |
|---|---|---|---|---|
| S10 `7da5c8b` | S10 `80448f9` | Current production of dev-lab | Unchanged | Existing live checks |
| S10 `7da5c8b` | **S11** | **Supported** (the transition state during deployment, and after a frontend-only rollback) | Everything S10 offers works identically: S10 never sends new parts or `params` | Contract test: S10 client fixtures and command shapes accepted by the S11 validator; real-QEMU replay of the recorded S10 session fixtures on the S11 host; staging rehearsal |
| **S11** | S10 `80448f9` | **Not a supported state** (avoided by order: host before frontend; on rollback, frontend before host) — must still fail **explicitly** | New parts → host refusal `unsupported_component` ("cannot be simulated yet"); a params mirror → 400 → `command_refused` (session stopped, project untouched); all S10 features keep working | Contract test against a frozen copy of the S10 validator (`runtime/host/tests/fixtures/protocol-s10.ts`, verbatim from `80448f9`); controller tests with recorded old-host answers; staging rehearsal |
| **S11** | **S11** | Target | Full R1 | All suites |

**Deployment** (slice 7, not yet authorised): staging host → full runtime suite → staging with the
S10 frontend → dev-lab host → existing live checks against the S10 frontend (still deployed) →
dev-lab frontend → full live checks. **Rollback:** frontend to `7da5c8b` first (S10 FE on S11 host:
supported), then host to `80448f9` (S10/S10). Both directions are rehearsed on staging before
dev-lab; the S11-FE/S10-host state is exercised there too, to prove its explicit failures.

### 6.3 Electrical integrity of warnings

- **Warnings never alter solver results.** Pin warnings are computed by `ratingWarnings()` from an
  already solved outcome (a pure function, in the browser, for local and host runs alike). Tests
  assert that the solved values are bit-identical with and without the warning pass, and that the
  outcome object is not mutated.
- **Two distinct categories, never mixed:**
  - *electrical risk warnings* (`RatingWarning`: over-current, contention, shorts, and the new
    `gpio_input_overvoltage`, `gpio_output_overvoltage`): the circuit is solved and the run continues;
    the values shown are the engine's; the warning says a real part would be stressed;
  - *unsupported simulation states* (refusals and session failures: `unsupported_component`,
    `unsupported_feature`, `no_steady_state`, `command_refused`, …): nothing is solved or the run
    stops; never presented as a warning.
- **Limits from the datasheet, not invented:** ESP32 Series Datasheet v5.3 (Espressif), Table 5-3
  "DC Characteristics (3.3 V, 25 °C)", PDF p. 52: V_IH max = VDD + 0.3 V = **3.6 V**, V_IL min =
  **−0.3 V** (the specified input voltage range). Table 5-1 "Absolute Maximum Ratings", p. 51:
  supply pins −0.3 … 3.6 V. Recorded in `docs/sprints/s11-evidence/datasheets/FACTS.md` with the
  file's SHA-256. (The PDF does not render its minus signs; the −0.3 V lower limit is inferred, with
  the reasoning recorded there. The 3.6 V upper limit, the one 5 V circuits hit, is unambiguous.)
  - `gpio_input_overvoltage`: an **input** pad's solved voltage above 3.6 V or below −0.3 V.
  - `gpio_output_overvoltage`: an **output** pad forced beyond its rail by the external circuit (an
    output-HIGH pad above 3.6 V, or an output-LOW pad below −0.3 V): current is pushed into the
    driver.
- **Tested on every trigger:** at Run (first solve), after a firmware GPIO change, and after a live
  parameter change, locally and on the host, with identical warnings.

### 6.4 Matrix performance — measurement before enabling

The 2 ms budget is a proposal to be **verified**, not assumed. Slice 6 enables the matrix in ESP32
projects only if all of these hold on the dev-lab host (the same machine: 4 cores ARM64, 4 GB):

| Metric | Method | Gate |
|---|---|---|
| Per-pad-event solve latency p50 / p95 / p99 / max | Real QEMU, a scanning test firmware (`TbiR1Scan`, built by the existing provisioning pipeline) and a static-pattern run; every host solve timed | p99 ≤ 2 ms (static and scanned) |
| Solve frequency | Solves per simulated second and per wall second | Recorded |
| CPU | Session Host process `cpuUsage` and the QEMU process (`/proc/<pid>/stat`), per wall second | Recorded; QEMU stays within its unit quota |
| Impact on other sessions | A second concurrent session (TbiBanks echo) with and without the scanning session: its simulation-time rate and solve latency | Rate degradation ≤ 20 %; no bridge stall > 100 ms |
| Admission | Both sessions admitted within the existing limits; a third refused as before | Unchanged |

If any gate fails, the matrix **stays local-only** (catalog flag kept), with the measurements
recorded, and the PM decides.

### 6.5 GPIO32/33 — documentation reconciled with runtime evidence

The scope document (§5, §7.2, §20, §21, §23.2, §24) and the Sprint 10 architecture record still
call GPIO32/33 outputs (blocker B6) an open pre-release item. **Evidence that it is closed:**
- `docs/runtime/R1-REPORT.md`: gates R1-A3 and R1-A4 "Met" (GPIO32/33 drive HIGH/LOW, read back,
  light an LED with the same current as bank 0, echo GPIO35);
- **re-verified 2026-10-08** on the deployed runtime id `33e35e4ac5e798d7`:
  `runtime/tests/banks.runtime.test.ts` **10/10 passed** (outputs 4/16/25/27/32/33 driven HIGH then
  LOW in firmware order; equal electrical result on both banks; two-way loops across banks);
- the board profile marks IO32/33 as ordinary `io` (`esp32DevkitcWroom32.ts:140-141`).

Correction: the **living** scope document is updated with a dated note (Sprint 11); the Sprint 10
records (closed, tagged) are **not** edited. The correction is recorded in `SPRINT-11.md`.
