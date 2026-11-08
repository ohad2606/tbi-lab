# Exploration Foundation — L3 packaged logic, L2 state inspection, ESP32 interop

**Branch:** `explore-logic-l2l3` (off `sprint-19b-mpy`, with `sprint-19b-logic` PM-1 merged).
DEV only; not deployed. Roadmap items L2 and L3 of the EF-D9 C logic track (docs/TODO.md on
`sprint-19b-todo`). S1 (sequential logic) is out of scope.

## L3 — SN74LVC08A (quad 2-input AND, one shared supply)

**Source:** Texas Instruments SCAS283W, "SNx4LVC08A Quadruple 2-Input Positive-AND Gates",
January 1993, revised July 2024, downloaded from ti.com/lit/ds/symlink/sn74lvc08a.pdf; pinned in
`~/tbi-s19d/explore/datasheets/` (PDF sha256 `5edd5cd664dac4f3774c9c6fc7ad8310c8f2ca3da7f0e369aa69dfe2b1cc2ba4`).
SN74LVC08A, −40 °C to +85 °C column (as for L1).

| Figure | Value | Section |
|---|---|---|
| Pin map (D, DB, NS, PW) | 1A 1, 1B 2, 1Y 3, 2A 4, 2B 5, 2Y 6, GND 7, 3Y 8, 3A 9, 3B 10, 4Y 11, 4A 12, 4B 13, V_CC 14 | §4 Table 4-1 |
| V_CC operating | 1.65–3.6 V | §5.4 |
| V_IH / V_IL | 0.65/0.35 × V_CC (1.65–1.95 V); 1.7/0.7 V (2.3–2.7 V); 2/0.8 V (2.7–3.6 V) | §5.4 |
| V_OH min | V_CC − 0.2 V @ −100 µA (1.65–3.6 V); 1.2 V @ −4 mA (1.65 V); 1.7 V @ −8 mA (2.3 V); 2.2 V @ −12 mA (2.7 V); 2.4 V @ −12 mA and 2.2 V @ −24 mA (3 V) | §5.7 |
| V_OL max | 0.2 V @ 100 µA (1.65–3.6 V); 0.45 V @ 4 mA (1.65 V); 0.7 V @ 8 mA (2.3 V); 0.4 V @ 12 mA (2.7 V); 0.55 V @ 24 mA (3 V) | §5.7 |
| I_I, I_CC, ΔI_CC | ±5 µA; 10 µA; 500 µA | §5.7 |
| Absolute maxima | V_CC 6.5 V; V_I −0.5…6.5 V; V_O −0.5…V_CC + 0.5 V; I_O ±50 mA; through V_CC or GND ±100 mA | §5.1 |
| V_I recommended | 0–5.5 V (inputs 5.5 V tolerant) | §5.4, §7.3.4 |
| t_pd (carried, not simulated) | 1–4.1 ns at 3.3 V ± 0.3 V | §5.9 |

**Model.** The L1 gate model unchanged (input rows, guaranteed output envelope through every test
point, Kleene evaluation), four times, with the package's own solved supply. Every HIGH output is
an element from the shared V_CC pin, every LOW output one to the shared GND pin: the supply-pin
currents are the sums, out of the solve. Feedback is analysed per gate (`U1#2`), so a chain
between gates of one package is allowed and a loop (also inside one package) is refused.

**Decisions taken from the sheet (stated, not approximated):**
- The 2.3–2.7 V and 2.7–3.6 V input rows share 2.7 V: there the stricter of the two applies
  (V_IH 2.0 V, V_IL 0.7 V).
- No PM-1 class bound: this sheet states no 3.3 V drive (the L1 sheets' "±24-mA output drive at
  3.3 V"). At 3.3 V only the ±100 µA row is guaranteed; a real load there is refused
  (`logic_output_uncharacterized`). **Owner decision needed** to extend PM-1 to this sheet.
- No I_off row: V_CC = 0 V is refused (`logic_unpowered_uncharacterized`), never "off".
- Footnote (1) of §5.4, "All unused inputs of the device must be held at VCC or GND": a floating
  input of any gate, used or not, is refused (`logic_input_floating`, naming the pin, with a
  device-specific message quoting the rule). Unused outputs may stay open (optional terminals).
- P_tot (500 mW, derated with temperature) is not checked; ambient temperature is not modelled.
  The ±100 mA supply-pin and ±50 mA output limits are checked.
- Terminal ids are `a1, b1, y1 … y4` (the session protocol's identifiers start with a letter);
  every view shows the datasheet names `1A … 4Y`.
- No bound is claimed for an unknown (X) output's current: the absolute maxima are stress ratings
  (§5.1 note 1; §7.3.1 "capable of driving larger currents than the device can sustain"). A
  current-limited supply feeding an X output is refused (`logic_unknown_state`).
- An input between V_IL and V_IH is refused (`logic_input_undefined`): the sheet gives no level
  and no supply current there (I_CC only with inputs at V_CC or GND, ΔI_CC at V_CC − 0.6 V). So the
  static-CMOS inference "a controlling input decides when the other is undefined" (an inference
  from CMOS structure, not in this sheet's Table 7-1) is never used for the package. An input on an
  undetermined net is refused (`logic_unknown_state`), one outside V_I 0–5.5 V
  (`logic_input_out_of_range`).
- I_CC (≤ 10 µA) is reported only with every input within 1 mV of a rail; otherwise the quiescent
  current is "not characterized", with ΔI_CC (500 µA per input at V_CC − 0.6 V) shown. The solve
  never includes I_CC (as for L1).
- The output envelope between guaranteed points is linear (the approved L1 method, EF-D4 A); it is
  conservative only if the real V(I) is convex — device physics, not a datasheet statement.
- Breadboard part: the D (SOIC-14) package (D0014A outline) on a representative breakout; the
  sheet has no through-hole package.

## L2 — logic state inspection

`ComponentResult.logic` (engine) for every logic part: per gate, each pin's level as the device
model classified it, and its voltage relative to the part's own GND pin; V_IH/V_IL at the solved
supply. The Inspector shows a pin table (an input between V_IL and V_IH: "undefined", never a
level; a pin on an unknown net: no number) and the function's truth table with the rows the gates
are in. EN/HE; technical cells LTR.

## Interop — `esp32-logic-quad-and`

ESP32 GPIO18/GPIO19 → gate 1 → 220 Ω + LED; 1Y → 2A; push button (10 kΩ pull-down) → 2B →
220 Ω + LED; gates 3/4 inputs to GND; the IC at 3.0 V from the bench supply (where real loads are
characterized). Golden test `app/tests/l3-logic-quad.test.ts` checks the chain's truth table,
the guaranteed-envelope operating point, KVL and the shared supply current on the solved numbers.

## Independent review (read-only agent, datasheet vs. diff)

All card figures, the pin map and the D0014A dimensions were verified against SCAS283W (−40…85 °C
column alignment checked). Confirmed issues and disposition:
1. Unknown-output current bound used the ±50/±100 mA absolute maxima as a physical limit →
   **fixed** for the package (no bound; refused). L1 keeps 50 mA (pre-existing, see below).
2. Supply current reported as known with inputs away from the rails / in the undefined band →
   **fixed** (refusal in the band; I_CC only at the rails, else "not characterized" + ΔI_CC).
3. The package showed the 1G sheets' delay figures → **fixed** (own limitation, 1–4.1 ns).
4. Ratings gaps (V_CC < −0.5 V; inputs below 0 V; inputs above 5.5 V still classified) →
   **fixed** (ratings rows; above/below the recommended V_I range refused).
5. Comment cited §5.4 for the between-row 100 µA limit → **fixed** (§5.7).
6. X-input inference not in this sheet → **moot** for the package (refused), documented above.
7. Pin-map column citation listed W (CFP) → **fixed**.
8. Pad-mode test accepted any `logic_*` code → **fixed** (exact levels asserted; all 9 solve).
9. Missing coverage → **added**: 2.7 V, 1.65 V and 1.8 V (ranged) solves, the package's
   `logic_unknown_state`, the wrong-way output refusal, `logic_input_out_of_range`.
L2 notes: thresholds text now says "where two rows meet, the stricter"; the device's
output-uncharacterized text covers the wrong-way case. Alias "7408" (TTL) removed.

## Found, not changed (pre-existing, for decision)

- The ESP32 pad model in **input** mode is a linear leakage conductance to GND (esp32Gpio.ts).
  A gate input wired only to an ESP32 pad in input mode therefore solves at 0 V (LOW) instead of
  being refused as floating. Before the firmware's `setup()` runs, this is the state of the
  example's gate-1 inputs. It predates this work (L1/X1 behave the same).
- L1 single gates: the unknown-output bound is still the 50 mA I_O absolute maximum, I_CC is
  still reported with inputs away from the rails, an input in the undefined band still gives an X
  (or a controlling-input) result instead of a refusal, and the delay text is shared. These are the
  same points the review raised for the package; changing shipped L1 behaviour needs a PM decision.
- L1 single gates reported a missing GND as `logic_unknown_state`; now `logic_supply_missing` (fix).
