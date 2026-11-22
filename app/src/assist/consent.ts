/**
 * TBI-017 slice 1: the remembered consent to send a circuit to the AI service (design §2).
 *
 * - Kept per account AND per consent version: a new version from the service asks again.
 * - The account is the service's opaque reference when it gives one (`status.account`); without
 *   it the consent is this browser's (key `browser`). An email or a name is never part of a key.
 * - The browser copy is a convenience only: the consent is sent with every request and the
 *   service is the authority (it refuses a request without the current version).
 * - "Withdraw consent" removes every remembered version of that account.
 * - Storage failure (private mode, quota) is never fatal: the dialog simply asks again.
 */
import { STORAGE_NAMESPACE, storageName } from '../deployment.js';

export const CONSENT_PREFIX = 'tbi-lab.assist.consent';
const OPAQUE = /^[A-Za-z0-9._-]{1,64}$/;

/** The subset of `Storage` used (tests pass a Map-backed fake). */
export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export const accountRef = (account: string | undefined) =>
  account && OPAQUE.test(account) ? account : 'browser';

export function consentKey(
  account: string | undefined,
  version: string,
  namespace: string | null = STORAGE_NAMESPACE,
): string | null {
  if (!OPAQUE.test(version)) return null;
  return storageName(`${CONSENT_PREFIX}/${accountRef(account)}/${version}`, namespace);
}

function browserStorage(): ConsentStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class ConsentStore {
  constructor(
    private readonly storage: ConsentStorage | null = browserStorage(),
    private readonly namespace: string | null = STORAGE_NAMESPACE,
  ) {}

  has(account: string | undefined, version: string): boolean {
    const k = consentKey(account, version, this.namespace);
    if (!k || !this.storage) return false;
    try {
      const v = this.storage.getItem(k);
      if (!v) return false;
      const parsed = JSON.parse(v) as { accepted?: unknown };
      return parsed.accepted === true;
    } catch {
      return false;
    }
  }

  /** Remember the consent; false when it could not be stored (the dialog will ask again). */
  grant(account: string | undefined, version: string, now: () => Date = () => new Date()): boolean {
    const k = consentKey(account, version, this.namespace);
    if (!k || !this.storage) return false;
    try {
      this.storage.setItem(k, JSON.stringify({ accepted: true, at: now().toISOString() }));
      return true;
    } catch {
      return false;
    }
  }

  /** Forget every remembered version for this account. */
  withdraw(account: string | undefined): void {
    if (!this.storage) return;
    const prefix = storageName(`${CONSENT_PREFIX}/${accountRef(account)}/`, this.namespace);
    try {
      const keys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k?.startsWith(prefix)) keys.push(k);
      }
      for (const k of keys) this.storage.removeItem(k);
    } catch {
      // nothing remembered can be read either
    }
  }
}
