# Sprint 25 — Engineering reliability, MicroPython hardening, Runtime v5

DEV only (`tbi-lab-srv`). Branch `sprint-25`, from the DEV-Lab build `9dd2fd6` (`dev-lab-s24p`).

## Runtime v5 (QEMU patch 0012)

Runtime id `39f2229a66d45e43` = Espressif QEMU `40edccac` + patches 0001–0012. Patch 0012 is
clean-room from the ESP32 TRM v5.9 (Register 6.30; Table 21.3-1) and the pinned ESP-IDF 3.3.12
`gpio_ll.h` / `i2c_ll.h`. It adds three bridge capabilities; everything older is unchanged.

| Capability | Wire format | Meaning |
|---|---|---|
| `input-read` | host `Z <pad> <0\|1>`; QEMU `N <vns> <mask>` | The host marks pads with no defensible level. A guest read of GPIO_IN/GPIO_IN1 while such a pad is not driving is reported at the read; the host ends the session there. |
| `gpio-irq` | (no frame) | Edge interrupts (INT_TYPE 1 rising, 2 falling, 3 any) per CPU (INT_ENA bit 2 PRO, bit 0 APP), through new per-CPU interrupt-matrix inputs. Level types, NMI/SDIO enables and wake-up enable stay `U gpio-interrupt` (refused by name). |
| `i2c-clock` | `B <vns> <bus> S <addr> <rw> <cycles>` | Every START carries the SCL period in 80 MHz cycles (TRM Table 21.3-1: (LOW+1) + HIGH + 7, or + 8 / + 6 + threshold with the SCL filter). Rise time is excluded, so 80 MHz / cycles is an upper bound of the real clock. |

Programs built for a v5 runtime `require` the capabilities they rely on, so a rolled-back v4
runtime refuses them at the handshake instead of running them unchecked.

## Phase 1 — floating GPIO inputs (P0)

Before: an ESP32 input with nothing holding its net was solved through the leakage model's
numerical reference to 0 V and read as LOW; an unwired pin read 0 (the emulator's reset value); a
first read between V_IL and V_IH was LOW. None of these is characterised physics
(`~/tbi-s24/evidence/m2-input/FINDING-floating-input.md`).

After (Runtime v5):
- Which pins a program reads comes from the build (`programInputReads`: literal and constant pins of
  `pinMode(…, INPUT…)`, `digitalRead`, `Pin(…)`, interrupt pins). A read the analysis cannot
  resolve (computed pin, `gpio_get_level`, a register read), or firmware it did not analyse
  (prebuilt, reference images), makes every wired pad watched.
- A watched pad in input mode is marked undefined when: nothing drives its net (the engine's
  `logic_input_floating` rule: no resistive or source path; junctions, capacitors and input pads
  do not drive), an undetermined logic level reaches it, nothing is wired to it, or its voltage is
  between V_IL (0.825 V) and V_IH (2.475 V) (closure: whatever the previous level; see below).
- When the firmware reads the input register while such a pad is not driving, the session ends at
  that virtual time: `gpio_input_undefined` (EN/HE, the pin and why). No LOW or HIGH is ever
  substituted, and no output that follows the read reaches the user.
- Internal pull resistors stay refused at Build (they are not simulated); the messages say so.
- Unread pins are untouched (their behaviour, and their determinism baselines, do not change).
- Editor checks: `gpio_input_floating` reworded (the run stops at such a read);
  `gpio_input_unconnected` (new) for a pin the program reads with nothing wired to it.
- Examples corrected: `esp32-blink` no longer reads the unconnected GPIO5; `esp32-input-echo`,
  `esp32-bench`, `esp32-motion-relay` and `esp32-night-light` no longer read the unconnected
  GPIO35/36/39 (they now use example sketches in `app/tests/exampleSketches`; the runtime test
  firmware TbiBanks/TbiGpioProof is unchanged).

Limitation: the runtime sees the register read, not the bit the program uses. A read of GPIO_IN
while another pad of the same register that the program also reads is undefined is refused too.

## Phase 2 — I2C (P0)

| Path | Before | After |
|---|---|---|
| Arduino `Wire.requestFrom` from the LCD backpack | returned the PCF8574 output latch (not the port levels: those depend on the HD44780 pins and the backpack wiring, e.g. P3's backlight transistor) | refused at the read: `i2c_read_unsupported` |
| A read from an address no part has | released bus 0xFF after the address NACK | unchanged (physically defined) |
| `Wire.setClock` / `Wire.begin(…, freq)` | unchecked | the programmed SCL period is checked at every START to the display: above the PCF8574's 100 kHz, `i2c_clock_exceeded` |
| MicroPython `machine.I2C` | freq ≤ 100 kHz checked at Build; reads refused at Build | unchanged, plus the same runtime clock check |

Measured on real QEMU v5: the shipped example (`Wire.begin(21, 22, 100000)`) runs and shows its
text; `Wire.setClock(400000)` is refused at exactly 400 000 Hz (the TRM formula reproduces the
IDF's register values exactly); `Wire.requestFrom(0x27, 1)` is refused and nothing it would have
returned is printed.

## Phase 3 — potentiometer (P1)

Bourns PTV09A datasheet REV. 01/25 (FACTS.md §12):
- Total resistance: only the standard table, 1, 2, 5, 10, 20, 50, 100, 200, 500 kΩ and 1 MΩ,
  chosen from a list in the Inspector. Any other value is refused by the editor (`not_standard`)
  and by the engine (named, with the standard values). Saved projects with another value still
  open (nothing is migrated); they must pick a standard value to run.
- End-of-track residual resistance: the datasheet gives only a bound ("500 ohms or ±1 % max."),
  read as the larger of the two (the sheet does not say which applies). The model keeps an ideal
  0 Ω contact (ASSUMPTION POT-1, unchanged). New: whenever a segment is shorter than that bound,
  the result says the values depending on that end are the ideal-track limit, not an exact
  prediction, and shows the bound.
- Ratings: unchanged warnings (0.05 W whole track, the derived rated-condition track current per
  segment and at the wiper, 20 VDC). No damage model: the datasheet publishes no damage threshold.
- Live wiper on the 0.01 % grid during Run: unchanged.

## Phase 4 — ESP32 + potentiometer (P1)

Examples `esp32-pot-threshold` (Arduino) and `mpy-pot-threshold` (MicroPython): a 10 kΩ PTV09A
across the 3.3 V supply, wiper to GPIO34 read as a digital level, GPIO4 drives an LED. Real-QEMU
test `runtime/tests/s25-pot.runtime.test.ts`, both languages: 10 % reads LOW (wiper 0.3300 V, the
reference engine's value to 1e-9 V, the pad's 50 nA leakage included); turned live to 90 % reads
HIGH with the LED at the reference output-high current (to 1e-12 A); 50 % (1.65 V) keeps HIGH; 10 %
reads LOW again. A run that starts at 50 % is refused at the first read (`between_thresholds`).

ADC: **BLOCKED** in both languages. `analogRead` and `machine.ADC` stay refused: QEMU's SAR ADC
crashes the guest and no measured transfer function exists. No analog reading is simulated.

## Phase 5 — GPIO interrupts (P2, Runtime v5)

Real firmware (`runtime/firmware/arduino/TbiIrq`, ordinary `attachInterrupt`), edges scheduled at
exact virtual times off the command grid, each ISR answering with one register write whose virtual
time the runtime reports (`runtime/tests/s25-irq.runtime.test.ts`):
- CHANGE on GPIO4, RISING on GPIO5, FALLING on GPIO13: every edge of the selected type ran its ISR
  exactly once, in order; no edge of another type did (60 edges, 40 ISR answers).
- Latency edge → ISR's first output write: 2.136 µs (CHANGE, 20/20), 2.216 µs (RISING 10/10,
  FALLING 10/10); identical across runs (deterministic).
- `attachInterrupt(…, ONHIGH)` (level): the session ends at the register write, naming the facility.
- MicroPython `Pin.irq(trigger=IRQ_RISING|IRQ_FALLING)` is allowed on Runtime v5 (it uses the same
  hardware path); wake triggers stay refused.

Known: QEMU runs the two cores in turn (F-R2-1), so an edge that arrives while the other core
holds the slice is served at the slice's end (seen for polling in Sprint 12; not exercised by
this schedule, whose answers were all ~2.2 µs).

## Phase 6 — manifest and tablet

The web app manifest is emitted as `assets/manifest-<hash>.json`: a static file server's MIME table
(Go's, under Caddy) has no type for `.webmanifest`, which was served without a Content-Type;
`.json` is served as `application/json`, which browsers accept for manifests. No server
configuration changes. The manifest keeps `"id": "/"`, so installed apps keep their identity.

## Phase 7 — routing

The GND-post lead hook (owner screenshot 4) stays a known limitation: the only prototype fixed 2 of
12 cases and added 13 crossings elsewhere (`data/deferred-post-fan-prototype.patch`), which fails
this sprint's low-risk rule. Nothing in routing changed.

## Independent review

A review of the first commit (4a46fcf) found two highs and two mediums, all fixed before the
runtime used for every result below (`39f2229a66d45e43`):
- H1: an edge interrupt armed on a pad with no level would have fired from it. Now arming one is
  reported like a read (`N`), at the arming (`s25-irq` H1 test).
- H2: when every pin is watched, the board's unwired pins read LOW silently. They are now marked
  `unconnected` too, so a register read while one is undefined is refused.
- M1: an open-drain pad that releases its line is not driving (`esp32_gpio_driving()`).
- M2: the read analysis follows constant arrays, range-for, balanced parentheses and `pulseIn`;
  `shiftIn`, `rtc_gpio_get_level`, `gpio_ll_get_level`, register reads and `Pin` under another name
  make it unresolved.
Documented, not changed: register-level granularity (M3, above); the hold band keeps the previous
level (M4, owner decision); peripheral-routed pads; a multi-pad message names the first cause.

## Tests

Real QEMU, Runtime v5 `39f2229a66d45e43` (frozen at `~/tbi-s25-rt-release`, checksums verified):
- `s25-irq` 4/4, `s25-pot` 3/3, `s25-i2c` 3/3 (figures above). MicroPython `Pin.irq`: 20/20 edges,
  latency 18.9–29.4 µs (the scheduled handler).
- Whole runtime suite (except `s8-containment`, never run on this host). The failures that are not
  Sprint 25's were measured on the Sprint 24 source (9dd2fd6) with Runtime v4 in an isolated home:
  - pre-existing, identical on 9dd2fd6 + v4: the 7 R2 tests built on the gate workload (sessions
    end `psu_sinking` at 0.89 s: the Sprint 22 rule "supplies never sink", bab7064) and `s19b-x1`
    (`logic_supply_current_uncharacterized` at create: Sprint 21, 8c825e9; the same request as the
    `esp32-logic-and` example). Not changed in this sprint.
  - Sprint 25 behaviour, tests updated: builds on v5 report `inputReads` and require `input-read`
    (and `i2c-clock` with `i2c`); `Pin.irq` is delivered (the probe arms it on an unconnected pin and
    is refused, `gpio_input_undefined`); the DHT22 without a pull-up is refused at the read instead
    of reading the leakage model's LOW; the malformed-reply fault uses an unused verb (`Z` is now
    v5's); the core-seed test seeds Arduino sketches only.
  - Prebuilt reference firmware: test tickets carry the input reads the build analysis gives for the
    firmware's source (as a build would). The R1 examples and the MicroPython button's Arduino twin
    run the examples' own sketch on v5 (TbiBanks also reads the unconnected GPIO35/36/39).
  - Determinism pins: the engine's new `levelUndefined` field is the only difference in the
    Sprint 12 and R1 streams (with it removed every stream hashes to its previous pin exactly, v4
    and v5: `~/tbi-s25/evidence/drift`); re-pinned. R1 on v5 runs another firmware: new pins.
- Unit: 203 files, 1992 passed, 3 skipped (the real `mpy-cross` tests, covered by the real-QEMU
  MicroPython suites). Typecheck and lint clean.
- Full runtime suite on 4ff4089 also showed the R1 slices, `r1-matrix-perf`, `r2-led-bench` and
  `s13-pad-short` failing: their pinned test firmware reads inputs the test circuits leave unwired,
  which v5 refuses (correctly). The tests now hold those inputs LOW through 10 kΩ, or run the
  example's own sketch (7851942); 15/15 on v5. The browser fixtures (fake build service and Session
  Host) learned the corrected example sketches: e2e 309 passed, 0 failed.

## Staging findings (fixed before DEV-Lab)

Installing on staging (`tbi-s8`) with Runtime v5 found two defects no test had exercised:
- The build service's start-up reader of `runtime.json` kept its own list of capability tokens
  (the v4 set) and refused `gpio-irq`, `i2c-clock` and `input-read`: the service did not start
  (restart loop, fail closed). It now checks against the bridge's canonical list (aa0fbae,
  `runtime/builder/runtimeJson.ts`, unit-tested). The deploy kit now refuses a service that
  restarts after an install or a rollback.
- A curated example built before this sprint ran with that older build's feature record (no
  `inputReads`): the rebuild of a system source is recorded under `global`, the user's own older
  record of the same image stayed, and both the cache and the run ticket preferred it. The runtime
  then watched every pin and refused the first unwired one (`esp32-distance-alarm` on staging).
  The service now uses the current record (analyzer version and profile hash) for both (4e9eeef,
  unit test reproduces it). DEV-Lab testers who built a curated example under Sprint 24 hold such
  records: without this fix their examples would have been refused after the upgrade.

## Deployment (DEV-Lab, 2026-10-31)

DEV-Lab (`tbi-lab-srv`) runs `4e9eeef` on Runtime v5 `39f2229a66d45e43` (frozen at
`~/tbi-s25-rt-release`, checksums verified before the deploy), release artifact set
`fc854ca8236611a4` (adds TbiIrq/TbiIrqLevel), package manifest `e2ee35ae822b1c7e` (built twice,
byte-identical). It replaced `9dd2fd6` on Runtime v4 `cd778dc17d8edcdd`.

Gates, in order: unit, typecheck, lint; e2e 309 passed, 0 failed; staging `tbi-s8` with real QEMU
v5 (S25 cases 6/6, the earlier real browser suites 34 passed, 2 skipped by design: s6, s11, s12, s19b, s20-logic,
s15, s18, s18f, s13; one s6 run hit the staging creation rate and passed on its re-run); backup
verified; deploy (only `tbi-qemu@.service`'s runtime bind and `runtime.json` change; polkit,
Caddy, the gate drop-in, policy and keys unchanged; both services active with 0 restarts); rollback
rehearsed back to `9dd2fd6`/v4 (1.5 s) and forward (1.4 s); browser acceptance through the gate,
real QEMU, 11/11 (version and manifest JSON, the pot example on desktop and tablet in EN and HE,
the S25 cases).

After a rollback to Runtime v4, builds made for v5 require `input-read` (and `i2c-clock` with
I2C), so by design v4 refuses them at the handshake by name (fail closed). The `9dd2fd6` build
service would reuse those records (their analyzer version, 3, is newer than its own, 2), so
building again may not clear it: a real rollback should also remove the Sprint 25 build records.
The rehearsal checked the services, units, links and identities, not a session on v4.

## Closure (2026-10-31)

### GPIO undefined region: no hold (P1)

Evidence: ESP32 Series Datasheet v5.3 (sha256 `a7917e6b…cd29adf`), Table 5-3 "DC
Characteristics (3.3 V, 25 °C)", gives V_IH min 0.75 × VDD and V_IL max 0.25 × VDD and **no
input hysteresis or Schmitt-trigger parameter**; the ESP32 Technical Reference Manual v5.9
(sha256 `1007b90e…40a64b82`, IO_MUX/GPIO chapter: FUN_IE, FUN_WPU/WPD, FUN_DRV, MCU_SEL) has no
hysteresis control or figure either (full-text search of both documents: no match for
"hysteresis" or "Schmitt"). Keeping the previous level through the band is therefore not a
guaranteed behaviour of the relevant input. Decision (per the closure directive):

- A watched pad (one the program may read, or an armed edge interrupt) whose solved voltage is
  strictly between V_IL and V_IH is marked undefined, **whatever it read before**; the next
  register read (or the arming / delivery check of an edge interrupt, review H1) ends the session
  with `gpio_input_undefined` / `between_thresholds` and the solved voltage. At or below V_IL is
  LOW, at or above V_IH is HIGH (unchanged).
- Scheduled sensor responses (HC-SR04 echo, DHT22 frame): a response that would put a watched
  input pad in the band cannot be given as levels; it is not scheduled and the session ends before
  it with its own code, `sensor_level_undefined` (the sensor, the board, the pin and the voltage;
  EN/HE) — not as a read the firmware never made (review M1).
- PWM (A1 averaging): for a watched input, entering or leaving the band between the operating
  points is a change (`pwm_input_unsupported`), never "the previous level"; unwatched inputs keep
  the earlier rule (review M2).
- Unwatched pads and runtimes without `input-read` (v4 and older) keep the level QEMU was last
  given; the firmware cannot read it there on v5 without that being refused. The R1 reference
  harness (`runtime/harness/closedLoop.ts`, the v1 bridge oracle used by `electrical.runtime`)
  keeps its documented hold semantics: it is a reference loop with no input-read path, not a
  product path.
- Texts: the band message and the pot / night-light example summaries (EN, HE) say the datasheet
  specifies no hysteresis, so a read there stops the run.

Tests: host (fake runtime) band-after-HIGH refusal with the solved voltage (fails on the previous
code: `floating`); HC-SR04 echo into the band; PWM band change; real QEMU: Arduino and MicroPython
pot 10 → 90 → 10 → 90 → 50 % refused at the read; Arduino `attachInterrupt(CHANGE)` and
MicroPython `Pin.irq` on the wiper pin (edges counted at 90 % and 10 %, then 50 % refused while
armed); the photoresistor real test (bright, dark, bright, then the band refused).

### Read granularity (P2): kept register-wide

Arduino-ESP32 3.3.12 `digitalRead` → `gpio_get_level` → `gpio_ll_get_level`
(`hal/esp32/include/hal/gpio_ll.h:534`): one 32-bit load of `GPIO_IN` (GPIO0–31) or `GPIO_IN1`
(GPIO32–39), then a shift and mask in the CPU. MicroPython's `Pin.value()` uses the same HAL. The
GPIO peripheral (and so the emulator's device model) sees only the bus read; which bit the
program keeps is decided by later CPU instructions. Narrowing the refusal per bit would need
data-flow tracking of the loaded value inside TCG, or a guess from the next instruction or the
application source — neither is a faithful representation, and guessing is excluded. The refusal
therefore stays per register and per watched pad: only pads the analysis says the program may
read (or every pad, when its reads cannot be resolved) are ever marked, and the two registers are
separate. Consequence (documented limitation): a read of one watched pin is refused while another
watched pin of the same register is undefined; a program whose reads cannot be resolved is
refused at any read while an unwired user pin of that register is undefined.

### Independent review (closure round)

No High finding. Fixed: M1 (sensor refusal reported as a read: now `sensor_level_undefined`, and
only for input-mode pads), M2 (PWM band state applied to unwatched pads), M3 (the record tool now
reads, backs up and deletes inside one write transaction, deleting a row only if it still holds the
backed-up record), L6 (lease comment), L8 (rollback script: restarts the build service on any
failed step, re-checks for a live session before the restarts, keeps the full database copy
root-owned outside the tool's writable paths), L9 (a malformed backup line is reported by number,
never quoted), L10 (unresolved reads share one sentence). Documented, not changed:
- L4: while the operating point is a placeholder (Sprint 17C; at most until the refusal one tick
  later) the firmware gets no input change and no `Z` mark, so a read inside that window sees the
  last level QEMU was given. Pre-existing; the session is refused if the state lasts.
- L5: on runtimes without `input-read` (v4 and older; i.e. after a rollback) the band keeps the
  previous level, the v4 semantics.
- L7: a record whose profile has no loaded provider counts as current (lease only; submit checks
  the provider first).

### Diagnostics

- `gpio_input_undefined` names each pin with its own cause (one sentence per cause, EN/HE); before,
  every pin was described with the first pin's cause.

### Build records and runtime identity (P4)

- A build record now stores the runtime capabilities its analysis assumed (`capabilities`); a
  record analysed for another set (or written before the field) is not reused: it is built again
  (same image, a feature report for this runtime). Arduino's cache key did not name the runtime,
  so before this a record analysed for v5 (`requires: input-read`) could be reused for v4.
- `runtime/builder/records.ts` (CLI `records-cli.ts`): lists the build records whose `requires`
  names a capability a target runtime.json does not announce; backs them up (JSON lines, verified
  before deletion, never overwritten), deletes exactly those rows by primary key in one
  transaction, and restores them without overwriting a rebuilt row. Prebuilt (uploaded) grants,
  records the target can run, artifact files and projects are never touched. Output carries counts
  and artifact prefixes only, never a principal.

### Gates (closure head a0c2b85; f695238 adds one test-only change)

| Gate | Result |
|---|---|
| Typecheck / lint | clean |
| Unit (vitest) | 2005 passed, 0 failed, 3 skipped (3c4cbd6) |
| Browser e2e | 309 passed, 0 failed, 40 skipped (a0c2b85) |
| Full runtime suite, Runtime v5 39f2229a66d45e43 (s8-containment excluded: DEV-Lab restart tests, never run on this host) | 218 passed, 9 failed, 19 skipped of 246 (3c4cbd6); the 2 test-fixture defects fixed and re-run (a0c2b85): 4/4 |
| Real-QEMU closure cases | s25-pot 5/5, s25-irq 4/4, s25-i2c 3/3, r1-ldr 1/1 |
| Reproducible package | two builds of a0c2b85 IDENTICAL, 34 files, manifest 93e7d99e8b953b3a |
| Staging tbi-s8 (a0c2b85) browser, real QEMU | s25-real 6/6; batches 16+11+5 passed, 2 skipped by design; s13-live 2/2 after its test update (f695238); 0 restarts |
| DEV-Lab acceptance (a0c2b85) | 11/11 |

Runtime-suite failures, classified (baseline: the same files on 9dd2fd6 + Runtime v4 failed the
same way, except as noted):

| Test | Class |
|---|---|
| r2-acceptance: gate workload, quantum 1 vs 10 ms, R1 equivalence; r2-failures: isolation, failure injection, resource measurements (6) | previously known: expected refusal following corrected physics (S22 `psu_sinking`: the R1 gate workload holds VEXT at 0 V while GPIO2 drives 3.3 V through 20 kΩ into it, at 0.89 s). No fixture can avoid it at 0 V: a workload redesign is an owner decision. |
| s19b-x1 (1) | previously known: expected refusal following corrected physics (S21 `logic_supply_current_uncharacterized`, owner decision Q7) |
| r1-determinism night-light (1) | expected refusal following corrected physics (this closure): the v5 workload's 20 lx step is inside the band. Fixed (test): 1 -> 300 -> 1 lx on v5, re-pinned 9cd2a738b4ffffde (3 runs, reproduced in a second invocation); earlier runtimes keep their schedule and pins. |
| s8-qemu-tasks (1) | test fixture defect: its sketch was the pre-S25 TbiBanks, no longer a curated source, so other principals' leases were correctly refused ("ticket"). Fixed: the current esp32-input-echo program. |
| r2-failures client disconnect over SSE | failed on the v4 baseline and the 4ff4089 run, passes now (timing-sensitive; not claimed fixed) |
| s13-live-real night-light drag (staging browser) | expected refusal following corrected physics: a drag across the LDR divider reads GPIO34 at 865 mV. Test updated (f695238). |

No new regression.

### Rollback rehearsal (DEV-Lab, 2026-10-31)

| Step | Result |
|---|---|
| deploy a0c2b85 (from 4e9eeef, Runtime v5) | 5.5 s; units, polkit, Caddy, policy, keys unchanged; 0 restarts |
| back to 9dd2fd6 / Runtime v4 cd778dc17d8edcdd | 1.6 s; build service stopped; full grants DB copied (root-only, `/var/lib/tbi-build/rollback-20261031T121543Z-db`); 21 of 112 rows listed and removed (19 shared curated records, 2 rows of 1 user; all `requires: input-read`, 3 also `i2c-clock`), backed up first (`…/rollback-20261031T121543Z/removed.jsonl`, verified); after: 91 rows, 0 incompatible; 0 restarts |
| v4 Build / Run / Stop (browser through the gate) | 4/4: esp32-blink (v4 prewarm record), esp32-lcd-hello (compiled), mpy-blink (compiled); records afterwards: 99, 0 incompatible with v4 |
| forward to a0c2b85 / Runtime v5 | 0.8 s; units and runtime.json byte-equal to the forward set; 0 restarts |
| v5 Build / Run / Stop | 4/4; esp32-lcd-hello and mpy-blink compiled (no v4 record reused: records without the v5 capability binding are never current) |

Nothing else was touched: prebuilt grants, the artifact store, projects and the policy are as
they were. DEV-Lab ends on a0c2b85 / Runtime v5.

