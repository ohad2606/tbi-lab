# Sprint 13 security gate: G1 applied, G2 investigated (2026-10-13)

PM decision: "Sprint 13 Security Gate Decision". G1 GO. G2 is P0, with approval needed for config outside G1.

Full proposal and evidence tables: `docs/ops/GATE-CHANGE-G1-G2.md`.

## Files here

| File | What |
|---|---|
| `live-pre-G1.txt` | Live anonymous checks before the change (12/12, pre-G1 behaviour) |
| `live-G1.txt` | The same checks after G1 (12/12) |
| `live-rollback-rehearsal.txt` | After restoring the backup live (12/12, pre-G1 behaviour) |
| `live-G1-after-rehearsal.txt` | After reapplying G1 (12/12) |
| `s13-gate-google.json` | Offline matrix: the real v7.15.4 with the live config file and the Google provider (17/17), log-leak counts per variant |
| `tools/live-gate-g1.mjs` | The live check (statuses, cookie names and attributes only; fake callback values) |

## Live state after this work

- oauth2-proxy: cfg sha256 `aac495428e2357db…` (G1), active, restarted 3× in the window (apply, rollback rehearsal, re-apply), each about 0.26 s.
- Caddy, unit files, allowlist, env file: **unchanged**.
- No G2 part is installed.
- Application: `71b40fb`, unchanged.

## Logs written since the change (counted, never printed)

- 158 lines in the journal for oauth2-proxy and Caddy, 11:39–11:45.
- **0** real code; **0** real cookie value. The only `state=` matches are the literal `state=%s)` (v7.15.4 prints its format string) and base64 of "FAKE…".
- The same holds in `/var/log/syslog`.
- No real sign-in happened since the change. Until G2, the owner's next sign-in **will** write its code and state to the request log (S1), as before.

## Historical exposure (no entry deleted or modified)

| Material | Where | Still valid? |
|---|---|---|
| OAuth codes (82 logins) | journal, syslog | **No.** Single use, all redeemed or expired (Google: minutes). Redeeming one also needs the client secret, which appears in no log |
| States / nonces | journal, syslog | **No.** Bound to CSRF cookies of 15 min |
| Session cookies (12 dumps, latest 2026-10-05) | journal, syslog (12 lines over the rotations) | **No.** oauth2-proxy rejects a session cookie whose signed timestamp is older than `cookie_expire` (8 h); there is no refresh token (`access_type: online`), so nothing extends it. Encrypted with the cookie secret, which appears in no log |
| Google access tokens | — | **Never logged.** Only the 5-character prefix |
| Client secret, cookie secret | — | **0 occurrences** in the journal, syslog, auth.log (all rotations) |
| Email, Google user id, client id | auth and token-validation lines | Identifiers, not credentials (personal data of the owner) |

**Who can read:**
- `root`;
- group `adm`: `ubuntu` (the operator; already root via sudo), `syslog` (the rsyslog daemon), and `ocarun` (Oracle Cloud Agent "Run Command", usable from the OCI console by tenancy IAM principals with that permission).

**Who did read:**
- Logins: only `ubuntu` (7 in wtmp).
- Run Command: no executions recorded.
- OCI log shipping: not installed (package 404), no fluentd process.

**No evidence of unauthorized exposure.**

**Retention:**
- The journal has **no time limit**, only the default size cap (179 MB now). Its oldest entry is 2026-09-20.
- `/var/log/syslog` rotates weekly with 4 kept; its oldest copy is from 2026-09-27.

**Recommendation:**
- **No session revocation and no secret rotation is warranted:** every logged value is expired or single-use, and no secret was logged.
- Optional hardening for the owner to decide separately:
  - a journald `MaxRetentionSec`;
  - removing `ocarun` from `adm`, if Run Command is not used;
  - once G2 is active, deciding whether the pre-G2 entries should age out.
- No deletion now.
