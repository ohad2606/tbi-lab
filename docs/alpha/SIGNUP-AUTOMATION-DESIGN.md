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
| Replay of a captured request | timestamp must be within 5 minutes either side; nonce (16-64 chars) is remembered for the window, bounded cache (full = refuse, never evict); a bad signature never consumes a nonce |
| Resource exhaustion | body cap 4 KiB (header and stream); per-source sliding-window limit (3/min default in tests, configurable) and a global limit, both checked BEFORE verification; bounded key tables; store capped (`maxRecords`) |
| Spoofed client address behind the proxy | source key = the LAST hop of the header the trusted proxy appends, never the first (client-controlled) entry |
| Spam / fake sign-ups with a valid signature (secret leak, or a spammed form) | nothing is approved automatically; strict allow-listed validation; duplicate address (non-rejected) is answered 202 but stored and notified once; owner decides |
| Injection (log, mail, shell, path) | text fields NFC-normalised, control/format/bidi characters removed, length-bounded; email via the account path's strict address rule; ids are fixed-format and never from the request; plain-text mail only; Telegram message has no parse mode |
| Email abuse (the endpoint making us mail arbitrary people) | mail is sent only on the owner's Approve, never from the public endpoint; one send per request; idempotency key to the provider |
| Double approval / double email | per-id serialisation, state persisted before each side effect, `emailAttemptedAt` set before sending so a crash mid-send never causes an automatic second mail; resend is an explicit owner action and only from `email_failed` or an interrupted send |
| Secret disclosure through errors | Telegram URL carries the token by design: errors are mapped to a class (`network`, `http_<n>`), never the URL or body; logs contain no addresses |
| Stored personal data | see 4 |
| Someone reads the store | dir 0700, files 0600, atomic write; a dir readable by others is refused at start (explicit failure, no repair) |
| CSRF on the admin routes | existing rule (JSON content type, same-origin, write rate limit), owner only |

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
shared by the intake (create) and the admin service (update); a single-writer-per-file discipline is kept by
creating with a fresh id and updating only from the admin service.

## 6. Approval email

Plain text, HE and EN, chosen by the sign-up language: the lab link (`<LAB_URL>`, from config), sign in with the
same Google account, desktop Chrome or Edge, the alpha has limited places, reply to the email for feedback. Signed
by the team, no personal name. `from` and reply-to are `<SUPPORT_ADDRESS>` from config. The wording in
`email.ts` is a draft of the owner-approved mail and must be compared with the approved text before enabling.

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
rate limits, validation, store with permissions/atomicity/retention, Telegram and Resend adapters, HE/EN templates,
the approve/reject/resend workflow with idempotency, the intake HTTP handler, owner routes in the admin service.

Remaining (not in this slice): the intake process entry (`main`) and systemd unit, wiring the approver and the
purge schedule into the admin service's `main.ts`, the admin UI (HE + EN, WCAG 2.2 AA), the form script, the owner
runbook, the deploy plan, an end-to-end test with a fake helper.
