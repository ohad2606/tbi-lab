# H6 — staging restore rehearsal (2026-10-12)

Instance: staging `tbi-s8` (Session Host `ba0f4a6`, Runtime v2). Script:
[restore-rehearsal.sh](restore-rehearsal.sh), log: [rehearsal.log](rehearsal.log) (key-file hash
lines removed).

| Step | Result |
|---|---|
| 1. Backup | `/var/backups/tbi-lab/h6-rehearsal-20261012T105302Z`: 4 units, polkit rule, `/etc/tbi-s8` (keys, policy, `runtime.json`), hashes recorded |
| 2. Damage | `runtime.json` deleted; policy replaced (alpha policy); the build unit's `runtime.json` credential lines removed; services restarted. All three differences detected |
| 3. Restore (from the backup only) | units, rule and `/etc/tbi-s8` copied back, `daemon-reload`, restart: **1.9 s** to a healthy `/health` (`ba0f4a6`) |
| 4. Verify | every unit, key, `policy.json` and `runtime.json` byte-equal to the backup; policy = repository `policy.json`; deployed suites `s11-deployed`, `s8-qemu-tasks`, `s8-deployed-policy`: **15 passed, 2 skipped** (old-host cases) |

Observation: with `runtime.json` missing the build service still starts, with no runtime
capabilities (`runtime/builder/main.ts`: every capability-gated facility stays unsupported, e.g.
Wire is refused). That is fail-closed. The runbook's health checks therefore include the
`runtime.json` id.
