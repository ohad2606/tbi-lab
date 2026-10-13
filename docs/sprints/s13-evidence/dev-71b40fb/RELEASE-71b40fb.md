# Release `71b40fb` (OS-11 + OS-12): staging validation and DEV deployment (2026-10-13)

**PM decision:** "Sprint 13 OS-11 / OS-12 PM Decision".
- Application fixes approved for staged validation.
- Staging GO.
- DEV conditional on staging.
- G1 not authorized; G2 to be prepared.

**Result:**
- Staging passed every mandatory gate.
- DEV deployed and verified.
- **No rollback needed.**
- **Live revision on staging and DEV: `71b40fb033df99789350f6fe07e25934dc347f47`.**

Not done, and not authorized:
- production, merge, tag;
- runtime or firmware lock;
- gate configuration (G1/G2 are proposals only: `docs/ops/GATE-CHANGE-G1-G2.md`);
- alpha policy (inactive on both instances).

## 1. Package and provenance

| Item | Value |
|---|---|
| Commit | `71b40fb033df99789350f6fe07e25934dc347f47` |
| Package | Built **twice** from clean worktrees (`build-package.sh`, `TBI_BUILD_TIME=2026-10-13T12:00:00Z`): **byte-identical**. Manifest sha256 `6aed0f18702eaa39…` (`MANIFEST.sha256`); `verify-build` passed. Read-only copy at `~/tbi-s13-rel/release-71b40fb` |
| Bundles | session-host `26137bd8…`; build-service `fe2a2c50…` and build-job `011f703c…` (**byte-identical to `c3b148b`**) |
| Backend vs the deployed `c3b148b` | No backend source change. `session-host` differs **only** in its embedded commit stamp (verified by normalizing the stamp); the other two bundles are byte-identical |
| Inputs | lock `767d3715fdaaef10`, staging/DEV policy `d43ab503`, alpha policy `f55d14d4` (not installed), Node v24.21.0 |
| Runtime / firmware lock | unchanged: Runtime v2 `b5b34b49cb7e4049`, artifact set `767d3715fdaaef10` |

## 2. Full regression on the candidate code (serial; tests from `b97c620`/`3a97254`, app and backend code = `71b40fb`)

| Suite | Result |
|---|---|
| typecheck, lint | pass |
| unit | **1164 / 1164** |
| e2e (full) | **199 passed, 0 failed**, 22 env-gated skips |
| 12 pinned real-QEMU runtime suites | **81 / 81**; **no fingerprint changed** |
| OS-11 gate tests on the real oauth2-proxy v7.15.4 | **19 / 19**, on 5 consecutive runs (see note) |

**Note:** in the first CI run the gate test had 1/19 failing. The cause was the **test**: random ports collided, so a second proxy failed to bind and that case talked to the first proxy, which had a different configuration. Fixed in `3a97254` (OS-assigned ports; it verifies that its own proxy answers). No product change.

## 3. Compatibility

- The frontend change is app-only.
- The backend API is unchanged: same bundles apart from the stamp.
- New frontend + old host: real-QEMU runs against staging while staging still ran `c3b148b` (the OS-12 visual check) and after the install.
- Old frontend + new host: identical host code.
- DEV order: host, then frontend. Rollback: frontend first.

## 4. Staging (`tbi-s8`)

| Step | Result | Evidence |
|---|---|---|
| B0 backup | **PASS**. `/var/backups/tbi-lab/s13-staging-pre-71b40fb-20261013T083403Z`: 12 files, each byte-equal to live | `B0-hashes.txt` |
| B1 install | **PASS**. `install.sh staging` from a clean worktree of `71b40fb` (`npm ci`), `TBI_S8_POLICY` and `TBI_S8_ARTIFACT_CAP_MB` unset, release runtime; 3.9 s. `/health` = `71b40fb`; bundles = package; **units, policy (`d43ab503`), keys, `runtime.json` unchanged** (the build unit, rendered through the new cap input, is byte-identical); cap 256 | `staging-before.txt`, `staging-after-B1.txt` |
| B2 deployed suites | **PASS**: s11-deployed 6+2 skipped · s8-deployed-policy 7/7 · s8-containment 9/9 · s8-qemu-tasks 2/2 · s8-policy 7/7 · **s13-deployed-security: every check** (stream cap, source limit, isolation, non-blocking shutdown, crash containment, no server text, ownership) · **C-5 N=1 with fault: every criterion**. Policy unchanged afterwards | `B2-RESULTS`, `B2-*.json` |
| B3 real QEMU in a browser | **PASS: 34 tests** (+2 old-host skips). Batch 1, 25/25: export/import, journey EN↔HE, live sliders, pad short, OS-09, P4, Owner Smoke 13/13, **OS-11 sign-in, OS-12 search** (2). Batch 2, 9/9: s12, s11, s6-real incl. determinism. Batches were spaced for the preview plan's session-creation limit | `r71-B3-run*.summary.txt` |
| B5 rollback rehearsal | **PASS**. To `c3b148b` in **1.65 s**, byte-equal to the backup; session check 2/2. Forward in **2.73 s**, equal to B1 and the package; 8 passed + 2 skipped after | `B5.summary.txt`, `staging-*.txt` |

## 5. DEV (dev-lab)

| Step | Result |
|---|---|
| Backup | **PASS**. `/var/backups/tbi-lab/pre-71b40fb-dev-20261013T090424Z`: 9 files byte-equal, both release links recorded; rollback `tools/rollback-dev-71b40fb.sh` (frontend first), prepared first |
| Backend | **PASS**. Release directory from the package bytes (= staging); healthy in **0.87 s**; sandbox users |
| Host checks | **PASS**. Deployed suites 21 passed, 5 skipped (runbook exclusions; same as previous deploys); s13-deployed-security: every check |
| Frontend | **PASS**. `publish-frontend.sh` with the package's build time and `VITE_FEEDBACK_URL` unset: every gate check; **byte-identical to the package (22 files)** |
| Live acceptance (gate internal origin, bounded relay) | Gate C `live-s12` **47/47**. Sprint 13 `live-s13` **38/38** (real QEMU). **OS-11/OS-12 `tools/live-os11-os12.ts` 21/21** |
| Live public gate (anonymous) | JSON requests to `/version.json`, `/runtime/health`, `/build/…`, `/assets/…` → **401, no Set-Cookie, no redirect**; an HTML page load → 302 to Google + **one** CSRF cookie |
| Final state | Only the intended changes: services link, session-host + manifest, frontend link, service PIDs, `/health`. Units, polkit rule, `/etc/tbi` (keys, default policy), runtime and gate (Caddy, oauth2-proxy PIDs) unchanged. No session, QEMU unit, build job, session directory, relay or test process left |

On the first live OS-11/OS-12 run, one check failed. The cause was the **tool**: its own commit check (a plain `fetch` of `/version.json`) was counted as an app request. It is now excluded; the rerun gave 21/21, and every app request carried `application/json`.

**Process note.** A safety check refused my first DEV backup command (a `sudo sh -c` script it could not inspect) before it ran. The backup was redone with individual `sudo` commands; there was no removal in either version.

## 6. Owner verification

`docs/alpha/OWNER-RETEST-OS11-OS12.md`. OS-11 and OS-12 stay **open** until the owner signs it.
