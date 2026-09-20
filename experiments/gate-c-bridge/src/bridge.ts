/**
 * MCU <-> electrical bridge (Gate C).
 *
 * Output direction: firmware drives a GPIO -> the pin's electrical model changes ->
 *                   the Gate A solver recomputes the network.
 * Input direction:  the solved node voltage at an input pin is interpreted through the
 *                   datasheet threshold model -> the resulting digital level is pushed
 *                   into the emulated GPIO controller.
 *
 * The bridge holds NO knowledge of any particular circuit. It is driven entirely by the
 * pin map it is given and by solver state; there are no hardcoded outcomes.
 */

import { Circuit } from '../../gate-a-electrical/src/circuit.js';
import type { SolveResult } from '../../gate-a-electrical/src/circuit.js';
import { GpioPin, interpretDigitalInput, type DigitalLevel } from './pinModel.js';
import type { GpioLink, PinEvent } from './qemuLink.js';

export interface BridgePin {
  /** GPIO number on the classic ESP32. */
  gpio: number;
  /** The pin device in the circuit. */
  device: GpioPin;
  /** Electrical node the pin is attached to. */
  node: string;
  /** Output pins are driven by firmware; input pins are read by firmware. */
  direction: 'output' | 'input';
}

export interface BridgeOptions {
  /** Called after each solve, for logging/evidence. */
  onSolve?: (result: SolveResult) => void;
}

export class McuElectricalBridge {
  private readonly inputLevels = new Map<number, DigitalLevel>();
  private lastResult: SolveResult | null = null;
  /** Every level pushed into the MCU, in order. Evidence for tests. */
  readonly pushedInputs: PinEvent[] = [];

  constructor(
    private readonly circuit: Circuit,
    private readonly pins: BridgePin[],
    private readonly link: GpioLink,
    private readonly options: BridgeOptions = {},
  ) {
    for (const pin of this.pins) {
      if (pin.direction === 'input') this.inputLevels.set(pin.gpio, 0);
    }
    this.link.onOutputChange((event) => this.handleFirmwareOutput(event));
  }

  /** Firmware changed an output pin: update its electrical model and re-solve. */
  private handleFirmwareOutput(event: PinEvent): void {
    const pin = this.pins.find((p) => p.gpio === event.pin && p.direction === 'output');
    if (!pin) return;
    pin.device.setMode(event.level === 1 ? 'output-high' : 'output-low');
    this.solveAndPropagate();
  }

  /**
   * Re-solve the network and push any changed digital input levels to the MCU.
   * Called whenever either side changes: firmware output, or an external circuit change.
   */
  solveAndPropagate(): SolveResult {
    const result = this.circuit.solve();
    this.lastResult = result;
    this.options.onSolve?.(result);

    for (const pin of this.pins) {
      if (pin.direction !== 'input') continue;
      const voltage = result.nodeVoltages.get(pin.node);
      if (voltage === undefined) continue;
      const previous = this.inputLevels.get(pin.gpio) ?? 0;
      const level = interpretDigitalInput(voltage, previous);
      if (level !== previous) {
        this.inputLevels.set(pin.gpio, level);
        this.link.setInput(pin.gpio, level);
        this.pushedInputs.push({ pin: pin.gpio, level });
      }
    }
    return result;
  }

  /** Force the current input levels to be (re)sent, e.g. to establish an initial state. */
  pushAllInputs(): void {
    for (const pin of this.pins) {
      if (pin.direction !== 'input') continue;
      const level = this.inputLevels.get(pin.gpio) ?? 0;
      this.link.setInput(pin.gpio, level);
      this.pushedInputs.push({ pin: pin.gpio, level });
    }
  }

  getResult(): SolveResult {
    if (!this.lastResult) throw new Error('bridge has not solved yet');
    return this.lastResult;
  }

  getInputLevel(gpio: number): DigitalLevel {
    const level = this.inputLevels.get(gpio);
    if (level === undefined) throw new Error(`GPIO ${gpio} is not a bridged input`);
    return level;
  }
}
