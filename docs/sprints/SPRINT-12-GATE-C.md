# Sprint 12 — Gate C (dev-lab) record

**Status (2026-10-11): DEPLOYED.** dev-lab serves the Gate B release. No release-blocking check
failed, so no rollback was needed. Production is untouched (none deployed); staging is unchanged
since Gate B. No merge, tag or sprint closure. Evidence: [s12-evidence/gate-c/](s12-evidence/gate-c/).

## Deployed identities

| Item | Value |
|---|---|
| Frontend | `ba0f4a6893499b8728e8c902095b19b2be48404c` (`/srv/tbi-lab/dev-lab/ba0f4a6…`; served `/version.json`: environment dev-lab, clean) |
| Session Host | `840bc8aeb52c48b4…`, stamped `ba0f4a6`; `/health` protocol `tbi-lab.session/2`, runtime.commit `ba0f4a6` |
| Build service / build job | `fbdc0b13bcae6f29…` / `011f703c8ce87f47…` |
| Services release | `/srv/tbi-lab/services/ba0f4a6…`: the three bundles are **byte copies of the Gate B staging bundles**, not rebuilt ([MANIFEST.json](s12-evidence/gate-c/MANIFEST.json)) |
| QEMU runtime | v2 `b5b34b49cb7e4049` (`/home/ubuntu/tbi-s12-rt-release/qemu-b5b34b49cb7e4049`, binary `b3d1108b…`, the directory staging binds); `/etc/tbi/runtime.json` capabilities `i2c, pad-func, sched-input` |
| Firmware reference images | release set `767d3715fdaaef10`. The 7 missing ones were imported sha-verified ([imported.txt](s12-evidence/gate-c/imported.txt)); the other 6 were already present |

## Sequence and results

| # | Step | Result |
|---|---|---|
| 1–2 | Baseline | frontend and host `0487ce6`, v1 runtime `33e35e4a`; all four services active; no session ([devlab-before.txt](s12-evidence/gate-c/devlab-before.txt)) |
| 3 | Backup | `/var/backups/tbi-lab/pre-s12-gatec-20261011T141919Z`: 4 units, polkit rule, `/etc/tbi`, both release pointers, store listing ([hashes](s12-evidence/gate-c/backup-hashes.txt)); rollback script [rollback-gatec.sh](s12-evidence/gate-c/tools/rollback-gatec.sh), prepared and not run |
| 4 | Artifact identities | bundles = staging bytes; runtime directory = staging's; release set lock = repo lock |
| 5a | Backend on v1 | the only unit change is `tbi-build.service` +4 lines (the `runtime.json` credential), exactly the template's; `services/current` switched; `tbi-build` + `tbi-session-host` restarted together; `/health` = `ba0f4a6` in 2 s |
| 6a | Checks on v1 | s11-deployed + s8-qemu-tasks: **8 pass**, 2 skipped (they need an S10 host) |
| 5b | Runtime v2 | `switch-runtime.sh dev-lab` in **794 ms** (backup `switch-runtime-tbi-20261011T142154Z`) |
| 6b | Backend checks on v2 | s8-deployed-policy, s8-containment, s11-deployed, s8-qemu-tasks: **21 pass, 0 fail**. 5 skipped: 2 need an S10 host, and 3 were **deliberately excluded** because they stop or restart dev-lab services (stale-health, restarted build service, restarted Session Host); they passed on staging in Gate B ([v2-backend-checks.txt](s12-evidence/gate-c/v2-backend-checks.txt)) |
| 7 | Frontend | `publish-frontend.sh ba0f4a6`: all checks passed, dev-lab serves `ba0f4a6` |
| 8–10 | Real-QEMU browser acceptance on the deployed site (gate origin, EN + HE) | **47/47** ([live-s12.txt](s12-evidence/gate-c/live-s12.txt), [tool](s12-evidence/gate-c/tools/live-s12.mjs), [shots](s12-evidence/gate-c/shots/)). One first-run failure was a script defect: LCD line 1 was compared without trimming the 16-character padding; the screenshot showed the correct text, and the trimmed check passed 7/7 on re-run ([rerun](s12-evidence/gate-c/live-s12-lcd-rerun.txt)) |
| 11 | Staging and production | staging host, bundles, runtime bind and policy as Gate B left them; Caddy and oauth2-proxy untouched since 4 Oct, the Caddyfile serves only `dev-lab.tbi-tech.net`; dev-lab diff = the intended items only ([devlab-after.txt](s12-evidence/gate-c/devlab-after.txt)) |

The live acceptance (47 checks) covered:
- **S12 examples:** distance alarm at 0.5 m → LED off; live change to 0.1 m → LED on, "10.x cm"; back to 1 m → off. The thermo-hygrometer prints 21.5 °C / 55.0 %, then −7.3 °C after a live change. The LCD shows "Hello, ESP32!" and "Up: N s" with the backlight on.
- **S11 examples:** motion → relay and buzzer, released again; night light dark → high, bright → low.
- **Refusals:** the capacitor and the matrix are refused next to the board; the S12 parts are offered.
- **Hebrew:** RTL chrome, Hebrew names for the three new parts, firmware output unchanged, the serial monitor stays LTR, the same electrical result.
- **Limits:** a second user's Run, while one session is live, fails explicitly with `runtime_busy` ("The ESP32 runtime service is busy…"), and the first user is unaffected. Every Stop leaves no session or QEMU behind.
- No page errors.

## Rollback readiness

| Scope | Command | Notes |
|---|---|---|
| Runtime only | `deploy/dev-lab/s8/switch-runtime.sh dev-lab /home/ubuntu/tbi-s8-rt/qemu-33e35e4ac5e798d7` | ≈ 0.8–1 s, rehearsed in Gate B (B5) |
| Frontend only | re-point `/srv/tbi-lab/dev-lab/current` to `0487ce6…` | `publish-frontend.sh` header |
| Full | `docs/sprints/s12-evidence/gate-c/tools/rollback-gatec.sh` | frontend first, then units, `runtime.json`, services link, restart, and removal of the imported reference images; the v1 runtime and the `0487ce6` releases are kept |

## Resources (dev-lab host, 1 vCPU, 3.9 GB)

- tbi-session-host 65.5 MB, tbi-build 116.4 MB, Caddy 31.8 MB, oauth2-proxy 14.4 MB.
- QEMU per session ≈ 66–85 MB.
- Memory available 2.2 GB; disk 22 GB free.

## Capacity: the basis of the C-5 "PASS"

D-2 as worded: "every session p5 rate ≥ 1.0× real time". The harness passes at **p5 ≥ 0.99 over
1 s wall-clock windows**, with the first 30 s excluded. Sprint 12 Part F.4 proposed exactly that
reading (or ≥ 1.0 over 5 s windows) for PM confirmation; **no confirmation is recorded**. Measured
N = 1, paced, mix workload, 150 s ([c5win-n1-mix-paced.json](s12-evidence/gate-c/c5win-n1-mix-paced.json)):

| Window | Count | p5 | Min | ≥ 1.0 | Whole run |
|---|---|---|---|---|---|
| 1 s | 121 | 0.9958 | 0.9876 | 60 | — |
| 5 s | 24 | 0.99952 | 0.99894 | 10 | — |
| run | 1 | — | — | — | sim/wall **0.99999986** |

A paced session runs at exactly 1.0× and its window rates scatter symmetrically around it, so
**p5 ≥ 1.0 is unreachable by construction at any window length**. N = 1 meets the harness
criterion (≥ 0.99, 1 s) and both proposed readings' intent: 0.9958 ≥ 0.99, and 0.9995 at 5 s.
It does not meet the literal 1.0. N = 2 (Gate B: p5 0.87 / 0.94) fails every reading on this host.
**Decision needed:** ratify the operational criterion (recommended: p5 ≥ 0.99 over 1 s windows,
or ≥ 0.995 over 5 s windows).
