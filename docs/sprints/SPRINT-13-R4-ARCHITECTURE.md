# Sprint 13 — R4 architecture: hardware PWM (LEDC), servo, LED dimming

**Status: PROPOSED, for PM approval. No R4 implementation starts before approval** (PM, Gate C
acceptance, 2026-10-11). R4 = R3d of `docs/runtime/R3-CAPABILITY-PLAN.md` (capability A). This
document turns that capability into a concrete design on Runtime v2.

## 1. Goal and scope

**In scope:**
- `ledcAttach` / `ledcWrite` / `analogWrite` (arduino-esp32 3.3.12 LEDC driver) on ESP32 Classic GPIO outputs, simulated with exact timing.
- The SG90 servo as a new ESP32 part: the engine model `peripherals/servo.ts` exists; product exposure is new.
- LED / RGB LED brightness from PWM, through the A1 electrical decision (§4).
- Two curated examples: servo sweep, LED fade (fading by `ledcWrite` steps in the sketch).

**Out of scope (refused explicitly):**
- The LEDC hardware fade API (`ledcFade*`): refused by the builder.
- PWM into circuits with time-dependent parts (capacitors) or inductive / electromechanical loads (relay coil, active buzzer): refused at Run with a named reason.
- `tone()` and passive buzzers (not in the catalog); MCPWM, RMT, DAC; third-party servo libraries (D-3).

## 2. Baseline (verified in the pinned tree and the repo)

| Fact | Evidence |
|---|---|
| Upstream `hw/misc/esp32_ledc.c` (154 lines) stores timer/channel registers and computes a duty **percentage** only: no counter, no edges, no pad routing | pinned source `qemu-40edccac…` |
| Patch 0007 already publishes pad functions (`FUNCn_OUT_SEL`) to the bridge | Runtime v2 |
| The builder refuses `ledcAttach`, `ledcAttachChannel`, `ledcWrite`, `__analogWrite`, `analogWrite` as feature `pwm` | `runtime/builder/features.ts:30` |
| Runtime capabilities gate builder features per runtime id (the `i2c` precedent) | `/etc/<N>/runtime.json`, ADR-011 §5 |
| Bit-banged pulses already arrive as exact `G` frames (subject to F-R2-1: ≤ ≈ 13 µs longer) | Runtime v2 limitations |

## 3. Runtime: patch 0009 (LEDC waveform)

- **Model.** Extend `esp32_ledc` to the real register semantics:
  - timer clock source (APB 80 MHz / REF_TICK 1 MHz, and RTC8M for low speed), divider (10.8 fixed point) and duty resolution → **period**;
  - channel `duty` (with its 4 fractional bits), `hpoint`, output enable and idle level → **high time and phase**;
  - channel → timer binding.
- **Routing.** A pad driven by an LEDC signal (`GPIO_FUNCn_OUT_SEL` = LEDC HS/LS signal 71–86, ESP32 TRM table 4-2) reports a **waveform**, not edges:
  `W vns pad period_ns high_ns phase_ns`
  - re-sent whenever any input to it changes (duty, timer, routing, enable);
  - `period_ns = 0` means static at the idle level.
  - Resolution is one LEDC clock tick (12.5 ns at APB).
- **Determinism.** The waveform is a pure function of register state at virtual time `vns`. No wall clock, no per-edge traffic: a 5 kHz PWM costs one frame per configuration change.
- **Negotiation and fail-closed.**
  - The capability `pwm` is added to the bridge hello (`H tbi-bridge 2 <tick> i2c,pad-func,sched-input,pwm`).
  - QEMU sends `W` only after the host acknowledges `pwm` (the `sched-input` precedent).
  - An old host never sees `W`. An old runtime never offers `pwm`, so the builder keeps refusing PWM sketches there.
- **New runtime id.** Patch 0009 creates Runtime v3 (id = hash of the commit and patches 0001–0009). Every pinned fingerprint is a hypothesis to test (architecture A-12), not an assumption:
  - R-MCU-1 re-baseline (50 runs);
  - the s12/r1 determinism pins re-checked;
  - firmware unchanged.

## 4. Electrical meaning: decision A1 (requested)

The engine solves DC operating points. A pad switching faster than the circuit settles has no
single honest DC value. Therefore:

1. **Edge-consuming devices (servo signal):** exact. The Session Host expands the waveform into pulse widths at the period cadence analytically; the servo model takes `high_ns`.
2. **Resistive and diode loads (resistor, LED, RGB LED, diode):** solve the two operating points (pad high, pad low). Report:
   - both points;
   - the duty-weighted **average current**, which drives LED brightness in 2D and 3D;
   - the **peak** current, used for the ratings check.

   This is exact for loads that settle instantly. The display says "PWM: duty x %, average I, peak I".
3. **Anything else on a PWM net** (capacitor, relay coil, transistor-switched inductive load, buzzer, sensor supply): refused at Run with `pwm_load_unsupported`, naming the part (EN/HE). A time-stepped solve at edge resolution (A2) is future work.

## 5. Session Host, builder, browser

| Layer | Change |
|---|---|
| Session Host | Parse `W`; keep the waveform per pad; recompute device state at each `W`. Expand pulses for servos (≤ 50 Hz typical, analytic, no per-edge loop). Two-point solve + average for A1 loads. `gpio` event additive field `pwm: { periodNs, highNs }`. New diagnostics `pwm_load_unsupported`, and the existing `edge_rate_exceeded` budget for bit-banged edges |
| Builder | `pwm` allowed when the runtime's capabilities include `pwm`; `ledcFade*` refused (new token rule) |
| Engine | Servo device wiring (signal pad, 4.8–6 V supply); supply current: no torque model, so a documented constant idle draw from the datasheet or none (decision R4-D3) |
| Frontend | SG90 part: catalog, palette, 2D symbol, schematic, 3D (horn angle), inspector (angle, accepted pulse width), i18n EN/HE; PWM duty readout on pads; LED brightness from the average current; two examples |

## 6. Tests (new, T-R4-*)

1. **QEMU:** register → waveform correctness for every timer clock, divider and resolution used by the 3.3.12 driver, and at duty 0 / 100 %.
2. **Bridge:** `W` only after `pwm` is acknowledged; old host and old runtime fail closed (explicit codes).
3. **Determinism:**
   - R-MCU-1 on Runtime v3;
   - the existing pins, each either unchanged or re-baselined with the mechanism explained;
   - a servo-sweep pin.
4. **Servo:** angles within the model deadband for 1.0 / 1.5 / 2.0 ms; a hold without pulses; slew rate.
5. **A1:**
   - average and peak currents equal hand-calculated values at duty 0 / 25 / 50 / 100 %;
   - a ratings warning when the peak exceeds I_F max;
   - every refused load named.
6. **Builder:** PWM accepted on Runtime v3 and refused on v2; `ledcFade*` refused.
7. **Browser:** both examples on real QEMU (EN/HE), and the refusal cases.

## 7. Approval gates

| Gate | Content | Exit |
|---|---|---|
| **R4-A** | This architecture, decisions R4-D1..D4 | PM approval |
| **R4-P** | Probe, timeboxed 2 days, scratch build outside the repo: 0009 on the pinned tree; the 3.3.12 driver's register sequence observed; `W` correct for `analogWrite` and for a 50 Hz servo | go / no-go |
| **R4-B** | Staging Gate B on Runtime v3 (the full B0–B7 pattern) | PM |
| **R4-C** | Dev-lab Gate C | PM |

**Decisions requested:**
- **R4-D1:** A1 as in §4 (recommended), or refuse all loads but the servo signal.
- **R4-D2:** R4 for the 16 Nov alpha only if it passes R4-B by 5 Nov; otherwise post-alpha (recommended, §8).
- **R4-D3:** servo supply current: a documented datasheet constant, or none, with the limitation stated.
- **R4-D4:** refuse the LEDC hardware fade in V1 (recommended).

## 8. Interaction with the alpha

R4 changes the runtime id. A runtime change in the last week before the alpha would replace the
Gate B/C-validated Runtime v2 under the testers. Recommendation: the alpha runs Runtime v2
`b5b34b49cb7e4049`. R4 joins only if it clears R4-B by **5 Nov**, leaving a week of dev-lab soak;
otherwise it follows the alpha. PWM stays explicitly refused until then, as it is today.
