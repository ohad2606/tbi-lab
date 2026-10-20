# Exploration Foundation — architecture proposals (Sprint 18, Workstream C)

**Status:** Proposed, for PM/owner review. Nothing in this document is implemented.
**Date:** 2026-10-20. **Base:** `sprint-15-r4` @ `3ac52b6` (R4 + Sprint 18 Workstream A).
**Owner direction it follows:** `docs/TODO.md` on `main` @ `15c8469` (Digital Logic & Integrated
Circuits: near-term; basic logic and the 555 first, before broad catalog expansion), CLAUDE.md (physics
must be real; MCU pin capability rule), PM-6/PM-9/PM-10/PM-11.

**Owner order, inconsistent in the TODO:** "Digital Logic, Switching & Integrated Circuits" orders
selected packaged logic ICs *before* the 555, while "Digital Logic & Integrated Circuits" orders the
555 *before* them. Both start with "basic logic primitives **and digital stimulus**". This
document follows the second list, and it proposes the time kernel (EF-1) **ahead of** the owner's
phase 1 (decision D-1, §11): stimulus with a frequency and the 555 both need it.

**Revision 2** (same day) follows an independent fact-check of revision 1; corrected points are
marked *(rev 2)*.

Each proposal (EF-1 … EF-8) can be reviewed and approved on its own; §10 gives the order they depend
on, §11 the decisions only the owner/PM can take. Datasheet figures quoted below are **placeholders
for the method**: each one is to be pinned from the named datasheet revision at implementation,
with the source recorded in the part card, as the existing cards do.

---

## 1. Where the engine stands (facts, with the code)

| Fact | Where |
|---|---|
| One MNA engine with Newton iteration; DC operating points. Parts added since Sprint 10 are `PartModel`s (elements, discrete `PartState`, `nextState`, `report`, `ratings`); the original resistor, LED, diode, PSU and GPIO pads are built into the session *(rev 2)* | `packages/engine/src/parts.ts`, `session.ts` |
| Discrete states settle by a fixed-point loop (relay armature hysteresis); a state that never settles is refused `no_steady_state` (a repeated state, or 32 passes). One pass updates every state from one solve, so a chain of *d* dependent states needs about *d* passes *(rev 2)* | `EngineSession.solveUnchecked` |
| Time-stepped solving exists: backward Euler, **fixed 1 ms step** in the browser worker, capacitor only; local circuits only | `parts/capacitor.ts`, `app/src/sim/worker.ts` (`STEP_S = 1e-3`) |
| ESP32 sessions are **DC only**: a time-dependent part is refused `unsupported_component` before the first guest instruction | `runtime/host/session.ts` (catalog `mcuRuntime: false`) |
| ESP32 inputs: datasheet V_IL/V_IH; the band between them **holds** the previous level (documented semantics) | `packages/engine/src/esp32Gpio.ts` `interpretDigitalInput` |
| The host knows MCU outputs only when QEMU reports them, at exact virtual time, and can schedule input changes at exact future virtual times (`sched-input`: the queue is QEMU's, mirrored by the host's `InputSchedule`; `J` strictly after the frame being answered; `X <pad>` cancels every pending entry of a pad; at most 512 pending, ≥ 1 µs apart on one pad, 4096 `J` per session per simulated second *(rev 2)*; ADR-011) | `runtime/harness/protocol.ts`, ADR-011 |
| PWM: two exact operating points averaged by duty (A1), refused wherever averaging would invent physics; Sprint 18 caches the points (F-17C-2) | `runtime/host/pwmElectrical.ts` |
| Ratings framework: `absolute` / `operating` / `unrated`, `outsideModelRange`, model-limitation notes | Sprint 13 H2, `packages/engine/src/ratings.ts` |
| Capability registry: firmware facilities and parts, generated panel, refusal at build | `packages/domain/src/capabilities.ts`, `runtime/builder/features.ts` |

## 2. Selection principle: multipliers, not component count

A capability multiplies designs when it makes many **combinations** of existing and new parts
simulable, not one more part. Candidates scored on: designs unlocked (combinatorial), physics risk
(can it be modelled from documented data, and refused where not), cost on the 1-vCPU DEV host, and
what it depends on.

| Candidate | Unlocks | Physics risk | Depends on | Verdict |
|---|---|---|---|---|
| **EF-1 Mixed-signal time kernel in ESP32 sessions** | every RC (debounce, filters, delays), capacitors with the ESP32, 555 with the ESP32, PWM into RC loads (exact ripple instead of a refusal), later inductive loads | low (backward Euler/trapezoid are standard; validation by analytic solutions) | nothing new | **Yes, first: the foundation** |
| **EF-2 Digital logic as electrical parts** (family card, single gates, stimulus, inspection) | gate networks, level-compatibility checks, ESP32 + logic, logic + LEDs/transistors | medium (family data is tabulated at a few supply points; the undefined band must be explicit) | none for combinational; EF-1 for clocks/delays | **Yes** |
| **EF-3 555 timer** | astable/monostable designs, 555 + ESP32, 555 + logic | medium (datasheet block diagram + guaranteed figures; timing from the RC network) | EF-1 | **Yes (owner priority)** |
| **EF-4 One logic-level N-MOSFET** | switching loads above 3.3 V / 40 mA from GPIO, PWM motor/LED-strip drivers, logic-to-power | medium (square-law fit to datasheet; validity range flagged) | none (EF-1 for gate charge) | **Yes, small** |
| Potentiometer | dividers, 555 adjustment; but its main ESP32 use is the ADC | low | ADC decision (§11 D-5) | Only with/after the ADC decision |
| ESP32 ADC | potentiometers, LDR/thermistor values, analog sensors | **high**: the classic ESP32 ADC is non-linear with per-chip calibration; an ideal ADC would invent accuracy | QEMU SENS/ADC + bridge | Owner decision (§11 D-5), not in the first set |
| More sensors/displays | one design each | varies | — | No (not multipliers) |

The recommended set is **EF-1 → EF-2 → EF-3, with EF-4 alongside EF-2**, and the contracts (EF-7)
and reference projects (EF-8) built with them, not after them.

---

## 3. EF-1 — Mixed-signal time kernel (local and ESP32 sessions)

**Problem.** A fixed 1 ms step cannot resolve a 555 at kHz rates or a 50 µs debounce edge, and the
ESP32 session cannot solve time-dependent parts at all, so every RC network next to an ESP32 is
refused.

**Proposal.**

1. **One time kernel in the engine** (`EngineSession.advanceTo(t)`), shared by browser and host
   (ADR-008): variable step, trapezoidal with backward-Euler start-up and after every discontinuity
   (no trapezoidal ringing at switching edges), local-truncation-error step control, a **minimum
   step floor** and a **step budget per simulated second**. Step control is a pure function of the
   circuit state: no wall clock, so runs are deterministic (R-MCU-1 extends to it).
2. **Breakpoints:** every known discontinuity is a step boundary, exactly: MCU output events
   (virtual time from QEMU), PWM edges (the R4 `LedcTracker` already gives exact rational edge
   times), stimulus-source edges.
3. **Event localization:** when a step changes a part's discrete state (a comparator, a logic
   input crossing V_IH, a relay), the step is bisected until the crossing time is bracketed to a
   stated tolerance (proposal: 10 ns or 1e-6 of the step), and the state changes at that instant.
4. **ESP32 lockstep with prediction and rollback.** QEMU is deterministic in virtual time, but the
   host learns an MCU output only when it happens. Per command tick (1 ms):
   - snapshot the engine (time, histories, discrete states: small);
   - advance to the next tick assuming the outputs stay as they are, and schedule every MCU input
     crossing found on the way with `sched-input` at its exact virtual time;
   - when QEMU reports an output change at `t_e` before the tick ends, restore the snapshot,
     re-advance to `t_e`, apply the change and predict again. *(rev 2)* The queue is QEMU's (the
     host keeps a mirror, `InputSchedule`); there is no "cancel after `t_e`": the host sends
     `X <pad>` for every pad with predicted entries after `t_e` (QEMU, stopped at the frame for
     `t_e`, has already applied the earlier ones) and re-sends the still-valid `J`s. The tie at
     exactly `t_e` (an entry due at the frame being answered) must be defined by a new decision,
     derived from the bridge's store-vs-timer order in patch 0006: ADR-007 does not settle it, and
     a `J` can never land at the frame it answers.
   An input the MCU must see is therefore delivered at its physical crossing time **within the
   bridge's limits, or the session is refused by name** *(rev 2)*: `J` strictly after the frame,
   ≥ 1 µs between entries on one pad (two crossings closer than that cannot be represented), 512
   pending, and the 4096 `J`/s budget, which counts every `J` sent, so speculative entries that a
   rollback cancels consume it. The budget must be re-specified for speculative scheduling (or
   counted on committed entries only), with a test whose sent `J`s exceed it.
5. **A1 stays** for purely resistive PWM loads (exact and cheap). With EF-1 a PWM pad driving an RC
   load is simulated edge by edge instead of refused. The `pwm_load_unsupported` refusal is then
   kept only for loads without a model.
6. **Honest speed:** simulated time may run slower than real time. The app shows the real-time
   factor. Beyond the step budget the session is refused (`transient_budget_exceeded`), never
   approximated by a larger step.

**Validation (all automatic):**
- RC charge/discharge against `v(t) = V(1 - e^{-t/RC})` at stated tolerance.
- RC driven by an exact PWM waveform: the periodic steady state and its ripple against the analytic
  expression.
- Two-pole RC ladder against a closed form.
- Event localization against analytic crossing times.
- Determinism: identical breakpoints and outcomes over repeated runs, local and through QEMU.
- The current DC paths must stay bit-identical: the kernel is engaged only when a time-dependent
  part exists. *(rev 2)* Gate input capacitance (EF-2) and MOSFET gate charge (EF-4) are therefore
  elements of time-stepped sessions only; at DC they are absent, as a capacitor is open today.

**Cost estimate (DEV host), *(rev 2)* with its limits:**
- **Solve cost:** a DC solve takes 0.23–0.46 ms for 2–16 parts. This is the Sprint 18
  micro-benchmark of the PWM work, also in `SPRINT-18-R4.md`; earlier references are 0.45 ms per
  1 ms step for `rc-fade` (Sprint 10) and 0.31 ms with QEMU contending (V1-ARCHITECTURE).
- **Workloads:**
  - an RC network next to a GPIO needs tens of steps per event;
  - a 1 kHz 555 needs about 200 steps per period, i.e. about 0.07 s of CPU per millisecond
    simulated, roughly 70× slower than real time;
  - edge-by-edge PWM at LEDC rates (1–5 kHz) is about 10^4 breakpoints per simulated second.
- **Not yet counted:** QEMU sharing the one vCPU, rollback re-advances, bisection solves and
  fixed-point passes per step. The real factor is worse.
- **Interaction with existing limits:**
  - the host is one Node event loop for up to 4 sessions;
  - `stallTimeoutMs` is 10 s, and `maxLifetimeMs` is 30 min, i.e. about 26 s simulated at 70×;
  - `PWM_SOLVE_BUDGET_PER_SIM_S` is 1000 and the `J` budget 4096/s.

  `transient_budget_exceeded` must be defined against these (kernel solves budgeted separately
  from the PWM reconfiguration budget, which A1 keeps for resistive loads).
- **Rule:** a kHz 555 is *simulated correctly in slow motion*, not faked in real time, or refused
  by name when the budgets cannot hold it. The visible real-time factor is part of the proposal.

**Effort:** 2–3 sprints (kernel + local, then ESP32 lockstep). **Risk:** the rollback must be
exhaustively tested against the `sched-input` queue semantics. **Also needed** *(rev 2)*:
- lifting the host's refusal of time-dependent parts (`runtime/host/session.ts`);
- the catalog's `mcuRuntime` / `mcuRuntimeReason` for the capacitor;
- a revision of ADR-010.

## 4. EF-2 — Digital logic as electrical parts

**Rule (owner TODO):** logic is never abstract 0/1 where electrical behaviour matters.

**Proposal.**

1. **A logic-family card**: a data record per family and device, pinned to a datasheet revision. It
   holds:
   - the supply range;
   - V_IH/V_IL, V_OH/V_OL at their test currents, at each tabulated V_CC;
   - input leakage, I_CC quiescent;
   - absolute maxima (V_CC, I/O clamp, output current, V_CC/GND pin current);
   - propagation delay (typ/max, with the load it is specified at).

   The values are used **only at the tabulated supply points, with stated bands**:
   - between rows: refuse, or use the more conservative row (owner decision D-3), never
     interpolate silently;
   - outside the supply range: `outsideModelRange`.
2. **Gates are real parts**, not ideal symbols. The first primitives are **single-gate devices**
   that exist physically (e.g. the 74LVC1G / 74AHC1G single-gate series): a NOT, AND, OR, NAND,
   NOR, XOR, XNOR or buffer, each with explicit VCC and GND terminals. A primitive is therefore
   both "basic logic" and a buyable part.

   Packaged multi-gate ICs come next and reuse the same model:
   - one canonical pin map per package (e.g. a quad-NAND DIP-14);
   - several gate instances;
   - shared supply pins.
3. **Electrical elements per gate:**
   - each input is the datasheet leakage bound, plus input capacitance under EF-1. *(rev 2)*
     The leakage is a ±I bound with no sign, so it is not modelled as a conductance to a rail:
     that would make an unconnected CMOS input deterministically LOW, which is invented. A
     **floating input** (no DC path to a driver, a supply or a pull resistor) is detected
     topologically and is **X**, or the Run is refused (`logic_input_floating`, naming the pin).
     That is also the owner's "unconnected required pins" check;
   - each output is a Thevenin source **between the part's own VCC or GND pin and the output
     node**. Output current therefore flows through the supply pins (KCL correct: fan-out,
     supply current and pin-current ratings come out of the solve, not from counting);
   - the output resistance comes from the datasheet's guaranteed V_OH/V_OL test points, documented
     as the guaranteed (worst-case) characteristic (D-4: guaranteed vs typical). *(rev 2)* The
     linear source is valid only up to the largest tabulated test current: beyond it
     `outsideModelRange`, and the output-current absolute maximum is a rating row;
   - output kinds as the device has them: push-pull, **tri-state** (enable pin: the output
     element is absent while disabled, so the node is driven by others or floats → X downstream),
     **open-drain / open-collector** (only the sink element; a missing pull-up is a named
     diagnostic, not a level);
   - I_CC is a quiescent sink.
4. **Discrete state:** the output level per gate, settled by the existing fixed-point loop.
   Combinational loops without delay that oscillate are `no_steady_state` (honest). *(rev 2)*
   One pass updates every state from one solve, so a chain of *d* gates needs about *d* passes,
   and the loop's 32-pass cap would refuse a stable chain of more than about 31 gates. The
   proposal therefore settles logic states in topological order within a pass: gates sorted by
   the nets they drive, each re-evaluated after its inputs. Feedback loops are detected and
   iterated; the cap is raised only for them, with a test for a 40-gate chain. With EF-1 and
   the datasheet propagation delay, ring oscillators become simulable, labelled with the delay
   figure used.
5. **The undefined band is explicit.** An input between V_IL and V_IH is **X**:
   - *(rev 2)* **X propagates**: a gate whose output depends on an X input has an X output.
     Its output element is removed (no driven level), so the node it drives is undetermined.
     Every downstream input is X, every affected part is shown as unknown, and
     `logic_input_undefined` names the first input in the band. A held level is never driven:
     that would be an invented number (EF-7 §5);
   - when an X reaches anything electrical whose result the user would read as a number (an LED,
     an ESP32 input), that part's result is shown as unknown, or the Run is refused if no honest
     display exists;
   - an X on a clock input refuses the edge.

   (The ESP32's own inputs keep their documented hold semantics.)
6. **Logic compatibility is a solve result, not a lookup.** A 3.3 V ESP32 output into a gate whose
   V_IH at 5 V is above 3.3 V produces X and a diagnostic naming both parts. The correct
   level-shifting design works.
7. **Sequential parts** (D flip-flop first):
   - the state holds Q and the last clock level, and edges are detected between settled solves;
   - asynchronous set/reset have priority per datasheet;
   - **setup/hold:** D changing in the same event as the clock edge (DC sessions), or within the
     datasheet setup/hold window (EF-1), gives an X output and `logic_timing_violation`, never a
     guessed winner.
8. **Digital stimulus:**
   - in DC sessions, the existing toggle switch and push button with pull resistors already
     serve;
   - a **logic source** part is added with EF-1: frequency, duty, initial level, one-shot; an
     ideal source behind a user-set output resistance. Its edges are kernel breakpoints, and it is
     labelled as an instrument, not a chip.
9. **Truth-table and inspection** are analysis over the same model. The inspector clones the
   session's engine and solves every combination of the selected stimulus inputs: at most 6
   inputs, 64 combinations; at 0.3–0.5 ms per solve and a few passes each, 0.1–0.5 s,
   off the UI thread *(rev 2)*. Manual input stepping and Boolean-expression display (owner TODO)
   are views over the same table; active-path highlighting and X-Ray come later and read the same
   solved states. It reports each output as HIGH, LOW or X, with its node
   voltage. It is never a separate logic simulator.
10. **ESP32 interaction:** GPIO → gate → GPIO works in today's host DC loop (gates are stateful
    parts like the relay). **PWM into a gate:** A1 averaging is wrong for logic. For a purely
    digital network fed by PWM, the exact answer is an edge-domain propagation of the rational
    waveforms (zero delay or datasheet delay), a later extension of the R4 tracker. Until then it
    stays refused (`pwm_load_unsupported`, named).

**Validation:**
- Every gate's truth table, with inputs at the guaranteed rails.
- V_OH/V_OL at the datasheet test currents reproduced exactly; the fan-out limit crossing the
  rating.
- 3.3 V → 5 V compatibility, both the failing and the correct design.
- D flip-flop edge, asynchronous-reset and simultaneity cases.

**Also required before a part is exposed** *(rev 2, owner TODO "IC model requirements",
"Pin/package correctness", "Three-view integration")*:
- one canonical device definition per part, shared by Workbench, Schematic, 3D, simulation and
  AI: pin numbers, names and roles, package, source revision;
- topology checks: wrong power pin, swapped supply, unconnected required pins, package-specific
  pin differences;
- the AI layer reads the same records, never pin maps from model memory.

Families: CMOS (74HC, 74AHC/LVC) first. TTL-like behaviour (74HCT inputs, 74LS) comes later, as
separate cards; it is not inferred from CMOS figures. The SR/D latch and the D flip-flop share the
sequential mechanism (§7). Rise/fall timing comes only under EF-1, from datasheet transition
times, labelled typ/max.

**Effort:** 1 sprint for card mechanism + single gates + inspector; 1 for packages + D flip-flop.

## 5. EF-3 — 555 timer (first integrated circuit)

**Model**, from the datasheet functional block diagram of one named device (NE555 bipolar or a
CMOS TLC555/LMC555: owner decision D-6; they differ in divider, thresholds, output stage and
supply current):
- the internal resistor divider as real resistors between VCC, CONT and GND, so the Control
  Voltage pin is electrically real;
- two comparators: discrete decisions on their pin voltages against the divider nodes, with the
  datasheet threshold/trigger input currents as elements;
- the SR latch as discrete state, with RESET priority below its datasheet threshold;
- the discharge transistor: a switch with the datasheet saturation figure at its test current;
- the output stage as a source pair fitted to the datasheet V_OH/V_OL test points at the
  tabulated supply;
- I_CC by output state.

Timing is never a formula: it emerges from the RC network under EF-1.

**Validation:**
- Astable and monostable against the analytic times *of the model's own thresholds* (with ideal
  2/3 and 1/3: `t_H = ln 2 (R_A + R_B) C`, `t_L = ln 2 R_B C`, `T = 1.1 R C` for the monostable).
- The datasheet's timing-accuracy and drift figures shown as the real part's band, not hidden.
- CONT-pin modulation; RESET; output loading against V_OH/V_OL.

**Effort:** 1 sprint after EF-1. **Rule:** one device first, its card cites the datasheet revision.

## 6. EF-4 — Foundational analog/discrete (kept deliberately small)

- **One logic-level N-MOSFET.** A square-law model fitted to the named datasheet's transfer and
  R_DS(on) figures:
  - the validity range (V_GS window, subthreshold excluded) is enforced with `outsideModelRange`;
  - absolute maxima: V_DS, V_GS, I_D, power;
  - the gate is an open circuit at DC; gate charge under EF-1.

  This turns every ESP32 GPIO and logic output into a load switch. *(rev 2)* **Under PWM, A1 does
  not cover it today:** transistors are not in `PWM_AVERAGED_TYPES`, and are refused. Admitting a
  MOSFET to A1 would assume instant switching. That is justifiable only as an explicit
  **conduction-loss-only** model, refused or labelled when the PWM period approaches the
  datasheet switching times, and it understates dissipation by the switching loss. The honest
  default is EF-1 with gate charge. The decision is D-8.
- **Potentiometer:** only together with the ADC decision (§11 D-5). As a local divider it is
  cheap; its classroom value next to an ESP32 is the ADC.
- **Not proposed now:** inductors and motors (need EF-1 plus back-EMF models), op-amps (a family
  decision of their own), more sensors.

## 7. EF-5 — Mixed circuit, logic and MCU interaction (the contracts between domains)

| Boundary | Today | With the proposals |
|---|---|---|
| MCU output → circuit | DC solve per GPIO event; PWM A1 | + time kernel between events (EF-1) |
| Circuit → MCU input | DC level with hold band, at the event | + exact crossing times scheduled via `sched-input` (EF-1 §4) |
| Logic → MCU / MCU → logic | — | stateful parts in the same solve (EF-2); X in the undefined band |
| PWM → logic | refused | edge-domain propagation (later); refused until then |
| IC (555) → MCU | — | under EF-1: e.g. `pulseIn` measuring a 555 monostable |
| MCU → anything not modelled | refused at build (Arduino), at run time for MicroPython (EF-7) | unchanged rule |

Every new boundary is either exact or refused, by name. No boundary averages, guesses a level or
invents timing.

## 8. EF-6 — Genuine ESP32 Classic MicroPython

Covered by `MICROPYTHON-FEASIBILITY.md` (Workstream D evidence, this sprint):
- the real MicroPython firmware runs unmodified in the same QEMU runtime;
- code is delivered to the interpreter itself, never translated;
- unmodelled facilities are refused at run time by the emulator (EF-7), because Python has no
  build-time symbol analysis.

## 9. EF-7 — Support and refusal contracts

1. **One registry, every context.** Extend `capabilities.ts` from "firmware facility / part" to
   a status per (feature, context), with three contexts: local circuit, ESP32 Arduino, ESP32
   MicroPython. The statuses are the registry's existing `supported`, `limited` (with the named
   limits) and `unsupported` (with the refusal code) *(rev 2: names as in the code)*. The capability panel, the palette and the AI layer read the same records
   (CLAUDE.md MCU pin capability rule).
2. **Every refusal is executable.** Each `refused` or `limited` entry names a test that provokes
   it. A registry test fails when an entry has no test or a test has no entry. This makes the
   existing `FEATURE_CODES` sync test general.
3. **Run-time refusals from the emulator**, for runtimes without build analysis (MicroPython). A
   QEMU access to an unmodelled peripheral register block becomes a bridge frame
   `U <vns> <block>`, and the host refuses `unsupported_feature` naming the facility. *(rev 2)* The
   bridge parser fails closed on unknown frames, so `U` comes with a new capability token in the
   hello (ADR-011 §1), and hosts without it never receive it. The first
   blocks: SENS/ADC, GPIO interrupt enable, RMT, MCPWM, PCNT, RTC sleep, Wi-Fi/BT MAC. Today some of
   these silently read zero, and the ADC crashes the guest. Root cause: SENS `SAR_MEAS_START1`
   never reports done, polled 12.6 M times (MICROPYTHON-FEASIBILITY §1).
4. **Model-validity contract**, unchanged in kind:
   - `outsideModelRange` for an operating point outside the model's fitted range;
   - rating kinds `absolute` / `operating` / `unrated`.

   Every new part (gates, 555, MOSFET) must declare its validity range and rating rows before it
   is exposed.
5. **The undefined is a state** (logic X, unknown servo current, unverified duty 0): shown as
   unknown, never as a number.

## 10. EF-8 — Reusable engineering projects (cross-domain composition)

Each project ships as an example (language-neutral project data, EN/HE text) **and** as a golden
test asserting its numbers. That proves the composition rather than showing it.

| # | Project | Domains | Golden assertion |
|---|---|---|---|
| P1 | Push button with an RC delay into an ESP32 input (*rev 2*: not a "debounce" demonstration: the engine has no contact-bounce model, and none may be invented) | circuit + MCU (EF-1) | the input edge time equals the analytic RC crossing of V_IH ± the event tolerance; `micros()` in the firmware agrees within the bridge quantization |
| P2 | 555 astable LED blinker (≈1 Hz) | IC + circuit (EF-1, EF-3) | period vs the model's analytic times; LED current from the solve |
| P3 | ESP32 GPIO AND a push button through a single AND gate to an LED | MCU + logic + circuit (EF-2) | truth table through the real solve; LED current at each state |
| P4 | 3.3 V ESP32 output into a 5 V CMOS gate: the failing design and the corrected one | logic compatibility (EF-2) | X and `logic_input_undefined` in the first, a valid level in the second |
| P5 | ESP32 PWM → logic-level MOSFET → a 12 V load of existing parts (resistor + LEDs; the catalog has no LED-strip part) from the bench supply | MCU + discrete + supply (EF-4 with EF-1, or A1 conduction-only per D-8) | averaged and peak currents; conduction dissipation against the rating, with switching loss shown as not included (A1) or simulated (EF-1) |
| P6 | ESP32 triggers a 555 monostable and measures it with `pulseIn` | MCU + IC (EF-1, EF-3) | the measured width equals the model's `1.1 R C`, within `pulseIn` quantization (F-R2-2). *(rev 2)* With an NE555 (≥ 4.5 V supply) the output exceeds the ESP32 pad maximum: a divider is part of the design; with a CMOS 555 at 3.3 V not. Tied to D-6 |
| P7 | MicroPython blink and PWM fade | MicroPython + R4 (EF-6) | the same frame fingerprint across runs; duty exact |

## 11. Order, effort and the decisions needed

**Order** (*rev 2*: EF-1 ahead of the owner's phase 1, see the header and D-1):
EF-1 (local) → EF-2 slice 1 (single gates, family card, inspector) with EF-4 →
EF-1 (ESP32 lockstep) → EF-3 (555) → EF-2 slice 2 (packages, D flip-flop) → EF-6 after its probe
exit criteria. EF-7 and EF-8 accompany every slice.

**Owner/PM decisions** (none can be taken by engineering):

| # | Decision | Options |
|---|---|---|
| D-1 | Approve EF-1 as the foundation, **ahead of** the TODO's phase 1 (logic primitives + digital stimulus), with "slow motion, never approximated" (the real-time factor shown). Alternative: logic primitives first in DC sessions (manual stimulus only), EF-1 next | EF-1 first · logic first |
| D-2 | First logic family and supply | 74HC at 5 V (classic) · 74AHC/74LVC at 3.3 V (direct ESP32 interop) · both, with 74HCT as the level shifter |
| D-3 | Supply voltages between datasheet rows | refuse · conservative row · interpolation **if** the datasheet states proportional limits (e.g. 0.7 V_CC) |
| D-4 | Output characteristic | guaranteed (worst case, conservative) · typical (closer to a bench, not guaranteed) |
| D-5 | ESP32 ADC (and with it the potentiometer next to an ESP32) | not now · a calibrated transfer with the datasheet's error band shown · ideal (not recommended: invents accuracy) |
| D-6 | The first 555 | NE555 (bipolar, the textbook part) · TLC555/LMC555 (CMOS, runs from 3.3 V with the ESP32) |
| D-7 | Approve the reference-project set (§10) as the acceptance of the Exploration Foundation | — |
| D-8 *(rev 2)* | A MOSFET under PWM | EF-1 only (gate charge, switching simulated) · A1 conduction-loss-only, labelled, refused near the switching times |
| D-9 *(rev 2)* | Which TODO phase order is authoritative (packaged ICs before or after the 555) | — |
