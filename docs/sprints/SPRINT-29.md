# Sprint 29 — Exploration Expansion (DEV)

Branch `sprint-29` from `fb31713` (the Sprint 28 head; deployed code `f0960cc`). Target: DEV only
(tbi-lab-srv). Runtime unchanged: Runtime v5 `39f2229a66d45e43`, the S26 MicroPython home
(MicroPython 1.29). The AI provider service is unchanged and inactive. Alpha, RC5 and production
untouched.

## 0. Baseline

Verified before any change: one Claude process, the pipeline lock free; `sprint-28` =
`origin/sprint-28` = `fb31713` (code `f0960cc`); DEV-Lab and staging served `f0960cc`; rollback
targets `f0960cc` (S28) and `d9dc155` (S27) published. The lock's per-process ownership worked in
practice: after each of two session restarts the dead holder's lease was taken over and logged
(`TAKEOVER … (process gone or PID reused)`), never shared.

Inventory (evidence-based): genuine MicroPython already ran GPIO, PWM, timing, I2C to the LCD,
edge `Pin.irq`, tracebacks and Build/Run/Stop on real QEMU; ADC was refused (the emulator's SAR ADC
crashes the guest); serial input was not offered. Logic: four SN74LVC1G single gates and the
SN74LVC08A, a truth-table inspector — but **every gate-to-gate cascade was refused** (owner rule
S22-Q1: I_CC bounded only with inputs at the test voltages, which a gate output never is). The DC
engine has an RC transient only without an MCU; no 555.

## 1. Owner decisions (this sprint)

| Id | Decision | Effect |
|---|---|---|
| **S29-D1** | **ΔI_CC bound.** An input within 0.6 V of GND or of V_CC (off the I_CC test voltages), with the supply in both the I_CC and the ΔI_CC rows, is bounded by I_CC + ΔI_CC (500 µA) per such input. Engineering assumptions: A1 monotonic CMOS input current toward the rail (the "one input at V_CC − 0.6 V" test point bounds the band), A2 the same bound on the GND side. Mid-band inputs stay not characterized. | Gate cascades and switch + pull-down inputs become boundable. |
| **S29-A3** | **Leakage-level tolerance.** A gate output (at its rail, S22-Q5) or a CV bench supply whose reverse current at a corner is no larger than the circuit's datasheet leakage sum (I_I per input once, I_off, ESP32 I_IH/I_IL) is evaluated, not refused; anything larger stays refused. Since the review: only when that reverse current disappears with the leakage currents removed (it must be leakage-DRIVEN). | Without it D1 changed only the refusal reason (the ±5 µA leakage of either sign drove a HIGH output backwards or made a supply sink µA). |
| **S29-D2** | **SN74LVC1G86 strict.** SCES222R has no §8.2.1.1 power rule, so a loaded XOR output leaves the I_CC test condition (I_O = 0) and is refused by name, like the SN74LVC08A (Q9). | The examples build XOR from OR + NAND + AND (all with §8.2.1.1). |
| **S29-D3** | **High band ends at V_CC.** At the operating point an input must be ≤ V_CC + 1 mV for the ΔI_CC band; a real source overdriving an input above V_CC stays refused; a corner may still reach V_CC + 0.6 V by leakage across a resistance. | E.g. an ESP32 HIGH (3.3 V) into a gate at 3.0 V is refused. |

Both are rows of kind `assumption` in the provenance table (`ENGINE.DELTA_ICC_BAND_V`,
`ENGINE.LEAKAGE_LEVEL_REVERSE`) and are named in the EN/HE refusal texts.

## 2. Workstream B — digital logic systems (P0)

Engine (`packages/engine/src/logic`):
- `quiescentAt` / `iccZones`: the ΔI_CC basis; zone checks keep each input in its band at every
  corner; the supply in both rows. A part refused only by the strict 1 mV test condition is
  re-evaluated on the ΔI_CC basis (session.ts) and reports the bound actually used
  (`iccBasis: 'deltaIcc'`, `deltaIccInputs`, `iccMaxA`).
- A supply current-limit refusal first settles the parts' I_CC basis (limits set aside, a
  learn-only pass): the refusal reports the TRUE worst demand (a gate fed by a gate output was
  still on the strict basis when the limit failed first: 5.96 mA reported, 6.96 mA real).
- Correctness fixes exposed by D1: the margin sensitivity is **two-sided** at the operating point
  and at every corner (a forward-only output stage at zero current, or an off transistor, gave one
  side no response — a LOW SN74LVC08A output's load was missed; a relay driver's no-sink check never
  settled); the Q9 "loaded" check is two one-sided checks; a corner cycle whose margins all hold and
  differ by ≤ 10 × the bounds' resolution (1e-12 A) is accepted, any other cycle stays refused.
- New parts **SN74LVC1G02 (NOR)** and **SN74LVC1G86 (XOR)** from SCES213Y / SCES222R (pinned
  sha256). The 1G86 differs from the set in its I_CC row ("V_I = V_CC or GND": inputs at V_CC keep
  the strict 10 µA) and has no loaded-output power rule (S29-D2: an unloaded XOR runs, a loaded one
  is refused by name). Catalog, palette, canvas/schematic symbols, 3D, EN/HE, provenance, refusal
  text variant.

What now holds, with numbers (logic-s29 / s29-examples tests):
- A 1-bit **full adder** of seven gates in four stages at 3.3 V (X = (A + B)·NAND(A, B),
  S = (X + Cin)·NAND(X, Cin), Cout = NAND(NAND(A, B), NAND(X, Cin))): all 8 input combinations,
  every intermediate level and S/Cout = A + B + Cin, LEDs lit exactly when HIGH; each gate's I_CC
  bound reported. A limit just under the worst demand is refused, just over runs.
- Switch + 10 kΩ pull-down inputs: up to 100 kΩ the input stays within 0.6 V of GND and V_IL
  (bounded, 1.01 mA); 200 kΩ refused (the LOW level itself is not guaranteed: 1 V > 0.8 V).
- Still refused, by name: inputs between the bands; supplies below the ΔI_CC row (e.g. 2.3 V); any
  SN74LVC08A output that drives an input (its I_CC only at I_O = 0, Q9 — now exact at both levels);
  5.0 V with a 1 mA load (only ±100 µA guaranteed off the tabulated rows).

## 3. Workstream A — genuine ESP32 MicroPython (P0)

Support contract `runtime/builder/pyContract.ts` (unit-tested: every probe against the Build
analysis; every Build refusal has EN/HE text):

| API | Status | Decided | Refusal | Evidence (real QEMU unless noted) |
|---|---|---|---|---|
| `Pin(n, Pin.OUT)` value/on/off | SUPPORTED | run | — | s24-mpy "M1c blink" |
| `Pin(n, Pin.IN).value()` | SUPPORTED | run | (undefined pad: `gpio_input_undefined`) | s24-mpy "M2 button"; s29-mpy-monitor |
| internal pulls | REFUSED | session | `internalPull` | s19b-mpy |
| `drive=` | REFUSED | build | `drive_strength` | unit |
| `Signal(…)` on/off | SUPPORTED | run | (read-back: fail closed, see note) | **s29-mpy-contract** |
| `PWM` duty_u16 / **duty()** / freq | SUPPORTED (high-speed LEDC) | run | `pwm_unsupported_mode`, `pwm_rate_exceeded` | s19b-mpy; **s29-mpy-contract** |
| `Pin.irq` edges | SUPPORTED | run | — | s25-irq |
| `Pin.irq` **level** trigger | REFUSED | run | `unmodelled: interrupt` (before arming) | **s29-mpy-contract** |
| `time.sleep*`, `ticks_*` | SUPPORTED, deterministic | run | — | s19b-mpy, s24-mpy |
| `I2C(0, 22/21, ≤ 100 kHz)` scan/writeto | SUPPORTED | build+run | — | s24-i2c, s26-multifile |
| I2C > 100 kHz / reads / SoftI2C | REFUSED | build | `i2c_frequency` / `i2c_operation` / `i2c` | s24-i2c, unit |
| `ADC` | REFUSED | run | `unmodelled: adc` (no guest crash shown) | s19b-mpy |
| DAC, SPI, TouchPad, Timer, UART, RTC | REFUSED | build | `dac`, `spi`, `touch`, `interrupt`, `library:machine.*` | unit |
| `machine.freq(hz)` | REFUSED | build | `cpu_frequency` | s19b-mpy |
| sleep modes / reset, WDT | REFUSED | build / session | `sleep` / `restart` | unit / host |
| dynamic access | REFUSED | build | `dynamic_access` | s19b-mpy, unit |
| **`input()`, `sys.stdin`** | **REFUSED (new)** | build | **`serial_input`** | unit |
| network, sockets, radio | REFUSED | build | `library:*` | unit |

Known risks reconciled: ADC guest crash — still refused at the access (unchanged, not reopened);
`Pin.irq` silently accepted — edges delivered since S25, **level triggers verified refused**
(MicroPython 1.29 has no `IRQ_*_LEVEL` constants; a numeric level type reaches the runtime's
refusal); serial input bursts — there is no serial input path in a session, so `input()` and
`sys.stdin` are now **refused at Build** (`serial_input`, analyzer 7) instead of waiting forever;
CPU clock changes — refused at Build; dynamic access — refused (S28 L7).
Note: `Signal.value()` (read-back) is not resolved to a pin by the Build analysis, so the run
watches every pad and is refused at the read while any is unconnected (fail closed, documented).

User acceptance (M1, real QEMU): the existing MicroPython examples; plus the M4 monitor below.

## 4. Workstreams C/D — interoperability and cross-domain

- Logic → 2N3904 → SRD-05 relay (separate 5 V supply, 1N4148 across the coil) → LED: four switch
  states, LED and relay iff A·B, gate output < 3 mA (logic-s29). No bleeder needed (S29-A3).
- **mpy-adder-monitor** (M4): switches + logic gates + firmware. The ESP32 only READS the
  four-gate half adder (GPIO32/33 the switches, GPIO34/35 the gate outputs, loaded only by pad leakage so their
  HIGH is guaranteed ≥ 3.2 V > V_IH 2.475 V), prints each state, checks it against A + B and sets a
  PWM LED. Real QEMU (s29-mpy-monitor): four states, the guest's printed line from the levels it
  read, pads 3.300/0.000 V, LED average = duty × the engine's ON current (2.158 / 5.574 / 2.158 /
  0.180 mA, equal to 4 decimals).
- Design rule found: ESP32 output → gate input is limited by owner rule Q7 (a pad is relied on only
  at leakage-level current), so a pulled-down gate input driven by the ESP32 is refused once the
  pad drives it. The examples esp32-logic-and / -override now run before setup() and are refused
  by name once the sketch drives GPIO18 (texts corrected).

Workstream C candidates evaluated: diodes, capacitors, BJT, potentiometer, switches, buzzer, relay
exist; the foundational improvement with the widest effect this sprint was making multi-gate logic
and switch/pull-down inputs valid (D1/A3) plus NOR/XOR. Capacitors under a running ESP32, RC timing
with firmware and the 555 need MCU-time co-simulation (not credible yet): backlog.

## 5. Workstream E — examples (EN/HE, with "Try:" next steps)

| Example | Level | Domains |
|---|---|---|
| logic-half-adder | beginner | switches + four gates (OR, NAND, AND, AND) + LEDs |
| logic-full-adder | intermediate | seven gates in four stages, every intermediate level inspectable |
| mpy-adder-monitor | advanced | switches + the four-gate half adder + MicroPython + PWM |

Editor fixes found with them: the generated schematic labelled two gate outputs "Y" (equal labels
read as one connection) — names are now qualified by the part ("U1.Y", "U2.Y"); the floating-island
check joined only a part's first two terminals (a gate fed only by gate outputs was "floating").

## 6. Independent review

A read-only engineering review of `fb31713..08705a6` (engine, analyzer, editor checks, datasheets)
found three MAJOR issues, all resolved before the gates: M1 the 1G86 had inherited a power rule
its sheet lacks (owner decision S29-D2); M2 the A3 tolerance accepted any small reverse current,
including a quiescent current into a stacked-ground supply (fixed: leakage-driven only, proven by
re-solving the corner without leakage); M3 the high band admitted real overdrive above V_CC (owner
decision S29-D3). Minor items fixed (stale ΔI_CC basis, `def input` spacing, floating-island
inputs, provenance wording, Inspector texts); notes accepted (two-sided ties, cycle resolution
~10 pA, the learn-only pass re-evaluates every check). Each counterexample is a regression test.

## 7. Gates and deployment

Release: `sprint-29` `bf05304` (code; this document follows as a docs-only commit).

| Gate | Result |
|---|---|
| Unit (3ab8039) | 2336 passed, 3 skipped (pre-existing, environment-gated) |
| Typecheck / lint | 0 errors |
| e2e (3ab8039, Playwright) | 331 passed, 40 skipped (real-stack specs, gated by env), 0 failed |
| Real-QEMU runtime suite (3ab8039) | 242 passed, 19 skipped, 1 failed: `s19b-x1` still asserted the Sprint 28 refusal at creation. Under S29-D1 the session is created and runs; it is refused by name (`logic_mcu_output_uncharacterized`, GPIO18, Q7) once the sketch drives GPIO18 — what the staging browser spec asserts. Test updated (`bf05304`), 1/1 on real QEMU, identical on two runs; no rule weakened |
| Package (dev-lab profile, built twice) | IDENTICAL, 37 files, manifest `bffa12c82552e2bd` |
| Staging install (tbi-s8) | `bf05304`, 6.1 s, DEV-Lab unchanged during it |
| Staging real stack | isolation 5/5, s8-policy 7/7, s28-assist 4/4, s8-gate 5/5 |
| Staging browser (real QEMU) | P1+S26 5/5; b1 16 passed / 2 skipped; b2 11/11; b3 7/7; **s29-real 2/2**; no service restart |
| DEV-Lab deploy | `bf05304`, 4.4 s; Caddy, polkit, policy, keys, gate tmpfiles unchanged; AI service `disabled` (`no_provider`) |
| DEV-Lab acceptance (browser, through the gate) | 24/24, incl. S29 full adder EN/HE and the MicroPython adder monitor EN/HE on the real build service + QEMU (a first run was cut at 12/24 by a session restart; rerun in full) |
| Rollback rehearsal | back to `f0960cc` 24.6 s, checks 4/4; forward to `bf05304` 24.3 s, checks 4/4; units and runtime.json byte-equal on both sides; public route 302 |

## Future / Backlog

- MCU-time co-simulation for capacitors and RC timing under a running ESP32; LMC555 on the time
  kernel (SPRINT-19B).
- ESP32 output → gate input with a pull-down (owner rule Q7) — a characterized light-load bound
  would make it valid.
- SN74LVC08A cascades (Q9: no loaded-output I_CC rule in its sheet).
- `Signal.value()` read-back resolved to its pin by the Build analysis.
- Example search: whole-text fields match across word boundaries (Hebrew prefix stripping found
  "מסר" across "עומס: ראו").
- A visible MicroPython support panel in the app generated from pyContract.ts.
