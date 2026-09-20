# Gate A — Electrical Simulation Feasibility

Feasibility experiment. **Not product code.** Everything here is disposable.

## Question

Can we perform deterministic, physically valid DC circuit simulation in the browser?

## Approach

Two independent tracks, so that "the numbers are right" does not rest on a single
implementation:

- **A1 — our own solver** (`src/`): Modified Nodal Analysis in TypeScript. Dense LU with
  partial pivoting, Newton-Raphson for nonlinear junctions with SPICE `pnjlim` limiting,
  and an **active-set formulation** for lab-PSU CV/CC crossover.
- **A2 — ngspice as an oracle** (`tests/ngspice-crosscheck.test.ts`): the same circuits are
  solved by ngspice 45.2 (WebAssembly, via the MIT-licensed `eecircuit-engine` wrapper) and
  the results compared. **Development/test dependency only — not a production dependency.**

No final engine choice is made or implied by this experiment.

## Why the results are physics and not curve-fitting

1. **The solver verifies itself against the exact equations.** After Newton converges, the
   solution is substituted back into the *non-linearised* device equations and the KCL
   residual at every node is computed. If it exceeds tolerance, `solve()` throws rather than
   returning a number. A converged-looking Newton step is not accepted as evidence.
2. **PSU current limiting is inside the electrical model.** The supply's CV/CC mode is an
   active-set variable of the solution, selected by the complementarity conditions
   `I <= I_limit` and `V <= V_setpoint`. Nothing in the test or application code clamps a
   result. `tests/solver.test.ts` asserts the same solution is reached from either starting
   mode, and `tests/reference-cases.test.ts` asserts the crossover load (50 Ohm for
   5 V / 100 mA) is resolved correctly from both sides.
3. **The LED uses a real device equation**, not a constant forward-voltage rule — see below.
4. **Two independent solvers agree** to 1e-12 relative once their physical constants and
   convergence settings are aligned.

## Device models and provenance

| Model | Equation | Parameter provenance |
|-------|----------|----------------------|
| Resistor | `I = (Va - Vb) / R` | exact |
| Ideal voltage source | `V(+) - V(-) = E` | exact |
| Ideal current source | delivers `I` out of `+` | exact |
| Lab PSU | CV: `V(+) - V(-) = Vset`; CC: `j = Ilimit`; mode by complementarity | ideal CV/CC bench supply |
| LED / diode | `I = Is * (exp(Vj / (N*Vt)) - 1) + gmin*Vj`, `Vt = kT/q` | see below |

### LED parameter identification — documented approximation

The Vishay **TLHR5400** datasheet (document 83012, rev. 2.7, 25-Jan-2024) publishes one
typical forward operating point: **V_F = 2 V at I_F = 20 mA, T_amb = 25 degC**. One anchor
cannot identify both `Is` and `N`, so:

- `N = 1.9` is **assumed** (mid-range for recombination-dominated GaAsP visible LEDs,
  commonly reported as 1.8 - 2.5),
- `Is` is **fitted** so the model reproduces the datasheet anchor exactly,
- `Rs` is **not modelled**, because it is not identifiable from the available data.

`tests/led-model-sensitivity.test.ts` quantifies the cost of that assumption rather than
hiding it: across `N = 1.8 ... 2.5` the predicted 5 V / 220 Ohm operating point spans
**13.7157 mA to 13.7458 mA — a 0.22 % spread**. The model is documented as valid for roughly
**1 mA - 20 mA**; it under-predicts V_F well above that range.

**This is a parameter-identification limitation, not a solver limitation.** Gate A's
numerical claim is about solver agreement on an identical model card. Fidelity to a physical
part needs either a vendor SPICE model or bench measurement — tracked in the sprint backlog.

## Tolerances

Every tolerance is asserted in code. Kind and unit are stated explicitly.

| Where | Tolerance | Kind | Against |
|-------|-----------|------|---------|
| Linear reference cases (1, 2, 3) | 1e-9 | relative, dimensionless | closed-form analytic |
| Open circuit (4) | 1e-12 A | absolute | exactly zero |
| PSU CC cases (5, 6) | 1e-9 | relative | analytic; plus the mode itself is asserted |
| LED (7) | 1e-9 | relative | independent bisection solution of the same equation |
| KCL residual, all cases | 1e-12 A | absolute | exact non-linearised device equations |
| Branch residual, all cases | 1e-12 V / 1e-12 A | absolute | branch equations |
| ngspice, linear cases | 1e-12 | relative | ngspice 45.2 |
| ngspice, LED, both at defaults | 1e-6 | relative | ngspice 45.2 |
| ngspice, LED, aligned | 1e-12 | relative | ngspice 45.2, tight RELTOL |
| Browser vs Node | 1e-12 | relative | the Node suite's numbers |

### Why the default-settings ngspice comparison is 1e-6 and not tighter

The ~3.3e-7 difference was traced to two identified causes, both asserted in the test:

- **3.34e-7 — physical constants.** ngspice 45.2 evaluates `kT/q` with **CODATA 2014**
  values; we use the **exact 2019 SI** definitions. Confirmed by solving for the thermal
  voltage implied by ngspice's operating point: it matches CODATA 2014 to 1 part in 1e9.
- **1.18e-8 — ngspice's default `RELTOL = 1e-3`**, which stops Newton well short of machine
  precision.

Remove both and the two solvers agree to **~1e-16 relative**. Neither effect is a
disagreement about the physics.

## Results

| Case | Expected | Result |
|------|----------|--------|
| 1. 5 V + 1 kOhm | 5 mA | 5 mA |
| 2. 12 V, 10 k / 10 k | 6 V | 6 V |
| 3. 9 V, 1 k + 2 k | 3 mA | 3 mA |
| 4. Open circuit | 0 A | 0 A (exactly) |
| 5. PSU 5 V / 100 mA into 10 Ohm | CC, ~100 mA, ~1 V | **CC**, 100 mA, 1 V |
| 6. Short circuit, current-limited PSU | CC at limit | **CC**, 100 mA, 100 uV across 1 mOhm |
| 7. LED + 220 Ohm from 5 V | documented model | 13.7200 mA at 1.9816 V |

Browser (Chromium 153, Web Worker): all seven cases reproduce the Node numbers, and the LED
case is **bit-identical**. 3000 nonlinear solves took 275 ms (**0.092 ms/solve**) while the
main thread continued to service its timer loop — 83 ticks during the computation.

## Candidate API surface

`src/api.ts` demonstrates `getNodeVoltage`, `getBranchCurrent`, `setSupplyVoltage`,
`setCurrentLimit`, `stepSimulation(dt)`. Not final. In a DC-only sprint `stepSimulation`
re-solves the quasi-static operating point; `dt` is recorded but unused, so the later
transient path is not designed out.

## Known limitations

- DC only. No transient, no AC, no reactive components.
- Dense LU: fine for the tens of nodes here, not for thousands.
- The ideal PSU has no output impedance, no loop dynamics, and cannot sink current.
- LED parameters rest on one datasheet anchor (above).
- Only R, V, I, diode/LED and the lab PSU exist. No transistors, no semiconductors beyond
  the diode.

## Running

```
npm test                 # Node suite: reference cases, solver units, sensitivity, ngspice
npm run test:browser     # builds, then runs the Chromium + Web Worker proof
```
