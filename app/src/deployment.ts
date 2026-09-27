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
