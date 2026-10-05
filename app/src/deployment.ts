/**
 * Deployment-provided settings, fixed at build time. The product knows nothing about the
 * authentication in front of a deployment: a protected preview only tells it where signing
 * out goes (VITE_SIGN_OUT_URL, e.g. an authenticating proxy's sign-out endpoint).
 */

/**
 * The sign-out destination, or null when the deployment has none (local and unauthenticated
 * builds show no sign-out control). Only a same-origin path or an http(s) URL is accepted.
 */
export function parseSignOutUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (url === '') return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

export const SIGN_OUT_URL = parseSignOutUrl(import.meta.env.VITE_SIGN_OUT_URL);

/**
 * A preview deployment's name (e.g. "Sprint 9"), or null for a regular deployment. A preview
 * says so on every screen, so it is never mistaken for the validated deployment beside it.
 */
export function parsePreviewName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 .-]{0,23}$/.test(name) ? name : null;
}

export const PREVIEW_NAME = parsePreviewName(import.meta.env.VITE_PREVIEW_NAME);

/**
 * A storage namespace, or null. A preview served on the same origin as another deployment keeps
 * its projects (IndexedDB) and preferences (localStorage) apart from that deployment's.
 */
export function parseStorageNamespace(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(value) ? value : null;
}

/** A storage name (database or preference key) within the deployment's namespace. */
export function storageName(name: string, namespace: string | null): string {
  return namespace ? `${namespace}/${name}` : name;
}

export const STORAGE_NAMESPACE = parseStorageNamespace(import.meta.env.VITE_STORAGE_NAMESPACE);
