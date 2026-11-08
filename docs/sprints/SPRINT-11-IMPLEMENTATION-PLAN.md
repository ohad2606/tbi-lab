# Sprint 11 — R1 implementation plan

**Status:** approved with conditions (PM, 2026-10-08). Slices 0–6 **implemented** (2026-10-08):

| Slice | Outcome | Commit |
|---|---|---|
| 0 Foundation | Done: bounded `params` mirrors with submit-time checks and rate limit, time-dependent backstop, pad over-voltage warnings, command error mapping, mirror coalescing | `747a6df` |
| 1 RGB LED | Enabled | `439bee0` |
| 2 Buzzer | Enabled; `tone()` / `analogRead()` refusals verified on built ELFs | `19f878a` |
| 3 PIR | Enabled (motion mirrored live) | `f8d87ae` |
| 4 NPN + relay | Enabled | `32ddc20` |
| 5 Photoresistor | Enabled (digital threshold; light mirrored live) | `654a3ac` |
| 6 8×8 matrix | **Measured; gates not met; stays local-only** | `c1f198d` |
| (7, examples part) | Two curated ESP32 examples (approved) | `b5f198b` |
| 7 Deployment | **Not authorised**; procedure proposed in `SPRINT-11.md` Part C | — |
**Architecture:** [SPRINT-11-R1-ARCHITECTURE.md](SPRINT-11-R1-ARCHITECTURE.md) ·
**Tests:** [SPRINT-11-TEST-MATRIX.md](SPRINT-11-TEST-MATRIX.md) ·
**Contract:** [ADR-010](../architecture/adr/ADR-010-esp32-part-support-and-live-part-parameters.md).

**Rules for every slice**
- Physics from the existing engine only; values identical to the same circuit run locally
  (one engine, two hosts — ADR-008). No QEMU, bridge, builder or toolchain change.
- A slice is **independently testable**: it removes `mcuRuntime: false` only for its own parts, so
  every guard (palette, Run, host) stays consistent at every commit.
- Each slice ends green on: typecheck, lint, unit, build, e2e (mocked host), and the slice's
  **local real-QEMU** runtime test (`TBI_RUNTIME_HOME=/home/ubuntu/tbi-s8-rt`, TbiBanks firmware:
  outputs 4/16/27/25/32/33, inputs 34/35/36/39, echoes 34→4 and 35→33).
- **No deployment until Slice 7.** dev-lab stays on `7da5c8b` / `80448f9` throughout.
- **Stop conditions** apply at any point: a value that differs between local and host runs for the
  same circuit and pad states; any change to the R1/R2/S8 fingerprints; a determinism failure; an
  isolation or quota regression. Stop, record, ask the PM.

---

## 1. Slices

### Slice 0 — Foundation (prerequisite for all)

| | |
|---|---|
| **Depends on** | PM approval (§4 Q1, Q6) |
| **Changes** | (a) Host engine backstop: refuse `EngineSession.timeDependent` circuits at prepare (`unsupported_component`, reason `time_dependent`). (b) `MirrorControl.params` + bounded validation (ADR-010). (c) Client: a command 400 → `mirror_failed`, not "service not reachable". (d) Pad diagnostics `gpio_input_overvoltage`, `gpio_output_overvoltage` (if Q6 = yes), with ESP32 absolute maxima added to `datasheets/FACTS.md`. (e) Test harnesses: engine `mcu-parts.test.ts` (pads + parts, local vs pads-attached equivalence); runtime `r1-parts.runtime.test.ts` skeleton + fixture pairing (`runtime-fixtures.test.ts`). (f) Gate check: confirm the `gate.runtime.test.ts` fingerprints against runtime `33e35e4ac5e798d7` (the header names `979f09d739382157`) and record the result |
| **Tests** | T-C1…T-C9, T-D1…T-D4, T-X1…T-X3 (test matrix) |
| **Acceptance** | All existing suites green and unchanged in value (engine A/B: original eight types bit-identical); the params validator refuses every malformed shape; the backstop refuses a capacitor even with the catalog flag removed in a test build; the stale message is gone |
| **Risks** | The diagnostics surface warnings in existing local examples (expected none: no example exceeds 3.6 V on a pad) → checked by the A/B run |
| **Stop if** | The gate fingerprints do not reproduce on the deployed runtime id (then the release gate itself needs attention before any R1 claim) |

### Slice 1 — RGB LED, digital GPIO

| | |
|---|---|
| **Depends on** | Slice 0 |
| **Changes** | Catalog flag removed for `component.rgb_led`. No engine change. Verify 2D glow, 3D colour (`rgbMix` from `sim.outcome`) and Inspector currents with host outcomes |
| **Tests** | T-P1…T-P4 (engine equivalence, host run with TbiBanks driving GPIO4/16/27 through 220/100/100 Ω, ratings warning on a resistor-less channel, 8 colours), e2e with a mocked host outcome |
| **Acceptance** | Per-channel currents from the host equal the local solve of the same circuit and pad states (≤ 1e-12 relative); colour follows channel currents; a direct (no-resistor) channel raises `gpio_source_current` and `forward_current` |
| **Risks** | Users expect PWM colour mixing → the product says "on/off per channel; PWM not simulated" (existing builder refusal names `pwm`) |
| **Stop if** | Any outcome field for the RGB LED is absent or differs between local and host |

### Slice 2 — Buzzer, digital on/off

| | |
|---|---|
| **Depends on** | Slice 0 (Slice 4 for the transistor-driven variant) |
| **Changes** | Flag removed for `component.buzzer`. Example guidance: low-side 2N3904 from PSU 5 V (the direct-GPIO case is marginal: ≈ 3.07 V, just above the 3.0 V sounding threshold) |
| **Tests** | T-P5…T-P8 (direct GPIO solve value and `sounding`; NPN-driven from 5 V; `tone()` sketch refused by the builder; bit-banged toggling shows window state only) |
| **Acceptance** | `sounding` and current equal the local solve; the sound option (`BuzzerSound.tsx`) reacts to host outcomes; `tone()` is refused with the `pwm` feature named |
| **Risks** | `tone()` refusal not covering every Arduino path → verify against a built ELF (symbol list) |
| **Stop if** | A `tone()` sketch is not refused (then PWM-based sound would be silently wrong) |

### Slice 3 — PIR, digital input

| | |
|---|---|
| **Depends on** | Slice 0 (params mirror) |
| **Changes** | Flag removed for `sensor.pir_hc_sr501`. The PIR dome toggle and Inspector `motion` control send params mirrors during ESP32 runs |
| **Tests** | T-P9…T-P13 (PSU 5 V → PIR → GPIO34; motion on/off mirrored mid-run → firmware echo 34→4 lights an LED; unpowered PIR (VCC < 4.5 V) reads LOW; params mirror ordering vs `projectRevision`; unknown param refused) |
| **Acceptance** | Firmware sees HIGH within the first instruction after the tick at which the motion mirror applies; the echo LED's current equals the local solve; deterministic across 3 repeated runs with the same command schedule |
| **Risks** | Users expecting the real 5–300 s hold time → stated limitation (no retrigger/hold model) |
| **Stop if** | A params mirror can change any non-live parameter, or ordering diverges from `projectRevision` |

### Slice 4 — NPN switching and relay

| | |
|---|---|
| **Depends on** | Slice 0 |
| **Changes** | Flags removed for `component.bjt_npn` and `component.relay` |
| **Tests** | T-P14…T-P20 (GPIO → 1 kΩ → 2N3904 → relay coil from PSU 5 V; pull-in/drop-out across firmware toggles; hysteresis state persists across events; direct GPIO on the coil does not pull in; contact into GPIO35 with a 3.3 V pull-up → echo to GPIO33; a 5 V pull-up raises `gpio_input_overvoltage`; self-interrupting coil → `no_steady_state` ends the run with a specific message) |
| **Acceptance** | Region (cutoff/saturation), coil current and armature state equal the local solve; fixed-point passes ≤ 2 in normal switching (measured) |
| **Risks** | Missing inductive kick and operate time look "too ideal" → stated; diode across the coil is inert at DC (stated) |
| **Stop if** | Relay state differs between local and host for the same event sequence |

### Slice 5 — LDR, digital threshold (ADC feasibility recorded)

| | |
|---|---|
| **Depends on** | Slice 0 (params mirror); PM answer Q2 |
| **Changes** | Flag removed for `component.photoresistor`. **No ADC.** Document the threshold band per divider; examples pick resistor values that cross V_IH/V_IL cleanly within the model range (1–100 lx where possible) |
| **Tests** | T-P21…T-P25 (divider into GPIO35: light above/below thresholds → echo GPIO33; hold band keeps the previous level; initial level 0; illuminance mirror mid-run; `analogRead` sketch refused with `adc` named) |
| **Acceptance** | Input level transitions occur exactly where the solved pad voltage crosses 2.475 V / 0.825 V; values equal the local solve |
| **Risks** | Users expect `analogRead` → explicit builder refusal plus product text "digital threshold only" |
| **Stop if** | Any path would expose an analog value to firmware (none exists; guard test) |

**ADC feasibility (recorded, not implemented):** needs a SENS/APB_SARADC model in QEMU, a new
analog bridge frame and a new runtime id with new fingerprints. Out of R1; separate phase on PM
request.

### Slice 6 — 8×8 matrix, static patterns (bounded)

| | |
|---|---|
| **Depends on** | Slices 0–1 (pad/LED path proven); PM answer Q3; **solve-cost measurement first** |
| **Changes** | Measurement on the dev host (and later staging): per-event solve time for the matrix, static and scanned (1 kHz row scan from a test sketch run locally only). If within budget: flag removed for `display.led_matrix_8x8`; product text "static patterns; multiplexed scanning is not shown as persistence of vision" |
| **Tests** | T-P26…T-P30 (static row × column pattern lit from TbiBanks outputs; per-dot currents equal local; one row sinking 8 dots raises `gpio_sink_current`; scanned sketch shows last state per window, no crash, wall-time stretch measured; strapping-pin note) |
| **Acceptance** | Static patterns exact; measured p99 per-event solve ≤ the agreed budget (proposed 2 ms); no other session's latency regression in the two-session test |
| **Risks** | Host event-loop contention between sessions; misleading scanned displays |
| **Stop if** | p99 per-event solve > budget, or a two-session run shows a bridge-reply stall > 100 ms → the matrix **stays local-only** in R1 and the finding goes to the PM |

### Slice 7 — End-to-end regression, hardening, deployment

| | |
|---|---|
| **Depends on** | Slices 0–6 (or the subset the PM keeps) |
| **Changes** | (a) Release-gate extension: pinned Session Host event-stream hash for the R1 part workload. (b) Optional curated examples (Q5) reusing the input-echo/TbiBanks sketch text (already a global system source: no build-service change; verified by source key). (c) Docs: `SPRINT-11.md` record, scope §6.0a table, limitations text EN/HE. (d) Deployment per PHASE-R1 §4 with the Sprint 10 tools: staging host → full runtime suite → dev-lab host (`publish-runtime.sh`, `tbi-session-host` only) → suite with `TBI_S8_INSTANCE=tbi` → frontend (`publish-frontend.sh`) → live checks → owner smoke |
| **Tests** | Full local CI; full runtime suite on staging and dev-lab (R1/R2/S8 fingerprints unchanged); engine A/B; live dev-lab checks (existing 3D 7, demo 40, S9 smoke, input-echo 17, bench 17) + new R1 live checks; rollback rehearsal on staging |
| **Acceptance** | §5 below |
| **Stop if** | Any fingerprint changes; any existing live check regresses; `tbi-build` restarts or its bytes change |

---

## 2. Dependencies

```
Slice 0 ──┬─ Slice 1 (RGB) ── Slice 6 (matrix, after measurement)
          ├─ Slice 2 (buzzer) ─ (transistor variant after Slice 4)
          ├─ Slice 3 (PIR)  [params mirror]
          ├─ Slice 4 (NPN + relay)
          └─ Slice 5 (LDR)  [params mirror]
Slices 0–6 ── Slice 7 (gate, examples, deploy)
```

## 3. Top risks and mitigation

| Risk | Mitigation |
|---|---|
| **5 V near the ESP32 shown as harmless** (PIR/relay/buzzer need the PSU's 5 V) | New pad diagnostics (Q6); examples use 3.3 V for anything that reaches a pad |
| **Host solve cost** (matrix, fixed points) delays other sessions on the shared event loop | Measure first; budget; matrix stop condition; no budget/limit mechanism added unless needed |
| **Live params widen the command surface** | Bounded validator; engine accepts only declared `liveParams` in range; unknown → `mirror_failed`; fuzz-style negative tests |
| **Frontend/host version skew** | Deployment order (host first), explicit refusals, rollback order (frontend first) |
| **Release gate stale or not covering part models** | Slice 0 gate check; Slice 7 part-model event hash |
| **Over-promising** (PWM colour, `tone()`, ADC, scanned matrix, PIR hold, relay timing) | Builder refusals unchanged; limitation text in product and docs; tests assert refusals |
| **Examples need build-service records** | Reuse the TbiBanks/input-echo sketch (global system source) or ship no new curated examples (Q5) |

## 4. Questions requiring PM decisions

1. **Q1 — Host source change.** Approve the additive `control.params` mirror (recommended), or the
   no-host-change alternative (environment controls locked during ESP32 runs; PIR/LDR inputs fixed
   at their values when Run starts)?
2. **Q2 — LDR.** Confirm **digital threshold only** in R1 (ADC stays refused). Should ADC become a
   separately planned V1 phase (QEMU SENS model + new runtime id)?
3. **Q3 — Matrix.** Approve "static patterns only, subject to the solve-cost budget" (proposed p99
   ≤ 2 ms per pad event), with "stays local-only" as the fallback?
4. **Q4 — Capability discovery.** Agree that no `/health` capability field is needed in R1
   (deployment order suffices)?
5. **Q5 — Examples.** Add curated ESP32 examples (e.g. PIR → relay via 2N3904; LDR → RGB channel)
   that reuse the existing input-echo/TbiBanks sketch, so the build service is not redeployed? Or no
   new curated examples in R1?
6. **Q6 — Pad diagnostics.** Approve the two new engine warnings (`gpio_input_overvoltage`,
   `gpio_output_overvoltage`)? They are warnings only, but they also appear in local circuits.
7. **Q7 — Deployment.** Approve one host deployment at the end (staging, then dev-lab
   `tbi-session-host` restart only) after Slice 7, with the frontend after it — rather than per slice?

**Also noted (documentation only, no decision needed unless the PM prefers):** the scope document
(§7.2, §20) and SPRINT-10-ARCHITECTURE still list GPIO32/33 outputs (blocker B6) as an open
pre-release item, while `docs/runtime/R1-REPORT.md` records it as met (R1-A3/A4). To be corrected in
the Sprint 11 record.

## 5. Acceptance and rollback criteria (sprint level)

**Acceptance**
- Every part the PM keeps in R1 runs in an ESP32 project with values equal to the same circuit
  solved locally for the same pad states, verified by engine, host and real-QEMU tests.
- The capacitor stays refused (catalog and engine backstop); `analogRead`, PWM, `tone()` stay
  refused.
- R1/R2/S8 fingerprints reproduce unchanged; the new part-model gate hash is pinned and stable
  across 3 runs.
- Runtime suite green on staging and dev-lab; existing live checks unchanged; new R1 live checks
  pass, including the real-QEMU echo through PIR/LDR inputs and NPN/relay outputs.
- No service other than `tbi-session-host` restarted; builder bytes unchanged; runtime id unchanged.
- EN/HE texts for every new message and limitation; owner smoke PASS.

**Rollback**
- Trigger: any acceptance item fails after deployment, or a regression in an existing live check.
- Order: frontend → `7da5c8b` (atomic link switch, no restart); then host → `80448f9`
  (`rollback-runtime.sh`, `tbi-session-host` only).
- Verification: served `/version.json` = `7da5c8b`; Session Host `/health` commit = `80448f9`;
  existing live checks green; no data migration to undo.
