# Electrical engine — provenance

`packages/engine` is the one production electrical engine (ADR-008). Its numerical core was
**promoted** in Sprint 3 from the Gate A feasibility implementation at tag `sprint-1-complete`.
The originals under `experiments/gate-a-electrical/` remain unchanged as frozen evidence. They
are not maintained and never imported by production code.

| Production file           | Source                                                                               | Changes                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/linalg.ts`           | `experiments/gate-a-electrical/src/linalg.ts`                                        | Provenance header only                                                                                                                                                         |
| `src/circuit.ts`          | `experiments/gate-a-electrical/src/circuit.ts`                                       | Provenance header only                                                                                                                                                         |
| `src/devices.ts`          | `experiments/gate-a-electrical/src/devices.ts`                                       | Provenance header; `CurrentSource` removed (not used by any product component)                                                                                                 |
| `src/models.ts`           | `experiments/gate-a-electrical/src/models.ts`                                        | Provenance header; the ngspice-only `CODATA_2014` constants and deprecated aliases removed (the oracle cross-check stays in `experiments/`)                                    |
| `src/registry.ts`         | new                                                                                  | Model-card ids -> cards; documented validity range per card                                                                                                                    |
| `src/session.ts`          | new (informed by `experiments/gate-a-electrical/src/api.ts`, which was not promoted) | Compile from snapshot, disabled-output model, reference analysis, structured errors, live PSU controls. Sprint 4: diode, switches, live toggle control, transient button input |
| `tools/extract_1n4148.py` | new (Sprint 4)                                                                       | Reproduces the 1N4148 anchors and fit from the manufacturer PDF (standard library only; not a runtime or CI dependency)                                                        |

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

## Added in Sprint 4

`devices.ts`, `circuit.ts` and `linalg.ts` are unchanged: the diode reuses the Gate A `Diode`
device (Shockley + series resistance, the same Newton infrastructure as the LED) and the switch
reuses the Gate A ideal `VoltageSource` element.

### 1N4148 diode card (`model.diode.vishay_1n4148`)

| Item              | Value                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source            | Vishay Semiconductors, _1N4148 Small Signal Fast Switching Diodes_, Document 81857, Rev. 1.6, 07-Nov-2024, https://www.vishay.com/docs/81857/1n4148.pdf (SHA-256 `aefe85400a427ed886a4e1c88205ceabb9f9b38044b29c6acee4bb00146a44b7`; the PDF is not committed) |
| Anchors           | Fig. 1 _Typical Forward Voltage vs. Junction Temperature_, read at T_j = 25 °C from the PDF's **vector** path data, calibrated against the figure's own gridlines: V_F = 0.4990 V @ 0.1 mA, 0.6105 V @ 1 mA, 0.7306 V @ 10 mA, 0.8775 V @ 100 mA               |
| Fit               | Least squares of V_F = N·Vt·ln(I/I_S + 1) + I·R_S, Vt from CODATA 2019 at 298.15 K: **N = 1.924182, I_S = 4.210299 nA, R_S = 0.379873 Ω**                                                                                                                      |
| Residuals         | −0.86 / +1.81 / −1.04 / +0.09 mV at the four anchors                                                                                                                                                                                                           |
| Independent check | Three Fig. 2 points of the 25 °C curve at 6–22 µA (not used in the fit) agree within 5.2 mV                                                                                                                                                                    |
| Table limits      | Model V_F(10 mA) = 0.730 V ≤ 1 V max; model \|I_R(20 V)\| ≈ 4.2 nA ≤ 25 nA max                                                                                                                                                                                 |
| Validity          | Forward 0.1–100 mA at 25 °C (flagged `outsideModelRange` outside it, numbers unchanged). Reverse bias: Shockley saturation current + gmin only. **Breakdown (V_BR ≥ 100 V) is not modelled**, and 100 V exceeds every V1 PSU setpoint (≤ 30 V)                 |
| Assumptions       | The datasheet does not uniquely define I_S, N and R_S: they are the three-parameter fit above. Temperature fixed at 25 °C. No capacitance or recovery (DC only)                                                                                                |

`tools/extract_1n4148.py` reproduces every number above from the PDF, and
`tests/diode.test.ts` refits the anchors independently and compares circuits against a bisection
solution of the same equation, sharing no code with the MNA solver.

### Switch model (push button and toggle switch)

No `R_on`/`R_off` constants and no leakage:

- **Open** (toggle `closed: false`, or a button not pressed): the switch contributes **no
  element**, like a PSU with its output off.
- **Closed**: an ideal 0 V `VoltageSource` branch between `a` and `b`. Its branch current is the
  switch current. When closed switches form a loop (switches in parallel), only a spanning forest
  gets a branch; the redundant switches report current `null` ("not defined") because an ideal
  loop does not define how current divides.
- A closed-switch path across an enabled PSU is refused as `psu_shorted`, naming the switches.
- An open switch that isolates part of the circuit from GND gives the normal floating diagnostic.

Tested (`tests/switch.test.ts`): exact open/closed results for every resistor decade 1 mΩ–1 GΩ,
CC through a closed switch, a switch in series with an LED, series and parallel switches, and
1,000 live toggle transitions and 1,000 button cycles, each bit-identical to a fresh solve. The
solver tolerances are unchanged.

### Ground

Every `component.ground` terminal is the one reference node, even when two GND symbols are not
wired to each other (`tests/session.test.ts`, "A14").
