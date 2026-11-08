# Sprint 13 — staging release package and plan (PREPARED; nothing deployed)

PM instruction, 2026-10-12: prepare the staging release for OS-01 … OS-10 and P2–P4, with all required evidence. **No deployment is authorized.** Staging (B-steps below), DEV, merge, tag and production each need their own approval.

## 1. What the release contains

The release commit **R** is given in the release record (`docs/sprints/s13-evidence/release/`).

It spans every Sprint 13 commit since the deployed `ba0f4a6` (30 commits):

| Area | Content |
|---|---|
| Owner Smoke | OS-01 … OS-10 (`SPRINT-13-OWNER-SMOKE.md`) |
| Physics | P2 validity region, P3 pad-to-GND short (incl. board-only), P4 drive-strength refusal (`s13-evidence/h2/P2-P4-RESULTS.md`). **P1 is not included** (bench measurement pending) |
| Hardening already reviewed | H1 capability panel, H2 Component Failure Framework, H4 first-run guide, H5 parallel build workers (**off** by default: `maxActive` = 1 unless the alpha policy is selected), H7 feedback link (**disabled**: no `VITE_FEEDBACK_URL`) |
| Tests and records | H3, H6, CI, R4 probe evidence; the pin re-baseline `d20f2cc` |

**Unchanged:**

- **Runtime v2:** `b5b34b49cb7e4049`. No QEMU patch or provisioning change.
- **Firmware lock:** byte-identical, so the **release artifact set `767d3715fdaaef10`** is reused.
- **Project schema:** version 3; no migration.
- **Session Host wire protocol and build-service protocol:** no diff.

## 2. Artifacts (built from a clean checkout of R; hashes in the release record)

| Artifact | Build | Deployed by (when approved) |
|---|---|---|
| Frontend (`app/dist`) | `npm ci`, then `npm run build --workspace @tbi-lab/app`, with `TBI_BUILD_COMMIT=R`, `TBI_BUILD_ENV=dev-lab` and a fixed `TBI_BUILD_TIME` | `publish-frontend.sh R` (DEV only, after the DEV approval); staging's browser tests use a local preview of the same commit |
| Session Host (`session-host.mjs`) | esbuild, exactly as `install.sh` does it (version + commit stamped) | `install.sh staging` |
| Build service (`build-service.mjs`, `build-job.mjs`) | `npm run buildsvc:build` | `install.sh staging` |

Reproducibility: the package is built **twice independently**, from two clean worktrees with the same `TBI_BUILD_TIME`, and must be byte-identical.

## 3. Frontend / host compatibility

| Pairing | Result |
|---|---|
| **New frontend + current host (`ba0f4a6`)** | **Tested**: real-QEMU browser runs against staging (journey EN/HE, live sliders). It works, but P2/P3 for **ESP32 sessions** need the new host: the old host's engine reports a shorted pad as 0 A, without the flag. The OS-09 `supply_pin` diagnostic also comes only from the new host. |
| **Current frontend + new host** | Works. New fields (`outsideModelRange` on pins, `unreliable`, reason `supply_pin`, feature `drive_strength`) are additive and ignored; the old texts appear (generic warning code; feature code name). |
| **New + new** | Target. |

**Order:**

- Staging validates the host first (B1).
- On DEV (when approved): host first, then frontend. Rollback is in the reverse order.

**Project data.** OS-05's open-time route repair re-routes a stored wire that crosses a display face. That is a layout-only change, saved like the existing repair of criteria 1–2. Endpoints and connectivity never change. Projects stay readable by the current frontend.

## 4. Staging plan (B-steps; each needs the PM's go)

| Step | Action | Pass criterion | Rollback |
|---|---|---|---|
| B0 | Backup (Sprint 12 pattern): the four `tbi-s8-*` units, `/etc/tbi-s8/policy.json`, `/srv/tbi-lab/s8-staging/*`, with sha256 of each | Listing and hashes recorded | — |
| B1 | From a clean checkout of **R**: `TBI_S8_RUNTIME=<release runtime dir> deploy/dev-lab/s8/install.sh staging` (default policy) | `/health` reports commit R and runtime `b5b34b49cb7e4049`; bundle hashes equal the package's | Restore B0 units and bundles, `daemon-reload`, restart the two staging services; or re-run `install.sh staging` from a clean checkout of `ba0f4a6` (same runtime). Measured restore: 1.9 s (H6 rehearsal) |
| B2 | Deployed suites against staging (`TBI_S8_INSTANCE=tbi-s8`): s8-deployed-policy, s11-deployed, staging containment | All pass | as B1 |
| B3 | Real-QEMU browser: the release frontend (local preview of R) against staging via the bounded relays: journey EN/HE, live sliders, LCD swap (OS-09), pin short (P2/P3), P4 refusal | All pass | as B1 |
| B4 | Electrical: the staging host's published outcomes for the curated ESP32 examples equal the engine reference; the pin-short case is flagged | Equal; flagged | as B1 |
| B5 | Rollback rehearsal on staging (back to `ba0f4a6`, then forward to R) | Both directions verified with `/health` and one session each | — |
| B6 | Staging acceptance record; **PM review before any DEV step** | PM decision | — |

Out of scope here: DEV (`publish-frontend.sh`, DEV host), production, merge, tag, infrastructure.

## 5. Acceptance (staging)

Accepted when all of these hold:

- B1–B5 pass.
- The package is reproducible.
- Every pinned runtime suite passes on the release runtime.
- The full unit, browser and real-QEMU regression on R passes.
- The PM accepts the record.

Owner Smoke stays open until the owner signs `docs/alpha/OWNER-RETEST-S13.md`.
