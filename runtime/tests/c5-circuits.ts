/**
 * The circuit the capacity and recovery harnesses give TbiGpioProof (runtime/firmware/arduino/TbiGpioProof).
 *
 * The firmware drives GPIO2 and GPIO18 and reads GPIO5 (`pinMode(5, INPUT)`, no internal pull). Since
 * Sprint 25 (Runtime v5, input-read) the simulator refuses a read of a pad with no defensible level
 * (`gpio_input_undefined`): the earlier harness circuits left GPIO5 unconnected, so every gpio session
 * ended `electrical_error` about 1.7 s into simulated time (Alpha W1 retry, 2026-11-11). Here GPIO5 is
 * held HIGH by a 10 kOhm pull-up to the 3.3 V supply, a real and defined level; GPIO2 keeps its load
 * (`legacyGpioProofCircuit` is the earlier circuit, kept only to reproduce that failure).
 */
import { Circuit } from '../host/tests/r1-support.js';

/** The pins TbiGpioProof reads, and the pull-up each one gets. */
export const GPIO_PROOF_INPUTS = [5] as const;

/** GPIO2 -> 220 ohm -> LED -> GND (the visible output); GPIO5 <- 10 k <- 3.3 V (the input, read HIGH). */
export function gpioProofCircuit(): Circuit {
  const c = legacyGpioProofCircuit();
  for (const gpio of GPIO_PROOF_INPUTS) {
    const pu = c.add('component.resistor');
    c.ohms(pu, 10_000).wire(`${pu}.a`, 'PSU1.positive').pad(gpio, `${pu}.b`);
  }
  return c;
}

/** The pre-fix circuit: GPIO5 is not connected to anything (an undefined input). Reproduction only. */
export function legacyGpioProofCircuit(): Circuit {
  const c = new Circuit().psu(3.3);
  const r = c.add('component.resistor');
  const d = c.add('component.led');
  c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
  return c.pad(2, `${r}.a`);
}

/** The id of the LED in either circuit (c5-capacity reports it). */
export const gpioProofLed = (c: Circuit): string =>
  c.doc.components.find((x) => x.type === 'component.led')!.id;
