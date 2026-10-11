# Gate B — G-2 round 3 (2026-10-11): H-1 evidence, determinism baselines, R2 fidelity investigation

**Status: STOPPED for PM review** (PM G-2 decision of 2026-10-11, "stop after the investigation").
Nothing re-pinned beyond TbiDht22 (accepted earlier). No staging, dev-lab or production change.
B4b–B7 not resumed. Raw evidence: [g2r3/](g2r3/).

Corrections to [G2-EVIDENCE.md](G2-EVIDENCE.md) (round 2):

- **F-R2-1's interval is ≈ 10.1 µs, not 6.2 µs.** The round-2 sweep (31 µs offsets) missed its
  start; a 0.2 µs sweep finds it at 539.0–549.1 µs of each simulated millisecond in TbiEdgeTime.
- **F-R2-2 is not specific to the first reading.** It depends on the phase of `pulseIn`'s polling
  loop at the two edges (below); the first reading of TbiHcSr04 is where that phase happens to
  give 23294.
- The round-2 proposal to replace EdgeEcho's assertion with TbiEdgeTime is withdrawn (PM: keep
  the end-to-end firmware test); TbiEdgeTime is added as a separate test.

## 1. H-1 (Session Host publication) — test evidence

Fix: `97de8e7` + `1cc45ac` (pushed). Tests: `bd26ec5` (local).

| Requirement | Evidence | Result |
|---|---|---|
| Exact, late, repeated-late tick boundaries | `runtime/host/tests/publication.test.ts`: exact baseline; one late boundary tick (`4@10-10`); repeated isolated (`4@10-10,4@30-30,7@50-50`); persistent from boot (`4`) and mid-session (`4@25`); late only off boundaries; late runs across two boundaries; a 7 ns→4 ns→exact sequence | every case's published stream equals the exact-tick stream **byte for byte, stamps included** |
| No required event silently dropped | same cases: every GPIO edge counted (20 by 100 ms, 2 per window), every serial line once, every operating point; stop case: GPIO2 transitions = edges produced up to the last frame | pass |
| Multiple events, window boundaries | events at 10 ms − 1 ns, on 10 ms, 10 ms + 5/6 ns, exact and late; an event between a boundary and its late tick | windows `(end − 10 ms, end]`, by event time | pass |
| No duplicate publication, no reordering | every case: `seq` contiguous, `simNs` non-decreasing, one event per type per stamp | pass |
| Stop / restart / cleanup | late-tick session stopped: `ended/stopped`, runtime process gone, private directory gone, partial window published once; restart (new session) starts at window 1 with the same stream | pass |
| Regression proof | the 13 cases against the pre-fix host (`8c9ff51`): **10 fail**; the 3 that pass are those H-1 cannot affect (exact ticks; late ticks off boundaries) | — |
| Unit suite, typecheck, lint | 1026/1026 (119 files) | pass |
| Sprint 12 runtime suites (real QEMU, fixed host) | s12-bridge 10, s12-examples 3, s12-r2 3, s12-r3 3, s12-pace 1 | pass |
| Sprint 11 and earlier runtime suites | 23 files, 98/98 (r1-*, r2-*, gate, failures, isolation, quantum, serial, timing, banks, electrical, firmware, resources, s7-build, s8-gate) | pass |
| Not run (staging instance; PM: no staging changes) | s8-containment, s8-policy (installs a policy, restarts services), s8-qemu-tasks, s8-deployed-policy, s11-deployed | resume with B4a |
| s12-determinism with the committed pins | the 7 pins were taken under the defect: 7/7 fail, each producing exactly the replacement value below | expected |

**Protocol contract** (R2-REPORT §5, `bd26ec5`): publication is **sampled state per window**,
attributed by event time, each window published once; GPIO gives final state + exact transition
count, electrical gives the window-end operating point, serial is lossless up to the per-window
cap (excess counted). **Lossless per-edge traces are not part of `tbi-lab.session/1`**; edge
timing is verified at the bridge by test instrumentation only. Wire format unchanged.

What H-1 cost (old host vs fixed host, same images, [det-audit.json](g2r3/det-audit.json)): no
GPIO edge and no serial byte was lost (transition and byte totals equal; at 4 m two trigger edges
were pushed past the 3 s cut-off), but whole windows were merged into the next one, so their
**operating points were never published**: HC-SR04 4 m 20 → 37 windows, 33 operating points
(echo-high states) missing; DHT22 the MCU start-signal window (pin 4 driven low) missing; LCD the
intermediate "Hello, ESP" state missing.

## 2. Determinism baselines (the seven `s12-determinism` scenarios)

Three stream sets, each dumped and audited ([det-audit.py](g2r3/det-audit.py)): **old** = old host
(`8c9ff51`) + old images (reproduces all seven old pins exactly, 1 run); **A** = fixed host +
committed images (TbiDht22 new, TbiHcSr04/TbiLcd old), 10 runs; **B** = fixed host + proposed
images (TbiHcSr04 `9fd371b1…`, TbiLcd `d8819c06…`), 10 runs.

| Scenario | Old pin | A (10/10) | B (10/10) | Electrical (B) | Timing fidelity (B) |
|---|---|---|---|---|---|
| hcsr04-0.1m | `2371e2174c387d9c` | `b0d9a191756612ba` | `a6174faf18931c61` | 0 issues | 21/21 readings 582 (oracle 582.377) |
| hcsr04-1m | `caa97d8064a84841` | `efe9ac9393687eb6` | `f5c51475cc5dac18` | 0 issues | 20/20 readings 5823 (oracle 5823.773) |
| hcsr04-4m | `43dba895631b86e4` | `188a0e63e70a16bf` | `ce7868f0e5352722` | 0 issues | **first reading 23294 (−1.091 µs, outside T-R2-2)**, 16 later 23295 — same in A and in old |
| dht22 −10 °C/30 % | `85e3e8d5cf6c46bb` | `b87741773a4f3c7a` | same | 0 issues | decoded −10.0 °C / 30.0 % exactly (2/2) |
| dht22 21.5 °C/55.2 % | `838e065211c66629` | `414a2379065bc425` | same | 0 issues | decoded exactly (2/2) |
| dht22 60 °C/95 % | `afcb868539a8f893` | `10af087aa4803ee2` | same | 0 issues | decoded exactly (2/2) |
| lcd1602-hello | `2ec207126b9067ba` | `03d6e5f264ed9506` | same | 0 issues | text, backlight, display sequence as the old stream plus the formerly skipped state |

- **Reproducibility:** 10/10 identical fingerprints for every scenario in A and in B.
- **Electrical correctness:** every published operating point checked against the parts' own
  documented models, not against the engine's output: HC-SR04 echo high = 5 V through
  R_out 100 Ω (A-R2-6) into 1 k + (2 k ∥ input leakage) = 3.225772 V at GPIO18; DHT22 released
  bus = 10 k pull-up against the 50 nA input leakage = 3.299500 V. 0 discrepancies in all sets.
- **A → B differences** (HC-SR04 only; DHT22 and LCD identical): the new image starts 1.000 ms
  later, so the setup reading's windows move from 0.89 to 0.90 s and a few later window
  boundaries split differently; readings and operating points identical.
- **Not approved by agreement alone:** the 4 m scenario reproduces a reading outside T-R2-2 in
  every run (F-R2-2); its pin would encode that reading. Recommendation in §5.

## 3. Firmware images — old vs new (fixed host)

Unchanged from round 2 (G2-EVIDENCE per-image table) and confirmed by §2: TbiDht22 and TbiLcd
identical streams; TbiHcSr04 identical content and device timing, app start +1.000 ms; TbiI2cProbe
all 450 bus phases identical, +1 ms start, ±96 ns gap pairs, one STOP +19 ns; TbiEdgeEcho firmware
polling ≈ 12 µs, both images; TbiR1Scan identical content, ≈ 20 ppm loop-rate difference. Only
TbiDht22 is re-pinned.

## 4. R2 fidelity investigation

### F-R2-1 — a core cannot run while the other core executes

**Cause (QEMU, not the images).** Under `-icount`, QEMU runs the two ESP32 cores round-robin on
one thread and the single virtual clock advances by the instructions of **whichever core is
executing** (`accel/tcg/icount-common.c`: `timers_state.qemu_icount += executed`;
`tcg-accel-ops-rr.c`). While one core executes, the other is frozen and simulated time passes for
it. On silicon both cores run at the same time. CCOUNT itself is exact (`target/xtensa/op_helper.c`:
linear in virtual time).

**Affected path** ([core0-tick-path.txt](g2r3/core0-tick-path.txt), QEMU exec trace): every 1 ms
core 0's CCOMPARE0 tick (intset 0x40) runs `_xt_lowint1` → `_frxt_timer_int` →
`xPortSysTickHandler` → tick hook → `xTaskIncrementTick` (SMP critical section, spinlock) →
`vTaskSwitchContext` / `prvSelectHighestPriorityTaskSMP` → IDLE0 `esp_vApplicationIdleHook` →
task-watchdog feed (`esp_task_wdt_reset`, `task_wdt_timer_feed`, `esp_timer_impl_get_counter_reg`)
→ `waiti`: ≈ 1 260 instructions.

**Measurements** ([fr2-analysis.json](g2r3/fr2-analysis.json); deterministic, run twice):

| Experiment | Result |
|---|---|
| E1 TbiEdgeTime, capture on core 1, interrupts masked, 734 edges, 4 µs grid + 0.2 µs over 535–557 µs | all edges within −50..+96 ns except **539.0–549.1 µs**: seen at 549.05–549.15 µs (lateness linear, max 10.13 µs) |
| E1 TbiEdgeTime0, capture on core 0 | no interval ≥ 4 µs (core 1 idle; a shorter one is not excluded by the 4 µs grid) |
| E2 `pulseIn` on core 1 / core 0, widths 15 µs–23.3 ms, 690 pulses each | outside ~10 µs windows per ms: reading − width within −1.09..+0.23 µs at every width (polling + truncation, §F-R2-2); edges inside a window: rise late → reading up to **−8.8 µs**, fall late → up to **+9.9 µs**, **independent of width**; repeated runs identical |
| E2 caveat | the windows combine the measuring core's own tick interrupt (physical; on silicon ~½ the duration) and the other core's tick (emulator); E2 does not separate them — E1 isolates the other core |
| E4 TbiDualLoad: core 1 times a fixed loop | core 0 idle: 159 454 cycles; core 0 busy: 211 469–211 582 (**×1.33**; silicon ×1.0). Instruction-bound code on two busy cores runs slower in simulated time |
| E5 GPIO write answered with a scheduled input (`J`) | in some iterations the **writing core loses 10.95 µs** right after the write (bare bridge, no Session Host; 0.58 µs without `J`). Deterministic; the echo itself stays exact. **Traced** (below): the lost interval is the rest of core 0's tick |

**Mechanism, traced (E5, [e5-trace-excerpt.txt](g2r3/e5-trace-excerpt.txt), QEMU
`-d exec,int,nochain` of TbiTrigClock `0259381b` streamed through
[e5-filter.py](g2r3/e5-filter.py), collapsed with [e5-analyse.py](g2r3/e5-analyse.py)):**

1. Core 0 takes its CCOMPARE0 tick while core 1 is busy, runs 35 TBs into `_frxt_timer_int` and
   stops right after `wsr.ccompare0` (0x4008852b, rearming the next tick): the round robin switches
   to core 1 there, with core 0's tick handler unfinished.
2. Core 1 runs on (here: `digitalWrite(HIGH)`, `delayMicroseconds(10)`, `digitalWrite(LOW)`) until
   its slice ends: at the next virtual-timer deadline, or earlier when something re-arms a virtual
   timer. A pad frame answered with `J` does exactly that (the bridge arms the scheduled input),
   so the slice ends right after the LOW write.
3. Core 0 resumes at 0x4008852e and runs the rest of its tick, 427 TBs, while core 1 is frozen and
   simulated time advances: tick hook (interrupt-WDT feed: MWDT write-protect, config_stage, feed),
   `xTaskIncrementTick` (SMP spinlock), `vTaskSwitchContext` / `prvSelectHighestPriorityTaskSMP`,
   IDLE0 `esp_vApplicationIdleHook`, task-WDT feed, `waiti`. Core 1 then continues in `loop()`
   10.95 µs later than on silicon.

Without `J` the slice ends at the next deadline instead, so the same frozen interval falls
somewhere else (in TbiTrigClock, inside `delay(100)`, where nobody measures it). E1's fixed window
(539–549 µs) is the same three steps with the slice ending at a fixed deadline. So E1, E2's windows
and E5 are one effect: **core 0's tick work always runs while core 1 is frozen; where the ≈ 10 µs
lands depends on when core 1's slice ends** (timer deadlines, timer re-arming by the bridge).
Moving it cannot remove it: the ≈ 1 260 instructions must execute somewhere on the one virtual
clock. Only per-core time (option A) removes it.

Impact: any firmware measurement of µs timing (pulseIn, cycle-counter timestamps, software
protocols) can be off by up to ≈ 10–11 µs when an edge or an instruction sequence coincides with
the other core's activity; about 1 % of a millisecond per tick (≈ 0.6–1 % of edges); a dual-core
busy workload runs ×1.33 slower per core. Not caused by any image; present since R1.

### F-R2-2 — the 4 m HC-SR04 reading 1.09 µs short

**Cause.** `pulseIn` (arduino-esp32 3.3.12, `cores/esp32/wiring_pulse.c`) polls `digitalRead` in a
loop and returns `(ccount at fall seen − ccount at rise seen) / 240`, truncated. So
**reading = floor(W + δf − δr)**, where δr, δf ∈ [0, L) are the loop's detection delays and L is
one loop period. The oracle W = 23 295.091 µs has fraction 0.091, so δf − δr < −0.091 µs gives
23294. Measured with TbiHcSr04Abs (pulseIn's source inlined, absolute cycle counts, calibrated to
the bridge frames with TbiTrigClock's 0.583 µs from a write to the next cycle read): rise and
fall detected 0.63–1.04 µs after the exact echo edges (so L ≳ 1.05 µs under QEMU), δf − δr =
−0.38..+0.33 µs; 40 measurements: 29 × 23294, 11 × 23295. (The run's first trigger was 9.96 µs,
below the module's 10 µs minimum, and correctly got no echo: reading 0.)

- **Not specific to the first reading:** with phase-swept starts (E3) and tick-aligned starts the
  same firmware gives 23294 or 23295 depending on the loop phase at each edge; TbiHcSr04's first
  reading is simply the one whose phase gives 23294.
- **Subsequent readings:** TbiHcSr04's later readings start tick-aligned, so they repeat one phase
  (23295). E2 repeats at one phase: 23294/23295/23295.
- **The echo edges are exact** (to the ns, bridge record; rise/fall detected 0.63–1.04 µs after them).
- **Relation to F-R2-1:** not caused by the other-core interval (no 10 µs error; the readings are
  within one loop period), but F-R2-1 (E5) can shift the loop's phase before an edge and so
  decides *which* of the two values appears.
- **Same class on silicon:** pulseIn's polling quantisation exists on real hardware; under QEMU L
  is ≈ 1.9× longer (instruction speed, ADR-007), so ±1 µs flips occur more often.
- **T-R2-2 as written cannot hold for pulseIn on any platform:** truncation alone gives up to
  −1 µs, the polling adds ±L. A reading of W − 1.09 µs is a correct pulseIn result for W.

## 5. Options, effort, risks, recommendation

**F-R2-1**

| Option | Effect | Effort | Risks |
|---|---|---|---|
| A. Per-core virtual time in QEMU (lockstep quanta: each round every core runs ≤ Q instructions and time advances once) | removes the freeze down to Q (e.g. 32 instr = 0.26 µs), dual-core ×1.33 → ×1.0, E5 gone | 3–5 weeks incl. validation | QEMU core change (icount accounting, timers, warp, halted cores) on top of 0001/0005; slower (TB exit every Q per core; ×2–×5 estimate on the 1-vCPU host); new runtimeId → **every** fingerprint R1–S12 re-baselined; upstream unlikely. **Material architecture change** |
| B. Multi-threaded TCG with icount | — | — | not supported by QEMU (icount requires round-robin) |
| C. Single-core FreeRTOS firmware (`CONFIG_FREERTOS_UNICORE`) | no other core | 1–2 weeks (Arduino core libs rebuilt) | changes user firmware semantics (pinned tasks, loop core), diverges from real DevKit builds |
| D. Shorten core 0's tick work (e.g. idle-0 watchdog) | ~10 → ~6 µs | days | changes user firmware behaviour; does not remove the effect |
| E. Document and bound (no fix in V1) | limitation stated with measured bounds | 1 day | needs PM approval |

Recommendation: **E for V1/Alpha, A as a post-Alpha runtime spike** (1 week to measure Q vs speed
before any commitment). The E5 work is now named by an exec trace (above); no QEMU debug
build was needed.

**F-R2-2**

| Option | Effort | Note |
|---|---|---|
| Re-specify T-R2-2 from pulseIn's definition: reading ∈ [W − 1 − L, W + L] with L the firmware's measured loop period (≈ 1.05–1.3 µs here) | ½ day | derived from the algorithm, not fitted to pass; **needs PM approval** (it changes the 1 µs bound) |
| Keep 1 µs, measure with a capture peripheral (RMT/MCPWM capture) instead of pulseIn | 2–3 days + QEMU peripheral model | changes what the test covers; RMT capture is not modelled today |
| Keep 1 µs and leave the first-reading test red | 0 | test stays red until decided |

Recommendation: re-specify T-R2-2 as above (PM decision); keep the strict 1 µs on the bridge
(echo edges exact to the ns, already asserted).

**Pins:** establish the seven `s12-determinism` replacement pins from §2 (B column with the
proposed images, or A if the HC-SR04/LCD re-pins are not accepted) once F-R2-2's 4 m treatment is
decided.

## 6. Tests added (PM-approved)

- `runtime/tests/s12-bridge-timing.runtime.test.ts` + `runtime/firmware/arduino/TbiEdgeTime`
  (lock: `b85bf69d…`): bridge schedule within ±0.1 µs at 1 ms and 10 ms quanta; phase sweep
  strict ±0.1 µs — **fails today on F-R2-1** (no tolerance granted).
- `runtime/tests/s12-r2-timing.runtime.test.ts`: every echo equals the oracle for its trigger to
  the ns; every reading, the first included, within T-R2-2's 1 µs — **4 m fails today on F-R2-2**.
- s12-bridge's TbiEdgeEcho test is unchanged (end-to-end firmware coverage kept).
