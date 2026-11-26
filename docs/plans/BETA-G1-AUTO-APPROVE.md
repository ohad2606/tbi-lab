# BETA-G1: self-signup without manual approval (design note, slices 1-7)

Status: design plus a tested, **off-by-default** code slice (`runtime/admin/signup/autoApprove.ts`). Nothing is
deployed or enabled anywhere. This builds on the sign-up automation (TBI-022, `docs/alpha/SIGNUP-AUTOMATION-DESIGN.md`);
read that first. Private details (hosts, paths, addresses) are placeholders: `<STORE_DIR>` is `TBI_SIGNUP_DIR`,
`<STATE_DIR>` is `TBI_SIGNUP_AUTO_STATE_DIR` (default: `<STORE_DIR>`).

Slice 2 applies the ops review of slice 1 (M1 control state location, M2 admin-owned claim set, M3 retry backoff,
L1 future-dated counter, Q5/L2 cut-off, L5 safe failure modes).

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
| `TBI_SIGNUP_AUTO_STATE_DIR` | optional absolute, normalized path of the **control-state directory** (pause file + state file). Unset: `<STORE_DIR>` (slice 1 behaviour). Not absolute / not normalized: off plus one log line. See "Control-state directory" below. |
| `TBI_SIGNUP_AUTO_SINCE` | optional ISO time with zone (`2026-12-12T08:00:00+02:00`). Only requests **created after** it are auto-approved. Unset: the time auto-approve first ran, persisted in the state file (section 3). Invalid: off plus one log line. |
| `TBI_SIGNUP_AUTO_WEB` | BETA-G1 s8: optional `excluded` (default when unset or empty) or `included`. With `excluded`, requests from the browser route (`origin: "web"`, docs/plans/BETA-G1-WEB-INTAKE.md) are never auto-approved: they stay `pending` for the owner and spend no slot. Must stay `excluded` until the owner answers O1 there. Any other value: off plus one log line. |

The flag needs `TBI_SIGNUP_ADMIN=1` (the sign-up feature itself). A bad auto setting never disables the manual
routes. Turning the flag on or off needs a restart of the admin service. Pausing (section 4) does not.

### Control-state directory (M1)

The pause file and the state file (count, retries, claim set, cut-off) decide what is approved, so they must not
be writable by the internet-facing intake. In the TBI-022 layout `<STORE_DIR>` is owned by the intake user, so a
compromised intake could delete the pause file or rewrite the counter.

- **Alpha requirement (deploy item, not done in this slice):** `TBI_SIGNUP_AUTO_STATE_DIR` must be an
  admin-only 0700 directory on Alpha (owned by the admin service user, mode 0700), **not** writable by the
  intake user, under parents that are root- or admin-owned. The operator pauses with
  `touch <STATE_DIR>/auto-approve.paused` as root or as the admin service user.
- Enforced at start and before every sweep (slice 3 adds the ancestor rules):
  1. the directory itself is a real directory (`lstat`; a symlink is refused: `not_dir`), owned by the admin
     service's uid (`owner`), and not group- or world-writable (`mode`);
  2. the configured path is its own `realpath`: no component is a symlink (`symlink`). A symlink in a parent
     could be swapped by whoever can write the directory that holds it, so it is refused rather than resolved;
  3. every parent up to `/` is owned by the admin service's uid or by root (`ancestor_owner`), and is not
     group- or world-writable unless it has the sticky bit (`ancestor_mode`). A sticky 1777 directory such as
     `/tmp` is accepted, because others cannot rename or remove entries they do not own there.
  Any `lstat`/`realpath` error gives its errno name. Otherwise auto-approve does not start (`auto-approve not
  started (state dir unsafe: <reason>); manual only`, once) or the sweep stops (`auto-approve state dir unsafe
  (<reason>); manual only`, once per distinct reason). Manual approval is never affected. The check is by path
  (check, then use); with the rules above only this uid or root can swap a component in between.
- **Runbook:** an unsafe state dir at start needs a restart of the admin service after the fix. The timer is
  never created in that case (fail closed), so fixing the directory alone does not turn auto-approve on. (An
  unsafe dir found by a later sweep is re-checked every sweep and resumes by itself once fixed.)
- Side effect, intended: with the default (`<STORE_DIR>`) and the Alpha layout where the store is owned by the
  intake user, auto-approve refuses to start until a separate state dir is configured.

**Flag off means today's behaviour, unchanged.** No timer is started, no file is written, records get no new
field, audit lines are byte-identical (the actor tag is added only for the auto approver), and no log line is
added. This is tested.

## 3. Daily cap and the "waitlist"

- Counted per **Israel calendar day** (`Asia/Jerusalem` via `Intl`, so DST is handled: the 23-hour and 25-hour
  days each have one cap; it resets at local midnight, not UTC midnight).
- What is counted: requests **claimed** by the sweep. Manual approvals by the owner are not counted (the owner's
  explicit decision is not capped here; the helper's account cap still applies to both).
- Persisted in `<STATE_DIR>/auto-approve.state.json`
  (`{"v":2,"day":"YYYY-MM-DD","count":N,"retries":R,"since"?:ISO,"claims":{<id>:{at,attempts,lastAttemptAt,spoolId?}}}`,
  0600, written as an exclusive temp file, fsync, rename), so count, claims and cut-off survive a restart.
- Atomicity: a claim runs under an in-process mutex per store, plus the per-id lock that the owner's
  approve/reject/resend and the purge already share (`locks.ts`). Inside it the sweep re-reads the record, checks
  it is still eligible, **persists count+1 and the claim first**, then marks the record `autoApprovedAt`, and only
  then calls approve. A crash between those steps wastes at most one slot; it can never exceed the cap.
- Eligible for a new claim: `status: pending`, created **after the cut-off**, not in the claim set, never marked
  (`autoApprovedAt` unset), and `lastError` null. A request where an earlier approve attempt failed (for example
  the helper answered `cap_reached` or `error`) needs the owner and is never retried automatically.
- **Retries (M2, M3).** A claimed request whose helper had not answered yet (`account_pending`: status `approved`,
  no mail attempted) is retried without a new slot, but only if its id is in the **admin-owned claim set**. Record
  fields alone never make a request retryable: the intake can write records, so a forged record with
  `autoApprovedAt` and `status: approved` is ignored (tested). Bounds, all persisted before the call:
  - per record: at most one resubmit per `AUTO_RETRY_BACKOFF_MS` = **15 minutes** (`lastAttemptAt` on the claim);
  - per sweep: at most `AUTO_RETRIES_PER_SWEEP` = **2** retries, then new claims run, so they are not starved;
  - per Israel day: at most **`dailyCap` retries** (`retries` in the state file, reset at Israel midnight). So
    one day makes at most `2 x dailyCap` approve calls. Reaching it logs `auto-approve retry limit reached` once
    per day; the rest wait for the next day (or the owner).
  - Each retry is a **new** spool request (the helper may be down); the claim keeps the last spool request id
    (`spoolId`) for the operator. Polling the earlier request instead of resubmitting is a possible later change.
  - Finished claims (mail attempted, email sent/queued/failed, rejected, back to `pending` with an error, or the
    record gone) are dropped from the set at the next sweep.
- **Cut-off (Q5, L2).** Only requests created after the cut-off are taken. The very first run (no state file)
  writes `TBI_SIGNUP_AUTO_SINCE`, or unset the current time, as `since` (one log line `auto-approve cut-off
  recorded`), so the existing backlog is **not** approved when the flag is first turned on; it stays for the owner.
- **Reset on every start, re-enable and resume (G1 follow-up).** Every admin process starts unconfirmed. Its first
  sweep that may approve (not paused, owner principal recorded) first persists `since = max(now, stored since,
  TBI_SIGNUP_AUTO_SINCE)` (one log line `auto-approve cut-off reset`), under the state-dir mutex, before any retry
  or claim. A paused, `no_owner` or `state_dir_unsafe` sweep makes the process unconfirmed again; a paused or
  `no_owner` sweep also writes `active: false` whenever it is not already false, including on a first run with no
  state file (so a paused first run is no longer a first run, and a backdated `TBI_SIGNUP_AUTO_SINCE` cannot take
  the requests of the pause, also across a restart). A pause created and removed between two sweeps is not seen. So any
  restart, env/drop-in off -> on, pause -> resume or owner recorded after `no_owner` leaves the requests created
  before it for the owner (manual). The cut-off only moves forward (a clock step back never moves it earlier).
  Cost: a restart or resume for an unrelated reason also leaves **all** requests still pending from before it
  (including over-cap ones waiting for the next day) for manual approval. A reset
  that cannot be written approves nothing (`stopped: reset_failed`, logged at most once an hour per class) and is
  retried by the next sweep; the count, retries and claims are written back unchanged. Until the reset, the status
  route answers `cutoff` and `waitingBacklog` as `unknown` with the reason `reset_pending`. Never delete or edit the
  state file while auto-approve is on.
- **Deleting the state file resets today's count** (and clears the claim set). With evidence of an earlier run (in memory,
  the `auto-approve.marker` file, or a marked request) the cut-off becomes now; without it (e.g. the whole state
  directory deleted) the next run is a first run that applies `TBI_SIGNUP_AUTO_SINCE` again: the cap is only as strong as the integrity of the admin-only state
  dir. Only root or the admin service user can do it; the runbook must say so, and says to remove or update
  `TBI_SIGNUP_AUTO_SINCE` after the first enable.
- An unreadable or corrupt state file, or one whose `day` is **after** today (a clock stepped back across
  midnight, L1: `future_day`), counts as cap reached (fail closed). Each sweep stops at the first read. The log
  line is written at most **once per hour per reason** (`AUTO_UNREADABLE_LOG_MS`; a new reason logs at once; a
  clock stepped back logs again). It is never reset automatically: the operator inspects it and fixes or
  removes it.
- **Decision: no new "waitlist" status.** Over the cap a request stays `pending`. It is never lost, it shows in the
  owner's open list as today, and the next days' sweeps take the backlog oldest first, as long as the process is
  not restarted or resumed meanwhile (a reset leaves all older pending requests, over-cap ones included, manual). A new status would touch the
  store schema, the admin client, the UI and both translations for no behavioural gain. The open list could later
  show "waiting for tomorrow's cap" (UI follow-up).
- Order: by `createdAt` (millisecond resolution). Requests created in the same millisecond have no defined order
  among themselves.
- Retention interaction: a pending request is still deleted 90 days after creation (published notice). If the
  daily inflow stays above the cap for months, the oldest waitlisted requests could be purged unapproved. The
  cap-reached log line exists so monitoring tells the owner well before that.

## 4. Kill switch

`<STATE_DIR>/auto-approve.paused` (with the default, `<STORE_DIR>/auto-approve.paused`; with a separate state dir a
pause file in the store dir has no effect). Same semantics as BETA-G2's `free-admission.paused`:

- `lstat`, never followed: any entry counts as paused (file, directory, symlink, dangling symlink). Its content is
  ignored.
- `ENOENT` = not paused. **Any other error** (`EACCES`, `ENOTDIR`, unknown) counts as paused (fail closed). Each
  distinct error code is logged once, as the errno name only.
- Checked at the start of every sweep and again before **every** claim and retry, so `touch` stops the sweep
  within the current request and `rm` resumes it at the next tick. No restart is needed.
- The pause check is outside the claim mutex, so one in-flight request may complete after `touch` (the one
  whose check already passed); the next check stops the sweep.
- Paused means manual mode, not "closed": signups are still stored and alerted, and the owner approves them by hand.
- Transitions are logged (`auto-approve paused` / `resumed`).

Operator: `touch <STATE_DIR>/auto-approve.paused` (as root or as the admin service user) to pause; `rm` it to resume.

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
| Compromised intake (it owns `<STORE_DIR>`) | Unlinks the pause file or rewrites the counter in the store dir; forges records that look half-approved | M1: control state in an admin-only `<STATE_DIR>` (deploy item), enforced owner/mode check. M2: only ids in the admin-owned claim set are retried, retries are bounded per day. **Residual** until the separate state dir is deployed: with the default dir the check refuses to start when the store is owned by the intake user. |
| Helper outage | Every sweep resubmits the spool request | M3: one resubmit per record per 15 min, 2 retries per sweep, `dailyCap` retries per day. |
| Clock stepped back across midnight | A fresh cap for the earlier day | L1: a state file dated after today fails closed (`future_day`). |
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
unreadable (<class>); treated as cap reached` (`<class>` includes `corrupt` and `future_day`; at most once an
hour per class), `auto-approve could not mark a claimed request (<ERRNO>); claim released, slot stays used` (or
`claim left for the next sweep`; once per errno name), `auto-approve waiting (owner principal not recorded; manual only)`, `auto-approve
sweep failed (<class>)`, `auto-approve state dir unsafe (<reason>); manual only`, `auto-approve not started (state
dir unsafe: <reason>); manual only`, `auto-approve cut-off recorded (only requests created from now on)`,
`auto-approve retry limit reached (N today); the rest wait`.

### Failure modes that are safe (L5)

- If the state write of the claim throws, nothing else happens (the record is not touched).
- If marking the record (`store.update` of `autoApprovedAt`) throws after the claim was persisted, approve has
  not been called. The claim is released (removed from the claim set) but the **slot stays used**: the count
  never goes down, so the cap still holds (a store that keeps failing wastes at most `dailyCap` slots a day). The
  sweep stops (`mark_failed`) and logs once per errno name. The request is eligible again and may be claimed by a
  later sweep with a new slot. If the release write fails too, `prune` drops the orphan at the next sweep: a claim
  whose record is still `pending` and unmarked (re-read first) is an orphan, because outside the mutex a live
  claim is always marked. The same covers a crash between the claim and the mark.
- If `approve` throws after the mark, the record stays `pending` with `autoApprovedAt` set; it is never retried or
  re-claimed automatically, and the slot is spent. The owner approves it by hand.
- If the state file is unreadable, the sweep stops (cap reached) and logs at most once an hour per reason.

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
Slice 2: future-dated counter; forged half-approved record not approved or mailed; per-day retry bound; 15-minute
backoff with a fake clock; retries per sweep bounded (new claims still run); spool request id stored on the claim;
separate state dir (pause and state there, store-dir pause ignored); unsafe state dir (mode, symlink, missing,
foreign owner) refused, and the wiring refusing to start; persisted default cut-off across a restart; configured
cut-off; config parsing of the two new variables.
Slice 3: group/world-writable ancestor refused, sticky ancestor accepted, sweep refuses then resumes once fixed;
symlinked ancestor refused (`symlink`); foreign-owned ancestor refused and root-owned accepted (stat hook, so it
runs as root and non-root; a real `chown` case runs only as root); wiring refuses to start on an unsafe ancestor;
mark failure after the claim releases the claim, keeps the slot used, logs once per errno, and the cap still
holds; an orphan claim is pruned and re-claimed; a marked claim is kept; the unreadable-counter line is limited to
once an hour per reason (fake clock).
Slice 5 (`runtime/admin/tests/signup-auto-status.test.ts`, real admin server behind test gates): the status route
needs the owner (401/403 like the sibling routes), is GET only (405; CSRF first), answers `{enabled:false}` without
reading a locked store dir, reports count/cap/cut-off/backlog after a real sweep, `running` before/after stop, the
day rollover without a write, pause as a file or a directory, `unknown` for a corrupt, future-dated, unreadable
(EACCES, non-root only) or unsafe/missing state, writes nothing and logs nothing, and holds no path or personal data.

## 7. Not done in this slice

- **Done in slice 7 (repo wiring only; nothing installed or enabled anywhere):**
  - `deploy/dev-lab/s8/tbi-admin.service.in`: `StateDirectory=<N>-admin-auto` + `StateDirectoryMode=0700`. systemd
    creates `/var/lib/<N>-admin-auto` owned by the unit's `User=`/`Group=` (`tbi-admin:tbi-adminio`) and re-applies
    the owner and the mode at every start. Also `TBI_SIGNUP_AUTO_STATE_DIR=/var/lib/<N>-admin-auto`, which is inert
    while the flag is off. `TBI_SIGNUP_AUTO_APPROVE`, `TBI_SIGNUP_AUTO_DAILY_CAP` and `TBI_SIGNUP_AUTO_SINCE` are
    only **commented** lines: installing the unit leaves auto-approve off. The cap is the placeholder
    `<OWNER_CAP>` (Q2). Uncommented as they stand, these lines still fail closed (config error, off). The owner
    enables auto-approve with a drop-in.
  - Path choice: the parents `/var/lib`, `/var`, `/` are root-owned 0755 on the host, so they pass the
    `autoStateDirCheck` ancestor rules. No symlink, and no DynamicUser (which would place the directory under
    `/var/lib/private` behind a symlink). It is a sibling of the helper's `/var/lib/tbi-admin` and is never inside
    that tree (a StateDirectory there would make systemd chown the helper's tree). It is not under the sign-up
    store either (that is owned by the intake user and would fail `ancestor_owner`).
  - No other writable path was added. All hardening stays (ProtectSystem=strict, PrivateNetwork=yes,
    AF_UNIX only, IPAddressDeny=any, no capabilities).
  - Test `runtime/admin/tests/signup-auto-deploy-unit.test.ts` renders the unit with install.sh's real
    `render_raw` (non-root, nothing installed). It asserts that the flag, cap and cut-off are unset (the parser
    says off, no error); that no install.sh mode uncomments them; the StateDirectory and its 0700 mode; that the
    writable paths are only the spool, the socket dir and the state dir; the hardening values; that the state dir
    is separate from every path rule, the helper tree and the stores; that no other repo unit runs as
    `tbi-admin` or can write the dir; and that the parents pass the ancestor rules on the test host.
  - Owner runbook: `docs/alpha/SIGNUP-AUTO-APPROVE-RUNBOOK.md` (enable, pause/resume, log lines to alert on,
    rollback, and the cut-off caveat when re-enabling).
- Still open for deploy:
  - The intake unit `tbi-signup` is not in the repo yet. When it lands it must set
    `InaccessiblePaths=-/var/lib/<N>-admin-auto` (defence in depth; the 0700 mode already denies it). The test
    case for this is an explicit skip until then.
  - The draft mailer unit could add the same `InaccessiblePaths` line (separate mailer slice).
  - The signup env of the admin unit (`TBI_SIGNUP_ADMIN`, store, mail) is not in this template. It is a TBI-022
    deploy item.
  - The monitoring alerts themselves (the runbook lists the lines).
  - The cap value (Q2).
- Admin UI: today's count against the cap, the pause state, and "waiting for tomorrow" on waitlisted rows (the
  "approved automatically" badge is done in slice 4; the status route below in slice 5). Every new text needs
  HE+EN keys.
- Done in slice 5: the admin read-only status route `GET /signups/auto-approve` (section 9).
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
- Q5 (default implemented in slice 2): auto-approve now takes only requests created after it was first enabled
  (or after `TBI_SIGNUP_AUTO_SINCE`); the existing backlog stays for the owner. Does the owner want a different
  cut-off (for example the date the public copy changed, G5)?

### Known follow-ups from the slice-2 reviews (not blockers; before enabling anywhere)

- Done in slice 3: parent directories are checked (section 2); orphan claims are released or pruned (L5); the
  unreadable-counter line is rate-limited; the doc now says that deleting the state file resets today's count,
  that one in-flight request may complete after `touch`, and that an unsafe dir at start needs a restart.
- Open: stop during startup can still run one sweep; the cut-off is written before the pause check.
- Open (out of scope here): no cross-process lock (one admin service process per store is assumed).
- Deploy item: never put the state dir under the store dir; create it 0700, owned by the admin service user.

### Runbook note (QA day2213)
- The state dir chain must have no group/world-writable non-sticky ancestors and no symlinks: use the real path
  (slice 7: `/var/lib/<N>-admin-auto`, a systemd StateDirectory, 0700, owned by the admin uid), not `/var/run/...`.
  Not under the sign-up store (`/var/lib/tbi-signup` is owned by the intake user: `ancestor_owner`). A trailing
  slash is tolerated.
- Ancestors such as 0775 directories are refused (`ancestor_mode`) — by design.

## 9. Status route (slice 5, read-only)

`GET /signups/auto-approve` on the admin service (under the gate's admin prefix in deployment), for the admin UI.
Same rules as the other sign-up routes: gate identity, owner only (no identity 401, anyone else 403), rate
limited, `no-store`. GET only: other methods 405 (a cross-site mutation is refused by the CSRF rule first, 403).
It never writes, takes no lock, writes no log line and does not change the sweep's log memory.

- Auto-approve off (flag unset or invalid): `{"enabled": false}`. Nothing is read; the state dir is not touched.
- On: `{enabled: true, running, day, dailyCap, count, capReached, paused, pauseError?, stateDir, stateDirReason?,
  cutoff, waitingBacklog, unknownReasons?}`.
  - `running`: the sweep timer of this process is active (false before start, after stop, or when start refused an
    unsafe state dir; that needs a restart, section 2).
  - `day`: the Israel calendar day; `count`: requests claimed that day (0 when the file is from an earlier day or
    absent: the cap has reset); `capReached`: `count >= dailyCap`.
  - `paused`: the kill switch exactly as the sweep reads it (`lstat`, any entry; a check error other than
    `ENOENT` is paused, with `pauseError` = the errno name).
  - `stateDir`: `ok` or `unsafe` with `stateDirReason` (the codes of section 2). When unsafe the state file is not
    read (`count: "unknown"`).
  - `cutoff`: the ISO time after which requests are taken (configured, or persisted by the first sweep);
    `waitingBacklog`: pending requests created at or before it (never auto-approved; they need the owner). Costs one
    listing of the store, like the owner's list.
  - **Explicit failure:** a value that cannot be read is the string `"unknown"`, never a guessed number, and
    `unknownReasons.<field>` names why: an errno name, `corrupt`, `future_day`, `state_dir_unsafe`, or
    `not_recorded` (no sweep has recorded the default cut-off yet), `reset_pending` (this process has not reset
    the cut-off yet: before its first approving sweep, or while paused / without the owner principal).
- The answer holds counts, the cap, booleans, the day, the cut-off time and fixed codes only: no id, name, address,
  path or secret (tested).
