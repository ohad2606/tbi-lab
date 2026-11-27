# Sign-up auto-approve (BETA-G1): owner runbook

Design and behaviour: `docs/plans/BETA-G1-AUTO-APPROVE.md`. This page lists what the owner does. **Nothing here has
been done on any host.** The commands, unit drop-ins and expected log lines on this page were written from the code
and its tests; none of them has been run on a host. Every step changes a live service (manual DEV-Lab/Alpha change: RED zone), so each one runs only in an
interactive session with the owner's approval.

There are two ways to use automatic approval:

- **Email-verified mode** (`TBI_SIGNUP_AUTO_WEB=verified`): a person signs up on the site, confirms the address with a
  link, and is then approved automatically. This is the mode for public web sign-ups. Read the general sections
  (prerequisites, pause, roll back) and then [Email-verified mode](#email-verified-mode).
- **Without verification** (`excluded`, the default, or `included`): `excluded` approves only requests that did not
  come from the web page. `included` approves web requests **without any proof of the address**. Do not use
  `included` on a public site.

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
- It sets `TBI_SIGNUP_AUTO_STATE_DIR=/var/lib/<N>-admin-auto`, in the unit file itself (not in a drop-in). It approves
  and writes nothing while the flags are off, but with the sign-up admin on, the pause file in that directory already
  [holds applicant mail](#what-the-pause-holds).
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
4. Public copy (G5) and the legal note (G4) match automatic approval (and, in email-verified mode, the
   confirmation mail and the deletion of unconfirmed requests).
5. **Hard precondition for every flag on this page: isolate the intake.** Today the admin and intake services must
   run as the **same user**: the sign-up store is 0700 and both write 0600 files in it. File modes then do not
   separate them; the intake unit's sandbox must. Do not set a flag until all of this is done:
   - The user model (shared or separate) is recorded in the private ops repository.
   - The intake unit has `ProtectSystem=strict`; its `ReadWritePaths` holds only the sign-up store and, if
     funnel counters are on, the intake's own `TBI_FUNNEL_DIR`.
   - Its `InaccessiblePaths` covers `/var/lib/<N>-admin-auto` (control state, verification state, mail-gate
     state), the verification state directory and key file wherever they are configured (for a key passed with
     `LoadCredential`: the source file **and** the admin unit's credential directory), the admin mail key file
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

## Email-verified mode

**Status: off by default, not deployed, never run on a host.** Everything below is from the code on this branch and
its tests (fake mail sender, temporary directories, loopback).

### How it works

1. The intake stores the web request as `pending`, as before.
2. The admin service (a sweep about every 60 s) sends a confirmation mail with a link to
   `<site>/<lang>/signup/#verify=<token>`. The token is valid for 24 hours and works once.
3. The person opens the link and presses the button on the page. The intake only writes an empty marker file.
4. The next admin sweep checks the marker against its own state and records the confirmation.
5. Auto-approve claims a slot of today's cap and approves the request: the account is added, then the approval mail is
   sent to the confirmed address (generic greeting, no sign-up name). Over the cap the request waits for a later day.

Requests that did not come from the web page are never sent a confirmation, so in this mode they are **never**
approved automatically.

Quiet hours: confirmation mails are sent at any hour. The **approval** mail is held during the admin unit's quiet
hours (`TBI_SIGNUP_QUIET`, default 23:00-08:00 Israel time) and sent when they end. `TBI_SIGNUP_QUIET=off` on the
admin unit sends it at once; it does not change the intake's own quiet hours.

### More preconditions

All of "Before enabling" above, and:

1. **The admin service can send mail.** The unit template in this repository has no network
   (`PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`), and its writable paths do not
   include the sign-up store. Mail egress, store access, the mail key and the other sign-up settings are not in the
   template; they must come from the deployment and be reviewed there. Check that an approval mail sent from the admin
   app arrives. **A failed confirmation mail is not retried:** it still uses a slot, and the person has to ask for a
   new link.
2. **The published site has the confirmation view.** Today `node site/build.mjs <dir>` does not include it; only the
   preview option `--signup-verify` does. Without it the link in the mail opens the ordinary sign-up page and nothing
   can be confirmed. Enabling it in a published build needs a reviewed change.
3. The proxy routes `/signup/verify` and `/signup/resend` to the intake (they are in
   `site/deploy/Caddyfile.signup.template`).
4. The mail caps are chosen, at or below what the mail provider allows. Each new tester costs at least two mails
   (confirmation and approval), plus new links.

### Values

**None of these values is approved.** The numbers are proposals; the code has no default for them except where the
"Unset" column says so.

| Setting (admin unit) | Placeholder | Proposed | Allowed | Unset |
|---|---|---|---|---|
| `TBI_SIGNUP_AUTO_DAILY_CAP` | `<AUTO_CAP>` | 40 | 1..1000 | auto-approve off |
| `TBI_SIGNUP_VERIFY_MAX_PER_DAY` | `<VERIFY_PER_DAY>` | 50 | 1..1000 (see the counter file below) | 50 |
| `TBI_SIGNUP_MAIL_MAX_PER_HOUR` | `<MAIL_PER_HOUR>` | 30 | 1..1000 | required in verified mode |
| `TBI_SIGNUP_MAIL_MAX_PER_DAY` | `<MAIL_PER_DAY>` | 95 | 1..10000 | required in verified mode |
| `TBI_SIGNUP_MAIL_MAX_PER_30D` | `<MAIL_PER_30D>` | 2700 | 1..300000 | required in verified mode |
| `TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS` | `<UNVERIFIED_DAYS>` | 7 | 1..90 | no early deletion (90 days) |
| `TBI_SIGNUP_AUTO_CUTOFF_KEEP_S` | `<CUTOFF_KEEP_S>` | not chosen | 0..3600 | every restart resets the cut-off |

Rules checked at start. Breaking one of the first six **disables all sign-up admin routes** (manual approval too),
with the log line `admin routes disabled (config: ...)`:

- The three mail caps are set together, with hour <= day <= 30 days.
- The mail caps and the keep window need `TBI_SIGNUP_AUTO_STATE_DIR`, not the store directory (the unit template sets
  it).
- `TBI_SIGNUP_VERIFY_MAX_PER_DAY` and `TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS` are allowed only while email
  verification is configured correctly. They also trigger this when `TBI_SIGNUP_VERIFY` is removed or another verify
  setting is bad.
- With the mail caps set, the verify cap (50 when unset) must not exceed the mail day cap.
- `TBI_SIGNUP_AUTO_WEB=verified` needs `TBI_SIGNUP_VERIFY=1` with valid verify settings
  (`TBI_SIGNUP_AUTO_WEB=verified needs TBI_SIGNUP_VERIFY=1 with valid settings`).
- `TBI_SIGNUP_AUTO_WEB=included` with a `TBI_SIGNUP_VERIFY` value other than empty or `0` is refused
  (`TBI_SIGNUP_VERIFY needs TBI_SIGNUP_AUTO_WEB verified or excluded`): it would turn verification off and still
  approve web requests without proof. Empty or `0` counts as verification off and is not refused (`0` also logs
  `email verification off (config: ...)`). Nothing is written in the state or verify directories on these two refusals.
- A bad `TBI_SIGNUP_VERIFY*` or `TBI_SIGNUP_SITE_URL` value with `TBI_SIGNUP_AUTO_WEB` unset or `excluded`:
  `email verification off (config: ...)`; manual approval keeps working.

**The counter file.** The admin keeps seven days of confirmation-mail records (one address hash and time each,
about 96 bytes) in `verify/mail-counters.json`. Seven rolling days can touch eight calendar days, so at the largest
allowed cap (1000 a day, every mail to a new address) the file holds at most 8,000 entries, about 750 KB. It has its
own read limit of 2 MB (the other per-request state files keep 256 KB), so every allowed cap fits. Old entries are
dropped at each confirmation mail and at the hourly unconfirmed purge. A file that is larger than 2 MB anyway (for
example damaged) is never read and never reset: no confirmation mail is sent (`verify not sent (limit_unreadable)`)
until the file is removed.

Recovery: create the pause file, move `verify/mail-counters.json` out of the state directory (this forgets today's
count and the per-address limits), restart, then resume.

**Approve and resend trust only the admin's own records (verified mode).** A request whose row says the account was
already added (status approved, email failed or email queued, or "account added") but has no approval binding in the
admin verify state gets its account request again before any mail; an account that already exists answers "exists"
and counts as added. Requests approved before verified mode was enabled have no binding: a resend of such a request
sends one more account request (answered "exists") and then the mail. A web request marked "email sent" with no
binding gets the account request and the binding too, sends **no** mail and answers "already approved"; other
requests whose mail was already sent show "already approved" with no account request. If the account request or the
binding fails, or the verify state cannot be read, the owner sees a warning (`unbound_state`: "is marked as
approved, but we have no record that the account was added ..."), nothing is sent, and the log has
`unbound record state refused (<class>)`. Check the person under Testers before you try again.

Resend (or approve) on a request with no binding runs the account add again. This can **re-create an account you
removed**, and the answer `exists` also covers a **disabled** tester. Check Testers first.
This only stops intake logic bugs (a wrong field written to a record). The intake and the admin run as the same unix
user, so a compromised intake can change the admin's state too; no code in the admin protects against that.

### The verify key

A file with at least 32 random bytes, as hex or base64url, not readable by "other". Only the admin service gets it.
It must not be the intake's secret or the mail key. Create it once, as root:

```
sudo test ! -e /etc/tbi-signup/verify.key && sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/tbi-signup/verify.key'
sudo chown root:root /etc/tbi-signup/verify.key
sudo chmod 0400 /etc/tbi-signup/verify.key
sudo stat -c '%U:%G %a %s' /etc/tbi-signup/verify.key     # expected: root:root 400 65
```

systemd hands the service a private copy (`LoadCredential` below), so the source file stays root-only. Never print
the key, put it in an environment variable or copy it into a repository.

**Rotation** (RED zone; the restart also resets the auto-approve cut-off, see Pause and resume):

1. Copy the current key to `/etc/tbi-signup/verify.key.prev` (same owner and mode), then write a new `verify.key`.
2. Add `LoadCredential=verify.key.prev:/etc/tbi-signup/verify.key.prev` to the drop-in, `daemon-reload`, restart.
3. After at least 24 hours remove that line and the `.prev` file, `daemon-reload`, restart. The code has no time limit
   of its own on `.prev`: it is accepted as long as the service can read it.

Replacing the key without `.prev` (for example after a leak) revokes every unused link
(`verify rejected (key_retired)`). People ask for a new one; the resend limits apply.

### Enable, in this order

Every step is RED zone. Do not leave the public form open between steps: see "Requests that stay manual" below.

1. Pause first: `sudo touch /var/lib/<N>-admin-auto/auto-approve.paused`.
2. Create the verify key (above).
3. Create `/etc/systemd/system/<N>-admin.service.d/signup-verify.conf` (root-owned, 0644). Replace **every**
   placeholder. Keep all these lines in this one file, and remove `auto-approve.conf` if it exists, so that roll back
   is one step.

   ```
   [Service]
   LoadCredential=verify.key:/etc/tbi-signup/verify.key
   Environment=TBI_SIGNUP_VERIFY=1
   Environment=TBI_SIGNUP_VERIFY_KEY_FILE=%d/verify.key
   Environment=TBI_SIGNUP_SITE_URL=https://<SITE_HOST>
   # Only requests created after this time are mailed (and may be deleted as unconfirmed).
   Environment=TBI_SIGNUP_VERIFY_SINCE=<ISO_TIME_WITH_ZONE>
   Environment=TBI_SIGNUP_MAIL_MAX_PER_HOUR=<MAIL_PER_HOUR>
   Environment=TBI_SIGNUP_MAIL_MAX_PER_DAY=<MAIL_PER_DAY>
   Environment=TBI_SIGNUP_MAIL_MAX_PER_30D=<MAIL_PER_30D>
   Environment=TBI_SIGNUP_VERIFY_MAX_PER_DAY=<VERIFY_PER_DAY>
   Environment=TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS=<UNVERIFIED_DAYS>
   Environment=TBI_SIGNUP_AUTO_APPROVE=1
   Environment=TBI_SIGNUP_AUTO_DAILY_CAP=<AUTO_CAP>
   Environment=TBI_SIGNUP_AUTO_WEB=verified
   Environment=TBI_SIGNUP_SUMMARY=1
   ```

4. `sudo systemctl daemon-reload && sudo systemctl restart <N>-admin.service`. Expect `email verification on`,
   `auto-approve on (daily cap N)`, `summary file on` and `auto-approve paused`. There must be no `off (config`,
   `routes disabled`, `verify key unusable`, `verify state dir unsafe` or `mail_caps_missing` line. Check that
   `auto-summary.json` appears in the sign-up store.
5. Proxy: route the two new paths. Intake unit (it never gets the verify key): add `Environment=TBI_SIGNUP_VERIFY=1`
   (works only with `TBI_SIGNUP_WEB=1`; otherwise the new paths stay 404 without a message) and, if wanted,
   `Environment=TBI_SIGNUP_NOTIFY=summary`. Restart the intake.
6. Resume: `sudo rm /var/lib/<N>-admin-auto/auto-approve.paused`. Wait for `auto-approve cut-off recorded` or
   `cut-off reset`.
7. Publish the site with the sign-up page and the confirmation view (precondition 2).
8. Test with an address you own, from sign-up to signing in, before announcing the page.

### Requests that stay manual

Automatic approval needs both the sign-up **and** the confirmation to be later than the auto-approve cut-off. A
restart (so also any change of the drop-in), a resume after a pause, and the other resets listed under
[Pause and resume](#pause-kill-switch-and-resume) move the cut-off to now. After it:

- every request created earlier stays `pending` until you approve it, **also when the person confirms later** and
  also when it was only waiting for the next day's cap;
- the person's page and mail do not tell them this.

So after each restart or pause, review the confirmed requests on the admin sign-up screen. The only exception is the
optional keep window (`TBI_SIGNUP_AUTO_CUTOFF_KEEP_S`, below), which covers short restarts, not pauses.

### What pause stops in this mode

| While `auto-approve.paused` exists | |
|---|---|
| Stops | confirmation mails (first mails and new links); automatic approval |
| Continues | storing sign-ups; recording confirmations; deleting expired and unconfirmed requests; account creation already in progress; sending queued approval mails of requests **you** approved, only if the request was never auto-claimed; your own approve, reject and resend |
| Waits | approval mails of automatically approved requests, queued or about to be sent (also when the pause check itself fails); they are sent after the resume, at the next drain ([What the pause holds](#what-the-pause-holds)) |
| Lost | requests for a new link made while paused are dropped; the person has to ask again |

A request that waited for its first mail during a pause is mailed after the resume, but it stays manual (above). A
long pause can reach the unconfirmed deletion deadline before a mail was ever sent
(`purge unverified never mailed N`). To stop new web sign-ups altogether, set `TBI_SIGNUP_WEB=0` on the intake and
restart it.

### What is deleted, and when

| What | When |
|---|---|
| Unconfirmed web request (record, markers, address marker, verify state) | only with `TBI_SIGNUP_RETENTION_UNVERIFIED_DAYS`: that many days after **creation**, checked hourly, so up to 1 hour early. Only requests created after the verify cut-off. Not while `mails held (mail_caps_missing)`. A request left half-removed by a crash (its web marker already gone) is finished at the next run if it is still pending, unconfirmed and has no account |
| Any request not approved (`pending`, including confirmed and waiting; `rejected`) | within 90 days of creation (`TBI_SIGNUP_RETENTION_PENDING_DAYS`); the purge runs at start and daily |
| Every other request | within 365 days of creation (`TBI_SIGNUP_RETENTION_MAX_DAYS`) |
| Verify state `verify/<id>.json` (token hashes, address hashes, times) | with its request, while verification is on |
| Address hashes and times in `verify/mail-counters.json` | counted for 7 days; removed at the next confirmation mail or hourly unconfirmed purge after that. The admin Delete does not remove them |
| Confirm marker | after the sweep has judged it (kept if the state cannot be read or written) |
| Resend marker | after the sweep has handled it (kept while the mail cap is reached or the state is unreadable) |
| Mail-gate times (`mail-gate.json`, no addresses) | entries older than 30 days dropped at the next send |
| `auto-summary.json` (counts only) | overwritten about once a minute; stays after disabling |

Deleting one person by hand: `docs/alpha/SIGNUP-DATA-DELETION.md`.

### When something fails

| Condition | What happens |
|---|---|
| `verified` mode without the mail caps | `auto-approve off (config: ... needs the mail caps)`; no confirmation mail (`verify mails held (mail_caps_missing)`); resend requests wait; no unconfirmed purge. Links already sent can still be confirmed. Approval mails go only to the address the account was added for (`approval mail refused (addr_changed)`); mails you send by hand are then **not** capped |
| `verified` mode, verification not set up | the sign-up admin is refused: `admin routes disabled (config: TBI_SIGNUP_AUTO_WEB=verified needs TBI_SIGNUP_VERIFY=1 with valid settings)`; no sign-up admin routes, automatic approval or confirmation mail |
| Key missing or bad | `verify key unusable (<class>); verification off`: nothing is sent or confirmed, and the unconfirmed purge does not run |
| State directory unsafe | `verify state dir unsafe (<reason>); verification off` |
| Cut-off file unreadable | `verify cut-off unreadable; nothing minted or verified` |
| Confirmation mail fails | `verify send failed (<class>)`; not retried, the slot stays used |
| Mail cap or provider limit | `mail cap reached (...)`; mails wait |
| Approval mail fails | the request shows a failed mail; resend it from the admin app |

Limits fixed in the code: 3 confirmation mails per address in 7 days, at least 10 minutes apart, 5 per request, at
most 3 unexpired links. A request for a new link that meets one of these limits, or the daily verify cap, is dropped;
the person has to ask again later. A first mail held by the daily or per-address limit is tried again by later sweeps.

### Upgrading from an earlier version

**Confirmation links sent by a version without key ids (before S4a) stop working**
(`verify rejected (key_retired)`). The person asks for a new link; the usual resend limits apply.

### Roll back email-verified mode

1. Create the pause file.
2. Take the sign-up page, or its confirmation view, off the published site, so no new person is told to expect a
   mail.
3. Intake: remove `TBI_SIGNUP_VERIFY` and `TBI_SIGNUP_NOTIFY` (and set `TBI_SIGNUP_WEB=0` to stop web sign-ups),
   restart.
4. `sudo rm /etc/systemd/system/<N>-admin.service.d/signup-verify.conf`, `daemon-reload`, restart the admin service.
   Remove the **whole** file: removing only `TBI_SIGNUP_VERIFY` disables the sign-up admin routes.
5. Review the `pending` requests and approve or reject them by hand.

Consequences:

- Links already sent no longer work.
- Queued approval mails of requests **you** approved are sent without the mail caps and without the address binding,
  also while the pause file exists, unless automatic approval had claimed the request (next item).
- Queued approval mails of automatically approved (or automatically claimed) requests wait while the pause file exists, **as long as
  `TBI_SIGNUP_AUTO_STATE_DIR` is still set** (the unit file of this repository sets it; see
  [What the pause holds](#what-the-pause-holds)). After you remove the pause file they are sent, without the mail
  caps and without the address binding. Reject does not apply to them (their accounts exist): to stop one, delete the
  request in the admin app before you resume.
- The `verify/` directory stays, and deleting a request no longer removes its `verify/<id>.json`. It holds hashes and
  times only; remove the directory by hand if verification will not come back.
- The verify cut-off is stored in `verify/since.json`. **Before enabling again**, set `TBI_SIGNUP_VERIFY_SINCE` to
  the new start time. Otherwise every waiting request since the first enable is mailed, and old unconfirmed ones can
  be deleted.
- Rolling the software back to an older version was not tested with this state.

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
| admin | `TBI_SIGNUP_AUTO_CUTOFF_KEEP_S` | `0`..`3600` seconds; unset or `0` = off. Bad value, or no separate `TBI_SIGNUP_AUTO_STATE_DIR`: sign-up admin routes disabled | **Value not approved (owner decision DEC-38 open).** A restart whose first approving sweep comes within this many seconds of the last one keeps the cut-off. Sweeps run every 60 s, so a value near or below 60 mostly resets. |

- In email-verified mode, put the admin settings of this table in `signup-verify.conf`.
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
- One request already in progress may still finish its account step after the `touch`; its approval mail then waits
  ([What the pause holds](#what-the-pause-holds)). A mail already handed to the provider cannot be stopped. The next
  check stops the sweep.
- While paused, sign-ups are still stored and you approve them by hand (manual mode). The owner alert follows the
  intake's setting (per request, or the summary). Email-verified mode: see
  [What pause stops in this mode](#what-pause-stops-in-this-mode).
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

### What the pause holds

Applicant approval mail follows the pause file whenever the admin unit has `TBI_SIGNUP_AUTO_STATE_DIR` and the
sign-up admin routes are on, **with or without** an auto-approve drop-in or the mail caps.

| Approval mail | Pause file present | Pause check fails, or the directory is unsafe | Setting not set |
|---|---|---|---|
| Automatic approval, sent at once | waits | waits | sent (the sweep itself still checks the pause once per request, see above) |
| Queued mail of an automatically approved request (the minute drain) | waits | waits | sent; with auto-approve on, the drain still reads a pause file in the **store** directory |
| Queued mail of a request you approved that automatic approval never claimed | sent | sent | sent |
| Queued mail of an automatically claimed request that you later approved or resent | waits | waits | sent; with auto-approve on, the drain still reads a pause file in the **store** directory |
| Your own approve and resend in the admin app | as without a pause | as without a pause | as without a pause |

- Your approve or resend itself is not held. If its mail is queued instead of sent (quiet hours, mail cap) and
  automatic approval had claimed the request, the drain holds it while paused.
- After a crash during a pause, check for approved requests with an email attempt but not recorded as sent: no drain
  sends them, so resend them by hand.
- The check runs before an attempt is recorded or a mail slot is reserved, and again right before the send.
- A held mail stays `email_queued`: it is not marked failed or sent, no attempt is counted and no mail slot stays
  used. The account is created as usual. The admin app shows it as queued, with a send time that is already past;
  "resend" does not force it. The drain sends it within about a minute after the resume (after quiet hours).
- The directory must be absolute, pass the same safety checks as for auto-approve (owner, mode, no symlink, parents)
  and be neither the sign-up store nor inside it. Otherwise these mails wait until it is fixed.
- The pause file is read only from that directory. A file in the store directory has no effect while the setting is
  set.
- **Where the setting comes from decides what roll back does.** The unit file of this repository sets it, so removing
  a drop-in keeps it and the pause keeps applying. If a host sets it only in a drop-in, removing that drop-in also
  removes the setting, so **the pause can no longer apply**: queued mails are then sent. Check before you remove a
  drop-in: `systemctl show -p Environment <N>-admin.service` (and `systemctl cat` to see which file sets it). To keep
  the pause, the line must be in the unit file or in a drop-in that stays.
- Admin log lines: `approval mail held (state_dir_unsafe)` and `approval mail held (pause_check_failed)` (each at most
  hourly while such a mail is waiting): check the directory's owner, mode, parents and disk. `approval mail pause check
  not configured (state_dir_unset)` (once per start): the setting is missing. A plain pause logs no line per held mail.

## What to watch in the log (monitoring)

The lines in this section come from the admin service, with the prefix `tbi-admin: signup: `. They contain no ids,
names, addresses or paths. In email-verified mode also watch the lines in
[When something fails](#when-something-fails) (search for `signup: ` without the `auto-approve` filter) and the
intake's `verify refused (<code>)`, `resend refused (<code>)` and `marker failed (<class>)`:

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

In email-verified mode use [Roll back email-verified mode](#roll-back-email-verified-mode) instead.

1. `sudo rm /etc/systemd/system/<N>-admin.service.d/auto-approve.conf`
2. `sudo systemctl daemon-reload && sudo systemctl restart <N>-admin.service`
3. Check that no `auto-approve on` line appears after the restart, and that the status block reports
   auto-approve as off.

- Requests approved automatically stay approved, and their accounts exist. Disable an account by hand in the
  admin app if needed. The sign-up audit log marks those approvals `actor=auto`.
- The directory `/var/lib/<N>-admin-auto` is kept; leave it in place. While the flag is off nothing is approved from
  it, but a pause file in it still holds queued approval mails of automatically approved requests as long as
  `TBI_SIGNUP_AUTO_STATE_DIR` is set ([What the pause holds](#what-the-pause-holds)). To keep them waiting, create the
  pause file before step 1.
- **Turning it on again later:** nothing extra is needed. The first sweep of the new process resets the cut-off to
  now, so requests that arrived while auto-approve was off stay for manual handling. `TBI_SIGNUP_AUTO_SINCE` can
  only move the cut-off later, never earlier.
- Never edit or delete the state file while auto-approve is on. Only root and the admin service user can do it,
  and doing so resets the cap for the day.
