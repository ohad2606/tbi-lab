# Sprint 12 — test matrix (Runtime v2: bridge v2, R2, R3)

**Status:** In use (2026-10-09; T-R3-5 corrected to the measured driver behaviour). Companion to [SPRINT-12-ARCHITECTURE.md](SPRINT-12-ARCHITECTURE.md).

**Levels:**
- **U**: unit, no QEMU (CI).
- **RT**: real QEMU runtime test (`runtime/tests`, local stack or staging).
- **E2E**: Playwright; local (CI) or opt-in real QEMU.
- **DEP**: against a deployed instance (staging; dev-lab only after Gate C approval).

"Oracle" means the expected value comes from the shared engine model, never from the code under
test.

## Protocol (bridge v2)

| Id | Level | Case | Expected |
|---|---|---|---|
| T-PROTO-1 | U | Parse `H tbi-bridge 2 <tick> <caps>` with known tokens and `-` | Capabilities parsed and sorted |
| T-PROTO-2 | U | `H` v1 on a v2 host | Accepted; capability set empty |
| T-PROTO-3 | U | `H` v3, unknown capability token, unsorted or duplicate tokens | `ProtocolError` (fail closed) |
| T-PROTO-4 | U | `F`, `B` (S/W/R/P) frames: valid and every malformed variant (pad ≥ 40, address > 0x7F, byte > 0xFF, bad bus) | Parsed or `ProtocolError` |
| T-PROTO-5 | U | Encoder: `J` with `vns` not later than the frame, pad/level out of range, spacing < 1 µs, > 512 pending | Encoder refuses (host never emits it) |
| T-PROTO-6 | U | `K`/`D` outside a `B` reply, or missing in a `B` reply | Encoder refuses |
| T-PROTO-7 | U | Ticket `requires: ["i2c"]` against `H` capabilities without `i2c` | Session ends `unsupported_feature` before the first instruction (`Q` in the `H` reply) |
| T-PROTO-8 | U | Ticket without `requires` (old build service) | Behaviour identical to Sprint 11 |
| T-PROTO-9 | RT | v2 host on **v1 QEMU**: full Sprint 11 runtime suite | All pass (no capabilities) |
| T-PROTO-10 | RT | v2 QEMU given a malformed `J` / `K` / `D` (test hook) | QEMU exit 3, session `protocol_error`, cleanup verified |
| T-PROTO-11 | RT | v1 host bundle on v2 QEMU | Refused at `H` (fail closed); documents why deploy order matters |
| T-PROTO-12 | RT | `X` cancels pending entries | Cancelled edges never observed by the firmware |

## Determinism and fingerprints

| Id | Level | Case | Expected |
|---|---|---|---|
| T-DET-1 | RT | **Continuity:** `gate.runtime.test.ts` pinned fingerprints (TbiGpioProof, 1 ms and 10 ms quanta) on each new runtime (0006, 0006–0007, 0006–0008) | Bit-identical to the v1 pins, or stop-and-explain (architecture §5.2) |
| T-DET-2 | RT | Continuity: `r1-determinism`, banks, timing, serial | Identical |
| T-DET-3 | RT | Firmware that never reads a pad receiving 512 scheduled `J` edges | Guest timeline fingerprint identical to the no-`J` run (the host-sync timer does not reshape scheduling) |
| T-DET-4 | RT | HC-SR04 at 3 distances × 10 runs | One trace hash per distance; pinned |
| T-DET-5 | RT | DHT22 at 3 (T, RH) points × 10 runs | One hash per point; pinned |
| T-DET-6 | RT | LCD init + text × 10 runs | One hash; pinned |
| T-DET-7 | RT | **R-MCU-1** on Runtime v2: 62 full + 30 stressed boot runs | Zero divergences |
| T-DET-8 | RT | Quantum independence with `J` (1 ms vs 10 ms tick) for HC-SR04 | Same fingerprint |

## R2: µs inputs, HC-SR04, DHT22 (electrical accuracy)

| Id | Level | Case | Expected (oracle) |
|---|---|---|---|
| T-R2-1 | U | Host HC-SR04 driver: trigger widths 5, 10, 20 µs | < 10 µs: no echo; otherwise two `J` at `hcsr04Echo` times |
| T-R2-2 | RT | `pulseIn` distance at 2 cm, 10 cm, 1 m, 4 m, at 20 °C and 35 °C | Firmware-reported µs equals the oracle width within 1 µs (one `pulseIn` loop granularity, measured and recorded) |
| T-R2-3 | RT | Out of range (1 cm, 5 m) | No echo; `pulseIn` times out (specified behaviour) |
| T-R2-4 | RT | Re-trigger inside 60 ms | Second trigger ignored |
| T-R2-5 | RT | Echo through a 1 k/2 k divider vs a direct 5 V connection | Divider: valid levels. Direct: the engine's absolute-maximum report on the pad |
| T-R2-6 | RT | Echo through a divider that leaves the pad between V_IL and V_IH | Level held per `interpretDigitalInput`; the distance read differs, as it would on real hardware; documented |
| T-R2-7 | RT | DHT22 frames at (−10 °C, 30 %), (21.5 °C, 55.2 %), (60 °C, 95 %) | Firmware decodes exactly the oracle values; checksum valid |
| T-R2-8 | RT | DHT22 with no pull-up, or the module unpowered | No valid response; firmware reports a read failure; no invented frame |
| T-R2-9 | RT | DHT22 read within 2 s of the previous read | No response (specified) |
| T-R2-10 | RT | Firmware drives DATA while a frame is pending | `X` issued; `pad_contention` reported if the solution shows contention |

## R3: I2C and LCD

| Id | Level | Case | Expected |
|---|---|---|---|
| T-R3-1 | RT | `Wire.begin(21,22)` → `F` frames for the SDA/SCL pads | Exactly those pads become `i2c0-sda`/`scl`, open-drain |
| T-R3-2 | RT | Peripheral-owned pads emit no `G`; idle lines solve as released | Solver shows the pull-up level |
| T-R3-3 | RT | Bus scan 0x01–0x7E with one LCD at 0x27 | Only 0x27 ACKs; **0x48 NACKs (no phantom TMP105)** |
| T-R3-4 | RT | Write, read, repeated START, 100-byte write | Correct phase order and bytes (probe P-2..P-7 promoted) |
| T-R3-5 | RT | Address NACK / data NACK | `endTransmission` returns 4 / 4 (core 3.3.12: the IDF driver reports both as `ESP_ERR_INVALID_STATE`; measured in the R3 probe) |
| T-R3-6 | RT | LCD init + "Hello" + `setCursor` + clear | Engine `hd44780` DDRAM equals the expected text |
| T-R3-7 | RT | Backlight bit on and off | Part result `backlight` follows |
| T-R3-8 | RT | Address jumpers 0x20 vs 0x27 | Device answers only at its configured address |
| T-R3-9 | RT | I2C1 bus (`Wire1`) on other pads | Works on bus 1, or is explicitly refused if the probe shows otherwise |
| T-R3-10 | RT | SDA/SCL swapped in the wiring | NACK + wiring diagnostic |
| T-R3-11 | RT | No pull-up anywhere (module without pull-ups, none external) | `i2c_no_pullup` diagnostic; NACK |
| T-R3-12 | RT | LCD unpowered or under-voltage | NACK; part shows unpowered |
| T-R3-13 | U/RT | Two LCDs at 0x27 on one bus | Session refused `i2c_address_conflict`, naming both |
| T-R3-14 | U | Build service with runtime capabilities `{i2c}` vs `{}` | `Wire` sketch → `requires:["i2c"]` vs `unsupported:["i2c"]` |
| T-R3-15 | U | Sketch with `INPUT_PULLUP` + `Wire` | Internal pulls still refused (D-4) |
| T-R3-16 | RT | MicroPython firmware unchanged | MicroPython smoke unchanged (I2C not exercised) |

## Security, isolation, quotas

| Id | Level | Case | Expected |
|---|---|---|---|
| T-SEC-1 | DEP | Env parameters out of range or malformed (distance −1, RH 101, NaN, strings) | 400; session unaffected |
| T-SEC-2 | RT | Firmware trigger flood (HC-SR04 retrigger loop at maximum rate) | `J` budget holds; `input_schedule_full` diagnostic if exceeded; host CPU bounded |
| T-SEC-3 | RT | Firmware I2C flood (tight `endTransmission` loop) | `i2c_rate_exceeded` diagnostic at the budget; host CPU bounded |
| T-SEC-4 | DEP | Foreign user commands and parameters to another user's session | 404 (ownership unchanged) |
| T-SEC-5 | DEP | `requires` ticket against a v1 runtime instance | Refused at `H` |
| T-SEC-6 | DEP | Quota: session and creation limits with the new parts | Unchanged 429/503 semantics |
| T-SEC-7 | RT | QEMU unit sandbox unchanged (containment suite) | `s8-containment` 9/9 |
| T-SEC-8 | DEP | Cleanup after each new-part session | No leftover unit or session directory |

## Regression (must stay green)

All of these on Runtime v2:
- full Sprint 8–11 runtime suites;
- `s8-gate`, `s8-policy`, `s8-qemu-tasks`, `s8-containment`;
- release gate, banks, GPIO tests;
- `s11-deployed` (R1 examples, command boundary, admission, refusals);
- the R1 browser e2e (`s11-real.spec.ts`);
- frontend unit and e2e CI;
- the live smoke scripts (3D, demo, controls, R1 live).

## Product / UI

| Id | Level | Case |
|---|---|---|
| T-UI-1..3 | U/E2E | HC-SR04 and DHT22 in the palette for ESP32 projects only with an R2 host; refused with a reason otherwise; EN/HE names and environment labels; RTL chrome with LTR values and units |
| T-UI-4..6 | E2E | Environment controls (distance, temperature, RH) editable while running and mirrored; ranges enforced in the UI |
| T-UI-7..10 | E2E | LCD renders host-reported text in 2D and 3D; backlight; address jumper parameter; HE UI does not alter LCD content |
| T-E2E-1/2 | E2E (real) | Distance alarm and thermo-hygrometer examples end to end |
| T-E2E-3/4 | E2E (real) | LCD example; S12 frontend on an S11 host refuses the new parts explicitly |

## Operations

| Id | Case | Expected |
|---|---|---|
| T-OPS-1 | `switch-runtime.sh staging v2` → suites → `switch-runtime.sh staging v1` → suites | Both directions pass; timings recorded |
| T-OPS-2 | Switch refused while a session is live | Refused with a clear message |
| T-OPS-3 | FU-11-1: staging system artifacts imported | `s8-deployed-policy` 7/7 on staging |
| T-OPS-4 | FU-11-2: publish scripts with an almost-full `/tmp` | Use the disk-backed directory; free-space check aborts cleanly when short |
| T-OPS-5 | Backups created before each switch and publish | Present and restorable |
