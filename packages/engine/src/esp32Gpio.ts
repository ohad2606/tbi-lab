/**
 * Electrical model of a classic-ESP32 GPIO pin (runtime R1).
 *
 * PROMOTED from experiments/gate-c-bridge/src/pinModel.ts (Sprint 0 Gate C, tag sprint-1-complete)
 * with the logic and every constant unchanged; see PROVENANCE.md. This is the approved V1 GPIO
 * electrical model: output = 3.3 V behind 16.5 ohm (high) / 17.679 ohm (low); input thresholds
 * V_IL = 0.825 V, V_IH = 2.475 V, holding the previous level in between.
 *
 * Every number here is derived from the ESP32 Series Datasheet v5.3, Table 5-3
 * "DC Characteristics (3.3 V, 25 degC)". The derivations are shown so the model can be
 * audited rather than taken on trust. An output pin is NOT modelled as an ideal 3.3 V
 * constant: it is a Thevenin source whose series resistance comes from the datasheet's
 * own drive-current specification.
 *
 * Datasheet values used (VDD = 3.3 V):
 *   V_IH  min 0.75 x VDD                      -> 2.475 V
 *   V_IL  max 0.25 x VDD                      -> 0.825 V
 *   V_OH  min 0.8 x VDD                       -> 2.64 V
 *   V_OL  max 0.1 x VDD                       -> 0.33 V
 *   I_OH  typ 40 mA  at V_OH >= 2.64 V, maximum drive strength (VDD3P3_CPU domain)
 *   I_OL  typ 28 mA  at V_OL  = 0.495 V,      maximum drive strength
 *   I_IH / I_IL      max 50 nA  (input leakage)
 *   R_PU / R_PD  typ 45 kOhm    (internal pull-up / pull-down)
 */

import type { Device, Indexer, StampOptions, StampTarget, TerminalCurrent } from './devices.js';
import { GROUND_NAMES } from './devices.js';

export const VDD_V = 3.3;

/** V_IH = 0.75 x VDD. Above this a digital input reads HIGH. */
export const V_IH_V = 0.75 * VDD_V;
/** V_IL = 0.25 x VDD. Below this a digital input reads LOW. */
export const V_IL_V = 0.25 * VDD_V;

/**
 * The specified pad voltage range (Sprint 11, R1), ESP32 Series Datasheet v5.3, Table 5-3
 * "DC Characteristics (3.3 V, 25 degC)", p. 52: V_IH max = VDD + 0.3 V, V_IL min = -0.3 V (the
 * PDF does not render the minus sign; see docs/sprints/s11-evidence/datasheets/FACTS.md). Table
 * 5-1 (absolute maximum, p. 51) bounds the supply pins to -0.3 ... 3.6 V. A pad outside this range
 * is over-stressed: the pins are not 5 V tolerant. Used for warnings only (ratings.ts), never by
 * the solver.
 */
export const V_PIN_MAX_V = VDD_V + 0.3;
export const V_PIN_MIN_V = -0.3;

/**
 * Output driver on-resistance, derived from the datasheet drive-current points.
 *
 *   High side: the datasheet guarantees V_OH >= 2.64 V while sourcing I_OH = 40 mA.
 *              R = (VDD - V_OH) / I_OH = (3.3 - 2.64) / 0.040 = 16.5 ohm
 *   Low side:  it guarantees V_OL = 0.495 V while sinking I_OL = 28 mA.
 *              R = V_OL / I_OL = 0.495 / 0.028 = 17.679 ohm
 *
 * DOCUMENTED APPROXIMATION: these are the *maximum drive strength* figures, and they are
 * worst-case guarantees rather than typical on-resistances, so the real driver is stronger
 * (lower resistance) than this model. ESP-IDF's default drive strength is one step below
 * maximum, which would give a higher resistance. Drive-strength selection is not modelled;
 * it is recorded in the Sprint 0 backlog. The model is a linear approximation of a MOSFET
 * driver, valid near the operating points above and increasingly optimistic far from them.
 */
export const R_DRIVE_HIGH_OHM = (VDD_V - 2.64) / 0.04;

/**
 * The datasheet drive characteristics (ESP32 Series Datasheet v5.3, Table 5-3 "DC
 * Characteristics", maximum drive strength): TYPICAL values, not maximum ratings. I_OH 40 mA for
 * the VDD3P3_CPU and VDD3P3_RTC power domains and 20 mA for the VDD_SDIO domain (on the DevKitC
 * header: GPIO16 and GPIO17, chip pins 25 and 27); I_OL 28 mA. Table 5-1 publishes no per-pin
 * absolute maximum. Used only by the diagnostics (ratings.ts), never by the electrical model.
 * (Sprint 13 H2 finding, for a PM decision: the pad DRIVER model uses the 40 mA point for every
 * pin, so GPIO16/17 are modelled stronger than their domain's 20 mA characteristic.)
 */
export const I_OH_A = 0.04;
export const I_OH_SDIO_A = 0.02;
export const I_OL_A = 0.028;
/** GPIOs on the header in the VDD_SDIO power domain (datasheet pin layout: pins 25, 27). */
export const SDIO_DOMAIN_GPIOS: ReadonlySet<number> = new Set([16, 17]);
/** Typical source capability of a pad (Table 5-3, by power domain). */
export const typicalSourceA = (gpio: number) =>
  SDIO_DOMAIN_GPIOS.has(gpio) ? I_OH_SDIO_A : I_OH_A;
/** Table 5-1 absolute maximum: cumulative IO output current, 1200 mA. */
export const I_OUTPUT_CUMULATIVE_MAX_A = 1.2;
export const R_DRIVE_LOW_OHM = 0.495 / 0.028;

/**
 * The characterized output points (Table 5-3): HIGH holds V_OH >= 2.64 V while sourcing I_OH;
 * LOW is characterized at V_OL = 0.495 V while sinking I_OL. The linear driver model is a chord
 * from the rail to that point: between the rail and the point it is anchored by the datasheet;
 * beyond it (an overloaded or shorted pad) it is an extrapolation, and the real current is
 * limited by the transistors in a way Espressif does not publish (Table 5-1: no short-circuit
 * current). Sprint 13 P2: such a pad result is reported as outside the model range (unreliable),
 * never as a measured value.
 */
export const V_OH_CHAR_V = 0.8 * VDD_V;
export const V_OL_CHAR_V = 0.495;

/** Whether a driven pad operates beyond its characterized point (P2). Inputs: never. */
export function outsideCharacterizedRegion(mode: PinMode, voltageV: number): boolean {
  if (mode === 'output-high') return voltageV < V_OH_CHAR_V;
  if (mode === 'output-low') return voltageV > V_OL_CHAR_V;
  return false;
}

/** Internal pull-up / pull-down resistance, datasheet typical. */
export const R_PULL_OHM = 45_000;

/**
 * Input leakage conductance. The datasheet bounds input current at 50 nA; modelled as a
 * linear leakage to ground so a floating input node always has a DC path and the nodal
 * matrix stays non-singular. G = 50 nA / 3.3 V = 1.515e-8 S (66 Mohm).
 */
export const G_INPUT_LEAKAGE_S = 50e-9 / VDD_V;

export type PinMode = 'output-high' | 'output-low' | 'input' | 'input-pullup' | 'input-pulldown';

export type DigitalLevel = 0 | 1;

/**
 * Interpret a node voltage as a digital input level.
 *
 * Between V_IL and V_IH the datasheet guarantees nothing. Rather than invent a threshold,
 * the model HOLDS the previous level through that band, which is the conventional way to
 * represent a real Schmitt-trigger-ish input without claiming a specific hysteresis width.
 * The held value is part of the documented semantics, not an accident.
 */
export function interpretDigitalInput(voltageV: number, previous: DigitalLevel): DigitalLevel {
  if (voltageV >= V_IH_V) return 1;
  if (voltageV <= V_IL_V) return 0;
  return previous;
}

/**
 * A GPIO pin as an electrical device.
 *
 * Output modes are a Thevenin source (drive voltage behind the driver resistance), stamped
 * via its Norton equivalent, which is exact for a linear DC solve:
 *   G = 1/R_drive  between the pin node and ground
 *   I = V_drive * G  injected into the pin node
 * Input modes present the datasheet leakage conductance, plus the internal pull resistor
 * when one is enabled.
 */
export class GpioPin implements Device {
  readonly kind = 'esp32-gpio-pin';
  readonly hasBranch = false;
  readonly limitingActive = false;
  private ip = -1;
  private mode: PinMode;

  constructor(
    readonly id: string,
    private readonly node: string,
    mode: PinMode = 'input',
  ) {
    this.mode = mode;
  }

  nodeNames(): string[] {
    return [this.node];
  }
  prepare(idx: Indexer): void {
    this.ip = GROUND_NAMES.has(this.node) ? -1 : idx.node(this.node);
  }
  resetState(): void {}
  branchResidual(): null {
    return null;
  }

  setMode(mode: PinMode): void {
    this.mode = mode;
  }
  getMode(): PinMode {
    return this.mode;
  }

  /** Norton equivalent of the pin: conductance to ground and current injected into the node. */
  private norton(): { conductanceS: number; injectedA: number } {
    switch (this.mode) {
      case 'output-high': {
        const g = 1 / R_DRIVE_HIGH_OHM;
        return { conductanceS: g, injectedA: VDD_V * g };
      }
      case 'output-low': {
        const g = 1 / R_DRIVE_LOW_OHM;
        return { conductanceS: g, injectedA: 0 };
      }
      case 'input-pullup': {
        const g = G_INPUT_LEAKAGE_S + 1 / R_PULL_OHM;
        return { conductanceS: g, injectedA: VDD_V / R_PULL_OHM };
      }
      case 'input-pulldown': {
        const g = G_INPUT_LEAKAGE_S + 1 / R_PULL_OHM;
        return { conductanceS: g, injectedA: 0 };
      }
      case 'input':
      default:
        return { conductanceS: G_INPUT_LEAKAGE_S, injectedA: 0 };
    }
  }

  stamp(t: StampTarget): void {
    if (this.ip < 0) return;
    const { conductanceS, injectedA } = this.norton();
    t.addA(this.ip, this.ip, conductanceS);
    t.addZ(this.ip, injectedA);
  }

  /**
   * Current delivered by the pin into the external circuit, amperes. A pin wired straight to GND
   * has no unknown (its node IS the reference, 0 V) but still a defined model current: the model
   * evaluated at V = 0 (Sprint 13 P3; previously reported as 0 A). Whether that value is inside
   * the characterized region is decided by `outsideCharacterizedRegion`.
   */
  current(x: readonly number[]): number {
    const { conductanceS, injectedA } = this.norton();
    return injectedA - conductanceS * (this.ip < 0 ? 0 : x[this.ip]!);
  }

  exactTerminalCurrents(x: readonly number[]): TerminalCurrent[] {
    return [{ nodeIndex: this.ip, currentLeaving: -this.current(x) }];
  }

  /** Open-circuit (Thevenin) voltage this pin would present with no load. */
  thevenin(): { voltageV: number; resistanceOhm: number } {
    const { conductanceS, injectedA } = this.norton();
    return { voltageV: injectedA / conductanceS, resistanceOhm: 1 / conductanceS };
  }
}

/** Unused import guard: StampOptions is part of the Device contract. */
export type { StampOptions };
