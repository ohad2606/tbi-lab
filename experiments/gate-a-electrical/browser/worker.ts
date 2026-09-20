/**
 * Gate A browser proof: the DC solver running inside a Web Worker.
 *
 * Node-side test success is not evidence for the browser path, so the same seven reference
 * cases are executed here, off the main thread, in a real browser engine. The worker also
 * exposes a deliberately heavy workload so the harness can show the main thread stays
 * responsive while electrical computation is in progress.
 */

import { Circuit } from '../src/circuit.js';
import { Diode, LabPsu, Resistor, VoltageSource } from '../src/devices.js';
import { LED_TLHR5400 } from '../src/models.js';

interface CaseResult {
  name: string;
  values: Record<string, number>;
  mode?: string;
  maxKclResidualA: number;
}

function ledCircuit(): Circuit {
  const c = new Circuit();
  c.add(new VoltageSource('V1', 'vcc', '0', 5));
  c.add(new Resistor('R1', 'vcc', 'anode', 220));
  c.add(new Diode('D1', 'anode', '0', LED_TLHR5400));
  return c;
}

function runReferenceCases(): CaseResult[] {
  const out: CaseResult[] = [];

  {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'n1', '0', 5));
    c.add(new Resistor('R1', 'n1', '0', 1000));
    const r = c.solve();
    out.push({
      name: 'case1-5V-1k',
      values: { current: r.deviceCurrents.get('R1')! },
      maxKclResidualA: r.maxKclResidualA,
    });
  }
  {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'top', '0', 12));
    c.add(new Resistor('R1', 'top', 'mid', 10_000));
    c.add(new Resistor('R2', 'mid', '0', 10_000));
    const r = c.solve();
    out.push({
      name: 'case2-divider',
      values: { midVoltage: r.nodeVoltages.get('mid')! },
      maxKclResidualA: r.maxKclResidualA,
    });
  }
  {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 9));
    c.add(new Resistor('R1', 'a', 'b', 1000));
    c.add(new Resistor('R2', 'b', '0', 2000));
    const r = c.solve();
    out.push({
      name: 'case3-series',
      values: { current: r.deviceCurrents.get('R1')! },
      maxKclResidualA: r.maxKclResidualA,
    });
  }
  {
    const c = new Circuit();
    c.add(new VoltageSource('V1', 'a', '0', 5));
    c.add(new Resistor('R1', 'a', 'dangling', 1000));
    const r = c.solve();
    out.push({
      name: 'case4-open',
      values: { current: r.deviceCurrents.get('R1')! },
      maxKclResidualA: r.maxKclResidualA,
    });
  }
  {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RL', 'out', '0', 10));
    const r = c.solve();
    out.push({
      name: 'case5-psu-cc',
      values: { current: r.deviceCurrents.get('PSU1')!, loadVoltage: r.nodeVoltages.get('out')! },
      mode: r.supplyModes.get('PSU1'),
      maxKclResidualA: r.maxKclResidualA,
    });
  }
  {
    const c = new Circuit();
    c.add(new LabPsu('PSU1', 'out', '0', 5, 0.1));
    c.add(new Resistor('RSHORT', 'out', '0', 1e-3));
    const r = c.solve();
    out.push({
      name: 'case6-short',
      values: { current: r.deviceCurrents.get('PSU1')!, loadVoltage: r.nodeVoltages.get('out')! },
      mode: r.supplyModes.get('PSU1'),
      maxKclResidualA: r.maxKclResidualA,
    });
  }
  {
    const r = ledCircuit().solve();
    out.push({
      name: 'case7-led',
      values: { current: r.deviceCurrents.get('D1')!, ledVoltage: r.nodeVoltages.get('anode')! },
      maxKclResidualA: r.maxKclResidualA,
    });
  }
  return out;
}

type Request =
  | { type: 'run-reference-cases' }
  | { type: 'stress'; iterations: number };

self.onmessage = (event: MessageEvent<Request>): void => {
  const req = event.data;
  const started = performance.now();
  try {
    if (req.type === 'run-reference-cases') {
      const cases = runReferenceCases();
      self.postMessage({ type: 'reference-results', cases, elapsedMs: performance.now() - started });
      return;
    }
    // Repeatedly solve the nonlinear LED circuit: a deliberately heavy, realistic workload.
    let lastCurrent = 0;
    for (let i = 0; i < req.iterations; i++) {
      lastCurrent = ledCircuit().solve().deviceCurrents.get('D1')!;
    }
    self.postMessage({
      type: 'stress-done',
      iterations: req.iterations,
      lastCurrent,
      elapsedMs: performance.now() - started,
    });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error) });
  }
};
