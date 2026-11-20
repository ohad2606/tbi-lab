# Sign-up automation (TBI-022): design note

Status: design plus a tested, **disabled-by-default** code slice (`runtime/admin/signup/`). Nothing here is
deployed. Private details (hosts, paths, proxy configuration, accounts) are kept out of this public repository
and appear below only as placeholders such as `<ALPHA_HOST>`, `<SUPPORT_ADDRESS>`, `<LAB_URL>`.

## 1. Goal and flow

Today a new sign-up is only visible by opening the form's responses, and the owner copies the details into the
admin page and writes the email by hand. The owner keeps the decision (no auto-approve); everything else is automated.

1. The existing form stays. A form-response script (outside this repo's runtime) POSTs each response, signed, to
   `POST <ALPHA_HOST>/signup`.
2. The intake stores a PENDING request and sends the owner a Telegram message: name, role, link to the admin page
   (never the email address).
3. The admin app lists pending requests (separate slice) with Approve / Reject / Resend.
4. Approve = the **existing account-add path** (admin service -> spool -> root helper), then the approval email
   through the Resend HTTP API from `<SUPPORT_ADDRESS>`, Hebrew or English by the sign-up language.
   Reject sends nothing.

## 2. Where it lives (extending the existing architecture)

`docs/alpha/ADMIN-AND-FEEDBACK.md` (Sprint 23C) fixes a rule this design keeps: the **admin service
(`runtime/admin`, user `tbi-admin`) is the only writer of the helper's spool**, it is reachable only by the owner
behind the gate, and the Session Host never writes a request the helper accepts. Two consequences:

- The **owner side** (list, approve, reject, resend) is added to the admin service as routes under
  `/admin-api/signups...`, next to `/accounts`. They inherit the gate identity, owner check, CSRF rule and per-caller
  rate limits. `AccountsDeps.signups` is absent by default: the routes then do not exist (404).
  Approve calls the account path through the `AccountAdder` interface (`spoolAccountAdder` wraps the existing
  `AdminSpool.submit/wait`), so no second way to add an account exists.
- The **public side** (the signed POST) must NOT live in the admin service (that one trusts the gate's identity and
  has the spool). It is a separate small process, `tbi-signup` (own user, own unix socket, own unit), that can
  only create pending files. It has no spool, no helper access, no Resend key.

Both sides share one pure library (`runtime/admin/signup/`): `hmac.ts`, `limits.ts`, `validate.ts`, `store.ts`,
`notify.ts`, `email.ts`, `service.ts`, `http.ts`. Every I/O (clock, fetch, secret readers, spool) is injected;
tests use fakes only.

### Who holds which secret

| Secret / capability | Process | Why there |
|---|---|---|
| HMAC shared secret (file, root-owned, group-readable by `tbi-signup` only) | intake process | only the process that verifies needs it |
| Telegram bot token (file) | intake process | it sends the notification |
| Resend API key (file, sending-only key) | admin service (the approver) | the only component that sends the email; the intake cannot send mail |
| Spool write | admin service | unchanged (D1) |
| Pending store | intake: create only; admin service: read and update | see 4 |

The Session Host and the builder get none of these. Secrets are never in environment variables, logs, error
messages, URLs we log, or the repo; only file paths are configured. The owner installs each secret himself (the
runbook, a later slice, gives stdin-based commands).

## 3. Threat model

Assets: the allowlist (who may use the lab), the owner's attention, sign-up personal data, the support address
reputation, the secrets above.

| Threat | Control |
|---|---|
| Anyone on the internet can POST | HMAC-SHA256 over `v1\n<timestamp>\n<nonce>\n<raw body>`; hex signature compared with `timingSafeEqual`; one generic 401 for every authentication failure (reason only in the log) |
| Replay of a captured request | timestamp must be within 5 minutes either side; nonce (16-64 chars) is remembered for a TTL derived inside `NonceCache` as 2 x the replay window (not configurable; verification refuses a window longer than the cache's), bounded cache (full = refuse, never evict); a bad signature never consumes a nonce |
| Resource exhaustion | body cap 4 KiB (header and stream); per-source sliding-window limit (checked BEFORE verification) and a global limit taken only AFTER the HMAC verifies, so unsigned junk from many sources cannot spend it (accepted DoS: a holder of the secret, or a flood from many sources that each stays under the source limit, still costs one HMAC per request; the proxy rate limit and request timeouts bound that; a global 429 consumes the nonce, so the sender retries with a fresh nonce); bounded key tables; store capped (`maxRecords`) |
| Spoofed client address behind the proxy | source key = the LAST hop of the header the trusted proxy appends, never the first (client-controlled) entry |
| Spam / fake sign-ups with a valid signature (secret leak, or a spammed form) | nothing is approved automatically; strict allow-listed validation; duplicate address (non-rejected) is answered 202 but stored and notified once (atomic: in-process mutex plus an `<sha256(email)>.mark` file created with O_EXCL that holds the record id; no per-request scan of all files); owner decides |
| Injection (log, mail, shell, path) | text fields NFC-normalised, control/format/bidi characters removed, length-bounded; email via the account path's strict address rule; ids are fixed-format and never from the request; plain-text mail only; Telegram message has no parse mode |
| Email abuse (the endpoint making us mail arbitrary people) | mail is sent only on the owner's Approve, never from the public endpoint; one send per request; idempotency key to the provider |
| Double approval / double email | per-id serialisation, state persisted before each side effect, `emailAttemptedAt` set before sending so a crash mid-send never causes an automatic second mail; resend is an explicit owner action and only from `email_failed` or an interrupted send |
| Secret disclosure through errors | Telegram URL carries the token by design: errors are mapped to a class (`network`, `http_<n>`), never the URL or body; logs contain no addresses |
| Stored personal data | see 4 |
| Someone reads the store | dir 0700, files 0600, atomic write; a dir readable by others is refused at start (explicit failure, no repair) |
| CSRF on the admin routes | existing rule (JSON content type, same-origin, write rate limit), owner only |

Operational rules added by the security review:

- **Nonce TTL rule:** TTL >= 2 x window (enforced in code). The cache is in memory: a restart of the intake
  reopens replay of any captured request still inside the 5-minute window, for at most that window (up to 10
  minutes of timestamp validity either side is not reachable: the timestamp check still rejects older requests).
  Accepted; the effect of a replay is a duplicate request, which the dedupe marker absorbs.
- **Store directory shared between users:** the intake user owns the 0700 directory; the admin service user must
  reach it through a shared group (dir 0770 is refused by the start check, which demands no group/other access), so
  deploy review must choose: run both processes as one user, or a second directory with the admin service pulling
  by a root-owned helper. Until decided the start check stays strict (no repair).
- **Secret rotation:** replace the HMAC file and the form script property together, restart the intake; requests
  signed with the old secret get 401 until the script is updated (a short outage is acceptable). The nonce cache
  is emptied by the restart. Same for the Telegram token and the Resend key (read at use, no restart).
- **Audit log:** `audit.log` in the store directory (0600, append-only): `<time> <id> <approve|reject|resend>
  <outcome class>`. No name, address or role. Not purged by the retention job; rotate with the host's log rotation.
- **Store full:** `create` refuses at `maxRecords`; the intake answers 503 and logs `store failed (full)`. The owner
  must be told: the monitoring slice alerts on that log line (and on a rising 503 count); the form script retries later.
- **Proxy header assertion:** at start the intake process must refuse to serve if the source header is not
  configured explicitly or the proxy cannot be shown to set it (a startup self-check request in the deploy plan);
  falling back to the socket address behind a proxy would put every client in one rate bucket.
- **Server timeouts:** the intake `main` must set `server.requestTimeout`, `headersTimeout` (<= 10 s),
  `keepAliveTimeout` and a small `maxConnections`, so slow-body clients cannot hold sockets (the body cap bounds
  size, not time).
- **Error classes:** secret-read and fs failures surface as class codes only (`secret_missing`,
  `secret_unreadable`, `secret_short`, `fs_error`); `lastError` and logs never contain a path, URL or address.
- **Approve after a failed email** answers 409 `email_failed_use_resend` (never a success); the owner presses Resend.

Not mitigated here (accepted / owner decision): a leaked HMAC secret lets an attacker create pending requests
(bounded by the limits, and the owner still must approve); Telegram notification may be dropped (the request is
still stored and shown in the admin list); the form itself can be spammed independently of us.

## 4. Personal data and retention

Stored per request: name, email, role, language, consent flag, timestamps, status, error class. Minimisation:
the Telegram message has name and role only; the intake log has no personal data; the approval email is the only
use of the address besides the allowlist add.

Retention (`purge`, run on start and daily by the admin service when enabled; defaults, owner to confirm):
rejected 30 days, never-decided 60 days, finished (`email_sent`) 90 days after the last update (the account then
lives only in the helper's registry). `approved` and `email_failed` are never deleted automatically (they need the
owner). Orphaned temp files older than 1 hour are removed. Whether the sign-up form itself keeps the data is a
separate point. Legal review of this flow (processors: the form provider, the mail provider, the messaging
provider; consent wording; retention) is needed and is tracked outside this repository.

Statuses: `pending`, `approved` (account step started or done, mail not yet sent), `rejected`, `email_sent`,
`email_failed`.

## 5. Endpoint contract

`POST /signup`, `content-type: application/json`, body (all fields required, nothing else allowed):
`{"name","email","role","lang":"he"|"en","consent":true}`. Headers: `x-tbi-timestamp` (unix seconds),
`x-tbi-nonce`, `x-tbi-signature` (hex). Answers: 202 `{ok:true}` (also for a duplicate), 400 invalid, 401
unauthorized, 413, 415, 405, 429 (+`retry-after`), 503. Nothing from the request is echoed. The same store is
shared by the intake and the admin service. Single-writer per file: the record file (`<id>.json`) is written by
the intake once at creation (exclusive) and afterwards only by the admin service. The intake's only later write is
the separate `<id>.notified` marker (the `notified` flag is derived from it on read), so it can never overwrite an
owner update. The address marker is written by the intake only.

## 6. Approval email

Plain text, HE and EN, chosen by the sign-up language. Hebrew is the owner-approved text of 2026-11-20, verbatim;
English is a translation (pending owner OK). Greeting by the first name; a paragraph about signing in with a
non-Google address appears only when the address is not `@gmail.com`; sign-off "צוות TBI Lab" / "The TBI Lab
team" (pending owner confirmation). The lab link (`<LAB_URL>`) and the sender / reply-to (`<SUPPORT_ADDRESS>`)
come from config. Never sent twice: the attempt is persisted before sending, approve never re-sends, and the mail
provider is given an idempotency key per request.

### 6.1 Owner API (admin service, behind the gate and the owner check; paths as the admin service sees them)

Enabled only with `TBI_SIGNUP_ADMIN=1` (+ settings below); otherwise every route below is 404. All answers are
JSON, `no-store`. Mutations need `content-type: application/json`, a same-origin request (CSRF), an empty body
`{}`, and are rate limited like the other admin writes. Non-owner: 403; no identity: 401.

| Route | Answer |
|---|---|
| `GET /signups` | 200 `{signups: Record[]}` all statuses |
| `GET /signups/pending` | 200 `{signups: Record[]}` only `status: "pending"` (the admin UI list) |
| `POST /signups/<id>/approve` | 200 `{record, note?}` (`note`: `already_done` or `email_not_resent`); 202 `account_pending` (helper has not answered yet; retry); 409 `bad_state` / `email_failed_use_resend`; 502 `cap_reached` / `account_error` / `email_failed`; 404 |
| `POST /signups/<id>/reject` | 200 `{record}`; sends nothing; 409 if already approved |
| `POST /signups/<id>/resend` | 200 only after a failed or interrupted send for an added account; 409 otherwise |

Error answers: `{error: <code>, record?}`. `Record`: `id, name, email, role, lang, status, accountAdded,
emailAttempts, emailAttemptedAt, lastError, notified, createdAt, updatedAt`. Approve adds the account through the
existing spool and root helper (the owner's principal is the actor), then sends the mail. One operation per id at a
time, also across requests. The routes sit under the gate's admin prefix (`/admin-api/...`) in deployment.

Admin service settings (all required when enabled; missing means the service refuses to start): `TBI_SIGNUP_ADMIN=1`,
`TBI_SIGNUP_DIR`, `TBI_SIGNUP_RESEND_KEY_FILE`, `TBI_SIGNUP_FROM`, `TBI_SIGNUP_LAB_URL` (https), optional
`TBI_SIGNUP_REPLY_TO`. When enabled the retention purge runs at start and every 24 h (rejected 30 d, pending 60 d,
sent 90 d).

### 6.2 Intake process (`runtime/admin/signup/intake-main.ts`)

Off unless `TBI_SIGNUP_INTAKE=1` (exit 0, one log line). With the flag set, a missing setting, a missing or short
HMAC secret, a missing Telegram token or an unsafe store directory is a refusal to start (exit 1, class code only).
Settings: `TBI_SIGNUP_DIR`, `TBI_SIGNUP_HMAC_FILE`, `TBI_SIGNUP_TELEGRAM_TOKEN_FILE`, `TBI_SIGNUP_TELEGRAM_CHAT_ID`,
`TBI_SIGNUP_ADMIN_LINK` (https), `TBI_SIGNUP_LISTEN` (loopback only, default `127.0.0.1:7411`),
`TBI_SIGNUP_SOURCE_HEADER`. Secrets are read from files, never from the environment, and never logged. Serves
`POST /signup` only; SIGTERM / SIGINT close the listener.

## 7. What the owner must change on Alpha (private details later, in the private ops repo)

Nothing below has been done. All of it is an Alpha change and needs the owner in an interactive session.

1. Proxy: route `POST <ALPHA_HOST>/signup` to the intake socket only (no gate login for this path, since the form
   script cannot sign in); set the client-address header from the real peer address (overwrite, not append from the
   client); apply a request-size limit and a rate limit at the proxy as well; do not log request bodies.
2. New systemd unit `tbi-signup` (own user and group, own socket directory, `ProtectSystem=strict`,
   `NoNewPrivileges`, `PrivateTmp`, no network except outbound to the messaging provider, writable only the pending
   store, no access to the spool, results, view or artifact paths).
3. Pending store directory (0700, owned by the intake user) and read/update access for the admin service user
   (a shared group or a second directory; to be decided at deploy review).
4. Secret files: HMAC secret (intake group-readable), Telegram bot token (intake), Resend sending-only key (admin
   service). Created by the owner; never through an agent.
5. Admin service unit: add the store path, the Resend key path, the sender/reply address and lab URL configuration
   (outbound HTTPS to the mail provider only), enable `signups`. Add a daily purge timer or in-process schedule.
6. Mail provider: the sending domain is already verified; create a sending-only key.
7. Form script: sets the shared secret in the script properties, signs and posts on submit (separate slice).
8. Rollback: stop the unit and remove the proxy route; the admin routes are inert without configuration.

## 8. Open questions for the owner

- Final approval-mail wording (the draft must match the approved text) and whether Reject should optionally send a mail.
- Retention periods (defaults above).
- Whether the form's timezone/ordering matters for "limited places" wording; whether the cap check should refuse
  at submit time or only at approval (currently only at approval: the account helper enforces the cap, the request
  returns to pending with `cap_reached`).
- Telegram: one chat for the owner only (assumed).
- Duplicate policy: same address while pending/approved is ignored silently; a rejected one may re-apply.

## 9. Code status and what remains

Done and unit-tested (fakes only; no network, no real secret): HMAC with replay window and nonce cache, size and
rate limits, validation, store with permissions/atomicity/retention, Telegram and Resend adapters, the approved
HE/EN mail, the approve/reject/resend workflow with idempotency, the intake HTTP handler and process entry
(loopback, fail closed), the owner routes and their wiring plus the purge schedule in the admin service's `main.ts`
(off by default), an end-to-end test with a fake helper.

Remaining (not in this slice): systemd unit for the intake, the admin UI (HE + EN, WCAG 2.2 AA), the form script, the
owner runbook, the deploy plan. Open: owner OK of the English text and the sign-off line.
