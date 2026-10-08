# Sprint 11 — R1: the Sprint 10 parts in ESP32 projects

**Status (2026-10-08):** slices 0–6 **implemented** on `sprint-11` (worktree
`~/projects/tbi-lab-s11`), from `465b330` = `main` = `sprint-10-complete`; final CI green on
`aa782bc` (Part C). **dev-lab unchanged:** frontend `7da5c8b`, runtime `80448f9`. Deployment
(slice 7) **not** authorised; awaiting PM review.

Documents: [architecture](SPRINT-11-R1-ARCHITECTURE.md) (approved with conditions, §6) ·
[implementation plan](SPRINT-11-IMPLEMENTATION-PLAN.md) · [test matrix](SPRINT-11-TEST-MATRIX.md) ·
[ADR-010](../architecture/adr/ADR-010-esp32-part-support-and-live-part-parameters.md).

## Part A — architecture approved with conditions (PM, 2026-10-08)

Approved: bounded live-parameter commands (PIR, LDR); LDR digital threshold only (ADC tracked as
separate V1 work); static 8×8 matrix patterns conditional on measured performance; two curated,
tested ESP32 examples; ESP32 voltage and output-current warnings; one controlled deployment sequence
after implementation and validation. Mandatory conditions (architecture §6): matrix performance
measured (p50/p95/p99, CPU, solve frequency, impact on other sessions); protocol safety (identity,
names, ranges, payload size, ownership, frequency); a tested frontend–host compatibility matrix with
forward deployment and rollback; warnings that never alter results and stay distinct from
unsupported states; the GPIO32/33 documentation contradiction reconciled.

## Part B — GPIO32/33 documentation correction (2026-10-08)

The scope document still called GPIO32/33 outputs (blocker B6) an open pre-release item. Runtime
evidence says it is closed: `docs/runtime/R1-REPORT.md` gates R1-A3/R1-A4 "Met", and on 2026-10-08
`runtime/tests/banks.runtime.test.ts` passed **10/10** on the deployed runtime id
`33e35e4ac5e798d7` (GPIO32/33 driven HIGH and LOW in firmware order, the same electrical result as
bank 0, two-way loops across banks). The living scope document carries a dated correction; the
closed Sprint 10 records are left unchanged.

## Part C — slices 0–6 implemented (2026-10-08); deployment not authorised

Branch `sprint-11`, from `465b330`. **dev-lab untouched** (frontend `7da5c8b`, runtime `80448f9`).
Commits: `747a6df` (slice 0), `439bee0` (1 RGB), `19f878a` (2 buzzer), `f8d87ae` (3 PIR),
`32ddc20` (4 NPN + relay), `654a3ac` (5 photoresistor), `c1f198d` (6 matrix: measured, not
enabled), `b5f198b` (two curated examples), `aa782bc` (hardening: determinism gate, example
warning check, layout fixes).

### C.1 Capabilities after R1 (ESP32 projects)

| Part | ESP32 project | How the firmware sees it | Limits (stated in product and docs) |
|---|---|---|---|
| RGB LED | **Enabled** | Output: on/off per channel (8 colours) | No PWM mixing (`analogWrite`/`ledcWrite` refused) |
| Buzzer (active) | **Enabled** | Output: on/off | `tone()` refused (`pwm`, verified on a built ELF); straight from a pin it only just sounds (≈3.07 V) — use a transistor from 5 V |
| 2N3904 | **Enabled** | Driver or inverter | DC model only |
| Relay | **Enabled** | Coil via a transistor; contact into an input (external pull-up to 3.3 V) | No operate/release time, coil inductance or flyback spike; a self-interrupting coil ends the run (`no_steady_state`) |
| PIR | **Enabled** | Input: HIGH with motion (motion mirrored live) | No retrigger/hold time, no warm-up |
| Photoresistor | **Enabled** | Input: digital threshold with the pad's hold band (light mirrored live) | No ADC (`analogRead` refused, verified on a built ELF) |
| 8×8 matrix | **Not enabled (local-only)** | — | Measured: per-event solve p99 over the 2 ms gate; scanning runs at ≈0.022× real time (C.4) |
| Capacitor | **Refused** (catalog + engine backstop) | — | ESP32 transient integration is V1 roadmap |

New engine warnings (risk warnings, never values; distinct from unsupported states):
`gpio_input_overvoltage`, `gpio_output_overvoltage` (ESP32 datasheet v5.3 Table 5-3: −0.3 … 3.6 V).
New examples: **ESP32: motion alarm through a relay**, **ESP32: RGB night light with a light sensor**
(reuse the input-echo sketch: shared curated builds, no build-service change).

### C.2 Protocol and security validation (architecture §6.1)

`tbi-lab.session/2` unchanged; `control.params` additive. Checked when a command arrives:
structure (1–8 keys, key pattern, finite numbers / booleans / strings ≤ 32, ≤ 512 bytes) → 400;
part identity → 409 `unknown_component`; allowed names per type (catalog `live` params; PSU keys
only on the PSU, `closed` only on toggles) → 409 `unsupported_control`; kind and range → 409
`invalid_value`; ≤ 50 commands per session per second → 409 `rate_limited`; command body ≤ 8 KiB
→ 413; another principal's session → 404 (unchanged). The engine re-applies the same domain rule
at apply. Browser: mirrors coalesced per component while one is in flight; refusals reported as
`command_refused` / `commands_rate_limited` (EN/HE), never "runtime not reachable".
**Behaviour change (deliberate):** a control that does not exist for a part (e.g. `closed` on the
PSU) is now refused at submit (409) instead of being accepted and failing the session at apply;
the browser still stops the run on any refused mirror.

### C.3 Compatibility (architecture §6.2) — tested at contract level

| Frontend → host | Result |
|---|---|
| S10 → S11 | Every recorded S10 create request and every S10 command shape is accepted **unchanged** (tested against the S11 validator vs a frozen copy of the S10 validator) |
| S11 → S10 | `params` mirrors refused 400 `control` (→ `command_refused` in the browser, tested); new parts refused by the S10 host's catalog guard (`unsupported_component`) |
| S11 → S11 | All suites |
Real host-version combinations, forward deployment and rollback: staging rehearsal (C.7).

### C.4 Performance

- Matrix (4 runs; `s11-evidence/r1-matrix-perf.md`): static p99 5.9–8.1 ms; scanning p50 ≈0.5,
  p95 ≈1.7, p99 3.0–3.4, max 5.4–7.3 ms; ~9 870 solves per simulated second; ≈0.022× real time;
  a second session's rate halves beside ANY second session (idle or scanning: two QEMUs on this
  host), its tick gaps stay 10–15 ms. Decision: matrix local-only.
- Enabled parts: the same one-solve-per-pad-event path as before; real-QEMU part tests run at
  normal speed (8–14 s each including boot).
- Host bundle: `session-host.mjs` 182 938 B (deployed `80448f9`: 179 592 B).

### C.5 Test results

- Engine A/B vs the deployed engine `80448f9`: **231 identical, 0 different** (every example, pad
  mode, switch and button state, and the recorded session requests).
- Real QEMU (runtime `33e35e4ac5e798d7`, local): banks 10/10 (GPIO32/33), gate 6/6 (pinned
  fingerprints reproduce), r2-acceptance 5/5, r2-failures 11/11 (with the host bundle built),
  r2-led-bench, electrical, failures, isolation, quantum, serial, timing, resources, firmware,
  s7-build: pass; R1: rgb, buzzer, pir, relay, ldr, examples (2), matrix-perf, determinism (2,
  pinned): pass. The `s8-*` suites need a deployed instance: staging (C.7).
- Final app CI on `aa782bc`: see C.8.

### C.6 Findings recorded

1. **Firmware rebuilds are not byte-reproducible on this host** (already recorded in Sprint 7,
   `s7-reproducibility.json`): rebuilding gave new hashes for all five pinned test firmwares. Tests
   always use the pinned bytes by sha256; the provisioning step re-pointed the name links in the
   local test store, which were restored. The new `TbiR1Scan` is pinned as built.
2. The release-gate test header named runtime `979f09d739382157`; its pinned fingerprints
   reproduce unchanged on `33e35e4ac5e798d7` (6/6). Header corrected.
3. A relay with only its coil wired (COM unwired) is a floating circuit in the engine (existing
   behaviour, local and ESP32 alike; COM is not an optional terminal).
4. ESP32 pin levels in the Circuit view are shown for pads with reported changes (outputs); an
   input-only pad's level is visible through the firmware's response.

### C.7 Proposed staging deployment and rollback (for PM review; NOT executed)

1. **Freeze** the R1 commit; build the host bundle from a clean worktree (`publish-runtime.sh`
   path) and the frontend; record hashes.
2. **Staging host** (`tbi-s8-session-host`, `/srv/tbi-lab/s8-staging`): back up the current bundle,
   install the R1 bundle, restart `tbi-s8-session-host` only. Run against staging: `s8-gate`,
   `s8-policy`, `s8-deployed-policy`, `s8-containment`, `s8-qemu-tasks`, plus `r2-*` and the R1
   suites.
3. **Compatibility on staging, real hosts:** the S10 frontend (`7da5c8b` build) and the S11
   frontend against the R1 staging host (local preview with the runtime proxy, as `s6-real`);
   then the S11 frontend against the restored S10 staging host (explicit refusals expected).
4. **Rollback rehearsal on staging:** restore the S10 bundle, restart, `/health` commit check,
   suites; re-apply R1.
5. **dev-lab host:** `publish-runtime.sh <R1 sha>` (restarts `tbi-session-host` only; protocol
   `tbi-lab.session/2`; build-service bytes unchanged; auto-rollback on a failed check); run the
   existing live checks against the still-deployed S10 frontend.
6. **dev-lab frontend:** `publish-frontend.sh <R1 sha>`; existing live checks plus new R1 live
   checks (both examples on real QEMU through the gate: motion → relay/LED/buzzer; dark → white;
   capacitor refused EN/HE); `/health` = R1 commit, runtime id unchanged; only
   `tbi-session-host` restarted. Owner smoke.
7. **Rollback (dev-lab):** frontend first → `7da5c8b` (atomic re-point), then host → `80448f9`
   (`rollback-runtime.sh`, `tbi-session-host` only); verify `/version.json`, `/health`, existing
   live checks. No data migration to undo.

### C.8 Final CI

On `aa782bc` (clean tree), local: typecheck PASS, lint PASS, **unit 929/929** (112 files; was
867), build PASS, **e2e 169 passed / 3 skipped** (the usual opt-in real-QEMU specs; was 166),
legacy browser 4 passed. Plus the real-QEMU suites of C.5 and the engine A/B.

### C.9 Remaining risks

- **Deployment not yet rehearsed:** host/frontend version combinations and rollback are tested at
  contract level only until the staging rehearsal (C.7).
- **No per-solve wall budget** on the host: a dense circuit with many pad events slows its own
  session (the matrix stays local-only for this reason); a firmware edge-rate limit (R3-class
  `edge_rate_exceeded`) is not part of R1.
- **Two concurrent sessions halve each other's simulation rate** on this host (existing capacity
  characteristic, measured again here): relevant to the carried-forward capacity track.
- **Model limits that users may notice:** relay timing/flyback, PIR hold time, the photoresistor's
  wide hold band, the buzzer's marginal direct drive — stated in docs and examples, not modelled.
- **Firmware rebuild reproducibility** (C.6.1) affects re-pinning, not the product.
