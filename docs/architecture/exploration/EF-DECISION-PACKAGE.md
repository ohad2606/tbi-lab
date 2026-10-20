# Exploration Foundation — architecture decision package (Sprint 19A)

**Status:** for owner decision. Documentation only: nothing here is implemented, and no
irreversible architecture choice is made before the decisions below are taken.
**Date:** 2026-10-20, DEV (`tbi-lab-srv`).
**Branch:** `sprint-19a-ef-decisions` (from `sprint-18-exploration` @ `c23ce72`).

**Reconciles:**
- `EXPLORATION-FOUNDATION.md` rev 2 (EF-1 … EF-8, decisions D-1 … D-9);
- `MICROPYTHON-FEASIBILITY.md` (Sprint 18 Workstream D evidence);
- `docs/sprints/SPRINT-17C-NEXT-PROPOSALS.md` (`sprint-15-r4`: Component Failure Framework gaps
  F1–F7, MicroPython probe);
- `docs/TODO.md` on `main` @ `15c8469` (owner direction);
- CLAUDE.md;
- the code on `sprint-15-r4` @ `c164cbe`: R4 + Sprint 18F, which DEV-Lab serves as `b59ee50`.

**Context:** R4 owner acceptance is approved (5/5 retests). PR #7 stays unmerged; Alpha is
unchanged.

Numbers quoted from datasheets are **indicative**: each one is pinned from a named datasheet
revision when its part card is written, as every existing card is, and the card cites it.

---

## 0. Code facts this package relies on (verified on `c164cbe`)

| Fact | Where |
|---|---|
| One MNA/Newton engine shared by the browser worker and the Session Host (ADR-008) | `packages/engine/src/session.ts` |
| Parts since Sprint 10 are `PartModel`s: `elements` (devices or ideal contacts), `nextState`, `report`, ratings | `packages/engine/src/parts.ts` |
| Discrete states settle in a fixed-point loop, `MAX_STATE_PASSES = 32`, else `no_steady_state` | `session.ts:313` |
| Islands with no path to the reference are refused (`floating_circuit`) | `session.ts` `islandsWithout` |
| Available device primitives: `Resistor`, `VoltageSource`, `LabPsu`, `Diode`, `Capacitor`, `RegulatedOutput`, `ConstantSink`, `PwlLoad`, BJT | `devices.ts`, `sources.ts`, `pwl.ts`, `bjt.ts` |
| Time-stepping: browser only, fixed 1 ms step (`STEP_S = 1e-3`), capacitor only | `app/src/sim/worker.ts:22` |
| ESP32 sessions are DC-only: the capacitor (`mcuRuntimeReason: 'time_dependent'`) and the LED matrix are `mcuRuntime: false` | `packages/domain/src/catalog.ts:481, 516` |
| ESP32 pad: 3.3 V behind 16.5 Ω (high) / 17.679 Ω (low); V_IL 0.825 V, V_IH 2.475 V, **hold** in between | `packages/engine/src/esp32Gpio.ts` |
| Bridge capabilities negotiated at hello: `i2c`, `pad-func`, `pwm`, `sched-input`; unknown frames fail closed | `runtime/harness/protocol.ts:19` |
| Build profiles carry a `language` (`arduino-cpp` today); one profile exists | `packages/domain/src/program.ts:36` |
| Parts in the catalog (21): resistor, LED, RGB LED, diode, capacitor, photoresistor, buzzer, NPN BJT, push button, toggle switch, relay, PIR, HC-SR04, DHT22, LCD1602-I2C, SG90, LED matrix, lab PSU, ground, ESP32 DevKitC. No logic part, no MOSFET, no 555 | `catalog.ts` |

---

## 1. The conflicting TODO phase orders (reconciled, not chosen)

`docs/TODO.md` on `main` contains **two** approved sections with different orders:

| Step | §"Digital Logic, Switching & Integrated Circuits" (line ~931) | §"Digital Logic & Integrated Circuits" (line ~944, marked *Near-term*) |
|---|---|---|
| 1 | Basic logic primitives and digital stimulus | basic logic primitives and digital stimulus |
| 2 | Truth-table / state inspection | truth-table/state inspection |
| 3 | **Selected packaged logic ICs** | **555 timer as an early concrete IC target** |
| 4 | **555 timer** | **selected packaged logic devices** |
| 5 | Flip-flops / counters / shift registers | flip-flops, counters and shift registers |
| 6 | Broader IC catalog by demand | broader IC catalog by real demand |

**The only conflict:** steps 3 and 4 are swapped. Steps 1–2 and 5–6 agree.

**What decides between them technically:**
- "Packaged logic ICs" in DC sessions need nothing beyond step 1: the same gate model, a
  package pin map, shared supply pins.
- The 555 needs the time kernel (EF-1): it is an oscillator or one-shot; its behaviour **is**
  timing.

So "555 before packages" (second list) means building EF-1 before packages. "Packages before
555" (first list) lets packages ship in DC sessions while EF-1 is built.

**Engineering observation:**
- The second list is the later, *near-term* section, and it states the owner's priority ("basic
  logic and the 555 … before broad catalog expansion").
- The first list is the general direction.

That is an observation, not a choice. **This is decision EF-D9.** The plan in §6 runs in either
order: the logic track does not wait for EF-1, and the 555 does.

**A second, smaller inconsistency:** both lists put "digital stimulus" in step 1.
- Manual stimulus (switch, push button, ESP32 GPIO) works in DC sessions.
- A clock or pulse source with a frequency does not, without EF-1.

EF-D1 decides how step 1 is read.

---

## 2. Decision matrix EF-D1 … EF-D9

Each decision: options, recommendation, user benefit, physics/runtime implications, dependencies
and risks, and what the owner must decide. EF-Dn = D-n of `EXPLORATION-FOUNDATION.md` §11, in
full.

### EF-D1 — Where the time kernel (EF-1) goes relative to logic phase 1

**Options:**
- **A. EF-1 first:** the time kernel before any logic part.
- **B. Logic first:** logic primitives in DC sessions with manual stimulus, then EF-1.
- **C. Split (parallel):**
  - logic slice 1 in DC sessions now, with manual stimulus: switch, button, ESP32 GPIO;
  - EF-1 (local kernel) built in parallel on its own branch;
  - the clock/pulse source, propagation delay, the 555 and sequential parts wait for EF-1.

**Recommendation: C.** *(Revised from rev 2, which recommended A. Reason: logic slice 1 does not
depend on EF-1 at all, and C delivers the owner's phase 1 without waiting 2–3 sprints. EF-1 still
gates everything timing-dependent.)*

**User benefit:**
- logic gates with real thresholds, levels, loading and ESP32 interop in the next sprint;
- RC timing, clocks and the 555 follow when EF-1 lands.

**Physics/runtime implications:**
- Slice 1 settles logic at **zero propagation delay**. That is valid only where the delay is
  below every observer's resolution:
  - datasheet tpd is a few ns;
  - the ESP32 bridge spaces input events ≥ 1 µs per pad;
  - QEMU's `icount shift=3` is 8 ns per instruction.
- Anything where delay matters is refused, by name, in slice 1: oscillating feedback, races,
  clock sources, sequential parts.
- EF-1 later adds time with "slow motion, never approximated" and the real-time factor shown.

**Dependencies and risks:**
- C needs two tracks to merge into the same engine. Mitigation:
  - EF-1 is engaged only when a time-dependent part exists, so DC paths stay bit-identical (a
    test for that);
  - logic parts declare their delay data from day one, but it is not used until EF-1.
- Risk: users may want a clock before EF-1. It is refused with a named reason, not faked.

**Decision required:** A, B or C, and confirmation of "slow motion, never approximated" for EF-1.

### EF-D2 — First logic family, supply and package

**Options:**
- **A. 74HC at 5 V:** the classic maker family.
  - The ESP32's 3.3 V output is below its V_IH at 4.5 V (≈ 3.15 V, indicative), so it does not
    interoperate directly with the ESP32.
  - Its datasheet tabulates V_CC = 2.0 / 4.5 / 6.0 V, so 5 V and 3.3 V both fall **between rows**
    (EF-D3).
- **B. A 3.3 V CMOS family whose datasheet tabulates a 3.0–3.6 V supply range** (e.g. 74LVC1G
  single gates: V_IH 2.0 V / V_IL 0.8 V across 3.0–3.6 V, indicative).
  - The ESP32's own rail is inside a tabulated row: direct, exact interop.
  - The LVC1G parts are SOT-23-5/SC-70 single gates: physically real and buyable, but on a
    breadboard they need a breakout adapter.
- **C. B plus 74HCT later** as the 5 V level shifter (TTL-compatible inputs, V_IH ≈ 2.0 V at
  4.5–5.5 V).

**Package sub-decision (EF-D2b):**
- **(i) Single-gate devices:** one function per part, the cleanest primitive.
- **(ii) DIP-14 quad devices** (e.g. a quad NAND): what makers put on breadboards.
  - It needs the canonical package pin map and the unused-gate rule (unused CMOS inputs must be
    tied: a named warning) from the first slice.

**Recommendation:** B with C next; package (i) for slice 1, (ii) as slice 2 with the same gate
model.
- The family and device choice is pinned only after the datasheet table rows are checked against
  3.0–3.6 V and 4.5–5.5 V.
- The availability of an XNOR single-gate part is confirmed at pinning. Otherwise XNOR comes
  with a quad package.

**User benefit:**
- ESP32 + logic works without level-shifting, at exact datasheet levels;
- the 5 V world and the classic compatibility lesson (EF-8 P4) follow with 74HCT.

**Physics/runtime implications:**
- None beyond §3: the family card is data, the model is the same.
- (ii) adds topology checks for package pins.

**Dependencies and risks:**
- Risk: makers expect DIP 74HC. A is the textbook, but at 3.3 V and 5 V it is between table rows
  (EF-D3), so it would need an interpolation decision first.

**Decision required:** the family (A/B/C) and the package (i/ii) for slice 1.

### EF-D3 — Supply voltages between datasheet rows

**Options:**
- **A. Refuse:** `outsideModelRange` plus Run refused for that part, naming the supply.
- **B. The conservative row:** of the bracketing rows, take the figure that is worse for the
  design; label it.
- **C. Interpolate,** but **only** where the datasheet itself states a proportional limit
  (e.g. V_IH = 0.7 × V_CC), never a linear blend of two rows.

**Recommendation:**
- C where the datasheet states the proportional form;
- otherwise A;
- B only as an explicit, labelled owner choice (it is defensible as a bound, but users read it as
  "the" value).

**User benefit:** clear honesty: the user sees "this supply is outside the datasheet's
characterized points" instead of a fabricated threshold.

**Physics/runtime implications:**
- Thresholds and output levels come from the card at the **solved** V_CC of each part (its own
  supply pins), re-evaluated in the fixed-point loop.
- A supply between rows that the card cannot cover marks every affected result as outside the
  model.

**Dependencies and risks:**
- With EF-D2 = B, the ESP32's 3.3 V needs no interpolation at all.
- The risk concerns 74HC at 5 V (A of EF-D2).

**Decision required:** A, B or C (or "C, else A").

### EF-D4 — Output characteristic: guaranteed or typical

**Options:**
- **A. Guaranteed (worst case).**
  - The output is a resistor from the part's own V_CC (HIGH) or GND (LOW) pin, fitted through
    the datasheet's **highest-current guaranteed** V_OH/V_OL test point (e.g. LVC1G at 3 V:
    V_OH ≥ 2.3 V at −24 mA → R_OH ≤ 29 Ω, indicative).
  - A test asserts that the resistor also meets every lower-current guaranteed point (it does,
    with margin: at −100 µA the drop is 3 mV against the guaranteed 100 mV).
- **B. Typical:** fitted to typical curves where the datasheet publishes them.
  - Closer to a bench, but not guaranteed. Many logic datasheets publish no typical output
    curves at all.

**Recommendation: A.** Typical curves only where published, as a later, labelled option.

**User benefit:**
- a design that works in the simulator works with every compliant part;
- fan-out and loading problems show up rather than being hidden.

**Physics/runtime implications:**
- Linear validity only up to the largest tabulated test current: beyond it `outsideModelRange`.
- The output-current absolute maximum is a rating row.
- Output current flows through the part's supply pins (KCL), so supply and pin-current ratings
  come from the solve.

**Dependencies and risks:**
- Worst case can look pessimistic next to a bench measurement. It is labelled "guaranteed
  characteristic" in the inspector.

**Decision required:** A or B.

### EF-D5 — The ESP32 ADC (and the potentiometer next to an ESP32)

**Options:**
- **A. Not now:** refused by name in every context.
  - Arduino: at build (`analogRead` is already an analyzed facility).
  - MicroPython: at run time via the `U` frame (§4), instead of today's guest crash.
- **B. A calibrated transfer with the datasheet's error band shown:**
  - needs a SENS/SAR model in QEMU plus a bridge frame for the sampled voltage;
  - the classic ESP32 ADC is non-linear with per-chip calibration (eFuse Vref), so the band is
    large and must be shown, never hidden.
- **C. An ideal ADC:** not recommended. It invents accuracy no classic ESP32 has.

**Recommendation: A now; B as its own later project if the owner wants analog sensing.**

**User benefit:**
- A: no silent crash, a clear message;
- B: potentiometers, LDR readings and analog sensors with honest error bars.

**Physics/runtime implications:**
- A: one register hook in Runtime v4 (§4).
- B: a QEMU device model, a new bridge capability, an attenuation/width model and the error
  band. That is a multi-sprint project of its own.

**Dependencies and risks:**
- B has a high physics risk; A has none.
- The potentiometer as a pure divider (no ADC) is independent and cheap. It can ship with logic
  as a stimulus/threshold part if wanted.

**Decision required:** A, B or C; and whether a potentiometer may ship as a divider-only part
before any ADC.

### EF-D6 — The first 555

**Options:**
- **A. NE555 (bipolar):** the textbook part.
  - Needs ≥ 4.5 V, so its output into an ESP32 needs a divider: that is part of the design
    lesson.
  - Larger supply current; a totem-pole output.
- **B. A CMOS 555 (TLC555 or LMC555):** runs from 3.3 V with the ESP32, with a different
  divider, thresholds, output stage and supply current.

**Recommendation:** A as the first card if the 555 is primarily a stand-alone/educational part; B
if 555 + ESP32 at 3.3 V is the primary use. One device first either way, with the second as a
separate card later.

**User benefit:** A matches every textbook and tutorial; B gives direct ESP32 interop.

**Physics/runtime implications:**
- Both need EF-1.
- The internal divider is real resistors (so CONT is electrically real), the comparators are
  discrete decisions, the latch is state, and the discharge transistor and output stage come
  from datasheet points.
- Timing emerges from the RC network.

**Dependencies and risks:** EF-1 local (and ESP32 lockstep for P6).

**Decision required:** A or B, and its datasheet source.

### EF-D7 — Reference projects as the Exploration Foundation acceptance

**Options:**
- **A. Approve the EF-8 set (P1–P7)** as the acceptance criteria. Each ships as an example and as
  a golden numeric test.
- **B. Approve a subset per slice:** for Sprint 19B the three projects of §5 (X1–X3), the rest
  with their slices.
- **C. Replace with owner-chosen projects.**

**Recommendation: B.** It keeps acceptance tied to what each slice can honestly do.

**User benefit:** every capability arrives with a working, verified project, not an isolated
part.

**Physics/runtime implications:**
- Each project is a golden test that fails if any composed domain regresses.

**Dependencies and risks:** none beyond the slices themselves.

**Decision required:** A, B or C.

### EF-D8 — A MOSFET under PWM

**Options:**
- **A. EF-1 only:**
  - the gate charge and the switching transient are simulated edge by edge;
  - A1 averaging is never applied to a MOSFET.
- **B. A1 conduction-loss-only:**
  - the two operating points are averaged by duty (instant switching assumed), labelled
    "switching loss not included";
  - refused when the PWM period approaches the datasheet switching times.

**Recommendation:**
- **A** as the honest default;
- **B** only if the owner wants MOSFET PWM drivers before EF-1, accepting that dissipation is
  understated by the switching loss and labelled so.
- The MOSFET itself at DC (a load switch from a GPIO or a logic output) needs neither and can
  ship with logic slice 1 or 2.

**User benefit:**
- B: early LED-strip/motor-driver lessons;
- A: correct dissipation and switching behaviour.

**Physics/runtime implications:**
- B adds the MOSFET to `PWM_AVERAGED_TYPES` with a switching-time guard.
- A depends on EF-1 lockstep.

**Dependencies and risks:** B's understatement must be visible in the ratings display (CFF).

**Decision required:** A or B; and whether a DC-only MOSFET may ship early.

### EF-D9 — Which TODO phase order is authoritative

**Options:**
- **A. The first list:** packaged logic ICs, then the 555.
- **B. The second (*near-term*) list:** the 555, then packaged logic ICs.
- **C. Both in parallel tracks:**
  - packages on the logic track (DC, no EF-1);
  - the 555 on the EF-1 track.

  Whichever track finishes first ships first.

**Recommendation:**
- the owner states which list is authoritative and retires the other text (one order in the
  TODO);
- engineering can deliver **C** without conflict because of EF-D1 C.

**User benefit:** one roadmap everyone reads the same way.

**Physics/runtime implications:**
- none: packages need no new physics;
- the 555 needs EF-1 either way.

**Dependencies and risks:**
- With A, the 555 can still be built early on the EF-1 track but not exposed first.
- With B, packages may wait idle if EF-1 slips.

**Decision required:** A, B or C, and which TODO section to edit.

### Summary table (for quick reading)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| EF-D1 | Time kernel vs logic phase 1 | A EF-1 first · B logic first · C split, in parallel | **C** (revised from A) |
| EF-D2 | First logic family / package | A 74HC 5 V · B 3.3 V CMOS family tabulated at 3.0–3.6 V (e.g. LVC1G) · C B + 74HCT later; package (i) single gate · (ii) DIP-14 quad | **B → C; (i) then (ii)** |
| EF-D3 | Supply between datasheet rows | A refuse · B conservative row · C interpolate only where the datasheet states proportional limits | **C, else A** |
| EF-D4 | Output characteristic | A guaranteed · B typical | **A** |
| EF-D5 | ESP32 ADC | A not now (named refusal, also at MicroPython run time) · B calibrated + error band · C ideal | **A now; B later as its own project** |
| EF-D6 | First 555 | A NE555 · B CMOS 555 | **depends on primary use; one card first** |
| EF-D7 | Acceptance projects | A all P1–P7 · B per slice (19B: X1–X3) · C owner's own | **B** |
| EF-D8 | MOSFET under PWM | A EF-1 only · B A1 conduction-only, labelled | **A; DC MOSFET may ship early** |
| EF-D9 | Authoritative TODO order | A packages → 555 · B 555 → packages · C parallel tracks | **owner picks the text; engineering can do C** |

---

## 3. Digital logic foundation — slice L1 (first implementation slice)

**Goal:** genuine interoperability between logic gates, electrical circuits and MCU GPIO, in DC
sessions (local and ESP32), with no new physics invented and no timing claimed.

**Assumes** EF-D1 = C, EF-D2 = B (i), EF-D3 = C-else-A, EF-D4 = A. Other answers change data
only, not the structure.

### 3.1 Parts

- Single-gate CMOS devices: NOT, BUF, AND, OR, NAND, NOR, XOR (XNOR if a single-gate part exists
  in the chosen family), each with **VCC, GND, inputs, output**.
- One **open-drain** buffer and one **tri-state** buffer (with an OE input). These cover
  wired-AND, pull-up requirements and high-Z.
- Catalog: one type per function (e.g. `logic.gate_and`) with a `model` parameter naming the
  device card, as the LED matrix and DHT models do. The canonical device definition (pins,
  roles, package, source revision) is one record shared by canvas, schematic, 3D, engine and
  the AI layer.

### 3.2 The family card (data, per device and datasheet revision)

| Field | Use |
|---|---|
| `vcc.operating` [min, max], `vcc.absoluteMax` | supply validity; outside → `outsideModelRange` / rating row |
| rows: for each tabulated V_CC range: V_IH min, V_IL max (absolute or `× V_CC` as the sheet states) | input classification |
| V_OH min at I_OH, V_OL max at I_OL, every tabulated test point | output resistors (EF-D4 A) and their self-check |
| I_I (input leakage bound, ±) | leakage-bound check (§3.4), never a conductance |
| I_CC quiescent | `ConstantSink` VCC→GND |
| absolute maxima: V_I, V_O, I_IK/I_OK clamp, I_O, V_CC/GND pin current | rating rows (`absolute`) |
| t_pd typ/max with C_L and V_CC | carried, displayed as data, **not simulated in L1** |
| `source` (manufacturer, document, revision, table) | cited by the card's tests |

### 3.3 Electrical model (all existing engine primitives)

- **Inputs:** no element at DC; the pin voltage is read from the solve. The input classification
  per the card row at the part's **solved** V_CC:
  - `HIGH` ≥ V_IH;
  - `LOW` ≤ V_IL;
  - otherwise **X** (`logic_input_undefined`, naming the pin).

  The ESP32's own inputs keep their documented hold semantics; gates do not hold.
- **Floating input:** the pin's net has no DC path to any driver, supply, ground or pull
  resistor. Found topologically: the net carries only gate-input pins, disabled outputs or
  nothing. The result is X, and the Run is refused with `logic_input_floating` naming the pin. An
  unused input of a used package is the same rule (L2).
- **Output** (push-pull), by the gate's discrete state:
  - `HIGH`: a `Resistor` R_OH from the part's **VCC pin node** to OUT;
  - `LOW`: a `Resistor` R_OL from OUT to the part's **GND pin node**;
  - `X` or `Z`: **no element** (the node is driven by others, or floats → X downstream).

  So output current flows through the supply pins and KCL holds. Fan-out, supply current and pin
  current all come out of the solve.
- **Open-drain:** only the LOW element exists. A HIGH output with no pull-up on the net is a named
  diagnostic (`logic_pullup_missing`), never a level.
- **Tri-state:** OE inactive → Z (no element). OE itself is an input with the same
  classification; OE = X → output X.
- **Unpowered:** V_CC below the card's operating minimum → every output X (no element) +
  `outsideModelRange`. Input-clamp behaviour of an unpowered CMOS part is **not** modelled; such
  a circuit is refused (`logic_unpowered_driven`) when an input is driven above the unpowered
  rail.
- **Two outputs driving one net:** the solve gives the contention current through both output
  resistors. The output-current absolute maximum flags it (as ESP32 pad contention is today).

### 3.4 The leakage-bound check (no invented level)

- An input reached only through a large resistance has an uncertainty of ±I_I × R_thevenin.
- After settling, for each gate input whose net is driven only through resistors, the engine
  computes R_thevenin by one perturbation solve (linear: unit current injection).
- If V ± I_I·R_th crosses into the undefined band, the input is X with `logic_input_marginal`.
  Example: a 10 MΩ pull-up with I_I = ±5 µA gives ±50 V, so it is honestly undefined.
- Cost: one extra solve per such input per settled point, bounded by the existing solve budget.

### 3.5 Settling (simulation ownership and order)

- **Owner:** `packages/engine` (`parts/logic.ts` + family cards). The same `EngineSession` runs:
  - in the browser worker for local circuits;
  - in the Session Host for ESP32 sessions (ADR-008).

  No logic evaluation exists anywhere else. The UI and AI only read `report()` results.
- **Order:**
  1. Gate states are discrete `PartState`s.
  2. Within each fixed-point pass, the engine evaluates gates in **topological order** of the nets
     they drive (each after its inputs), so a chain of *d* gates settles in one pass, not *d*.
  3. A stable chain of 40 gates is a test.
- **Feedback** (a gate output reaching its own input through gates) is **refused** in L1
  (`logic_feedback_unsupported`). Cross-coupled latches and ring oscillators need either
  explicit latch semantics (L2) or delays (EF-1). The zero-delay loop cannot decide a race
  honestly.
- **Propagation timing:** zero delay in L1, valid because no L1 observer resolves it (EF-D1).
  - Static hazards/glitches are therefore not shown; L1 has no edge-sensitive part they could
    affect.
  - The inspector shows t_pd as card data labelled "not simulated in this version".

### 3.6 ESP32 GPIO interop

- **ESP32 → gate:** the pad's output model (3.3 V behind 16.5 / 17.679 Ω) drives the gate input
  net; the solve gives the level at the input. Gate inputs draw no DC current.
- **Gate → ESP32:** the gate output resistor drives the pad's input. The host reads the pad's
  solved potential and applies the ESP32 hold semantics, exactly as for a relay contact or a
  sensor output.
- **Timing:** a gate output change caused by an ESP32 output event is at the same virtual time
  (zero delay, §3.5).
- **PWM into a gate:** stays refused (`pwm_load_unsupported`, named). A1 averaging is wrong for
  logic. Edge-domain propagation is a later extension.
- **Level compatibility is a solve result:** a 3.3 V pad into a 5 V-supplied CMOS input gives X +
  `logic_input_undefined` naming both parts; the corrected design (a 3.3 V family, or 74HCT
  later) works.

### 3.7 Unsupported in L1, each refused by name

| Case | Code |
|---|---|
| floating input | `logic_input_floating` |
| input in the undefined band | `logic_input_undefined` (result X, Run not refused unless X reaches an MCU input or a displayed number with no honest X display, then refused) |
| input marginal by leakage | `logic_input_marginal` |
| combinational feedback | `logic_feedback_unsupported` |
| PWM into logic | `pwm_load_unsupported` |
| clock/pulse source, delays, sequential parts, 555 | not in the palette (registry `unsupported`, reason "needs the time kernel") |
| supply between rows without a proportional rule | `outsideModelRange` + refusal (EF-D3 A) |
| unpowered part driven | `logic_unpowered_driven` |
| open-drain without pull-up | `logic_pullup_missing` (diagnostic) |

### 3.8 Truth-table / state inspection (TODO phase 2)

- It is analysis over the **same** model:
  - the inspector clones the circuit's engine;
  - it steps the selected manual stimulus inputs (switches/buttons, at most 6, so 64 rows);
  - it solves each row in the worker, off the UI thread.
- Each output is reported as HIGH, LOW or X with its node voltage.
- ESP32 pads are held at their current drive in the clone, labelled so. A truth table never
  runs a separate logic simulator.

### 3.9 Tests (L1 acceptance)

- **Per card:**
  - every guaranteed V_OH/V_OL point is met by the model, and the highest point exactly;
  - V_IH/V_IL classification at every row boundary (±1 mV);
  - rating rows trigger at their limits.
- **Per gate:** the full truth table with inputs at the guaranteed rails, local and through the
  Session Host (identical results).
- **Fan-out:** N inputs plus M LED loads; the output voltage and supply-pin current against hand
  analysis; the crossing of the output-current maximum.
- **Interop:**
  - ESP32 → AND → ESP32 round trip on real QEMU;
  - 3.3 V into a 5 V-supplied CMOS input → X + named diagnostic;
  - the corrected design passes.
- **Refusals:** each code in §3.7 provoked by a test (the EF-7 registry rule: no entry without a
  test).
- **Settling:** a 40-gate chain in one pass; feedback refused; determinism (identical results
  ×2).
- **Leakage bound:** a 10 MΩ pull-up → `logic_input_marginal`; a 10 kΩ pull-up → a valid HIGH.
- **Regression:** every existing engine result bit-identical (R1–R4 golden and determinism
  suites).

---

## 4. MicroPython foundation — slice M1 (smallest reliable product slice)

**The genuine interpreter:** the pinned, unmodified MicroPython ESP32_GENERIC v1.29.0 image
(`artifacts.lock.json` `micropython`), run by the same QEMU runtime. No interpreter of our own,
no translation to C++.

### 4.1 Code delivery ("Build")

- A new build profile `esp32-micropython-1.29` (`language: 'micropython'`, file `main.py`,
  64 KiB like Arduino).
- **Build** writes `main.py` into the image's LittleFS v2 partition (0x200000–0x400000) with a
  pinned `tbi-mklfs`. That tool is built from the interpreter's own `lib/littlefs` and uses its
  `VfsLfs2` configuration.
- The output is one merged 4 MiB image: the pinned interpreter plus the filesystem.
- The rest of the path is unchanged: the build service, store, grants, ticket and Session Host.
- Byte-reproducible:
  - the Sprint 18 probe built a byte-identical image twice (`c79cf6e4…`);
  - the tool reads no clock (the stock `mklittlefs` stamps wall time and is unusable).
- Syntax errors appear at run time as a traceback on serial, as on a real board. An optional
  pinned `mpy-cross` syntax check at build gives earlier feedback. It is the real compiler, not a
  re-implementation.
- `boot.py` is not written, so first-boot setup does not run.

### 4.2 What works, and how it is proven

| Facility | Status | Evidence |
|---|---|---|
| `machine.Pin` output/input | supported | P1: GPIO2 toggles at 50 ms exactly |
| `machine.PWM` | supported (high-speed LEDC channels; R4 host models them) | P1 through the Session Host: LED averages exactly 0.125/0.25/0.5/0.75 × high-state current |
| `machine.I2C` (I2C0, bus scan, R3 devices) | supported, to re-verify in M1 with the LCD1602-I2C | Sprint 17C probe: scan through the R3 bridge |
| `time.sleep*`, `ticks_*` | supported | sleep_us(500) = 515 µs measured |
| determinism | supported | identical image, frames, serial ×2 |

### 4.3 What must be refused, and how (Runtime v4)

- A new bridge capability token `unmodelled` and frame `U <vns> <facility>`, negotiated at
  hello. Hosts without it never receive it, since the parser fails closed.
- The host ends the session `unsupported_feature`, naming the facility in EN/HE, **before** dead
  or crashed behaviour reaches the user.

| Facility | Hook (from the Sprint 18 probes) | Today |
|---|---|---|
| ADC (`machine.ADC`) | the first read of `SENS_SAR_MEAS_START1/2`, or a write setting MEAS_START | 12.6 M polls, then a guest panic |
| GPIO interrupts (`Pin.irq`) | a `GPIO_PINn` write with INT_ENA ≠ 0 (probe patch: exact, observation-only) | 0 callbacks, silent |
| CPU clock change (`machine.freq(x)`, x ≠ 240 MHz) | RTC clock-config writes changing the CPU source/divider | simulated time stalls about 1.2 s later (F-17C-1) |
| RMT (NeoPixel), MCPWM, PCNT, DAC, touch, deep/light sleep, Wi-Fi/BT (`network`, `bluetooth`) | the first *use* access of their register blocks | `unimp` regions (silent zeros) |

**Rule for every hook:** boot touches some of these regions (`-d unimp`: rtcio, iomux, i2s0,
apbctrl). A hook fires only on an access that means *use of the facility*. Each hook has two
tests:
- a firmware that uses the facility → refused, named;
- the curated Arduino examples and MicroPython blink/PWM → **not** refused (no false
  refusals).

**Not measured yet (must be, inside M1, before the slice is accepted):**
- `machine.reset()` (expected: guest reset → `guest_reset` under `-no-reboot`);
- `machine.Timer` (hardware timer interrupts);
- `machine.UART(1/2)`;
- `machine.SPI`.

Each ends as supported (measured), refused (hooked) or out of M1, with a test.

### 4.4 Serial reliability

- **Cause:** a 1000-byte burst handed to the bridge in one command is lost; the same bytes paced
  at 11 bytes per 1 ms tick arrive complete (CRC verified).
- **Fix:**
  - the host paces serial input at the session's line rate (115200 8N1: at most ⌊11.52 × tick_ms⌋
    bytes per tick), queueing the rest, deterministically in virtual time;
  - this is the real link's own limit, not a workaround;
  - it applies to Arduino sessions too, which already send little.
- Output (`print`) already arrives intact.
- The REPL is **not** a product feature in M1: `main.py` runs and serial is the program's
  stdin/stdout.

### 4.5 Lifecycle and resources

| Item | M1 behaviour |
|---|---|
| Boot | ~1.1 s of virtual time to `main.py` (measured): the UI shows "starting interpreter" |
| Run/Stop | each Run boots a fresh image (no state carried); Stop is clean (`ended/stopped`, measured) |
| `main.py` ends | the interpreter falls to the REPL; the session stays live (as a real board), idle |
| Unhandled exception | traceback on serial; to be measured in M1 (expected: REPL afterwards) |
| Resources | QEMU RSS ~77 MB, peak ~112 MB (within the 384 MiB unit cap); 10.4 s wall for 2.5 s simulated, boot-dominated, 1 vCPU |

### 4.6 Product surface (only after 4.1–4.4 pass)

- An editor language mode (Python syntax, LTR always).
- Two examples: MicroPython blink, PWM fade.
- Capability panel context `micropython` (EF-7 one registry, every context).
- EN/HE refusal texts.

### 4.7 M1 exit criteria

1. The build profile is byte-reproducible (two builds, two paths, identical).
2. Runtime v4 `U` frames for ADC, GPIO interrupt and CPU clock are refused by name, with no false
   refusal across every curated Arduino example and MicroPython blink/PWM.
3. Paced serial: a 4 KiB input is received intact.
4. The examples run through the Session Host with exact PWM averages and identical fingerprints
   ×2.
5. The four unmeasured items of §4.3 are measured and classified.

---

## 5. Cross-domain demonstrations (after L1 and M1)

Each ships as an example (language-neutral project data, EN/HE text) **and** a golden test that
asserts its numbers. All three need only L1 + M1 (no EF-1), and each composes more domains than
the previous one.

### X1 — ESP32 + logic gate + readback (MCU ⇄ logic ⇄ circuit)

**Circuit:**
- ESP32 GPIO18 and a push button with a 10 kΩ pull-down drive a 3.3 V AND gate;
- the gate drives an LED through 220 Ω;
- the gate output is also wired back to ESP32 GPIO4 (input);
- the sketch (Arduino) mirrors GPIO4 to serial.

**Golden assertions:**
- the truth table through the real solve: LED current at each of the 4 states from the gate's
  output resistor and the LED card;
- the ESP32 reads back exactly the gate's level;
- the output voltage under the LED load against hand analysis;
- removing the pull-down gives `logic_input_floating`, named.

### X2 — MicroPython control with a hardware override through logic and a transistor stage (MicroPython ⇄ logic ⇄ discrete ⇄ electromechanical)

**Circuit:**
- `main.py` drives GPIO18 from a Python state machine (blink pattern, then steady);
- a NAND gate combines it with a manual "inhibit" toggle switch;
- the gate output drives the existing NPN BJT, which switches the existing relay coil from the
  5 V bench supply, with the existing diode as flyback;
- the relay contact switches an LED load;
- Python reads the relay state back through a second gate input path on GPIO4.

**Golden assertions:**
- base current from the gate's V_OH and the base resistor, and BJT saturation;
- the relay pulls in only when the gate output is HIGH, with the relay card's hysteresis;
- the LED current through the contact;
- Python's serial log of the read-back states equals the solved states;
- the same frame fingerprint ×2;
- swapping the gate to a 5 V-supplied CMOS part with the 3.3 V pad input gives X + the named
  diagnostic.

### X3 — Majority-voter safety interlock with fault diagnosis (multi-level logic network ⇄ MCU ⇄ discrete ⇄ CFF)

**Circuit:**
- three "sensor" inputs: two ESP32 GPIOs from MicroPython (simulated sensor states) and one
  toggle switch;
- a 2-of-3 majority voter from single gates, `(A·B) + (A·C) + (B·C)`: 3 AND + 2 OR, a two-level
  network settled in topological order;
- the voter output drives the relay stage of X2;
- MicroPython reads the voter output **and** each AND-gate output back, and reports a
  disagreement (a "sensor fault") on serial.

**Golden assertions:**
- all 8 input combinations against the majority function through the solve;
- the supply-pin current of each gate;
- three injected faults, each producing its named, honest result:
  - (a) a removed pull-down → `logic_input_floating`;
  - (b) an over-loaded output (a second LED without its resistor) → the output-current rating row
    (`absolute`);
  - (c) the voter's supply moved to 5 V with 3.3 V inputs → X propagating to the relay stage,
    with the relay result shown as unknown, not as a number;
- the read-back fault report equals the solved states.

---

## 6. Reliability and operational prerequisites

### 6.1 DEV disk capacity (measured 2026-10-20: 96 GB, 91 GB used, **5.1 GB free, 95 %**)

Read-only measurement (`du`, and a `hardlink -n` dry run, results in §6.1.1):

| Consumer | Size | Status |
|---|---|---|
| `~/tbi-r1-clean/rt/arduino` | 9.0 G | **ACTIVE**: bind-mounted into every DEV-Lab and staging build job (`/opt/tbi-arduino`) |
| `~/tbi-tools/arduino` | 7.8 G | provisioning source |
| `~/.local/share/tbi-lab-runtime` (arduino + runtime) | 8.8 G | default `TBI_RUNTIME_HOME` of local dev |
| `~/tbi-s12-rt-release/arduino` | 7.7 G | the RC4/Alpha release runtime home: **protected** (Runtime v2 rollback, Alpha handoff) |
| `~/tbi-s15-rt/arduino` | 6.1 G | the test runtime home (real-QEMU suites) |
| `~/tbi-s12-rel/g2/f4` | 8.0 G | Sprint 12 release gate evidence: **protected** |
| QEMU build trees (`*/build`) | ~1 G each × 3 | intermediate objects of runtime builds |
| `~/.vscode-server` | 7.0 G | editor server (two CLI/bin versions) |
| `/tmp` | 723 M | test leftovers |

**Finding:** the same pinned toolchain (arduino-cli `b8786322…`, arduino-esp32 3.3.12, ~59,770
files each) exists in **five** copies (≈ 39 GB).

**Remediation, in order of safety. Nothing is deleted in Sprint 19A; each step needs owner
approval:**

1. **Content-identical deduplication of the toolchain copies** (`hardlink`, util-linux 2.41):
   - files are merged only when byte-identical, with a full content compare, not hash-only;
   - no file disappears from any tree, and every path keeps its content;
   - before and after, each tree's profile pins (`verifyToolchain`) and a full sha256 manifest
     are recorded and compared;
   - the toolchain is read-only in use (bind-mounted read-only), so shared inodes cannot diverge
     through use;
   - reversible: a `cp -a --no-preserve=links` re-splits a tree.
2. **QEMU build trees** of runtimes whose release binaries are installed and validated (~3 GB):
   - archive, not delete: `tar --zstd` to compressed files, which keeps the evidence at roughly a
     fifth of the size (to measure);
   - never the active runtime prefixes (`~/tbi-s18-rt-release/qemu-2cb1406f94f52e4f`,
     `~/tbi-s12-rt-release/qemu-b5b34b49cb7e4049`).
3. **Editor and caches:** an old `.vscode-server` version (one of two: ~3 GB), `~/.npm` (657 M,
   re-downloadable), `/tmp` test leftovers. All need owner approval.
4. **A capacity rule:** a 10 GB free-space floor checked before builds, deploys and test runs.
   The build service already checks disk at admission (`checkResources`); the deploy scripts and
   test runners should check too.

No paid storage is proposed.

#### 6.1.1 Dedup dry-run result

`hardlink -n -c` (dry run: nothing changed) over the five toolchain `data/` trees, 867 s:

| Files | Linkable | Compared | **Would save** |
|---|---|---|---|
| 298,700 | 282,970 | 519,044 (sha256 + content) | **23.42 GiB** |

- Free space would go from 5.1 GB to about 28.5 GB.
- The dry run used `-c`: content only, ignoring owner, mode and mtime. The real O1 run must
  **not** unify permissions of the active, bind-mounted tree, so it runs without `-c` (owner,
  mode and mtime must match too) and is re-measured; the saving may be somewhat smaller.
- Record: `~/tbi-s19a/disk-dryrun.txt`.

### 6.2 Build-cache performance (after Sprint 18F)

- Deployed:
  - the core seed (seeded ~10–13 s on a quiet host, 8 s CPU; cold 34–37 s);
  - the curated prewarm (examples are cache hits);
  - the elapsed-seconds readout.
- **Remaining cost:**
  - ~8 s of CPU of fixed toolchain work (link 2.2 s);
  - the job's `CPUQuota=80%`, a policy limit that protects live sessions;
  - libraries compiled per build (LCD example: 13.4 s seeded).
- **Proposals:**
  - (a) seed the libraries the curated examples use, keyed like the core;
  - (b) raise the job CPU quota while no session is live (a policy change; the build already
    starts only when sessions allow).
- No cost increase. For MicroPython the "build" is a filesystem image (milliseconds); no
  compiler is involved.

### 6.3 Staging-isolation debt (D10, open since Sprint 13)

- **Today:**
  - staging (`tbi-s8`) and DEV-Lab (`tbi`) run as the **same** system users (`tbi-runtime`,
    `tbi-build`, `tbi-qemu`);
  - the union of their polkit rules lets `tbi-runtime` stop either instance's QEMU units;
  - mitigated only by procedure: no live DEV-Lab session during staging work.
- **Proposal:**
  - per-instance users and groups (`tbi-s8-runtime`, `tbi-s8-build`, `tbi-s8-buildjob`,
    `tbi-s8-qemu`);
  - polkit rules scoped by user **and** unit prefix;
  - state directories owned per instance;
  - a test asserting that staging's host cannot act on DEV-Lab units (the s8-containment suite,
    pointed across instances);
  - one sprint task, staging first, with the B0-style backup and rollback.
- No cost.

### 6.4 Release reproducibility (F-18-1)

- **Today:**
  - the release package (frontend + services) is byte-reproducible: verified on every Sprint
    18/18F package, two builds and two paths;
  - Runtime v3's QEMU binary is **not** byte-identical across build directories; only its runtime
    id reproduces. Release binaries are validated by running the pinned suites against them.
- **Proposal:**
  - build QEMU from a fixed path with `-ffile-prefix-map`/`-fdebug-prefix-map` in the meson
    CFLAGS and `SOURCE_DATE_EPOCH`;
  - verify with two builds in two directories → identical sha256;
  - a Runtime v4 (§4.3) is the natural point to adopt it, since it is a new build anyway.

### 6.5 Component Failure Framework gaps (from Sprint 17C, status now)

| # | Gap | Status | Proposal / slice |
|---|---|---|---|
| F1 | A part with unmodelled current (SG90) behind a resistor still "works" | open | stiff-supply rule: simulate only when VCC/GND are a supply output and ground directly; else hold + `operating` notice. Small; can go with L1 |
| F2 | Resistors have no power rating | open, **needs a product default** | `ratedPower` parameter; default unrated or ¼ W (owner) |
| F3 | No pulsed ratings | open | only where a datasheet gives pulse duty and width |
| F4 | Overstress is not sticky | open | latch "exceeded at t = …" per part until Stop. Small; can go with L1 |
| F5 | PSU regulation dynamics | refused (`pwm_supply_limited`), honest | none |
| F6 | Pad drive strength (GPIO16/17) and duty 0 (O-R4-1) | fail closed; **needs the owner bench session** | bench protocol `s13-evidence/h2/BENCH-PROTOCOL.md` |
| F7 | MCU-side unmodelled peripherals (no build analysis) | open | M1 §4.3 (`U` frames) |
| new: F8 | Logic parts need X / undefined as a first-class result in the ratings and inspector display | design (§3) | with L1 |

---

## 7. Sprint 19B execution plan

**Principle:** engineering capability per sprint, not component count.
- Three parallel tracks on separate branches.
- Each milestone ends in a test gate.
- The DEV-Lab deployment boundary is unchanged: staging gate first, rollback rehearsed, Alpha
  untouched, PR #7 unmerged.

**Prerequisite:** the owner's answers to EF-D1, EF-D2, EF-D3, EF-D4 and EF-D7, which L1 needs, and
EF-D5, which M1 needs. EF-D6, EF-D8 and EF-D9 can wait for the EF-1 track.

### Track O — operations (branch: none for data; scripts in `deploy/` on `sprint-19b-ops`)

| Milestone | Tasks | Acceptance |
|---|---|---|
| O1 disk | dedupe the toolchain copies (§6.1 step 1; dry run: 23.4 GiB) with before/after manifests; archive QEMU build trees (step 2) | ≥ 20 GB free; every toolchain tree's pins and sha256 manifest unchanged; DEV-Lab and staging builds byte-identical before/after; no active or protected path touched |
| O2 isolation | per-instance users for staging (§6.3) | the cross-instance containment test passes; staging B0 backup, rollback rehearsed; DEV-Lab untouched |

### Track L — digital logic slice L1 (branch `sprint-19b-logic`, from `sprint-15-r4` HEAD)

| Milestone | Tasks | Acceptance |
|---|---|---|
| L1.1 cards | family-card schema; the first device cards from the pinned datasheet revision; card self-tests (§3.9) | every guaranteed point met; boundaries ±1 mV; ratings |
| L1.2 engine | the gate `PartModel` (§3.3); floating/undefined/marginal; topological settling; feedback refusal | truth tables; 40-gate chain; refusal codes, each with its test; **all existing engine goldens bit-identical** |
| L1.3 product | catalog types, canvas/schematic symbols, 3D models (package), inspector (levels, X), capability registry entries, EN/HE texts | e2e for placement, inspection, X display; HE/RTL scan |
| L1.4 ESP32 | host path (no host change expected: gates are stateful parts like the relay); X1 example | X1 golden test on real QEMU; deterministic ×2 |
| L1.5 truth table | inspector analysis (§3.8) | 64-row table equals solves; off the UI thread |

### Track M — MicroPython slice M1 (branch `sprint-19b-mpy`, from `sprint-15-r4` HEAD)

| Milestone | Tasks | Acceptance |
|---|---|---|
| M1.1 build | `tbi-mklfs` pinned in the toolchain record; the `esp32-micropython-1.29` profile; the service path | byte-reproducible ×2 paths; an image boots `main.py` |
| M1.2 runtime v4 | QEMU patches for the `U` hooks (ADC, GPIO-irq, CPU clock first), capability `unmodelled`, reproducible build (§6.4) | §4.7 criterion 2; v3 behaviour unchanged for Arduino (pinned suites identical) |
| M1.3 host | `U` handling → `unsupported_feature`; paced serial input | refusal per facility; a 4 KiB input intact; Arduino serial suites unchanged |
| M1.4 measure | `machine.reset`, exceptions, Timer, UART1/2, SPI | each classified with a test |
| M1.5 product | editor mode, 2 examples, registry context, EN/HE | e2e; M1 exit criteria §4.7 |

### Cross-track

**X2 and X3 (§5)** come after L1.4 + M1.3: the golden tests and examples.

**Regression requirements (every milestone):**
- unit, typecheck, lint, the full e2e suite;
- the real-QEMU suites, with determinism pins unchanged;
- R1–R4 goldens bit-identical;
- the s18f build-seed equivalence;
- for any runtime or host change, the staging browser gate before DEV-Lab.

**Deployment boundaries:**
- DEV-Lab gets L1 and M1 only after their staging gates.
- Runtime v4 is deployed paired with its Session Host, with the v3 rollback kept.
- No Alpha change, no PR merge, no infrastructure cost.

**Track EF-1** (time kernel, local; branch `sprint-19b-kernel`) starts in 19B only if capacity
allows. Otherwise it starts in 19C. It is a 2–3 sprint track (EXPLORATION-FOUNDATION §3) and
gates the clock source, delays, the 555, sequential parts and the MOSFET under PWM.

**Parallelism on a 1-vCPU host:** the tracks parallelize as engineering work. Their heavy test
runs (real QEMU, e2e) are serialized by the test runner, and each track's gate runs alone.

---

## 8. Future / Backlog (not proposed for 19B)

- the ADC with an error band (EF-D5 B);
- 74HCT and DIP packages (EF-D2 C/ii);
- the 555 (EF-D6) and sequential logic (with EF-1);
- edge-domain PWM into logic;
- library seeding for builds;
- the MicroPython REPL as a product feature;
- MicroPython libraries (e.g. an LCD driver) beyond the firmware's own modules.
