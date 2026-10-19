# RC4 release handoff (DEV, Sprints 16C–16E)

Prepared on DEV (`tbi-lab-srv`), 2026-10-18/19. **Not an Alpha deployment authorization.** Nothing in
this document was run on Alpha; every result below is DEV evidence unless marked *imported*. The
authoritative gate procedure is Alpha's `RC4-RELEASE-GATES.md` **v5** (2026-10-18), now in the
repository as `docs/release/RC4-RELEASE-GATES.md` (sha256
`214910d5cfe90c66772292e7f50295a4f9d25b09242d08e6e71a37cba4cc763d`, byte-identical to the handoff,
`sha256sum -c` OK on DEV). Procedures referred to: `RC4-PACKAGING.md`, `PROBLEM-REPORTS.md`,
`SESSION-DIAGNOSTICS.md`.

## 1. Release identity

| | |
|---|---|
| **RC4 package source commit** | **`71c4ce773f765c107852fe1a222cc17f446779f7`** (`origin/sprint-13`, merge of PR #11). The packages, the DEV deployment and the Alpha bundle are built from this commit |
| Documentation commit | the merge of this PR (#12) on `sprint-13` changes `docs/` only (verified with `git diff --stat`); it is **not** the package commit and needs no rebuild: the package stamps its own source commit (`COMMIT`, `/version.json`, Session Host `/health`) |
| Previous release (RC3, rollback target) | `802befe9867d8370383fc6d28fc3349d95d1063d` |
| Merges (normal merge commits, required CI green on each head, branch protection unchanged) | #8 diagnostics + acceptance → `c4f2642515d1124c24f1be36a0e6316259430f8e`; #9 Report a Problem → `184b5b8e49234cf1553b5875262743ebc069dec3`; #10 packaging → `7e04c4d4c3f91245dce9f7d54d5496c91d1bb3fb`; **#11 runtime end classification → `71c4ce773f765c107852fe1a222cc17f446779f7`** |
| Composition | RC3 + S14 acceptance + diagnostics + Report a Problem + pinned packaging + the F1 fix (§10). **Active Minutes absent** (source, settings and bundle: `release-config.mjs`, `check-dist.mjs`) |
| `7e04c4d` | superseded RC4 candidate (16C/16D); its packages and DEV deployment are replaced by `71c4ce7` |
| Runtime | v2 `b5b34b49cb7e4049` (unchanged from RC3); release artifacts `767d3715fdaaef10` (firmware lock unchanged) |
| Tools | Node `v24.21.0`, npm `11.19.0` (pinned in both profiles) |

## 2. Release configuration

Two profiles, `deploy/release/rc4.release.json` (**default: reports OFF**) and
`rc4-reports.release.json`. Every `VITE_*` setting the source reads is pinned (8); a missing,
extra, empty or excluded setting fails the build.

| Setting | `rc4` | `rc4-reports` |
|---|---|---|
| `VITE_BUILD_BASE` / `VITE_RUNTIME_BASE` | `/build` / `/runtime` (= the source defaults, `app/src/main.tsx`) | same |
| `VITE_SIGN_OUT_URL` | `/oauth2/sign_out` | same |
| `VITE_PROBLEM_REPORTS` | `0` (compiled off, checked in the bundle) | `1` |
| `VITE_FEEDBACK_URL`, `VITE_FEEDBACK_VERSION_PARAM`, `VITE_PREVIEW_NAME`, `VITE_STORAGE_NAMESPACE` | unset | unset |
| Host `TBI_REPORTS_DIR` | unset (endpoint 503) | `/var/lib/<N>-runtime/state/reports` (drop-in) |
| Excluded | `VITE_ACTIVITY_ENDPOINT`; `app/src/usage`, `runtime/usage`, `docs/product/ACTIVE-MINUTES.md` | same |

Note against gates v5 §3: v5 asks for `VITE_BUILD_BASE`/`VITE_RUNTIME_BASE` "unset explicitly
(same-origin defaults)". The profiles pin them to exactly those defaults, so the compiled value is
the same-origin path either way; `check-dist.mjs` proves it is in the bundle. The ninth v5 name,
`VITE_ACTIVITY_ENDPOINT`, is absent from the source and refused in the bundle.

## 3. Packages and reproducibility (gate G2 on DEV)

`deploy/release/verify-on-packaging-host.sh 71c4ce7 <work>`: each profile built twice from clean
worktrees at the commit's committer time `2026-10-19T08:40:21Z`, `env -i`, empty npm configs.

| Profile | Package manifest (sha256 of `MANIFEST.sha256`) | Result |
|---|---|---|
| `rc4` | `51da82d511d4275a01a9bda97346ffc362d9a3cbdb76a9510dec86b0d9aba16a` | 2 builds IDENTICAL, 26 files incl. 8 source maps |
| `rc4-reports` | `c5031212383ea81d8a729a2c0915a5454f4c047b591659c040b3ba291ed33738` | 2 builds IDENTICAL, 26 files incl. 8 source maps |
| `rc4`, planted environment (D2/D4) | `51da82d5…` = the `rc4` package | caller environment with `VITE_ACTIVITY_ENDPOINT`, `VITE_PROBLEM_REPORTS=1`, `VITE_BUILD_BASE`, `VITE_RUNTIME_BASE`, `TBI_REPORTS_DIR` set **and** an `app/.env.local` in the calling checkout: package unchanged |

**No exception list, no source-map exception** (v5 §5 not needed). Per-file hashes:
`rc4-release/MANIFEST-rc4.sha256`, `rc4-release/MANIFEST-rc4-reports.sha256`; inputs:
`rc4-release/inputs-rc4*.sha256`; effective configuration: `rc4-release/build-config-rc4*.json`;
the run: `rc4-release/G2-RESULT-DEV.txt`; all manifest hashes: `PACKAGE-MANIFEST-HASHES.txt`.
Services: `session-host.mjs` `54810c70…` (contains the F1 fix), `build-service.mjs` `fe2a2c50…`,
`build-job.mjs` `011f703c…` (the last two byte-identical to RC3's and to `7e04c4d`'s).

## 4. Verification matrix (DEV, on `71c4ce7`)

Sprint 16E, 2026-10-19. Skipped tests are listed, never counted as passed.

| Area | Result |
|---|---|
| Typecheck, lint (format, boundaries) | pass |
| Unit + domain (`vitest`) | **1252 / 1252** (141 files; includes the 12 release-configuration tests and the 2 new launcher tests) |
| Browser acceptance (fakes, Chromium, `test:e2e`) | **235 passed, 0 failed, 22 skipped**. Skipped: the 18 env-gated real-stack tests (run below) and 4 `s13-3d-timing` measurements (not a regression test, `TBI_3D_TIMING=1` only) |
| Real QEMU, Runtime v2 (`test:runtime`, Session Host bundle rebuilt from `71c4ce7`) | **195 passed, 0 failed, 19 skipped** (44 files). Includes `test:r2` (`r2-failures` 11, `r2-acceptance` 5, `r2-led-bench` 1). Skipped: the five `*-deployed` files (run below against installed instances) and `c5-capacity` (opt-in capacity measurement, `TBI_C5`; its deployed form `c5-deployed` runs below) |
| `test:esp32` (Sprint 1–2 experiment harness) | **19 passed, 1 failed** on the first run; the failure is environmental (**F2**, §10): the closed-loop test refused its pinned flash image because the Gate C tests in the same suite write to that shared file. Rerun of that test alone with a pristine copy (sha `d069fffc…`, the test's own hash check): **1 / 1 pass**. Not shipped code; `experiments/` unchanged since RC3 |
| Deployed suites, staging `tbi-s8` (the `rc4` package installed) | **15 passed, 3 skipped**: policy & admission, R1 examples + command boundary, Sprint 13 security (limits, isolation, shutdown, crash containment), C-5 N=1 60 s. Skipped: Alpha recovery (needs ≥ 3 live sessions; DEV has 1 CPU), 2 old-host compatibility cases. Crash containment now logs `runtime_crashed` (it logged `guest_reset` on `7e04c4d`: F1) |
| Deployed suites, **live DEV** `tbi` | see §6 |
| Browser → real QEMU (the `rc4` package frontend + staging `tbi-s8`, test gate) | **16 passed, 0 failed, 2 skipped**: s6-real 3, s11-real 3, s12-real 3, s13-export 1, s13-journey 2 (EN→HE, HE→EN), s13-live 2, s13-staging (OS-09, P4) 2. Skipped: the 2 compatibility cases that need an older Session Host |
| Failure handling, browser → real QEMU (temporary DEV spec, not committed) | **3 / 3**: QEMU killed (main process) → `runtime_crashed` shown; QEMU killed **control-group-wide** (the F1 trigger) → `runtime_crashed` shown, never `guest_reset`; Session Host restarted → explicit failure; a fresh Run works after each |
| Runtime end classification, real systemd (temporary DEV test, staging) | plain `esp_restart()` → refused before Run (`unsupported_feature`, build feature analysis); a macro-hidden restart reaches QEMU → **`guest_reset`** (exit 0, unchanged); control-group-wide kill → **`runtime_crashed`**, SIGKILL |
| Security (dependencies) | `npm audit --omit=dev`: **0**. Dev tooling only (not shipped, unchanged since RC3): `vitest`/`tinypool` critical, `source-map-js` high, `@vitest/mocker` moderate |
| Authentication | DEV gate: every path incl. `/assets/*`, `/runtime/*`, `/build/*` and `POST /runtime/reports` with a spoofed identity header → 302 to Google. Backends without identity → 401 (sessions, builds, reports) |
| Report ownership & storage | principal from the gate identity only; files 0600 / dir 0700 owned by the runtime user; `problem_report` lines without text or principal; CLI list/show/delete; bidi escaped (unit) |
| Telegram failure isolation | DEV runs **no** alerter: reports are stored and answered 201 without any messaging service. The Alpha alerter (alertd v3) is untested on DEV |
| Secret scan | bundle contents (RC3 history + `802befe..71c4ce7`, 3 137 blobs): no key/token patterns; the only e-mail in the RC3→RC4 diff is synthetic (`b@example.com`) |

## 5. Drills (staging `tbi-s8`, real systemd sandbox, Runtime v2)

Sprint 16C/16D, on `7e04c4d` (the reports, switch and rollback paths are unchanged by #11, which
touches only `runtime/harness/launcher.ts` and its test):

| Drill | Result |
|---|---|
| A. Install RC4, reports OFF | `/health` and `/version.json` name the commit; `POST /reports` 503 (401 without identity) |
| B. Reports ON (drop-in + `rc4-reports` frontend) | EN and HE reports → ids; 0700/0600 `tbi-runtime`; `problem_report` lines; CLI list/show (HE text intact) |
| C. Reports OFF again | 503; the `rc4-reports` frontend shows "Reports cannot be received right now. Your text is kept here" (EN/HE), draft kept; stored reports intact, then deleted with the CLI (retention) |
| D. Roll back to RC3 (`install.sh staging` from `802befe`) | `/health` + `/version.json` `802befe`; `/reports` 404; reports dir ignored; real sessions 5/5 |
| E. Forward to RC4 | 12 s switch; bundles = package; real sessions 3/3 |

Sprint 16E, on the final `71c4ce7` packages (staging backup
`~/tbi-rc4-final/s8-backup-pre-71c4ce7`; staging left on the `rc4` package, reports OFF):

| Drill | Result |
|---|---|
| A. Install, reports OFF | `/health` and `/version.json` name `71c4ce7`; staging bundles = package; `POST /reports` 503 with identity, 401 without |
| B. Reports ON | EN `57V1-ERX8-T87D`, HE `8ENY-36RJ-J3YK` stored; dir 0700, files 0600 `tbi-runtime`; two `problem_report` lines (id, category, blocking, release, app, time only); CLI list; the `rc4` frontend has no Report a Problem action |
| C. Reports OFF again | 503 / 401; the `rc4-reports` frontend shows the EN/HE "cannot be received right now, your text is kept" message; both reports deleted with the CLI, 0 left |
| F1 drills | above (§4): failure handling 3/3, end classification on real systemd |

## 6. Live DEV deployment (authorized; DEV has no external testers)

**DEV-Lab serves `71c4ce7`** since 2026-10-19 10:12 UTC (previously `7e04c4d`, 16D).

- Pre-check: 0 live `tbi-qemu@` sessions. Backup: units, polkit rule, Caddyfile, tmpfiles and
  state in `~/tbi-rc4-final/devlab-backup-20261019T101107Z` (DEV only, with `SHA256SUMS`).
- Services: `/srv/tbi-lab/services/71c4ce7…/` = byte copies of the `rc4` package (+ `MANIFEST.json`,
  `replaces` `7e04c4d`); `current` switched; `install.sh dev-lab` re-rendered the units: **all four
  units and the polkit rule unchanged**. The units bind `services/current` read-only as
  `/opt/tbi-build`, so they run exactly the package bytes.
- Frontend: `/srv/tbi-lab/dev-lab/71c4ce7…/` = the `rc4` package frontend; through the gate's
  internal origin `index.html` and all 21 assets byte-identical, `/version.json` = `71c4ce7`, SPA
  fallback, missing asset 404; public site gated (302 on every path).
- Reports: OFF on DEV (503 with identity, 401 without; no reports directory).
- Deployed suites on live DEV: **15 passed, 3 skipped** (same set as staging); end classification
  on DEV-Lab's real systemd: reset → `guest_reset`, control-group kill → `runtime_crashed`.
- **Rollback (rehearsed 2026-10-19 10:19 UTC):** re-point `/srv/tbi-lab/services/current` and
  `/srv/tbi-lab/dev-lab/current` to `7e04c4d…` (its bundles verified against its `MANIFEST.json`),
  restart `tbi-build tbi-session-host` → host and frontend reported `7e04c4d`; forward again →
  `71c4ce7`. Units are identical for both, so no unit restore is needed; the RC3-era target
  `71b40fb…` remains available with the 16D backup's `tbi-session-host.service`.
- Not done on live DEV: browser runs through the real Google login (needs a person; §9).

## 7. Release gates G1–G9 (v5 §6) and DEV requirements D1–D10 (v5 §8)

| Gate | v5 pass criterion | Status | Evidence / what is left |
|---|---|---|---|
| **G1** source identity | exact SHA, CI links, final diff = reviewed diff | **PASS (DEV)** | `71c4ce7`; merges §1; CI green on every PR head (#8–#11) and 3/3 on the docs PR. D6 PASS (acceptance and diagnostics merged together in #8, then #9, then #10; Active Minutes not merged) |
| **G2** reproducibility | identical incl. `.map`, or §5 | **PASS on DEV; open on the Alpha packaging host** | §3. D1: source-map remedy merged in #10 (`app/vite.config.ts` + `check-dist.mjs` refusal); **D1's CI double-build job is not written** (open, DEV) |
| **G3** switches pinned | all nine; (a) reports off; activity endpoint absent | **PASS (DEV)** | §2, §3. D2 PASS (planted-environment build); D3 PASS in substance: profiles instead of a `--reports` flag, the chosen set is `build-config.json` and the profile file is covered by `inputs.sha256`; D4: a tracked `.env*` is refused (unit test), an untracked one cannot reach the fresh worktree (planted build). **Alpha's `ops/build-package-alpha.sh` (A1) is not updated** |
| **G4** content checks | `verify-build.mjs` (commit, version) + bundle grep | **PASS (DEV)** | every package: `verify-build.log` "all checks passed: 71c4ce7", `check-dist.log` (profile confirmed: no activity code, reports switch = profile, no uncompiled setting, no map placeholder). D5 PASS. To be repeated on Alpha's own packages |
| **G5** regression | typecheck, lint, vitest, app E2E, `test:r2`, `test:esp32`, the 22 env-gated E2E on DEV; 0 failed, skips listed | **PASS on DEV, with one recorded environment failure** | §4. The "22" are 18 real-stack tests (16 passed, 2 old-host compatibility skips) and 4 measurement-only 3D timings (skipped). `test:esp32`: 1 environmental failure (F2) re-run green in isolation; reported here rather than counted as a pass. D7 PASS on DEV. Alpha staging not run |
| **G6** security | gate checks 93 + preview checks 96 before/after on Alpha; live Caddyfile `13397188…`; `/runtime/reports` 401 without identity; diff secret scan; no description/identity in `problem_report` | **Partly (DEV)**; **Alpha checks not run** | DEV: `/runtime/reports` 401 without identity at the backend, 302 through the gate; `problem_report` lines carry no text or principal (unit + drill B); RC3→RC4 diff secret scan clean; gate files unchanged since RC3 (`deploy/dev-lab/Caddyfile`, policies, rate table). Alpha-only: 93/96 checks, live Caddyfile hash (A8) |
| **G7** privacy/retention | §4 decisions recorded | **Decisions recorded (imported, v5 §4/A14)**; DEV parts PASS | 90-day disclosure text unchanged (EN/HE `report.disclosure.retention`), purge tested; `session_end` carries the pseudonymous `who` only. A14: the `rate_event` table and the action names `build-failure`, `build-submit`, `prebuilt-upload`, `session-create` are **unchanged** since RC3 (no diff in `runtime/policy/rate.ts`, policies or call sites). D9: text reviewed; the optional report-hold marker is not implemented |
| **G8** rollback | `rc4-switch.sh` / `rc4-rollback.sh` reviewed, via `maintenance-window.sh`; rc4-pre backup OK | **OPEN (Alpha, D8)** | DEV evidence only: staging drills D/E (RC3 rollback and forward) and the live-DEV rollback (§6). The Alpha scripts are Alpha-only (A3, A9, A10) and are not written; DEV has no copy of `rc3-switch.sh` to model them on |
| **G9** idle + window | no live `tbi-qemu@`, owner-approved window | **OPEN (Alpha)** | checked at switch time on Alpha only |
| D10 / A15 staging isolation | staging with its own users, or the Alpha overlay | **Not implemented (optional)**; finding on DEV | DEV's `install.sh staging` runs `tbi-s8-*` as the live users (`User=tbi-runtime`), exactly the condition A15 describes: on DEV, staging could stop live DEV-Lab sessions. Acceptable on DEV (no external testers); Alpha must use its A15 overlay |

## 8. Alpha handoff (owner carries it; Alpha keeps no GitHub credential)

Files on DEV in `~/rc4-release-handoff-20261019/` (`SHA256SUMS` covers every file):

| File | What |
|---|---|
| `rc4-71c4ce7.incremental.bundle` | git bundle `802befe..rc4-release`, ref `refs/heads/rc4-release` = `71c4ce773f765c107852fe1a222cc17f446779f7` (30 commits; verified on DEV to rebuild the exact commit and tree `767d07e8…` from a clone holding only `802befe`, `git fsck` clean) |
| `RC4-RELEASE-HANDOFF.md` | this document |
| `rc4.release.json`, `rc4-reports.release.json` | the two configuration / feature-switch profiles (also in the bundle) |
| `MANIFEST-rc4.sha256`, `MANIFEST-rc4-reports.sha256`, `inputs-rc4*.sha256`, `build-config-rc4*.json`, `G2-RESULT-DEV.txt`, `PACKAGE-MANIFEST-HASHES.txt` | DEV's package evidence (§3) |
| `RC4-GATE-STATUS.txt` | the §7 gate table as plain text, for the Alpha evidence folder |

No credentials, keys, tester identities, allowlists, logs or production data.

On the Alpha packaging host, as the owner/operator (nothing here is authorized yet beyond
packaging; each deployment step needs the PM's written go):
1. `sha256sum -c SHA256SUMS`; compare the bundle hash with the value reported through a
   separate channel.
2. In the clone holding `802befe`: `git bundle verify rc4-71c4ce7.incremental.bundle`, then
   `git fetch rc4-71c4ce7.incremental.bundle refs/heads/rc4-release:refs/heads/rc4-release`;
   `git rev-parse rc4-release` must print `71c4ce773f765c107852fe1a222cc17f446779f7`.
3. **G2 (reproducibility procedure):** with the pinned Node on `PATH` (A2):
   `deploy/release/verify-on-packaging-host.sh 71c4ce7 <empty work dir>` builds each profile twice
   at the commit's committer time and compares (no exception list); verdict PASS required. With the
   same tools the manifests should also equal DEV's (§3); a mismatch with DEV alone is reported,
   a mismatch between Alpha's own two builds fails G2.
4. **G3/A1:** change `ops/build-package-alpha.sh` to call
   `deploy/release/build-package.sh deploy/release/rc4.release.json <sha> <out> <T>` (and
   `rc4-reports.release.json` for stage (c)); the RC3 script is not used for RC4.
5. **G4:** each Alpha package's `verify-build.log` and `check-dist.log` must pass.
6. **G6, G8, G9 (Alpha-only):** gate checks 93 and preview checks 96 before/after; live Caddyfile
   hash; write and review `rc4-switch.sh` / `rc4-rollback.sh` after RC3's (rollback → `802befe` +
   `alpha-rc4-pre` backup, without `--gate`, through `ops/maintenance-window.sh`); 0 live
   sessions in an owner-approved window.
7. **Staging on Alpha** only through `ops/rc4-staging.sh` with the A15 overlay (staging users,
   `pkcheck` matrix) — never the repository's plain `install.sh staging`.
8. **Deployment order (after authorization):** services (`session-host.mjs` changes;
   `build-service.mjs` and `build-job.mjs` are byte-identical to RC3) → frontend → `/health` and
   `/version.json` = `71c4ce7` → deployed suites → `ops/rc4-readiness-check.sh` (A12). Reports
   stay **OFF** (`TBI_REPORTS_DIR` absent, `rc4` frontend). Stage (c), reports ON, is a separate
   decision: `rc4-reports` frontend + the drop-in of A7, as drill B.
9. **Rollback:** RC3 package `pkg-802befe` and the RC3 procedure (DEV drill D: 5/5 sessions
   after rollback); monitoring needs no change (alertd v3 already RC4-compatible).
10. Return to DEV: `G2-RESULT.txt`, the manifest hashes, the 93/96 logs and the gate decisions.

## 9. Owner acceptance checklist on live DEV (real Google login; cannot be automated)

Not spoofed: DEV's automated checks stop at the gate. Use `https://dev-lab.tbi-tech.net/`, the
allowlisted Google account, a desktop browser; note anything unexpected with the time (UTC).

1. **Login**: open the site in a private window → Google sign-in → back on TBI Lab. `/version.json`
   shows commit `71c4ce7…`.
2. **Projects and persistence**: create a project, rename it, add a part; reload → still there;
   open an example; return to Projects → both listed.
3. **Build / Run / Stop**: in the ESP32 Blink example press Build → "Build ready"; Run → running,
   the LED blinks, serial output appears; Stop → stopped. Run again → a fresh session.
4. **EN and HE**: switch to עברית → layout right-to-left, code editor and serial monitor stay
   left-to-right, the circuit unchanged; switch back to English.
5. **Reports disabled**: the app menu has **no** "Report a problem" item.
6. **Reports enabled (isolated testing only)**: covered on staging `tbi-s8` (drills B/C). Do not
   enable reports on DEV-Lab without a separate decision.
7. **Runtime failure messaging** (optional, needs a shell on DEV): while a session runs,
   `sudo systemctl kill -s KILL 'tbi-qemu@*'` → the app says the simulator stopped unexpectedly
   (not "the firmware requested a chip reset"); Run again works.
8. **Sign out** (account menu) → back to Google sign-in.

## 10. Findings

- **F1 (pre-existing since Sprint 8/13), FIXED in RC4 by #11:** when a session's QEMU unit was
  killed control-group-wide, its exit recorder died too and the user was told "The firmware
  requested a chip reset" (`guest_reset`). The launcher now reads systemd's own record of the main
  process (`ExecMainCode`/`ExecMainStatus`) when the record is missing. Review: 2 files; the two new
  unit tests fail without the fix; the recorded-exit path (legitimate resets) is unchanged; real
  systemd evidence in §5.
- **F2 (test harness, pre-existing, not shipped):** `experiments/gate-c-bridge/src/qemuRuntime.ts`
  hands QEMU the shared pinned image `~/tbi-tools/fw/arduino-gpio-proof-4mb.bin` writable
  (`-drive file=…,format=raw`, no copy), so the Gate C tests rewrite it and the Sprint 1 closed-loop
  test, which checks the image hash, fails afterwards in the same `test:esp32` run. Fix proposal
  (backlog, not done): copy the image per run as `closedLoop.ts` does. Workaround used:
  `TBI_ARDUINO_FLASH=<pristine copy>`.
- Externally sent signals other than SIGKILL do not end QEMU in the sandbox (`PrivatePIDs=yes`
  makes it PID 1 of its namespace); a real crash inside QEMU does. Operators must use SIGKILL to
  kill a runtime by hand.
- The real policy's per-user rate limit applies to repeated browser runs under one identity: test
  runs need distinct synthetic identities.
- Staging isolation on DEV (D10/A15): see §7.

## 11. Known limitations (RC4)

- ESP32 Classic only, DC electronics only; PWM/LEDC, LED dimming and servos are **not** in RC4
  (R4, PR #7, unmerged; its duty-0 bench measurement O-R4-1 is open).
- Chip reset requests from firmware (`esp_restart`) are refused explicitly (`guest_reset`), not
  simulated.
- One CPU per live session; DEV (1 CPU) cannot run the ≥ 3-session recovery test.
- Report a Problem is off by default; enabling it is a separate, recorded decision (A7).
- Source maps ship in the package (deterministic); they are not loaded by the app.
