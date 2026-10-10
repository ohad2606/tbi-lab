# Gate B preflight (2026-10-10, before any staging change)
| Check | Result |
|---|---|
| Push | origin/sprint-12 = c5ed6c0 (11 commits b8ad8c4..c5ed6c0); tree clean |
| Clean build | provision.sh all into ~/tbi-s12-rt-release from `git archive c5ed6c0`: exit 0; QEMU built 559 s |
| Runtime identity | runtimeId b5b34b49cb7e4049 (= dev id), capabilities [i2c,pad-func,sched-input], 8 patches, no dev flag; binary sha256 b3d1108b4b99ba21 |
| Behaviour of the clean runtime | gate 6/6 (pinned v2 fingerprints), s12-bridge 10/10 (local, in-process) |
| Firmware pins | 6/12 reproduced byte-exact; 6 (TbiR1Scan + 5 S12) differ by unmapped host paths in the pinned images (known since Sprint 7; root cause found: symlinked arduino data dir defeats -ffile-prefix-map). Pinned bytes imported sha-verified from the dev store, per the lock policy |
| Unit suites (clean export, npm ci) | typecheck, lint OK; 118 files, 1010/1010 |
| Staging idle | 0 tbi-s8-qemu@ units |
| Disk | 31 GB free |
| Backup | /var/backups/tbi-lab/s12-staging-pre-20261010T165444Z (units, polkit, /etc/tbi-s8, bundles, runtime prefix, store listing, SHA256SUMS) |
| DEV isolation | dev-lab binds services/current (0487ce6) and the resolved v1 runtime dir, not tbi-s8-rt/qemu-current; baseline snapshot devlab-before.txt |
| Rollback readiness | v1 runtime untouched; switch-runtime.sh prints rollback; B0 restores units/bundles |
