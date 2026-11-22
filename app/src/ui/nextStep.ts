/**
 * TBI-014 slice 2: the next-step card shown in the editor after the first successful Run of the
 * first-run example. Pure decision logic; the card is NextStepCard.tsx. The "seen" flag is a
 * per-device localStorage preference (no server, no tracking).
 */
import { FIRST_RUN_EXAMPLE } from './firstRun.js';

export interface NextStepInput {
  screen: string;
  /** The example the open project was created from (null for any other project). */
  exampleId: string | null;
  /** The open project is the one that example created (not a later project). */
  sameProject: boolean;
  simStatus: string;
  /** The solver returned live values (not an engine refusal). */
  solved: boolean;
  /** Part of an ESP32 session (runtime view) or the project has an MCU program: build flow. */
  mcu: boolean;
  /** Dismissed before on this device. */
  seen: boolean;
}

/** Only after a successful local run of the no-build first-run example, once per device. */
export function shouldShowNextStep(i: NextStepInput): boolean {
  return (
    i.screen === 'editor' &&
    i.exampleId === FIRST_RUN_EXAMPLE &&
    i.sameProject &&
    i.simStatus === 'running' &&
    i.solved &&
    !i.mcu &&
    !i.seen
  );
}
