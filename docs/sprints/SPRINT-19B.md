# Sprint 19B — Exploration Foundation: approved engineering implementation

**Target:** DEV only (`tbi-lab-srv`). PR #7 stays draft and unmerged; Alpha untouched; production
unchanged. RC5 is separate: none of this sprint's Exploration features are in it.
**Base:** `sprint-15-r4` at `c164cbe` (R4 + 18F); DEV-Lab and staging served `b59ee50` on Runtime v3
`2cb1406f94f52e4f`.
**Approved decisions:** EF-D1 C · EF-D2 B → C (SN74LVC1G, verified 3.3 V family) · EF-D3 A ·
EF-D4 A guaranteed · EF-D5 A (explicit ADC refusal) · EF-D6 B (LMC555 first) · EF-D7 B · EF-D8 A ·
EF-D9 C (parallel tracks, one authoritative TODO) · F2 ¼ W default, configurable, from a verified
series with its derating.

## Branches

| Branch | Content | Head |
|---|---|---|
| `sprint-19b-logic` | L1 logic gates, X1, F2 | `8c1d24f` |
| `sprint-19b-mpy` | integration: logic + F2 (cherry-picked) + M MicroPython + Runtime v4 + O2; **deployed `4676139`** | `571e266` + this record |
| `sprint-19b-kernel` | T time-kernel prototype (isolated, not in the product) | `fa21917` |
| `sprint-19b-todo` | the single authoritative digital-logic order in `docs/TODO.md` (off `main`) | `08240dc` |
| `sprint-19a-ef-decisions` | the 19A decision package (unchanged) | `2e2b397` |

## 1. Milestone O — operations

### O1 disk (≥ 20 GB)
- `hardlink -t` over three NON-active toolchain copies (`~/tbi-tools/arduino`, `~/tbi-s15-rt/arduino`,
  `~/.local/share/tbi-lab-runtime/arduino`). The active `~/tbi-r1-clean/rt/arduino` and the protected
  `~/tbi-s12-rt-release` were excluded.
- Manifests (path, size, mode, owner, sha256) identical before and after over 179,293 files.
- Free space 5.41 GB → **20.36 GB**. Script `~/tbi-s19b/o1-dedupe.sh`, logs `~/tbi-s19b/logs/o1-*`.
- During the sprint free space fell to 18.7 GB (Claude Code / VS Code extension auto-updates
  ≈ 1.1 GB, sprint logs and builds). One more duplicate (the MicroPython source tarball, 153 MB) was
  hardlinked. **Owner decision:** the older Claude Code version directories (2.1.306, ≈ 690 MB in
  `~/.local/share/claude/versions` and the VS Code extension cache) are not ours to delete.

### O2 staging isolation
- Each instance runs as its own system users: dev-lab `tbi-build`, `tbi-buildjob`, `tbi-runtime`,
  `tbi-qemu` (groups `tbi-buildio`, `tbi-runtimeio`, `tbi-artifacts`), **exactly as before**; staging
  `tbi-s8-build`, `tbi-s8-buildjob`, `tbi-s8-runtime`, `tbi-s8-qemu` (groups `tbi-s8-*`).
- Templates take `@U@`; the polkit rule names the instance's own users, so neither instance's
  services can start or stop the other's templates.
- Dev-lab renders byte-identical units (diffed; the polkit file differs only in a comment).
- The existing staging store moves to the staging users (modes kept); systemd re-owns state dirs.
- **Not separated (stated, not hidden):** the gate group `tbi-gate` is shared, so a service of either
  instance can connect to the other's API sockets, where the other's identity/ticket checks apply.
  A per-instance gate group needs a Caddy/oauth2-proxy change (future).
- Unrendered placeholders are refused before any unit is touched (install.sh, switch-runtime.sh).

### Rollback, resource limits
- Staging backup before O2: `/var/backups/tbi-lab/s18-staging-pre-20261022T073637Z`; rollback
  `~/tbi-s19b/rollback-staging-o2.sh` (restores units, rule, keys, bundles and the store owner).
- Unit resource limits unchanged (MemoryMax 384M per QEMU, CPUQuota, TasksMax 80, …).

## 2. Milestone L — L1 logic (+ X1)

**What users can build:** single-gate logic with real supply pins, in every view (workbench,
schematic, 3D), driven by switches, buttons, dividers or ESP32 outputs, driving LEDs and ESP32
inputs.

- Parts: SN74LVC1G08 (AND), 1G00 (NAND), 1G32 (OR), 1G04 (NOT); SOT-23-5 (DBV0005A) on a breakout.
- Model (TI datasheets, pinned in `~/tbi-s19b/datasheets` with SHA256SUMS):
  - input thresholds from the V_IH/V_IL table rows for the supply;
  - output stage = piecewise-linear I(V) through every guaranteed (V_OH, I_OH) / (V_OL, I_OL) point;
  - Kleene three-valued evaluation: an input in the undefined band is **X**, and what it decides is
    unknown: those nets and parts are shown as unknown, never as a number.
- Refused by name: `logic_input_floating`, `logic_supply_missing`, `logic_supply_uncharacterized`
  (a supply outside the tabulated rows), `logic_output_uncharacterized` (a load beyond the
  guaranteed points), `logic_feedback_unsupported` (any loop through gates), `logic_unknown_state`.
- **X1** (`esp32-logic-and`): ESP32 output + push button → AND gate at 3.0 V → LED; the ESP32 reads
  the output back. Real QEMU (Runtime v3): read-back equals the written level on every line; LED
  3.91 mA.

**Unsupported (by design in L1):** gates 1G02/86/125/07 (cards in the datasheet set, not yet
parts); feedback (latches); propagation delay; packaged multi-gate ICs.

**Owner decision (open):** apply the 3.0 V output rows across 3.0–3.6 V. Today a load above
100 µA at 3.3 V is refused (`logic_output_uncharacterized`): the datasheet has no 3.3 V row, so
the ESP32's 3V3 pin cannot power a gate that drives an LED.

## 3. Milestone F — Component Failure Framework

### F2 resistor power rating
- KOA Speer CF series (`CF.pdf` p.143, pinned): CF1/4 0.25 W, 300 V working; CFS1/2 0.5 W, 350 V;
  both derated 100 % to 70 °C, linearly to 0 at 155 °C; results at a 25 °C ambient.
- Optional parameter `powerRating` (absent = ¼ W; stored only when it differs).
- Above the derated power → `unrated` (outside the specified conditions; the series publishes no
  damage threshold, so no damage is inferred). Above the working voltage → `absolute`.
- A value the series is not made in (CF1/4 2.2 Ω–5.1 MΩ, CFS1/2 1.0 Ω–5.1 MΩ) → a named row
  `resistance_outside_series`: no rating is borrowed, none is silently dropped.
- **Compatibility:** a project where the user selected ½ W stores `powerRating`; builds before F2
  (e.g. the 18F rollback target `b59ee50`) reject that project as `unknown_param`. Projects that
  never changed the rating are unaffected.
- Under PWM the power row uses the peak current (Sprint 17C conservative rule for every part).

### Investigations (F, not changed)
- **Unmodelled load current:** a load on a logic output beyond the guaranteed points is refused
  (L1). The servo's supply is still treated as stiff (F1, backlog).
- **Unknown-state gaps:** L1 adds unknown nets; stateful parts on an unknown node are refused.

## 4. Milestone M — genuine MicroPython, Runtime v4

**What users can build:** ESP32 programs in MicroPython v1.29.0 (the genuine ESP32_GENERIC
interpreter, unmodified) using `machine.Pin`, `machine.PWM`, `time`, `print` and pure-Python
modules, on the same circuits as Arduino C++ (language switch in the Code view).

- Build = the user's `main.py` written unchanged into the interpreter's own LittleFS partition by
  `tbi-mklfs` (built from the interpreter's own littlefs sources), spliced into the pinned image:
  byte-reproducible (`c79cf6e4…` for the probe program, matching the 19A probe).
- **Refused at Build** (`pyFeatures.ts`, fail closed, review finding 1): any import outside an
  allowlist (`library:<module>`: network, bluetooth, esp32, neopixel, dht, random, os, …); `machine`
  names other than Pin/PWM/ADC/Signal/idle/freq, by facility (DAC, touch, SPI, I2C, Timer →
  interrupt, sleep, reset/WDT → restart, mem32, UART, RTC, …); internal pulls in every spelling;
  drive strength; `machine.freq(x)`.
- **Refused at Run** by Runtime v4 (patch 0011, frame `U <vns> adc|gpio-interrupt|cpu-clock`), at the
  access: ADC reads, `Pin.irq`, a lowered CPU clock. The session fails `unsupported_feature`,
  naming the facility (EN/HE).
- Every MicroPython artifact requires the runtime capability `unmodelled`; the build service offers
  the profile only when its runtime announces it (never on v3).

**Unsupported:** ADC, interrupts, timers, UART/SPI/I2C, Wi-Fi/BT, sleep, `machine.reset`, serial
INPUT (the REPL; `SerialPacer` is built and tested, not wired: the host has no serial-input path),
names built at run time (the documented static-analysis residual; Runtime v4 is the backstop for
ADC, interrupts and the clock).

## 5. Milestone T — time-kernel prototype (isolated)

`packages/engine/src/kernel/transient.ts`, not used by any product path.

- Trapezoidal between discontinuities, backward Euler after the start, breakpoints, events and any
  input change; step doubling + Richardson error estimate on node voltages **and** component
  currents; exact breakpoints; refusals `transient_step_floor`, `transient_budget_exceeded`,
  `transient_logic_unsupported`, `transient_solve_failed`, `transient_time_not_ahead`.
- Events (relay armature, a supply's CV/CC mode) are bracketed by bisection; the kernel steps there
  with error-checked steps and crosses with one backward-Euler step: no unchecked state is returned.
- Closed-form tests: RC (worst 0.326 mV over 0.5 s, 64 steps, 192 solves, ~65 ms); RC ladder;
  relay pull-in 170.2464 ms vs exact 170.2671 ms (the event time's error is the trajectory's voltage
  error / slope, ~21 µs; it shrinks ×5+ with 100× tighter tolerances); CC→CV at the closed-form
  501.25 µs with no current ringing; second order pays (201 vs 1155 solves at 10 µV);
  determinism; exact breakpoints and checkpoint/restore.
- **Next:** LMC555 on the kernel (needs exposure approval), propagation delay for logic.

## 6. Independent reviews and dispositions

Three independent reviews (each by a reviewer that had only the code): L1 (fixed in `b6b8462`),
M + O2, and T + F2.

| Finding | Disposition |
|---|---|
| M **blocker:** MicroPython refused nothing at Build (pulls, DAC, touch, SPI, Wi-Fi, sleep, reset ran with dead or invented behaviour) | fixed: `pyFeatures.ts` (allowlist, fail closed) + 6 unit tests + real-stack tests |
| M: raising the CPU clock never refused (v4 sees only a lowered clock) | fixed: `machine.freq(x)` refused at Build |
| M: a MicroPython pin mismatch stopped the Arduino build service | fixed: the profile is dropped with a logged reason |
| M: MicroPython offered on a runtime without `unmodelled` | fixed: offered only when the runtime announces it |
| O2: isolation overstated (shared `tbi-gate`) | documented in install.sh and §1 |
| harness: an unhandled U frame ended as `completed` | fixed: `host_error` |
| tests weaker than claimed (IRQ, reproducibility, pacer) | fixed: IRQ-ARMED never printed; an independent second build; pacer stated as not wired |
| placeholder check after the unit went live | fixed: before the target is touched |
| `tbi-mklfs` argument truncation | fixed (new pin `81818234…`) |
| MicroPython listed in the UI where the service lacks it | open (fails closed: `unknown_profile`); backlog |
| T **blockers:** unchecked event steps; event-time accuracy overstated | fixed (§5) |
| T: trapezoidal across unseen discontinuities; ringing in currents; double toggles; budget; `ok` without outcome; restore on failure; tests too loose | fixed (§5) |
| F2: out-of-series values silent | fixed: `resistance_outside_series` |
| F2: ½ W projects rejected by pre-F2 builds | documented (§3) |
| F2: PWM power is the peak | documented (Sprint 17C rule) |

## 7. Tests

| Gate | Result |
|---|---|
| Typecheck, lint, Prettier, boundaries | pass |
| Unit (all, `373b458`) | **1428 / 1428**; engine on the kernel branch 255 / 255; logic branch after F2 fixes all green |
| Browser e2e (all, `4676139`) | **241 passed, 0 failed, 33 skipped** (the real-stack specs, run on staging) |
| Real QEMU, MicroPython (`s19b-mpy`, Runtime v4) | **7 / 7** |
| Real QEMU, X1 (`s19b-x1`) | passed (Runtime v3; on v4 through the staging browser gate) |
| Runtime regression on the v4 RELEASE binary (49 files) | 210 passed, 4 failed, 19 skipped → s15-r4 M2 (harness change) fixed `4676139`; s12-determinism hcsr04 timeout under load, passes alone (8 / 8); s8-containment / s8-policy ran against the OLD staging, pass after the 19B install |
| Determinism | MicroPython transcripts and electrical sequences identical over two runs; s12 R2/R3 fingerprints 8 / 8; kernel bit-identical |
| Load-sensitive | "two concurrent gate sessions" (r2-failures) timed out twice under load, passed twice alone |

## 8. Deployment

### Package and runtime
- Package `~/tbi-s19b/rel/s19b-4676139`, rc4 profile (reports OFF), manifest **`91f686900b8e9149`**; a
  second build at another path is byte-identical (26 files, 8 source maps).
- Runtime v4 release build `cd778dc17d8edcdd` in a clean home (`~/tbi-s19b-rt-release`), from the
  pinned source + patches 0001–0011, 468 s. Its id equals the dev build's; the binary differs
  (QEMU builds are not bit-reproducible, F-18-1, open).
- MicroPython build home built in the release home; its pins equal the profile's.

### Staging `tbi-s8` (first install with the O2 users)
| Step | Result |
|---|---|
| Backup | `/var/backups/tbi-lab/s18-staging-pre-20261022T073637Z` (verified equal to live before install) |
| Install | `4676139`, 4.3 s; bundles equal the package; health `4676139`; MicroPython profile offered |
| DEV-Lab during staging | hashed before/after every staging step: unchanged |
| Isolation | each instance's users can stop only their own templates (polkit "Access denied" otherwise); neither reads the other's store |
| Browser gate | `s19b-real` **4 / 4** (X1 on v4; MicroPython PWM average; ADC refused at the access; PULL_UP refused at Build); 18F set **12 / 12** (build: curated 72 ms, seeded edit 13.4 s) |
| Deployed suites | s8-policy 7/7 (policy restored byte-equal), s8-deployed-policy 7/7, s8-qemu-tasks 2/2, s11-deployed 6 + 2 skipped, s13-deployed-security 1/1, s8-containment 9/9 (after two test updates, `571e266`) |
| Rollback rehearsal | first attempt **failed** (the script's globs on the root-only backup expanded unprivileged; staging's services were stopped for ~2 min; DEV-Lab unaffected); fixed; back **742 ms** (byte-equal, shared users, store re-owned), forward 6.7 s; `s19b-real` 4/4 again |

### DEV-Lab — DEPLOYED
- **DEV-Lab serves `4676139`** (frontend, Session Host, build service) on **Runtime v4**
  `cd778dc17d8edcdd`, since 2026-10-22 10:14 UTC. Pre-check: 0 live sessions.
- Backup `~/tbi-s19b/deploy/devlab-backup-20261022T101434Z` (units, polkit rule, Caddyfile, tmpfiles,
  Caddy drop-in, policy, runtime.json, key hashes, links, health; SHA256SUMS).
- Deploy 2.5 s. Unit changes exactly: the v4 runtime bind; the MicroPython binds; one polkit comment
  line. Users, Caddyfile, tmpfiles, Caddy drop-in, policy and keys unchanged.
- Through the gate's internal origin, the 15 non-map files are byte-identical to the package;
  `/version.json` = `4676139`; the public site stays gated (302).
- Deployed suites: **15 passed, 2 skipped** (s8-deployed-policy, s8-qemu-tasks, s11-deployed);
  restart tests not run on DEV-Lab.
- **Rollback, rehearsed:** `~/tbi-s19b/deploy/rollback-devlab-19b.sh back|forward` (links, units and
  runtime.json together). Back to `b59ee50` / v3 in **703 ms** (units and runtime.json byte-equal to
  the backup; s8-qemu-tasks 2/2); forward in 729 ms (s8-qemu-tasks 2/2).
- Prewarm after deploy: the 2 non-current curated sources rebuilt (seeded, 14.7 s); each rehearsal
  restart did one cold curated rebuild (~60 s: the seed of the other runtime is pruned at start).

## 9. Capability and refusal matrix (Sprint 19B additions)

| Area | Supported | Refused by name |
|---|---|---|
| Logic gates (DC) | SN74LVC1G08/00/32/04 at tabulated supplies; guaranteed output points; X propagation | `logic_input_floating`, `logic_supply_missing`, `logic_supply_uncharacterized`, `logic_output_uncharacterized`, `logic_feedback_unsupported`, `logic_unknown_state` |
| Resistor rating | ¼ W (default) / ½ W KOA CF, derated, 25 °C | `unrated` power; `absolute` working voltage; `resistance_outside_series` |
| MicroPython (Build) | Pin, PWM, Signal, idle, freq(); time, sys, gc, math, struct, json, re, … | `library:<module>`, machine facilities (dac, touch, spi, i2c, interrupt, sleep, restart, drive_strength, cpu_frequency, `library:machine.<name>`), internal pulls |
| MicroPython (Run, v4) | GPIO, PWM (exact averages), serial output | `unmodelled`: adc, interrupt, cpu_frequency (lowered) |
| Time kernel (isolated) | RC, ladders, relay and CV/CC events | `transient_*` |

## 10. Future / Backlog
- LMC555 on the time kernel (EF-D6 B; the kernel prototype passes its gates; exposure needs approval).
- Potentiometer (EF-D5 A, passive); MOSFET; gates 1G02/86/125/07; packaged multi-gate ICs.
- MicroPython: examples, `machine.reset`, Timer/UART/SPI/I2C measurement, serial input (REPL; the
  pacer is ready), capability-panel MicroPython context, hiding the language where not offered.
- F1 (servo supply treated as stiff), F4 investigation.
- A per-instance gate group (Caddy/oauth2-proxy change); QEMU build reproducibility (F-18-1).
