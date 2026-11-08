# RC4 release gates — verification procedure (Alpha host)

Edition: **v5, 2026-10-18** (Sprint 16D: §4 retention decisions now in force, §9 A14 retention and A15 staging
isolation, §8 D10, §10 status; v4 = `RC4-RELEASE-GATES.md.v4` (16C: G6 Caddyfile baseline, §7 monitoring v3, §9, §10),
v3 = `.v3`, v2 = `.v2`).
Status: **reviewed procedure, RC4 NOT authorized** (2026-10-16; coverage re-verified and DEV list added in Privacy & Operations Hardening, Phase 5).
Nothing here is executed against Alpha until the PM authorizes RC4. Every gate must pass; a failure stops the
release and is reported. Skipped tests are listed as skipped, never counted as passed.

## 1. Source-map nondeterminism (the known defect)

- **What:** the frontend bundler (Rolldown, via Vite) emits asset virtual modules for imported images. In
  `frontend/assets/index-*.js.map`, the `sourcesContent` of `src/assets/brand/tbi-lab-logo.png` and
  `tbi-lab-symbol.png` contains placeholders `import.meta.ROLLDOWN_FILE_URL_<id>` whose ids swap between two
  builds of the same commit (parallel asset emission order). `mappings`, `sources`, `names` are identical.
- **History:** found in RC3; RC3 shipped under a PM exception **granted for RC3 only**.
- **Measured for the RC4 candidate (2026-10-16, local only):** two clean packages of local integration commit
  `2e8eb7c` (S14 merged on `802befe`; not the final RC4 SHA): 27/28 files identical, the `.map` differs exactly
  as above, manifest without `.map` identical (`e3d65e70…` both). Evidence `~/tbi-alpha-rel/pkg-s14int-{a,b}/`.
  **The defect is still present; RC4 fails G2 today.**
- **Impact:** none on executed code (source maps are not loaded by the app); it breaks the "same commit → same
  bytes" release property, which is what lets us prove the deployed package is the reviewed one.

## 2. Executable-artifact reproducibility requirements

For the exact RC4 SHA, two packages built in fresh worktrees with the same pinned inputs must have:
1. **byte-identical executable artifacts:** every `frontend/**/*.js`, `*.css`, `*.html`, assets, and
   `services/{session-host,build-service,build-job}.mjs` — no exception is possible for these;
2. identical `inputs.sha256` (lock file, firmware artifact lock, both policies), `node.version` = v24.21.0,
   same `BUILD_TIME`, same `COMMIT`;
3. identical `MANIFEST.sha256` **including** `.map` files — or the conditional exception in §5.

## 3. Required build-switch pinning (gate G3)

`ops/build-package-alpha.sh` today pins only `VITE_SIGN_OUT_URL` (set) and `VITE_PREVIEW_NAME`,
`VITE_STORAGE_NAMESPACE`, `VITE_FEEDBACK_URL` (unset). The app reads **nine** switches at `2e8eb7c`; five are
inherited from the operator's environment:

| Switch | In RC3 | Pinned today | Required for RC4 package (a) |
|---|---|---|---|
| `VITE_SIGN_OUT_URL` | yes | set `/oauth2/sign_out` | unchanged |
| `VITE_PREVIEW_NAME`, `VITE_STORAGE_NAMESPACE`, `VITE_FEEDBACK_URL` | yes | unset | unchanged |
| `VITE_BUILD_BASE`, `VITE_RUNTIME_BASE` | yes | **no** | unset explicitly (same-origin defaults) |
| `VITE_FEEDBACK_VERSION_PARAM` | yes | **no** | unset explicitly |
| `VITE_PROBLEM_REPORTS` (S14) | no | **no** | **unset** (reports off) for stage (a); a separate, separately reproduced package with `=1` for stage (c) |
| `VITE_ACTIVITY_ENDPOINT` (S14 POC) | no | **no** | **unset, never set** on Alpha (POC, no approval) |

Pass: the script sets/unsets all nine (`env -i`-style allowlist preferred, so a future switch cannot leak in);
a bundle grep proves the activity endpoint and (for (a)) the reports menu are absent.

**Coverage review (2026-10-16, Privacy & Operations Hardening, Phase 5):** a repository-wide search at `2e8eb7c`
(all workspaces, `node_modules` and docs excluded) finds exactly these **nine** `VITE_*` names — the table covers
**9/9**. Other build-time inputs: `TBI_BUILD_COMMIT`, `TBI_BUILD_ENV`, `TBI_BUILD_TIME` (pinned by the script);
`TBI_TEST_GATE`, `TBI_RUNTIME_PROXY`, `TBI_BUILD_PROXY` (dev/preview server only, not in the bundle); Vite's
automatic `app/.env*` files (gitignored, absent in the script's fresh worktree, but nothing asserts that).
Services: esbuild `--define` of version and commit only. **Gap today: 5 of 9 not pinned** (unchanged).

## 4. Privacy and retention prerequisites (gate G7)

Before problem reports are enabled (stage c) and before RC4 ships its new log lines:
- `problem_report` journald lines carry id, category, blocking, release, app, time only — never the description
  or identity (S14 tests + bundle/log check in G6);
- report store `TBI_REPORTS_DIR` 0700, files 0600, retention **90 days** = the retention stated in the in-app
  disclosure text (`report.disclosure.retention`); the purge exists in S14 (`runtime/host/reports.ts:289`, tested in
  `runtime/host/tests/reports.test.ts`) and is verified on the host after enabling;
- `session_end` lines carry the 10-char pseudonymous `who` only (as `admission` lines today);
- journald and backup retention decided by the owner (risk R6; inventory `evidence/alpha-hardening2-20261016T0356Z/RETENTION-INVENTORY.md`)
  — **in force since 2026-10-18 (Sprint 16D, PM-approved)**: journal 30 days (`MaxRetentionSec=30day`,
  `MaxFileSec=1day`), rsyslog copies 30 days (daily, rotate 30, maxage 30), stale rate rows expired once (daily
  timer prepared, not enabled), routine backups by operator-reviewed `tbi-retention.py plan/apply/purge` only (A14).
  Consequence for RC4: the daily report's "cumulative" figures become rolling 30-day figures from about 12.11;
- the daily report and alertd keep their privacy rules (no emails, no principals, no report text) — verified
  for monitoring v2 on 2026-10-16.

## 5. The RC4 source-map exception is conditional

An RC3-style exception may be granted for RC4 **only** with fresh RC4 evidence, all of:
1. two packages of the **final RC4 SHA** (not `2e8eb7c`) built per G2, dated, with logs;
2. `diff MANIFEST.sha256` lists **only** `.map` files;
3. a structured JSON diff of each differing `.map` shows differences **only** in `sourcesContent` entries of
   asset virtual modules, only in `ROLLDOWN_FILE_URL_<id>` placeholders;
4. manifests with `.map` lines removed are identical, and every executable file is byte-identical (§2);
5. a written PM decision naming RC4, the files and the hashes. Preferred instead: a DEV fix (remedies below).

## 6. Gates

| # | Gate | Procedure | Pass criterion |
|---|---|---|---|
| G1 | Source identity | RC4 commit = merge commit on `sprint-13` after PRs (acceptance → diagnostics → report-problem); required CI checks green; final diff = reviewed diff | exact SHA recorded; CI links |
| G2 | Reproducibility | fully pinned `build-package-alpha.sh <sha> rc4-a <T>` and `… rc4-b <T>` (same T), fresh worktrees; `diff MANIFEST.sha256` | identical including `.map` — or §5 complete |
| G3 | Build switches pinned | §3 | all nine pinned; (a) reports off; activity endpoint absent |
| G4 | Content checks | `verify-build.mjs` (commit, version), bundle grep | as listed |
| G5 | Regression | on the RC4 SHA: typecheck, lint, full vitest, full app E2E; **plus** QEMU-backed `test:r2`, `test:esp32` and the 22 `*-real` E2E specs on a non-production runtime (DEV) | 0 failed; skipped listed, never counted as passed |
| G6 | Security | gate checks (93) + preview checks (96, base URL `https://lab.tbi-tech.net`) before/after; live Caddyfile = `gate/Caddyfile` (approved link-preview version, sha256 `13397188…`, newer than `rc3-hashes.txt`); `/runtime/reports` → 401 without identity through the gate; secret scan of the diff; no description/identity in `problem_report` lines | all pass |
| G7 | Privacy/retention | §4 | decisions recorded |
| G8 | Rollback | `rc4-switch.sh` / `rc4-rollback.sh` written like RC3's (rollback → `802befe` + `alpha-rc4-pre` backup, **without `--gate`**); both reviewed; invoked through `ops/maintenance-window.sh` (proposal, MAINTENANCE-PROCEDURE.md) | scripts reviewed; rc4-pre backup `SHA256SUMS` OK |
| G9 | Idle + window | no live `tbi-qemu@` units; owner-approved window | 0 sessions at switch |

## 7. Evidence required before RC4 deployment

Folder `~/tbi-alpha-rel/evidence/rc4-<UTC>/` with: G1 SHA + CI links + reviewed-diff hash; both package dirs
(`MANIFEST.sha256`, `inputs.sha256`, build logs) and their diff; §5 analysis if needed; the pinned switch list
and bundle greps; G5 test logs with pass/fail/skip counts; G6 logs (93/96 before and after); G7 decision
references; reviewed switch/rollback scripts and the rc4-pre backup listing; G9 session count at switch time;
the PM's written go. Monitoring after the switch: **alertd v3 (installed 2026-10-18)** understands `session_end` and
`problem_report` and alerts (critical, never muted) on RC4's `problem report storage error` line; RC4 log
compatibility 13/13 against the installed bytes (72 `session_end` lines generated by the RC4 code). No further
monitoring change is needed for RC4. Monitoring rollback is per component (`ops/monitoring-rollback.sh alertd|report`).

## 8. Outstanding requirements for DEV (exact list; none started on Alpha)

| # | Gate | Requirement | Acceptance |
|---|---|---|---|
| D1 | G2 | Make `frontend/assets/index-*.js.map` deterministic (one remedy below) and add a CI job that builds the package twice and compares `MANIFEST.sha256` | two clean builds of the RC4 SHA: identical manifests **including** `.map`; CI job green |
| D2 | G3 | `build-package` (repo `docs/sprints/s13-evidence/release/build-package.sh` and the Alpha copy): run the frontend build under an explicit environment allowlist (`env -i` + PATH/HOME + the nine `VITE_*` set or unset explicitly + `TBI_BUILD_*`) | a planted `VITE_ACTIVITY_ENDPOINT`/`VITE_PROBLEM_REPORTS`/`VITE_BUILD_BASE` in the caller's environment does not change the package |
| D3 | G3 | Parameter `--reports off|on` selecting `VITE_PROBLEM_REPORTS` (default off); the chosen switch set written to `switches.txt` and covered by `inputs.sha256` | package (a) = off, package (c) = on, each reproduced twice |
| D4 | G3 | Refuse to build if any `app/.env*` file exists in the build tree | test with a planted `app/.env.local` → refused |
| D5 | G4 | `verify-build.mjs`: assert no activity-endpoint code path and the reports menu state matching `switches.txt` | fails on a wrong package |
| D6 | G1 | Merge order acceptance → diagnostics → report-problem via PRs on `sprint-13`, required CI green, final diff = reviewed diff; the active-minutes POC **not** merged for RC4 | RC4 SHA recorded |
| D7 | G5 | Full regression on the RC4 SHA incl. QEMU-backed `test:r2`, `test:esp32`, the 22 `*-real` E2E specs on a DEV runtime; skipped tests listed separately | 0 failed; skips listed |
| D8 | G8 | `rc4-switch.sh` / `rc4-rollback.sh` modelled on RC3's (rollback → `802befe` + `alpha-rc4-pre`, without `--gate`), to be invoked through `ops/maintenance-window.sh` | reviewed by PM |
| D9 | G7 | Confirm the in-app 90-day report disclosure text unchanged; optional: a report-hold marker honoured by the 90-day purge | text reviewed |
| D10 | (staging) | Optional, preferred long-term: `install.sh staging` creates and uses its own users (`tbi-s8-runtime`, `tbi-s8-build`) and renders the staging polkit rule for them, so the Alpha overlay (A15) becomes unnecessary; meanwhile full QEMU/browser tests (G5) stay on DEV | installer change reviewed; staging rule grants no live user |

Not a DEV requirement, PM decision: whether an RC4 source-map exception would ever be considered (§5); **no
exception has been granted.**

## Remedies for G2 (DEV, normal PR; pick one)

1. Deterministic asset emission / placeholder ids (bundler option or upgrade with the upstream fix).
2. Post-build normalisation of `sourcesContent` placeholder lines for asset virtual modules.
3. Omit `sourcesContent` for asset virtual modules, or ship Alpha without `.map` files.
Add a CI job that builds twice and compares `MANIFEST.sha256` (P2 follow-up acceptance).

## 9. Alpha-only packaging and deployment dependencies (not in the repository; DEV must not assume them)

| # | Dependency | Alpha location / value | Relevance for RC4 |
|---|---|---|---|
| A1 | Packaging script | `ops/build-package-alpha.sh` (Alpha copy of the repo's `build-package.sh` + Alpha settings) | D2–D4 must be applied to **both** copies; DEV delivers the change as a patch/bundle, Alpha installs it |
| A2 | Pinned Node for packaging | `/opt/tbi-lab/node/v24.21.0` (`PATH` must include its `bin` for vite-node) | `node.version` in `inputs.sha256` |
| A3 | Service runtime Node / services | units run `/opt/tbi-node/bin/node /opt/tbi-build/{session-host,build-service}.mjs`; release dirs `/srv/tbi-lab/services/<sha>`, `/srv/tbi-lab/dev-lab/<sha>`, links `…/current` | `rc4-switch.sh` must follow `rc3-switch.sh` exactly |
| A4 | Simulator runtime | `/opt/tbi-lab/runtime/qemu-b5b34b49cb7e4049` (+ `.SHA256SUMS`), QEMU `/opt/tbi-runtime/bin/qemu-system-xtensa` | unchanged for RC4 |
| A5 | Toolchain | `/opt/tbi-arduino` (profile `esp32-arduino-3.3.12`) | unchanged |
| A6 | Capacity | policy `global.runtime.maxLiveSessions = cpus` (6) via systemd credential; `TBI_HOST_MAX_SESSIONS=6`; preview `maxSessions 1` | must not change with RC4 |
| A7 | Report switch (stage c only) | `TBI_REPORTS_DIR` absent from the live unit (off); stage (c) value `/var/lib/tbi-runtime/state/reports` (unit template line `/var/lib/@N@-runtime/state/reports`) | separate approval |
| A8 | Gate | Caddy → oauth2-proxy exact-email allowlist (root:oauth2-proxy 0640) → unix sockets; `ops/gate-checks.sh` (93), `ops/og-preview-checks.sh <base URL>` (96) | G6; allowlist and registry are never part of a release |
| A9 | Maintenance | `ops/maintenance-window.sh`, `ops/alerts-mute.sh` (maintenance-scope mute), `ops/restore-config.sh`, `ops/backup-config.sh` | D8 scripts run through these |
| A10 | RC3 rollback target | `/srv/tbi-lab/{services,dev-lab}/802befe…`, package `pkg-802befe` (`MANIFEST.sha256` sha256 `959494b8…`), `rc/rc3-hashes.txt` | rollback must restore these |
| A11 | Monitoring | alertd v3 `/usr/local/lib/tbi-alpha/tbi-alertd.py` (sha256 `c0cf12dd…`), daily report `tester-usage.py` (`20fdda95…`) | already RC4-compatible |
| A12 | Readiness check | `ops/rc4-readiness-check.sh <sha> [log-compat evidence]` (read-only PASS/BLOCKED/FAIL) | run before and after the switch |
| A13 | Transfer | Alpha has **no** GitHub credential; DEV → Alpha changes arrive as a git bundle/package + sha256, verified on Alpha; Alpha → DEV via DEV-initiated pull | no push from Alpha |
| A14 | Retention (16D) | `/etc/systemd/journald.conf.d/30-retention.conf`; `/etc/logrotate.d/rsyslog` (30 d); `/usr/local/lib/tbi-alpha/tbi-retention.py` + `/etc/tbi-retention/policy.json` (root 0600); audit `/var/log/tbi-retention/audit.jsonl` | rate expiry depends on the app's `rate_event(principal, action, at)` table, the action names `build-failure`, `build-submit`, `prebuilt-upload`, `session-create` and `windowMs` in the policy (keeps max(24 h, 2 × longest window)): **RC4 must not rename/re-shape these without telling Alpha** (new actions are simply not expired; a longer window is picked up automatically). RC4 adds `alpha-rc4-pre-*` backups = class `release-pre` (2 newest valid kept) |
| A15 | Staging isolation (16D) | `ops/rc4-staging.sh` + `ops/staging/`: staging runs as `tbi-s8-runtime` / `tbi-s8-build` (User= drop-ins), staging polkit rule re-rendered for them (`50-tbi-s8.rules`), store re-owned; real-polkit `pkcheck` matrix must pass before any smoke, else staging is stopped | without it the repo's `install.sh staging` runs staging as the live users, and the live polkit rule then lets staging stop/kill live `tbi-qemu@` sessions. Requires that the template `50-tbi-lab.rules.in` keeps its shape (preflight compares) |

Secrets that exist only on Alpha and are **never** transferred: service identity/ticket keys (systemd
credentials), oauth2-proxy client secret and cookie secret, Telegram bot config, tester allowlist and registry,
retention audit log and rate databases.

## 10. Status at 2026-10-18 (Sprint 16B/16C, read-only check `ops/rc4-readiness-check.sh`)

Candidate composition `92dac26` (RC3 + acceptance + diagnostics + report-problem, no Active Minutes, local only):
26 PASS, 5 BLOCKED, 0 FAIL. Open: G1 (D6, no merged RC4 SHA), G2 (D1), G3 (D2–D4), G5 (D7), G8 (D8). `2e8eb7c`
additionally contains the Active Minutes POC and is **not** an RC4 candidate. **RC4 is not deployable.**

Sprint 16D (19:30–20:00 UTC): unchanged gate status. Retention in force (A14, §4). Staging isolation overlay
prepared and verified without running staging (A15): live polkit decisions checked with `pkcheck` (only
`tbi-runtime` may stop live `tbi-qemu@`; any other UID `auth_admin`), overlay rule decision matrix 64/64,
`rc4-staging.sh preflight 92dac26` = overlay checks PASS, final SHA BLOCKED (as intended). Staging on Alpha still
waits for the final RC4 SHA and an owner-approved window; G5 (QEMU and browser suites) runs on DEV.
