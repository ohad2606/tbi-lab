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

/**
 * Sprint 13 H7: the external feedback form, or null. DISABLED unless a deployment sets
 * VITE_FEEDBACK_URL (an https form address) — external data collection needs the owner's approval
 * first, and no build sets it today. VITE_FEEDBACK_VERSION_PARAM names the form's query parameter
 * that is prefilled with the app version and commit (e.g. a form's prefill entry id).
 */
export function parseFeedbackUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}

export function parseFeedbackParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value.trim()) ? value.trim() : null;
}

export const FEEDBACK_URL = parseFeedbackUrl(import.meta.env.VITE_FEEDBACK_URL);
export const FEEDBACK_VERSION_PARAM = parseFeedbackParam(
  import.meta.env.VITE_FEEDBACK_VERSION_PARAM,
);

/** The form link with the version prefilled (when a parameter name is configured). */
export function feedbackLink(base: string, param: string | null, version: string): string {
  if (!param) return base;
  const u = new URL(base);
  u.searchParams.set(param, version);
  return u.toString();
}

/**
 * Sprint 14: the in-app "Report a problem" action. OFF unless a deployment builds with
 * VITE_PROBLEM_REPORTS=1, and then only useful where its Session Host stores reports
 * (TBI_REPORTS_DIR; without it every report is refused with a clear message, never lost silently).
 */
export function parseEnabled(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '1';
}

export const PROBLEM_REPORTS = parseEnabled(import.meta.env.VITE_PROBLEM_REPORTS);
