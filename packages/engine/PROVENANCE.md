# Electrical engine — provenance

`packages/engine` is the one production electrical engine (ADR-008). Its numerical core was
**promoted** in Sprint 3 from the Gate A feasibility implementation at tag `sprint-1-complete`.
The originals under `experiments/gate-a-electrical/` remain unchanged as frozen evidence. They
are not maintained and never imported by production code.

| Production file   | Source                                                                               | Changes                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/linalg.ts`   | `experiments/gate-a-electrical/src/linalg.ts`                                        | Provenance header only                                                                                                                      |
| `src/circuit.ts`  | `experiments/gate-a-electrical/src/circuit.ts`                                       | Provenance header only                                                                                                                      |
| `src/devices.ts`  | `experiments/gate-a-electrical/src/devices.ts`                                       | Provenance header; `CurrentSource` removed (not used by any product component)                                                              |
| `src/models.ts`   | `experiments/gate-a-electrical/src/models.ts`                                        | Provenance header; the ngspice-only `CODATA_2014` constants and deprecated aliases removed (the oracle cross-check stays in `experiments/`) |
| `src/registry.ts` | new                                                                                  | Model-card ids -> cards; documented validity range per card                                                                                 |
| `src/session.ts`  | new (informed by `experiments/gate-a-electrical/src/api.ts`, which was not promoted) | Compile from snapshot, disabled-output model, reference analysis, structured errors, live PSU controls                                      |

**Evidence that promotion changed no number:** `tests/gate-a-golden.json` holds the Gate A
engine's outputs as IEEE-754 bit patterns, captured by running the frozen feasibility engine.
`tests/reference.test.ts` re-runs the seven reference cases at the original tolerances and
requires every value to be bit-identical. The LED circuit built through the product path
(project document -> snapshot -> session) is bit-identical as well.

## Modelling decisions added in Sprint 3

| Decision                          | Model                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PSU output off**                | The supply contributes **no element** to the solved topology: an open circuit (infinite impedance) between its terminals. It carries exactly zero current, and its terminal voltage is whatever the rest of the circuit imposes (undefined if nothing does). It is not a 0 V source, and no leakage is added. An island that is referenced only through an off supply is reported as floating, with the supply named |
| **GND**                           | Every `component.ground` terminal is the single reference node. Nets with `role: "ground"` are that node                                                                                                                                                                                                                                                                                                             |
| **Unwired terminal**              | Its own node, reached only through its component. A resistor with one end open carries zero current and its open end sits at the other end's potential (Gate A case 4)                                                                                                                                                                                                                                               |
| **Unwired component**             | A component with no wired terminal is not part of the circuit. It is reported as not connected and not simulated. No values are invented for it                                                                                                                                                                                                                                                                      |
| **Floating island**               | A group of elements with no path to GND in the solved topology is refused as `floating_circuit`, naming its components and nets. No ground is inserted and no leakage is added                                                                                                                                                                                                                                       |
| **Enabled PSU shorted by a wire** | Refused as `psu_shorted`: an ideal wire across an ideal source has no meaningful operating point                                                                                                                                                                                                                                                                                                                     |
| **Circuit entirely on GND**       | Zero unknowns: every potential and every current is exactly 0                                                                                                                                                                                                                                                                                                                                                        |
| **LED model range**               | `outsideModelRange` flags conduction outside the card's documented 1-20 mA range. The numbers remain the exact solution of the documented model                                                                                                                                                                                                                                                                      |

## Tested resistance range

**1 mΩ .. 1 GΩ, the full catalog input range, is supported** (`tests/range.test.ts`):

- every decade as a single load, in CV and CC at extreme setpoints and limits;
- all 169 decade pairs as a divider (ratios up to 1e12);
- LED + series resistor at every decade against an independent bisection;
- 200 seeded random ladders.

All cases pass the solver's own exact-equation verification and agree with the analytic answer to
1e-9 relative, the Gate A tolerance.
