# Sign-up data: deleting one person, and the funnel counters (K12 slice 1)

**Status: code and tests only. Nothing here is deployed or switched on.** The delete route exists in
the admin service whenever the sign-up routes are enabled (`TBI_SIGNUP_ADMIN=1`); the funnel counters
are off unless `TBI_FUNNEL_COUNTERS=1`. Any change on Alpha needs the owner (see the charter).

Placeholders: `<ALPHA_HOST>` is the lab's address, `<id>` a sign-up request id (26 characters,
for example `01JD...`). No real address, host or count belongs in this public file.

## 1. When a person asks to be deleted

Do the steps in order. Steps 1–3 are in the admin app; steps 4–6 are manual.

### Step 1 – find the request by email address

1. Sign in to the TBI Admin app (`https://<ALPHA_HOST>`) as the owner, in Chrome or Edge on a
   computer, and open **Sign-up requests**.
2. At the bottom, under **Stored requests and deletion**, press **Show all stored requests**. The
   list holds every request the store still has, in any status. (The list above it holds only the
   requests that still need you.)
3. Type the address, or part of it, in **Filter by email**. The filter runs in the browser only:
   nothing typed is sent to the server or saved. Note the request ID (`<id>`), the status and
   whether the row is marked **Account added**.

If no request matches, it was already removed by retention (not approved: 90 days; every request:
at most 365 days; with email verification and `TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS` set, an
unconfirmed web request after that many days) or never reached the store. Continue with step 4
anyway. If the screen says sign-up requests are not available, the sign-up routes are off or
unreachable: nothing was checked, so do not report the person as deleted.

### Step 2 – delete the request now

Press **Delete** on that request's row. A confirmation opens with Cancel selected; check the ID
and the masked address, then press **Delete request**. One request is deleted at a time (if the
address has several, repeat for each). After every answer the list is loaded again from the server,
and the screen says what happened, naming the request ID only.

| Answer (what the screen says) | Meaning |
|---|---|
| 200 `{"deleted":true}` ("deleted") | Gone: the record, its notification, web, confirm and resend markers, the address marker, any leftover temporary file and, while email verification is on, the admin's verify state for it (see section 2). Before anything was removed the audit log got `<time> <id> delete started`, and only after every step `<time> <id> delete ok` (no personal data). "deleted" is never shown without that `ok` line. |
| 200 `{"deleted":true,"note":"already_deleted"}` ("already gone") | It was deleted before (the audit log says so). Nothing changed. |
| 404 `not_found` ("already gone") | No such request (wrong id, or retention already removed it). |
| 403 ("not deleted") | Not the owner, or the request was not same-origin JSON (reload the admin app and try again). |
| 429 ("too many requests") | The write limit; wait the time shown, then try again. |
| 500 `delete_incomplete` ("did not finish") | A file, the verify state or an audit line could not be removed or written (EPERM, an unreadable address marker, a full disk, ...). No `delete ok` is written; the audit log has `<time> <id> delete started` (if it took the line) and `<time> <id> delete incomplete`, and the server log `signup: delete incomplete stage=<step> (<class>)`, where `<step>` is one of `history`, `side`, `web`, `record`, `verify`, `audit` (it never names the id, the address or a file). If `started` could not be written, nothing was removed. The record may be kept, or already removed with only cleanup left. Refresh the list: if the request is still there, try again. If it is not, ask the operator to check the server log and the store directory permissions; deleting the same id again finishes the cleanup (a `started` line without a later `ok` keeps the delete open, so the retry never says "already gone"). If it repeats, the operator also checks that `audit.log` is a readable, writable regular file: while it cannot be read, a request that is still in the list is deleted as usual (only if its lines can be written), but a request that is no longer there answers this (also an unknown id), nothing is removed, and the `delete incomplete` audit line may be missing. |
| no answer ("the server did not answer") | Unknown whether it was deleted. Check the reloaded list (Refresh requests) and try again if the row is still there. |

The service answers the same 404 `not_found` when the sign-up routes have been switched off, so
after "already gone" check the reloaded list: if it says the requests are not available, nothing was
checked. Any other 404 is reported as "service not available".

A sign-up that arrives while a delete runs can leave an empty marker named after the request ID
(`<id>.rq`, `<id>.vq-<hex>`, `<id>.notified` or `<id>.notifyq`, never after the address): the
retention sweep removes only the `.rq` and `.vq-` ones, and deleting the same ID again removes all
four.

**If auto-approve is on**, check Testers after deleting any pending request: it may have been
approved just before the deletion.

Deleting the request does **not** remove an account that was already added. Step 3 does that.

**An account add may still be in progress.** If the request was approved but not marked **Account
added** (or Approve answered that the account is not ready yet), the account may still be created
after the request is deleted. The confirmation warns about this. After a few minutes, open the
Testers screen, look for the account and **Disable** it if it appears (step 3).

### Step 3 – the account, if one was added (`accountAdded: true`)

In the TBI Admin app, Testers screen (the confirmation of step 2 links to it): find the tester (the list shows masked addresses, e.g.
`da***@example.com`, and the display name) and **Disable** it. That revokes access at once.

Disable does not erase the address: the root helper's tester registry keeps the record (revoked),
and the access view keeps a keyed tag of the address. Erasing the registry record is an
operator action with the helper's registry tool on Alpha (outside this repository); it is an Alpha
change and needs the owner in an interactive session. Record the date of the request and of each
step for the reply to the person.

### Step 4 – the approval email queue (only if the separate mailer is deployed)

If the mailer service (`docs/alpha/MAILER-DESIGN.md`) is running, a queue entry
`signup-approval-<id>-g<n>.json` holds the address and name until it is sent, and its ledger keeps the
outcome. A sent entry is removed by the mailer. If an entry for `<id>` is still in the queue, the
operator removes it (Alpha change, owner). While the mailer is not deployed, the admin service sends
directly and keeps no queue.

### Step 5 – the Telegram alert (manual)

The owner alert for a new request carries the person's **name and role** (never the address). Delete
that message in the owner's Telegram chat by hand. With `TBI_SIGNUP_NOTIFY=summary` on the intake there
are no per-request alerts (the summary and alerts hold counts only); older alerts may still be there.

### Step 6 – the Google Form and its spreadsheet (manual)

The form's responses and the linked spreadsheet hold the full answers (name, address, role,
"how did you hear about us", consent). Delete the person's response in the form (Responses tab) and
the row in the response sheet. The sheet tab "TBI send status" holds only the row number and send
status for that row; delete that row too. Do not delete or sort response rows while that tab shows
`retry` for any row (the forwarder would resend the wrong row; see the header of
`deploy/signup/apps-script/Code.gs`).

## 2. Every place sign-up personal data lives

| Place | What | Removed by |
|---|---|---|
| Pending store (`TBI_SIGNUP_DIR`): `<id>.json` | name, address, role, language, consent, status | the screen's Delete (`DELETE /signups/<id>`, step 2), or retention (90 days not approved / 365 days at most) |
| Pending store: `<sha256 of address>.mark` | a hash of the address (de-duplication) | step 2 (the marker pointing to that id), retention purge |
| Pending store: `<id>.notified`, `<id>.notifyq`, `audit.log` | no personal data (id, action, outcome) | step 2 removes the markers; the audit log is kept |
| Pending store: `<id>.web`, `<id>.vq-<hex>`, `<id>.rq` | empty markers (web origin, button pressed, new link asked) | step 2; the admin sweep; retention purge |
| Account spool (`<TBI_ADMIN_DIR>/spool`, results) | the address while an `add` request waits for the helper | the helper deletes the request once processed; results hold a masked address only |
| Tester registry and access view (root helper) | the account (address, display name, sign-in times), a keyed tag of the address | step 3 (disable); erasure is an operator action (owner) |
| Mail queue and ledger (mailer, when deployed) | address and name of a queued approval email | sent entries are removed; a waiting one by the operator (step 4) |
| Admin state, email verification: `<STATE_DIR>/verify/<id>.json` | token hashes, address hashes, times | removed with the request (step 2 or retention) while verification is on. **With verification switched off it stays** until it is on again or an operator removes it |
| Admin state, email verification: `<STATE_DIR>/verify/mail-counters.json` | address hash and time of each confirmation mail | **not removed by step 2.** Counted for 7 days, then removed at the next confirmation mail or hourly unconfirmed purge; if neither runs, it stays until an operator removes it |
| Mail provider | the confirmation and approval emails that were sent (provider's own retention) | the provider's console, manual |
| Telegram chat | name and role in the new-request alert (not in summary mode) | step 5, manual |
| Google Form + response spreadsheet | every answer | step 6, manual |
| Backups (host and helper backups) | copies of the above | **rotate out on their own schedule; never edited.** A deleted record disappears from backups when the last backup holding it expires. After a restore, see "After restoring a backup" below. |

**After restoring a backup** of the pending store, a request deleted after that backup was taken
comes back. Before the admin app is used again, look in the store's `audit.log` for every id that has a
`delete ok` line and is in the store again, and delete each of those once more
with step 2 (it answers "deleted" again; the restored record is a real record). The backup itself is
never altered, and there is no automation for this: it is a manual step after every restore.

**After a deploy of the admin service or the admin app,** reload every open TBI Admin tab before
acting on a sign-up. A tab loaded before the deploy may not know a new answer of the service and
then says that the request "changed in a way this page does not know".

Funnel counters (section 3) hold no personal data and need no step.

## 3. Funnel counters (`runtime/admin/funnel/counters.ts`)

**The numbers are indicative.** They exist to see roughly how many sign-ups were submitted and
approved per day. Never use them for billing, credits, usage limits, quotas or any decision about a
person: a write can fail (the count is then kept in memory and retried, and lost if the process stops
first), a day is capped at 10 000 per event, and duplicates of an address are not counted. Writes
start at least 5 seconds apart (a stop by SIGTERM / SIGINT writes at once); a crash or a forced kill
loses the counts not yet written, at most that window while writes succeed. Once a service has seen an
event at the cap, further ones that day are refused without writing.

- Stored: per UTC day and event, one integer. Events (fixed allow-list): `landing_view`,
  `signup_form_view`, `signup_submitted`, `signup_approved`, `first_session`. Three are counted
  (`landing_view` and `first_session` are not, so their zeros mean "not counted"):
  - `signup_form_view` (the intake, web route only): **form tokens issued**, one per successful
    `GET /signup/form-token`; refused requests are not counted. The page fetches a token when it
    loads (so again after a reload), on focus or submit when it has none still fresh (the fetch
    failed, the token is close to expiry, or it was discarded; there is no timer) and after a 401.
    A refused submit that discards the token (a 400 other than `too_fast`, 403, 500 and other
    statuses except 429 and 503, a second 401) moves focus to the error summary inside the form,
    so a new token is fetched at once. It is **not** a
    number of people or visits, and dividing sign-ups by it does not give a conversion rate. A bot
    can raise it to the daily cap (10 000) while staying within the per-source token limit; accepted
    for an indicative number (nothing is stored per source).
  - `signup_submitted` (the intake, once per new request; duplicates and refusals are not counted).
  - `signup_approved` (the admin service, once per request, when its account is added).
- Never stored or logged: IP address, user agent, referrer, URL, address, name, cookie, request id,
  client id. The intake sets no cookie.
- One file `funnel-counters.json` (0600) in a private directory (0700); a directory that group or
  others can access is refused (the counters stay off, one log line, the service runs). Atomic
  writes; days older than 400 are pruned; an unreadable file is renamed aside
  (`funnel-counters.json.corrupt-<ms>`) and logged, never silently reset.
- Settings, per service: `TBI_FUNNEL_COUNTERS=1` and `TBI_FUNNEL_DIR` (absolute). Give the intake and
  the admin service each its own directory (one file each). The sign-up store needs both services to
  run as the **same user** today, so directory modes do not separate them: the intake's sandbox must
  (`SIGNUP-AUTO-APPROVE-RUNBOOK.md`, precondition 5). Off by default; a bad setting turns only the
  counters off, never the sign-up.
- There is no HTTP endpoint. `FunnelCounters.snapshot()` returns `{v:1, days:{<day>:{<event>:n}}}`
  for an operator or a later owner view.
- Enabling the counters on Alpha is a production change: it needs the owner's approval.

### Reading the counters (`scripts/funnel-report.mjs`)

Run as a user that may read the directories (they are private). Give each service's directory once:

```sh
sudo node scripts/funnel-report.mjs --dir /path/to/intake-funnel-dir --dir /path/to/admin-funnel-dir
sudo node scripts/funnel-report.mjs --dir /path/to/funnel-dir --csv
```

- Read-only: it writes nothing, ignores the lock file, and renames, repairs or prunes nothing.
- Output: per UTC day, one row per directory that has the day (`dir` = position of its `--dir`,
  from 1) and a `total` row; one column per event, plus `unknown`: the sum of event names this copy
  of the script does not know (a newer writer; the names are not printed).
- A directory without a counters file counts as empty (warning on stderr).
- Exit 0: report. Exit 1: an input is invalid or unreadable; nothing is printed on stdout, and
  stderr gives one reason code per bad directory (`dir_unreadable`, `dir_symlink`,
  `dir_not_directory`, `file_symlink`, `file_not_regular`, `file_too_large` (over 1 MiB),
  `file_unreadable`, `file_invalid`). Exit 2: usage (`--dir` must be absolute, without `..`, and
  not repeat a directory).
