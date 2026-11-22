/**
 * TBI-017 slice 1: the remembered consent to send a circuit to the AI service (design §2, §12c).
 *
 * - Kept per account AND per consent version: a new version from the service asks again.
 * - Remembered across browser sessions (localStorage, key `acct:<ref>`) ONLY when the service
 *   gives a valid opaque account reference (`status.account`). Without one (the service does not
 *   send it today) every account on this browser would share the copy, so it is kept for this
 *   browser session only (sessionStorage, key `session`; memory when that is unavailable): a new
 *   browser session asks again. An email or a name is never part of a key.
 * - The browser copy is a convenience only: the consent is sent with every request and the
 *   service is the authority (it refuses a request without the current version).
 * - "Withdraw consent" removes every remembered version of that account (or of the session).
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

/** Whether this is a usable account reference (then the consent is remembered across sessions). */
export const isAccountRef = (account: string | undefined): account is string =>
  !!account && OPAQUE.test(account);

/** The key segment: `acct:<ref>` for an account, `session` otherwise (never mixed up). */
export const accountRef = (account: string | undefined) =>
  isAccountRef(account) ? `acct:${account}` : 'session';

export function consentKey(
  account: string | undefined,
  version: string,
  namespace: string | null = STORAGE_NAMESPACE,
): string | null {
  if (!OPAQUE.test(version)) return null;
  return storageName(`${CONSENT_PREFIX}/${accountRef(account)}/${version}`, namespace);
}

/** A Map-backed storage: the session fallback when sessionStorage is not available. */
export function memoryStorage(): ConsentStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function browserStorage(kind: 'localStorage' | 'sessionStorage'): ConsentStorage | null {
  try {
    return typeof globalThis[kind] === 'undefined' ? null : globalThis[kind];
  } catch {
    return null;
  }
}

export class ConsentStore {
  private readonly session: ConsentStorage;
  constructor(
    /** Long-lived storage, used only with an account reference. */
    private readonly storage: ConsentStorage | null = browserStorage('localStorage'),
    private readonly namespace: string | null = STORAGE_NAMESPACE,
    /** This browser session's storage, used without an account reference. */
    session: ConsentStorage | null = browserStorage('sessionStorage'),
  ) {
    this.session = session ?? memoryStorage();
  }

  private backing(account: string | undefined): ConsentStorage | null {
    return isAccountRef(account) ? this.storage : this.session;
  }

  has(account: string | undefined, version: string): boolean {
    const k = consentKey(account, version, this.namespace);
    const s = this.backing(account);
    if (!k || !s) return false;
    try {
      const v = s.getItem(k);
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
    const s = this.backing(account);
    if (!k || !s) return false;
    try {
      s.setItem(k, JSON.stringify({ accepted: true, at: now().toISOString() }));
      return true;
    } catch {
      return false;
    }
  }

  /** Forget every remembered version for this account (or this session). */
  withdraw(account: string | undefined): void {
    const s = this.backing(account);
    if (!s) return;
    const prefix = storageName(`${CONSENT_PREFIX}/${accountRef(account)}/`, this.namespace);
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(prefix)) keys.push(k);
      }
      for (const k of keys) s.removeItem(k);
    } catch {
      // nothing remembered can be read either
    }
  }
}
