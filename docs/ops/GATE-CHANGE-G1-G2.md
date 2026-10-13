# Gate changes G1 (per-request CSRF cookies) and G2 (no OAuth secrets in logs): proposal

**Status: PROPOSED. Nothing applied to the live gate.**
- G1 needs explicit approval (PM decision 2026-10-13 §B).
- G2 is a prepared, bounded change, likewise applied only on approval.

All evidence comes from the **same binary as the gate** (oauth2-proxy v7.15.4, go1.26.7) and the same Caddy (2.6.2), on loopback, with a mock OpenID provider and fake values. **No real code, state, cookie or credential appears anywhere.**

Tests: `runtime/tests/os11-gate.runtime.test.ts` (19 cases). Evidence: `docs/sprints/s13-evidence/os11/os11-gate*.json`.

## Current configuration (`/etc/oauth2-proxy/oauth2-proxy.cfg`, relevant keys; secrets live in a root-only env file and are not shown)

```
reverse_proxy = true
provider = "google"
redirect_url = "https://dev-lab.tbi-tech.net/oauth2/callback"
prompt = "select_account"
skip_provider_button = true
authenticated_emails_file = "/etc/oauth2-proxy/allowed-emails"
email_domains = []
cookie_name = "__Host-tbi_dev_lab"
cookie_secure = true
cookie_httponly = true
cookie_samesite = "lax"
cookie_expire = "8h"
request_logging = true
request_logging_format = "{{.Client}} - {{.RequestID}} - [{{.Timestamp}}] {{.Host}} {{.RequestMethod}} {{.Upstream}} {{.RequestURI}} …"
auth_logging = true
standard_logging = true
# cookie_csrf_per_request: not set (default false); cookie_csrf_expire: not set (default 15m)
```

## How the CSRF cookie works today, and with G1

- **A login start** (any unauthenticated request that is not JSON) makes oauth2-proxy:
  1. create a random nonce;
  2. put it into the OAuth `state` sent to Google;
  3. set a CSRF cookie holding it: `__Host-tbi_dev_lab_csrf`, Secure, HttpOnly, SameSite=Lax, 15 min.
- **At `/oauth2/callback`** the proxy loads the CSRF cookie and checks that the nonce in `state` matches. Only then does it redeem the authorization code. Whatever the outcome, it clears the CSRF cookie.
- **Today the CSRF cookie has ONE fixed name**, so every new login start in a browser overwrites the pending one. A second tab, or any background request after the session expired (the root cause of OS-11, now fixed in the app), makes the first login fail. And because a failed callback clears the cookie, a login running in parallel then fails too.
- **With G1** (`cookie_csrf_per_request = true`), the cookie name is derived from each login's own state, so concurrent logins have separate cookies. **The validation itself is unchanged:**
  - the nonce must still match a cookie this browser holds for exactly that state;
  - the cookie is still Secure, HttpOnly, Lax and 15 min;
  - it is still cleared after use.

## Evidence (same binary): G1 changes only the concurrent-tab result

| Check | Current | G1 |
|---|---|---|
| Normal login: ends on the original URL; CSRF cookie cleared | 302 | 302 |
| Replayed callback (refresh/back); code redeemed exactly once | 403 | 403 |
| No CSRF cookie | 403 | 403 |
| Tampered `state` | 403 | 403 |
| Only another login's CSRF cookie present | 403 | 403 |
| The callback URL presented by another browser | 403 | 403 |
| **Two tabs signing in at once** | **403, 403 (both lost)** | **302, 302** |
| Expired session: background JSON request | 401, no login, no CSRF cookie | 401, no login, no CSRF cookie |
| Expired session: interactive re-login | 302 → app | 302 → app |
| Account not on the allowlist | 403, no session | 403, no session |

The allowlist (`authenticated_emails_file`, `email_domains = []`), the session cookie, `prompt=select_account`, and the 403 for an unknown identity are not touched.

## G1: exact change

```diff
 # /etc/oauth2-proxy/oauth2-proxy.cfg
 cookie_samesite = "lax"
 cookie_expire = "8h"
+# OS-11 G1: one CSRF cookie per login attempt (named after its state), so concurrent logins
+# cannot overwrite each other. Validation unchanged; expiry stated explicitly (the default).
+cookie_csrf_per_request = true
+cookie_csrf_expire = "15m"
```

## G2: no OAuth secrets in future logs; the audit kept

**Findings (live journal; counts only, values never read out):**

| Where | What | Live journal since 2026-09-25 |
|---|---|---|
| oauth2-proxy request log | `/oauth2/callback?code=…&state=…` on every login | 82 lines |
| oauth2-proxy standard log, **failure path** (e.g. a missing CSRF cookie): `oauthproxy.go` prints the **whole request**, including the **Cookie header** | code, state, and **any session cookie the browser sent** | 16 dumps; 12 contain a session-cookie value (the latest from 2026-10-05) |

**Risk now: low.**
- Every logged code is single-use and redeemed or expired.
- Every state is bound to a cleared cookie.
- Every logged session cookie is past its 8 h validity: cookies are signed with their time and refused after `cookie_expire`.

**Risk in future: a live credential.** A failure while a browser still holds a valid session cookie would write that cookie to the journal.

**Access:**
- The journal is root-owned, and systemd's default ACL grants read access to group `adm`: `ubuntu` (which has passwordless sudo anyway), `syslog`, and **`ocarun` (the Oracle Cloud Agent)**.
- **Retention:** no explicit limit; capped by size only (default ≤ 10 % of the disk, ≤ 4 GiB). The oldest entry is from 2026-09-25.

**G2 has three bounded parts:**

```diff
 # (a) /etc/oauth2-proxy/oauth2-proxy.cfg — the request log stops recording the callback line
+exclude_logging_path = ["/oauth2/callback"]
```

```ini
# (b) NEW /etc/systemd/system/oauth2-proxy.service.d/10-log-filter.conf
# journald drops, at ingestion, the request dumps (they carry the Cookie header) and any line
# quoting a callback query. Other oauth2-proxy lines (login starts, AuthSuccess/AuthFailure with
# request id, errors) are kept.
[Service]
LogFilterPatterns=~&\{(GET|POST|HEAD)
LogFilterPatterns=~/oauth2/callback\?
```

```diff
 # (c) /etc/caddy/Caddyfile, inside the dev-lab.tbi-tech.net site: a redacted audit line for the
 #     callback ONLY (time, status, path, duration, User-Agent; no code, state, Cookie or
 #     Set-Cookie). This replaces the one line (a) removes and makes a missing-CSRF failure visible
 #     again: that path writes no AuthFailure line.
 dev-lab.tbi-tech.net {
 	encode zstd gzip
+	log {
+		format filter {
+			wrap json
+			fields {
+				request>uri query {
+					delete code
+					delete state
+				}
+				request>headers>Cookie delete
+				request>headers>Authorization delete
+				resp_headers>Set-Cookie delete
+			}
+		}
+	}
+	@notcallback not path /oauth2/callback
+	skip_log @notcallback
 	reverse_proxy 127.0.0.1:4180
```

**Evidence for G2:**
- **(a)** On the real binary, a successful login leaves **0** code/state in the log; the `[AuthSuccess]` line, with timestamp and request id, stays.
- **(b)**
  - Applied to the binary's real failure output, the same patterns leave **0** code/state and **0** Cookie dumps, and keep "Initiating login".
  - On systemd 259, **this exact drop-in file** on a throwaway unit with fake values (since removed): `systemctl show` lists both patterns, and journald dropped exactly the two secret-bearing lines while keeping the audit lines. (systemd strips trailing spaces from unit-file values, so the pattern has none.)
- **(c)**
  - `caddy validate` passes on 2.6.2.
  - Through `reverse_proxy` with a fake upstream returning `Set-Cookie`, the access line has `"uri":"/oauth2/callback"`, the status, and **0** fake code, state, CSRF or session values. Caddy also redacts `Set-Cookie` values by default; the explicit delete is defence in depth.
  - Other paths are not logged (the Caddy site had no access log before).

**Not proposed:**
- Deleting historical journal entries: no live value, so it is the owner's decision.
- `standard_logging = false`: it would lose error diagnostics; (b) is narrower.
- Changing `adm` membership or the Oracle agent: outside this scope. It is listed as a residual for the owner.

## Restart impact

| Step | Effect |
|---|---|
| oauth2-proxy restart (G1, G2a, G2b together: one `daemon-reload` + restart) | ~1–2 s. **Signed-in users stay signed in** (stateless cookie sessions; same cookie secret and name). Open event streams (a running ESP32 session) drop and reconnect within the app's 25 s reconnect window. A login started **before** and finished **after** the restart fails once (G1 renames the CSRF cookie); the user signs in again |
| Caddy (G2c) | `caddy validate` first, then `systemctl reload caddy`: graceful, no dropped connections |

Schedule: when the owner is idle and no ESP32 session is live (check `systemctl list-units 'tbi-qemu@*'`).

## Validation plan (after approval)

1. Back up `oauth2-proxy.cfg`, the unit, the Caddyfile; record their hashes. `caddy validate` the new Caddyfile.
2. Apply. One daemon-reload + oauth2-proxy restart; Caddy reload. Check `systemctl is-active`; `publish-frontend.sh`'s gate checks (anonymous: HTML request → 302 + CSRF cookie with the **per-request name**; JSON request → 401 with no cookie).
3. Owner: sign in. Two tabs signing in at once. An expired session (or delete the session cookie) → one clean re-login. A non-allowlisted Google account → 403.
4. Logs: after the owner's login, `journalctl -u oauth2-proxy -u caddy --since …` contains **no** `code=` / `state=` / `Cookie:[` (counted, not printed), and does contain AuthSuccess and the Caddy callback line.

## Rollback (each step seconds)

- Restore the backed-up `oauth2-proxy.cfg`.
- Remove `oauth2-proxy.service.d/10-log-filter.conf`; `daemon-reload`; restart oauth2-proxy.
- Restore the Caddyfile; `systemctl reload caddy`.

Signed-in sessions survive the rollback too.
