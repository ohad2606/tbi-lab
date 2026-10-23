/**
 * L2: the logic state of a gate or a packaged device, for inspection (truth table / state view).
 * Only what the solve and the datasheet row decided: each pin's level as the model classified it
 * and the measured pin voltage relative to the part's OWN GND pin (the voltage the thresholds
 * apply to). An input between V_IL and V_IH is `x` (undefined), never a guessed level.
 */
import type { LogicFunction } from '../logic/lvc1g.js';
import type { LogicLevel } from './logicGate.js';

export interface LogicPinState {
  /** Terminal id (language-neutral: `a`, `y`, `a1`, `y2`…). */
  pin: string;
  /** `high` / `low` per the datasheet thresholds; `x` undefined/unknown; `off` unpowered. */
  level: LogicLevel;
  /** Pin voltage relative to the part's GND pin (V), or null where it is unknown. */
  volts: number | null;
}

export interface LogicInspection {
  partNumber: string;
  function: LogicFunction;
  /** The solved supply V_CC − GND (V), or null. */
  supplyV: number | null;
  /** V_IH / V_IL at that supply, from the datasheet row (V); null where no row applies. */
  vih: number | null;
  vil: number | null;
  /** One entry per gate (`unit` '' for a single-gate part, '1'…'4' for a package). */
  gates: { unit: string; inputs: LogicPinState[]; output: LogicPinState }[];
}
