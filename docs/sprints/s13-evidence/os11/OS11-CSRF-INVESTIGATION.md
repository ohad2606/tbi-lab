# OS-11: "Login Failed: Unable to find a valid CSRF token" (P1): root cause and fix

**Status:**
- **Root cause confirmed** from the gate's own log and **reproduced on the real oauth2-proxy binary** (v7.15.4).
- **App fix implemented and tested locally; not deployed.**
- **Gate changes proposed for separate approval; not applied.**
- No live authentication configuration was changed.

No OAuth `code`, `state`, cookie or token value appears in this document, the tests or the evidence. Log lines were read with their query strings and e-mail addresses redacted, and clients were told apart by a hash of the User-Agent.

## 1. The redirect chain (current gate)

```
browser ── GET /path ──► Caddy :443 ──► oauth2-proxy (no valid session)
   ◄── 302 accounts.google.com/o/oauth2/auth?…state=<nonce:/path>…   + Set-Cookie __Host-tbi_dev_lab_csrf=<nonce> (Max-Age 900, Lax, Secure, HttpOnly)
browser ── Google account chooser (prompt=select_account) ──► 302 /oauth2/callback?code=…&state=…
oauth2-proxy: state nonce == CSRF cookie? ── yes: redeem code, set session cookie, clear CSRF cookie, 302 /path (the app)
                                          └─ no:  403 "Unable to find a valid CSRF token", browser stays on /oauth2/callback
```

- **A successful login never stays on the callback.** The gate log shows every successful callback answered with 302 to the original path. The reproduction (case 2) confirms it ends on the exact original URL.
- **The CSRF cookie name is shared** (`cookie_csrf_per_request` is off). Every login start overwrites it.

## 2. What happened (gate log, 2026-10-13, owner's browser = one User-Agent hash)

| Time (UTC) | Request | Gate |
|---|---|---|
| 12 Oct 19:03 | sign-in | session cookie valid **8 h** (`cookie_expire = 8h`, from login; no refresh) |
| 06:04:15 – 06:05:08 | `/version.json` ×3 | 302 to Google, each a **new login start**, each overwriting the CSRF cookie |
| **06:05:23** | **`/` (the owner's refresh) and `/version.json`, same browser, same second** | two login starts; the second overwrote the first's CSRF cookie |
| 06:05:27 | `/oauth2/callback` (state of the first) | **403, "CSRF token mismatch"** (auth log) |
| 06:05:28 | `/favicon.ico` (the error page's own request) | yet another login start |

**Root cause.** After the gate session expires, *any* request without `Accept: application/json` makes oauth2-proxy start a new login and replace its single CSRF cookie. The app's version check runs **when the window regains focus or the tab becomes visible**, the very moment the user returns and refreshes. That request overwrote the CSRF cookie of the user's own login while the user was at Google. The login then came back with a state the cookie no longer held.

A refresh on the error page only replays the dead callback, so it can never succeed: the dead end the owner saw.

**Corrections from the investigation:**
- **The session lifetime is 8 h from sign-in, not the 1 h the log's `expires` field suggests.** That field is the Google access token's expiry. Without a refresh token, the proxy keeps the session until the cookie ends; this was verified on the binary. "About an hour" is when the owner returned to the tab, after the 8 h had passed.
- **The 403 page itself does offer working recovery links** (`/`, `/oauth2/sign_in`; reproduction case 7). The dead end is the natural action, *refresh*.

## 3. Reproduction on the real oauth2-proxy (`runtime/tests/os11-gate.runtime.test.ts`)

The same binary as the gate, on loopback, with a mock OpenID provider (a throwaway RSA key; no real credentials). Configured like the gate: `skip_provider_button`, Lax cookies, an 8 h cookie. **8/8 cases pass**, recorded in the evidence (`os11-gate.json`):

| # | Case | Result |
|---|---|---|
| 1 | Root cause: a background request while a login is in flight | the background request starts a 2nd login (302) and replaces the CSRF cookie; **callback 403 "CSRF token mismatch"**: reproduced |
| 2 | **The fix:** the same request with `Accept: …, application/json` | **401, no cookie written**; the login completes **on the original URL** (`/editor?x=1`), app 200, CSRF cookie cleared |
| 3 | Stale callback (refresh/back after success; another browser) | 403; the authorization code is **redeemed exactly once** (refused before any token request) |
| 4 | Expired/missing CSRF cookie | 403 (safe rejection) |
| 5 | Session expired (cookie lifetime) | background request **401, no login started**; one top-level request starts **exactly one** login → app 200 |
| 6 | Two tabs signing in at once, **current config** | **both 403**: tab 1's state no longer matches, and its failed callback clears the cookie, so tab 2 finds none |
| 6b | Same, with `--cookie-csrf-per-request` (proposal G1) | **both succeed** and land on their own URLs; a background login no longer clobbers either |
| 7 | The 403 page | links `/` and `/oauth2/sign_in`; following the sign-in link → one fresh login → the app |

## 4. Fix A (app; implemented, tested locally, NOT deployed)

| Change | Where |
|---|---|
| Every background request (version check, runtime health, build service, Session Host incl. the event stream, 3D assets) goes through `gateFetch`. It adds `application/json` to `Accept`, so after expiry the gate answers **401 and starts nothing** | `app/src/gate.ts`; the five call sites |
| A 401 raises a one-time "signed out" signal | `gate.ts` |
| Banner (EN/HE): "Your sign-in has expired. Your projects are saved in this browser." with **Sign in again**. It saves pending changes, then **one** reload (a top-level navigation): one clean login back to this page. Never automatic, so there is no loop | `app/src/ui/SignInBanner.tsx` |
| Project data: local IndexedDB, untouched by the gate; flushed before the reload | — |

**Tests (all fail without the fix where applicable):**
- `app/tests/os11-gate.test.ts`: Accept handling; 401 → signal once; every default client sends `application/json`; a source guard that **no file other than `gate.ts` calls `fetch(`**. The last two **fail without the fix**, which was checked by temporarily reverting the call sites.
- `app/e2e/os11-signin.spec.ts`: a gate 401 on focus → banner → Sign in again → exactly one navigation → the edit is saved.
- `runtime/tests/os11-gate.runtime.test.ts` (above).

**What fix A covers:** the reported failure (the app's own requests racing the user's login). With it, refreshing after expiry gives one clean login.

**What it does not cover:** the user signing in from **two tabs at once** (case 6), and requests the app does not issue itself (the browser's `/favicon.ico`, lazily loaded code chunks). These need G1.

## 5. Proposed gate changes (NOT applied; separate approval)

### G1: per-request CSRF cookies (recommended with fix A)

```diff
 # /etc/oauth2-proxy/oauth2-proxy.cfg
 cookie_samesite = "lax"
 cookie_expire = "8h"
+# OS-11: one CSRF cookie per login attempt (name derived from its state), so concurrent logins
+# (two tabs, a background request) cannot overwrite each other. Expiry unchanged (15 min).
+cookie_csrf_per_request = true
+cookie_csrf_expire = "15m"
```

- **Effect:** case 6b, verified on the same binary.
- **Security:** CSRF protection is unchanged (still a nonce cookie per login, HttpOnly, Secure, Lax, 15 min). The allowlist, the session cookie and the 403 for unauthorized identities are untouched.
- **Risk:** low. More short-lived cookies while logins are pending. The binary also supports `cookie_csrf_per_request_limit` if needed.
- **Validation:**
  1. Backup.
  2. `oauth2-proxy --config … --version`/config test.
  3. Restart oauth2-proxy (a few seconds; signed-in sessions stay valid: same cookie secret and name).
  4. The owner signs in, from two tabs at once.
  5. An unauthorized account still gets 403.
  6. `publish-frontend.sh`'s gate checks.
- **Rollback:** restore the backup copy of the file and restart oauth2-proxy (seconds).

### G2: stop logging callback codes and states (recommended)

```diff
+# OS-11: the request log printed /oauth2/callback?code=…&state=… for every login.
+exclude_logging_path = ["/oauth2/callback"]
```

- **Why:** the journal currently holds 82 such lines, readable by root and the `adm` group. They are not replayable (codes are single-use and already redeemed; states are bound to cleared cookies), so the risk is low, but the requirement is not to log them. AuthSuccess/AuthFailure stay in the auth log.
- **Gap:** the standard log's "invalid redirect" warnings can still quote a callback URL when an error page is rendered; that becomes rarer with fix A and G1.
- **Deleting the existing journal lines** would be a destructive step. **Not proposed; the owner's choice.**
- **Risk:** none for users. Validation and rollback are the same as G1 (one restart for both).

### Not proposed

- Disabling CSRF.
- Automatic re-login loops.
- Changing the 8 h session or adding refresh tokens: that needs `prompt=consent` on every login, and the 8 h re-login is a clean single login once fix A is in.
- Custom error templates: the default page already offers working links.

## 6. Acceptance criteria

| Criterion | Status |
|---|---|
| Successful login ends on the intended URL, not the callback | ✓ gate log (every success → 302 to the path); reproduction case 2 |
| Refreshing after session expiry starts safe reauthentication | ✓ with fix A: cases 2 and 5; e2e |
| A stale callback is rejected safely | ✓ case 3 (403; the code is never redeemed twice) |
| Recovery from a rejected callback is clear and leads to a fresh login | ✓ case 7 (the page's sign-in link); fix A's banner prevents the race. A refresh *on the error page* still replays it: the user follows the page's link |
| Sleep/resume and multiple tabs do not dead-end | Sleep/resume: ✓ with fix A. **Two tabs signing in at once: needs G1** (case 6 fails today, 6b passes) |
| Project data intact | ✓ local data, flushed before the reload (e2e) |
| Automated regression tests for the root cause | ✓ unit (incl. a source guard), e2e, real-proxy reproduction |

**Deployment:** fix A ships with the next approved frontend release (DEV via `publish-frontend.sh`). G1 and G2 need explicit approval of the gate change.
