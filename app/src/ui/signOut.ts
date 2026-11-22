/**
 * TBI-017: leaving the session forgets the AI consent that was only remembered for this browser
 * session (sessionStorage, keys `<prefix>/session/<version>`), so the next person at this tab is
 * asked. Kept out of `src/assist` on purpose: routine builds carry no assist code (checkAssist),
 * so the key prefix is repeated here and a test pins it to `CONSENT_PREFIX`.
 * Account-keyed consent (localStorage) belongs to that account and is not touched.
 */
export const SESSION_CONSENT_MARK = 'tbi-lab.assist.consent/session/';

export function forgetSessionConsents(storage: Storage | null = safeSession()): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.includes(SESSION_CONSENT_MARK)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // storage unavailable: nothing was remembered
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
