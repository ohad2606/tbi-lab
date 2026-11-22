/**
 * TBI-014: first-run welcome. Pure decision logic; the dialog is FirstRun.tsx. The flag is a
 * per-device localStorage preference (no server, no tracking).
 */
/** The example the welcome opens: an LED, a resistor and the lab supply, with suggested probes. */
export const FIRST_RUN_EXAMPLE = 'led-current';
/** The probe named in step 3 (the example's suggested current probe). */
export const FIRST_RUN_PROBE = 'I(D1)';

export interface FirstRunInput {
  screen: string;
  /** Saved projects on this device: someone who already has work is not a first-time user. */
  projectCount: number;
  /** "Don't show again" or the example was started. */
  seen: boolean;
  /** Skip or Esc: hidden for this page session only. */
  skippedThisSession: boolean;
}

/** The welcome opens by itself only on the Projects screen of a device with no flag and no projects. */
export function shouldAutoShowFirstRun(i: FirstRunInput): boolean {
  return i.screen === 'home' && i.projectCount === 0 && !i.seen && !i.skippedThisSession;
}
