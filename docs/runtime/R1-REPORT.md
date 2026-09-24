# Runtime R1 — Classic ESP32 production baseline: report

Status: **implemented and verified locally; submitted for PM review.** R1 is not closed or
tagged, and nothing has been pushed. No R2 or Sprint 6 work was started.

| Item                 | Value                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| Branch / worktree    | `runtime-r1`, created from `sprint-5-complete` (`dce6a87`), worktree `../tbi-lab-r1` |
| Target               | Original ESP32 (Xtensa LX6), ESP32-DevKitC V4 with an ESP32-WROOM-32. No C3/S3 substitution |
| Runtime build        | `runtimeId 567e58e704a0e43e` = espressif/qemu `40edccac` + `runtime/qemu/patches/0001-0004` |
| Test host            | 1 vCPU aarch64 (Neoverse-N1), 3.8 GiB RAM, Ubuntu, Node 24                          |
| Evidence             | `docs/runtime/r1-evidence/*.json` (written by the runtime tests), `provision-clean-all.txt` |

## 1. Acceptance gates

| Gate   | Result | Evidence |
| ------ | ------ | -------- |
| R1-A1  | Met    | A clean clone plus an empty `TBI_RUNTIME_HOME` built with `provision.sh all` (§4). QEMU is fetched by commit and verified; the patches are hashed into `runtimeId`. The firmware is byte-identical across two builds, two repo paths and two runtime homes |
| R1-A2  | Met    | Arduino (5 sketches) and MicroPython v1.29.0 boot on the `esp32` machine (`banks`, `gate`, `serial`, `firmware` tests) |
| R1-A3  | Met    | `banks.runtime.test.ts`: outputs 4/16/25/27 (bank 0) and 32/33 (bank 1), inputs 34/35/36/39 (bank 1) and GPIO5 (bank 0, gate), all through the engine |
| R1-A4  | Met    | GPIO32/33 drive HIGH/LOW, read back, light an LED with the same current as bank 0 (to 1e-12), and echo GPIO35 |
| R1-A5  | Met    | No demo devices and no ignore-mask exist in the runtime. GPIO4/16/27 events are delivered, and GPIO4 closes the GPIO34 → GPIO4 loop |
| R1-A6  | Met    | `packages/domain/src/boards/esp32DevkitcWroom32.ts`: all 38 header positions, sourced (§5); 9 tests |
| R1-A7  | Met    | `electrical.runtime.test.ts`: every solve in the loop satisfies the approved pin equations to 1e-9 V |
| R1-A8  | Met    | Feedback is solved and injected at the pad event's simulation time; all 39 GPIO2 solves per gate run are off the 1 ms grid (§8) |
| R1-A9  | Met    | 64 gate runs (16 per configuration, including 16 under main-loop stress): exactly one result per configuration (§9) |
| R1-A10 | Met    | Hashes pinned in `runtime/tests/gate.runtime.test.ts` and listed in §9 |
| R1-A11 | Met    | §10; no cycle-accuracy claim is made |
| R1-A12 | Met    | Artifacts are 0444, content-addressed and verified before use. Each session gets a private 0700/0600 copy. NVS reports `BOOTS=1` in every session, sequential and concurrent (§12) |
| R1-A13 | Met    | Everything lives under `$TBI_RUNTIME_HOME` (default `~/.local/share/tbi-lab-runtime`). There is no `tbi-tools` or `/home/...` reference in `runtime/` |
| R1-A14 | Met    | `.github/` is unchanged. `npm test` does not include `runtime/tests`. CI gains only the static typecheck and lint of `runtime/` (no toolchain) |
| R1-A15 | Met    | Guest UART0 travels only in bridge `S` frames; QEMU diagnostics travel only on stderr. Tested both ways (§13) |
| R1-A16 | Met, with one open item | `runtime/qemu/README.md`. **The ESP32 ROM images carry no licence statement upstream** (§16) |
| R1-A17 | Met    | 15 failure tests. Each ends in a classified outcome, with no restart and the artifacts unchanged (§14) |
| R1-A18 | Met    | §15, measured on one host with one workload. No capacity claim |

## 2. QEMU baseline (R1.1)

- **Upstream:** https://github.com/espressif/qemu, tag `esp-develop-9.2.2-20260417` (Espressif's
  latest release), commit `40edccac415693c5130f91c01d84176ae6008566`, QEMU 9.2.2.
- **Why this commit:** it is the latest Espressif release, and it has the same QEMU base (9.2.2) as the
  Sprint 0/1 fork, so the Sprint 1 findings carry over. The branch head after it adds only
  ESP32-C6 work. No release jump.
- **What upstream lacks for the classic ESP32:** `hw/gpio/esp32_gpio.c` is a 108-line stub (only
  STRAP is readable), and IO_MUX/RTCIO are unimplemented devices.

**Patches** (`runtime/qemu/patches`, all TBI-authored, GPL-2.0-or-later):

| #    | Purpose                                                        | sha256 (prefix) | Size |
| ---- | -------------------------------------------------------------- | --------------- | ---- |
| 0001 | Sprint 1 fix: defer the `sleep=off` icount warp while a round-robin slice is in flight | `7fc84611` | +20 |
| 0002 | Sprint 1 fix: synchronous APP-CPU reset under icount           | `a29bf7bf`      | +17  |
| 0003 | Classic ESP32 GPIO register model: both banks, W1TS/W1TC, pad events, external input. Property-gated to the `esp32` machine | `ee3fa808` | +254 |
| 0004 | `tbi-bridge` device and `tbi-serial` chardev (synchronous protocol v1) | `e4a1a574` | +385 |

**Provenance.** 0003 was written from the ESP32 Technical Reference Manual and the ESP-IDF
`soc/gpio_reg.h` offsets. No code was taken from a159x36, lcgamboa/PICSimLab or Velxio (AGPL).
0001/0002 are the Sprint 1 TBI patches, and applied with at most a 9-line offset.

**The Sprint 1 fixes are still needed.** The unpatched baseline sometimes produced no guest
output at all under `-icount shift=3,sleep=off`: 1 run in 8 at `shift=3`, and 3 runs in 3 at
`shift=0`. Without `sleep=off` it always booted.

## 3. GPIO completeness (R1.2)

Model (patch 0003):
- A pad drives only while it is output-enabled and has an output driver. GPIO34–39 have no
  driver, and non-existent pads never drive.
- `GPIO_IN`/`IN1` return the pad's own level while it drives, and the applied external level
  otherwise.
- Every change of a pad's (drive, level) is published once, in ascending pad order, and
  answered synchronously by the host before the guest continues.

Results (`banks.runtime.test.ts`, TbiBanks, Arduino API only):

| Check | Result |
| ----- | ------ |
| Sweep order 4, 16, 27, 25, 32, 33, each LOW → HIGH → LOW | exact |
| `digitalRead` of each driven output (`RB<n>=1`) | 6/6 |
| GPIO36 via 10 k to 3V3 / GPIO39 via 10 k to GND | `IN36=1 IN39=0` |
| LED current per HIGH output (330 Ω + TLHR5400) | identical on both banks to 1e-12 A |
| VA → GPIO35 → firmware → GPIO33 → LED (bank 1 → bank 1) | injections [1, 0], outputs [1, 0], ECHO35 0/1/0 |
| VB → GPIO34 → firmware → GPIO4 (bank 1 → bank 0) | outputs [1, 0], ECHO34 0/1/0 |
| Input-only pads driving | never |

**GPIO4/16/27** (R1-A5) are ordinary pads. The Sprint 0 community demo devices and
`ignore-mask` do not exist in this runtime.

**Pads not offered to circuits.** The ROM or bootloader enables GPIO7–11 (SPI flash) through
the GPIO matrix, so the runtime reports them (`drive=1 level=0` at boot). The host never attaches
them, because the capability map gives them `simulatorSupport: none`. This is tested.

## 4. Provisioning (R1.4)

```sh
runtime/provision/provision.sh check && runtime/provision/provision.sh all
TBI_RUNTIME_HOME=<home> npm run test:runtime
```

Pins (`runtime/provision/versions.env`):
- the QEMU repository, tag and commit;
- arduino-cli 1.5.1, with its tarball sha256 pinned per architecture;
- arduino-esp32 3.3.12 (its archives are verified by `core install` against the index checksums);
- FQBN `esp32:esp32:esp32:FlashMode=dio`;
- MicroPython v1.29.0 (sha256 `e67ad601…`);
- firmware `SOURCE_DATE_EPOCH` 1767225600.

Clean run from a fresh clone into an empty home (`r1-evidence/provision-clean-all.txt`):

| Step | Wall time |
| ---- | --------- |
| QEMU: fetch + verify + patch | 11 s |
| QEMU: configure | 20 s |
| QEMU: build (`ninja`, 1 CPU) | 541 s |
| QEMU: install + notices | 134 s |
| arduino-cli + ESP32 core | 4 min 45 s |
| MicroPython | 1 s |
| 5 firmware images | 2 min 26 s |
| **Total** | **18 min 58 s** (user 10 min 54 s) |

**Reproducible firmware.** Three problems were found and fixed:
- the Arduino core embeds `__DATE__`/`__TIME__`, so `SOURCE_DATE_EPOCH` is now pinned;
- host paths appeared in debug strings, so they are now mapped with `-ffile-prefix-map`;
- DWARF `DW_AT_comp_dir` recorded the caller's working directory, so compiles now run from the
  fixed staging directory.

After these fixes, repeated builds, a different repo path and a different runtime home all
give byte-identical images. `runtime/firmware/artifacts.lock.json` pins them:

| Artifact | sha256 |
| -------- | ------ |
| TbiGpioProof | `5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af` |
| TbiBanks | `9ca3a5cea66e46a2b54f14f38e0b065f36bc8cf70398cc88fae421028930a03d` |
| TbiTiming | `2b6ab2fb7566f28c4d64241caa7c2496915625b6dc652bf342033bdc09afa151` |
| TbiNvs | `23881828bd850c3c5786f17125b0fd0fecfd60975daa2130ebbf8156646e989d` |
| TbiRestart | `a49d6ed8584b364f94d0af18e1e92313d15bb8babf6c228ca2084c31f78da54a` |
| micropython (4 MiB image) | `23b8b47fdab856b33c44eb5911852e86c96dfeac2f1d2033dba8ddb6c681b0a1` |

**Disk.**

| Scope | Size |
| ----- | ---- |
| Full provisioning home | 8.6 GB |
| of which: arduino data (toolchains for every ESP32 family) | 6.0 GB |
| of which: arduino download cache | 1.7 GB |
| of which: QEMU source tree | 204 MB |
| of which: QEMU build tree | 426 MB |
| of which: firmware build outputs | 130 MB |
| **Running sessions needs only:** the QEMU install | 39 MB |
| **Running sessions needs only:** artifacts | 45 MB |

**Prerequisites** are listed in `runtime/README.md`. `libslirp-dev` is required even though
slirp is unused, because the Espressif tree builds `net/slirp.c` unconditionally.

## 5. Capability map (R1.3)

`board.esp32_devkitc_wroom32` lists all **38 header positions** (J2 1–19, J3 1–19). Each entry
records:
- `headerLabel`, `gpio`, `exposed`, `digitalInput`, `digitalOutput`;
- `internalPull`, `role`, `strapping`, `simulatorSupport`;
- `reason` wherever support is limited or a caveat applies.

Sources:
- Espressif, *ESP32-DevKitC V4 User Guide*: header tables and notes [1]–[3] (fetched page
  sha256 `2829b992…`).
- Espressif, *ESP32 Series Datasheet* v5.3 (sha256 `a7917e6b…`): Table 3-1 strapping pins,
  §4.8.1 GPIO, the Appendix A IO_MUX table with note 2 (GPIO34–39), and §5.3 pull resistance.

All the approved rules hold and are tested:
- GPIO6–11 are flash;
- GPIO34/35/36/39 are input-only with no pulls;
- GPIO32/33 are output-capable;
- GPIO0/2/5/12/15 are strapping pins;
- GPIO1/3 are the console UART;
- GPIO4/16/27 are ordinary.

No capability is derived from a numeric range. Each row is explicit. Runtime-wide limits are in
`simulatorLimitations` (§17).

## 6. Electrical model regression (R1.9)

The approved Gate C pin model is promoted unchanged into `packages/engine/src/esp32Gpio.ts`
(`PROVENANCE.md`). In the gate circuit (GPIO2 → 220 Ω → LED; GPIO2 → 10 k → GPIO5 ← 10 k ← VEXT):

| Case | Check |
| ---- | ----- |
| HIGH driving R + LED | `3.3 − 16.5·I_pin = V_io2` to 1e-9 V; I_LED 5.74 mA |
| LOW | `17.679·I_in = V_io2` to 1e-9 V; LED off |
| External HIGH | io5 > V_IH (2.475 V) → `gpio5<=1` |
| External LOW | io5 < V_IL (0.825 V) → `gpio5<=0` |
| Hysteresis | io5 ≈ 1.60 V (inside the band) → level held, no injection |
| Two-way feedback | every firmware `IN=` line equals the last injected level; both 0 and 1 occur |
| Both banks | §3 (LED currents identical across banks; bank-1 inputs) |
| Supply | PSU stays CV; current < 100 mA limit |

## 7. Firmware coverage (R1.8)

- **Arduino** (core 3.3.12, arduino-cli 1.5.1): `pinMode`, `digitalWrite` and `digitalRead` on
  both banks, plus `delay`, `millis`, `esp_timer`, hardware timers, Preferences/NVS and
  `esp_restart`.
- **MicroPython** v1.29.0 over the bridge's serial input: REPL, `Pin(32, OUT)`, and
  `Pin(35, IN).value()` driven by the circuit (`IN35 1`) echoed to `Pin(25)` (3.295 V into 10 k).
- **DIO is still required.** TbiGpioProof built with `FlashMode=qio` fails on this runtime with
  `qio_mode: Failed to set QIE bit` followed by
  `assert failed: __esp_system_init_fn_init_flash … (flash_ret == ESP_OK)`. This is the same
  class of failure Sprint 0 found.

## 8. Synchronous, event-driven loop (R1-A8)

- Every G frame is solved and answered, with its injections, before the guest continues, at the
  pad event's own simulation time.
- In the 1 ms gate run, all 39 GPIO2 solves fall between ticks (e.g. 377 099 816 ns), none on
  the 1 ms grid.
- Commands apply only at 1 ms tick boundaries (13.000 / 13.600 / 14.200 / 14.900 s).

## 9. Deterministic release gate (R1.6)

Workload: the Sprint 1 scenario (TbiGpioProof, VEXT 3.3/0/3.3/0 V at 13.0/13.6/14.2/14.9 s, end
at 15.5 s). The fingerprint covers pad events, full-precision solves, injections, commands, and
serial output with its simulation timestamps.

| Configuration | Runs | Distinct results | Timeline | Timed serial | Serial bytes |
| ------------- | ---- | ---------------- | -------- | ------------ | ------------ |
| 1 ms, full workload | 16 | **1** | `2fadf3ae624080b1` | `1a8db052c6c4fa4a` | `45b7ded872c2e393` |
| 1 ms, full workload, QMP main-loop stress (1 query/ms) | 16 | **1** | `2fadf3ae624080b1` | `1a8db052c6c4fa4a` | `45b7ded872c2e393` |
| 10 ms, full workload | 16 | **1** | `12efd464dbe6bb3a` | `39d81de4911e98b9` | `45b7ded872c2e393` |
| 1 ms, boot window 0–3 s | 16 | **1** | `b64f0bd3e94c22c4` | `4dc46111f588e958` | `9874f2e574af4adb` |

How the baseline was established:
- 12 exploratory runs (3 per configuration), then 40 runs (10 per configuration). All were
  unpinned, and each configuration converged to a single result.
- The hashes were then pinned, and a confirmation run (3 per configuration) matched them.
- Additional runs reproduced the 1 ms timeline in each full-suite run. The isolation test does
  1 solo run, then 2 runs concurrently with 2 NVS sessions on 1 vCPU (39 s wall each, against
  11 s solo); all 3 equal the pinned timeline.
- Divergences: **0**.

Per 1 ms run:
- 83 pad events (39 on GPIO2, 39 on GPIO18, 5 on flash pads);
- 44 solves (1 initial, 39 GPIO2, 4 commands);
- 5 injections, 4 commands, 15 500 ticks, 431 serial frames.

## 10. Timing (R1.7)

The runtime is deterministic, not cycle-accurate. At `-icount shift=3` each guest instruction
costs 8 ns of simulation time, which is 125 M instructions per simulated second.

| Measurement (1 ms tick) | R1 | Sprint 1 | Real-chip expectation |
| ----------------------- | -- | -------- | --------------------- |
| `delay(1000)`, bridge markers | 1000.297 ms | 999.902 ms | ≈1000 ms |
| `delay(1000)`, firmware view | `millis` 1000, `micros` 1 000 299, 240.07 M cycles | 1000 / 999 904 / 239.98 M | 1000 / ≈1 000 000 / 240 M |
| 100 ms hardware-timer alarm, 1 s window | 9 ticks (window 999.985 ms; the 10th lands just after) | 9 | 9–10, depending on phase |
| 1 M-iteration busy loop | 48.803 ms, 11.71 cycles/iteration | 48.803 ms, 11.7 | not measured on silicon; estimated ~1.9× faster (instruction-bound code runs at a fixed 125 MIPS here) |
| Boot to `setup()` | 376.8 ms (`millis` 39) | 379 ms (`millis` 41) | not measured |

The peripheral clocks (`millis`, `esp_timer`, CCOUNT, hardware timers) agree with simulation time
to within 0.03 %. No correction constant is applied.

## 11. Serial (R1.10)

- **Output.** The `tbi-serial` chardev turns every UART0 byte into an `S <vns> <hex>` frame, in
  the same ordered stream as pad events.
- **Input.** Host input is sent as `R <hex>`, only in tick replies, and delivered at the next
  instruction boundary.
- **No stdout or pty parsing.** Guest bytes never reach stderr, and QEMU diagnostics never enter
  the stream.
- **Bounds.** The host keeps 1 MiB of guest serial and 64 KiB of diagnostics; overflow is
  counted, not silently dropped. The runtime accepts at most 4096 pending RX bytes, and anything
  larger fails closed with exit 3.
- **Tests.** In the MicroPython REPL test, the `42` output leaves UART0 between GPIO32's HIGH and
  LOW events. Two runs give identical timed transcripts. The 64-byte host cap and the 5000-byte
  RX input both behave as specified.

## 12. Artifacts and isolation (R1.5)

- **Artifacts.** Artifacts are immutable: mode 0444, named by sha256, and verified against the
  lock before every session. A hash mismatch or missing file is refused before QEMU starts.
- **Sessions.** Each session gets a fresh `mkdtemp` directory (0700) with a 0600 copy of the
  image, and QEMU runs only on that copy. The directory is deleted at the end, which discards
  the guest's writes.
- **NVS.** Three sequential TbiNvs sessions each wrote their flash
  (`guestWroteFlash = true`) and each reported `TBI-NVS-BOOTS=1`. The artifact's sha256 was
  unchanged.
- **Concurrency.** Two NVS sessions and two gate sessions ran concurrently. The NVS sessions both
  reported `BOOTS=1`, and both gate timelines equalled the solo run bit for bit.
- **No cloud storage** is involved.

**Why this matters (observed).** The Sprint 1 reference image on this host
(`/home/ubuntu/tbi-tools/fw/arduino-gpio-proof-4mb.bin`, outside the repository) no longer
matches its pinned hash (`d069fffc…` → `9ac7f056…`, mtime 2026-09-23 08:04 UTC). An ELF core dump
was written into its coredump partition (0x3F0000) and otadata was written. Some earlier harness
attached the file to QEMU directly. R1 makes that impossible for the runtime. The file was left
untouched as evidence.

## 13. Failure modes (R1.13)

| Case | Outcome | Detail |
| ---- | ------- | ------ |
| Invalid firmware (erased flash) | `stalled` | ROM prints `invalid header: 0xffffffff`; simulation time then crawls (≈0.1 ms per wall second); host detects < 1 ms progress in 5 s |
| Artifact hash mismatch / missing | refused | `ArtifactError` before spawn |
| QEMU crash (SIGSEGV) | `crashed` | signal recorded, 1 boot only |
| Host bridge crash (connection drop) | `peer_lost` | QEMU exits 4: "host connection lost … (fail closed)" |
| Malformed reply | `protocol_error_runtime` | exit 3 "unexpected reply from host" |
| Invalid input command (pad 40) | `protocol_error_runtime` | exit 3 "malformed input command" |
| Malformed frames from runtime (bad pad, time backwards, bad version, binary garbage) | `protocol_error_host` | runtime killed; error recorded |
| Host stops answering | `timeout` | wall-clock limit |
| Host-command ordering error | `host_error` | "command … is in the past"; never reordered |
| Guest `esp_restart` | `guest_exit` | `-no-reboot`; one `rst:` line, one handshake. **Reset is unsupported and never silently repeated** |
| Missing binary / unreadable flash | `start_failed` | spawn error / QEMU `-drive` diagnostic |

In every case the artifacts are unchanged (tested), the evidence is kept in the result, and
nothing restarts.

## 14. Resources (R1.12): measurements, not capacity

One gate session (15.5 s simulated, 1 ms tick) on 1 vCPU (`r1-evidence/resources.json`):

| Metric | R1 | Sprint 1 |
| ------ | -- | -------- |
| Startup (spawn → bridge handshake) | 62 ms | — |
| QEMU RSS after boot (at 3 s simulated) | 70.3 MB | — |
| QEMU peak RSS (VmHWM) | 143.8 MB | 145 MB |
| Host (Node/vitest) peak RSS | 92.1 MB | — |
| QEMU CPU time | 8.64 s (0.557 CPU-s per simulated s) | 8.5 s |
| Wall time | 10.99 s (0.709 wall-s per simulated s) | 10.3 s |
| Shutdown (Q → exit) | 7 ms | — |
| Per-session overlay | 6.7 ms, 4 MiB | — |
| Wall under main-loop stress | 15.6–34.2 s (timeline identical) | — |

## 15. Deviations from the Sprint 1 baseline

1. **The runtime changed.**
   - The base moved from the a159x36 community fork to Espressif's maintained release.
   - GPIO is now a clean-room model.
   - The protocol is new: one combined (drive, level) event per change, where Sprint 1 sent
     separate `D`/`O` events. The initial solve is at the handshake, not the first tick.
   - Flash-pad events are now visible.
2. **Counts:** 90 events / 45 solves in Sprint 1, 83 / 44 now. The difference is fully explained
   by item 1 (§9). Injections (5) and commands (4) are identical.
3. **Hashes are not comparable.** The runtime, the event encoding and the firmware bytes all
   differ; the firmware is now reproducible, which Sprint 1's image was not. The Sprint 1 pins
   (`1382cd99…`, `b779e313…`, `c4d82896…`) are superseded for this runtime.
4. **Sprint 1 cannot be replayed bit-exactly on this host,** because its reference image was
   mutated (§12).
5. **Timing:** `delay(1000)` is 1000.297 ms (was 999.902). Boot to `setup()` is 376.8 ms (was
   379). The busy loop is unchanged (48.803 ms).
6. **The 10 ms tick shifts boot by ~109 ms** (first pad event at 486 ms, against 377 ms at 1 ms).
   Sprint 1 recorded the same effect (setup() at 468 ms with a 10 ms tick). See risk 1.

## 16. Licence notes (R1.11)

Full notes are in `runtime/qemu/README.md`.
- QEMU is GPL-2.0 and runs as a separate process. The patches are GPL-2.0-or-later. The install
  carries `LICENSE`, `COPYING` and the exact patches.
- The product talks to QEMU only over the line protocol.
- Distributing a runtime binary requires a source offer; the upstream commit plus these patches
  plus `provision.sh` is the full recipe. Server-only use is not distribution, but that should be
  confirmed by counsel before hosting.
- **Open item:** Espressif's ESP32 mask ROM images (`pc-bios/esp32-v3-rom*.bin`) have no stated
  licence upstream. TBI does not redistribute them.
- The toolchain (arduino-esp32, MicroPython) is used for test firmware only.

## 17. Risks

1. **The tick quantum affects guest timing (invariant 8).**
   - Under icount, QEMU switches between the two cores at virtual-timer deadlines. The command
     tick is such a deadline, so it also sets the core-interleaving granularity.
   - Each quantum is deterministic, but 1 ms and 10 ms give different timelines.
   - V1 fixes the quantum at 1 ms, so it is effectively part of the pinned configuration.
     Decoupling the core-switch quantum from the command tick would be R2 work.
2. **Pull-ups and pull-downs are not modelled** (IO_MUX/RTCIO are absent upstream).
   - `INPUT_PULLUP` on an unconnected pin reads the applied external level, not HIGH.
   - The product must refuse or flag this until it is modelled. PM decision needed.
3. **GPIO interrupts are not modelled.** `attachInterrupt` handlers never fire. Silent wrong
   behaviour unless the product detects and refuses it.
4. **GPIO-matrix and IO_MUX routing are not modelled.**
   - Peripheral outputs (LEDC/PWM, UART1/2, I2C, SPI) do not reach pads.
   - Input-enable is not honoured.
   - This is consistent with the R1 exclusions, but it must stay explicit in the product.
5. **Invalid or hung firmware** freezes or crawls virtual time. It is detected by a progress
   heuristic (< 1 ms of simulation time per 10 s wall), not by a watchdog model.
6. **Sub-word GPIO register accesses** are treated as whole-word. ESP-IDF and Arduino use only
   32-bit accesses.
7. **Strapping pins** are not sampled from the circuit. The chip always boots from flash.
8. **Toolchain footprint:** 8.6 GB to provision, most of it Arduino toolchains for every ESP32
   family. A 1-CPU build takes about 19 minutes.
9. **Single measurement host (1 vCPU):** no concurrency or throughput figure should be derived
   from these numbers.

## 18. PM / architecture decision items

These do not block R1:
- **Pulls and GPIO interrupts** (risks 2 and 3): model them in a later runtime step, or refuse
  them in the product.
- **Tick quantum vs invariant 8** (risk 1): accept the 1 ms quantum as part of the pinned runtime
  configuration, or schedule the decoupling.
- **ESP32 ROM image licence terms**, before any distribution of a runtime image.
- **Sprint 1 reference image** on the dev host has been mutated (§12). The Sprint 1 fingerprints
  remain documented, but can no longer be re-verified from that file.

## 19. Test counts

| Suite | Count | Result |
| ----- | ----- | ------ |
| Runtime (`npm run test:runtime`, 9 files) | 55 | pass (pinned) |
| Unit (`npm test`) | 374 (Sprint 5: 365; +9 capability map) | pass |
| App browser acceptance (`npm run test:e2e`) | 67 | pass |
| Sprint 0 browser (`npm run test:browser`) | 4 | pass |
| Typecheck, lint, Prettier, boundary check (now including `runtime/`) | — | pass |

## 20. PM decisions on the R1 review (2026-09-24)

The review of `1e7d8a5` approved R1 for push, not for closure. There is one closure blocker.

**Internal pull-up / pull-down.** The hardware supports them (capability map `internalPull`), but
the V1 simulator does not model them and must not advertise them as supported.
`INPUT_PULLUP`, `INPUT_PULLDOWN` or an equivalent configuration must never silently behave as a
plain input. The product/runtime contract must return an explicit unsupported-feature diagnostic.
Plain digital input polling stays supported.

**GPIO interrupts.** They are not in the supported V1 MCU subset. `attachInterrupt` or equivalent
must not run silently with handlers that never fire; integration must diagnose it explicitly.
Polling with `digitalRead` is the supported path. Interrupts are not to be implemented just to
close R1.

**Host command quantum — R1 closure blocker.** Production stays pinned at
`hostCommandQuantum = 1 ms` of simulated time. The observation in risk 1 (§17) conflicts with the
invariant that the command quantum is not an MCU execution timestep, and it is **not** accepted as
documented behaviour. A targeted follow-up must decouple host-command scheduling from guest
execution and core scheduling. Acceptance:
- with identical firmware and no host commands whose timing differs, changing the quantum must
  not materially alter the guest execution timeline;
- pad events and electrical feedback stay event-driven and synchronous, never quantised to 1 ms;
- the release gate stays single-result under stress;
- timing stays within the accepted non-cycle-accurate envelope;
- tested at 1 ms and 10 ms at least.

If decoupling needs a materially different QEMU scheduling design, work stops for a PM report
before any broad rewrite.

**ESP32 ROM images.** Development continues with upstream-fetched ROM images. ROM binaries are not
committed and not redistributed inside any runtime or container artifact; provisioning keeps
obtaining them from the authoritative source (Espressif's repository at the pinned commit). ROM
licensing is a packaging/deployment gate before any redistributable runtime or controlled pilot
image.

**Mutated Sprint 1 reference image — formal acknowledgement.**

| Item | Value |
| ---- | ----- |
| File (outside the repository) | `/home/ubuntu/tbi-tools/fw/arduino-gpio-proof-4mb.bin`, 4 194 304 bytes |
| Historical checksum (Sprint 1 pin, `experiments/sprint-1-spikes/closed-loop/closedLoop.ts`) | `d069fffc27f7d7246ff94120ed4b0d3bddb0b85228dee3d9fbb20ba1a20cdd44` |
| Current checksum | `9ac7f05630f7b56bca477e33a0b6373186625bf89927593b9725e88321888847` |
| Last modified | 2026-09-23 08:04:01 UTC, after the Sprint 1 work |
| Guest-written data | an ELF core dump (`\x7fELF` header) in the coredump partition, 0x3F0000–0x3F2C7F (11 187 non-erased bytes); otadata at 0xE000 written. NVS (0x9000–0xDFFF) is erased |

The file was modified by a guest crash dump after the original work, because a harness attached
it to QEMU directly. It was **not repaired, overwritten or deleted**. Sprint 1 therefore cannot be
replayed bit for bit from that file. Sprint 1 history and the `sprint-1-complete` tag are
unchanged. R1's immutable, content-addressed artifacts with per-session private copies (§12)
supersede that mechanism.
