# Gate B — G-2 final resolution package (2026-10-11)

PM decision "G-2 Round 5" (conditional acceptance):
- `c608cf5` pushed (`origin/sprint-12` = `c608cf5`).
- The bounded V1 timing contract approved, with explicit conditions.
- Patch B conditionally approved, with proposal 4(i).
- F-R2-2: return the exact options; the numerical `pulseIn` contract is unchanged until decided.

This round applies Patch B and the test changes in **one local commit, not pushed**, and returns the
package below. No staging, dev-lab or production change; B4b–B7 not resumed; no merge, tag or
sprint closure.

## 1. F-R2-2 — exact options

Applies to the firmware-visible HC-SR04 `pulseIn` reading. W = engine oracle echo width;
R = the firmware's reading in µs; L = 0.4534 µs, `pulseIn`'s polling period measured on Runtime v2
`b5b34b49cb7e4049` (G2-ROUND4 §2).

### Option (a) — adopt the derived contract

> **T-R2-2 (revised).** For every HC-SR04 echo whose rise and fall both lie outside the
> CPU-unavailable intervals documented for the firmware image, the firmware's `pulseIn` reading
> satisfies ⌊W − L⌋ ≤ R ≤ ⌊W + L⌋. A reading outside this bound is accepted only if at least one
> of its edges lies in a documented interval and |R − W| ≤ 13.5 µs. The contract holds for sketches
> with core 0 idle; µs timing with a busy core 0 is unsupported. The former 1 µs bound is kept as a
> known-failure regression test that matches only the documented case: the 4 m session's first
> reading, 23294 against 23 295.091.

Consequences:
- **Tests.** `s12-r2-timing`'s four firmware cases assert the formula, with no exceptions needed:
  every reading in these scenarios, including the 4 m first reading (23294 = ⌊W − L⌋), is inside
  it. A fifth case, *KNOWN FAILURE (F-R2-2)*, keeps the 1 µs bound. It passes only while exactly
  that one reading misses 1 µs: any other reading outside 1 µs is an unexpected failure, and no
  reading outside it is an unexpected pass. Both fail the case.
- **Product statement.** HC-SR04 readings within one count (±0.08 mm) of the oracle; up to
  ±13.5 µs (±2.3 mm) on the ≈ 1–3 % of readings whose edges fall in an interval.
- **Gate B** closes with all acceptance cases green and two known-failure cases reported
  separately (F-R2-1 and F-R2-2).
- **Effort:** ≈ 2 h (test change plus one suite run).

### Option (b) — keep T-R2-2 at 1 µs

> **T-R2-2 (unchanged).** Every firmware `pulseIn` reading is within 1 µs of the oracle width.

Consequences:
- **Tests.** The 4 m firmware case fails in every run (23294 vs 23 295.091, −1.091 µs). Gate B
  either closes with this documented failing test, or the case gets the same mechanism-matched
  known-failure handling; that handling is a test change, not a criterion change.
- **Achievability.** The criterion is not achievable in general. `pulseIn` truncates and polls, so
  R can be ⌊W − L⌋ for any W whose fraction is below L. On silicon the shorter polling period
  narrows this but does not remove it.
- **Product statement.** HC-SR04 readings within 1 µs (±0.17 mm), with a documented exception at
  4 m.
- **Effort:** none.

**Recommendation: (a).** The bound is derived from `wiring_pulse.c`, not fitted, and every reading
outside it in every data set is attributed to a documented interval (G2-ROUND5 §2).

## 2. Patch B — final changes and fingerprints (applied in the local commit)

Lock (`runtime/firmware/artifacts.lock.json`): five re-pins, each recording `previousSha256`.

| Image | Previous | Pinned |
|---|---|---|
| TbiR1Scan | `5ddd712902b1ac514f095b319a685de7f5a2a5da5e47bba49b167dbcee8f60b3` | `b86f9c5e7d86d840fdaf31f0ac7531dc7e7c63456136dbcf9e7e84215ce98a17` |
| TbiEdgeEcho | `8cf4804dc1ba37f5c1afc9acdb22498200c31b40a5e3a39715bafc6c625688de` | `6ceb6ac3bb0d1e60306d7f86bb1cb3f622a0293a84ea1b8e735036c35dea0c12` |
| TbiHcSr04 | `620e06276aeaa4512e79a9c65c7d3200fbd2aaaba333137e11ffcdac9b85efba` | `9fd371b1ea77a60fc19c4ec2122e191ec498639df3afc5a887954fe05d9677d5` |
| TbiLcd | `2f70c09c14f7686bd6671c925adeabcb5564fb2de5ad8989b6c78c108e4bd4fd` | `d8819c06411561f952ca4a0ceaa09eb01d047ec7d9c831adff6f19f3b1e5e2e9` |
| TbiI2cProbe | `6f75261c61a610e5bb6c30cda1c9b112cf26fe6df2c05de09a3eb7460bbc3777` | `768f52b5cc6aaa0e42152c463e2e7215f56966b8b10e2e773604e9e3d8433e55` |

TbiDht22 (`1c9a0e52…`, `97a4567`) and TbiEdgeTime (`b85bf69d…`) were already reproducible.
**All 13 lock artifacts are reproducible from source**; the manifest is G2-ROUND5 §3.4 and is
unchanged.

`s12-determinism` pins, re-established with 10 runs under the final state:

| Scenario | Previous pin (old host, old images) | Pin (10/10 identical) |
|---|---|---|
| hcsr04-0.1m | `2371e2174c387d9c` | `a6174faf18931c61` |
| hcsr04-1m | `caa97d8064a84841` | `f5c51475cc5dac18` |
| hcsr04-4m | `43dba895631b86e4` | `ce7868f0e5352722` |
| dht22--10C-30RH | `85e3e8d5cf6c46bb` | `b87741773a4f3c7a` |
| dht22-21.5C-55.2RH | `838e065211c66629` | `414a2379065bc425` |
| dht22-60C-95RH | `afcb868539a8f893` | `10af087aa4803ee2` |
| lcd1602-hello | `2ec207126b9067ba` | `03d6e5f264ed9506` |

Ten runs per scenario, all identical, all equal to the pins prepared in round 4
([determinism-10x.txt](g2final/determinism-10x.txt)). The HC-SR04 pins encode the 4 m first
reading 23294 (F-R2-2).

## 3. Test changes

| Test | Change | Kind |
|---|---|---|
| `s12-bridge` | The 5 µs spacing case is split in two (proposal 4(i)). **(1)** *Every scheduled edge is observed in order, none lost or invented; X cancels; 1 ms and 10 ms quanta agree* (acceptance). **(2)** *Firmware-visible: every edge seen within one TbiEdgeEcho polling period*: latency spread ≤ 13 µs + 1 µs `micros()` truncation (separate firmware-visible coverage) | split; new bound derived from the measured loop (below) |
| `s12-bridge-timing` | The schedule case is unchanged (strict 0.1 µs electrical edge accuracy). The sweep case becomes *KNOWN FAILURE (F-R2-1)*, mechanism-matched (below) | expected-failure handling |
| `s12-determinism` | The seven pins (above) | baseline replacement |
| `s12-r2-timing` | **Unchanged.** The 4 m firmware case stays red until the F-R2-2 decision | — |

**Expected-failure handling** (`s12-bridge-timing`, F-R2-1), per the PM's conditions:
- **Matches only the documented mechanism.** The image's interval was measured in round 3, E1:
  edges at 539.0–548.8 µs into the ms are seen at 549.05–549.15 µs. The case asserts three things:
  - every edge outside the interval is within 0.1 µs;
  - every late edge lies in the interval and is seen at 549.0–549.2 µs;
  - every sweep edge well inside the interval is late.
- **Unexpected failure fails the case:** an edge late outside the interval, or seen anywhere other
  than at the interval's end.
- **Unexpected pass fails the case** with "unexpected pass: F-R2-1 no longer reproduces;
  investigate before changing this case".
- **Stays in CI.** It is an ordinary test case, nothing is skipped, and its name begins with
  `KNOWN FAILURE (F-R2-1)` so it is reported apart from acceptance cases. Its evidence file records
  `knownFailure: 'F-R2-1'`.

### 3.1 EdgeEcho −9 µs: firmware polling, not event loss (verified)

Bare-bridge run of `6ceb6ac3…`, 200 pulses with the rise phase stepped by 0.1 µs, plus `tbiprof`
([ee-analysis.json](g2final/ee-analysis.json), [tool](g2final/tools/ee-analyse.py)):

- **No event loss:** 400 of 400 scheduled edges observed, in order. On the s12-bridge schedule
  itself, 8 of 8 edges are observed in order and the cancelled group never is. TbiEdgeTime sees the
  same schedule within 0.1 µs (s12-bridge-timing).
- **Polling:** the EdgeEcho loop (`digitalRead`, `micros()`, and two function-local statics whose
  C++ guard takes a FreeRTOS mutex every iteration) runs 1 922 times in 25 ms, i.e. **13.0 µs per
  iteration**. Edge latency is 0–12.0 µs (396 edges). The s12-bridge errors (8, 1, 1, −9, 3, 5,
  −8.09 µs) are differences of such latencies (spread 10 µs). The old image's 5 µs pass depended
  on its phase only; its code is identical.
- **New finding: lock-holder preemption (an F-R2-1 sub-mechanism).** 4 of the 200 sweep rises were
  272–278 µs late. Traced ([ee-stall-marks.txt](g2final/ee-stall-marks.txt)):
  1. Core 1 takes a FreeRTOS spinlock (`xPortEnterCriticalTimeout`, inside the guard's mutex give).
  2. QEMU's round robin switches to core 0, which requests the same lock and spins
     (2 232 iterations, ≈ 47 000 instructions) for its whole slice. The caller on core 0 was not
     identified.
  3. Core 1, which holds the lock, is frozen until the slice ends, then releases it.

  On silicon both cores run, so the holder releases within µs. **No edge is lost; it is seen
  late.** It affects core-1 code that enters critical sections at a high rate: mutexes, queues,
  guarded statics, some driver calls. It does not apply to `pulseIn` or `digitalRead` polling
  without locks; the DHT22 and HC-SR04 data show none of it.

## 4. Remaining known limitations (V1 contract, approved bounds)

| Id | Limitation | Bound measured | Condition / scope | Test |
|---|---|---|---|---|
| F-R2-1a | Other core's tick: the polling core is blind | 10–12 µs; ≈ 1.5 + 10–12 µs when split; ≤ ≈ 13.3 µs unsplit | once per simulated ms, image-dependent phase | s12-bridge-timing KNOWN FAILURE |
| F-R2-1b | Own-core tick interrupt (also on silicon, ≈ 2× shorter there) | core 1 ≈ 4 µs, core 0 ≈ 25.6 µs | once per ms | — |
| F-R2-1c | **Busy core 0**: core 1 frozen | up to 0.98 ms | any sketch keeping core 0 running: **unsupported for µs timing** | matrix evidence |
| F-R2-1d | **Lock-holder preemption** (new) | 272–278 µs freezes (2 % of edges in the EdgeEcho sweep) | core-1 code taking FreeRTOS spinlocks at a high rate | EdgeEcho evidence; firmware-visible case on a fixed schedule |
| F-R2-1e | `delay()` wake-up phase on core 1 | 0–477 µs (image-dependent tick offset) | phase only; periods exact | matrix evidence |
| F-R2-1f | Startup cross-core race quantised to a tick | app start +1 ms in 2 of 6 images | startup timing only | determinism pins |
| F-R2-2 | `pulseIn` polling and truncation | ⌊W − L⌋..⌊W + L⌋, L = 0.4534 µs | decision §1 | s12-r2-timing 4 m (red) |
| — | UART bit timing; interrupt latency (`attachInterrupt`); LEDC, RMT and hardware timers; Wi-Fi/BT | not modelled or not measured | no claim | — |

**Conditions for every supported timing-sensitive feature** (the approved contract's conditions):

- **DHT22 read:** core 0 idle.
- **HC-SR04:** core 0 idle; error bound per §1.
- **Software µs outputs:** core 0 idle; outputs only ever longer, by ≤ 12 µs.
- **Polling inputs:** core 0 idle; no high-rate locking in the polling loop.
- **`delay()` periods:** exact in length; their phase is limited by F-R2-1e.
- **I2C:** controller-timed.
- **Never claimed:** unrestricted µs fidelity.

## 5. Results and Gate B readiness

Final state (Patch B plus the test changes), release runtime, fixed host, run sequentially
([final-results.txt](g2final/final-results.txt)):

| Suite | Acceptance cases | Known failures (reported separately) |
|---|---|---|
| s12-determinism (10 runs) | 8/8 pass | — |
| s12-bridge | 11/11 pass (incl. both 4(i) cases) | — |
| s12-bridge-timing | 1/1 pass (schedule, 0.1 µs) | KNOWN FAILURE (F-R2-1): reproduced exactly as documented (edge at 548 µs seen at 549.121 µs; 239/240 sweep edges within 0.1 µs) |
| s12-r2-timing | 7/8: all 4 bridge cases (ns-exact) and 3 firmware cases pass | **4 m firmware case fails** (23294 vs 23 295.091): left red, unannotated, pending the F-R2-2 decision |
| s12-r2, s12-r3, s12-examples, s12-pace | 3/3, 3/3, 3/3, 1/1 | — |
| r1-matrix-perf (TbiR1Scan) | pass | — |
| Unit (119 files) | 1026/1026 | — |
| typecheck, lint | pass | — |

**Guard check:** with the documented interval moved temporarily, the known-failure case failed
with "unexpected failure outside F-R2-1: {phaseUs 548, lateNs 1121}". The file was restored.

**Not run:** the five staging suites (s8-containment, s8-policy, s8-qemu-tasks, s8-deployed-policy,
s11-deployed). They touch staging and belong to the post-acceptance re-install.

**Gate B readiness:** ready to resume once the PM accepts this package and decides F-R2-2.
Remaining steps:
1. F-R2-2 test change, option (a) only: ≈ 2 h.
2. Push the local commit.
3. Staging re-install from the final commit, B4a re-runs and the five staging suites: ≈ 2 h.
4. B4b–B7: ≈ 3.5 h.

Total ≈ 1 working day. With acceptance by about 13 Oct, Gate B completes about 14 Oct, inside the
13–31 Oct window. The 30 November forecast is unchanged (≈ 60 %, bound by D-1 by about 30 Oct).
The new lock-holder limitation adds one line to Sprint 14's in-product unsupported list.
