# Sprint 12 — Runtime v2 staging release plan (Gate B)

**Status:** executed as Gate B (see SPRINT-12-GATE-B.md); steps updated after G-3 (release artifact set) and G-4. B2 runs before B1 (B1 needs
the release artifact set). Dev-lab is untouched.
Executing it needs a separate PM authorization: it deploys a new QEMU runtime and restarts
staging services. Dev-lab (Gate C) is a later, separately approved step.

Evidence for every claim: [SPRINT-12.md](SPRINT-12.md) Part F and `docs/sprints/s12-evidence/`.

## 0. What is released

| Item | Value |
|---|---|
| Branch / commit | `sprint-12` at the commit named in the authorization request |
| QEMU runtime | Runtime v2 = espressif/qemu `40edccac` + patches 0001–0008. The dev-built id on this host is **`b5b34b49cb7e4049`**; the release is provisioned with `provision.sh` (step 2), which must reproduce that id (it is computed from the patch files alone) |
| Bridge | v2: `H tbi-bridge 2 <tick> i2c,pad-func,sched-input` |
| Session Host | v2 host (accepts v1 and v2 runtimes), R2/R3 devices, pacing at real time |
| Build service | capabilities from `runtime.json`; Wire → `requires: ["i2c"]` |
| Frontend | HC-SR04, DHT22, LCD 16×2 I2C parts; three curated examples |
| Fingerprints | Runtime v2 pins (gate: full `95fd9c70…`, boot `d7c5fa5d…`; serial pins unchanged from R1), 50/50 repeated runs |

## 1. Preconditions (checked, read-only, before step 1)

1. PM authorization for this plan, in writing.
2. Sprint 11 Owner Smoke status known (this plan does not depend on it, but does not close it).
3. `git status` clean on `sprint-12`; the commit pushed; `npm ci` and the unit suites green.
4. No staging session live: `systemctl list-units 'tbi-s8-qemu@*'` empty.
5. Disk: ≥ 6 GB free on `/` (QEMU build ≈ 2 GB, deploy scratch ≥ 3 GB, FU-11-2 checks it).

## 2. Steps (the order of SPRINT-12-ARCHITECTURE §5.3)

| # | Action | Command | Verify | Rollback |
|---|---|---|---|---|
| B0 | Backup (Sprint 11 pattern) | `sudo install -d /var/backups/tbi-lab/s12-staging-pre-<UTC>` and copy the four `tbi-s8-*` units, `/etc/tbi-s8/policy.json`, `/srv/tbi-lab/s8-staging/*`, sha256 of each | listing + hashes recorded | — |
| B2 | **Provision Runtime v2 side by side**, in its OWN runtime home (never `~/tbi-s8-rt`: `provision.sh qemu` re-points `qemu-current` there, and staging binds that symlink); then **publish the release artifact set** (G-3): the lock's pinned firmware, verified, into the immutable root-owned `/srv/tbi-lab/release-artifacts/<lock id>/` | `TBI_RUNTIME_HOME=/home/ubuntu/tbi-s12-rt-release runtime/provision/provision.sh all` (≈ 45 min), then `deploy/dev-lab/s8/publish-release-artifacts.sh /home/ubuntu/tbi-s12-rt-release` | `runtime.json`: `runtimeId` = `b5b34b49cb7e4049`, `capabilities` = `["i2c","pad-func","sched-input"]`, not `dev`; every pinned image rebuilt byte-exact (provision refuses host-path images); the set verified | delete nothing; both are inert until bound |
| B1 | **Host v2 on v1 QEMU**: re-run `install.sh staging` from a clean checkout of the release commit (refuses uncommitted changes; rebuilds both bundles, stamps the host with version + commit, renders units, imports the reference images from the release artifact set of this commit's lock — FU-11-1, G-3 — and copies the v1 `runtime.json`, which has no capabilities). Needs B2 first (the artifact set) | `TBI_S8_RUNTIME=/home/ubuntu/tbi-s8-rt/qemu-33e35e4ac5e798d7 deploy/dev-lab/s8/install.sh staging` | `/health` up with `runtime.commit` = the release commit; full Sprint 11 runtime suite with `TBI_S8_INSTANCE=tbi-s8` (T-PROTO-9 on staging); `s8-deployed-policy` **7/7** (sessions on the user's own uploaded image, G-4); an R2/R3 project is refused `unsupported_component` naming the part | restore B0 units/bundles, `daemon-reload`, restart the two staging services |
| B3 | **Switch staging to Runtime v2** (refuses while a session is live; restarts only `tbi-s8-build`) | `deploy/dev-lab/s8/switch-runtime.sh staging /home/ubuntu/tbi-s12-rt-release/qemu-b5b34b49cb7e4049` | prints `OK … in <ms>`; `/health`; runtime suites below | `switch-runtime.sh staging /home/ubuntu/tbi-s8-rt/qemu-current` (printed by B3) |
| B4 | Suites on staging (Runtime v2) | `TBI_RUNTIME_HOME=… TBI_S8_INSTANCE=tbi-s8` runtime suites: gate (Runtime v2 pins), R-MCU-1 (62 full + 30 stressed boot runs), `s12-bridge`, `s12-r2`, `s12-r3`, `s12-determinism`, `s12-examples`, `s12-pace`, Sprint 8–11 suites, `s8-containment`, `s8-policy` (policy restored byte-equal), `s11-deployed`, T-SEC-4..8 | all pass, or each failure recorded and explained | B3 rollback |
| B5 | **Rollback rehearsal** (T-OPS-1) | B3 rollback, then `s11-deployed` + `s8-qemu-tasks` on v1, then B3 again | switch times recorded both ways; suites pass both ways | — |
| B6 | Frontend on staging (if PM wants it here rather than at Gate C) | staging has no frontend of its own; the S12 frontend is checked against the staging host by the real-QEMU Playwright specs (`s11-real`, `s12-parts`) | specs pass; S12 frontend on an S11 host refuses the new parts explicitly (T-E2E-4) | — |
| B7 | C-5 dry run on staging, N = 1..3 | test-only policy override (`maxLiveSessions` 3), restored and verified byte-equal afterwards (the `s8-policy` pattern) | `c5-capacity.runtime.test.ts` reports per N | restore policy from B0 |

**Never during Sprint 12:** dev-lab units, `/srv/tbi-lab/services/current`, dev-lab Caddy or
oauth2-proxy, production, any infrastructure resize.

## 3. Expected durations (this host, 1 vCPU)

B1 ≈ 15 min + suites ≈ 30 min; B2 ≈ 45 min; B3 < 5 s (measured in the rehearsal); B4 ≈ 3 h
(R-MCU-1 alone ≈ 1.5 h); B5 ≈ 20 min; B7 ≈ 30 min. Total ≈ 5–6 h, one working day.

## 4. Known limitations a reviewer should see

- Runtime v2 changes the R1 gate *timeline* fingerprint by two explained mechanisms (flash pads
  7–11 no longer reported as GPIO; pad 5's INPUT configuration re-published once); the guest's
  serial output and timestamps are bit-identical (50/50 runs). Accepted under §5.2.
- The I2C LCD at 5 V with 3.3 V pull-ups is refused (`i2c_logic_level`): it is outside the
  PCF8574's input specification. The curated example runs the module at 4.5 V.
- Capacity: this 1-vCPU host runs about 1–2 paced sessions at real time; C-5 on alpha hardware
  needs the D-1 hardware decision.
