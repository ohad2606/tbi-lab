# DEV deployment: `c3b148b` on dev-lab (2026-10-13)

**PM authorization:** "Overnight Review and Conditional Release Authorization". DEV is a conditional GO, met: staging passed every mandatory gate (`../staging-c3b148b/STAGING-ACCEPTANCE-c3b148b.md`).

Not done, and not authorized: production, merge, tag, infrastructure, DNS/OAuth, runtime or firmware lock, policy (DEV keeps its default policy; **the alpha policy is not active anywhere**), feedback collection. **No rollback was needed.**

## Final DEV state

| Item | Value | Verified by |
|---|---|---|
| Session Host / build service | **`c3b148b11b71c1cb01ff67caf1a8dc3150b279d0`**, 0.10-dev | `/health` |
| Service bundles | `/srv/tbi-lab/services/c3b148b…/` (root, 0644, `MANIFEST.json`): session-host `f9c1af47…`, build-service `fe2a2c50…`, build-job `011f703c…` | **byte-identical to the package and to the staging-validated bundles** |
| Frontend | `/srv/tbi-lab/dev-lab/c3b148b…/` by `publish-frontend.sh`, with the package's `TBI_BUILD_TIME` and `VITE_FEEDBACK_URL` explicitly unset | **byte-identical to the package (22 files)**; `/version.json` = `c3b148b`, dev-lab, clean; the gate serves it byte for byte; the public site is up and gated |
| Runtime / release artifacts | v2 `b5b34b49cb7e4049` / `767d3715fdaaef10`, unchanged | snapshot |
| Units, polkit rule, `/etc/tbi` (keys, policy `d43ab503…`) | **unchanged** (byte-equal to the backup) | `devlab-before.txt` vs `devlab-final.txt` |
| Gate | Caddy and oauth2-proxy: same PIDs, untouched | snapshot |
| Owner data | Projects are browser-local (IndexedDB): the server holds none. The artifact store and the owner's environment were not touched; no format change or migration | — |
| Leftovers | No session, QEMU unit, build job, session directory or relay | step 9 |

## Steps

| # | Step | Result |
|---|---|---|
| 1 | Baseline | `dc1bff8` host and frontend, idle (`devlab-before.txt`) |
| 2 | Backup | **PASS**: `/var/backups/tbi-lab/pre-c3b148b-dev-20261013T055329Z`. 4 units, polkit rule, `/etc/tbi`, both release-link targets; 9 files verified byte-equal (`dev-backup-hashes.txt`). Rollback `rollback-dev-c3b148b.sh` (frontend first) was prepared **before** any change |
| 3 | Artifacts | **PASS**: staging bundles = package; artifact set = the lock |
| 4 | Backend | **PASS**: new release directory from the package bytes (= staging); `services/current` switched; both services restarted together; healthy in **0.98 s**; sandbox users |
| 5 | Host checks | **PASS**: deployed suites (`TBI_S8_INSTANCE=tbi`, restart and stop cases excluded per the runbook) **21 passed, 5 skipped**: same as the `dc1bff8` deployment. **s13-deployed-security: every check** (stream cap 4 + 429, oversize source 413 `source_too_large` with no record, isolation 404, crash contained with the same host PID, no server text, worst `/health` 15 ms while a session ends, nothing left over) |
| 6 | Frontend | **PASS**: `publish-frontend.sh c3b148b…`, all checks (`step6-publish.summary.txt`) |
| 7 | Live acceptance through the gate's internal origin (bounded relay, stopped by PID) | **PASS**: Gate C regression `live-s12` **47/47**; Sprint 13 `live-s13` **38/38** (OS-01…10, P2–P4, deployed frontend commit), real QEMU, in one clean run each |
| 8 | Compatibility and hashes | **PASS**: frontend and host on the same commit; every deployed byte equals the package |
| 9 | Clean-up | **PASS**: nothing left; staging unchanged since its validation |

**Process note.** The auto-mode safety classifier refused the first attempt at step 4, before anything ran. DEV was verified unchanged (snapshot equal to the baseline). Step 4 continued after the owner's "continue".

**Owner retest:** `docs/alpha/OWNER-RETEST-S13.md` on `https://dev-lab.tbi-tech.net`. The version shown at the bottom right is now **`c3b148b`**. Owner acceptance stays OPEN.
