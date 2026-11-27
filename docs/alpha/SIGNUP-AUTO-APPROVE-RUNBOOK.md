# Sign-up auto-approve (BETA-G1): owner runbook

Design and behaviour: `docs/plans/BETA-G1-AUTO-APPROVE.md`. This page lists what the owner does. **Nothing here has
been done on any host.** Every step changes a live service (manual DEV-Lab/Alpha change: RED zone), so each one runs only in an
interactive session with the owner's approval.

`<N>` is the instance name (`tbi` for the dev-lab instance of `deploy/dev-lab/s8/install.sh`), so the unit is
`<N>-admin.service` and the control-state directory is `/var/lib/<N>-admin-auto`. Host names, addresses and
other private details are kept in the private ops repository, not here.

## What installing the unit does (and does not do)

- `tbi-admin.service.in` creates the control-state directory through systemd (`StateDirectory=<N>-admin-auto`,
  `StateDirectoryMode=0700`). systemd creates it owned by the admin service user (`tbi-admin`,
  group `tbi-adminio`) with mode 0700 and puts back the owner if it was changed at start. It may not correct a
  loosened mode: check `stat` shows 0700 after every restart (the code refuses only group/world-writable). Whether the intake can reach it depends on the user model
  (precondition 5): a **different** user is denied by the 0700 mode; the **same** user, as the store needs today, is
  not. The admin service can write only there and in the spool (ProtectSystem=strict; no network:
  PrivateNetwork=yes).
- It sets `TBI_SIGNUP_AUTO_STATE_DIR=/var/lib/<N>-admin-auto`. This setting does nothing until the flag is on.
- It does **not** set `TBI_SIGNUP_AUTO_APPROVE` or `TBI_SIGNUP_AUTO_DAILY_CAP`, so **auto-approve stays off**.
  A test checks the rendered unit for this: `runtime/admin/tests/signup-auto-deploy-unit.test.ts`.
- The parents of the directory (`/var/lib`, `/var`, `/`) must stay owned by root and not group- or
  world-writable. Otherwise the service refuses the directory (`ancestor_owner` / `ancestor_mode`) and stays
  manual-only. Never point the setting at a symlink or at a directory inside the sign-up store.

## Before enabling (prerequisites)

1. The sign-up feature itself is deployed and works by hand (`TBI_SIGNUP_ADMIN=1`, store, mail): you can approve
   a request in the admin app.
2. The owner principal is recorded in the access view. Without it the log says `auto-approve waiting (owner
   principal not recorded; manual only)`.
3. The owner has chosen the daily cap (open question Q2 in the design note): a whole number from 1 to 1000, at or
   below the mail provider's daily allowance and the account cap headroom. **No value is chosen in this repo.**
4. Public copy (G5) and the legal note (G4) match automatic approval.
5. **Hard precondition for every flag on this page: isolate the intake.** Today the admin and intake services must
   run as the **same user**: the sign-up store is 0700 and both write 0600 files in it. File modes then do not
   separate them; the intake unit's sandbox must. Do not set a flag until all of this is done:
   - The user model (shared or separate) is recorded in the private ops repository.
   - The intake unit has `ProtectSystem=strict`; its `ReadWritePaths` holds only the sign-up store and, if
     funnel counters are on, the intake's own `TBI_FUNNEL_DIR`.
   - Its `InaccessiblePaths` covers `/var/lib/<N>-admin-auto` (control state, verification state, mail-gate
     state), the verification state directory and key file wherever they are configured, the admin mail key file
     (`TBI_SIGNUP_RESEND_KEY_FILE`), the admin spool, results and view directories, the admin socket directory,
     and the admin configuration, log and funnel directories the intake does not need. These paths must exist
     before the intake starts: an optional (`-` prefixed) path that is absent at start is not masked.
   - On the host, `systemctl show -p InaccessiblePaths,ReadWritePaths <intake unit>` shows exactly that. Record the
     output as evidence **before** setting the flags.
   - The skipped intake case in `signup-auto-deploy-unit.test.ts` is completed when the intake unit lands in the
     repo: it checks these paths, and its user assertion must match the recorded user model.
   - **Blocking:** path masking alone is not enough with a shared user, because a process can signal another
     process of the same user and may reach its files through `/proc/<pid>/root`. Use either separate users
     (needs a group-based store mode, not built yet), or a separate PID namespace for the intake
     (`PrivatePIDs=yes`; confirm the host supports it and that it took effect) together with
     `NoNewPrivileges=yes`, an empty `CapabilityBoundingSet` and `SystemCallFilter=~@debug`.
   - **Blocking:** from inside the intake's sandbox, check and record that the admin process is not visible and
     cannot be signalled, and that the control state cannot be read, neither by its path nor through `/proc`.
     `systemctl show` proves configuration only, not enforcement.

Check the directory (expected answer: `tbi-admin:tbi-adminio 700 directory`):

```
sudo stat -c '%U:%G %a %F' /var/lib/<N>-admin-auto
```

## Enable

1. Create the drop-in `/etc/systemd/system/<N>-admin.service.d/auto-approve.conf` (root-owned, 0644), using
   your cap in place of `<OWNER_CAP>`:

   ```
   [Service]
   Environment=TBI_SIGNUP_AUTO_APPROVE=1
   Environment=TBI_SIGNUP_AUTO_DAILY_CAP=<OWNER_CAP>
   # Optional: only requests created after this time are taken (default: the first time it runs).
   #Environment=TBI_SIGNUP_AUTO_SINCE=2026-12-12T08:00:00+02:00
   ```

   A drop-in survives a reinstall of the unit (`install.sh` rewrites the unit file only). **Uninstalling or
   reinstalling the admin unit does NOT turn auto-approve off:** remove the drop-in first (see Roll back), or a later
   install brings it back with the old cap. Keep these lines out of
   the unit file itself.
2. `sudo systemctl daemon-reload && sudo systemctl restart <N>-admin.service`
3. Check the log (next section). Expect `auto-approve on (daily cap N)`. On the first sweep, without
   `TBI_SIGNUP_AUTO_SINCE`, expect `auto-approve cut-off recorded (only requests created from now on)`: the
   existing backlog stays for you to handle by hand. A past `TBI_SIGNUP_AUTO_SINCE` is honoured only if that
   first sweep may approve: if it is paused or the owner principal is not recorded yet, the cut-off becomes the
   time of the first approving sweep instead.
   Exception: if the first start finds the state directory unsafe, nothing is recorded, so after the fix a past
   `TBI_SIGNUP_AUTO_SINCE` still applies (within the daily cap). Remove or update it before you restart.
4. The admin app's sign-up screen shows the auto-approve status block (count and cap, paused, cut-off).

If the log says `auto-approve off (config: ...)`, the flag or cap value is wrong. Fix the drop-in and restart.
If it says `auto-approve not started (state dir unsafe: <reason>); manual only`, fix the directory, then
**restart**. Fixing the directory alone does not start auto-approve after a refused start.

## Mail caps and email verification (release notes, S4a)

Changes an operator must know before this version is installed:

- **Verified mode (`TBI_SIGNUP_AUTO_WEB=verified`) now requires the three mail caps**
  `TBI_SIGNUP_MAIL_MAX_PER_HOUR`, `TBI_SIGNUP_MAIL_MAX_PER_DAY` and `TBI_SIGNUP_MAIL_MAX_PER_30D` (hour <= day <=
  30 days; the day cap not below `TBI_SIGNUP_VERIFY_MAX_PER_DAY`, 50 when unset), plus
  `TBI_SIGNUP_AUTO_STATE_DIR`. No value is chosen in this repo. Without the caps: auto-approve is off
  (`auto-approve off (config: TBI_SIGNUP_AUTO_WEB=verified needs the mail caps)`), **no verification mail is
  sent** (`verify mails held (mail_caps_missing)`), resend requests wait, and the unverified purge does not run.
  Links this version already sent can still be confirmed, and approval mails still go only to the address the account was
  added for (`approval mail refused (addr_changed)`). Approval mails you send by hand are then not capped.
- **Confirmation links sent by an earlier version stop working** (`verify rejected (key_retired)`). The person
  asks for a new link; the usual resend limits apply.
- **The unverified purge** (`TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS`, off when unset) runs at most hourly and
  counts one hour ahead, so a request can be removed **up to 1 hour before** the full number of days. It counts
  from the time the request was created, so a request that never got a link (for example behind the daily verify
  cap) is removed too (`purge unverified never mailed N`). `purge unverified kept (<reason>) N` or `failed
  (<class>) N` means requests were left in place; check the state directory and the store. A failed one is tried
  again at the next run.

### `mail cap reached` with a state class

`mail cap reached (hour)`, `(day)`, `(30d)` or `(provider)` clears by itself; waiting mails are sent later. The
classes `missing`, `unreadable`, `invalid`, `clock_back`, `state_dir_unsafe` (or an error class) mean the gate
cannot trust its state in `/var/lib/<N>-admin-auto` and sends nothing:

1. Fix the cause first (owner and mode of the directory, disk, clock).
2. Wait for a send: `state_dir_unsafe`, a passing disk error, and `clock_back` caused only by a clock that has
   since been corrected forward clear by themselves. If the state is lost or damaged, or the class stays, remove
   **both** files and **restart** the service (removing them without a restart does not recover):

   ```
   sudo rm -f /var/lib/<N>-admin-auto/mail-gate.json /var/lib/<N>-admin-auto/mail-gate.seen
   sudo systemctl restart <N>-admin.service
   ```

   This forgets the mails already counted, so up to a full cap can be sent again. Check the provider's usage for
   the last 30 days first, and lower the caps for that period if needed. The restart is a RED zone step, as above.

## Morning summary and cut-off window (S4b settings, all off when unset)

| Unit | Setting | Values | Effect |
|---|---|---|---|
| admin | `TBI_SIGNUP_SUMMARY` | `1`; unset = off. Another value: off, `summary file off (config: ...)` | About once a minute writes `auto-summary.json` into the sign-up store: counts, booleans and dates only. Never read back. |
| intake | `TBI_SIGNUP_NOTIFY` | `summary`; unset or empty = one Telegram alert per request. Another value: the intake refuses to start | No alert per request. One summary a day when quiet hours (`TBI_SIGNUP_QUIET` of the intake) end, 08:00 when `off`; alerts (auto cap, verify cap, mail 80% of day or 30 days, verify key unreadable): once per type per day the condition was seen, at most 2 per type per day of sending; pause on / off: each at most once a day; no fresh summary for more than 30 minutes, or about 2 minutes while the morning summary is due (`no fresh sign-up summary (stale, missing, unreadable or invalid)`), once a day. Never in quiet hours. State: `auto-notify.state.json` in the store. |
| admin | `TBI_SIGNUP_AUTO_CUTOFF_KEEP_S` | `0`..`3600` seconds; unset or `0` = off. Bad value, or no separate `TBI_SIGNUP_AUTO_STATE_DIR`: sign-up admin routes disabled | **Owner decision open (DEC-38).** A restart whose first approving sweep comes within this many seconds of the last one keeps the cut-off. Sweeps run every 60 s, so a value near or below 60 mostly resets. |

- **Before using `summary`:** enable the admin setting first and check that `auto-summary.json` appears. The file is
  0600 and owned by the admin service user, so the intake can read it only when **both services run as the same
  user**. The store already needs that today (0700 directory, 0600 records written by both sides). With another user
  the intake logs `summary ignored (unreadable)`, no summary arrives and, with per-request alerts off, the owner gets
  only the daily `no fresh sign-up summary (unreadable)` alert. The same happens while the admin service is stopped
  (`stale`). A stopped intake sends nothing at all: a missing morning message means "check the services". A shared
  user requires the isolation of precondition 5.
- A pause switched on and off within one day, or during quiet hours, may not be reported in order; the morning
  summary shows the current state.
- Counts come from the requests the store holds at that moment (deleted or purged ones are not counted).
  `n/a` means unknown or the feature is off.
- A forged file can cause a wrong message only. It approves nothing and changes nothing in the admin service.
- Log classes (intake): `summary ignored (missing|unreadable|not_file|too_large|invalid|stale|future)`,
  `summary send failed (<class>)` (retried after 5, 10, 20, 40, then every 60 minutes), `summary state invalid`
  or `unreadable`. Admin: `summary file not written (<class>)`, `auto-approve heartbeat not written / removed`.
- With the cut-off window on, a pause, missing owner, unsafe directory or unreadable state removes the heartbeat,
  and so does a start without auto-approve or without the setting, **as long as `TBI_SIGNUP_AUTO_STATE_DIR` is still
  set** (otherwise the directory is unknown: after disabling by removing settings, wait longer than
  `TBI_SIGNUP_AUTO_CUTOFF_KEEP_S` or delete `auto-approve.heartbeat.json` before enabling again): the next start resets the cut-off as described
  below (`auto-approve cut-off reset`; a kept one logs `auto-approve cut-off kept`). **A pause file created and
  removed while the service was stopped, or between two sweeps, is not seen** and does not reset a kept cut-off.

## Owner view of email confirmation (S5)

Read only, nothing to enable. With `TBI_SIGNUP_VERIFY=1` each web request on the admin sign-up
screen shows its confirmation state, and unconfirmed ones (mail sent or not sent) sit in a closed
"Not confirmed yet" group. With verification or the mail caps configured, a block shows the
confirmation mails today, confirmed requests still waiting, the mail budget and the pause state
(no control). "unknown" means the admin state could not be read or trusted: check the log for
`signup: owner view unknown (...)` and the state dir permissions. Before the first sweep creates
`verify/`, every web request reads as unknown. A mail minted before this release has no success
record and reads as "not recorded as sent". "Approved automatically" rests on the request record:
with these states on, it is shown only for a request that is no longer pending and has its account
added. A mail sent to an address the record no longer holds reads as "Address changed".

## Pause (kill switch) and resume

Pausing needs no restart. Run it as root:

```
sudo touch /var/lib/<N>-admin-auto/auto-approve.paused     # pause
sudo rm /var/lib/<N>-admin-auto/auto-approve.paused        # resume
```

- Log: `auto-approve paused`, and later `auto-approve resumed` (at the next sweep, within about a minute).
- One request already in progress may still finish after the `touch`. The next check stops the sweep.
- While paused, sign-ups are still stored and alerted, and you approve them by hand (manual mode).
- A pause file in the sign-up store directory has **no** effect. Only the file in `/var/lib/<N>-admin-auto` counts.
- Resuming resets the cut-off to the time of the first sweep after the `rm`: requests that arrived while it was
  paused are **not** approved automatically; you approve them by hand. The daily count stays as it is.
- The pause is checked once per sweep (every 60 s). A pause file created and removed between two sweeps is **not**
  seen: nothing is paused and no reset happens. Keep the file for at least one sweep interval (see the
  `auto-approve paused` line in the log) before you rely on it, or restart the service.
- Unless the cut-off window above is on, the same reset happens on **every restart** of the admin service and every re-enable: each new process first
  moves the cut-off to now (never earlier), so requests that arrived before it are yours to handle. The cost: a
  restart or resume (also one for an unrelated reason) leaves **all** requests still pending from before it for
  manual approval, including older ones that were waiting for the next day's cap.
- After the first enable, remove `TBI_SIGNUP_AUTO_SINCE` from the drop-in (or set it to the recorded cut-off). The
  cut-off is stored in the state file. If that file is deleted, the daily count starts again at 0 and the list of
  unfinished approvals to retry is lost. The new cut-off depends on the process:
  - A running process that has set its cut-off, and has had no pause, missing owner or unsafe directory since,
    resets it at the next sweep, to now or to a later `TBI_SIGNUP_AUTO_SINCE`. A past value is **not** applied again.
  - In other cases lost state is not treated as a first run when there is evidence of an earlier run: this process
    saw a pause, a missing owner principal, an unsafe directory or an unreadable state file, or had read the file
    before; or the marker file `auto-approve.marker` is in the directory (empty, written on every paused or
    owner-not-recorded sweep, on every sweep that ends with an unreadable state in a safe directory, and with the
    first stored cut-off; kept across restarts; an error looking for it counts as present); or a request already
    carries an auto-approve mark. The log then says `auto-approve state missing, cut-off = now` and the cut-off is
    now (or a later `TBI_SIGNUP_AUTO_SINCE`): a past value is **not** applied, and requests that arrived before it
    stay for you. Leave the marker file in place.
  - If the marker cannot be written on an unreadable-state sweep, nothing is approved, the log says
    `auto-approve marker not written (<ERRNO>)` (at most hourly) and the next such sweep tries again.
  - Limits: after a restart the sweep can be a first run again, and a past `TBI_SIGNUP_AUTO_SINCE` **is** applied,
    in these remaining cases:
    - the state file and the marker were deleted (or the whole state directory) and no request carries a mark;
    - the state file was removed before any sweep of this release saw it (no marker yet, for example after a
      previous release that approved nothing) and no request carries a mark;
    - the earlier run only ever found the directory unsafe (nothing is written into an unsafe directory);
    - the marker write failed and the service restarted before a later write succeeded (and no request carries a
      mark).
  - So before you delete or replace the state file: create the pause file and wait for the `auto-approve paused` line
    (if it was already paused, no new line appears before the restart: find the earlier one since the last service
    start), remove `TBI_SIGNUP_AUTO_SINCE` from the drop-in, change the file, run `sudo systemctl daemon-reload`,
    restart, wait for a **new** `auto-approve paused` line, and only then remove the pause file.

## What to watch in the log (monitoring)

All lines come from the admin service, with the prefix `tbi-admin: signup: `. They contain no ids, names,
addresses or paths:

```
sudo journalctl -u <N>-admin.service --since today | grep 'signup: auto-approve'
```

The `auto-approve paused` and `auto-approve waiting` lines are not repeated every sweep, so they can be older than
today. For them, search since the last service start:

```
sudo journalctl _SYSTEMD_INVOCATION_ID="$(systemctl show -p InvocationID --value <N>-admin.service)" | grep 'signup: auto-approve'
```

If auto-approve is already paused, creating the pause file again writes no new `auto-approve paused` line before a
restart: look for the earlier line in that search. A restart while the pause file exists writes a new one.

Alert on (owner action needed or capacity reached):

| Log line | Meaning / action |
|---|---|
| `auto-approve daily cap reached (N); the rest stay pending` | Today's cap is used up. The rest wait for tomorrow or for you; a restart or resume before then leaves them all for you (manual). If this happens often, review the cap (pending requests are purged after 90 days). |
| `auto-approve paused` / `auto-approve resumed` | The kill switch changed. Check that it was you. |
| `auto-approve pause check failed (<ERRNO>); treated as paused` | The directory cannot be read. Check the owner and mode. |
| `auto-approve state dir unsafe (<reason>); manual only` | The owner, mode, symlink or parent of the directory is wrong. It resumes by itself once fixed, after a cut-off reset: requests that arrived before the first approving sweep after the fix stay for you (manual). With no state file then, the same process sets the cut-off to now (`state missing, cut-off = now`); after a restart see the limits under the state file above. |
| `auto-approve not started (state dir unsafe: <reason>); manual only` | Same problem at start. Fix it, then restart. |
| `auto-approve counter unreadable (<class>); treated as cap reached` | The state file is corrupt, or (`future_day`) the clock went back. Inspect it before you remove it (removing it resets today's count and the cut-off); create the pause file first, back the file up (`cp -p`) and remove `TBI_SIGNUP_AUTO_SINCE` (steps above) before any removal. |
| `auto-approve marker not written (<ERRNO>); retried at the next unreadable-state sweep` | The state is unreadable and the marker could not be created. Do not restart or remove the state file yet: create the pause file, fix the directory (mode, disk), and check that `auto-approve.marker` exists. |
| `auto-approve retry limit reached (N today); the rest wait` | The account helper keeps failing. Check the helper. |
| `auto-approve could not mark a claimed request (<ERRNO>); ...` | The store write failed. Check the store's disk and permissions. |
| `auto-approve sweep failed (<class>)` | An unexpected sweep error. Read the lines around it. |
| `auto-approve waiting (owner principal not recorded; manual only)` | Record the owner principal. Requests that arrive meanwhile stay for you (the cut-off is reset once the owner is recorded). |
| `auto-approve cut-off reset failed (<ERRNO>); nothing approved, retried next sweep` | The state file could not be written. Nothing is approved until it can. Check the directory's owner, mode and disk. |
| `auto-approve off (config: <reason>)` | The drop-in value is wrong. Auto-approve is off. |

For information only: `auto-approve on (daily cap N)`, `auto-approve processed N`, `auto-approve cut-off recorded`
(first run), `auto-approve state missing, cut-off = now` (lost state, see above) and `auto-approve cut-off reset (only requests created from now on)`. The reset line is written by the
first sweep that may approve after a restart or re-enable, a pause, a wait for the owner principal, an unsafe state
directory, or the deletion of the state file under a running process (not on a first run). Between such an event and
that line, if the state directory is safe and the state file can be read, the status block shows the backlog as
unknown (the status answer gives the reason `reset_pending`). Other cases differ:

- Before a first run, the reason is `not_recorded`; with `TBI_SIGNUP_AUTO_SINCE` set, the backlog is counted from it.
- With an unsafe state directory or an unreadable state file, the reason names that failure; with
  `TBI_SIGNUP_AUTO_SINCE` set, the backlog is counted from it.
- A pause file that no sweep has seen yet does not change the status block's backlog.

## Troubleshooting: cut-off reset and state file

Any restart or other change on the host is RED zone, as above. Never edit the state file to move the cut-off.

| What you see | Meaning | What to do |
|---|---|---|
| Log `auto-approve cut-off reset (only requests created from now on)` | The cut-off moved to now (or to a later stored value or `TBI_SIGNUP_AUTO_SINCE`), never earlier. The daily count is kept, unless the state file was lost (below). | Check that you expected it (restart, re-enable, resume, owner wait, unsafe directory, lost state file). Review older pending requests and approve or reject them by hand. |
| Status reason `reset_pending`; the backlog shows as unknown | This process, or the stored state, still needs the cut-off reset. Only a sweep that may approve does it: not paused, owner recorded, state directory safe. | Wait one sweep (60 s) and press Refresh requests. If it stays, look for `paused`, `waiting (owner principal not recorded; manual only)`, `cut-off reset failed` or `state dir unsafe` in the log and fix that cause. `paused` and `waiting` are not repeated every sweep: search since the last service start (below). A pause keeps this reason until you resume. |
| State file `auto-approve.state.json` was deleted | Today's count, the retry count and the list of unfinished approvals start empty, so up to a full cap can be approved again today. A running process that had set its cut-off resets it at the next approving sweep. With evidence of an earlier run the new cut-off is now, or a later `TBI_SIGNUP_AUTO_SINCE`; after a restart without evidence a past `TBI_SIGNUP_AUTO_SINCE` **is** applied (limits listed under Pause and resume). | Create the pause file at once and wait for `auto-approve paused` (if it was already paused, no new line appears before the restart: find the earlier one since the last service start). Remove `TBI_SIGNUP_AUTO_SINCE` from the drop-in, run `sudo systemctl daemon-reload`, restart, wait for a new `auto-approve paused` line, then remove the pause file. Leave `auto-approve.marker` in place. Check unfinished approvals and older pending requests by hand. |

## Roll back (turn auto-approve off)

1. `sudo rm /etc/systemd/system/<N>-admin.service.d/auto-approve.conf`
2. `sudo systemctl daemon-reload && sudo systemctl restart <N>-admin.service`
3. Check that no `auto-approve on` line appears after the restart, and that the status block reports
   auto-approve as off.

- Requests approved automatically stay approved, and their accounts exist. Disable an account by hand in the
  admin app if needed. The sign-up audit log marks those approvals `actor=auto`.
- The directory `/var/lib/<N>-admin-auto` is kept. It is inert while the flag is off; leave it in place.
- **Turning it on again later:** nothing extra is needed. The first sweep of the new process resets the cut-off to
  now, so requests that arrived while auto-approve was off stay for manual handling. `TBI_SIGNUP_AUTO_SINCE` can
  only move the cut-off later, never earlier.
- Never edit or delete the state file while auto-approve is on. Only root and the admin service user can do it,
  and doing so resets the cap for the day.
