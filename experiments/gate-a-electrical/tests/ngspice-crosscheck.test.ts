/**
 * Gate A track A2: independent cross-validation against ngspice.
 *
 * ngspice (45.2, KLU build, shipped as WebAssembly by the MIT-licensed `eecircuit-engine`
 * wrapper) is used here as an ORACLE ONLY. It is a development/test dependency and is not
 * a production dependency of TBI Lab. Two independently written solvers agreeing on the
 * same circuits is the strongest evidence available that the numbers are physics and not
 * an artefact of one implementation.
 *
 * TOLERANCES (all relative, dimensionless, unless stated):
 *   REL_TOL_LINEAR          1e-12  linear networks: pure linear algebra on both sides.
 *   REL_TOL_NONLINEAR_RAW   1e-6   LED case, our default model vs ngspice at ITS defaults.
 *                                  The observed ~3e-7 is not solver disagreement. It has
 *                                  two identified causes:
 *                                    (a) ngspice 45.2 evaluates kT/q with CODATA 2014
 *                                        constants; we use the exact 2019 SI values.
 *                                        3.4e-7 relative in thermal voltage.
 *                                    (b) ngspice's default RELTOL is 1e-3, so it stops
 *                                        Newton well short of machine precision. ~1.2e-8.
 *   REL_TOL_NONLINEAR_MATCHED 1e-12 LED case with both causes removed: our model evaluated
 *                                  with ngspice's constants, and ngspice asked to converge
 *                                  tightly. This is the real cross-validation claim, and it
 *                                  is met at the 1e-16 level in practice.
 *   ABS_TOL_ZERO_CURRENT_A  1e-12  amperes, open-circuit case.
 *
 * ngspice sign convention: i(v1) is current INTO the source's + terminal, so the current
 * delivered to the circuit is -i(v1). Our solver reports delivered current directly.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from 'eecircuit-engine';
import { Circuit } from '../src/circuit.js';
import { Diode, LabPsu, Resistor, VoltageSource } from '../src/devices.js';
import { CODATA_2014, LED_TLHR5400, type DiodeModel } from '../src/models.js';

const REL_TOL_LINEAR = 1e-12;
const REL_TOL_NONLINEAR_RAW = 1e-6;
const REL_TOL_NONLINEAR_MATCHED = 1e-12;
const ABS_TOL_ZERO_CURRENT_A = 1e-12;

/** Pin ngspice to 25 degC so it matches the temperature our model cards are specified at. */
const NGSPICE_OPTIONS = '.options temp=25 tnom=25';
/**
 * As above, but also asking ngspice to iterate to near machine precision instead of its
 * default RELTOL=1e-3. Used only where we are comparing SOLVER behaviour and therefore must
 * not be measuring ngspice's stopping criterion.
 */
const NGSPICE_TIGHT_OPTIONS = '.options temp=25 tnom=25 reltol=1e-9 abstol=1e-15 vntol=1e-12';

let sim: Simulation;
let ngspiceBanner = '';

async function ngspice(netlist: string): Promise<Record<string, number>> {
  sim.setNetList(netlist);
  const res = await sim.runSim();
  const errors = sim.getError();
  if (errors.length) throw new Error(`ngspice reported errors: ${JSON.stringify(errors)}`);
  const out: Record<string, number> = {};
  for (const d of res.data ?? []) out[d.name.toLowerCase()] = Number(d.values[0]);
  return out;
}

function expectRelative(actual: number, expected: number, relTol: number, label: string): void {
  const err = Math.abs(actual - expected) / Math.abs(expected);
  expect(err, `${label}: ours ${actual}, ngspice ${expected}, relative error ${err.toExponential(3)}`)
    .toBeLessThanOrEqual(relTol);
}

beforeAll(async () => {
  sim = new Simulation();
  await sim.start();
  ngspiceBanner = sim.getInitInfo();
  // Fail loudly if the oracle is not the engine we audited.
  expect(ngspiceBanner, 'ngspice banner').toContain('ngspice-45.2');
}, 180_000);

describe('ngspice cross-check: linear reference cases', () => {
  it('case 1: 5 V + 1 kOhm', async () => {
    const ng = await ngspice(`case1\nV1 1 0 5\nR1 1 0 1k\n${NGSPICE_OPTIONS}\n.op\n.end`);
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'n1', '0', 5));
    c.add(new Resistor('R1', 'n1', '0', 1000));
    const r = c.solve();
    expectRelative(r.deviceCurrents.get('V1')!, -ng['i(v1)']!, REL_TOL_LINEAR, 'I delivered');
    expectRelative(r.nodeVoltages.get('n1')!, ng['v(1)']!, REL_TOL_LINEAR, 'V(n1)');
  });

  it('case 2: 12 V, 10 k / 10 k divider', async () => {
    const ng = await ngspice(`case2\nV1 1 0 12\nR1 1 2 10k\nR2 2 0 10k\n${NGSPICE_OPTIONS}\n.op\n.end`);
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'top', '0', 12));
    c.add(new Resistor('R1', 'top', 'mid', 10_000));
    c.add(new Resistor('R2', 'mid', '0', 10_000));
    const r = c.solve();
    expectRelative(r.nodeVoltages.get('mid')!, ng['v(2)']!, REL_TOL_LINEAR, 'V(mid)');
  });

  it('case 3: 9 V, 1 k + 2 k series', async () => {
    const ng = await ngspice(`case3\nV1 1 0 9\nR1 1 2 1k\nR2 2 0 2k\n${NGSPICE_OPTIONS}\n.op\n.end`);
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 9));
    c.add(new Resistor('R1', 'a', 'b', 1000));
    c.add(new Resistor('R2', 'b', '0', 2000));
    const r = c.solve();
    expectRelative(r.deviceCurrents.get('R1')!, -ng['i(v1)']!, REL_TOL_LINEAR, 'I(R1)');
    expectRelative(r.nodeVoltages.get('b')!, ng['v(2)']!, REL_TOL_LINEAR, 'V(b)');
  });

  it('case 4: open circuit', async () => {
    const ng = await ngspice(`case4\nV1 1 0 5\nR1 1 2 1k\n${NGSPICE_OPTIONS}\n.op\n.end`);
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 5));
    c.add(new Resistor('R1', 'a', 'dangling', 1000));
    const r = c.solve();
    expect(Math.abs(-ng['i(v1)']!), 'ngspice current').toBeLessThanOrEqual(ABS_TOL_ZERO_CURRENT_A);
    expect(Math.abs(r.deviceCurrents.get('R1')!), 'our current').toBeLessThanOrEqual(ABS_TOL_ZERO_CURRENT_A);
    expectRelative(r.nodeVoltages.get('dangling')!, ng['v(2)']!, REL_TOL_LINEAR, 'V(open end)');
  });
});

/**
 * ngspice has no ideal CV/CC bench supply primitive, so the PSU cases are cross-checked by
 * their mode-equivalent circuits, which ngspice can express exactly:
 *   CC branch  ->  ideal current source of I_limit
 *   CV branch  ->  ideal voltage source of V_setpoint
 * ngspice validates the electrical solution of each branch; our solver's additional job is
 * to SELECT the branch satisfying both complementarity conditions (I <= I_limit and
 * V <= V_setpoint). The test asserts that selection against ngspice's numbers for both
 * branches, so a wrong mode choice cannot pass.
 */
describe('ngspice cross-check: lab PSU current limiting', () => {
  it('case 5: 5 V / 100 mA into 10 Ohm selects the CC branch', async () => {
    const cc = await ngspice(`case5cc\nI1 0 1 DC 100m\nRL 1 0 10\n${NGSPICE_OPTIONS}\n.op\n.end`);
    const cv = await ngspice(`case5cv\nV1 1 0 5\nRL 1 0 10\n${NGSPICE_OPTIONS}\n.op\n.end`);

    const ccTerminalV = cc['v(1)']!;
    const cvCurrentA = -cv['i(v1)']!;

    // ngspice says: the CV branch would draw 500 mA, which violates the 100 mA limit;
    // the CC branch sits at 1 V, which does not violate the 5 V setpoint. So CC is the
    // only self-consistent branch.
    expect(cvCurrentA, 'CV-branch current per ngspice').toBeGreaterThan(0.1);
    expect(ccTerminalV, 'CC-branch terminal voltage per ngspice').toBeLessThanOrEqual(5);

    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RL', 'out', '0', 10));
    const r = c.solve();

    expect(r.supplyModes.get('PSU1'), 'selected mode').toBe('CC');
    expectRelative(r.nodeVoltages.get('out')!, ccTerminalV, REL_TOL_LINEAR, 'V(out) vs ngspice CC branch');
    expectRelative(r.deviceCurrents.get('PSU1')!, 0.1, REL_TOL_LINEAR, 'I(PSU1)');
  });

  it('case 5b: 5 V / 100 mA into 1 kOhm selects the CV branch', async () => {
    const cv = await ngspice(`case5b\nV1 1 0 5\nRL 1 0 1k\n${NGSPICE_OPTIONS}\n.op\n.end`);
    const cvCurrentA = -cv['i(v1)']!;
    expect(cvCurrentA, 'CV-branch current per ngspice').toBeLessThan(0.1);

    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RL', 'out', '0', 1000));
    const r = c.solve();
    expect(r.supplyModes.get('PSU1'), 'selected mode').toBe('CV');
    expectRelative(r.nodeVoltages.get('out')!, cv['v(1)']!, REL_TOL_LINEAR, 'V(out) vs ngspice CV branch');
    expectRelative(r.deviceCurrents.get('PSU1')!, cvCurrentA, REL_TOL_LINEAR, 'I(PSU1) vs ngspice');
  });

  it('case 6: short circuit selects the CC branch', async () => {
    const cc = await ngspice(`case6cc\nI1 0 1 DC 100m\nRS 1 0 1m\n${NGSPICE_OPTIONS}\n.op\n.end`);
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RSHORT', 'out', '0', 1e-3));
    const r = c.solve();
    expect(r.supplyModes.get('PSU1'), 'selected mode').toBe('CC');
    expectRelative(r.nodeVoltages.get('out')!, cc['v(1)']!, REL_TOL_LINEAR, 'V(out) vs ngspice CC branch');
  });
});

describe('ngspice cross-check: LED (nonlinear)', () => {
  const SUPPLY_V = 5;
  const SERIES_R = 220;

  function ledNetlist(model: DiodeModel, options: string = NGSPICE_OPTIONS): string {
    return [
      'led',
      `V1 1 0 ${SUPPLY_V}`,
      `R1 1 2 ${SERIES_R}`,
      'D1 2 0 LEDMODEL',
      `.model LEDMODEL D(IS=${model.saturationCurrentA.toExponential(17)} ` +
        `N=${model.emissionCoefficient} RS=${model.seriesResistanceOhm})`,
      options,
      '.op',
      '.end',
    ].join('\n');
  }

  function ourOperatingPoint(model: DiodeModel): { voltageV: number; currentA: number } {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'vcc', '0', SUPPLY_V));
    c.add(new Resistor('R1', 'vcc', 'anode', SERIES_R));
    c.add(new Diode('D1', 'anode', '0', model));
    const r = c.solve();
    return { voltageV: r.nodeVoltages.get('anode')!, currentA: r.deviceCurrents.get('D1')! };
  }

  it('agrees with ngspice at both sides\' default settings', async () => {
    const ng = await ngspice(ledNetlist(LED_TLHR5400));
    const ours = ourOperatingPoint(LED_TLHR5400);
    expectRelative(ours.voltageV, ng['v(2)']!, REL_TOL_NONLINEAR_RAW, 'V(LED)');
    expectRelative(ours.currentA, -ng['i(v1)']!, REL_TOL_NONLINEAR_RAW, 'I(LED)');
  });

  it('attributes the default-settings difference to constants and to ngspice RELTOL', async () => {
    const ourDefault = ourOperatingPoint(LED_TLHR5400);
    const ourMatched = ourOperatingPoint({ ...LED_TLHR5400, constants: CODATA_2014 });
    const ngDefault = await ngspice(ledNetlist(LED_TLHR5400));
    const ngTight = await ngspice(ledNetlist(LED_TLHR5400, NGSPICE_TIGHT_OPTIONS));

    const constantsEffect = Math.abs(ourDefault.voltageV - ourMatched.voltageV) / ourDefault.voltageV;
    const reltolEffect = Math.abs(ngDefault['v(2)']! - ngTight['v(2)']!) / ngTight['v(2)']!;
    console.log(
      `V(LED) difference budget: constants ${constantsEffect.toExponential(3)}, ` +
        `ngspice RELTOL ${reltolEffect.toExponential(3)}`,
    );
    // The constant choice dominates, and both effects are far below any figure that could
    // matter to a user. Neither indicates a disagreement about the physics.
    expect(constantsEffect).toBeGreaterThan(1e-7);
    expect(constantsEffect).toBeLessThan(1e-6);
    expect(reltolEffect).toBeLessThan(1e-7);
  });

  it('agrees to 1e-12 once constants and convergence settings are aligned', async () => {
    // Same model card, evaluated with the CODATA 2014 constants ngspice itself uses.
    // I_S is a fitted parameter of the card and is NOT refitted here: only kT/q changes.
    const matched: DiodeModel = { ...LED_TLHR5400, constants: CODATA_2014 };
    const ng = await ngspice(ledNetlist(matched, NGSPICE_TIGHT_OPTIONS));
    const ours = ourOperatingPoint(matched);

    expectRelative(ours.voltageV, ng['v(2)']!, REL_TOL_NONLINEAR_MATCHED, 'V(LED), constants matched');
    expectRelative(ours.currentA, -ng['i(v1)']!, REL_TOL_NONLINEAR_MATCHED, 'I(LED), constants matched');

    console.log(
      `LED cross-check: ours V=${ours.voltageV.toFixed(12)} V I=${(ours.currentA * 1000).toFixed(9)} mA | ` +
        `ngspice V=${ng['v(2)']!.toFixed(12)} V I=${(-ng['i(v1)']! * 1000).toFixed(9)} mA`,
    );
  });
});
