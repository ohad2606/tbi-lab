/** Shared imports for the Sprint 10 part tests. */
import { thermalVoltage } from '../src/models.js';
export {
  EngineSession,
  RGB_WP154A4SUREQBFZGC,
  ratingWarnings,
  type SolveOutcome,
  type SolveSuccess,
} from '../src/index.js';
export const thermalVoltageForTests = () => thermalVoltage();
