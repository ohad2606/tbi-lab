# Sign-up auto-approve (BETA-G1): owner runbook

Design and behaviour: `docs/plans/BETA-G1-AUTO-APPROVE.md`. This page lists what the owner does. **Nothing here has
been done on any host.** Every step changes a live service, so each one runs only in an interactive session with
the owner's approval.

`<N>` is the instance name (`tbi` for the dev-lab instance of `deploy/dev-lab/s8/install.sh`), so the unit is
`<N>-admin.service` and the control-state directory is `/var/lib/<N>-admin-auto`. Host names, addresses and
other private details are kept in the private ops repository, not here.

## What installing the unit does (and does not do)

- `tbi-admin.service.in` creates the control-state directory through systemd (`StateDirectory=<N>-admin-auto`,
  `StateDirectoryMode=0700`). At every start systemd makes it owned by the admin service user (`tbi-admin`,
  group `tbi-adminio`) with mode 0700, and puts back the owner if it was changed. The intake user cannot write it or
  list it. The admin service can write only there and in the spool (ProtectSystem=strict; no network:
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

   A drop-in survives a reinstall of the unit (`install.sh` rewrites the unit file only). Keep these lines out of
   the unit file itself.
2. `sudo systemctl daemon-reload && sudo systemctl restart <N>-admin.service`
3. Check the log (next section). Expect `auto-approve on (daily cap N)`. On the first sweep, without
   `TBI_SIGNUP_AUTO_SINCE`, expect `auto-approve cut-off recorded (only requests created from now on)`: the
   existing backlog stays for you to handle by hand.
4. The admin app's sign-up screen shows the auto-approve status block (count and cap, paused, cut-off).

If the log says `auto-approve off (config: ...)`, the flag or cap value is wrong. Fix the drop-in and restart.
If it says `auto-approve not started (state dir unsafe: <reason>); manual only`, fix the directory, then
**restart**. Fixing the directory alone does not start auto-approve after a refused start.

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
- Prefer a pause to a rollback for short stops: the daily count and the cut-off stay as they are.

## What to watch in the log (monitoring)

All lines come from the admin service, with the prefix `tbi-admin: signup: `. They contain no ids, names,
addresses or paths:

```
sudo journalctl -u <N>-admin.service --since today | grep 'signup: auto-approve'
```

Alert on (owner action needed or capacity reached):

| Log line | Meaning / action |
|---|---|
| `auto-approve daily cap reached (N); the rest stay pending` | Today's cap is used up. The rest wait for tomorrow or for you. If this happens often, review the cap (pending requests are purged after 90 days). |
| `auto-approve paused` / `auto-approve resumed` | The kill switch changed. Check that it was you. |
| `auto-approve pause check failed (<ERRNO>); treated as paused` | The directory cannot be read. Check the owner and mode. |
| `auto-approve state dir unsafe (<reason>); manual only` | The owner, mode, symlink or parent of the directory is wrong. It resumes by itself once fixed. |
| `auto-approve not started (state dir unsafe: <reason>); manual only` | Same problem at start. Fix it, then restart. |
| `auto-approve counter unreadable (<class>); treated as cap reached` | The state file is corrupt, or (`future_day`) the clock went back. Inspect it before you remove it (removing it resets today's count and the cut-off). |
| `auto-approve retry limit reached (N today); the rest wait` | The account helper keeps failing. Check the helper. |
| `auto-approve could not mark a claimed request (<ERRNO>); ...` | The store write failed. Check the store's disk and permissions. |
| `auto-approve sweep failed (<class>)` | An unexpected sweep error. Read the lines around it. |
| `auto-approve waiting (owner principal not recorded; manual only)` | Record the owner principal. |
| `auto-approve off (config: <reason>)` | The drop-in value is wrong. Auto-approve is off. |

For information only: `auto-approve on (daily cap N)`, `auto-approve processed N`, `auto-approve cut-off recorded`.

## Roll back (turn auto-approve off)

1. `sudo rm /etc/systemd/system/<N>-admin.service.d/auto-approve.conf`
2. `sudo systemctl daemon-reload && sudo systemctl restart <N>-admin.service`
3. Check that no `auto-approve on` line appears after the restart, and that the status block reports
   auto-approve as off.

- Requests approved automatically stay approved, and their accounts exist. Disable an account by hand in the
  admin app if needed. The sign-up audit log marks those approvals `actor=auto`.
- The directory `/var/lib/<N>-admin-auto` is kept. It is inert while the flag is off; leave it in place.
- **Turning it on again later:** the cut-off saved at the first enable is still in the state file. Requests that
  arrived while auto-approve was off would then be approved automatically (within the cap). To keep them for
  manual handling, set `TBI_SIGNUP_AUTO_SINCE` to the time you turn it on again, in the drop-in. Removing the
  state file also moves the cut-off, but it resets today's count as well: do that only on a day with no automatic
  approvals.
- Never edit or delete the state file while auto-approve is on. Only root and the admin service user can do it,
  and doing so resets the cap for the day.
