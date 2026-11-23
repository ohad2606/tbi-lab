# TBI-018 s3d: enabling sim metering on staging (CHECKLIST, NOT EXECUTED)

Status: written in slice s3d-6. Nothing here has been run. Enabling metering anywhere is a separate
owner approval (design `S3D-HOST-WIRING-DESIGN.md` §10 R-3, decision O-10); this list is what that
approval would execute on staging first. Alpha follows only after a staging pass, in a maintenance
window. Host names, users and paths below are placeholders (`<n>` = the instance prefix of the unit
template, `<user>` = the Session Host's user).

## 0. Preconditions (all must be true before starting)

- [ ] The owner approved enabling on staging in writing (`directives/`), naming the plan map.
- [ ] Owner decisions answered or explicitly deferred: O-1 (plan source; initial map is every policy
      plan -> `legacy`), O-2, O-3 (new end reasons + `queue_replaced`), O-4, O-5, O-7 (refuse to start
      on a torn/corrupt journal), O-9 (cooldown seed: not implemented, s3c limit accepted?), O-10.
- [ ] Journal retention decided (m11): `.pre-compact` and `.pre-repair` copies are never deleted
      automatically; who deletes them, and when.
- [ ] The app with queue + limit handling (s3d-5) is deployed on staging BEFORE the host (R-2).
- [ ] The staged Session Host bundle contains s3d-6 (boot recovery, refusal exit 78) and the
      repair tool is available on the host as an operator command (see §5; packaging is s3d-7).
- [ ] The installed unit has `RestartPreventExitStatus=78` (template change of s3d-6; re-render and
      install the unit, `systemctl daemon-reload`).
- [ ] Pipeline lock held for the whole procedure; staging state recorded before (TEST-SAFETY).

## 1. Configuration files (prepared, reviewed, not yet referenced by the unit)

- [ ] Plans config JSON, owned by root, readable by `<user>` only, at most 1 MiB:
      `metering.enabled: true`; `sim.leaseMs` equal to the host's `TBI_HOST_LEASE_MS` (default 30000);
      `queue.freeCapMode: "fixed"`; `sim.maxConcurrentPerPrincipal: 1` if any plan has minute caps.
      There is no separate validator yet (s3d-7 candidate): the host's boot checks refuse an
      invalid file with exit 78 and a one-line reason, which is only seen at the restart in §3.
- [ ] Plan map: `TBI_HOST_SIM_PLAN_MAP=preview=legacy,system=legacy` (every policy plan mapped, no
      unknown names; check against the installed policy file).
- [ ] Intervals left at defaults unless measured: beat `floor(leaseMs/3)`, adapter housekeeping
      5000 ms, poll 15 s (`< queue.vanishMs`). Shutdown end wait is 8000 ms (bound 12000,
      `TimeoutStopSec=20`).

## 2. State directory

- [ ] `TBI_HOST_SIM_PLANS_STATE` = an absolute path NOT under another service's state and not the unit's
      `StateDirectory` itself if that one is mode 0770 (the host refuses anything but 0700): use a
      sub-directory, e.g. `/var/lib/<n>-runtime/state/sim`. Created by the host as 0700 when missing;
      an existing one must already be 0700 and owned by `<user>` (mkdir never fixes it).
- [ ] No symlink anywhere in the path. Writable under the unit's sandbox (`ProtectSystem=strict`:
      inside a `StateDirectory` or an explicit `ReadWritePaths=`).
- [ ] Free disk: the journal grows with every open/beat/close (fsync per append); compaction runs at
      boot past 20000 events and keeps a full copy. Check `df` for the copy size.

## 3. Enable (maintenance window on staging; ends live staging sessions)

- [ ] Add the three `Environment=TBI_HOST_SIM_*` lines (config, state, plan map) as a drop-in.
- [ ] `systemctl daemon-reload`, restart the staging Session Host.
- [ ] Expect one stderr line `{"event":"sim_boot","recovered":N,"compaction":"no"|"done"|"copy_failed"}`
      and `listening`. Any `refusing to start` line + exit 78 = the unit stays down (no restart loop):
      go to §6 (rollback) and investigate; never delete the journal.
- [ ] `GET /health` on the health-only socket: `capacity` now has `waiting` and `metered` (counts
      only; no principal, ticket or session id anywhere in the body).

## 4. Smoke (one runtime run under the lock; not part of CI)

- [ ] One session start (201 with `sim`), a run, stop: journal has exactly one `sim_open` and one
      `sim_close` for it; no address, token or ticket in the journal or the journal lines of the host.
- [ ] Capacity full -> second principal gets 202 + position; poll starts after the slot frees.
- [ ] Restart the host while a run is live: the next boot line shows `recovered: 1`; the closing
      `sim_close` has reason `host` and is billed at most one lease past the last journaled beat.
- [ ] Measure the beat-path latency of the fsync per append (m4) and record it.

## 5. Journal problem drill (staging only, on a COPY of the state dir)

- [ ] Simulate a torn tail on a copy: the host refuses (exit 78, unit stays down).
- [ ] Operator repair with the host STOPPED, as `<user>`:
      `repair-main <state dir>` (report only: exit 2 = torn, 3 = corrupt, 0 = clean), then
      `repair-main <state dir> --apply` (writes `sim-journal.log.<UTC>.pre-repair` first, then drops
      the torn last record). Corruption in the middle is never repaired: rollback (§6).
- [ ] Restart: the host boots and closes the recovered session with `host`.

## 6. Rollback (the fast path for any problem)

- [ ] Remove the `TBI_HOST_SIM_*` drop-in, `systemctl daemon-reload`, restart (ends live sessions).
- [ ] The journal and its copies stay where they are; never delete or edit them.
- [ ] The app keeps working against the legacy host (it never receives 202).
- [ ] Restore the recorded staging baseline; release the pipeline lock; report before/after.
