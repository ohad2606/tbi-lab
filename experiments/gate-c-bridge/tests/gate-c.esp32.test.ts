/**
 * GATE C — MCU <-> electrical bridge, on the real classic-ESP32 runtime.
 *
 * OUTPUT: real firmware -> emulated GPIO -> bridge -> Gate A solver -> network voltage/current
 * INPUT:  network voltage -> documented threshold model -> bridge -> emulated GPIO -> firmware
 *
 * Nothing here is hardcoded for the test circuit: the bridge is driven by solver state and
 * by the pin map alone. Expected values are computed by an INDEPENDENT bisection that shares
 * no code path with the MNA solver.
 *
 * TOLERANCES: relative 1e-6 (dimensionless) between the solver and the independent
 * reference; absolute 1e-12 A on KCL residuals.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Circuit } from '../../gate-a-electrical/src/circuit.js';
import { Diode, LabPsu, Resistor } from '../../gate-a-electrical/src/devices.js';
import { LED_TLHR5400, thermalVoltage } from '../../gate-a-electrical/src/models.js';
import { GpioPin, R_DRIVE_HIGH_OHM, VDD_V, V_IH_V, V_IL_V } from '../src/pinModel.js';
import { McuElectricalBridge, type BridgePin } from '../src/bridge.js';
import {
  BOARD_RESERVED_PINS_MASK,
  Esp32Runtime,
  FLASH_IMAGE,
  QEMU_BINARY,
} from '../src/qemuRuntime.js';

const REL_TOL = 1e-6;
const OUTPUT_GPIO = 2;
const INPUT_GPIO = 5;
let SERIES_R = 220;

let esp: Esp32Runtime;
let circuit: Circuit;
let bridge: McuElectricalBridge;
let io2: GpioPin;
let io5: GpioPin;
let seriesResistor: Resistor;
let external: LabPsu;
const timings: string[] = [];

/**
 * Independent reference: solve  Vdrive = I*Rdrive + I*Rseries + Vj(I)  for the LED branch
 * by bisection on the junction voltage. No matrices, no Newton, no device stamps.
 */
function expectedLedCurrent(driveV: number, driveR: number, seriesR: number): number {
  const nVt = LED_TLHR5400.emissionCoefficient * thermalVoltage(LED_TLHR5400.temperatureK);
  const diode = (vj: number): number => LED_TLHR5400.saturationCurrentA * (Math.exp(vj / nVt) - 1);
  const f = (vj: number): number => driveV - vj - (driveR + seriesR) * diode(vj);
  let lo = 0;
  let hi = driveV;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return diode(0.5 * (lo + hi));
}

function buildCircuit(): void {
  circuit = new Circuit();
  io2 = circuit.add(new GpioPin('IO2', 'io2', 'input'));
  seriesResistor = circuit.add(new Resistor('R1', 'io2', 'led_a', SERIES_R));
  circuit.add(new Diode('D1', 'led_a', '0', LED_TLHR5400));

  io5 = circuit.add(new GpioPin('IO5', 'io5', 'input'));
  external = circuit.add(new LabPsu('VEXT', 'ext', '0', 0, 0.1));
  circuit.add(new Resistor('R2', 'ext', 'io5', 1000));

  const pins: BridgePin[] = [
    { gpio: OUTPUT_GPIO, device: io2, node: 'io2', direction: 'output' },
    { gpio: INPUT_GPIO, device: io5, node: 'io5', direction: 'input' },
  ];
  bridge = new McuElectricalBridge(circuit, pins, esp.link);
}

/**
 * Wait until the bridge has solved in response to a firmware output transition.
 *
 * Returns the measured transport latency (firmware register write -> host event), which is
 * the number that actually characterises the bridge. The extra settle delay afterwards is a
 * harness convenience and is deliberately NOT included in the reported figure.
 */
async function awaitBridgeSolve(pin: number, level: 0 | 1): Promise<number> {
  const started = Date.now();
  await esp.link.waitForOutput(pin, level, 20_000);
  const transportMs = Date.now() - started;
  await new Promise((r) => setTimeout(r, 150));
  return transportMs;
}

beforeAll(async () => {
  esp = await Esp32Runtime.start({
    qemuBinary: QEMU_BINARY,
    flashImage: FLASH_IMAGE,
    ignoreMask: BOARD_RESERVED_PINS_MASK,
  });
  await esp.repl('import machine');
  buildCircuit();
  bridge.solveAndPropagate();
  bridge.pushAllInputs();
  await esp.repl(`pout = machine.Pin(${OUTPUT_GPIO}, machine.Pin.OUT)`);
  await esp.repl(`pin5 = machine.Pin(${INPUT_GPIO}, machine.Pin.IN)`);
}, 300_000);

afterAll(async () => {
  await esp?.stop();
  if (timings.length) console.log('Gate C timings:\n  ' + timings.join('\n  '));
});

describe('Gate C output direction: firmware -> GPIO -> bridge -> solver', () => {
  it('case 1: firmware drives GPIO HIGH and the solver sees the resulting current', async () => {
    await esp.repl('pout.value(1)');
    const latency = await awaitBridgeSolve(OUTPUT_GPIO, 1);
    timings.push(`firmware drives HIGH -> host observes: ${latency} ms (transport only)`);

    expect(io2.getMode(), 'pin model switched to driven-high').toBe('output-high');
    const result = bridge.getResult();
    const current = result.deviceCurrents.get('R1')!;
    const expected = expectedLedCurrent(VDD_V, R_DRIVE_HIGH_OHM, SERIES_R);

    expect(Math.abs(current - expected) / expected).toBeLessThanOrEqual(REL_TOL);
    expect(current, 'LED is conducting').toBeGreaterThan(1e-3);
    expect(result.maxKclResidualA).toBeLessThanOrEqual(1e-12);

    // The pin sags below the rail exactly as its driver resistance dictates.
    const pinV = result.nodeVoltages.get('io2')!;
    expect(pinV).toBeLessThan(VDD_V);
    expect(Math.abs(pinV - (VDD_V - current * R_DRIVE_HIGH_OHM)) / pinV).toBeLessThanOrEqual(REL_TOL);
    console.log(
      `case 1: V(io2)=${pinV.toFixed(6)} V, I(LED)=${(current * 1000).toFixed(6)} mA, ` +
        `V(LED)=${result.nodeVoltages.get('led_a')!.toFixed(6)} V`,
    );
  });

  it('case 2: firmware drives GPIO LOW and the electrical state changes accordingly', async () => {
    const before = bridge.getResult().deviceCurrents.get('R1')!;
    await esp.repl('pout.value(0)');
    const latency = await awaitBridgeSolve(OUTPUT_GPIO, 0);
    timings.push(`firmware drives LOW -> host observes: ${latency} ms (transport only)`);

    expect(io2.getMode()).toBe('output-low');
    const result = bridge.getResult();
    const current = result.deviceCurrents.get('R1')!;

    expect(Math.abs(current), 'LED current collapses when the pin is pulled low').toBeLessThan(1e-9);
    expect(Math.abs(current)).toBeLessThan(Math.abs(before));
    expect(result.nodeVoltages.get('io2')!).toBeLessThan(V_IL_V);
    console.log(`case 2: V(io2)=${result.nodeVoltages.get('io2')!.toExponential(3)} V, ` +
      `I(LED)=${current.toExponential(3)} A`);
  });

  it('case 6: the network genuinely recomputes rather than replaying a stored result', async () => {
    // Same firmware action, different circuit: if the answer were precomputed or hardcoded
    // it could not track a component value the firmware knows nothing about.
    await esp.repl('pout.value(1)');
    await awaitBridgeSolve(OUTPUT_GPIO, 1);
    const with220 = bridge.getResult().deviceCurrents.get('R1')!;

    SERIES_R = 1000;
    seriesResistor.resistanceOhm = SERIES_R;
    bridge.solveAndPropagate();
    const with1k = bridge.getResult().deviceCurrents.get('R1')!;

    expect(with1k).toBeLessThan(with220);
    const expected1k = expectedLedCurrent(VDD_V, R_DRIVE_HIGH_OHM, 1000);
    expect(Math.abs(with1k - expected1k) / expected1k).toBeLessThanOrEqual(REL_TOL);

    // And back again.
    SERIES_R = 220;
    seriesResistor.resistanceOhm = SERIES_R;
    bridge.solveAndPropagate();
    const back = bridge.getResult().deviceCurrents.get('R1')!;
    expect(Math.abs(back - with220) / with220).toBeLessThanOrEqual(1e-12);
    console.log(
      `case 6: 220 ohm -> ${(with220 * 1000).toFixed(4)} mA, ` +
        `1 kohm -> ${(with1k * 1000).toFixed(4)} mA (recomputed, not replayed)`,
    );
  });
});

describe('Gate C input direction: solver -> threshold model -> GPIO -> firmware', () => {
  it('case 3: a simulated circuit below V_IL makes firmware read LOW', async () => {
    external.setpointV = 0.3; // well below V_IL = 0.825 V
    bridge.solveAndPropagate();
    const v = bridge.getResult().nodeVoltages.get('io5')!;
    expect(v).toBeLessThan(V_IL_V);

    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('pin5.value()'), 'firmware reads LOW').toBe(0);
    console.log(`case 3: V(io5)=${v.toFixed(6)} V (< V_IL ${V_IL_V} V) -> firmware LOW`);
  });

  it('case 4: a simulated circuit above V_IH makes firmware read HIGH', async () => {
    const solveStart = Date.now();
    external.setpointV = 3.3; // above V_IH = 2.475 V
    bridge.solveAndPropagate();
    const solveMs = Date.now() - solveStart;
    const v = bridge.getResult().nodeVoltages.get('io5')!;
    expect(v).toBeGreaterThan(V_IH_V);

    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('pin5.value()'), 'firmware reads HIGH').toBe(1);
    timings.push(
      `electrical change -> solve + push to MCU: ${solveMs} ms ` +
        `(the 300 ms before reading back is a harness settle, not bridge latency)`,
    );
    console.log(`case 4: V(io5)=${v.toFixed(6)} V (> V_IH ${V_IH_V} V) -> firmware HIGH`);
  });

  it('case 5: firmware observes a transition made while it is running', async () => {
    // Start HIGH (from case 4), then move the external circuit low mid-run.
    expect(await esp.evalNumber('pin5.value()')).toBe(1);

    external.setpointV = 0.1;
    bridge.solveAndPropagate();
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('pin5.value()'), 'firmware saw HIGH -> LOW').toBe(0);

    external.setpointV = 3.3;
    bridge.solveAndPropagate();
    await new Promise((r) => setTimeout(r, 300));
    expect(await esp.evalNumber('pin5.value()'), 'firmware saw LOW -> HIGH').toBe(1);

    // The bridge pushed exactly the transitions the solver produced, in order.
    const pushes = bridge.pushedInputs.filter((p) => p.pin === INPUT_GPIO).map((p) => p.level);
    expect(pushes.slice(-3)).toEqual([1, 0, 1]);
  });

  it('holds its level inside the datasheet undefined band rather than inventing one', async () => {
    const midband = (V_IH_V + V_IL_V) / 2;
    external.setpointV = midband;
    bridge.solveAndPropagate();
    const v = bridge.getResult().nodeVoltages.get('io5')!;
    expect(v).toBeGreaterThan(V_IL_V);
    expect(v).toBeLessThan(V_IH_V);

    await new Promise((r) => setTimeout(r, 300));
    // It was HIGH going in; the undefined band must not silently flip it.
    expect(await esp.evalNumber('pin5.value()')).toBe(1);
    console.log(`undefined band: V(io5)=${v.toFixed(6)} V -> level held at 1`);
  });
});
