# Sprint 13 staging release package: `dc1bff8c3f1480fd4063e1e77a2c3234b0592e6c` (PREPARED, not deployed)

Plan, compatibility and rollback: `docs/sprints/SPRINT-13-STAGING-RELEASE.md`.

The release commit R is that plan's own commit. Everything after it is records only.

## Provenance

| Item | Value |
|---|---|
| Release commit (R) | `dc1bff8c3f1480fd4063e1e77a2c3234b0592e6c` (`origin/sprint-13`) |
| Product version | `0.10-dev` |
| Build | `build-package.sh` (this directory): clean worktree of R, `npm ci`, the frontend as `publish-frontend.sh` builds it (`TBI_BUILD_ENV=dev-lab`, `TBI_BUILD_TIME=2026-10-12T20:00:00Z`, no preview badge, no feedback URL), the Session Host and build service exactly as `install.sh` (host stamped with R and the version) |
| Node | v24.21.0 |
| Reproducibility | **Two independent clean builds, byte-identical**: 25 files; `MANIFEST-dc1bff8.sha256` sha256 `a835300d4bd70a62d69c5bfbd3565f0b5d19f989e4f83efe502fae82fd40f721` |
| `verify-build.mjs local` | all checks passed: the version.json names R and the clean tree; the bundle carries R; assets are content-hashed and present |

### Artifacts (sha256)

| File | sha256 |
|---|---|
| `services/session-host.mjs` | `288c2ddc1e705fc0296cf3025f78dbb5e703c0e0940d4d28a0b2a1e6433bf7f6` |
| `services/build-service.mjs` | `04052fe35110aa51e0ad298de3fd7b0ad9e75b203c3127c4e64fb761911b841a` |
| `services/build-job.mjs` | `011f703c8ce87f472e5e4670d106dfe10cf3dbd4e1b4e01d7f017e4119c73f0f` |
| `frontend/index.html` | `e631c3099dbb7097ef78f34a7835338685eb71f77693668f0b82a3aa460b1bec` |
| `frontend/version.json` | `ab086272d878ba7f3707368df3650f35e36e3f927e24959b9c390ff884281fd7` |
| All 25 files | `MANIFEST-dc1bff8.sha256` |

### Inputs (`INPUTS-dc1bff8.sha256`)

| Input | Value |
|---|---|
| `package-lock.json` | `46fad356…` |
| Firmware lock | `767d3715…`, **= the existing release artifact set `/srv/tbi-lab/release-artifacts/767d3715fdaaef10`, unchanged since `ba0f4a6`** |
| `policy.json` | `d43ab503…` (staging default) |
| `policy.alpha.json` | `f55d14d4…` (not used on staging) |
| Runtime | Runtime v2 `b5b34b49cb7e4049`, unchanged |

## Test evidence on R (serial, clean tree, 2026-10-12)

| Suite | Result |
|---|---|
| Unit | **1127 / 1127** |
| Typecheck, lint | pass |
| Browser e2e (CI fakes, full) | **194 passed, 0 failed, 20 skipped** |
| Pinned runtime, release QEMU `b5b34b49cb7e4049` | gate 7/7 (R-MCU-1 pins unchanged) · s12-determinism 8/8 · r1-determinism 2/2 · r2-acceptance 5/5 · s12-pace 1/1 · s12-r2-timing 9/9 · r2-failures 11/11 · failures 15/15 · s12-bridge 11/11 · s12-r3 4/4 · s13-pad-short 1/1 · electrical 7/7 |
| Real QEMU in the browser (the frontend of R; staging Session Host + Runtime v2 through bounded relays, stopped by PID) | 4/4: journey EN→HE, HE→EN; live sliders (night light, distance alarm) |
| Electrical correctness | All 22 curated examples solved by the engine of `ba0f4a6` and of R on identical inputs, the 8 ESP32 examples with every pad input / all HIGH / all LOW: 38 cases, **identical** outcomes, warnings and solver statistics after removing only the new additive fields (`outsideModelRange`, `unreliable`). P2–P4 before/after: `s13-evidence/h2/P2-P4-RESULTS.md` |
| Startup (D-04) | Cold, 7 loads each, loopback, medians. Workspace ready 200 → **227 ms** (+27 ms); example open 331 → **339 ms**; DOMContentLoaded 83 → 104 ms. The startup JS is about +20 KB gzip (the OS-04 rule) |

**Not done** (needs the PM's staging approval): staging installation and acceptance B0–B6. That includes the deployed suites against staging running R, and the staging rollback rehearsal.
