# Sprint 18F — R4 owner acceptance fixes: build performance and SG90 3D motion

**Target:** DEV only (`tbi-lab-srv`). PR #7 stays draft; Alpha untouched.
**Base:** `sprint-15-r4` at `fbc0465`; DEV-Lab served R4 `b7da1c1` on Runtime v3
`2cb1406f94f52e4f`.

The owner's manual acceptance on DEV-Lab found two blockers:
1. building the Servo Sweep example took more than 30 s;
2. the SG90 horn did not visibly move in the 3D view.

## 1. Build performance

### Baseline (before any change)

The owner's builds, from the DEV-Lab journal (`tbi-build-job@` units) and grants database:

| Time (UTC) | Source | Compile step | CPU | Merge + symbols | Cache state |
|---|---|---|---|---|---|
| 10:07:43 | LED fade (curated, key `05d41de9…`) | 32.5 s | 25.3 s | 0.6 s | first build of this example on DEV-Lab |
| 10:09:43 | Servo sweep (curated, key `ceddfd0f…`) | 32.0 s | 25.3 s | 0.6 s | first build of this example on DEV-Lab |

- Both were the **first** shared (`global`) builds of those examples on DEV-Lab, recorded with
  analyzer 2.
- The 5 older global records (blink, input echo, distance alarm, thermo-hygrometer, LCD) were
  analyzer 1, so each would also have rebuilt cold on first use (`FEATURES_ANALYZER`, Sprint 18
  F-18-2).
- Queueing was 0 (one build at a time, nothing queued). Cache lookup is a single SQLite query
  (< 1 ms). Delivery (lease and ticket) took milliseconds.

Locally, with the pinned toolchain, the same argv as the service, 1 vCPU (`~/tbi-s18f/bench`):

| Case | Compile |
|---|---|
| cold (empty build directory, as every job) | 28.7 s (26.6 s on a second run) |
| unchanged source, warm build directory | 5.4 s |
| one-line edit, warm build directory | 7.0 s |
| fresh job with only the core objects copied in | **6.7 s**, byte-identical to a cold build |

Phase breakdown of a warm compile (`arduino-cli -v`, timestamped):

| Phase | Time |
|---|---|
| arduino-cli startup, board/platform load | 0.6 s |
| library detection | 0.6 s |
| prototypes (ctags) | 0.7 s |
| sketch compile | 0.85 s |
| core check (118 objects reused) | 0.8 s |
| link | 2.2 s |
| image, merge, size | 1.1 s |

### Root cause

- Every job runs arduino-cli in a new, empty build directory with a per-job `build_cache`
  (Sprint 7 design, for isolation).
- arduino-cli therefore compiles the whole Arduino-ESP32 core, 118 objects and about 22 s of the
  ~30 s, for every build. Its build cache stays empty with our build properties.
- The core does not depend on the sketch.
- Deploy-time invalidation added to it: nothing pre-built the curated examples after a deploy,
  and the analyzer bump made the older shared records stale. Whoever opened an example first
  after the deploy paid the full cold build.

### Fix

**Core seed** (`runtime/builder/coreSeed.ts`, used by `arduino.ts`):
- One copy of the compiled core (`build/core/` plus arduino-cli's `build.options.json`) is kept
  per exact compile configuration, owned by the service (`/var/lib/tbi-build/state/core-seeds`).
- It is copied, with timestamps kept, into each new job's build directory before the compile.
- The job only ever gets a copy; the seed itself is never writable by a job.

**Correctness: never a stale object:**
- The seed key hashes everything the core compile sees from us: the profile hash (pinned
  toolchain files, FQBN, options), the exact compile argv and arduino-cli configuration in the
  tools' view, and the environment.
- arduino-cli's own rules stay in force:
  - different build options → it discards the build directory;
  - a dependency file naming another path or a newer source → it recompiles that object.
  - Measured: a seed from another job path recompiles everything (26.5 s) and gives the same
    bytes.
- A seed is harvested only from a successful build of a **curated** source (the product's own
  sketches), never from a user's source.
- It is written aside and renamed into place complete, with a format and key marker. An
  incomplete seed is never applied, and a failed apply falls back to a cold build.

**Prewarm** (`BuildService.prewarm`, started by `main.ts` after the service listens;
`TBI_BUILD_PREWARM=0` disables it):
- The curated sources without a current shared build are built in the background, one at a time
  and only while nobody else is building or queued.
- The first one also leaves the core seed.
- A user asking for a source that is being prewarmed joins that build.
- Live sessions defer prewarm builds as any build.

**Progress feedback:** while a build runs, the toolbar and Code view show its elapsed seconds
next to "Building…" (EN `12 s`, HE `12 שנ׳`).
- It is a real clock since the request, never an estimate.
- It is not a live region, so a screen reader announces the phase once, not every second.

### Equivalence and benchmark (real toolchain)

`runtime/tests/s18f-build-seed.runtime.test.ts` (fixed job path as in the sandbox):
- a user build never leaves a seed;
- the first curated build is cold and leaves it;
- every curated source, a user sketch and an edited sketch built seeded are **byte-identical** to
  their cold builds;
- another configuration never takes the seed.
- **Passed.** The image hashes equal the ones DEV-Lab's sandbox produced for the same sources
  (e.g. servo sweep `0753fa3f…`, LED fade `bb2a50b9…`).

Local timings from that run: cold 25.7–44.7 s, seeded 7.3–22.6 s. These are contaminated: other
test runs shared the single vCPU during it. The clean numbers are the deployed ones in §4.

## 2. SG90 3D motion

### Trace

1. Runtime v3 reports the pad's LEDC waveform.
2. `runtime/host/servos.ts` decodes the pulse width and models the shaft (`angleDeg`, with its
   slew).
3. The Session Host publishes `angleDeg` in the component state.
4. The app's `sim.outcome.components[M1].state.angleDeg` receives it; the inspector showed it
   correctly.
5. `ThreeView` puts `{ servoDeg }` into the viewer's live levels.
6. `renderer.applyLive` sets `servoHorn.rotation.y = servoHornYaw(angle)`.

Every step was correct up to the drawn mesh.

### Root cause

- When the scene is built, `batchStatic` merges every opaque mesh that shares a material into one
  static draw, baking its transform in. This is the performance pass for software WebGL.
- The horn's hub, arm, tip (white) and screw (steel) were merged too.
- The `servoHorn` group was left **empty**: `applyLive` turned an empty group, and the merged copy
  of the horn stayed at its build-time pose (90°) forever.
- The shadow map is redrawn only on demand, so a turned horn would also have left its old shadow.

### Fix

- The horn is marked a moving part (`userData.moving`). `movingPart()` (models.ts) keeps every
  mesh inside a moving part out of the static batches: they keep their own transforms.
- `applyLive` requests a shadow-map update when a horn's yaw changes.
- The live-level computation moved unchanged from `ThreeView.tsx` to `ui/liveLevels.ts`, so it is
  unit-tested.
- Unchanged:
  - the angle is the simulation's own `angleDeg`, with no animation loop and no interpolation of
    our own;
  - only a running, solved simulation reports an angle. Stopped, starting, stopping, failed
    (refusal or crash) and unsolved show the horn at rest (90°, as the 2D symbol).
- The pivot is the output shaft (`SERVO_SHAFT_X_MM`, horn bottom 28.6 mm). 0° points the arm along
  the part's +x; the arm turns counter-clockwise seen from above, as the 2D symbol; travel is
  clamped to 0–180°.
- Inspection hook (opt-in, as `poses()`): `Viewer.horns()` gives each horn's yaw, its own mesh
  count, and the shaft and arm-tip world positions.

## 3. Tests

| Suite | Result |
|---|---|
| Unit (all) | **1373 / 1373** on `9e93212`; builder suite 58 / 58 after the two staging-found fixes (`fe640a5`, `b59ee50`) |
| Typecheck, lint, prettier, boundaries | pass |
| Real toolchain `s18f-build-seed.runtime` | **1 / 1** (10 sources seeded = cold, byte for byte) |
| Browser e2e (all, `9e93212`) | **236 passed, 0 failed, 32 skipped** (the real-stack specs, run on staging below) |
| Browser `s18f-servo-3d.spec` (software WebGL) | passed; **fails without the fix** (horn meshes: expected 4, received 0), shown by disabling the fix |
| Real QEMU browser on staging (`b59ee50`): `s18-r4b-real` (incl. 2 new 18F tests, recovery on) + `s15-r4-real` + `s18f-servo-3d` | **11 / 11 passed** |
| Real build service on staging: `s18f-build-real.spec` | **1 / 1 passed** |
| Deployed suites on DEV-Lab (`TBI_S8_INSTANCE=tbi`) | **15 passed, 2 skipped** (same set as R4-C; restart tests not run on DEV-Lab) |

New regressions by requirement:
- **angle into the 3D view:** `liveLevels` unit test; `s18f-servo-3d.spec` (renderer); and
  `s18-r4b-real.spec` "the 3D horn follows Runtime v3's angle" (horn yaw equals the inspector's
  angle at 0 / 90 / 180°);
- **pivot and limits:** unit (tip at exactly 0 / 45 / 90 / 135 / 180 / 37.5° about the shaft, at
  the 15 mm reach, in the horn plane; clamped at −20 and 200°); spec (tip vectors at 0 / 90 / 180°);
- **view-switch lifecycle:** spec (away and back: still its own part, at rest); real spec (away
  and back during a run: follows again);
- **Stop, refusal, crash:** unit (no level in any non-running state); real spec (Stop → rest and
  still 2 s later; QEMU killed → `runtime_crashed`, rest and still);
- **pixels:** spec (the region round the shaft differs between 0 and 180°; 0° again is identical);
- **build cache correctness and invalidation:** builder unit tests (key sensitivity, apply and
  harvest, incomplete seeds, prune, prewarm order, curated-only harvesting, joining) and the real
  equivalence test;
- **build latency:** the real test records cold, seeded, unchanged and edited timings; the
  deployed measurement is §4.

## 4. Deployment and final measurements

### Fixes found on staging (before DEV-Lab)

- `fe640a5`: the harvested seed kept the job's group-writable modes (0770 / 0660).
  - Jobs never see the seed directory: the sandbox binds only `/job`.
  - The seed is now group read-only anyway (dirs 0750, files 0640); a job's copy stays 0770 / 0660.
- `b59ee50`: a lost seed was never recreated.
  - With the curated shared builds current, users only get cache hits, so no curated build would
    ever run again to leave a seed.
  - The provider now reports `hasCoreSeed`, and prewarm then rebuilds one curated source, at most
    one per run.
  - Exercised on staging: the seed was deleted, reinstall, one rebuild, seed back (same key, 118
    objects, 0750 / 0640).

### Release

| Item | Value |
|---|---|
| Deployed commit | **`b59ee503ee38c940669eb4872be6cd80f64aa86c`** (branch HEAD `3c5a857` adds only the real build-latency spec) |
| Package | `~/tbi-s18f/rel/r4f-b59ee50`, rc4 profile, manifest **`da3039a65992457b`**; a second build is byte-identical (26 files) |
| Changed bundles vs R4 `b7da1c1` | `build-service.mjs`, the frontend; `session-host.mjs` differs **only** in its embedded commit id; `build-job.mjs` identical |
| Runtime | v3 `2cb1406f94f52e4f` release build, **unchanged** (no unit change) |

### Staging `tbi-s8`

| Step | Result |
|---|---|
| Backup | `/var/backups/tbi-lab/s18-staging-pre-20261020T110341Z` (b7da1c1) |
| Install | `install.sh staging` from the clean worktree `~/tbi-s18f/src`; bundles equal the package; health reports `b59ee50` |
| DEV-Lab during staging | 0 live sessions; snapshot unchanged after every staging step |
| Prewarm | seed missing → 1 curated rebuild, cold, 33.9 s (36.8 s on the first install); the other curated builds were current |
| Browser gate | 11 / 11 (table above) |
| Build latency (`s18f-build-real`, through the app) | Servo Sweep example **111 ms** (shared, cache hit); one-line edit **15.8 s** (service 13.8 s, seeded); unchanged rebuild **94 ms**; another user sketch **14.5 s** (seeded); elapsed seconds shown while building |
| Sandbox breakdown of a seeded compile | 8.0 s CPU over 12.0–13.4 s wall (the job unit's `CPUQuota=80%`, plus the test browser and app server on the same single vCPU); before: 25.3 s CPU over 32 s |
| Rollback rehearsal | back to the backup (`b7da1c1`) in **1.0 s**, live state byte-equal to it; forward in **2.9 s** |

### DEV-Lab — DEPLOYED

- **DEV-Lab serves `b59ee50`** (frontend, Session Host and build service) on Runtime v3, since
  2026-10-20 11:16 UTC. Pre-check: 0 live sessions.
- Backup: `~/tbi-s18f/deploy/devlab-backup-20261020T111559Z` (units, polkit rule, Caddyfile, tmpfiles,
  policy, runtime.json, links; SHA256SUMS; the keys are not copied: unchanged by the install).
- `install.sh dev-lab` from the clean worktree. Units, polkit rule, Caddyfile, runtime.json and
  policy are **unchanged**; both services active; deploy 2.3 s.
- Through the gate's internal origin, the 15 non-map files are byte-identical to the package;
  `/version.json` reports `b59ee50` (not dirty). The public site stays gated (302).
- Prewarm on DEV-Lab, quiet host:
  - the 5 stale (analyzer 1) curated builds were rebuilt: the first cold, **34.7 s** (it left the
    seed); then seeded **9.9 / 10.6 / 13.4 / 9.9 s**;
  - all 8 curated sources now have current shared builds;
  - the rebuilt images have **the same hashes** as the old cold sandbox builds (`03406419…`,
    `efd795f9…`, `4a81f348…`, `7e877f84…`, `969a20ee…`).
- Deployed suites: 15 passed, 2 skipped; the policy file is restored byte-equal.
- **Rollback, rehearsed:** `~/tbi-s18f/deploy/rollback-devlab-18f.sh back|forward`.
  - It moves both links as a pair and restarts the Session Host and the build service; the
    runtime is the same.
  - Back to `b7da1c1` in 256 ms (health `b7da1c1`); forward in 243 ms (health `b59ee50`). Units
    unchanged.
  - `b7da1c1` ignores the seed directory.

### Before / after (DEV-Lab sandbox)

| Case | Before (R4 `b7da1c1`) | After (`b59ee50`) |
|---|---|---|
| Open an official example and Build, first user after a deploy | 32.0–32.5 s (owner: LED fade, servo sweep) | cache hit (~0.1 s): prewarmed |
| A user's own or edited sketch, first build | ~32 s (25.3 s CPU) | ~10–13 s on a quiet host, ~14–16 s with a browser on the same vCPU (8 s CPU) |
| Unchanged rebuild | cache hit | cache hit |
| Cold (no seed: first prewarm build after a toolchain or seed-format change) | — | 33.9–36.8 s, in the background |

**Remaining cost, quantified:**
- About 8 s of CPU per seeded build is fixed toolchain work: the link alone is 2.2 s, plus image
  creation and merge, library detection, prototypes and the sketch compile (§1 table).
- The sandbox's `CPUQuota=80%` stretches 8 s of CPU into at least 10 s of wall time. The quota
  is a policy limit that keeps live sessions responsive; it is not changed here.
- Libraries a sketch uses (e.g. `Wire` for the LCD) are still compiled per build (LCD example:
  13.4 s seeded).
- Going further would mean also seeding the commonly used libraries, or relaxing the job's CPU
  quota when no session is live. Both are proposals only (Future / Backlog).

## 5. Owner acceptance (repeat through the normal Google login)

1. `/version.json` shows `b59ee50…`.
2. Open **Servo Sweep** → Build: done at once (**Built**).
3. Change one line (e.g. `delay(1000)` → `delay(900)`) → Build: "Building…" with a running
   seconds count, done in about 10–15 s.
4. Run, then open **3D**: the white horn on the servo turns to 0°, about 90° and 180° in turn, as
   the inspector's angle shows (select M1).
5. Switch to Circuit and back to 3D during the run: the horn keeps following.
6. Stop: the horn returns to its rest position (90°) and stays still.
7. Hebrew (עברית): step 3 shows the seconds as `12 שנ׳`.

## 6. Future / Backlog (not implemented)

- Seed the libraries the curated examples use (Wire etc.), keyed like the core.
- A larger job CPU quota while no session is live.
- QEMU build reproducibility (F-18-1), D10 isolation of staging and DEV-Lab users: unchanged, open.
