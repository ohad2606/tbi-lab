# BETA-G1: self-signup without manual approval (design note, slice 1)

Status: design plus a tested, **off-by-default** code slice (`runtime/admin/signup/autoApprove.ts`). Nothing is
deployed or enabled anywhere. This builds on the sign-up automation (TBI-022, `docs/alpha/SIGNUP-AUTOMATION-DESIGN.md`);
read that first. Private details (hosts, paths, addresses) are placeholders: `<STORE_DIR>` is `TBI_SIGNUP_DIR`.

Public beta gate G1 (owner directive 2026-11-23): self-signup without manual approval, a daily sign-up cap, and a
kill switch. If G1 is not ready on 12.12 the beta is postponed.

## 1. Flow

1. Unchanged: the form forwarder POSTs a signed request; the intake verifies, rate-limits, validates,
   de-duplicates and stores it as `pending`, and alerts the owner on Telegram (deferred in quiet hours).
2. New, only when enabled: the **admin service** runs a sweep at start and every 60 s. For each eligible pending
   request, oldest first, it claims a slot of today's cap and calls the **same `SignupApprover.approve`** the
   owner's Approve button calls: account add through the spool and the root helper, then the approval email (or
   `email_queued` in quiet hours, sent by the existing drain at 08:00). Same idempotency, same audit log; the
   audit line ends with `actor=auto`.
3. Over the cap, while paused, or when the owner principal is unknown, requests simply stay `pending`: the
   owner can still approve or reject them by hand, and later sweeps take them in order.

### Why the admin service, not the intake

The intake is the public-facing process and is deliberately create-only: it has no spool access and no mail
key. Moving approval into it would give the internet-facing process the power to add accounts and send mail.
The sweep therefore runs where those capabilities already live. The cost is a delay of up to about one minute
between the signup and the approval. There is no new network surface: no new route, listener or outbound host.

### Spool actor

The root helper accepts account requests only from the owner principal. The sweep submits as the principal
recorded in the access view (`view.owner.principal`), read at every sweep. If none is recorded yet, nothing is
auto-approved (one log line). In the helper's own audit, auto-approvals therefore show the owner's principal; the
sign-up `audit.log` is where `actor=auto` tells them apart. A distinct helper-side "auto" actor would need a
helper change, which is out of scope (owner question Q1).

## 2. Configuration (admin service unit; root-owned unit file)

| Setting | Meaning |
|---|---|
| `TBI_SIGNUP_AUTO_APPROVE` | unset or empty: **off** (default, no log line). Exactly `1`: on. Any other value: off plus one log line `auto-approve off (config: ...)`. |
| `TBI_SIGNUP_AUTO_DAILY_CAP` | required when on: whole number 1..1000. Missing or invalid: off plus one log line. |

The flag needs `TBI_SIGNUP_ADMIN=1` (the sign-up feature itself). A bad auto setting never disables the manual
routes. Turning the flag on or off needs a restart of the admin service. Pausing (section 4) does not.

**Flag off means today's behaviour, unchanged.** No timer is started, no file is written, records get no new
field, audit lines are byte-identical (the actor tag is added only for the auto approver), and no log line is
added. This is tested.

## 3. Daily cap and the "waitlist"

- Counted per **Israel calendar day** (`Asia/Jerusalem` via `Intl`, so DST is handled: the 23-hour and 25-hour
  days each have one cap; it resets at local midnight, not UTC midnight).
- What is counted: requests **claimed** by the sweep. Manual approvals by the owner are not counted (the owner's
  explicit decision is not capped here; the helper's account cap still applies to both).
- Persisted in `<STORE_DIR>/auto-approve.day.json` (`{"v":1,"day":"YYYY-MM-DD","count":N}`, 0600, written as an
  exclusive temp file, fsync, rename), so the count survives a restart.
- Atomicity: a claim runs under an in-process mutex per store, plus the per-id lock that the owner's
  approve/reject/resend and the purge already share (`locks.ts`). Inside it the sweep re-reads the record, checks
  it is still eligible, **persists count+1 first**, then marks the record `autoApprovedAt`, and only then calls
  approve. A crash between those steps wastes at most one slot; it can never exceed the cap.
- Eligible: `status: pending`, never claimed (`autoApprovedAt` unset), and `lastError` null. A request where an
  earlier approve attempt failed (for example the helper answered `cap_reached` or `error`) needs the owner and is
  never retried automatically. A claimed request whose helper had not answered yet (`account_pending`, status
  `approved`, no mail attempted) is retried by later sweeps **without** a new slot.
- An unreadable or corrupt counter counts as cap reached (fail closed). It is logged once per sweep and never
  reset automatically: the operator inspects it and removes it.
- **Decision: no new "waitlist" status.** Over the cap a request stays `pending`. It is never lost, it shows in the
  owner's open list as today, and the next days' sweeps take the backlog oldest first. A new status would touch the
  store schema, the admin client, the UI and both translations for no behavioural gain. The open list could later
  show "waiting for tomorrow's cap" (UI follow-up).
- Order: by `createdAt` (millisecond resolution). Requests created in the same millisecond have no defined order
  among themselves.
- Retention interaction: a pending request is still deleted 90 days after creation (published notice). If the
  daily inflow stays above the cap for months, the oldest waitlisted requests could be purged unapproved. The
  cap-reached log line exists so monitoring tells the owner well before that.

## 4. Kill switch

`<STORE_DIR>/auto-approve.paused`. Same semantics as BETA-G2's `free-admission.paused`:

- `lstat`, never followed: any entry counts as paused (file, directory, symlink, dangling symlink). Its content is
  ignored.
- `ENOENT` = not paused. **Any other error** (`EACCES`, `ENOTDIR`, unknown) counts as paused (fail closed). Each
  distinct error code is logged once, as the errno name only.
- Checked at the start of every sweep and again before **every** claim and retry, so `touch` stops the sweep
  within the current request and `rm` resumes it at the next tick. No restart is needed.
- Paused means manual mode, not "closed": signups are still stored and alerted, and the owner approves them by hand.
- Transitions are logged (`auto-approve paused` / `resumed`).

Operator: `touch <STORE_DIR>/auto-approve.paused` (as root or as the service user) to pause; `rm` it to resume.

## 5. Threat model (additions to the TBI-022 model)

Auto-approve removes the human between "a form was submitted" and "an account exists and a mail went out". The
cap and the kill switch are the controls that replace that human.

| Threat | Effect with auto-approve | Control / residual risk |
|---|---|---|
| Bot / abuse signups through the public form (no secret needed: the form forwards and signs) | Each fake signup becomes an allowlisted account and uses a slot of the helper's account cap and of the daily cap | Daily cap bounds it per day. Kill switch stops it at once. Existing per-address dedupe and validation stay. The helper's account cap is the hard ceiling (a full cap leaves requests pending with `cap_reached`). **Residual:** with an open form, the cap can be filled by bots and starve real users for that day. Form-side protection (Google sign-in required, CAPTCHA) is an owner decision (Q2). |
| Email bombing via the approval mail (attacker enters victims' addresses) | We send one approval mail to an address we never verified | One live request per address (dedupe marker): an address gets at most one approval mail while its record exists (up to 365 days). Across addresses, the daily cap bounds our outgoing approval mails per day. Mails are plain text with no attacker-controlled link; the name is the only echoed field (already sanitised). Quiet hours hold mails until 08:00. **Residual:** up to `cap` unsolicited mails a day to distinct victims, which costs sender reputation. Keep the cap at or below the mail provider's daily allowance and watch bounce/complaint rates (monitoring slice). |
| Enumeration (is an address registered?) | None added | The intake still answers 202 to new and duplicate requests alike and echoes nothing. The sweep has no external answer. The approval mail goes to the address itself, never to the submitter. |
| Leaked HMAC secret | Before: pending junk. Now: junk that is approved automatically, within the cap | Same cap and kill switch; global intake limit 200/h; rotation procedure unchanged. |
| Cost | Each approval uses mail-provider quota and an account; accounts then use lab capacity | Cap ≤ provider allowance (owner sets it). Lab capacity is bounded by G2 (free slot share, session cap, queue), not by G1. No paid resource is added. |
| Race: owner action vs sweep, or two sweeps | Double account add or double mail | Per-id lock shared with the owner routes, plus the store mutex for claims; approve is idempotent (tested: concurrent sweeps take exactly the cap, owner+sweep give one add and one mail). Assumes **one** admin service process per store (as TBI-022 already does). |
| Restart / crash | Cap reset, or a second mail | Counter persisted before the claim; `emailAttemptedAt` persisted before the send (existing). |
| Logs leaking personal data | | New log lines carry counts, states and errno names only: no id, name, address or path (tested against every line the tests produce). |

### Ordering with quiet hours (23:00-08:00 Israel) and Telegram

- Approval happens at any hour. The account is added at once, and the approval email is queued in quiet hours and
  sent by the existing drain at 08:00. The cap slot is counted on the day of the **approval**. Example: a signup at
  23:30 counts on that day; its mail goes out at 08:00 the next day.
- Owner Telegram alert (intake): in the daytime the alert is sent at submit time, before the sweep approves the
  request. At night it is deferred, and the existing drain **skips requests that are no longer pending**, so a
  night signup that was auto-approved is not alerted at 08:00. That is consistent with "alerts are about requests
  that need you", but it means the owner sees night signups only in the admin list and the audit log (Q3).
- No Telegram alert when the cap is reached or a pause starts: the admin service holds no Telegram token, and
  adding one is a new secret in a second process. Instead it writes the fixed log lines below for monitoring
  (Q4).

### Log lines (admin service, prefix `tbi-admin: signup: `)

`auto-approve on (daily cap N)`, `auto-approve off (config: <fixed reason>)`, `auto-approve processed N`,
`auto-approve daily cap reached (N); the rest stay pending` (once per Israel day per process), `auto-approve
paused` / `resumed`, `auto-approve pause check failed (<ERRNO>); treated as paused`, `auto-approve counter
unreadable (<class>); treated as cap reached`, `auto-approve waiting (owner principal not recorded; manual only)`,
`auto-approve sweep failed (<class>)`.

## 6. Tests (`runtime/admin/tests/signup-auto-approve.test.ts`, real temp store, fake account path and mail)

Config parsing; flag off unchanged (no sweeper, no file, record bytes and directory listing unchanged, manual audit
line unchanged); a bad flag value leaves manual on; happy path (account, mail, `autoApprovedAt`, audit
`actor=auto`, counter); quiet hours queue and drain; rejected, owner-approved and failed requests are left alone;
cap boundary at cap-1, cap and cap+1 (oldest first, rest pending, one cap log line); manual approval of a
waitlisted request; Israel day at both 2026 DST edges; rollover at Israel midnight versus UTC; the 25-hour day;
kill switch present then removed (no restart), absent, symlink (dangling and to a file), directory,
EACCES/ENOTDIR/unknown through a stat hook, a real EACCES, switched on mid-sweep; double submit; owner Approve
racing the sweep; two concurrent sweepers; restart persistence; corrupt counter; `account_pending` retry without a
new slot; helper `cap_reached` not retried; no owner principal; wiring submits as the owner principal.

## 7. Not done in this slice

- Deploy wiring: the admin service unit env (`TBI_SIGNUP_AUTO_APPROVE`, `TBI_SIGNUP_AUTO_DAILY_CAP`), the runbook
  lines for pause/resume, and the monitoring alerts on the cap and pause log lines.
- Admin UI: an "approved automatically" badge (`autoApprovedAt` is in the record but the admin client ignores it),
  today's count against the cap, the pause state, and "waiting for tomorrow" on waitlisted rows. Every new text
  needs HE+EN keys.
- An admin read-only status route (count/cap/paused) for the UI above.
- Public copy (G5): the form and landing must stop saying the owner approves each request and must say what
  happens when the day is full.
- The legal note (G4): automatic account creation from form data. Check whether the consent text still matches.

## 8. Open questions for the owner

- Q1: Is it acceptable that the root helper's audit shows the owner principal for auto-approvals (the sign-up
  audit marks `actor=auto`), or do we want a helper-side "auto" actor (a helper change, separate slice)?
- Q2: Which daily cap for 15.12? It should stay at or below the mail provider's daily allowance and the account cap
  headroom. Should the form require Google sign-in (strong bot control, but it excludes people without a Google
  account) or use another control?
- Q3: Should night-time auto-approved signups still produce a morning Telegram summary?
- Q4: Should the cap-reached and pause events reach Telegram (needs the token in the admin service, or a
  monitoring relay), or is the log-based monitoring alert enough?
- Q5: Enabling the flag also processes the **existing** pending backlog (oldest first, within the cap). Should the
  owner clear the Alpha backlog first, or should auto-approve only take requests created after it was enabled
  (a small change)?
