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
at most 365 days) or never reached the store. Continue with step 4 anyway. If the screen says
sign-up requests are not available, the sign-up routes are off or unreachable: nothing was
checked, so do not report the person as deleted.

### Step 2 – delete the request now

Press **Delete** on that request's row. A confirmation opens with Cancel selected; check the ID
and the masked address, then press **Delete request**. One request is deleted at a time (if the
address has several, repeat for each). After every answer the list is loaded again from the server,
and the screen says what happened, naming the request ID only.

| Answer (what the screen says) | Meaning |
|---|---|
| 200 `{"deleted":true}` ("deleted") | Gone: the record, its notification markers, the address marker and any leftover temporary file. One audit line `<time> <id> delete ok` was written (no personal data). |
| 200 `{"deleted":true,"note":"already_deleted"}` ("already gone") | It was deleted before (the audit log says so). Nothing changed. |
| 404 `not_found` ("already gone") | No such request (wrong id, or retention already removed it). |
| 403 ("not deleted") | Not the owner, or the request was not same-origin JSON (reload the admin app and try again). |
| 429 ("too many requests") | The write limit; wait the time shown, then try again. |
| 500 ("did not finish; the record is kept") | A file could not be removed (the record is kept so a retry can finish; the log has the error class only). Try again; if it repeats, the operator checks the store directory permissions. |
| no answer ("the server did not answer") | Unknown whether it was deleted. Check the reloaded list (Refresh requests) and try again if the row is still there. |

The service answers the same 404 `not_found` when the sign-up routes have been switched off, so
after "already gone" check the reloaded list: if it says the requests are not available, nothing was
checked. Any other 404 is reported as "service not available".

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
that message in the owner's Telegram chat by hand.

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
| Account spool (`<TBI_ADMIN_DIR>/spool`, results) | the address while an `add` request waits for the helper | the helper deletes the request once processed; results hold a masked address only |
| Tester registry and access view (root helper) | the account (address, display name, sign-in times), a keyed tag of the address | step 3 (disable); erasure is an operator action (owner) |
| Mail queue and ledger (mailer, when deployed) | address and name of a queued approval email | sent entries are removed; a waiting one by the operator (step 4) |
| Mail provider | the sent approval email (provider's own retention) | the provider's console, manual |
| Telegram chat | name and role in the new-request alert | step 5, manual |
| Google Form + response spreadsheet | every answer | step 6, manual |
| Backups (host and helper backups) | copies of the above | **rotate out on their own schedule; never edited.** A deleted record disappears from backups when the last backup holding it expires. |

Funnel counters (section 3) hold no personal data and need no step.

## 3. Funnel counters (`runtime/admin/funnel/counters.ts`)

**The numbers are indicative.** They exist to see roughly how many sign-ups were submitted and
approved per day. Never use them for billing, credits, usage limits, quotas or any decision about a
person: a write can fail (the count is then kept in memory and retried, and lost if the process stops
first), a day is capped at 10 000 per event, and duplicates of an address are not counted.

- Stored: per UTC day and event, one integer. Events (fixed allow-list): `landing_view`,
  `signup_form_view`, `signup_submitted`, `signup_approved`, `first_session`. Tonight only two are
  counted: `signup_submitted` (the intake, once per new request; duplicates and refusals are not
  counted) and `signup_approved` (the admin service, once per request, when its account is added).
- Never stored or logged: IP address, user agent, referrer, URL, address, name, cookie, request id,
  client id. The intake sets no cookie.
- One file `funnel-counters.json` (0600) in a private directory (0700); a directory that group or
  others can access is refused (the counters stay off, one log line, the service runs). Atomic
  writes; days older than 400 are pruned; an unreadable file is renamed aside
  (`funnel-counters.json.corrupt-<ms>`) and logged, never silently reset.
- Settings, per service: `TBI_FUNNEL_COUNTERS=1` and `TBI_FUNNEL_DIR` (absolute). The intake and the
  admin service run as different users, so each gets its own directory (one file each). Off by
  default; a bad setting turns only the counters off, never the sign-up.
- There is no HTTP endpoint. `FunnelCounters.snapshot()` returns `{v:1, days:{<day>:{<event>:n}}}`
  for an operator or a later owner view.
