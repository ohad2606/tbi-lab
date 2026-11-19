import type { BrowserContext } from '@playwright/test';

/**
 * The first-run welcome (TBI-014) opens over an empty library. Specs that create their own
 * browser context (the config's default storageState does not reach them) mark the device as a
 * returning user so the dialog does not cover the screen under test. first-run.spec.ts does not use it.
 */
export async function markReturningUser(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      if (localStorage.getItem('tbi-lab.firstRun.v1') === null)
        localStorage.setItem('tbi-lab.firstRun.v1', 'seen');
    } catch {
      /* storage unavailable: nothing to mark */
    }
  });
}
