# Sprint 12 — Runtime v2 architecture: bridge v2, R2 (µs inputs), R3 (ESP32 I2C)

**Status:** **PROPOSED, awaiting PM architecture review** (2026-10-09).
- Planning only. No QEMU patch is written, Bridge v2 is not implemented, and nothing is deployed.
- **Branch:** `sprint-12` (worktree `~/projects/tbi-lab-s12`), from `e54675b` (the head of
  `sprint-11`), because Runtime v2 builds on the R1 Session Host.
- Sprint 11 stays open until the owner's smoke acceptance. This branch neither merges nor alters
  `sprint-11`.

**Companion documents:**
- [ADR-011](../architecture/adr/ADR-011-runtime-bridge-v2.md) (Bridge v2);
- [SPRINT-12-IMPLEMENTATION-PLAN.md](SPRINT-12-IMPLEMENTATION-PLAN.md) (slices, durations,
  dependencies, critical path);
- [SPRINT-12-TEST-MATRIX.md](SPRINT-12-TEST-MATRIX.md);
- source capability design: [R3-CAPABILITY-PLAN.md](../runtime/R3-CAPABILITY-PLAN.md), capabilities
  B and C.

**PM authorization (2026-10-09).** Window 13–31 Oct 2026. Overall milestone: an external V1 alpha
for five invited testers by 30 Nov 2026, which is a planning target, not a commitment. Scope:
1. Bridge v2.
2. R2: µs timing, HC-SR04, DHT22.
3. R3: ESP32 I2C, Arduino `Wire`, I2C LCD.
4. FU-11-1.
5. FU-11-2.
6. The C-5 benchmark plan.

**Working rules (PM):**
- the electrical solver remains the single source of truth;
- no simulated hardware behaviour without a validated model;
- nothing unsupported may be supported silently;
- authorization, isolation and quotas are preserved;
- R4/PWM stays out of scope;
- production is not changed;
- no unapproved infrastructure spending;
- no QEMU patch before architecture review.

---

## 0. Git and deployment baseline (verified 2026-10-09)

| Item | Value | How verified |
|---|---|---|
| `sprint-12` (local only, not pushed) | Branched from `e54675b8134a139e2dea982e3e5ead35bbd52742` | `git worktree add -b sprint-12` |
| Remote `sprint-11` | `e54675b` (= local) | `git ls-remote` |
| Remote `main` / `sprint-10` | `465b330` (tag `sprint-10-complete`). The local `main` ref in the shared clone is a stale Sprint 3 pointer (`113b7f7`) and is not used | `git ls-remote`, `git tag --points-at` |
| dev-lab | Frontend and Session Host from `0487ce6` (Sprint 11 R1); QEMU runtime `33e35e4ac5e798d7` | Sprint 11 Gate C record (`SPRINT-11.md` Part D) |
| Staging `tbi-s8` | R1 host, same runtime id | Sprint 11 Gate B |
| Pinned QEMU | espressif/qemu `40edccac…` (`esp-develop-9.2.2-20260417`) + TBI patches 0001–0005 | `runtime/provision/versions.env`, `runtime/qemu/README.md` |
| Arduino core | arduino-esp32 **3.3.12** (`esp32:esp32:esp32:FlashMode=dio`) | `versions.env`, `runtime/builder/profiles/` |
| Host hardware | **1 vCPU** (Neoverse-N1, `nproc` = 1, online CPU list `0`), 3.9 GB RAM, up 18 days | `lscpu`, `/sys/devices/system/cpu/online`, `free -m` |

**Correction carried forward.** `docs/sprints/s11-evidence/r1-matrix-perf.md` labels the host
"4 cores", which is wrong. The machine has had one online CPU through the whole measurement period.
The measured numbers stand, and they are one-vCPU numbers. The label is corrected in the Sprint 12
record (slice S12-12), not silently.

---

## 1. Architecture audit (current repository)

| # | Finding | Evidence | Consequence for Sprint 12 |
|---|---|---|---|
| A-1 | Bridge v1 places external input edges only in replies to pad events or at 1 ms ticks | `0004` (`tbi_reply`: `I` applied immediately), `harness/protocol.ts` | R2 needs scheduled inputs (`J`), as ADR-011 §2 specifies |
| A-2 | The host accepts only `H … 1`; strict parser | `harness/session.ts:239` | A version bump fails closed on an old host, so deploy order matters (ADR-011 §6) |
| A-3 | 0003 stores `FUNCn_OUT_SEL`/`IN_SEL` but routes no peripheral signal; pulls, open-drain and IO_MUX are not modelled | 0003 header ("Not modelled: …") | R3 needs pad-function reporting (patch 0007). Internal pulls remain unmodelled (decision D-4) |
| A-4 | **The upstream machine hard-wires a TMP105 at 0x48 on I2C0, reporting 25 °C** | `hw/xtensa/esp32.c` `esp32_machine_init_i2c` (pinned tree) | Invented hardware. Today it is unreachable because the build service refuses `Wire`. **It must be removed before `Wire` is allowed** (patch 0008) |
| A-5 | The upstream I2C controller runs the whole command list instantly at `TRANS_START` against a QEMU-internal bus. It sets `ACK_ERR` only for the address byte, has no data-byte NACK, no TXFIFO_EMPTY/RXFIFO_FULL interrupts, no timeout, no arbitration and no bus-clear; it logs and returns `0xee` on an empty-FIFO read; FIFO 32, 16 commands | `hw/i2c/esp32_i2c.c` (283 lines) | Whether `Wire` works on it is the **R3 feasibility question** (§6) |
| A-6 | `Wire` in core 3.3.12 uses the **new IDF ≥ 5.4 `i2c_master` driver** (`esp32-hal-i2c-ng.c`): interrupt-driven, synchronous transfers, `i2c_master_probe` for empty transmissions, **`enable_internal_pullup = 1`**, glitch filter 7 | `cores/esp32/esp32-hal-i2c-ng.c:126–131, 261` | The driver is precompiled in the core's IDF libraries, so its register sequence is unknown until probed. It turns on internal pull-ups the runtime does not model (D-4) |
| A-7 | The build service refuses `i2c` (symbols `i2cInit`, `i2c_master_bus_add_device`, `i2c_driver_install`; library `Wire`) and internal pulls (sketch tokens only); only the `Preferences` library is supported; **the sketchbook is empty, so there are no third-party libraries** | `runtime/builder/features.ts`, `arduino.ts:124` | `Wire` must become capability-gated. `LiquidCrystal_I2C`, `DHT.h` and `NewPing` are not available (decision D-3). Library-internal `INPUT_PULLUP` (the Adafruit DHT library) would **not** be caught by the sketch-token scan, which is a gap to close before any library is admitted |
| A-8 | HC-SR04, DHT22 and the I2C LCD exist **only as engine models** (`packages/engine/src/peripherals/`). They are absent from the catalog, palette, 2D/schematic symbols, 3D scene, i18n and examples | `catalog.ts` type list; `grep` | R2 and R3 each include full product-side part work (the six-touchpoint pattern of R1: catalog, palette, `symbols.tsx`, schematic, `scene3d/scene.ts`, messages EN/HE) |
| A-9 | Engine models carry documented assumptions: HC-SR04 echo rises at the end of the 200 µs burst; DHT22 waveform starts at the sensor's 80 µs low; the **release-to-response delay (T_go) is not modelled**; out-of-range values give no echo or frame | `hcsr04.ts`, `dht22.ts` | T_go needs a datasheet-sourced value before R2 can be wired (S12-4, assumption A-R2-2) |
| A-10 | Input interpretation exists and is honest: `interpretDigitalInput` holds the previous level inside the band between V_IL and V_IH; pads have an absolute-maximum check | `engine/src/esp32Gpio.ts:40, 90` | Scheduled levels are derived through it (ADR-011 §2). A 5 V HC-SR04 echo into a pad hits the existing absolute-maximum check, so the example needs a divider |
| A-11 | `runtimeId` = sha256(upstream commit + each patch sha256), first 16 hex digits. Determinism fingerprints are pinned per runtime id in `gate.runtime.test.ts` and `r1-determinism.runtime.test.ts` | `provision.sh:36`, tests | Each patch set means a new id and a fingerprint migration (§5) |
| A-12 | Fingerprints have transferred across runtime ids **only for a rebuild of identical sources** (`979f09d7…` → `33e35e4a…`, Sprint 8). No precedent exists for a functional patch | `gate.runtime.test.ts:23–27` | Fingerprint continuity under 0006–0008 is a **hypothesis to test**, not an assumption (§5.2) |
| A-13 | The runtime is selected per instance by a bind mount (`BindReadOnlyPaths=@RUNTIME@:/opt/tbi-runtime`), rendered by `deploy/dev-lab/s8/install.sh` from `TBI_S8_RUNTIME`. `publish-runtime.sh` replaces host bundles only | `tbi-qemu@.service.in:19`, `install.sh:26` | A QEMU runtime switch is a unit re-render plus daemon-reload, with side-by-side runtime directories. It needs its own script and rollback (S12-10) |
| A-14 | Capacity: policy `runtime.maxLiveSessions: "cpus"` and `build.deferWhileLiveSessionsAtLeast: "cpus"`. On 1 vCPU, **one live ESP32 session globally, and builds wait while it runs**. Measured: one session ≈ 3.4–3.9× real time alone, ≈ 1.7–1.8× each with two concurrent | `policy.json:89–92`, `r1-matrix-perf.md` | Five concurrent testers cannot be served on this host. C-5 plan (§8) and decision D-1 |
| A-15 | Staging store lacks the R1 reference image `5f177cbe…` (FU-11-1); publish scripts use `mktemp -d` on the 2 GB `/tmp` tmpfs (FU-11-2) | `SPRINT-11.md` Part E | Small fixes, folded into release engineering (§7) |
| A-16 | The 8×8 matrix stays local-only (per-event solve cost, about 9 900 bridge round trips per simulated second) | `r1-matrix-perf.md` | Bounds R2 design: DHT22 and HC-SR04 must cost few round trips. One `J` batch per measurement achieves this (§3.2) |

---

## 2. Runtime v2: the shape of the change

```
browser ──(unchanged session/2 contract + new part types + env params, ADR-010)──► Session Host
Session Host ◄── Bridge v2 (ADR-011) ──► QEMU runtime v2
   │  H v2 + caps          ← negotiated per session; ticket `requires` checked here
   │  G / T / S            ← unchanged
   │  J / X  (sched-input) → HC-SR04 echo, DHT22 frame: one reply = whole response
   │  F      (pad-func)    ← pads owned by the I2C controller
   │  B / K / D (i2c)      ← one synchronous round trip per bus phase
   └─ engine (single electrical truth): solves, input thresholds, device models (hcsr04, dht22, i2c, hd44780)
build service: policy keyed by the runtime's capability set (runtime.json) → ticket.requires
```

**Unchanged:**
- QEMU process isolation, unit sandboxing and the private socket;
- admission, quotas, run tickets and ownership;
- the 1 ms command quantum;
- the session/2 browser contract (additive fields only);
- the publish window and event aggregation.

**Runtime v2** = upstream `40edccac` + 0001–0005 (unchanged) + **0006** (bridge v2: `H` v2, caps,
`J`/`X`) + **0007** (pad functions) + **0008** (I2C proxy, TMP105 removal, controller fixes).

**Patch numbering (request D-6).** The capability plan reserved 0006 for LEDC, 0007 for I2C and 0008
for scheduled input. Patches apply in order, so the numbering follows landing order and LEDC
becomes 0009 when R4 is approved.

**Partial-ship property.**
- 0006 is independently shippable, and is R2 alone.
- If R3 is a no-go, Runtime v2 ships 0001–0006, and 0007–0008 become a later runtime.
- Capability tokens let the host and build service follow whatever the deployed runtime actually
  advertises.

---

## 3. R2 — microsecond input timing, HC-SR04, DHT22

### 3.1 QEMU (patch 0006)

As specified in ADR-011 §1–2:
- `H tbi-bridge 2 <tick_ns> <caps>`;
- `J`/`X` with a per-process queue (cap 512, minimum 1 µs spacing per pad);
- one virtual timer with `QEMU_TIMER_ATTR_HOST_SYNC` (0005), so scheduled edges do not reshape core
  interleaving.

Estimated size: about 150 lines in `tbi_bridge.c`, plus about 5 in the timer attribute plumbing. It
reuses 0005 unchanged.

### 3.2 Session Host

**HC-SR04.**
- **Trigger.** A `G` frame on the TRIG pad; the TRIG net level comes from solving the circuit. The
  host tracks the rising and falling edges.
- **On the falling edge:**
  - `hcsr04Echo(triggerFallNs, widthUs, distance, temperature)` gives the echo rise and fall times;
  - the host solves the ECHO net for "module drives high" and "module drives low" (through the
    user's divider or wiring) and maps each to the pad's level with `interpretDigitalInput`;
  - it replies with two `J` commands.
- **One round trip per measurement.**
- **Re-trigger inside the 60 ms cycle:** no response, which is the part's specified behaviour and
  is documented.

**DHT22.**
- **Start signal.** Pad driven low for at least 1 ms, then released (`G` with drive=0).
- **The host:**
  - builds `dht22Frame(rh, t)` and then `dht22Waveform`;
  - offsets the waveform by T_go (assumption A-R2-2);
  - solves the DATA net for both sensor states, using the pull-up in the circuit or on the module;
  - replies with **83 `J` commands in one reply**.
- **Read interval.** The sensor answers at most once per 2 s; a request inside that window gets no
  response (specified behaviour).

**Environment.**
- Inputs: distance (HC-SR04), temperature and RH (DHT22), plus air temperature for the speed of
  sound.
- They are **live part parameters** on the ADR-010 mirror path, validated by the host's mirror
  validator, and apply at the next command tick.
- A change mid-measurement affects only the next measurement, which is documented.

**Limits enforced before QEMU sees them:**
- the queue cap;
- the 1 µs spacing;
- a per-session `J` budget per simulated second (`input_schedule_full` diagnostic, never a silent
  drop);
- contention handling (ADR-011 §2).

### 3.3 Physics, honesty and recorded assumptions

| Id | Item | Treatment |
|---|---|---|
| A-R2-1 | HC-SR04 echo rises at the end of the 8-cycle burst (200 µs) | Existing documented engine assumption; shown in the part's model notes |
| A-R2-2 | DHT22 T_go (release to the sensor's response) | Take the typical value from the Aosong AM2302 sheet's timing table and document it as an assumption. If the sheet gives only a range, the PM chooses (D-7) |
| A-R2-3 | Sensor accuracy (±2 %RH, ±0.5 °C) is not added; the model is exact and deterministic | Already documented in `dht22.ts`; repeated in-product as "ideal sensor" |
| A-R2-4 | Supply ranges: HC-SR04 at 5 V. A 5 V echo straight into a pad exceeds the absolute maximum | Engine absolute-maximum check reports it; the curated example uses a 1 k/2 k divider |
| A-R2-5 | `attachInterrupt`-based capture stays unsupported | Builder refusal unchanged; `pulseIn` and polling are supported |

### 3.4 Product side

**Two new catalog parts** (`sensor.hc_sr04`, `sensor.dht22`), each with:
- 2D, schematic and 3D representation;
- palette entry;
- i18n EN/HE;
- environment controls;
- an `mcuRuntime` flag (true only with an R2 host, enforced as in ADR-010).

**Two curated examples, written with no third-party libraries (D-3):**
- distance alarm (`pulseIn`);
- thermo-hygrometer (an explicit DHT22 read routine, about 40 lines in the sketch).

---

## 4. R3 — ESP32 I2C, Arduino `Wire`, I2C LCD

### 4.1 QEMU (patches 0007, 0008)

**Patch 0007: pad functions** (ADR-011 §3).
- `F` frames when `FUNCn_OUT_SEL`, `IN_SEL` or the open-drain bit changes for the I2C signal
  indices of the classic ESP32: I2CEXT0 SCL/SDA, I2CEXT1 SCL/SDA. The exact indices are taken from
  `soc/gpio_sig_map.h` in the pinned IDF headers.
- Peripheral-owned pads stop emitting `G`.

**Patch 0008: I2C.**
- Remove the TMP105 creation (A-4).
- Add `tbi-i2c-proxy`, which forwards phases as `B` frames.
- Controller fixes limited to what the probe (§6) proves necessary. Expected candidates:
  - data-byte NACK → `ACK_ERR`;
  - an empty-FIFO read becomes a protocol-visible failure instead of `0xee`;
  - the interrupt bits the IDF driver waits on;
  - status fields the driver polls.

### 4.2 Session Host

- **Engine side.** `I2cBus` with an HD44780-on-PCF8574 target (`peripherals/i2c.ts`, `hd44780.ts`)
  per LCD part.
- **Gating at every START** (ADR-011 §4):
  - routed pads wired to the device's SCL/SDA nets;
  - a pull-up on each line visible to the solver;
  - device powered.
- **Pull-ups.** The module's own pull-ups count (most PCF8574 backpacks carry 4.7 kΩ). Internal pad
  pull-ups are not modelled and **do not count** (D-4).
  - The failing case is an explicit, localized diagnostic (`i2c_no_pullup`), not a silent NACK
    without explanation.
- **Address conflicts** refuse the session (`i2c_address_conflict`, naming both parts).
- **What the browser receives.**
  - LCD state (DDRAM text, cursor, backlight) as part results in the existing `electrical` outcome.
  - Optional additive `i2c` diagnostics (address, ACK/NACK counts).

### 4.3 Build service and tickets

- `i2c` moves from `unsupported` to `requires` when the configured runtime capabilities include
  `i2c`.
- The `Wire` library is allowed under the same condition.
- The ticket gains an additive `requires` list. The host checks it against `H` capabilities
  (ADR-011 §1, §5).

### 4.4 Product side

**One new catalog part:**
- `display.lcd1602_i2c`, with the PCF8574 backpack, address jumpers (0x27 default, 0x20–0x27) and
  backlight;
- 2D and 3D rendering of the 16×2 HD44780 character ROM A00 text. The display's charset is physical
  truth: Hebrew UI text never appears on the LCD.

**One curated example:** "hello / sensor readout", using raw `Wire` writes to the PCF8574 (about
60 lines of LCD routine, no third-party library, D-3).

Optionally, an R2+R3 combined example (DHT22 → LCD) if both ship.

### 4.5 MicroPython

Out of scope for Sprint 12 delivery.

The proxy and engine targets are controller-level and not Arduino-specific, so `machine.I2C` reuses
them. The MicroPython firmware path is unchanged and is not exercised.

---

## 5. Runtime versioning, fingerprint migration and rollback

### 5.1 Versions

| Name | Patches | runtimeId | Use |
|---|---|---|---|
| Runtime v1 (deployed) | 0001–0005 | `33e35e4ac5e798d7` | dev-lab, staging, today |
| Runtime v2-dev-n | 0001–0006/7/8 drafts | Scratch ids | Development only; never pinned, never deployed |
| **Runtime v2** | 0001–0008 final (or 0001–0006 if R3 is a no-go) | New id, recorded in the report | Staging (Gate B), then dev-lab with approval |

`runtime.json` gains a `capabilities` array, derived at provision time from what the patch set
advertises in `H`.

### 5.2 Fingerprint migration

1. **Continuity test.** Every existing pinned fingerprint is re-run on Runtime v2 with v1 workloads,
   which use no new capability:
   - `gate.runtime.test.ts`: TbiGpioProof, both quanta;
   - `r1-determinism`;
   - banks, timing, serial.

   **Expected: bit-identical.**
   - 0006 adds only a host-sync timer, armed only when `J` is used.
   - 0007 sends `F` only on peripheral routing, which v1 workloads do not do.
   - 0008 removes a device no v1 workload addresses.
2. **If a v1 fingerprint changes**, the work stops for analysis.
   - **Accepted by construction:** the change is explained in mechanism (for example, the
     boot-time GPIO-matrix reset now emits `F` frames that shift host-side event order).
   - **Otherwise** the patch is fixed. A changed fingerprint is never re-pinned silently.
   - Any accepted re-pin is a 40-run repeated baseline, as in R1, with the reason recorded beside
     the value.
3. **New fingerprints** are pinned for the new capabilities, each from 10+ converging repeated
   runs:
   - HC-SR04 at three distances;
   - DHT22 at three temperature/RH points;
   - LCD init plus text;
   - a `J`-but-unread control case (T-DET-3).
4. **R-MCU-1** release gate re-run on Runtime v2: 62 full runs + 30 stressed boot runs, zero
   divergences.

### 5.3 Deployment and rollback (staging first; dev-lab only with Gate C approval)

| Step | Action | Rollback | Proven by |
|---|---|---|---|
| 1 | Session Host v2 bundle on **v1 QEMU** (`publish-runtime.sh`) | `rollback-runtime.sh` (existing) | v2 host + v1 QEMU passes the full Sprint 11 suite (no capabilities) |
| 2 | Provision Runtime v2 **side by side** (`~/tbi-s8-rt/qemu-<v2id>`); switch the instance's runtime bind with a new `switch-runtime.sh <instance> <runtime dir>` (re-render `@N@-qemu@.service`, daemon-reload, no running session) | `switch-runtime.sh <instance> <v1 dir>`, under 5 s, no data migration | Rehearsed on staging: switch, run suites, switch back, run suites |
| 3 | Build service configured with Runtime v2 capabilities | Restore the previous config with the step 2 rollback | `requires` tickets refused on v1 QEMU at `H` (T-SEC-5) |
| 4 | Frontend with the R2/R3 parts (`publish-frontend.sh`) | Re-point the frontend `current` | S12 frontend on S11 host: explicit `unsupported_component` |

Backups follow the Sprint 11 pattern (`/var/backups/tbi-lab/…`).

**Rule.** The v1 runtime directory is never deleted during Sprint 12.

---

## 6. R3 feasibility probe: specification and go/no-go

**Purpose.** Decide within the first days of the sprint whether `Wire` (core 3.3.12, IDF
`i2c_master`) runs on the upstream ESP32 I2C controller with small, explainable fixes.

**Isolation.**
- Scratch QEMU build from the pinned tree in `~/tbi-s12-probe` (outside the repo).
- Never added to `runtime/qemu/patches`, never deployed, never given a pinned id.
- Probe patches and results are recorded in the sprint record; the code is not committed to
  product paths.
- **Starting it requires PM approval of this package**, because it is QEMU modification.

**Instrument.**
- A diagnostic I2C target at 0x27 with a scripted register file, logging each phase with virtual
  time.
- TMP105 removed.
- Controller register access traced (MMIO log), with no bridge change.
- Firmware: dedicated probe sketches built with the pinned core.

| # | Probe | Pass condition |
|---|---|---|
| P-1 | `Wire.begin(21,22)` | Returns; no driver assert, panic or timeout in the serial log; boot completes |
| P-2 | `beginTransmission(0x27); write(…3 bytes); endTransmission()` | Returns 0; target logs START(0x27,W), 3 bytes, STOP in order |
| P-3 | Same to an absent address (0x3F) | Returns 2 (address NACK), no hang, no panic |
| P-4 | Data-byte NACK from the target | Returns 3 (or the core's documented code); if the controller cannot express it, record the fix size |
| P-5 | `requestFrom(0x27, 4)` + `read()` ×4 | Bytes equal the target script; `available()` is correct |
| P-6 | Write then read with repeated START (`endTransmission(false)`) | Correct phase order including RSTART |
| P-7 | A 100-byte write (above the 32-byte FIFO and 16-command list) | All bytes arrive in order (END/re-arm path), or a precise failure |
| P-8 | Bus scan 0x01–0x7E | Exactly the declared device ACKs; **0x48 does not** (TMP105 gone) |
| P-9 | Full HD44780-via-PCF8574 initialisation (4-bit sequence) plus "Hello" | The engine's `hd44780` model decodes DDRAM "Hello" from the logged bytes |
| P-10 | Determinism | P-2/P-5/P-9 run 10× each with identical phase logs and serial output |
| P-11 | Non-I2C regression | TbiGpioProof gate fingerprint on the probe build equals the pinned value |

**GO** (R3 stays in Sprint 12) when all of:
- P-1 to P-3, P-5, P-6 and P-8 to P-11 pass;
- the required controller changes total **≤ about 200 changed lines** in `esp32_i2c.c` and are
  each explained against the ESP32 TRM I2C chapter;
- P-4 and P-7 either pass or have a fix of that same bounded size.

**NO-GO** (R3 leaves the October 31 scope) when any of:
- the driver needs SCL-level timing, a cycle-accurate controller state machine, hardware bus-clear
  semantics or clock stretching;
- the estimated fix exceeds about 5 days;
- determinism (P-10) or non-I2C regression (P-11) fails for a reason not fixable in the probe
  window.

**On NO-GO:** Runtime v2 ships R2 only (0001–0006). R3 is re-planned with options for the PM:
- a deeper controller model;
- or MicroPython-only I2C first, if its driver is simpler;
- or deferring the LCD past the alpha.

**Timebox.** 1.5 days planned, 3 days maximum. The decision is reported to the PM at the timebox
end, with the evidence, whichever way it goes.

---

## 7. FU-11-1 and FU-11-2

| Item | Design | Size |
|---|---|---|
| **FU-11-1** staging reference firmware | Extend `install.sh staging` to import the pinned system artifacts listed in `runtime/firmware/artifacts.lock.json` (including TbiGpioProof `5f177cbe…`) into `/var/lib/tbi-s8-artifacts`, through the store's normal sha256-verified import path, owned by the store user. Same command, idempotent. Then `s8-deployed-policy` must run 7/7 on staging | 0.5 d |
| **FU-11-2** reliable temporary build directories | `publish-runtime.sh`, `publish-frontend.sh` and the new `switch-runtime.sh` default their scratch space to a disk-backed directory (`${TBI_DEPLOY_TMP:-$HOME/.cache/tbi-deploy}`), not `mktemp -d` on the 2 GB `/tmp` tmpfs. They check free space (≥ 3 GB) before `npm ci`, and abort with a clear message instead of producing truncated packages. Clean up on exit (trap) | 0.5 d |

Neither changes dev-lab until a deployment is approved.

---

## 8. C-5: five-concurrent-session capacity benchmark plan

**Question.** On a given host, can five concurrent live ESP32 sessions each run at **at least
1.0× real time**, without starving the build service and with bounded per-event latency?

**Scenarios** (each session drives a curated example through the real stack: gate → Session Host →
QEMU):

| # | Workload per session | Why |
|---|---|---|
| W1 | Motion alarm (R1), PIR toggled every 2 s | Typical, light |
| W2 | Night light (R1), LDR param changed every 1 s | Parameter mirror path |
| W3 | HC-SR04 distance alarm at 10 Hz | R2 schedule load |
| W4 | DHT22 + LCD every 2 s | R2 + R3 round trips |
| W5 | Serial-heavy (115200 continuous) | Bridge stream load |
| Mix | 2×W1, W2, W3, W4 | Realistic alpha class |

**Measurements**, taken at N = 1, 2, 3, 4, 5 concurrent sessions, 3 repeats, 10 minutes each:
- per-session simulation rate (× real time; p5);
- tick gap p99 and maximum;
- per-event solve p99;
- host CPU, steal and load;
- RSS per QEMU and for the Session Host;
- build latency for one concurrent build with deferral off versus on;
- first-Run latency;
- error and diagnostic counts.

**Pass criteria (proposed, D-2):**
- every session p5 rate ≥ 1.0×;
- tick gap p99 ≤ 100 ms;
- no session failures;
- build completes ≤ 120 s under load;
- memory headroom ≥ 25 %.

**Execution.**
1. **In Sprint 12 at no cost:** the harness, plus an N=1..3 dry run on **staging** under a
   test-only policy override (restored afterwards and verified, the Sprint 11 `s8-policy`
   pattern).
   - It gives the per-session CPU cost curve on this 1-vCPU host.
   - Projection from Sprint 11 data: five light sessions would run at about **0.7× real time
     each**, below the criterion.
2. **On the alpha host:** only after the PM and owner decide the hardware (D-1). The plan
   specifies the minimum host the curve predicts (vCPU count and RAM) **as a recommendation, not
   a purchase**.

---

## 9. Security, isolation and quotas

**The new attack surface is host → QEMU commands built from untrusted inputs:** environment
parameters and firmware behaviour.

**Controls:**
- **Parameters.** Every environment parameter goes through the host's mirror validator, with
  ranges from the catalog (distance 0–5 m, RH 0–100 %, temperature −40–80 °C). Out-of-range values
  are rejected with `400`, as in Sprint 11.
- **Scheduled inputs.** `J` is generated only by host device models, never forwarded from the
  client. Caps, spacing and the per-second budget are enforced host-side and again in QEMU (fail
  closed). The `J` budget prevents a firmware trigger flood from exhausting the host.
- **I2C frames.** `B` frames come from guest firmware. The host bounds work per frame (O(1) engine
  calls), and a per-session `B` frame budget per simulated second (`i2c_rate_exceeded`) mirrors the
  edge budget idea.
- **Capability enforcement** at `H` (defence in depth over the build service).
- **Unchanged:** quotas, ownership, run tickets, the gate, the unit sandbox and the private socket.
- **Tests:** T-SEC-1..8 in the test matrix, plus a re-run of the Sprint 11 authorization, quota,
  malformed-command and cleanup suites.

---

## 10. Critical path: 31 October and 30 November

The details and dates are in the implementation plan. The summary:

- **31 October.**
  - Sum of effort at P50 is **≈ 22 days** (P90 ≈ 36.5), against **19 calendar days** (13–31 Oct).
  - The dependency chain at P50 is ≈ 13 days: bridge host → 0006 → 0007 → 0008 → R3 host → R3
    product → release engineering.
  - Effort, not the chain, is binding. With seven-day weeks and fast PM gates (≤ 1 day each):
    - **R2 complete on staging by about 24 Oct: high confidence.**
    - **R2+R3 Runtime v2 through Gate B on staging by 31 Oct: about 45–50 % (P50 lands 2–3 Nov;
      P90 about 13 Nov).**
  - **Recommendation:** treat 31 Oct as the R2 commitment and the R3 *target*, with the R3 go/no-go
    on about 15 Oct.
- **30 November.**
  - Still feasible if Sprint 13 (2–14 Nov) absorbs any R3 tail and the dev-lab Gate C.
  - Sprint 14 (16–27 Nov) is release hardening.
  - **The capacity decision (D-1) is on the November critical path, not October's.** Alpha
    hardware must be available by about 9 Nov to measure C-5 by 14 Nov, so **D-1 is needed by about
    30 Oct**.

---

## 11. Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| IDF `i2c_master` relies on controller behaviour upstream does not model (A-5/A-6) | M | H | Probe first, timebox 3 d, explicit go/no-go; R2 ships independently |
| A functional patch perturbs v1 fingerprints | L–M | H | Continuity test first in each patch slice; stop-and-explain rule (§5.2) |
| Library expectations (`DHT.h`, `LiquidCrystal_I2C`) from alpha testers | H | M | D-3: curated examples without libraries now; allowlist decision for Sprint 13 |
| Internal pull-ups unmodelled (A-3/A-6); users wire I2C without external pull-ups | M | M | Module pull-ups count; explicit `i2c_no_pullup` diagnostic; D-4 |
| DHT22 T_go source ambiguity | M | L | Datasheet value or PM choice (D-7); documented assumption |
| Per-part product work (3D, i18n) underestimated for the LCD (text rendering in 2D and 3D) | M | M | LCD 3D can show text as a texture or plane in v1. If late, show 2D text and a 3D body only, a PM-visible fallback |
| One implementer: effort exceeds window | H | M | R2-first ordering; R3 can slip to Sprint 13 without blocking R2 |
| Capacity (FU-11-3) unresolved | H | **Critical for 30 Nov** | D-1 by about 30 Oct; C-5 harness ready in Sprint 12 |
| Upstream `0xee` / `error_report` paths leak QEMU diagnostics | L | L | 0008 turns them into a fail-closed protocol status where reachable |

---

## 12. Requested PM decisions

| # | Decision | Recommendation |
|---|---|---|
| **D-0** | Approve this package (ADR-011, architecture, plan, test matrix) and the start of the **R3 feasibility probe** (scratch QEMU, not product) | Approve |
| **D-1** | Alpha capacity: how and when five concurrent sessions are hosted (hardware or tier change, or a reduced-concurrency alpha); spending needs owner approval | Decide by about 30 Oct; Sprint 12 provides the C-5 curve and a minimum-host recommendation |
| **D-2** | C-5 pass criteria (§8) | Accept as proposed |
| **D-3** | Third-party Arduino libraries (`DHT.h`, `LiquidCrystal_I2C`) | Sprint 12: none; library-free curated examples. Decide a pinned, licence-reviewed allowlist for Sprint 13. It needs symbol-level pull detection first (A-7) |
| **D-4** | Internal pull-ups (`INPUT_PULLUP`, `Wire`'s automatic internal pull-ups) | Sprint 12: unmodelled; they do not satisfy I2C gating; explicit diagnostic. Modelling pulls in the GPIO model is a candidate for a later runtime (it would also lift today's `INPUT_PULLUP` refusal) |
| **D-5** | Branch base: `sprint-12` from `sprint-11` head (`e54675b`) before Sprint 11 is merged | Accept. Rebase is not needed: after Sprint 11 merges, `sprint-12` contains it |
| **D-6** | Patch numbering by landing order (0006 bridge v2, 0007 pad functions, 0008 I2C; LEDC later 0009) | Accept |
| **D-7** | DHT22 T_go value if the datasheet gives only a range | Use the datasheet's typical value; else the range midpoint, documented |
| **D-8** | Scope confirmation: the R2/R3 parts include full product-side work (catalog, 2D/3D, i18n, examples) in Sprint 12 | Confirm; otherwise R2/R3 would be runtime-only and invisible to testers |

---

## 13. Out of scope / backlog (reported, not planned)

- R4: LEDC/PWM, servo, the A1 electrical decision.
- Modelling internal pulls in the GPIO model (D-4).
- Third-party library allowlist (D-3).
- I2C bus-duration timing.
- MicroPython I2C exercise.
- GPIO interrupt delivery (`attachInterrupt`).
- The 8×8 matrix in ESP32 projects.
- Capacitor or transient under a board.
- Production changes; alpha infrastructure provisioning.
