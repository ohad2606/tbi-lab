# R4 feasibility probe — LEDC waveform on the pinned runtime (2026-10-12)

Scope (PM, Sprint 13 review): the approved two-day probe, isolated scratch environment only. **No
product code, no runtime patch in the repo, no deployment.** Exit criterion (R4 architecture, R4-P):
"0009 on the pinned tree; the 3.3.12 driver's register sequence observed; `W` correct for
`analogWrite` and for a 50 Hz servo". Time used: Day 1 (of 2).

## 1. Environment (scratch, outside the repo)

| Item | Value |
|---|---|
| Location | `~/tbi-s13-r4probe/` (QEMU tree, two builds, runs, tools); removed after the decision |
| QEMU source | pinned `40edccac…` + patches 0001–0008 (Runtime v2) + a scratch edit of `hw/misc/esp32_ledc.c` only |
| Build A | `--enable-plugins` variant (first trace) |
| Build B | exactly the `provision.sh` configure flags (continuity check, final `W` run) |
| Scratch edit (`scratch-ledc-probe.diff`, evidence only, never a runtime patch) | (1) a register trace: every LEDC read/write with its virtual time, to stderr; (2) a "0009 core": the waveform as a pure function of register state, printed at each `duty_start`. Neither talks to the bridge |
| Probe firmware | 3 sketches built by the normal `provision.sh firmware` path, arduino-esp32 3.3.12: `R4ProbeAnalog` `c105e165…`, `R4ProbeLedc` `df4c848c…`, `R4ProbeServo` `84582687…` (never added to the lock or the repo) |
| Isolation | a scratch `TBI_RUNTIME_HOME` (own `qemu-current`, own `results/`; artifacts read-only) so no release evidence was touched |

## 2. Sources

| Document | Version | Used for |
|---|---|---|
| ESP32 TRM | v5.8 (`4ba58e9f…`) ch. 28 LED_PWM | divider (10.8 fixed point), counter overflow at 2^res − 1, hpoint/duty latch rule, glitch-free HS timer update, duty dithering bits |
| IDF `driver/ledc.h` (pinned 3.3.12 libs, `8ac4036f…`) | 3.3.12 | "the new LEDC parameters don't take effect until the next PWM cycle"; duty range [0, 2^res] |
| IDF `hal/ledc_ll.h` (esp32) | 3.3.12 | register fields |

## 3. Observed driver register sequence (all three sketches, identical shape)

`ledcAttach` / `analogWrite` on the first use, then each `ledcWrite`:

| Step | Register (offset) | Value (analogWrite, GPIO2) | Meaning |
|---|---|---|---|
| 1 | HSTIMER0_CONF (0x140) | `0x00007d08`, RST pulsed 1→0 | res 8, div 0x3E8/256 = 3.90625, REF_TICK |
| 2 | HSCH0_HPOINT (0x004) | 0 | |
| 3 | HSCH0_DUTY (0x008) | duty << 4 | 4 fractional (dither) bits = 0 |
| 4 | HSCH0_CONF1 (0x00c) | `0x40100400` | duty_inc 1, num 1, cycle 1, scale 0 (no fade) |
| 5 | HSCH0_CONF0 (0x000) | 4 | timer 0, sig_out_en |
| 6 | HSCH0_CONF1 | `0x80000000` | **duty_start**: parameters take effect |
| 7 | INT_ENA (0x188) | 0 | |
| 8 | GPIO matrix | pad 2 → signal **71** (LEDC_HS_SIG_OUT0), published by patch 0007 as `F … periph:71` | routing |

Steps 2–6 repeat for every `ledcWrite`. Observed variants: `ledcAttach(4, 5000, 12)` → APB clock
(`0x02007d0c`); a second channel (`ledcAttach(5, 1000, 8)`) → HSCH1 on HSTIMER1, routed to signal
72; servo → `0x02030d50` (res 16, div 6250/256, APB). The driver first binds a new channel to
timer 0 for a few instructions before selecting its own timer (duty 0, pad not yet routed: no
visible output).

**Upstream model defects confirmed** (why 0009 must replace, not extend, the model): reads of
DUTY/HPOINT/CONF1 return 0; `duty_res` is masked to 4 bits, so the servo's 16-bit resolution
(0x10) is **silently dropped**; only a duty percentage is produced; no counter, phase, routing or
`duty_start` semantics.

## 4. `W` correctness — scratch 0009 core vs independent reference vs hand calculation

Reference: `ledc_ref.py` (this directory; Python, exact rationals) applied to the register traces in `traces/` (with the sketches). The C core
prints picoseconds (exact; `+` marks a sub-picosecond remainder).

| Sketch call | Hand calculation | Python reference | C core (scratch 0009) |
|---|---|---|---|
| `analogWrite(2, 64)` | 1 kHz, 64/256 → 1 000 µs / 250 µs | 1 000 000 / 250 000 ns | period 1 000 000 000 ps, high 250 000 000 ps |
| `analogWrite(2, 128)` | 500 µs | 500 000 ns | 500 000 000 ps |
| `analogWrite(2, 255)` | core writes 256 = 2^8 → 100 % | 1 000 000 ns | 1 000 000 000 ps |
| `analogWrite(2, 0)` | undocumented (see §6, O-R4-1) | high count 0 | high count 0 — level not asserted |
| `ledcWrite(4, 1024/2048/4095)` @ 5 kHz, 12 bit | 200 µs; 50 / 100 µs / 100 % | identical | identical |
| `ledcWrite(5, 64)` @ 1 kHz, 8 bit | 1 000 µs / 250 µs | identical | identical |
| servo `3277 / 4915 / 6554` @ 50 Hz, 16 bit | 20 ms; 1 000.061 / 1 499.939 / 2 000.122 µs | identical | 20 000 000 000 ps; 1 000 061 035+ / 1 499 938 964+ / 2 000 122 070+ ps |

Period exactness: APB 80 MHz / 24.4140625 / 65 536 = **50.000 Hz**; REF_TICK 1 MHz / 3.90625 / 256 =
**1 000.000 Hz**. Phase: rising edges at timer-reset release (`t0`, virtual time, e.g.
889 244 128 ns) + hpoint + k·period; duty changes take effect at the next period boundary (IDF).
Determinism: the trace (every access and its virtual time) and the `W` values are **byte-identical**
across the two builds and across runs.

## 5. Continuity (A-12: every pin is a hypothesis to test)

The scratch runtime with the LEDC edit (build B, release flags) against the Runtime v2 pins:

| Suite | Result |
|---|---|
| R-MCU-1 gate, 6 configurations × 3 runs (and × 1 after the 0009 core) | **7/7 pass; pins unchanged** (`d7c5fa5d…`, `f6de86c9…`, `4cfdcad4…`) |
| Sprint 12 determinism pins (7 scenarios) | identical fingerprints to the release QEMU (control run) |

A runtime with an LEDC model change is therefore fingerprint-continuous for sketches that do not
use LEDC (none of the pinned firmware touches LEDC; the first access in the probes is in `setup()`).

**Side finding (not R4):** the Sprint 12 pins and the R1 motion pin no longer match on the
`sprint-13` branch with the **release** QEMU too. Bisected to `a23ffcd` (H2 slice 1): the only
difference in the event streams is the added field `outsideModelRange: false` on supply-limited
parts; with that one field removed, all 7 S12 fingerprints equal their pins. Handled on the branch
(re-pin, mechanism explained): `docs/sprints/s13-evidence/ci/PIN-DRIFT-H2.md`.

## 6. Findings that bound the design (stop conditions applied)

| # | Finding | Effect on R4 | Stop? |
|---|---|---|---|
| O-R4-1 | **Duty 0**: hpoint and hpoint + 0 coincide; the TRM states no precedence between "latch high" and "latch low". Neither TRM nor IDF headers document the output | 0009 must not assume "constant low" from inference. `analogWrite(pin, 0)` is common (LED off), so this must be settled before R4-B: one physical-board measurement, or an Espressif statement. Until then a duty-0 channel is reported with its level marked **unreliable**, never as a fact | no — narrow, decidable |
| O-R4-2 | **Fractional divider**: of 256 divider outputs, B are (A+1) input clocks; their exact positions are not documented ("evenly distributed") | Period exact; a high time can differ from nominal by ≤ 1 source clock (≤ 1 µs on REF_TICK = `analogWrite`, ≤ 12.5 ns on APB = servo). State it as the model's resolution; ±1 µs at 250 µs is 0.4 % | no |
| O-R4-3 | **Dither bits** (DUTY[3:0]): "statistical chance" of a longer pulse, generator undocumented | Not deterministic → 0009 refuses (reports unsupported) when non-zero. The 3.3.12 core always writes 0 | no |
| O-R4-4 | Clock assumptions: APB = 80 MHz and REF_TICK = 1 MHz (Arduino CPU 240 MHz default) | 0009 must read the actual clock configuration the runtime models, or refuse when it differs | no |
| O-R4-5 | Hardware fade (`duty_scale` ≠ 0) | Refused (R4-D4) | no |

No stop condition that blocks R4 was hit: the register sequence is complete and deterministic, all
timing derives from documented semantics, and every gap is either refusable or bounded.

## 7. Verdict

**GO for R4-B (implementation) as a separate decision**, with O-R4-1 resolved first (one physical
board measurement or an Espressif source). Not done in this probe and still needed for R4-B: the
bridge `W` frame and its negotiation, the Session Host consumption and A1 two-point solve, Runtime
v3 identity and re-baselines, and the product parts (servo, examples). Estimated effort unchanged
from the architecture (§8 there). Per R4-D2, R4 enters the 16 Nov alpha only if R4-B passes by
5 Nov; recommended: post-alpha.
