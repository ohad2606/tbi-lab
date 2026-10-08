# Sprint 11 — R1 test matrix

**Status:** PROPOSED, with the [implementation plan](SPRINT-11-IMPLEMENTATION-PLAN.md).
Layers: **E** engine unit (`packages/engine/tests`) · **H** host unit (`runtime/host/tests`) ·
**Q** real QEMU runtime (`runtime/tests/*.runtime.test.ts`, TbiBanks firmware, local
`TBI_RUNTIME_HOME`; then staging and dev-lab) · **A** app unit (`app/tests`) · **B** browser e2e with a
mocked host (`app/e2e`) · **L** live dev-lab (after deployment, via the root relay).

**Oracle:** the same circuit solved locally by the engine for the same pad states. "Equal" means
≤ 1e-12 relative for currents and voltages, identical discrete states, identical warnings.

**Negative cases are marked ✗.** Every ✗ must fail explicitly with the named reason — never a
silent no-op or a plausible-looking value.

## 1. Contract and guards (Slice 0)

| ID | Layer | Case | Expected |
|---|---|---|---|
| T-C1 | H | Mirror with `params: {motion: true}` for a PIR | Accepted (202) |
| T-C2 ✗ | H | `params` empty object | 400 `control` |
| T-C3 ✗ | H | `params` with 9 keys | 400 `control.params` |
| T-C4 ✗ | H | Key not matching `^[a-z][a-zA-Z0-9]{0,31}$` | 400 |
| T-C5 ✗ | H | Value `NaN`, `Infinity`, object, array, string > 32 chars | 400 |
| T-C6 ✗ | H/Q | Valid shape, but key not in the part's `liveParams` (e.g. `resistance` on the LDR) | `mirror_failed`; session ends with that reason |
| T-C7 ✗ | H/Q | `illuminance` outside the catalog range (0, 20000 lux) | `mirror_failed` |
| T-C8 | H | A params mirror with stale / duplicate `projectRevision` | 409 `stale_revision` / `duplicate_revision` (unchanged rules) |
| T-C9 | A | A command 400 from the host | Session reported `mirror_failed` (not `session_create_failed` / "service not reachable") |
| T-X1 ✗ | H | Capacitor in the circuit, catalog flag present | `unsupported_component` (catalog guard) |
| T-X2 ✗ | E/H | Capacitor with the catalog flag removed in a test build | `unsupported_component`, reason `time_dependent` (engine backstop) |
| T-X3 ✗ | A/B | Capacitor in an ESP32 project: palette, drop, Run (EN and HE) | Disabled with the specific note; drop refused; Run refused before sending |

## 2. Pad diagnostics (Slice 0, if Q6 approved)

| ID | Layer | Case | Expected |
|---|---|---|---|
| T-D1 ✗ | E | Input pad held at 5 V through a divider | `gpio_input_overvoltage` (> 3.6 V) |
| T-D2 ✗ | E | Output-HIGH pad with a 1 kΩ pull-up to 5 V | `gpio_output_overvoltage` |
| T-D3 | E | Every existing example and fixture | No new warning (engine A/B: identical outcomes except the new diagnostic field where applicable) |
| T-D4 | E/Q | The same over-voltage circuit locally and on the host | Identical warnings |

## 3. Parts (Slices 1–6)

| ID | Layer | Part | Case | Expected |
|---|---|---|---|---|
| T-P1 | E | RGB | Pads attached; each channel through 220/100/100 Ω from GPIO4/16/27 | Currents equal the local solve |
| T-P2 | Q | RGB | TbiBanks setup sweep drives each channel HIGH then LOW | Host outcomes show each channel on in turn; values equal T-P1 |
| T-P3 ✗ | E | RGB | A channel straight from a GPIO (no resistor) | `gpio_source_current` and `forward_current` warnings; value still solved |
| T-P4 | B | RGB | Mocked host outcome with channel currents | 2D glow, 3D colour, Inspector currents match |
| T-P5 | E/Q | Buzzer | Directly on GPIO4 HIGH | ≈ 3.07 V, ≈ 13.9 mA, `sounding` true (value pinned) |
| T-P6 | E/Q | Buzzer | Low-side 2N3904 from PSU 5 V, base 1 kΩ from GPIO4 | Sounds when HIGH, silent when LOW; equal to local |
| T-P7 ✗ | Q (builder) | Buzzer | Sketch using `tone()` | Run refused, feature `pwm` named |
| T-P8 | Q | Buzzer | Bit-banged toggling at 1 kHz | Each published window shows its final state; transition count matches; no crash |
| T-P9 | E/Q | PIR | PSU 5 V → PIR → GPIO34, motion true | GPIO34 HIGH; TbiBanks echoes to GPIO4 (LED lit, current equal to local) |
| T-P10 | Q | PIR | Motion toggled mid-run by a params mirror | Firmware sees the change at the first instruction after the applying tick; deterministic across 3 runs |
| T-P11 ✗ | E/Q | PIR | VCC 3.3 V (below 4.5 V) | Unpowered; GPIO34 LOW |
| T-P12 ✗ | H/Q | PIR | Mirror `params: {motion: 'yes'}` (wrong type) | `mirror_failed` |
| T-P13 | B | PIR | Dome click during a mocked ESP32 run | Params mirror sent with the next revision |
| T-P14 | E/Q | NPN + relay | GPIO4 → 1 kΩ → 2N3904; coil from PSU 5 V | HIGH: saturation, coil ≈ 4.8 V, energized; LOW: cutoff, released; equal to local |
| T-P15 | Q | Relay | Repeated toggles from firmware | Armature state persists correctly across events (hysteresis); fixed-point passes ≤ 2 |
| T-P16 ✗ | E | Relay | Coil straight from a GPIO | 2.67 V / 38 mA, **not** energized (pull-in 3.75 V) |
| T-P17 | Q | Relay | NO contact into GPIO35 with a 10 kΩ pull-up to 3.3 V | Echo to GPIO33 follows the contact |
| T-P18 ✗ | E | Relay | The same contact pulled up to 5 V | `gpio_input_overvoltage` |
| T-P19 ✗ | Q | Relay | Self-interrupting coil (buzzer wiring) | Run ends `electrical_error` / `no_steady_state`, the relay named; specific EN/HE message |
| T-P20 | E | NPN | Collector inverter into GPIO35 with a 3.3 V pull-up | Logic inversion; region labels correct |
| T-P21 | E/Q | LDR | 3.3 V → LDR → GPIO35, 10 kΩ to GND; light above the HIGH threshold | GPIO35 HIGH; echo to GPIO33 |
| T-P22 | E/Q | LDR | Light below the LOW threshold | GPIO35 LOW |
| T-P23 | Q | LDR | Light inside the hold band | The previous level is held (initial 0) |
| T-P24 | Q | LDR | Illuminance mirror mid-run crossing a threshold | One input transition at the applying tick; deterministic |
| T-P25 ✗ | Q (builder) | LDR | Sketch using `analogRead` | Run refused, feature `adc` named |
| T-P26 | E/Q | Matrix | Static pattern: rows/columns from TbiBanks outputs through 220 Ω | Lit dots and per-dot currents equal local |
| T-P27 ✗ | E | Matrix | One row sinking 8 dots | `gpio_sink_current` warning |
| T-P28 | Q (local only) | Matrix | 1 kHz row scan sketch | Window shows last state; no crash; per-event solve time recorded |
| T-P29 | Q | Matrix | Two concurrent sessions, one scanning | Other session's bridge replies not stalled > 100 ms |
| T-P30 | B | Matrix | Mocked host outcome with `array` | 2D and 3D dots match |

## 4. Regression, determinism, isolation, performance (Slice 7)

| ID | Layer | Case | Expected |
|---|---|---|---|
| T-R1 | A/B | Full unit and e2e suites | Green; refusal tests updated to the capacitor only |
| T-R2 | E | Engine A/B (`scripts/runtime-sync/engine-ab.ts`) | Original eight types bit-identical; allow-listed diffs only |
| T-R3 | Q | R1/R2/S8 fingerprints (gate, banks, r2-acceptance, r2-led-bench) | Reproduce **unchanged** (no re-baseline) |
| T-R4 | Q | New part-model event-stream hash (R1 workload) | Pinned; identical over 3 runs |
| T-R5 | Q | `r2-failures`, `s8-policy`, `s8-deployed-policy`, `s8-containment`, `s8-qemu-tasks`, `resources` | Green on staging, then dev-lab (`TBI_S8_INSTANCE=tbi`) |
| T-I1 ✗ | Q | Second session for a preview user | Refused by admission (unchanged) |
| T-I2 | Q | Session cleanup after `mirror_failed` and `no_steady_state` | Private directory removed; slot released; no QEMU unit left |
| T-PF1 | Q | Per-event solve time: RGB, NPN/relay, matrix static and scanned | Recorded; matrix p99 ≤ agreed budget (Q3) |
| T-PF2 | Q | `electrical` event payload size with the matrix | Recorded; within the existing publish limits |

## 5. Live dev-lab (Slice 7, after deployment)

| ID | Case | Expected |
|---|---|---|
| T-L1 | Existing checks: 3D 7, demo 40, Sprint 9 smoke, input-echo 17, bench 17 | Unchanged results |
| T-L2 | Old frontend `7da5c8b` against the new host (between host and frontend deploys) | All existing checks green |
| T-L3 | New: ESP32 + RGB channel blink; PIR → relay via 2N3904; LDR digital input → LED | Pass on real QEMU through the gate |
| T-L4 ✗ | New: capacitor in an ESP32 project | Refused (palette and Run), EN and HE |
| T-L5 | `/health` | Runtime commit = the R1 host commit; runtime id unchanged |
| T-L6 | Services | Only `tbi-session-host` restarted; `tbi-build` start time and bytes unchanged |

## 6. Rollback rehearsal (staging, before dev-lab)

| ID | Case | Expected |
|---|---|---|
| T-B1 | Roll the staging host back to the Sprint 10 bundle | `/health` shows the old commit; existing suite green |
| T-B2 | Re-apply R1 on staging | Suite green again |

## 7. Status after slices 0–6 (2026-10-08)

Legend: ✓ implemented and passing · ◐ covered differently (stated) · ✗ not done (stated) ·
— not applicable after the slice decision. Files: `E` = `packages/engine/tests/`, `D` =
`packages/domain/tests/`, `H` = `runtime/host/tests/`, `Q` = `runtime/tests/*.runtime.test.ts`,
`A` = `app/tests/`, `B` = `app/e2e/`.

| ID | Status | Where |
|---|---|---|
| T-C1–T-C5 | ✓ | H `r1-contract` (structural bounds incl. nesting, NaN/Infinity/null, 33-char keys and strings, 9 keys, > 512 bytes) |
| T-C6 | ✓ (stricter than planned) | Refused **at submit** with 409 `unsupported_control` (H `r1-contract`, `r1-pir`), and again by the engine (E `r1-pads`) |
| T-C7 | ✓ (stricter than planned) | 409 `invalid_value` at submit (H `r1-ldr`, `r1-pir`); domain rule D `liveControl`; engine E `r1-pads` |
| T-C8 | ◐ | Revision ordering is the existing generic mirror path (H `lifecycle`, `protocol`); no params-specific duplicate test |
| T-C9 | ✓ | A `mcu-simulation` (`command_refused`, `commands_rate_limited`, `mirror_failed` detail; coalescing) |
| Rate limit, body bound, ownership (§6.1) | ✓ | H `r1-contract` (rate 409 `rate_limited`; 8 KiB → 413; another principal → 404), H `ownership` (existing) |
| Compatibility (§6.2) | ✓ (contract level) | H `r1-contract` against a frozen copy of the S10 validator (`fixtures/protocol-s10.ts`): every S10 message accepted unchanged; S10 refuses `params` with 400; real host-version combinations: staging rehearsal (slice 7) |
| T-X1 | ✓ | H `models` (catalog-driven refusal: capacitor and matrix) |
| T-X2 | ✓ | H `r1-contract` (flag removed in the test: refused, reason `time_dependent`) |
| T-X3 | ✓ / ◐ | Palette and reasons EN/HE: B `s10-parts`, `s11-r1`; Run refusal: A `parts-s10`; the drop refusal uses the same `placementBlock` (D `sprint4`), not re-tested in a browser |
| T-D1, T-D2 | ✓ | E `r1-pads` (input over/under, output forced above 3.6 V; named `gpio_output_overvoltage`) |
| T-D3 | ✓ | A `r1-warnings`: every ESP32 example, every pad-mode combination, no over-voltage warning; engine A/B 231 identical / 0 different vs runtime `80448f9` |
| T-D4 | ◐ | Warnings are computed in the browser from the outcome for local and host runs alike; host outcomes equal the engine (all host and QEMU tests), so warnings are identical by construction |
| Warnings never alter values | ✓ | E `r1-pads` (no mutation; equal to a solve without the warning pass) |
| Warnings on Run / GPIO change / live parameter | ✓ | E `r1-pads` (three tests) |
| T-P1–T-P4 RGB | ✓ | E `r1-rgb`, H `r1-rgb`, Q `r1-rgb`, B (palette); colour rendering from outcomes is the existing generic path |
| T-P5–T-P7 Buzzer | ✓ | E `r1-buzzer`, H `r1-buzzer`, Q `r1-buzzer`; `tone()` refusal on a built ELF (`s11-evidence/r1-feature-probes.md`) |
| T-P8 bit-banged buzzer | ✗ | No test firmware toggles the buzzer; the window-aggregation behaviour is the generic one (`gpio` events) |
| T-P9–T-P13 PIR | ✓ | E `r1-pir`, H `r1-pir`, Q `r1-pir`, A `mcu-simulation`, B `s11-r1` |
| T-P14–T-P20 NPN, relay | ✓ | E `r1-relay` (incl. no_steady_state), H `r1-relay`, Q `r1-relay` (closed loop through the contact) |
| T-P21–T-P25 LDR | ✓ | E `r1-ldr`, H `r1-ldr`, Q `r1-ldr`, B `s11-r1`; `analogRead` refusal on a built ELF |
| T-P26, T-P27 matrix static | ✓ | E `r1-matrix`, H `r1-matrix` (capability, flag lifted in that test only) |
| T-P28, T-P29 matrix load | ✓ | Q `r1-matrix-perf` (4 runs; `s11-evidence/r1-matrix-perf.md`) |
| T-P30 matrix e2e | — | Matrix not enabled |
| Examples | ✓ | A `examples`, `runtime-fixtures` (+ curated-source key), Q `r1-examples`, B `s11-r1` |
| T-R1 | see `SPRINT-11.md` Part C | Full local CI |
| T-R2 | ✓ | Engine A/B vs `80448f9`: 231 identical, 0 different |
| T-R3 | ✓ | Q `gate` 6/6 and `banks` 10/10 on runtime `33e35e4ac5e798d7`; the other local runtime suites in the regression run |
| T-R4 | ✓ | Q `r1-determinism` (both examples, live parameters at fixed simulation times, 3 runs each, one stream, pinned) |
| T-R5 | ◐ | Local suites (`r2-failures`, `resources`) in the regression; `s8-*` suites run against a deployed instance: staging rehearsal (slice 7) |
| T-I1, T-I2 | ◐ | Existing suites (H `failures`, `lifecycle`; Q `isolation`, `r2-failures`); admission unchanged |
| T-PF1 | ✓ | Q `r1-matrix-perf` (and the solve timings of the part tests) |
| T-PF2 | ✗ | `electrical` payload size with the matrix not measured (matrix not enabled) |
| T-L1–T-L6, T-B1–T-B2 | not yet | Slice 7 (deployment not authorised) |
