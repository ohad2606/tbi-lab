# Gate changes G1 (per-request CSRF cookies) and G2 (no authentication secrets in logs)

**Status (2026-10-13):**
- **G1: APPLIED live** at 11:40 UTC (PM decision "Sprint 13 Security Gate Decision": G1 GO).
- **G2: PROPOSED, corrected, awaiting approval.** It needs configuration outside the reviewed G1 keys (oauth2-proxy, a systemd drop-in, Caddy), which the PM decision requires approval for.

All test evidence comes from the **same binaries as the gate** (oauth2-proxy v7.15.4 / go1.26.7, Caddy 2.6.2, systemd 259) and fake values only. **No real code, state, cookie, token or secret appears in this document, the tests or their evidence.**

Evidence: `docs/sprints/s13-evidence/g1-g2/`.

## G1: applied

### Exact change (`/etc/oauth2-proxy/oauth2-proxy.cfg` = `deploy/dev-lab/oauth2-proxy.cfg`)

```diff
 cookie_samesite = "lax"
 cookie_expire = "8h"
+# Sprint 13 G1 (PM decision 2026-10-13, OS-11): one CSRF cookie per login attempt, named after its
+# state, so concurrent logins (two tabs) cannot overwrite each other. Validation is unchanged;
+# the expiry is the default, stated explicitly.
+cookie_csrf_per_request = true
+cookie_csrf_expire = "15m"
```

- sha256: before `8c6cde5ce4c0c64c…`, after `aac495428e2357db…`.
- **No other key changed.** The live diff against the backup is exactly these 5 lines.
- `cookie_csrf_per_request_limit` exists in v7.15.4 and was left unset (unlimited). It was not part of the approval; see the accumulation measurement below.

### Compatibility (before applying)

`runtime/tests/s13-gate-google.runtime.test.ts`, **17/17**, ran the real v7.15.4 binary on the gate's own config file. It used the **Google provider** (the earlier OS-11 tests used generic OIDC), pointed by flags at a local mock of Google. It tested four variants:
- `current`: the pre-G1 file, which is what a rollback restores;
- **`installed file (G1)`**: the exact bytes installed;
- `G1`;
- `G1+G2a`.

| Check | current (rollback) | G1 (installed file) |
|---|---|---|
| The configuration loads; session cookie settings unchanged | yes | yes |
| CSRF cookie name | `__Host-tbi_dev_lab_csrf` | `__Host-tbi_dev_lab_<per-login hash>_csrf` |
| CSRF cookie attributes | HttpOnly, SameSite=Lax, 900 s | same |
| Normal login → original URL, CSRF cookie cleared | 302 | 302 |
| Replayed callback; code redeemed exactly once | 403 | 403 |
| Missing CSRF cookie / tampered state / only another login's cookie / another browser | 403 ×4 | 403 ×4 |
| **Two tabs signing in at once** | **403, 403** | **302, 302** (each on its own URL; both signed in) |
| Expired session: background JSON | 401, no login, no CSRF cookie | same |
| Expired session: page load | one login, signed in again | same |
| Account not on the allowlist | 403, no session | 403, no session |

**Accumulation (G1):** 20 abandoned login starts in one browser leave 20 CSRF cookies (a 4.2 kB Cookie header). Both the first and the last still complete. They expire after 15 min.
- Since OS-11, background requests no longer start logins, so only page loads do.
- If this ever matters, `cookie_csrf_per_request_limit` caps it. That would be a separate decision.

### Live application (idle window: no request for 75 min, no ESP32 session)

1. **Backup** `/var/backups/tbi-lab/g1-pre-20261013T113904Z`: `oauth2-proxy.cfg` (`8c6cde5c…`), the unit (`557ba4b3…`) and the Caddyfile (`47ce8f87…`). Each is byte-equal to live, with original permissions (cfg 640 root:oauth2-proxy).
2. **Baseline** (`live-pre-G1.txt`): `tools/live-gate-g1.mjs pre`, 12/12.
3. **Install + restart:** the gate answered again **0.26 s** after `systemctl restart`. Active, new PID, `NRestarts=0`, no error in the startup log.
4. **Live checks with G1** (`live-G1.txt`): **12/12**. They are anonymous and use fake values only:
   - a page load gives 302 to Google, with `prompt=select_account` and the gate's callback;
   - exactly **one** CSRF cookie, named per request, with Path=/, Secure, HttpOnly, SameSite=Lax, Max-Age=900 and no Domain;
   - **a second concurrent login gets its own cookie (no overwrite)**;
   - `/version.json` and `/runtime/health` as JSON give 401 with no cookie and no redirect;
   - a malformed state gives 500 and no session;
   - a fake state with no CSRF cookie, a fake per-request CSRF cookie, or a fake fixed-name CSRF cookie gives **403 and no session** in each case;
   - a protected path redirects to Google and never serves content.
5. **Rollback rehearsal, live** (`live-rollback-rehearsal.txt`):
   - restoring the backup and restarting: **0.26 s**; live is byte-equal to the backup; 12/12 pre-G1 checks (one shared cookie name again);
   - reapplying G1: **0.27 s**; 12/12 again (`live-G1-after-rehearsal.txt`).
6. **The only Caddy error** in the window was my own readiness probe (`/version.json`, 502 for the restart's fraction of a second).

**Still needing a real Google sign-in (the owner):**
- two tabs in practice;
- a real expired session;
- a non-allowlisted Google account;
- the back button after login.

These are in `docs/alpha/OWNER-RETEST-OS11-OS12.md`, step 3 and step 8.

### G1 rollback (live-rehearsed, 0.26 s)

```
sudo install -m 640 -o root -g oauth2-proxy /var/backups/tbi-lab/g1-pre-20261013T113904Z/oauth2-proxy.cfg /etc/oauth2-proxy/oauth2-proxy.cfg
sudo systemctl restart oauth2-proxy
```

- Signed-in sessions survive: same cookie name and secret.
- A login in flight at that moment fails once, because its CSRF cookie name changes back.

## G2: root cause and every logging surface

**Do not assume the callback exclusion fixes every path. It does not.** Each surface on this host was checked against the live logs (counts only; values never printed) and against the v7.15.4 source.

| # | Surface | What it records today | Live evidence (whole journal since 2026-09-20; syslog since 09-27) |
|---|---|---|---|
| S1 | oauth2-proxy **request log** (`request_logging`) | The callback's URI: **code and state**, on every login | 82 callback lines (journal), also copied to syslog |
| S2 | oauth2-proxy **standard log, callback failure** (`oauthproxy.go:921`, `1352–1368`: `logger.Println(req, …)`) | The **whole request**: URI (code, state) and the **Cookie header**, so a **still-valid session cookie** if the browser is signed in. Also the nonce | 16 dumps, 12 with a session-cookie value (latest 2026-10-05); also in syslog |
| S3 | oauth2-proxy **token validation** (Google provider, `internal_util.go:74`) | The tokeninfo URL with the access token **truncated to 5 characters** (`stripToken`; i.e. the public `ya29.` prefix) and Google's answer: email, Google user id, client id (public), scope | 48 lines; **0** with more than the 5-character prefix (journal and all syslog rotations) |
| S4 | oauth2-proxy **auth log** (`[AuthSuccess]`/`[AuthFailure]`) | Email, request id, session summary (`token:true`, never a value) | No secret (source: `SessionState.String()`) |
| S5 | oauth2-proxy error paths (state parse, redeem, cookie load) | Error text, no secret (redeem errors carry Google's error body only) | — |
| S6 | **Caddy error log** (`http.log.error`, both sites) | When an upstream is down (an oauth2-proxy restart, a backend restart): the **full URI**, so **code and state** for a callback. Cookie and Authorization are **already redacted** by Caddy 2.6.2 (logged as `[]`) | 0 callback lines so far; reproduced offline |
| S7 | Caddy access log | None today (no `log` directive) | — |
| S8 | **systemd journal** | Stores S1–S6 | 179 MB, size-capped, no time limit |
| S9 | **rsyslog** `/var/log/syslog` (journald forwards to it) | Copies of S1–S3 | syslog (+.1, .2.gz, .3.gz): 83 callback lines, 15 dumps, 12 with a session cookie |
| S10 | **Oracle Cloud Agent** | `unifiedmonitoring` (log shipping) is enabled but **not installed**: its package 404s for this Ubuntu, and no fluentd runs. `runcommand` runs as `ocarun` (in `adm`) | **No log leaves the host.** Run Command history: none |
| S11 | Backends (session host, build service) | They receive the Cookie header from oauth2-proxy but do not log headers | 0 cookie values in their journals |
| — | Client secret, cookie secret | — | **0** occurrences in the journal, syslog and auth.log (all rotations); matched without displaying them, with a positive control |

### Remediation, three bounded parts (PROPOSED: approval required)

Files: `deploy/dev-lab/g2/`.

**(a) oauth2-proxy (S1)**: `oauth2-proxy.cfg.g2a.diff`
```diff
 standard_logging = true
+# Sprint 13 G2 (a): the request log does not record the OAuth callback (its URI carries the code
+# and state). The config-file key is PLURAL: the flag's singular name is rejected by v7.15.4 as an
+# invalid key and the proxy would not start.
+exclude_logging_paths = ["/oauth2/callback"]
```
**Correction to the earlier proposal.** It said `exclude_logging_path` (singular). v7.15.4 refuses that key ("invalid keys") and **would not have started**. The earlier test passed it as a flag, where the singular name is valid. The new test uses the config file, as the gate does.

**(b) systemd drop-in (S2, S1 belt-and-braces, S8, S9)**: `10-log-filter.conf` → `/etc/systemd/system/oauth2-proxy.service.d/10-log-filter.conf`
```ini
[Service]
LogFilterPatterns=~&\{(GET|POST|HEAD)
LogFilterPatterns=~/oauth2/callback\?
```

**(c) Caddy (S6, S7)**: `Caddyfile.g2.diff` against the live file (`Caddyfile.live-20261013`); candidate `Caddyfile.g2-candidate`.
- **(c1)** A new global block, `log default { format filter { wrap json; fields { request>uri query { delete code; delete state }; request>headers>Cookie delete; request>headers>Authorization delete } } }`. It applies to every Caddy log line, including the error log of both sites. The output stays JSON in the journal.
- **(c2)** In the `dev-lab.tbi-tech.net` site, a redacted access line for `/oauth2/callback` only: time, status, duration, path and User-Agent, with code, state, Cookie, Authorization and Set-Cookie removed. Every other path still goes unlogged (`skip_log`).

### What G2 keeps (the PM's "safe diagnostics")

- **Timestamp and request id:** every `[AuthSuccess]`/`[AuthFailure]` line, e.g. a refused account (`unauthorized`).
- **Classification:** login starts ("Initiating login"), and token validation with email and status.
- **Callback outcome:** each callback's time, status and duration (c2). A 403 callback with no matching AuthFailure line is the missing-CSRF case, whose oauth2-proxy line (b) drops.
- **Error lines:** both sites, with method, host, path and status.

### G2 evidence (fake values)

**oauth2-proxy v7.15.4, live config file, Google provider:**

| Variant | Code / state in raw log | Session-cookie value in raw log | Cookie dumps | After (b) |
|---|---|---|---|---|
| current | yes | yes | 2 | 0 code, 0 state, 0 cookie, 0 dumps, 0 callback queries |
| G1 | yes | yes | 2 | 0 code, 0 state, 0 cookie, 0 dumps, 0 callback queries |
| G1+G2a | only in the failure dump | yes (failure dump) | 2 | **0 in every category** |

- After (b), AuthSuccess with its request id, the unauthorized AuthFailure, and the token-validation line are all kept.
- Full access token, id token and client secret: **0 in every variant, raw**.

**journald + rsyslog (systemd 259):**
- A transient unit carrying exactly these two patterns wrote fake versions of S1 and S2, an AuthSuccess line and a token-validation line.
- **The journal and `/var/log/syslog` both dropped the two secret-bearing lines and kept the other two.** journald filters before forwarding.

**Caddy 2.6.2, the exact (c) blocks:**
- An upstream down while a callback carries a fake code, state, Cookie and Bearer: the error line keeps `"/oauth2/callback?scope=email"` and status 502, with **0** code, state, cookie or bearer.
- An upstream up returning a fake Set-Cookie with 403: one access line (`"/oauth2/callback"`, 403, duration), with 0 Set-Cookie, code or state.
- Other paths: not logged.
- All lines are JSON.
- `caddy validate` passes on the full live candidate, preview imports included; `caddy fmt` is clean.

### G2 activation plan (on approval)

- Prerequisites: an idle window, then a backup of the cfg and Caddyfile; the drop-in is new.
- Steps, in order:
  1. Install the cfg (a) and the drop-in (b). Run `daemon-reload`, then restart oauth2-proxy (about 0.3 s).
  2. Check that `systemctl show oauth2-proxy -p LogFilterPatterns` lists both patterns.
  3. Run `caddy validate`, then `systemctl reload caddy` (graceful).
  4. Run `live-gate-g1.mjs g1`.
- Then check with fake callbacks (and after the owner's next sign-in) that `journalctl -u oauth2-proxy -u caddy` and `/var/log/syslog` contain **0** codes, states and cookie values since activation, counted not printed, while the AuthSuccess and Caddy callback lines are present.
- Rollback, in seconds:
  1. Restore the cfg.
  2. Remove the drop-in.
  3. `daemon-reload` and restart.
  4. Restore the Caddyfile and reload.

**Residual after G2:**
- The 403 page's own HTML is unchanged.
- A future oauth2-proxy version could add log paths, so this inventory must be re-run on any upgrade.
- `adm` readers keep read access to logs that are then clean.
