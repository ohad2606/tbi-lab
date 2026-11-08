# Gate B — G-2 round 5: three decision packages (2026-10-11)

PM decision "G-2 Round 4" (conditional acceptance): `630b313`, `54e9ad1`, `171fb3f` pushed after
verifying diffs, file scope, clean tree and branch (`origin/sprint-12` = `171fb3f`). This round
prepares the three remaining decisions. Only new evidence is recorded; rounds 3 and 4
([G2-ROUND3.md](G2-ROUND3.md), [G2-ROUND4.md](G2-ROUND4.md)) stand. No QEMU scheduling change, no
pin, lock or tolerance change applied, no staging, dev-lab or production change; B4b–B7 not resumed.

## 1. F-R2-1 — V1 timing-fidelity contract

All figures are measurements on Runtime v2 `b5b34b49cb7e4049` (round 4 matrix
[mx-analysis.json](g2r4/mx-analysis.json), this round's [r5-analysis.json](g2r5/r5-analysis.json)).
**TBI Lab V1 does not claim unrestricted microsecond timing fidelity.** It claims:

| Dimension | V1 contract | Measured basis |
|---|---|---|
| **Electrical edge scheduling** (what the simulated world does) | **Exact.** Inputs the host schedules (sensor echoes, protocol responses) are applied at their exact simulated ns; GPIO outputs are timestamped at the exact simulated ns of the firmware's write. | HC-SR04: every echo = engine oracle to the ns (4 points, s12-r2-timing bridge cases); s12-bridge schedule seen within 0.1 µs (TbiEdgeTime) |
| **Firmware-visible input detection** (when firmware notices an edge) | Within the reading loop's polling period (pulseIn: L = 0.4534 µs), **except** for edges inside an interval where the reading core cannot run. With core 0 idle these are, per simulated ms: (a) the reading core's own tick interrupt (core 1 ≈ 4 µs, core 0 ≈ 25.6 µs, also present on silicon at about half the length); (b) **the other core's tick handler (F-R2-1): a blind interval of 10–12 µs**, or about 1.5 µs plus 10–12 µs when QEMU splits it, or one unsplit interval of up to about 13.3 µs. That is about 1.5–2 % of each ms. | polling latency max 12.3 µs (rise) / 12.1 µs (fall); pulseIn out-of-bound readings −11.1..+10.9 µs, every one with an edge in (a) or (b) (§2) |
| **Normal single-core Arduino workloads** (`setup()`/`loop()` on core 1, nothing pinned to core 0) | µs timing within ≈ 1–2 µs of exact outside the intervals; within the interval length (≤ ≈ 13 µs) inside them. Software-timed outputs are only ever **longer**, never shorter. `micros()`/`millis()` are exact (virtual time, constant call overhead). | output pulses +0.5..+2.1 µs typical, max +9.2 µs; tone half-periods max +11.7 µs; `micros()` constant −6.4..−9.3 µs call overhead, no drift |
| **Busy core 0** (a task on core 0 that keeps it running) | **Not supported for µs timing.** QEMU gives core 0 slices of up to ≈ 0.98 ms, during which core 1 is frozen. | freezes p90 0.97 ms; polling latency up to 240.7 µs; pulseIn −240..+236 µs; output pulses up to +238 µs |
| **Core 1 delay and scheduling** | `delay()`/`vTaskDelay()` on core 1 end at core 1's own tick, whose phase relative to core 0's tick depends on the image (0–477 µs seen). Periods built from `delay()` are preserved; the **phase** of the first wake-up after a change can be up to that offset later than on silicon. There is no claim about tick alignment between cores. | `delay(1)` always ends 758.88 µs into the ms in TbiApiMatrix (+477 µs vs the tick count); TbiTickPhase ≈ 40 µs; TbiTrigClock ≈ 0 |

### 1.1 Use cases: supported, limited, unsupported

| Class | Use case | Statement for V1 | Evidence |
|---|---|---|---|
| **Supported, verified** | DHT22 (library-free read, the V1 example) | Decodes exactly | 80/80 reads at 79 start phases; bit margin ≥ 11 µs to the threshold |
| | HC-SR04 distance via `pulseIn` | Reading within ⌊W ± L⌋ (±0.08 mm) for edges outside the intervals; worst measured ±11 µs = **±1.9 mm** on ≈ 1–3 % of readings | §2; s12-r2 3/3 |
| | I2C / Wire, LCD1602 | Bus timing comes from the I2C controller (D-9); a frozen CPU only lengthens gaps between transfers | s12-r3 3/3; 450 bus phases identical across images |
| | UART serial (content), Preferences/NVS | No timing dependence (UART bit timing is not modelled and not claimed) | s11/s12 suites |
| | DC electrical parts (resistor, LED, RGB LED, diode, BJT, relay, capacitor, PSU, button, switch, PIR, photoresistor, buzzer DC, LED matrix) | Operating points from the exact GPIO state per 10 ms window | determinism audits: 0 electrical discrepancies |
| | `millis()`, `micros()`, `delay()`-based loop periods | Exact (periods); see the phase limit below | §1 table |
| **Supported with a visible limitation** | Software-timed µs outputs (`delayMicroseconds` pulses, software tone, LED-matrix scan) | Up to +12 µs longer when a pulse spans an interval | 5/572 pulses > +3 µs; 11/1 990 half-periods > +3 µs |
| | Polling an input for µs events (`digitalRead` loops, `pulseIn`, MicroPython `time_pulse_us`) | Up to ≈ 13 µs late inside an interval | §1 table, §2 |
| | `delay()` phase on core 1 | The first wake-up can be up to one tick-offset (≤ 1 ms) late | `delay(1)` +477 µs |
| **Unsupported in V1** | µs-timed I/O in sketches that keep core 0 busy (`xTaskCreatePinnedToCore(…, 0)` work loops) | Off by up to ≈ 1 ms. Must be listed as unsupported | busy-core column |
| | Bit-banged protocols whose per-edge timing margin is below ≈ 13 µs (e.g. bit-banged WS2812, 1-Wire sampling) | Not claimed; such parts must not be added while F-R2-1 stands | interval length |
| | Cross-core timing relationships (inter-core latency, tick alignment) | Not modelled faithfully | §1 table |
| **Not measured: no claim** | `attachInterrupt` GPIO interrupt latency; LEDC PWM, RMT, hardware timers; Wi-Fi/BT | Out of the V1 evidence. No timing claim may be made | — |

### 1.2 Regression tests kept for the known failures (unchanged, red)

- `s12-bridge-timing` › phase sweep: fails at 548 µs, +1.12 µs. This is the F-R2-1 interval, visible at the strict 0.1 µs electrical criterion.
- `s12-r2-timing` › 4 m firmware case: first reading 23294 against 23 295.09, outside T-R2-2's 1 µs.
- The electrical criterion is unchanged: the four bridge cases still require each echo to equal the oracle to the ns.

## 2. F-R2-2 — the outstanding exception and the acceptance contract

### 2.1 The +0.91 µs reading: explained

Round 3, E2 core 1 (TbiPulseIn `9a722797…`): pulse #590, W = 23 295.091 µs, rise at 494.000 µs,
fall at 789.091 µs into the ms, reading 23296. That is one count above ⌊W + L⌋ = 23295.
Bare-bridge replays ([jobs](g2r5/), [r5-analysis.json](g2r5/r5-analysis.json)):

- **Reproduces exactly:** a full replay of the 591-pulse schedule gives 23296 again.
- **Periodic, not one-off:** the same pulse in 40 other milliseconds (same phases) gives 23296 in **40/40**.
- **A window, located by a 50 ns sweep** (rise 494.0, fall 788.00–790.60 µs):
  - falls at 788.00–788.30 µs read in bound;
  - **falls at 788.35–789.50 µs read 23296 (24/24 above the bound)**, i.e. they are seen at one fixed point about 1.5 µs after the window opens;
  - from 789.55 µs the readings are in bound again;
  - one further point, 790.10 µs, read 23307 (+10.9 µs).
- **What runs in it, from function-entry markers** (tbiprof, [r5-marks.txt](g2r5/r5-marks.txt)):
  - With the fall at 789.0 µs, core 0 takes its tick interrupt immediately before core 1's detection: `_UserExceptionVector` → `_xt_lowint1` → context save → `_frxt_timer_int`. That is **187 instructions ≈ 1.5 µs, with core 1 frozen**.
  - With the fall at 788.0 µs, the same entry runs just *after* the detection, and the reading is in bound.
  - This is the first segment of the round-3 E5 split: the round robin switches out of core 0 at `wsr.ccompare0`. The remainder of that tick (≈ 10–12 µs) is the 260–288 µs window seen in this image.
- **The 790.10 µs point:** in that run core 0 ran its **whole** tick in one slice: entry, `xPortSysTickHandler`, `xTaskIncrementTick`, `vTaskSwitchContext`, the IDLE hook, the WDT feed and `waiti`. That is ≈ 1 660 instructions ≈ 13 µs, immediately before the detection. Replayed in isolation, the same pulse reads 23296 (in bound): whether the tick is split depends on where the round-robin slices fall. Each run is deterministic; the split does not repeat when the run history differs.

**Disposition.** The +0.91 µs case is F-R2-1 (the other core's tick entry), not a failure of the
pulseIn bound. **Every out-of-bound reading in every data set now has an edge in an identified
interval**: E2 core 1 12/12, E2 core 0 13/13, E3 1/1, matrix 9/9 and 5/5, this round's sweep 25/25.
No unexplained measurement remains.

### 2.2 Proposed acceptance contract (two tiers; for decision, not applied)

1. **Electrical echo fidelity (strict, unchanged):** each scheduled echo equals the oracle for its
   trigger, to the ns. Already a separate test case (`54e9ad1`); passes at all four points.
2. **Firmware-visible `pulseIn` fidelity:** a reading R of a pulse of width W must satisfy
   ⌊W − L⌋ ≤ R ≤ ⌊W + L⌋, with L = 0.4534 µs measured on this runtime, **for edges outside the
   documented intervals**. A reading outside it is accepted only if one of its edges lies in an
   interval identified for that image and |R − W| ≤ 13.5 µs. This holds with core 0 idle only; the
   busy-core-0 case is unsupported (§1).

**Options:**
- **(a) Adopt** tier 2 as the firmware criterion for R2 acceptance, and keep the T-R2-2 1 µs case
  as a named known-failure regression, still red. *Recommended:* the bound is derived from the code
  and every exception is explained.
- **(b) Keep** T-R2-2 at 1 µs as the only criterion. The 4 m case stays red, and Gate B closes with
  one documented failing test.

Under (a), the 4 m first reading (23294, W = 23 295.091) is inside ⌊W − L⌋ = 23294 and passes
without an exception.

## 3. Patch A vs Patch B — complete diff

**Correction to round 4:** the round-4 Patch B re-pinned only TbiHcSr04 and TbiLcd. The canonical
set is six images: TbiDht22 was already re-pinned in `97a4567`, and **TbiI2cProbe, TbiEdgeEcho and
TbiR1Scan** were missing. The complete patch is
[proposed-pins-B-full.patch](g2r5/proposed-pins-B-full.patch). It covers five lock entries (each
with `previousSha256`) plus the seven determinism pins. Patch A is unchanged
([g2r4](g2r4/proposed-pins-A-committed-images.patch)): the seven pins only, no lock change.

### 3.1 Firmware images

All new images are reproduced byte-exact by five independent clean builds
([g2-builds.txt](g2-builds.txt)). Old images embed host paths and are not reproducible from source.
Code is identical in every pair (normalised disassembly, round 4 §3).

| Image | Old sha256 (A keeps) | New sha256 (B pins) | Difference | Electrical | Timing |
|---|---|---|---|---|---|
| TbiDht22 | `a2e6b54c…c21820` | `1c9a0e52…5dcfaf3` (already pinned, `97a4567`) | host paths | identical | identical |
| TbiHcSr04 | `620e0627…85efba` | `9fd371b1…9677d5` | host paths (+64 B rodata) | identical operating points | app start +1.000 ms (cross-core startup race, round 4 §3); echo timing ns-identical; readings identical |
| TbiLcd | `2f70c09c…4bd4fd` | `d8819c06…e5e2e9` | host paths | identical (5/5 states) | −8/−9 ns |
| TbiI2cProbe | `6f75261c…bc3777` | `768f52b5…3e55` | host paths | identical (450 bus phases) | app start +1 ms; gaps ±96 ns; one STOP +19 ns |
| TbiEdgeEcho | `8cf4804d…5688de` | `6ceb6ac3…dea0c12` | host paths | n/a | +168 ns start; firmware polling latency phase-dependent in both |
| TbiR1Scan | `5ddd7129…8f60b3` | `b86f9c5e…e98a17` | host paths | same transitions per pad; 9/182 published events differ by 10 ms window attribution | +200 ns start; row durations from the same discrete set (304 ns steps); accumulated phase wanders 0.3–16.9 µs (round 4 §3, not a rate difference) |

### 3.2 Fingerprints (`s12-determinism`, fixed host)

| Scenario | Committed pin (old host) | A | B |
|---|---|---|---|
| hcsr04-0.1m | `2371e2174c387d9c` | `b0d9a191756612ba` | `a6174faf18931c61` |
| hcsr04-1m | `caa97d8064a84841` | `efe9ac9393687eb6` | `f5c51475cc5dac18` |
| hcsr04-4m | `43dba895631b86e4` | `188a0e63e70a16bf` | `ce7868f0e5352722` |
| dht22--10C-30RH | `85e3e8d5cf6c46bb` | `b87741773a4f3c7a` | same as A |
| dht22-21.5C-55.2RH | `838e065211c66629` | `414a2379065bc425` | same as A |
| dht22-60C-95RH | `afcb868539a8f893` | `10af087aa4803ee2` | same as A |
| lcd1602-hello | `2ec207126b9067ba` | `03d6e5f264ed9506` | same as A |

A and B differ only in the three HC-SR04 scenarios: the +1 ms start moves the setup reading's
windows from 0.89 to 0.90 s. Readings and operating points are identical (round 3 §2). Both
encode the 4 m first reading 23294.

### 3.3 Tests with the complete Patch B (applied temporarily, then reverted)

Every suite that uses one of the five re-pinned images, release runtime, fixed host
([pins-B-full-verify.txt](g2r5/pins-B-full-verify.txt)). Patch A's column is round 4
([test-status.txt](g2r4/test-status.txt)) plus its pin verification.

| Suite | Patch A (committed images) | Complete Patch B | Note |
|---|---|---|---|
| s12-determinism (3 runs/scenario) | 8/8 with A's pins | **8/8** with B's pins | |
| s12-bridge | 10/10 | **9/10: spacing test fails** | see below |
| s12-examples | 3/3 | 3/3 | |
| s12-r3 (TbiLcd, TbiI2cProbe) | 3/3 | 3/3 | |
| s12-r2 | 3/3 | 3/3 | |
| s12-r2-timing | 7 pass, 1 fail (4 m firmware, F-R2-2) | same: 7 pass, same 1 fail | bridge cases ns-exact in both |
| s12-bridge-timing | 1 pass, 1 fail (phase sweep, F-R2-1) | same | TbiEdgeTime is not re-pinned |
| r1-matrix-perf (TbiR1Scan) | pass | pass | |

**New finding under B: the s12-bridge spacing check fails with the reproducible TbiEdgeEcho.**
- The check asserts that consecutive edges, as timestamped by TbiEdgeEcho's `digitalRead` + `micros()` loop, keep their scheduled spacing within 5 µs.
- With `6ceb6ac3…` the spacing errors are 8, 1, 1, −9, 3, 5 and −8.09 µs ([s12-edges-B-full.json](g2r5/s12-edges-B-full.json)). All are inside the loop's measured ≈ 12 µs polling period (round 2, G2-EVIDENCE TbiEdgeEcho row). The old image passed only because of the phase its edges happened to fall at; its code is identical.
- The **electrical** spacing on the same schedule is checked separately by TbiEdgeTime (s12-bridge-timing, ±0.1 µs) and passes under both patches.
- **Not changed.** Round 2's proposal 4 (move the strict criterion to TbiEdgeTime and keep X-cancel and quantum equality in the EdgeEcho test) was never applied. This needs a PM decision: see §5.

**Fidelity tests that remain failing under either patch:**
- s12-r2-timing 4 m firmware (F-R2-2, §2);
- s12-bridge-timing phase sweep (F-R2-1, §1.2).

Under B, the s12-bridge spacing test is added to these until it is dispositioned.

### 3.4 Release artifact manifest (lock under Patch B)

| Artifact | sha256 | Reproducible from source | Used by |
|---|---|---|---|
| TbiBanks | `9ca3a5cea66e46a2b54f14f38e0b065f36bc8cf70398cc88fae421028930a03d` | yes | R1 suites |
| TbiGpioProof | `5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af` | yes | gate, s8-*, s12-bridge, s12-pace |
| TbiNvs | `23881828bd850c3c5786f17125b0fd0fecfd60975daa2130ebbf8156646e989d` | yes | isolation, r2-acceptance |
| TbiRestart | `a49d6ed8584b364f94d0af18e1e92313d15bb8babf6c228ca2084c31f78da54a` | yes | failures |
| TbiTiming | `2b6ab2fb7566f28c4d64241caa7c2496915625b6dc652bf342033bdc09afa151` | yes | timing, quantum |
| micropython | `23b8b47fdab856b33c44eb5911852e86c96dfeac2f1d2033dba8ddb6c681b0a1` | yes | MicroPython suites |
| TbiR1Scan | `b86f9c5e7d86d840fdaf31f0ac7531dc7e7c63456136dbcf9e7e84215ce98a17` | yes (B); old `5ddd7129…` no | r1-matrix-perf |
| TbiEdgeEcho | `6ceb6ac3bb0d1e60306d7f86bb1cb3f622a0293a84ea1b8e735036c35dea0c12` | yes (B); old `8cf4804d…` no | s12-bridge |
| TbiHcSr04 | `9fd371b1ea77a60fc19c4ec2122e191ec498639df3afc5a887954fe05d9677d5` | yes (B); old `620e0627…` no | s12-r2, s12-r2-timing, s12-determinism, c5 |
| TbiDht22 | `1c9a0e52d98cb433af249543f106c75b253c6232873717db90cc608a25dcfaf3` | yes | s12-r2, s12-determinism, c5 |
| TbiLcd | `d8819c06411561f952ca4a0ceaa09eb01d047ec7d9c831adff6f19f3b1e5e2e9` | yes (B); old `2f70c09c…` no | s12-r3, s12-determinism, c5 |
| TbiI2cProbe | `768f52b5cc6aaa0e42152c463e2e7215f56966b8b10e2e773604e9e3d8433e55` | yes (B); old `6f75261c…` no | s12-r3 |
| TbiEdgeTime | `b85bf69d17df101c06473d716b0b1e1c4457912e3870f14bed7d15ac0d086928` | yes | s12-bridge-timing |

Under B, **all 13 lock artifacts are reproducible from source**. Under A, five remain importable
only as pinned bytes (TI-S12-2 stays open). Toolchain: arduino-cli 1.5.1, arduino-esp32 3.3.12,
`esp32:esp32:esp32:FlashMode=dio`, SOURCE_DATE_EPOCH 1767225600. Runtime v2 `b5b34b49cb7e4049`
(QEMU 40edccac + 0001–0008). All 13 images are present and sha-verified in the release artifact
store.

## 4. Gate B and 30 November forecast

| Step (after PM acceptance) | Effort |
|---|---|
| Apply the accepted patch and contract (lock, pins, test split per §2 option), commit, push on approval | ≈ 0.5 day incl. a full local suite run |
| Staging re-install from the final commit; B4a re-run of the affected suites; the five staging-touching suites | ≈ 2 h |
| B4b R-MCU-1, B5 rollback rehearsal, B6 frontend checks, B7 C-5 dry run N = 1..3 | ≈ 3.5 h |
| **Gate B total** | **≈ 1–1.5 working days** from acceptance |

- **Gate B:** with acceptance by about 13 Oct, complete about 14–15 Oct. That is inside the
  13–31 Oct window, with about two weeks of float for Gate C (dev-lab, separate approval) and
  Owner Smoke.
- **30 November alpha:** unchanged at **≈ 60 %**. The runtime is no longer on the critical path:
  deferring the QEMU redesign removes the 3–5 week risk. The binding item remains the capacity
  decision D-1 by about 30 Oct and C-5 on alpha hardware by about 14 Nov.
- **New Sprint 14 work** (already in its scope as the "in-product unsupported list"): publish the
  §1 contract to users, including the busy-core-0 and bit-banging restrictions, and keep the
  curated examples single-core (they are today).

## 5. Decisions requested

1. **F-R2-1:** accept the §1 contract and the §1.1 matrix as the V1 statement, with the two
   regression tests kept red.
2. **F-R2-2:** option (a) or (b) of §2.2.
3. **Firmware:** Patch A, or the complete Patch B (recommended). Then approve applying it and
   re-establishing the pins at 10 runs.
   - With B, also decide how to handle s12-bridge's 5 µs EdgeEcho spacing assertion. It measures firmware polling (≈ 12 µs loop), not the bridge.
   - **(i) Recommended:** apply round 2's proposal 4. The strict spacing criterion lives in TbiEdgeTime (±0.1 µs, passing); the EdgeEcho test keeps edge order, X-cancel and 1 ms/10 ms equality.
   - **(ii)** Leave TbiEdgeEcho out of B and keep its old, non-reproducible pin.
