# RC4 packaging gate and release preparation (DEV)

**Status: PREPARED on DEV. Not merged, not deployed, nothing switched on.** Alpha stays on RC3
(`802befe`) until the PM authorizes otherwise. All evidence in this record was produced on the DEV
host (`tbi-lab-srv`) unless it is explicitly marked *imported from Alpha*.

## 1. Source (handoff from Alpha, verified on DEV)

| Check | Result |
|---|---|
| Incremental bundle sha256 | `67e8af9f…af95`: equals the value supplied independently in the PM directive, and `sha256sum -c` passes (both bundles) |
| `git bundle verify` | OK. It requires `802befe` (RC3 = `origin/sprint-13`), which DEV has |
| Refs (imported as `refs/remotes/alpha-s14/*`) | `s14-integration 2e8eb7c`, `s14-acceptance 43bd781`, `s14-diagnostics b2d7b1f`, `s14-report-problem 3155de7`, `s14-active-minutes 1e9edfb`. All five equal the manifest |
| Ancestry | Every component branch has merge base `802befe`. First-parent chain `802befe → cb8a005 → 3299478 → 92dac26 → 2e8eb7c` |
| `92dac26` composition | Re-merging `3299478` and `3155de7` gives tree `f981adc1`, identical to `92dac26`'s tree. Re-merging diagnostics gives `5c861e81` = `3299478^{tree}`. `cb8a005^{tree}` = `43bd781^{tree}` |
| Active Minutes in `92dac26` | **none**: no file, setting or reference. `2e8eb7c` adds only the 11 Active Minutes files |

**RC4 = `92dac26`'s content + this packaging work. `2e8eb7c` is not used.**

## 2. Release-relevant build settings

The RC4 source reads **8** `VITE_*` settings. The ninth `VITE_*` name in the handoff, `VITE_ACTIVITY_ENDPOINT`, belongs to the Active Minutes POC. It is absent from RC4 and is refused by the validator if it appears.

| Setting | RC4 value | Before (RC3 `build-package.sh`) |
|---|---|---|
| `VITE_SIGN_OUT_URL` | `/oauth2/sign_out` | set |
| `VITE_RUNTIME_BASE` | `/runtime` (pinned to the code default) | **inherited** |
| `VITE_BUILD_BASE` | `/build` (pinned to the code default) | **inherited** |
| `VITE_PREVIEW_NAME` | unset (guaranteed) | unset |
| `VITE_STORAGE_NAMESPACE` | unset (guaranteed) | unset |
| `VITE_FEEDBACK_URL` | unset (guaranteed; the external form needs owner approval) | unset |
| `VITE_FEEDBACK_VERSION_PARAM` | unset (guaranteed) | **inherited** |
| `VITE_PROBLEM_REPORTS` | `"0"` (`rc4`) or `"1"` (`rc4-reports`), explicit | **inherited** (did not exist in RC3) |
| `TBI_BUILD_ENV` / `TZ` / `LC_ALL` | `dev-lab` / `UTC` / `C` | set / inherited / inherited |
| `TBI_BUILD_COMMIT` / `TBI_BUILD_TIME` | arguments (commit, fixed time) | arguments |
| Node / npm | `v24.21.0` / `11.19.0`, checked | recorded only |
| Host switch `TBI_REPORTS_DIR` | null in `rc4`; the unit template's path in `rc4-reports` | — |

Two of the previously inherited settings are not harmless defaults. `VITE_BUILD_BASE` and `VITE_RUNTIME_BASE` fall back with `??`, so an empty value inherited from a shell would have produced a build that calls `""` instead of `/build`. The validator therefore forbids empty strings: a setting is either a value or `null` (guaranteed unset).

## 3. What changed in packaging (`deploy/release/`)

- `rc4.release.json` and `rc4-reports.release.json`: the profiles. They are identical except for the two Report a Problem switches, which must agree.
- `dev-lab.release.json` (release `rc4-dev-lab`, added 2026-10-29): DEV-Lab packages. Identical to `rc4.release.json` except `VITE_TBI_ENV="dev"`, which turns on the DEV branding (DEV icons and manifest names, `[DEV]` title, DEV strip and top-bar label; `app/src/environment.ts`). Every other profile pins `VITE_TBI_ENV` to `null`; `release-config.mjs` allows `"dev"` only in a `*-dev-lab` profile, and `check-dist.mjs` fails a package whose DEV markers do not match its profile.
- `release-config.mjs`: validates a profile against the source being built. The build fails on:
  - an unpinned setting, or a pinned setting the source no longer reads;
  - an excluded setting or path (Active Minutes);
  - switches that are not explicit or do not agree;
  - a feedback URL being set;
  - a wrong Node or npm version;
  - a tracked `.env` file.

  It prints the complete build environment and the recorded configuration.
- `build-package.sh`: the successor of `s13-evidence/release/build-package.sh`. That script is kept unchanged as RC3 evidence.
  - It uses the same package layout (`frontend/`, `services/`, `MANIFEST.sha256`, `inputs.sha256`, `COMMIT`, `VERSION`, `BUILD_TIME`, `node.version`). It adds `build-config.json`, `npm.version` and the profile's hash in `inputs.sha256`.
  - `npm ci` and every build run under `env -i` with only `PATH`, `HOME`, `LC_ALL`, `TZ` and the profile.
  - The profile and validator are read **from the commit being built**.
  - There are no hard-coded worktree paths.
- `check-dist.mjs`: checks the built frontend against the profile:
  - no source map lists an Active Minutes module, and no bundle names an excluded setting;
  - no uncompiled `VITE_*` reference remains;
  - the compiled Report a Problem switch equals the profile's value. If the check cannot find the switch, it fails.
- `compare-packages.sh`: the reproducibility gate. It compares two packages file by file, including executables, HTML, CSS, source maps and services, plus the recorded configuration. **There is no exception list.** Every differing file is named with its type, and the comparison fails.
- `tests/release-config.test.mjs`: 10 tests in the default unit suite, so they run in CI.

## 4. Reproducibility (DEV)

Packages were built from commit `c2d1b9698695cdca90630cd8548e5bfbafdba7f4` (the packaging branch before this record), with `TBI_BUILD_TIME=2026-10-18T12:00:00Z`, Node v24.21.0, npm 11.19.0. Each was a fresh worktree with its own `npm ci`, built sequentially on DEV.

| Comparison | Result |
|---|---|
| `rc4` (reports OFF), build 1 vs build 2 | **IDENTICAL**: 26 files, including 8 source maps; manifest `8a3046e407af87a7` |
| `rc4-reports` (reports ON), build 1 vs build 2 | **IDENTICAL**: 26 files, including 8 source maps; manifest `cda57825c9cba0fc` |
| Source path (an earlier commit `c38e021`, two different worktree paths) | IDENTICAL, manifest `332c50dc67e17cab`: the output does not depend on the build path |
| `rc4` vs `rc4-reports` | only the frontend differs (the bundle with the compiled switch, its hash name, `index.html`). The services are identical |
| `verify-build.mjs local`, `check-dist.mjs` | pass for all four packages, and each compiled switch matches its profile |

Service hashes, identical in both profiles: `session-host.mjs a24338d6…`, `build-service.mjs fe2a2c50…`, `build-job.mjs 011f703c…`. The last equals RC3's.

**Remaining nondeterministic files on DEV: none.**

*Imported from Alpha:* the handoff reports 27/28 files identical on `2e8eb7c` with a `.map` differing.
- **That difference was not reproduced on DEV, and its cause is not established.** It was a different commit (it includes Active Minutes) and the old script, which inherited settings.
- DEV has 1 vCPU. A bundler's parallel work can order differently on a multi-core host, so DEV's result does not prove Alpha's.
- **No exception is applied to source maps.** The RC3 exception does not carry over. `compare-packages.sh` has no exception list.
- G2 closes only when the same two-build comparison passes on the Alpha packaging host, with this script, on the merged RC4 commit.

### 4.1 Sprint 16A: the source-map nondeterminism found and fixed

The `verify-on-packaging-host.sh` run on `88a8f51` **failed**: `rc4` was identical, but in
`rc4-reports` the two clean builds differed in one file, `index-*.js.map`. The executable JS was
identical. The cause is two `sourcesContent` entries, the brand PNG modules
(`tbi-lab-logo.png`, `tbi-lab-symbol.png`). Their text is Rolldown's internal placeholder
`import.meta.ROLLDOWN_FILE_URL_<ref>`, and the two reference ids were swapped between the builds.
This is almost certainly the `.map` difference Alpha measured (*imported*), and it means the
earlier identical DEV pairs (§4) were not proof of determinism.

**Fix (`ea60028`, no exception):**
- A build plugin (`app/vite.config.ts`) sets those placeholder entries to `null` after writing. That is allowed by the source map format: the module has no source anyone wrote, and `sources` and the mappings are unchanged.
- `check-dist.mjs` refuses any map that still carries a placeholder (unit-tested).

**Result on `ea60028`:** two complete `verify-on-packaging-host.sh` runs (8 clean builds) on DEV.
- **PASS** both times.
- `rc4` gave manifest `09dd9945fd3080a1` for all four builds.
- `rc4-reports` gave `65f3e95106518529` for all four.
- Each package is 26 files with 8 source maps, and `check-dist` is confirmed for every one.

**Remaining nondeterministic files on DEV: none.** The packaging-host run (§8) is still required,
because a multi-core host may exercise other orderings.

## 5. Quality gates (DEV)

All of these ran on DEV on 2026-10-18, on the RC4 source (`92dac26` content plus `deploy/release/`).

| Gate | Result |
|---|---|
| Typecheck, lint (eslint, prettier, boundaries) | pass |
| Unit (`npm test`) on `92dac26` | **1236 / 1236** (140 files). Alpha's 1275 on `2e8eb7c` *(imported)* includes the Active Minutes tests |
| Release-config tests (new) | 10 / 10 |
| Browser e2e (`test:e2e`, CI fakes) | **235 passed, 0 failed, 22 skipped** |
| Real QEMU, Runtime v2 `b5b34b49cb7e4049` (Session Host of RC4) | **117 / 117 in 20 files**: gate 7, s12-determinism 8, r1-determinism 2, s12-bridge 11, s12-r2 3, s12-r3 4, s12-r2-timing 9, s12-bridge-timing 2, s12-examples 3, r1-examples 2, failures 15, r2-failures 11, r2-acceptance 5, electrical 7, s12-pace 1, s13-pad-short 1, s8-gate 5, s8-policy 7, s8-containment 9, isolation 5 |
| Security | identity, gate and policy suites (unit plus s8 real). GitGuardian passes on #8/#9. `npm audit --omit=dev`: **0 vulnerabilities** |
| CI on #8 and #9 | all three checks pass on each |

**Not hidden:**
- The first real-QEMU run reported **27 failed / 90 passed** (6 files). Every failure was `firmware artifact … is not provisioned`: the DEV runtime home `~/tbi-s12-rt` lacked the R2/R3 test firmware. I assembled a private home `~/tbi-rc4-rt`. It links the same Runtime v2 QEMU and copies all 13 pinned firmware images, each verified by its sha256 against `artifacts.lock.json` (identical to RC3's). The re-run of all 20 files gave 117/117.
- **Skipped (22, not passed):**
  - the `*-real` browser specs (`s6`, `s11`, `s12`, `s13-journey`, `s13-live`, `s13-staging`, `s13-export`), which need a real Session Host, build service and QEMU behind the test gate;
  - `s13-3d-timing`, which is measurement only.

  They belong to staging acceptance (§6 step 3). The deployed suites (`*-deployed*`, `s13-gate-google`) need a deployed host and were not run.
- `npm audit` on dev tooling (not shipped) reports advisories in `tinypool` (critical), `source-map-js` (high) and `@vitest/mocker` (moderate). The lockfile is unchanged since RC3, so they were already present there; they are not fixed here.

**Phase 5 validation, and what covers it:**

| Item | Evidence |
|---|---|
| Authentication | `reports.test`: 401 without a gate identity, spoofed identity headers ignored. s8-gate (real); identity unit suites |
| Report ownership and isolation | `reports.test`: only the owner's own session is associated, with an identical answer otherwise; body fields naming an identity, owner or diagnostics are refused; isolation (real) |
| Durable storage | `reports.test`: 201 only after the 0600 file in a 0700 directory, fsync and rename; a failing file or directory fsync gives 503 and leaves nothing; a full store gives 503 and keeps existing reports |
| Telegram failure | The host holds no messaging token. The alerter is ops tooling outside Git (not on DEV). `reports.test`: a failing log writer (alerter path) never prevents acceptance. **The alerter itself was not tested here** |
| Release switches | host: `TBI_REPORTS_DIR` unset gives 503 and nothing written (`reports.test`). App: only an explicit `1` (`problem-report.test`); the item is absent when off (e2e). Package: `check-dist` confirms the compiled switch for each profile and refuses a mismatch |
| RC3 rollback compatibility | No change to the lockfile, firmware lock, policies, Runtime or `VERSION` (`git diff 802befe 92dac26`). The package layout is RC3's. The host adds only an optional state subdirectory, which RC3 ignores. **A rollback drill on a host was not run (staging, §6)** |

### 5.1 Sprint 16A re-verification (head `f218354`, with the PR #9 review fixes)

| Gate | Result |
|---|---|
| Typecheck, lint | pass |
| Unit | **1249 / 1249** (141 files) |
| Browser e2e (CI fakes) | **235 passed, 0 failed, 22 skipped** |
| **Real-stack browser specs, local stack on DEV** (RC4 Session Host + build service on loopback, Runtime v2 `b5b34b49cb7e4049`, throwaway keys; the preview plays the gate) | **16 passed, 0 failed, 2 skipped**: s6-real 3, s11-real 3, s12-real 3, s13-export 1, s13-journey 2 (EN→HE, HE→EN), s13-live 2, s13-staging (OS-09, P4) 2. Skipped: the two compatibility cases that need an older Session Host (`TBI_S11_EXPECT`/`TBI_S12_EXPECT`) |
| Problem reports on the real host | 401 without a gate identity; 201 with one; file 0600 in a 0700 directory; a spoofed `x-tbi-principal` is ignored (principal derived from the gate subject); one `problem_report` line without description or identity; the CLI lists it |

The local stack is **not staging**: no Caddy, oauth2-proxy, systemd sandbox or deployed policy.
G5's staging run is still required; this shows the RC4 code passes the same specs.

Local stack (DEV, development mode):
```
TBI_IDENTITY_KEY_FILE=k1 TBI_TICKET_KEY_FILE=k2 TBI_RUNTIME_HOME=<rt> TBI_BUILD_LISTEN=127.0.0.1:7420 \
  TBI_BUILD_STATE=… TBI_RUNTIME_JSON=<rt>/qemu-current/runtime.json TBI_ARDUINO_HOME=<rt>/arduino \
  TBI_ARTIFACT_STORE=<store> TBI_BUILD_WORK=… node runtime/builder/dist/build-service.mjs &
TBI_IDENTITY_KEY_FILE=k1 TBI_TICKET_KEY_FILE=k2 TBI_RUNTIME_HOME=<rt> TBI_HOST_PORT=7410 \
  TBI_HOST_STATE=… TBI_ARTIFACTS=<store> node runtime/host/dist/session-host.mjs &
TBI_S6_REAL=1 TBI_S11_REAL=1 TBI_S12_REAL=1 TBI_RUNTIME_PROXY=http://127.0.0.1:7410 \
  TBI_BUILD_PROXY=http://127.0.0.1:7420 npx playwright test -c playwright.app.config.ts app/e2e/*-real.spec.ts
```

## 6. Deployment and rollback plan (NOT authorized: for review)

The RC4 host is a drop-in for RC3:
- same Runtime v2 `b5b34b49cb7e4049`;
- same `package-lock.json`, firmware lock, policies and `VERSION`;
- the only unit-template change is a commented-out line.

The rollback target is the existing RC3 package, unchanged.

1. **Merge** (PM approval): #8, then #9, then the packaging PR, into `sprint-13`, each with green required checks. The RC4 commit `R` is the resulting `sprint-13` head; record it.
2. **Package** `R` twice: `build-package.sh rc4.release.json R …` with the same `T`, then `compare-packages.sh`. It must be IDENTICAL. Repeat on the Alpha packaging host, which has more cores than DEV (§4).
3. **Staging (DEV-Lab / staging host)**, reports OFF (`rc4` profile, no drop-in):
   - install the RC4 host and frontend;
   - acceptance: R-MCU-1 gate, the real-QEMU browser specs (the `*-real` specs), one `session_end` line per session in journald, and `POST /runtime/reports` → 503;
   - roll back to RC3 and confirm the RC3 `/version.json` and the RC3 package checksums;
   - re-install RC4.
4. **Staging, reports ON** (`rc4-reports` package + `reports.conf` drop-in): send a report and confirm the 201, the 0600 file in a 0700 directory and one `problem_report` line. Then take the alerter down and confirm a report is still accepted. Then roll back:
   - switch reports off: the `rc4` frontend, remove the drop-in, restart; the endpoint answers 503 and stored reports are kept;
   - then roll back fully to RC3: RC3 never reads the reports directory, so it is left in place.
5. **Alpha** (separate PM authorization; quiet window, because a host restart ends live sessions):
   - install RC4 with reports OFF;
   - smoke test with the cohort accounts;
   - enabling reports is a separate, later switch (step 4 on Alpha).
6. **Rollback at any point:** reinstall the RC3 package (`802befe`) with the existing RC3 procedure: host bundle, frontend, `daemon-reload`, restart. Nothing in RC4 migrates state.

## 7. Release gates G1–G9 reconciled with the code (DEV)

The gate definitions live in `RC4-RELEASE-GATES.md` on Alpha, **which was not transferred**. Their
names below come from the handoff manifest (*imported*); the status is what DEV can verify in this
source. G6 and G9 are not described in the manifest: their status is unknown here, not passed.

| Gate (manifest) | What the code now provides | Status on DEV |
|---|---|---|
| **G1 / D6**: RC4 SHA through PRs on `sprint-13`, without Active Minutes | #8 → #9 → #10, all draft, CI green; `92dac26`'s composition verified; Active Minutes absent (validator + `check-dist`) | **Open**: needs the merges (PM). The RC4 SHA exists only after them |
| **G2 / D1**: reproducible package, no source-map exception | `compare-packages.sh` (manifest equality, no exception list), `verify-on-packaging-host.sh`, deterministic source maps (§4.1) | **PASS on DEV** after the §4.1 fix (8 builds); **open on the Alpha packaging host** |
| **G3 / D2–D4**: every VITE setting pinned; build script fixed | profiles, `release-config.mjs`, `build-package.sh` (env -i, no npmrc), `check-dist.mjs` | **PASS** (tests 11/11, four DEV packages) |
| **G4 / D5** | not described in the manifest beyond "not written" | **Unknown on DEV** |
| **G5 / D7**: the QEMU-backed E2E specs for S14 | the `*-real` specs | **Local stack on DEV: 16/16 pass** (2 compatibility cases skipped, §5.1); **staging run still open** |
| **G6** | not in the manifest | **Unknown on DEV** |
| **G7, G8 / D9**: RC4 switch and rollback scripts | procedures §6 and §9 (exact commands); no host-changing script was written (deployment scripts are out of DEV's mandate) | **Open**: procedures ready for review; scripts and drills need staging |
| **G9** | not in the manifest | **Unknown on DEV** |

## 8. Packaging-host verification (G2 on Alpha's packaging host)

The DEV result does not prove that a multi-core host reproduces (§4). On the packaging host,
after the merges, and with a clone that has the merged commit `R`:

```
git -C <clone> fetch origin && git -C <clone> status --porcelain        # must be empty
node --version; npm --version                                          # v24.21.0 / 11.19.0
deploy/release/verify-on-packaging-host.sh R /path/to/scratch/rc4-g2
```

It builds `rc4` and `rc4-reports` twice each, in fresh worktrees with their own `npm ci`, at the
commit's own time (the same on every host), and writes `G2-RESULT.txt`: host, CPU count, tools,
manifests, verdict. It installs, deploys and switches nothing. **PASS** requires both profiles
IDENTICAL. On **FAIL** the differing files are named; the package is not released and the cause
is investigated (no exception is granted by this procedure). Then compare the four manifests with
DEV's build of the same `R`: equal manifests across hosts additionally show host independence.

## 9. Drills (staging; commands for review, not executed)

`<N>` is the deployment's instance name in `tbi-session-host.service.in`; `pkg` a package
directory from §8. Each drill ends by checking `/version.json` and the service state.

**A. Install RC4, reports OFF** (`rc4` package): install `services/*.mjs` and `frontend/` exactly as
the RC3 procedure does; no reports drop-in. Check: `/version.json` names `R`; `POST /runtime/reports`
→ 503; one `session_end` line per finished session in journald (`SESSION-DIAGNOSTICS.md`).

**B. Reports ON** (`rc4-reports` frontend + host switch):
```
sudo install -d /etc/systemd/system/<N>-session-host.service.d
printf '[Service]\nEnvironment=TBI_REPORTS_DIR=/var/lib/<N>-runtime/state/reports\n' |
  sudo tee /etc/systemd/system/<N>-session-host.service.d/reports.conf
sudo systemctl daemon-reload && sudo systemctl restart <N>-session-host   # quiet window
```
plus the `rc4-reports` frontend. Check: menu item present; a report → 201 and an id; `stat` 0700 /
0600 owned by the runtime user; one `problem_report` line; with the alerter stopped, a report is
still 201 (Telegram outage).

**C. Reports OFF again**: `rc4` frontend; `sudo rm …/reports.conf && daemon-reload && restart`.
Check: 503; stored reports intact; then purge or delete them (retention, PROBLEM-REPORTS.md).

**D. Roll back to RC3**: reinstall the RC3 package (`802befe`) with the RC3 procedure. Check:
`/version.json` names `802befe`; RC3 checksums; sessions run; the reports directory is ignored.

**E. Forward again to RC4**: drill A. Record times and any session loss for each step.

## 10. Remaining blockers

1. **Merge approval (PM):** #8 → #9 → the packaging PR into `sprint-13`. The RC4 SHA exists only after that, and the packages must be rebuilt from it.
2. **G2 on the Alpha packaging host:** two builds plus `compare-packages.sh` on the merged commit (§4). The source-map difference seen on Alpha is unexplained.
3. **Ops tooling outside Git:** `ops/build-package-alpha.sh` must call `deploy/release/build-package.sh` with a profile instead of the RC3 script. The Telegram alerter is untested here.
4. **Profile decision (PM):** RC4 with reports OFF (`rc4`, recommended for the first install) or ON (`rc4-reports`).
5. **Staging (PM authorization):**
   - the 22 skipped real-stack browser specs;
   - the deployed suites;
   - the RC3 rollback drill;
   - the reports ON/OFF switch drill (§6).
6. `RC4-RELEASE-GATES.md` (on Alpha) was not transferred. G4, G7 and G8 (D5, D9, switch and rollback scripts) are covered here only as a plan (§6), not as scripts.
7. Dev-tooling advisories (`npm audit`, not shipped). They were already in RC3 and are listed for a later dependency update.
