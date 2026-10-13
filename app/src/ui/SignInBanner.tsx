/**
 * OS-11: the sign-in has expired (the gate answered a background request with 401). Background
 * requests never start a login themselves (gate.ts); this banner says so and offers ONE way back:
 * "Sign in again" saves pending changes, then reloads this page, a single top-level navigation
 * that starts one clean login and returns here. Never automatic, so there is no redirect loop.
 * Projects live in this browser and are untouched by the sign-in.
 */
import { useEffect, useState } from 'preact/hooks';
import { isSignedOut, onSignedOut } from '../gate.js';
import { useStore, useT } from './context.js';

export function SignInBanner() {
  const t = useT();
  const store = useStore();
  const [expired, setExpired] = useState(isSignedOut);
  const [busy, setBusy] = useState(false);
  useEffect(() => onSignedOut(() => setExpired(true)), []);
  if (!expired) return null;
  const signIn = async () => {
    setBusy(true);
    try {
      await store.flush();
    } finally {
      window.location.reload();
    }
  };
  return (
    <div class="banners">
      <div class="banner banner-warning" role="alert" data-testid="signin-expired">
        <span>{t('auth.expired')}</span>{' '}
        <button
          type="button"
          class="button"
          data-testid="signin-again"
          disabled={busy}
          onClick={() => void signIn()}
        >
          {t('auth.signInAgain')}
        </button>
      </div>
    </div>
  );
}
