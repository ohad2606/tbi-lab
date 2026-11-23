# TBI-018 s3d: enabling sim metering on staging (CHECKLIST, NOT EXECUTED)

Status: written in slice s3d-6, updated in s3d-7 (repair CLI packaging, drill on a copy, stale lock,
clock check, owner decisions of 2026-11-23). Nothing here has been run. Enabling metering anywhere is a separate
owner approval (design `S3D-HOST-WIRING-DESIGN.md` §10 R-3, decision O-10); this list is what that
approval would execute on staging first. Alpha follows only after a staging pass, in a maintenance
window. Host names, users and paths below are placeholders (`<n>` = the instance prefix of the unit
template, `<user>` = the Session Host's user).

## 0. Preconditions (all must be true before starting)

- [ ] The owner approved enabling on staging in writing (`directives/`), naming the plan map.
- [x] Owner decisions O-1 .. O-11 (design §13) ACCEPTED by the owner on 2026-11-23, among them O-7
      (refuse to start on a torn/corrupt journal) and O-9 = accept the s3c limit: no Free cooldown seed
      from the journal; after a host restart the Free cooldown starts empty (memory only).
- [ ] Journal retention (m11) is STILL AN OPEN OWNER DECISION (D-day1417-2). Proposed wording for the
      owner: "The host and the repair tool never delete journal copies. The operator keeps the last
      N = 3 `.pre-compact` and the last N = 3 `.pre-repair` copies per state directory and deletes older
      ones by hand only, with the host stopped, after checking that the live journal replays (repair
      tool report-only: exit 0); each deletion is written in the ops log (file name, size, date). The N = 3 rule is also tied to a
      dispute/audit window: a copy younger than X days is never deleted, even when it is older than
      the last 3 (X = owner decision)."
      Nothing deletes automatically, and no auto-deletion will be built without a new owner decision.
- [ ] The app with queue + limit handling (s3d-5) is deployed on staging BEFORE the host (R-2).
- [ ] The staged Session Host bundle contains s3d-6 (boot recovery, refusal exit 78), and the repair
      bundle `sim-journal-repair.mjs` built from the SAME commit is installed (mode 0644) in a
      separate operator directory, called `<bundles>` below (preferred: the CLI needs only node and the
      state dir). If it is put in the release directory instead (next to `session-host.mjs`): do it
      under the pipeline lock, record it in the ops log, and repeat it after any release switch or
      rollback. Build:
      `npm run simrepair:build` -> `runtime/plans/dist/sim-journal-repair.mjs` (one self-contained
      file, like `session-host.mjs`; needs no `node_modules`). The release/install scripts
      (`deploy/release/build-package.sh` services/, `deploy/dev-lab/s8/install.sh`) do NOT ship it
      yet (PM/owner decision): until they do, install it by hand as described above.
- [ ] The installed unit has `RestartPreventExitStatus=78` (template change of s3d-6; re-render and
      install the unit, `systemctl daemon-reload`).
- [ ] Pipeline lock held for the whole procedure; staging state recorded before (TEST-SAFETY).
- [ ] Clock / time skew: every journal time (open, beat, close, the per-day split) and every bill comes
      from the host clock, and the journal replay rejects time-inconsistent events (which makes the
      host refuse to start). Before enabling, and again before each restart below: `timedatectl` shows
      `System clock synchronized: yes` with an active NTP service; the host's UTC time matches a
      reference within 1 s. (The per-day split uses the config's `meter.timezone`, default
      `Asia/Jerusalem`, through Node's built-in ICU, not the host's local time zone.) Do not enable while the clock is unsynchronised or was just stepped; never set
      the clock by hand while metering is on. Recovery: if the clock was stepped while metering was on
      and the host then refuses with a corrupt journal (the replay rejects `endAt < openedAt`; repair
      tool exit 3), use the rollback (§6) and investigate; never hand-edit the journal.

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

## 5. Journal problem drill and repair

The repair command (`<node>` = the node binary of the unit's `ExecStart`; one JSON line on stdout with
counts and byte offsets only; exit 0 = clean or repaired, 2 = torn tail found (report only),
3 = corrupt (never repaired), 1 = usage / unusable directory / lock held):

    sudo -u <user> <node> <bundles>/sim-journal-repair.mjs <absolute state dir>           # report only
    sudo -u <user> <node> <bundles>/sim-journal-repair.mjs <absolute state dir> --apply   # repair

Drill first (dry-run on a COPY; the live state directory is never touched during the drill):

- [ ] Make the copy as `<user>`: `install -d -m 0700 <drill dir>` (absolute, no symlink, outside the
      live state dir), then `cp -p <state dir>/sim-journal.log <drill dir>/`. Copy ONLY the journal:
      never `host.lock` / `host.lock.takeover` (a copied lock names the live host's pid, and the tool
      would refuse with exit 1). A copy taken while the host runs may be torn (a write in flight):
      exit 2 on such a copy is expected, so re-copy (or copy with the host stopped). The live
      directory is never at risk.
- [ ] Report only on the copy: exit 0 (`clean`). To compare the event count, run a report-only run on the live state dir with the
      host stopped; otherwise drop the comparison (the `sim_boot` line has no event count).
- [ ] Simulate a torn tail on the copy (append a few bytes without a newline, e.g.
      `printf 'x' >> <drill dir>/sim-journal.log`): report only -> exit 2 (`torn`), the copy unchanged.
- [ ] `--apply` on the copy -> exit 0 (`repaired`), a `sim-journal.log.<UTC>.pre-repair` file appeared
      in the drill dir; report only again -> exit 0. Record the outputs.
- [ ] Optional (staging only, maintenance window): point a stopped staging host at the drill dir and
      check that it refuses with the torn copy (exit 78, unit stays down) and boots after the repair.
      Afterwards, restore and verify: point the host back at the live state dir and check that the
      drop-in names the live state dir (not the drill dir).
- [ ] Remove the drill dir by hand after the record is written (it is a copy, not the journal).
      Before removing, verify that the path equals the recorded drill dir and is not the state dir.

Real repair (only after the host refused with exit 78 and the report says `torn`):

- [ ] Host STOPPED (`systemctl is-active` = `inactive` or `failed`), pipeline lock held, as `<user>`.
- [ ] Report only -> exit 2; then `--apply` -> exit 0. Exit 3 (corruption in the middle) is never
      repaired: rollback (§6) and investigate. Exit 1 "locked": see the stale-lock step below.
- [ ] Restart: the host boots and closes the recovered session with `host`.

Stale lock (`host.lock` holds the pid of the host that owns the state dir):

- [ ] A lock whose pid is gone is taken over automatically by the next host or repair run; do not
      remove it by hand for that. Manual removal is only for a refusal that names it (lock malformed,
      takeover mutex `host.lock.takeover` stale/malformed, or the pid now belongs to an unrelated
      process).
- [ ] Before removing anything, check ALL of: the unit is not active (`systemctl is-active`), no host
      process of `<user>` exists (`pgrep -u <user> -f session-host.mjs` prints nothing), no repair run
      is in progress (`pgrep -u <user> -f sim-journal-repair.mjs` prints nothing), and the pid in the lock (`cat <state dir>/host.lock`) is not a running Session
      Host (`ps -p <pid> -o args=`). A reused pid shows up only as the generic "locked by another host" message, so `ps -p`
      is what tells them apart. Record the lock content in the report.
- [ ] NEVER remove a lock while a host runs or might start (the lock is what keeps two writers off
      one journal). Remove only the named lock file; never the journal or its copies.

## 6. Rollback (the fast path for any problem)

- [ ] Remove the `TBI_HOST_SIM_*` drop-in, `systemctl daemon-reload`, restart (ends live sessions).
- [ ] The journal and its copies stay where they are; never delete or edit them.
- [ ] The app keeps working against the legacy host (it never receives 202).
- [ ] Restore the recorded staging baseline; release the pipeline lock; report before/after.
