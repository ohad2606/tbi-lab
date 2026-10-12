# Sprint 13 staging acceptance: release `dc1bff8` (B0–B6, 2026-10-12)

**PM authorization:** "GO for staging steps B0–B6 of release dc1bff8".

Out of scope, and not done: DEV, production, merge, tag, infrastructure, runtime or firmware-lock changes. Plan: `docs/sprints/SPRINT-13-STAGING-RELEASE.md`. Package: `s13-evidence/release/RELEASE-dc1bff8.md`.

## Final staging state

| Item | Value |
|---|---|
| Instance | `tbi-s8` (staging; not routed by Caddy) |
| Session Host / build service | commit **`dc1bff8c3f1480fd4063e1e77a2c3234b0592e6c`** (`/health` runtime.commit), version `0.10-dev` |
| Bundles (`/srv/tbi-lab/s8-staging`) | session-host `288c2ddc…`, build-service `04052fe3…`, build-job `011f703c…`. **Byte-identical to the reproducible package** (`final-bundles.sha256`) |
| Runtime bound by `tbi-s8-qemu@` | Runtime v2 **`b5b34b49cb7e4049`**, `/home/ubuntu/tbi-s12-rt-release/qemu-b5b34b49cb7e4049`, capabilities `i2c, pad-func, sched-input` (unchanged) |
| Reference images | Release artifact set `767d3715fdaaef10` (unchanged lock) |
| Policy, keys, `runtime.json`, unit files | Byte-equal to B0 (default staging policy `d43ab503…`) |
| dev-lab | **Unchanged**: snapshot before = after (`devlab-before.txt`, `devlab-final.txt`) |
| Leftovers | No session, QEMU unit, build job or relay |

## Steps

| Step | Result | Evidence |
|---|---|---|
| **B0** backup | **PASS**. `/var/backups/tbi-lab/s13-staging-pre-20261012T202319Z`: 4 units, polkit rule, `/etc/tbi-s8` (keys, policy, `runtime.json`), the 3 bundles. 12 files, each verified byte-equal to the live file | `B0-hashes.txt` |
| **B1** install R | **PASS**. `install.sh staging` from a clean worktree of R (`npm ci`), `TBI_S8_RUNTIME` = the Runtime v2 release dir, in 3 s. `/health` = R; bundles = package. Policy, keys, `runtime.json` and units unchanged from B0 | `final-bundles.sha256` |
| **B2** deployed suites (`TBI_S8_INSTANCE=tbi-s8`) | **PASS**: s11-deployed 6 + 2 skipped (as at Gate B) · s8-deployed-policy 7/7 · s8-containment 9/9 · s8-qemu-tasks 2/2 · s8-policy 7/7. Staging policy restored byte-equal to B0 afterwards | `B2-*.summary.txt` |
| **B3** real-QEMU browser (the frontend of R, identical app code; staging through bounded relays stopped by PID) | **PASS: 28/28**, plus 2 skips that apply only to old hosts. Run 1: journey EN→HE and HE→EN, live sliders (night light, distance alarm), pin short EN/HE. Run 1b: OS-09, P4. Run 2: Owner Smoke spec (OS-03/04/06/07/10, EN/HE) 11/11, s12-real 3/3. Run 3: s11-real, s6-real 6/6 | `s13-B3-run*.summary.txt` |
| **B4** electrical checks and diagnostics | **PASS**. On the deployed host: the P2/P3 short flagged, its current not shown (EN/HE); OS-09 `supply_pin` diagnostic and the PCF8574 absolute-maximum row; P4 refused by the real build; curated examples' electrical states (s11-deployed, s12-real, s11-real, s6-real). The deployed host is byte-identical to the package of R, whose engine reproduced `ba0f4a6`'s results on all 38 example cases (release record). Nothing contradicts the approved model contract | as B3; release record |
| **B5** rollback rehearsal | **PASS on the second attempt**. *Attempt 1 did not roll back*: my command expanded `backup/bundles/*` in an unprivileged shell, but the backup is root-only (0700), so the bundles were not copied. The units, polkit rule and `/etc` were copied, and those were identical to R's. `/health` still showed R, which is how the failure was detected; staging stayed healthy, and the session check passed. *Attempt 2* (glob expanded under sudo): rolled back to `ba0f4a6` in **1.34 s**, byte-equal to B0, session check 2/2. Forward to R with `install.sh` from the clean checkout in **3.2 s**: bundles = package, s8-qemu-tasks + s11-deployed 8 passed, 2 skipped | `B5-checks.summary.txt` |
| **B6** report | This record, for the PM's review | — |

**Correction for the rollback runbook.** A restore from a root-only backup must expand file globs as root: `sudo sh -c "cp -p '$B'/bundles/* /srv/tbi-lab/s8-staging/"`. The H6 rehearsal script did not cover the bundles; `RUNBOOK.md` is updated accordingly.

## Owner Smoke and physics on staging

| Item | Deployed evidence (staging on R) |
|---|---|
| OS-01 value control | The Owner Smoke spec (field entry and units in OS-06); the journey's live parameter |
| OS-02 3D first frame | Frontend only, and no GPU here: **the owner's GPU measurement is pending** (target ≤ 2 s, PM D-02) |
| OS-03 live LDR | Owner Smoke OS-03; live sliders on real QEMU (night light) |
| OS-04 overlaps | Owner Smoke OS-04 |
| OS-05 wires over displays | CI on the identical app code (unit and 3D-path tests); no staging-specific behaviour |
| OS-06 HC-SR04 | Owner Smoke OS-06; distance alarm on real QEMU |
| OS-07 inspector overflow | Owner Smoke OS-07, EN/HE, 1400 and 1024 px |
| OS-08 Build/Run | Journey and live specs: Run unavailable until the real build, then Run. Full state matrix in CI (s7) |
| OS-09 LCD VCC/SDA | `s13-staging-real`: dark module, `i2c_wiring` naming GPIO21/SDA/VCC, SDA absolute-maximum row |
| OS-10 palette | Owner Smoke OS-10 ×4: strong armed state, distinct from hover, check mark (non-colour), invalid/valid preview, Escape, tool switch, keyboard; EN and HE |
| P2/P3 | Pin short on real QEMU, EN/HE |
| P4 | Real build reports `drive_strength`; Run refused |

**Owner acceptance remains OPEN** until the owner retests (`docs/alpha/OWNER-RETEST-S13.md`).
