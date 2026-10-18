# RC4 release handoff (DEV, Sprint 16C/16D)

Prepared on DEV (`tbi-lab-srv`), 2026-10-18. **Not an Alpha deployment authorization.** Nothing in
this document was run on Alpha; every result below is DEV evidence unless marked *imported*.
Procedures it refers to: `RC4-PACKAGING.md` (§8 packaging host, §9 drills), `PROBLEM-REPORTS.md`,
`SESSION-DIAGNOSTICS.md`.

## 1. Release identity

| | |
|---|---|
| **RC4 release commit** | `7e04c4d4c3f91245dce9f7d54d5496c91d1bb3fb` (tree `390e5a37deddb6b50b0cba2ec9a72144c7ca7808`), `origin/sprint-13` |
| Previous release (RC3, rollback target) | `802befe9867d8370383fc6d28fc3349d95d1063d` |
| Merges (normal merge commits, required CI green on each head, branch protection unchanged) | #8 diagnostics + acceptance → `c4f2642515d1124c24f1be36a0e6316259430f8e`; #9 Report a Problem → `184b5b8e49234cf1553b5875262743ebc069dec3`; #10 packaging → `7e04c4d4c3f91245dce9f7d54d5496c91d1bb3fb` |
| Composition | RC3 + S14 acceptance + diagnostics + Report a Problem + pinned packaging. Tree after #9 equals the reviewed candidate base `3bc4b32` (= Alpha's `92dac26` + review commit `03ad2cd`). **Active Minutes absent** (source, settings and bundle: `release-config.mjs`, `check-dist.mjs`). |
| Runtime | v2 `b5b34b49cb7e4049` (unchanged from RC3); release artifacts `767d3715fdaaef10` (firmware lock unchanged) |
| Tools | Node `v24.21.0`, npm `11.19.0` (pinned in both profiles) |

## 2. Release configuration

Two profiles, `deploy/release/rc4.release.json` (**default: reports OFF**) and
`rc4-reports.release.json`. Every `VITE_*` setting the source reads is pinned (8); a missing,
extra, empty or excluded setting fails the build.

| Setting | `rc4` | `rc4-reports` |
|---|---|---|
| `VITE_BUILD_BASE` / `VITE_RUNTIME_BASE` | `/build` / `/runtime` | same |
| `VITE_SIGN_OUT_URL` | `/oauth2/sign_out` | same |
| `VITE_PROBLEM_REPORTS` | `0` (compiled off, checked in the bundle) | `1` |
| `VITE_FEEDBACK_URL`, `VITE_FEEDBACK_VERSION_PARAM`, `VITE_PREVIEW_NAME`, `VITE_STORAGE_NAMESPACE` | unset | unset |
| Host `TBI_REPORTS_DIR` | unset (endpoint 503) | `/var/lib/<N>-runtime/state/reports` (drop-in) |
| Excluded | `VITE_ACTIVITY_ENDPOINT`; `app/src/usage`, `runtime/usage`, `docs/product/ACTIVE-MINUTES.md` | same |

## 3. Packages and reproducibility (gate G2 on DEV)

`deploy/release/verify-on-packaging-host.sh 7e04c4d <work>`: each profile built twice from clean
worktrees at the commit's committer time `2026-10-18T18:05:32Z`, `env -i`, empty npm configs.

| Profile | Package manifest (sha256 of `MANIFEST.sha256`) | Result |
|---|---|---|
| `rc4` | `78ad69fc87de51afd36af5bf5f8143902710dc8576a63e23942d63903d940fd0` | 2 builds IDENTICAL, 26 files incl. 8 source maps |
| `rc4-reports` | `712379d248b429e1c93ea96db7dd92e93ead267fbe4549288ec43103a53d4823` | 2 builds IDENTICAL, 26 files incl. 8 source maps |

**No exception list, no source-map exception.** Per-file hashes: `rc4-release/MANIFEST-rc4.sha256`,
`rc4-release/MANIFEST-rc4-reports.sha256`; inputs: `rc4-release/inputs-rc4.sha256`; the run:
`rc4-release/G2-RESULT-DEV.txt`. The two profiles share `services/*` byte for byte
(`session-host.mjs` `a62e516f…`, `build-service.mjs` `fe2a2c50…`, `build-job.mjs` `011f703c…`; the
last two are byte-identical to RC3's). The frontends differ only where the switch is compiled.

## 4. Verification matrix (DEV, on `7e04c4d`)

| Area | Result |
|---|---|
| Typecheck, lint (format, boundaries) | pass |
| Unit + domain (`vitest`) | **1250 / 1250** |
| Release configuration tests | 12 / 12 (pins, exclusions, switch agreement, fail-closed git check, compiled switches, map placeholders) |
| Browser acceptance (fakes, Chromium) | **235 passed, 0 failed, 22 skipped** (the 22 are the real-stack specs, run below) |
| Real-QEMU runtime suite (Runtime v2) | **195 passed, 0 failed, 19 skipped** (44 files). Skipped: the six `*-deployed` / capacity files, run separately against installed instances below |
| Deployed suites, staging `tbi-s8` (RC4 package installed) | **15 passed, 3 skipped**: policy & admission, R1 examples + command boundary, Sprint 13 security (limits, isolation, shutdown, crash containment), C-5 N=1 60 s. Skipped: Alpha recovery (needs ≥ 3 live sessions; DEV has 1 CPU), 2 old-host compatibility cases |
| Deployed suites, **live DEV** `tbi` (RC4 deployed, §6) | **15 passed, 3 skipped** (same set) |
| Browser → real QEMU (package frontend + staging `tbi-s8`, test gate) | **16 passed, 2 skipped** (old-host compatibility): blink, input echo, determinism, R1/R2 examples, LCD, DHT22, HC-SR04, live input, journey EN↔HE, export/import, OS-09 miswiring, P4 unsupported |
| Failure handling, browser → real QEMU | QEMU killed → `runtime_crashed` shown; Session Host restarted → `session_lost` shown; fresh Run works after both; no QEMU left |
| Security (dependencies) | `npm audit --omit=dev`: **0**. Dev tooling only (not shipped, unchanged since RC3): `tinypool` critical, `source-map-js` high, `@vitest/mocker` moderate |
| Authentication (DEV gate, unauthenticated) | every path incl. `/assets/*`, `/runtime/*`, `/build/*`, `POST /runtime/reports` (spoofed header) → 302 to Google |
| Authentication (backends) | no identity → 401 on sessions, builds, reports |
| Report ownership & storage | principal derived from the gate identity only; files 0600 / dir 0700 owned by the runtime user; one `problem_report` line (no text, no principal); CLI list/show/delete; bidi escaped (unit) |
| Telegram failure isolation | DEV runs **no** alerter: reports are stored and answered 201 with no messaging service (the report path never depends on it). The Alpha alerter itself is untested on DEV |
| Diagnostics | one `session_end` line per terminal session (19/19 in the browser run) |

## 5. Drills (staging `tbi-s8`, real systemd sandbox, Runtime v2)

| Drill | Result |
|---|---|
| A. Install RC4, reports OFF | `/health` and `/version.json` name `7e04c4d`; `POST /reports` 503 (401 without identity); browser suite as §4 |
| B. Reports ON (drop-in + `rc4-reports` frontend) | EN and HE reports → ids; 0700/0600 `tbi-runtime`; `problem_report` lines; CLI list/show (HE text intact) |
| C. Reports OFF again | 503; the `rc4-reports` frontend shows "Reports cannot be received right now. Your text is kept here" (EN/HE), draft kept; stored reports intact, then deleted with the CLI (retention) |
| D. Roll back to RC3 (`install.sh staging` from `802befe`) | `/health` + `/version.json` `802befe`; `/reports` 404; reports dir ignored; real sessions 5/5 (blink, input echo, determinism, journey EN↔HE) |
| E. Forward to RC4 | 12 s switch; bundles = package; real sessions 3/3 |

## 6. Live DEV deployment (Sprint 16D, authorized)

- Backup: units, polkit rule, Caddyfile, tmpfiles and state in `~/tbi-rc4-final/devlab-backup-20261018T194504Z` (DEV only).
- Services: `/srv/tbi-lab/services/7e04c4d…/` = byte copies of the `rc4` package (+ `MANIFEST.json`, `replaces` 71b40fb); `current` switched; units re-rendered by `install.sh dev-lab` from the RC4 templates (only change: the commented reports line and `TBI_HOST_MAX_SESSIONS=4`, equal to the code default).
- Frontend: `/srv/tbi-lab/dev-lab/7e04c4d…/` = the `rc4` package frontend; through the gate's internal origin `index.html` and all 21 assets byte-identical, `/version.json` = `7e04c4d`, SPA fallback, missing asset 404; public site gated (302).
- Reports: OFF on DEV (503, no directory).
- **Rollback (DEV):** re-point `/srv/tbi-lab/services/current` and `/srv/tbi-lab/dev-lab/current` to `71b40fb…`, restore the backed-up `tbi-session-host.service`, `daemon-reload`, restart `tbi-build tbi-session-host`.
- Not done on live DEV: browser runs through the real Google login (needs a person; checklist §9).

## 7. Release gates G1–G9

`RC4-RELEASE-GATES.md` (Alpha, v4) is **not on DEV** (not in the handoff of 2026-10-18 nor the
repository). Gate names come from the handoff manifest (*imported*); unknown gates stay unknown.

| Gate | Status on DEV |
|---|---|
| G1 / D6: RC4 SHA through PRs, no Active Minutes | **PASS**: `7e04c4d` |
| G2 / D1: reproducible packages, no source-map exception | **PASS on DEV**; **open on the Alpha packaging host** (§8) |
| G3 / D2–D4: settings pinned, build script fixed | **PASS** |
| G4 / D5 | **UNKNOWN** (definition not transferred) |
| G5 / D7: QEMU-backed E2E for S14 | **PASS on DEV staging and live DEV backends** (§4); Alpha staging not run |
| G6 | **UNKNOWN** (not in the manifest) |
| G7, G8 / D9: switch and rollback | **Drills A–E PASS on DEV staging**; Alpha's own scripts/wrapper not written on DEV |
| G9 | **UNKNOWN** (not in the manifest) |

## 8. Alpha handoff (owner carries it; Alpha keeps no GitHub credential)

Files on DEV in `~/rc4-release-handoff-20261018/`: `rc4-7e04c4d.incremental.bundle` (prerequisite
`802befe`, ref `refs/heads/rc4-release` = `7e04c4d`), this document, the two per-file manifests,
`PACKAGE-MANIFEST-HASHES.txt`, `SHA256SUMS`. No secrets, keys, identities or tester data: the
bundle's tree was scanned (key/token patterns: none; e-mail and principal strings in the RC3→RC4
diff: synthetic only).

On the Alpha packaging host, as the owner/operator:
1. `sha256sum -c SHA256SUMS`; compare the bundle hash with the value reported through a separate channel.
2. In the clone holding `802befe`: `git bundle verify rc4-7e04c4d.incremental.bundle`, then
   `git fetch rc4-7e04c4d.incremental.bundle refs/heads/rc4-release:refs/heads/rc4-release`;
   `git rev-parse rc4-release` must print `7e04c4d4c3f91245dce9f7d54d5496c91d1bb3fb`.
3. `deploy/release/verify-on-packaging-host.sh 7e04c4d <empty work dir>` (G2): verdict PASS required.
   Same tools and arch should also reproduce the DEV manifest hashes in §3; a mismatch with DEV
   alone is reported, a mismatch between Alpha's own two builds fails G2.
4. Update `ops/build-package-alpha.sh` to call `deploy/release/build-package.sh deploy/release/rc4.release.json …` (not the RC3 script).
5. Deployment order (after authorization): services (session host; build service is byte-identical
   to RC3) → frontend → health/version checks → deployed suites; reports stay OFF; RC3 rollback =
   RC3 package with the RC3 procedure (drill D).
6. Return to DEV: `RC4-RELEASE-GATES.md` v4 and the G2 result file.

## 9. Owner checklist on live DEV (Google login; cannot be automated)

Sign in at `https://dev-lab.tbi-tech.net/` with the allowlisted account: Projects load; open an
example; Build; Run → running, LED/serial; Stop; reload keeps the project; switch EN ↔ HE; menu has
no "Report a problem" (reports OFF); Sign out → back to Google.

## 10. Findings (non-blocking)

- **F1 (pre-existing since Sprint 8/13, fix in draft PR #11):** when a session's QEMU unit is killed
  control-group-wide, its exit recorder dies too and the user is told "The firmware requested a
  chip reset" (`guest_reset`). Containment itself works. The fix reads systemd's own record; verified
  on staging (`runtime_crashed`, SIGKILL). Not merged (outside the authorized merges).
- Externally sent signals other than SIGKILL do not end QEMU in the sandbox (`PrivatePIDs=yes`
  makes it PID 1 of its namespace); a real crash inside QEMU does. Operators must use SIGKILL to
  kill a runtime by hand.
- The real policy's per-user rate limit applies to repeated browser runs under one identity: test
  runs need distinct synthetic identities.
