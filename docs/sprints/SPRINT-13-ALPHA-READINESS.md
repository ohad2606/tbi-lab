# Sprint 13 — Alpha release-candidate readiness (prepared 2026-10-13)

**This is NOT release approval.** It records, for the PM, where every Alpha item stands. Nothing here is frozen, tagged, merged or deployed. RC freeze (Oct 25) and Go/No-Go (Oct 30) are PM decisions.

## 1. Commits

| | Commit | Where |
|---|---|---|
| Deployed release | `dc1bff8` | DEV (dev-lab) and staging (`tbi-s8`), Runtime v2 `b5b34b49cb7e4049`, artifact set `767d3715fdaaef10` |
| Candidate code (this package) | `sprint-13` @ the commit in §6 | **branch only**: tested locally, not deployed |

Between `dc1bff8` and the candidate (overnight run, Oct 12–13), there are no feature changes. The new commits are security, data-integrity and accessibility fixes from the audits, plus test and procedure work:

| Commit | Change |
|---|---|
| `a972d15` | Test: OS-08 run-gating, covering cached build vs active build vs stale code |
| `12860d1` | Data H2: autosave keeps pending documents per project (no silent loss) |
| `e4ecbeb` | Security #1, #4, #6: event streams capped per session, oversize sources refused at submit, internal error text no longer reaches clients. Also: a throwing launcher becomes `start_failed` instead of crashing the Session Host. And the deployed capacity harness |
| `d37bc34` | Security #2: the sandboxed launcher waits for a unit's end asynchronously, so the event loop no longer stalls every user |
| `8e6e0b4` | Security #9: build status token compared in constant time |
| `7490778` | Data H1: two tabs on one project cause no silent overwrite and no resurrection (conflict notice, Reload) |
| `074a936` | Data M2: a failed delete keeps the open project's unsaved edits |
| `75f38b6` | Data H3: route repair on open is a visible, undoable edit |
| `8f2283e`, `72537e1` | A11y V1–V8: blocked Run reachable by keyboard; field/slider descriptions; LTR isolation in Hebrew; Escape scope; Build reasons announced |
| `d43977f` | H5: one-command capacity acceptance procedure (`docs/ops/CAPACITY-ACCEPTANCE.md`) |
| `a606379`, `d5c03a6` | H5 harness: three defects found by the procedure's own smoke run on staging, including a **false PASS** in admission counting; all fixed and re-verified |
| `c3b148b` | Data: a regression from `7490778`, found by the final CI. A full storage showed "Could not save" instead of "storage is full" |

**Process notes.**
- `8f2283e` was committed before its unit tests and lint had finished. One unit expectation and formatting failed. Both were fixed in `72537e1` without rewriting history.
- The first full CI (`d5c03a6`) then caught a real regression from this run's own fix `7490778`, fixed in `c3b148b`. The full CI was repeated from the start on `c3b148b`.

## 2. Status by state

Columns: **I** = implemented · **L** = tested locally (unit, e2e, pinned runtime) · **Q** = tested on real QEMU · **D** = deployed (DEV/staging) · **A** = owner-accepted.

| Item | I | L | Q | D | A | Note |
|---|---|---|---|---|---|---|
| OS-01 … OS-10 | ✓ | ✓ | ✓ (where relevant) | ✓ `dc1bff8` | **—** | Owner retest pending (Oct 15–17) |
| OS-02 3D open ≤ 2 s (D-02) | ✓ (instrumented) | headless only | — | ✓ | **—** | **Needs the owner's GPU measurement.** No inference from the headless benchmark |
| P2 validity region, P3 pad short, P4 drive refusal | ✓ | ✓ | ✓ | ✓ | — | Owner retest |
| P1 ESP32 drive model | **stopped** | — | — | — | — | Bench measurement (`BENCH-PROTOCOL.md`), ~Oct 20; no model change without evidence and approval |
| H1 capabilities panel, H2 ratings, H3 journey, H4 onboarding, H6 runbook / backup | ✓ | ✓ | ✓ (H3 journey-real) | ✓ | — | H3 native Hebrew review = O-6 |
| H7 feedback form | ✓ (disabled) | ✓ | — | disabled | — | Enabling needs PM approval of external data collection |
| **H5 five-session capacity (P0)** | procedure ✓ | harness ✓ | **N = 1 PASS on staging only** | — | — | **Not accepted. No alpha host exists.** The single-core host has NOT passed five-session acceptance |
| Overnight security fixes (#1, #2, #4, #6, #9, launcher crash) | ✓ | ✓ unit | host code under the 12 pinned real-QEMU suites, locally | **no** | — | DEV/staging still carry these issues until an approved deployment |
| Overnight data fixes (H1, H2, H3, M2, A12 regression) | ✓ | ✓ unit + e2e | export/journey real runs (frontend) | **no** | — | |
| Overnight a11y/l10n fixes (V1–V8) | ✓ | ✓ unit + e2e | candidate frontend in the real-browser runs | **no** | — | |
| Capacity harness + procedure | ✓ | ✓ | smoke on staging N ≤ 2 (procedure check only) | — | — | |

## 3. Open P0 / P1

| # | Pri | Item | Blocks | Owner |
|---|---|---|---|---|
| B-1 | **P0** | Five-session capacity acceptance on the alpha host | RC freeze | Owner infra decision O-1…O-3 (**Oct 16**) → provisioning → `capacity-acceptance.sh` (**Oct 22**) |
| B-2 | **P0** | Owner Smoke acceptance (Sprints 11/12 and OS-01…10, P2–P4) | RC freeze | Owner (Oct 15–17) |
| B-3 | P1 | OS-02 first 3D frame ≤ 2 s on the owner's GPU | RC freeze (PM) | Owner measurement |
| B-4 | P1 | P1 drive model: bench evidence or ship with the stated limitation | PM decision ~Oct 20 | Owner bench |
| B-5 | P1 | Deploy the overnight fixes (the security fixes above are not on any deployed system) | Alpha host install | PM deployment approval |
| B-6 | P1 | Alpha configuration: `policy.alpha.json` and `TBI_ARTIFACT_CAP_MB ≥ 640` (security #3) | Capacity acceptance | Part of the approved alpha install |

No open P0/P1 defect in the code itself was found by the audits that is not fixed on the branch.

## 4. Audit results (overnight)

- **Security** (`s13-evidence/overnight/SECURITY-AUDIT.md`): no cross-user read, command or end path found. 2 high findings (stream exhaustion; Session Host crash on launcher throw) **fixed**; 2 medium **fixed** (event-loop stall, oversize record); 1 medium is **configuration** (artifact cap); low findings fixed or documented. No release blocker open in code.
- **Persistence and recovery** (`DATA-INTEGRITY-AUDIT.md`): H1, H2, H3 and M2 **fixed**, each with a test that failed first; H4, M1 and M3 documented. No format change and no migration.
- **UX / a11y / l10n** (`UX-A11Y-AUDIT.md`): V1 (P1) and V2–V8 **fixed**; S1–S5 documented (P2).
- **Release integrity** (Task A): see §6 for the full CI on the candidate. Two earlier *test-script* mistakes in the DEV live check were a warm build cache (OS-08 "no build" needs a unique source edit) and an invalid project id (`^prj_[A-Za-z0-9]+$`). They are tool errors, not product defects; the tool was corrected and DEV verified 38/38.

## 5. Skipped and not-run tests

| Suite | Why | When |
|---|---|---|
| Staging-instance suites (`s8-containment`, `s8-policy`, `s8-qemu-tasks`, `s8-deployed-policy`, `s11-deployed`) | They reconfigure or restart the deployed staging instance; staging is reserved for the owner | At the alpha host install |
| e2e skipped cases (22) | Env-gated: real-QEMU backends (`TBI_S6/S11/S12_REAL`) and the measurement-only `TBI_3D_TIMING`. The Sprint 13 real specs were run separately (§6) | — |
| C-5 at N ≥ 2 (deployed) | Staging policy admits one session; the host has 1 vCPU | On the alpha VM |
| OS-02 GPU timing | The host is headless | Owner |
| Live dev-lab checks of the candidate | The candidate is not deployed (not authorized) | After deployment approval |

## 6. Full CI on the candidate (`c3b148b`; details in `s13-evidence/overnight/CI-FINAL.md`)

| Step | Result |
|---|---|
| Typecheck, lint | pass |
| Unit | 1146 / 1146 |
| e2e full | 196 pass / 0 fail / 22 env-gated skips |
| Pinned runtime suites, release QEMU | 12 / 12 suites, 81 / 81; **no fingerprint changed** |
| Real QEMU in a browser (candidate frontend → staging backends `dc1bff8`) | 9 / 9 |

**RC preparation package** (`c3b148b`, built twice in clean worktrees; **not approval, not frozen, not tagged**): two independent builds are **byte-identical** (frontend and the three service bundles, 25 files). Manifest sha256 `84bec1760151b5b6…`; `verify-build` passed (the bundle carries `c3b148b`). Inputs: artifact set `767d3715fdaaef10`, alpha policy `f55d14d4f950fe24`, Node v24.21.0. Record: `s13-evidence/overnight/rc-c3b148b/`; local package `~/tbi-s13-rel/pkg-rc1a`. **Not frozen, not tagged and not deployed.** RC freeze (Oct 25) is the PM's decision; any later fix means a new candidate.

## 7. Rollback plan

- **DEV:** `docs/sprints/s13-evidence/dev/tools/rollback-s13-dev.sh` (to `ba0f4a6`); backup `/var/backups/tbi-lab/pre-s13-dev-20261012T213407Z`.
- **Staging:** B5 rehearsed: rollback 1.34 s, forward 3.2 s; backup `/var/backups/tbi-lab/s13-staging-pre-20261012T202319Z`.
- **Alpha host:** the same install pattern; `switch-runtime.sh` for the runtime; the previous services directory is kept; the runbook is `docs/ops/RUNBOOK.md`.
- **Project data:** local-first in each browser; the overnight fixes add no format change. Export/Import is the user-controlled backup.

## 8. Remaining work to Nov 1

| Date | Gate | Depends on |
|---|---|---|
| Oct 15–17 | Owner retest on DEV (`docs/alpha/OWNER-RETEST-S13.md`), incl. OS-02 GPU | Owner |
| **Oct 16** | **Infrastructure decision** O-1…O-3 | Owner: **critical path** |
| Oct 16–19 | Alpha VM provisioned and installed with the candidate (alpha policy, cap ≥ 640 MiB) | Approval |
| ~Oct 20 | P1 bench measurement | Owner |
| **Oct 22** | `capacity-acceptance.sh` full run (~3 h) → PM review | VM |
| **Oct 25** | RC freeze | B-1, B-2 closed |
| Oct 26–29 | Final regression; dry run | RC |
| Oct 30 | Go / No-Go | PM |
| Nov 1 | Alpha (fallback Nov 15) | O-5, O-6, feedback form approval |
