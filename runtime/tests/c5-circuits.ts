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
import { ESP32_DEVKITC_WROOM32 } from '@tbi-lab/domain';
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

/**
 * The circuit for TbiGpioProof run as the pinned R1 REFERENCE image (C5b uploads it and leases it). A reference image carries
 * no input-read analysis, so Runtime v5 fails closed and watches every user pin the board exposes: an input-register read
 * with any of them unwired is refused (runtime/host/session.ts, Sprint 25 review H2). Here every one of them is held by a
 * real 10 kOhm resistor: pull-ups on GPIO0, GPIO5 and GPIO15 (the boot strapping levels of a real ESP32, and GPIO5 is the
 * input the firmware reads), pull-downs elsewhere; GPIO2 is the driven output with its LED load.
 */
export function gpioProofReferenceCircuit(): Circuit {
  const c = gpioProofCircuit();
  for (const gpio of WATCHED_PINS) {
    // GPIO5: already pulled up. GPIO2: already attached to its LED load, and driven by the firmware (one attachment per pad).
    if ((GPIO_PROOF_INPUTS as readonly number[]).includes(gpio) || gpio === 2) continue;
    const r = c.add('component.resistor');
    const rail = PULL_UP.includes(gpio) ? 'PSU1.positive' : 'GND1.ref';
    c.ohms(r, 10_000).wire(`${r}.a`, rail).pad(gpio, `${r}.b`);
  }
  return c;
}
const PULL_UP: readonly number[] = [0, 5, 15];
/** Every pin the host watches for an image without input-read analysis (the board's simulated GPIOs). */
export const WATCHED_PINS: readonly number[] = ESP32_DEVKITC_WROOM32.pins
  .filter((p) => p.gpio !== null && p.simulatorSupport !== 'none')
  .map((p) => p.gpio!);

/** The id of the LED in either circuit (c5-capacity reports it). */
export const gpioProofLed = (c: Circuit): string =>
  c.doc.components.find((x) => x.type === 'component.led')!.id;
