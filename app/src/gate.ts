/**
 * The authentication gate (oauth2-proxy) and the app's background requests (OS-11).
 *
 * After the sign-in session expires (about an hour: Google's access token, no refresh token),
 * every request without `Accept: application/json` makes the gate START A NEW LOGIN: a 302 to
 * Google and a fresh CSRF cookie under one shared name. The app's background requests (version
 * check on focus, runtime health, build and session calls, 3D assets) therefore overwrote the CSRF
 * cookie of the user's own login in flight: Google returned the user with the first login's state,
 * the cookie held another one, and the callback failed "CSRF token mismatch" (403, a dead end).
 *
 * With `application/json` in Accept the gate answers 401 instead and starts nothing (verified on
 * the deployed gate, v7.15.4). So every background request goes through `gateFetch`: it adds that
 * Accept value and reports a 401 as "signed out". Only the user's own top-level navigation (the
 * "Sign in again" button: one reload) starts a login. Behind the gate a backend's own 401 means
 * the same thing (no identity reached it).
 */

const JSON_TYPE = 'application/json';

/** `init` with `application/json` added to its Accept header (kept first if one is given). */
export function withGateAccept(init: RequestInit = {}, accept?: string): RequestInit {
  const headers = new Headers(init.headers);
  const current = accept ?? headers.get('accept') ?? '';
  const values = current
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.includes(JSON_TYPE)) values.push(JSON_TYPE);
  headers.set('accept', values.join(', '));
  return { ...init, headers };
}

type Listener = () => void;
const listeners = new Set<Listener>();
let signedOut = false;

/** The gate (or a backend) said the sign-in is gone. Idempotent; listeners hear it once. */
export function reportSignedOut(): void {
  if (signedOut) return;
  signedOut = true;
  for (const l of [...listeners]) l();
}

export const isSignedOut = () => signedOut;

/** Subscribe to the signed-out signal; returns the unsubscribe. */
export function onSignedOut(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** fetch for background requests: never starts a login; a 401 reports "signed out". */
export async function gateFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  accept?: string,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<Response> {
  const res = await fetchFn(input, withGateAccept(init, accept));
  if (res.status === 401) reportSignedOut();
  return res;
}

/** For tests only. */
export function resetGateForTests(): void {
  signedOut = false;
  listeners.clear();
}
