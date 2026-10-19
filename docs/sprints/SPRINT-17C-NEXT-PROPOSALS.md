# Sprint 17C — next-sprint proposals (DEV, 2026-10-19)

Proposals only: nothing here is implemented. Evidence was gathered on DEV (`tbi-lab-srv`) on the
R4 branch (`sprint-15-r4`), Runtime v3 `2cb1406f94f52e4f`, with the pinned firmware of
`runtime/firmware/artifacts.lock.json`.

## 1. Component Failure Framework: gaps

What exists (Sprint 13 H2, extended by R4): datasheet limits per part, kept separate as
`absolute` (damage risk), `operating` (outside the specified range) and `unrated` (no published
limit); an `outsideModelRange` flag when an operating point leaves a model's validity range;
model-limitation notes; ESP32 pad checks (source/sink, contention, shorts, over-voltage,
cumulative current); under PWM the ratings use the peak, not the average. By decision there is
no damage modelling and no invented limit.

Gaps found or confirmed this sprint, by how misleading the display can be:

| # | Gap | Evidence | Effect today | Proposal |
|---|---|---|---|---|
| F1 | **Parts with an unmodelled current hide it from everything upstream.** The SG90 draws no modelled current (R4-D3) | Sprint 17C: a supply wired straight to a servo now names it ("does not include the current drawn by …"); a servo fed **through a resistor** still sees the full supply voltage and moves | Readings named; the indirect case shows a servo working where a real one would brown out | A *stiff-supply rule* for unknown-current parts: simulate them only when their VCC/GND nets are a supply output and ground directly (or through ideal contacts); otherwise hold + an `operating` notice "supply path not modelled". Small engine + host change, no new numbers |
| F2 | **Resistors have no power rating** | `packages/engine/src/ratings.ts` header: "Resistors carry no power rating in V1" | 100 Ω across 5 V (250 mW) passes silently | A catalog `ratedPower` parameter (default unrated, explicit ¼ W choice), `power` check as `absolute`. Needs a product decision on the default |
| F3 | **No time dimension in ratings.** Peaks are checked against continuous (DC) maxima | `app/src/sim/ratings.ts` `peakOutcome` | Conservative: a short PWM pulse within a datasheet's *pulsed* rating still warns | Keep conservative; add the pulsed-current rows only where a datasheet gives them with duty and width (TLHY5400/TLHG4900 cards do), as a separate code |
| F4 | **An overstress is not sticky.** A warning disappears when the operating point recovers | ratings are recomputed per published outcome | A brief absolute-max excursion (e.g. a transient PWM state) can be missed by the user | Keep "no damage modelling", but latch "exceeded at t = …" per part for the session, shown until Stop |
| F5 | **Supply regulation dynamics** | Sprint 17C M6: a PSU that current-limits during part of each PWM cycle is now refused (`pwm_supply_limited`) | Refused, honest | No change proposed; listed so the refusal is not mistaken for a model |
| F6 | **Pad drive strength** (P1 finding, GPIO16/17 driver 40 vs 20 mA) and **duty 0 (O-R4-1)** | `docs/sprints/s13-evidence/h2/BENCH-PROTOCOL.md` | Both fail closed; both need one bench session | Owner bench session: protocol §4 (duty 0) and the P1 rows in one sitting |
| F7 | **MCU-side failures are outside the framework.** A firmware using an unmodelled peripheral crashes or runs dead silently when no build-time analysis exists | MicroPython probe below: `ADC.read_u16()` → Guru Meditation; `Pin.irq` accepted, never fires | Only relevant once a runtime without static analysis exists | Runtime-side refusal frames from QEMU for unmodelled peripheral access (SENS/ADC, GPIO interrupt enable), named like `pwm_unsupported` |

Recommended order: F1 and F4 (small, remove misleading displays), then F6 (owner bench), then F2
(needs a default decided), F3 and F7 later.

## 2. MicroPython runtime on the classic ESP32: feasibility

**Evidence (probe on Runtime v3, MicroPython ESP32_GENERIC v1.29.0, pinned image `23b8b47f…`,
REPL driven over the bridge's serial input; temporary test, not committed; results in
`~/tbi-s15-rt/results/s17c-mpy-probe*.json`):**

| Area | Result |
|---|---|
| Boot | to the REPL in ~2.7 s of simulated time (R1 measured ~1 s to first output) |
| `machine.PWM` | uses **high-speed** LEDC channels: `PWM(Pin(18), freq=1000, duty_u16=16384)` → timer 0 on APB, div 313/256, 16 bit = 998.4 Hz (MicroPython reports `freq=998`), duty 16384/65536 = 25 % exactly; a second PWM at 50 Hz moves to timer 1; `deinit()` pauses the timers and idles the channels. All states the R4 host already models |
| `machine.I2C` | `I2C(0, scl=22, sda=21).scan()` runs through the R3 bridge (336 bus phases, all NACK → `[]`) |
| `machine.ADC` | `ADC(Pin(34)).read_u16()` **crashes the guest** (Guru Meditation, cache error) and reboots: the ADC is not emulated |
| `Pin.irq` | accepted silently; GPIO interrupts are not modelled, so a callback would never fire |
| `time.sleep_us(500)` | measured 515 µs by `ticks_us` |
| Determinism | frame stream and serial output byte-identical across two runs |
| Resources | QEMU RSS ~77 MB (peak ~112 MB); ~9.7 s CPU for ~8 s simulated at the REPL |
| Serial input | a burst of more than ~256 bytes is lost (the line was cut); paced input works |

**Conclusion: feasible, but not a small step.** The emulator and bridge already run MicroPython,
and PWM/I2C/GPIO need no new runtime work. What a product needs that does not exist:

1. **Code delivery**: either raw-paste mode over serial (flow-controlled; the plain REPL drops
   bursts, shown above) or writing `main.py` into the image's filesystem partition at "build"
   time (deterministic, no serial dependency). The second is preferable.
2. **Fail-closed analysis**: Arduino relies on linked-symbol analysis at build time; Python has
   none. Unmodelled facilities (ADC, interrupts, Wi-Fi, touch, DAC, sleep) must be refused at
   run time by the emulator (see F7), or the user sees a crash or dead behaviour.
3. **Product surface**: editor mode, examples, EN/HE errors (Python tracebacks pass through
   serial), capability panel entries, and the builder/ticket path for a non-compiled program.
4. **Versioning**: the MicroPython image becomes a pinned product artifact (today a test image).

Proposed next step (if approved): a time-boxed probe sprint with exit criteria (a) `main.py`
injected into the filesystem image deterministically, (b) QEMU refusal frames for ADC and GPIO
interrupts, (c) one example (blink + PWM fade) through the Session Host, end to end. No product
UI until those pass.
