# Phase R1: the Session Host with the Sprint 10 engine, emulator unchanged (deployment plan)

**Status:** plan only (2026-10-06). **Not executed.** It needs:
1. the owner smoke of the Sprint 10 promotion to pass;
2. a separate PM approval for R1.

*Update 2026-10-08 (PM, Sprint 10 closure): R1 is the **Sprint 11 primary target** (enable the
currently local-only Sprint 10 components in ESP32 projects where technically appropriate). Part P
of Sprint 10 (runtime `80448f9`) already deployed the Session Host with the Sprint 10 engine, but
narrowly: only the LED cards; its guard still refuses every `mcuRuntime: false` part. What remains
of this plan is lifting that refusal part by part (with `control.params` for the LDR / PIR
environment inputs), under its own Sprint 11 approval.*

This is phase R3a of [R3-CAPABILITY-PLAN.md](R3-CAPABILITY-PLAN.md). R2 (microsecond inputs), R3
(I2C) and R4 (PWM/servo) are later phases, each with its own approval.

## 1. What R1 delivers

ESP32 projects can hold the Sprint 10 parts whose interaction with the MCU is **digital GPIO
only**. The Session Host solves them with the same engine the browser uses. QEMU, the bridge, the
builder policy and the runtime id do not change.

| Part | In an ESP32 project after R1 | Why it is honest with today's runtime |
|---|---|---|
| RGB LED (WP154A4SUREQBFZGC) | **supported**: on/off per channel from GPIO | DC operating point per GPIO level; no PWM |
| Photoresistor GL5528 (+ divider) | **supported as a digital input**; the light level is the simulated environment | The divider voltage reaches a GPIO as a logic level. `analogRead` (ADC) stays refused by the builder |
| Buzzer CEM-1205-IC (active) | **supported**: on/off from GPIO or through a transistor | The part's own oscillator; `tone()` is LEDC/PWM and stays refused |
| Relay SRD-05VDC | **supported** (driven through a transistor; a direct GPIO drive is flagged by the GPIO diagnostics) | Coil hysteresis is a discrete state solved at each operating point |
| 2N3904 | **supported** | Nonlinear DC model, already ngspice-validated |
| PIR HC-SR501 | **supported**: motion is the simulated environment; output to a GPIO input | A regulated output and a logic level. Motion changes need the mirror change in §3 |
| LED matrix 1088AS | **supported for static patterns** | See the limit in §7 |
| Capacitor | **still blocked** | The host solves DC at each GPIO event and never advances simulated time. An ESP32 run would show the capacitor as an open circuit, not as a transient. Needs a host time-stepping change (a later, separate item) |

**Still blocked (unchanged):**

| Part | Waits for |
|---|---|
| Servo SG90 | R4 (PWM) |
| I2C LCD | R3 (I2C) |
| HC-SR04, DHT22 | R2 (microsecond inputs) |
| Capacitor in ESP32 projects | Host time-stepping (not yet planned as a phase) |
| `analogRead`, `tone`/`analogWrite`, interrupts | Builder refusals, unchanged |

## 2. What changes

| Item | Change |
|---|---|
| `session-host.mjs` | **Changes.** Rebuilt from the R1 commit: the engine with the Sprint 10 part models, plus the mirror change in §3. Local build from `bd78d2e` today: `dc439429…` (178.6 kB) against the deployed `c4965cb2…` (123.8 kB) |
| `build-service.mjs` | **Not deployed.** A rebuild differs (`476bac9a…` against `31e0bc62…`) only because the builder imports the domain package and so bundles the new catalog data (about 280 added lines of catalog constants; no logic change). R1 keeps the deployed bytes, and `tbi-build` is not restarted |
| `build-job.mjs` | Unchanged; byte-identical on rebuild (`011f703c…`) |
| QEMU binary, runtime id | **Unchanged**: `538af3d7…f9df`, `33e35e4ac5e798d7` |
| Units, polkit, Caddy, oauth2-proxy, gate, policy, keys | Unchanged |
| Frontend | A new static release (same rollback-safe method as the Sprint 10 promotion), published **after** the host. See §4 |

**Service restarted:** `tbi-session-host.service` only, plus `tbi-s8-session-host.service` on
staging first. `caddy`, `oauth2-proxy`, `tbi-build` and `tbi-s8-build` are not restarted.

**Release layout.**
- `/srv/tbi-lab/services/<R1 sha>/` holds the new `session-host.mjs`, with `build-service.mjs` and
  `build-job.mjs` **copied byte for byte from `c31d62e`**, and a `MANIFEST.sha256` saying so.
- Then the atomic switch of `services/current`.
- This does not use `deploy/dev-lab/publish.sh`: it rebuilds all three bundles, switches the frontend
  and restarts both services. A small `publish-host.sh` (host-only, pre-built, hash-verified, like
  `publish-frontend.sh`) is part of the R1 work.

## 3. Code changes inside R1 (to be reviewed with the approval)

1. **Host mirror commands accept part live parameters.**
   - Today `runtime/host/protocol.ts` (`validateCommand`) accepts only the PSU fields and `closed`.
   - A change of the light level or of PIR motion during an ESP32 run is therefore rejected. The
     browser fails the session (`mirror_failed`): honest, but it makes the PIR example unusable.
   - Change: accept `control.params` as a bounded object: at most 8 keys; values finite numbers,
     booleans or short tokens.
   - The engine's `applyControl` already accepts only the part's declared `liveParams` and refuses
     anything else. Additive: old clients never send it.
2. **Domain catalog.** The seven parts in §1 lose `mcuRuntime: false`; the capacitor keeps it. That
   flag drives both the palette rule and the Run refusal, so they stay consistent.
3. **Tests:**
   - host unit tests for the new mirror shape (bounds, unknown key refused);
   - an R2-style runtime test per part family: GPIO drives the RGB LED, relay and transistor, and
     the PIR and LDR divider feed a GPIO input, against the engine as oracle;
   - browser tests for the palette in ESP32 projects (capacitor still disabled).

**Alternative**, if the PM wants R1 to have no host source change at all: leave
`protocol.ts` as it is, and the frontend locks environment fields while an ESP32 run is active (a
change applies at the next Run). The PIR dome click would then be inactive during ESP32 runs.
**Recommendation:** the mirror change in item 1.

## 4. Order of deployment (backward compatible at every step)

1. **Pre-build** the R1 commit; record the hashes of the host bundle and the frontend files.
2. **Staging** (`tbi-s8-*`, `/srv/tbi-lab/s8-staging`):
   - install the new `session-host.mjs` and restart `tbi-s8-session-host` only;
   - run the suite in §6 against staging (default instance).
3. **Dev-lab host:**
   - snapshot first (as for the promotion: unit start times, hashes, runtime id);
   - publish the host release and restart `tbi-session-host` only;
   - running ESP32 sessions end; sessions are ephemeral by design;
   - rerun §6 with `TBI_S8_INSTANCE=tbi`.
   - The **current frontend (`bd78d2e`) keeps working unchanged**: it never sends the new parts or
     the new mirror shape, and the eight original types are frozen in the engine (bit-identical DC
     results).
4. **Frontend:** publish the R1 frontend with `publish-frontend.sh`, then run the demo smoke and the
   Sprint 10 checks, extended with ESP32 runs of the new parts.
5. **Owner smoke.**

## 5. Migration and state impact

- **No data migration.** The project format and schema are unchanged.
- **Projects:**
  - Projects already saved with these parts in a local circuit gain nothing automatically.
  - Projects that hold an ESP32 and a gated part can exist only through import; today they are
    refused at Run (`mcu_component_unsupported`), and after R1 they run.
- **Builds and artifacts:** the build service is not restarted, the artifact store and build
  records are not touched, and earlier builds stay current (same runtime id).
- **Session host state** (`/var/lib/tbi-runtime/state`: admission and ownership): same format, same
  host code paths. Live sessions end at the restart; there is nothing to migrate.
- **Policy** (`policy.json`) and keys: unchanged. Admission and quotas are unchanged.

## 6. Validation to rerun

**Sprint 8 runtime acceptance, on staging and then on dev-lab** (`TBI_S8_INSTANCE=tbi`, fresh
principals):
- `r2-acceptance` and `r2-failures`;
- `s8-gate`, `s8-policy`, `s8-deployed-policy` (stops the host once, briefly: stale-health case);
- `s8-containment`, `s8-qemu-tasks`;
- `resources`. Also measure the host solve time per GPIO event for the heaviest new circuit (the
  matrix: 64 diodes, 16 nodes) and for relay switching. A long solve stalls the guest in wall
  time, not in virtual time.

**Determinism:** the R1/R2 fingerprints must reproduce unchanged (same runtime id, same firmware).
They are rerun to confirm this, not re-baselined.

**Frontend and demo:**
- the Sprint 9 demo smoke (47), including ESP32 Build → Run → Stop;
- the Sprint 10 checks (29), plus new ESP32 runs: blink an RGB channel; relay through a 2N3904; a
  PIR input echoed to serial; light level read as a digital input;
- served-file hashes; services unchanged except `tbi-session-host`.

## 7. Limits that stay after R1 (said in the product, not hidden)

- **Matrix multiplexing.** GPIO events reach the browser aggregated per publish window (final
  level and transition count), so a fast multiplexed scan shows the last state in each window, not
  persistence of vision. Static patterns are exact. A scanned display needs edge timing (R4-class
  capability A) and a visual-persistence decision.
- **No PWM brightness, no `tone()`, no ADC.** The builder refusals are unchanged.
- **Capacitor in ESP32 projects:** still blocked (§1).

## 8. Rollback

- **Frontend:** switch `dev-lab/current` back to `bd78d2e` (atomic, no restart).
- **Host:** switch `services/current` back to `c31d62e` and restart `tbi-session-host` only.
  Unchanged runtime id; no state to undo.
- **Staging:** restore `/srv/tbi-lab/s8-staging/session-host.mjs` (`c4965cb2…`) and restart
  `tbi-s8-session-host`.
- **Order:** the frontend first, then the host. An R1 frontend on the old host would offer parts
  the old engine refuses (`unsupported_component`: an explicit error, never a wrong result), so
  that combination is avoided.
- Both steps are verified by hash, as in the promotion.

## 9. Confirmation

R1 changes **no emulator binary and no runtime id**:
- QEMU `538af3d799e5bdeb5ead877b99b8a486190202af39e880ba0884ed31d2b1f9df`;
- runtime `33e35e4ac5e798d7`;
- no QEMU patch;
- the builder's bundle and policy keep their deployed bytes.

Only `session-host.mjs` and the static frontend change.
