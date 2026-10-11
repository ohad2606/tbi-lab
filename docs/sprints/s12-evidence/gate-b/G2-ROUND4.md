# Gate B — G-2 round 4: targeted validation (2026-10-11)

PM confirmation "G-2 Round 3": push `bd26ec5`, `8073ccc`, `211ccff` (done, `origin/sprint-12` =
`211ccff`); targeted validation items 1–6. Only new evidence is recorded here; round 3
([G2-ROUND3.md](G2-ROUND3.md)) stands except where corrected below. No staging, dev-lab,
production or infrastructure change; no pin or tolerance changed; B4b–B7 not resumed.

## Method

- **Bare-bridge jobs** ([zz-jobs](g2r4/tools/zz-jobs.runtime.test.ts.txt)): an image on the real
  Runtime v2 bridge (`b5b34b49cb7e4049`) with scheduled inputs; every pad frame recorded at its
  exact simulated ns. DHT22 through the real Session Host ([zz-dhtsweep](g2r4/tools/zz-dhtsweep.runtime.test.ts.txt)).
- **`tbiprof` QEMU plugin** ([tbiprof.c](g2r4/tools/tbiprof.c), diagnostic, not shipped): counts
  executed instructions per translated block and per vCPU, the length of every round-robin slice,
  and optional function-entry markers. Observation only: a run with and without it gives
  byte-identical pad frames (all ns times) and serial output, identical to round 3's E5 data.
- Diagnostic firmware ([firmware/](g2r4/firmware/)): TbiApiMatrix (`aed07cf2…`), TbiDhtSweep
  (`b9d693e5…`), TbiTickPhase (`8341f29e…`), built with the pinned toolchain into the release
  artifact store; not product artifacts, not in the lock.

## 1. F-R2-1 impact matrix (supported APIs and components)

TbiApiMatrix runs every section twice: core 0 idle (the normal Arduino case: `loop()` on core 1),
and with a busy task on core 0 (`xTaskCreatePinnedToCore`, busy 100 000-iteration loops with
`vTaskDelay(1)` between them). All errors are against the bridge's exact edge times. Analysis:
[mx-analysis.json](g2r4/mx-analysis.json) ([mx-analyse.py](g2r4/tools/mx-analyse.py)).

**New mechanism measured (core 0 busy):** with both cores runnable, QEMU's round robin gives core 0
slices of up to a timer deadline: **p90 121 130 instructions ≈ 0.97 ms**, max 0.98 ms (core 0 idle:
p50 1 421, p99 2 495 instructions ≈ 20 µs). Core 1 is frozen for each of them. Round 3's ×1.33 was
the average of this; the per-event freeze is up to ~1 ms.

**New mechanism measured (both cases): inter-core tick offset.** Each core takes its own FreeRTOS
tick, but the two tick timers are not aligned as on silicon: their offset depends on how the cores
interleaved at scheduler start. TbiApiMatrix: core 0's tick (tick count incremented) at 270–282 µs
into the simulated ms, core 1's at ≈ 750 µs ([TbiTickPhase](g2r4/tickphase-serial.txt) on its own
image: core 1 tick ISR 4.0 µs, core 0 tick ISR 25.6 µs, offset ≈ 40 µs; TbiTrigClock ≈ 0). A task
on core 1 unblocked by the tick resumes only at core 1's own tick, so `delay()` ends that offset late.

| API / component | Effect class | Core 0 idle (measured) | Core 0 busy (measured) |
|---|---|---|---|
| `digitalWrite` + `delayMicroseconds(w)` output pulse (w = 2, 10, 50, 500 µs; 572 pulses, start phase swept) | output only ever **longer** | typical +0.5..+2.1 µs (call/poll overhead); 5/572 > +3 µs, max **+9.2 µs** (pulse spans the other core's interval) | 83/572 > +3 µs, max **+238 µs** |
| Software tone, `delayMicroseconds(500)` half periods (buzzer, LED-matrix scan class; 1 990) | longer only | typical +1.36 µs; 11 > +3 µs, max **+11.7 µs** | 23 > +3 µs, max **+224 µs** |
| `delay(1)` / `vTaskDelay` on core 1 (195, start swept) | ends at core 1's tick | always ends at 758.88 µs into the ms: **+477 µs** vs the tick count in this image (image-dependent offset, 0–477 µs seen); loop periods made of `delay()` unchanged | ends at 515–787 µs phases |
| `micros()` / `millis()` (95 intervals vs bridge) | exact (virtual time) | constant −6.4..−9.3 µs = call overhead of the bracketing calls; no drift | same (−5.2..−9.1) |
| `digitalRead` polling latency (300 edges each way, phase swept) | input seen late | rise p50 1.07, p99 4.8, max **12.3 µs**; fall p50 1.18, max 12.1 (edges at 270–274 µs: other core; 750 µs: own tick) | rise p90 24.8, max **97.9 µs**; fall p90 147.6, max **240.7 µs** |
| `pulseIn` (287 + 287 pulses, 100–2 197 µs) | see §2 | 278/287 within the polling bound; outside: −11.1..+8.3 µs | 158/287 within; −240..+236 µs |
| `pulseIn` with interrupts masked | other core only | 282/287 within; outside −10.1..+6.9 µs | 215/288 within; −124..+131 µs |
| MicroPython `machine.time_pulse_us` (124 pulses) | as pulseIn | −1.83..+2.96 µs (no reading hit an interval) | not measured |
| DHT22, library-free read (Session Host; 80 reads, 79 start phases) | polled protocol | **80/80 exact** (`T 215 H 550` = 21.5 °C / 55 %); bit high times 16–37 µs (0) and 60–80 µs (1): ±11 µs, margin ≥ 11 µs to the 48 µs threshold | not measured; by the polling latencies above (up to 241 µs) a DHT22 read on a loaded dual-core sketch would fail |
| HC-SR04 (`pulseIn`) | §2 | echo edges exact to the ns (s12-r2-timing bridge cases) | — |
| I2C / Wire / LCD1602 | controller-timed | transfers run on the I2C controller's own timing (D-9); a frozen CPU only lengthens gaps between transfers (round 2: 450 bus phases identical, one ±1.26 µs pair); HD44780 waits only get longer | not measured |
| Serial (UART0) | content | lossless; UART bit timing is not modelled, so no timing claim exists | — |
| Preferences (NVS) | none | no timing dependence | — |
| Dual-core FreeRTOS tasks | throughput and freezes | — | busy loop ×1.33 slower (round 3); freezes up to 0.98 ms |
| Resistor, LED, RGB LED (digital), diode, BJT, relay, capacitor, PSU, ground, push button, toggle switch, PIR, photoresistor (digital threshold only), buzzer (DC), LED matrix | electrical | operating point per 10 ms window from the exact GPIO state: unaffected. User controls act at ms scale. Matrix/buzzer driven by software timing fall in the tone row | as idle, firmware timing as above |

**Summary.** With core 0 idle (default Arduino sketches), µs timing seen by firmware is
within ≈ 1–2 µs of the exact time except in the other core's ≈ 10–12 µs interval per ms
(≈ 1 % of the ms); outputs only get longer; `delay()` ends up to the inter-core tick offset late
(up to 477 µs observed). With **both cores busy**, firmware-visible timing is off by up to ~1 ms:
any µs-timed protocol on such a sketch is unreliable under the current runtime.

## 2. `pulseIn()` acceptance bounds (F-R2-2)

**Polling period measured.** pulseIn's `WAIT_FOR_PIN_STATE` iteration on a static pin, interrupts
masked, for 2 000 µs: 4 411 iterations → **L = 0.4534 µs** (≈ 57 instructions at 8 ns; includes one
counter add of 8 ns). With core 0 busy: 0.5316 µs effective. Round 3's estimate (L ≳ 1.05 µs) was
the detection latency, not the period, and is withdrawn.

**Bound (derived from the algorithm, not fitted).** `reading = ⌊W + u_f − u_r + c⌋`, u ∈ [0, L) the
polling phase at each edge, c the constant path difference (≤ a few ns). Hence

  ⌊W − L⌋ ≤ reading ≤ ⌊W + L⌋, i.e. W − 1 − L < reading ≤ W + L  (−1.45 µs .. +0.45 µs here),

for a pulse whose two edges do not fall into an interval where the measuring core cannot run.

| Data set | Readings | Within the bound | Outside | Every outside reading has an edge in |
|---|---|---|---|---|
| TbiApiMatrix, interrupts on | 287 | 278 | 9 (−11.1..+8.3 µs) | all 9: 270–280 µs (other core) or 749–754 µs (own tick ISR) |
| TbiApiMatrix, interrupts masked | 287 | 282 | 5 (−10.1..+6.9 µs) | all 5: 540–547 µs (other core; masking moves it) |
| Round 3 E2, core 1, two runs | 690 + 690 | 678 + 678 | 12 + 12 (identical runs) | 11 of 12: 260–288 µs or 750–751 µs; 1 (+0.91 µs): fall at 789.1 µs, inside the window core 0 shows in that image (not identified for core 1) |
| Round 3 E2, core 0, two runs | 690 + 690 | 677 + 677 | 13 + 13 | all 13: 754–808 µs (core 0's own tick ISR and the other core) |
| Round 3 E3 HC-SR04 0.1 / 1 / 4 m | 41 / 41 / 41 | 41 / 40 / 41 | 0 / 1 (+4.2 µs) / 0 | 1 m: fall at 276.2 µs; 4 m: both 23294 and 23295 inside |

In-bound readings span −1.38..+0.23 µs against W. The HC-SR04 4 m first reading (23294 vs
W = 23 295.091) is inside the bound: F-R2-2 is fully explained by pulseIn's polling and truncation.
The intervals are F-R2-1 (other core) and the measuring core's own interrupts (physical on silicon
too, but ≈ 2× longer under QEMU's instruction speed). On silicon L is shorter, so the same formula
gives a tighter bound.

**Not applied.** T-R2-2 stays 1 µs; `s12-r2-timing` 4 m firmware case stays red. Decision below.

## 3. Canonical firmware equivalence (six images)

[elfdiff.py](g2r4/tools/elfdiff.py), [eq-prof.json](g2r4/eq-prof.json), [su-prof.json](g2r4/su-prof.json).

- **Code is identical.** In all six old/new pairs every function's instructions are identical
  after address normalisation (1 637–1 740 functions each; the 5 flagged regions per pair are
  literal pools/data that objdump disassembles). Section sizes are identical except
  `.flash.rodata`: the old images carry two host-path strings (+64 bytes, e.g. TbiHcSr04 52 424 vs
  52 360). No behavioural code difference exists.
- **Boot.** Serial output is identical to the ns up to app entry (`entry 0x4008059c` at
  301 080 472 ns in every pair). ROM/bootloader execute +499 / −469 instructions (hashing the longer
  image); app startup then re-synchronises on timer polling.
- **The +1 ms start (TbiHcSr04, TbiI2cProbe).** Function-entry markers (579 functions, startup until
  `setup()`): both images execute the **same 3 221 function entries in the same order** until, 273 ms
  into app startup, core 0 starts a flash operation (`s_do_unmapping` →
  `spi_flash_disable_interrupts_caches_and_other_cpu`) and needs core 1. In the old image core 1
  answers before its tick 272/273 boundary, in the new one after it; startup continues exactly one
  tick (1 ms) later and the sequences realign. At that point the images differ by ≈ 40 executed
  instructions (from `esp_clk_init` on). This is a cross-core race whose outcome the emulator's round
  robin quantises to a tick (F-R2-1 class); on silicon both cores run concurrently.
- **Sub-µs starts.** TbiDht22 0 ns (only the boot difference), TbiLcd −8/−9 ns, TbiEdgeEcho
  +168 ns, TbiR1Scan +200 ns: residual offsets of 1–25 instructions from startup spin loops.
- **TbiR1Scan "20 ppm" — correction to round 2.** Not an instruction-count difference (the code is
  identical). Each scan row lasts one of the same discrete durations in both images (1 006.576,
  1 006.880, 1 007.400, 1 007.704 µs, …: `delayMicroseconds` polls in 304 ns steps); which one a row
  gets depends on its phase. From a 200 ns start offset the selections diverge and the accumulated
  difference wanders, 0.3 → 16.9 µs over 2 575 rows ([r1-drift.json](g2r4/r1-drift.json)).

**Conclusion:** the six canonical images are functionally, electrically and protocol-wise
equivalent to the committed ones. Their only difference is data layout (no host paths), which
shifts startup by sub-µs amounts and, in two images, by one tick through the emulator's cross-core
scheduling.

## 4. Seven replacement determinism fingerprints (prepared, not applied)

Two patches, each verified by applying it temporarily and running `s12-determinism` (3 runs per
scenario), then reverting; round 3 established the values at 10/10.

- [proposed-pins-A-committed-images.patch](g2r4/proposed-pins-A-committed-images.patch): the seven
  pins with the committed images. Verification: [pins-A-committed-images-verify.txt](g2r4/pins-A-committed-images-verify.txt).
- [proposed-pins-B-canonical-images.patch](g2r4/proposed-pins-B-canonical-images.patch): the seven
  pins plus the TbiHcSr04 and TbiLcd lock re-pins. Verification: [pins-B-canonical-images-verify.txt](g2r4/pins-B-canonical-images-verify.txt).

Both encode the 4 m reading of 23294 (inside the §2 bound, outside T-R2-2).

## 5. Strict bridge-edge vs firmware-visible tests

`s12-r2-timing` now runs one session per point and reports two separate cases: **bridge** (each echo
equals the engine oracle for its trigger, to the ns) and **firmware** (each `pulseIn` reading within
T-R2-2's unchanged 1 µs) — local commit `54e9ad1`. `s12-bridge-timing` (TbiEdgeTime, ±0.1 µs) and
s12-bridge's TbiEdgeEcho test are unchanged.

## 6. Test status (this round, fixed host, release runtime; [test-status.txt](g2r4/test-status.txt))

| Suite | Result | Note |
|---|---|---|
| s12-bridge | 10/10 pass | TbiEdgeEcho end-to-end unchanged |
| s12-examples, s12-r3, s12-r2, s12-pace | 3/3, 3/3, 3/3, 1/1 pass | |
| s12-r2-timing | 7 pass, **1 fail** | all 4 bridge cases pass (echo = oracle to the ns); firmware 4 m fails on T-R2-2 (23294 vs 23295.09; F-R2-2, inside the §2 bound) |
| s12-bridge-timing | 1 pass, **1 fail** | s12-bridge schedule ±0.1 µs passes; phase sweep fails at 548 µs, +1.12 µs (F-R2-1) |
| s12-determinism (committed pins) | **7 fail**, 1 pass | expected: pins predate the H-1 fix; patches A and B each pass 8/8 (3 runs) |
| Unit (119 files) | 1026/1026 pass | typecheck and lint pass |
| s8-containment, s8-policy, s8-qemu-tasks, s8-deployed-policy, s11-deployed | **pending** | touch staging; not run (no staging changes) |
| Earlier R1/R2/S11 runtime suites | not re-run this round | runtime and host code unchanged since round 3 (98/98 then) |
| B4a re-runs, B4b–B7 | **pending** | not resumed |
