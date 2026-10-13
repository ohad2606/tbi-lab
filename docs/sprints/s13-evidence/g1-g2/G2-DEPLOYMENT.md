# G2 deployment on the DEV gate (2026-10-13)

**PM decision:** "G2 Security Remediation Authorization": GO, within the reviewed three-part scope.

**Result:**
- **G2 live since 12:08:31 UTC.**
- Rollback rehearsed live at 12:09:41 and G2 reapplied at 12:09:57. G2 has been continuously active since.
- G1 intact.
- Not touched: application `71b40fb`, runtime, firmware lock, allowlist, env file, unit file, Oracle infrastructure, historical logs, `ocarun`, retention.

## 1. Applied configuration

| File | Before (G1) | After (G1+G2) | Change |
|---|---|---|---|
| `/etc/oauth2-proxy/oauth2-proxy.cfg` (= `deploy/dev-lab/oauth2-proxy.cfg`) | `aac495428e2357db` | `1475fd922424e8fc` | (a) +4 lines: comment + `exclude_logging_paths = ["/oauth2/callback"]` (`g2/oauth2-proxy.cfg.g2a.diff`) |
| `/etc/systemd/system/oauth2-proxy.service.d/10-log-filter.conf` (= `deploy/dev-lab/g2/10-log-filter.conf`) | absent | `faa5c6aed92a7f02` | (b) `LogFilterPatterns=~&\{(GET\|POST\|HEAD)`, `LogFilterPatterns=~/oauth2/callback\?` |
| `/etc/caddy/Caddyfile` (= `deploy/dev-lab/g2/Caddyfile.g2-candidate`) | `47ce8f87048cb32d` | `fce876ab88989fc3` | (c1) global `log default` filter; (c2) callback-only redacted access log + `skip_log` (`g2/Caddyfile.g2.diff`) |

Unchanged, by hash:
- the unit `557ba4b36f6cdae0`;
- the allowlist `ad8b9f0b8c83fa7f`;
- the env file `d71e480e8f2dd403`;
- the preview snippets `3f2b7103…` and `ae0ecf34…`;
- Caddy's drop-in `acfc18ab…`.

## 2. Preconditions

- **Baseline:**
  - cfg = repo G1 file;
  - Caddyfile = reviewed live copy;
  - no oauth2-proxy drop-in;
  - systemd 259;
  - idle: last gate request 11:41 (mine), no ESP32 session.
- **Backup:** `/var/backups/tbi-lab/g2-pre-20261013T120731Z`, 7 files, each byte-equal to live, original owners and modes (`g2-backup-hashes.txt`).
- **Parsing before any restart:**
  - `s13-gate-google.runtime.test.ts`: **17/17** on the exact bytes to be installed (real v7.15.4, Google provider).
  - The installed binary was run with the full candidate cfg and the **real env file**, as user `oauth2-proxy`, with both LogFilterPatterns, in a transient unit on loopback :4189 that nothing routes to. It loaded with no error, `/ping` 200, page load 302, and systemd listed both patterns. The unit was then stopped and the candidate removed.
  - Caddy: `caddy validate` on the full candidate, preview imports included, and again on the installed file as root. The adapted JSON is identical to live apart from the logging blocks and the one `skip_log` route; the original handlers are unchanged.

## 3. Logging verification (non-secret random markers)

The tool is `tools/live-g2-markers.mjs` with `tools/count-g2-markers.sh`. Through the public gate, each run sent:
- a callback with no CSRF cookie, carrying a fake session cookie and a fake Bearer;
- a callback with a wrong CSRF cookie;
- a malformed state;
- a page load with a fake cookie and Bearer;
- a JSON request.

| Run | Secret-shaped marker values stored (journal / syslog) | Request dumps | Callback queries | Kept |
|---|---|---|---|---|
| Pre-G2 baseline (`g2-log-check-pre.txt`) | **40 / 40** | 4 | 7 | page, JSON, UA lines |
| After G2 (`g2-log-check-post.txt`) | **0 / 0** | 0 | 0 | page + JSON request-log lines, state-parse error, 3 Caddy callback audit lines (403, 403, 500) |
| During the rollback rehearsal (G2 off) | 40 / 40 (the baseline again) | — | — | — |
| After reapplying (`g2-log-check-final.txt`) | **0 / 0** | 0 | 0 | as "After G2" |

**Restart window.** 59 marker-tagged callbacks (fake cookie and Bearer) were sent during the oauth2-proxy restart. Caddy logged a real 502 in its **error** log with `"uri":"/oauth2/callback"`, no Cookie and no Authorization. 0 secret values were stored, and all 60 audit lines were kept.

**Whole host since the reapply (12:09:57):**
- journal: 146 lines; syslog: 56 lines;
- **0** code or state values, 0 cookie values, 0 Bearer values, 0 dumps.

**Still observable:**
- login starts ("Initiating login");
- "Access Denied" warnings;
- state-parse errors;
- startup lines;
- the request log of every other path (request id, path, status);
- Caddy error lines (message, method, path, status);
- one Caddy audit line per callback (time, status, duration).

The kinds that need a real sign-in, `[AuthSuccess]` and `[AuthFailure] … unauthorized` with request id, are kept in the offline run on the same bytes. The owner's next sign-in confirms them live.

## 4. Authentication and authorization

Live, anonymous with fake values (`live-G1-with-G2-final.txt`): **12/12**.
- **Login start:** one per-request CSRF cookie with the same attributes; a second concurrent login gets its own cookie.
- **Background JSON:** 401, no cookie, no redirect.
- **Fake callbacks:** 403 with no session (no CSRF cookie, a wrong one, or a fixed-name one); a malformed state gives 500.
- **Protected paths:** redirect to Google, never content.

Gate-only access:
- **Public listeners:** only Caddy on 80/443 (plus the existing sshd and rpcbind).
- **oauth2-proxy:** 127.0.0.1:4180 only.
- **Backends:** unix sockets, group `tbi-gate`.
- **Without a session:** `/`, `/runtime/health`, `/build/v1/health` and `/assets/*` give 401 (JSON) or 302 to sign-in (HTML).
- **HTTP:** 308 to HTTPS.

Offline, the exact installed bytes (17/17):
- two tabs 302/302;
- replay 403 with the code redeemed once;
- missing, tampered, foreign or other-browser CSRF: 403 ×4;
- expired session: 401, then one clean login;
- non-allowlisted account: 403, no session.

## 5. Rollback (rehearsed live)

`tools/rollback-g2.sh /var/backups/tbi-lab/g2-pre-20261013T120731Z` took **0.8 s** (`g2-rollback-rehearsal.txt`). Afterwards:
- the cfg and Caddyfile were byte-equal to the backup (`aac49542…`, `47ce8f87…`);
- the drop-in was gone and LogFilterPatterns empty;
- both services were active;
- G1 checks passed (12/12);
- logging was back to the exact pre-G2 behaviour.

Reapplying took 1.15 s and gave the same hashes as the first apply.
