# Sprint 7 — Arduino Firmware Workflow

**Status:** ALL GATES PASSED, **awaiting PM closure approval**. The implementation (phases 1–4) is
deployed to the dev-lab private preview. The following gates passed (§13, §14):
- the post-S7 integrated endurance run;
- the post-run tests;
- the owner's authenticated smoke;
- the final CI.

Not merged to `main`, not tagged.
**Base:** `sprint-6-complete^{}` = `1cdd0c7`. **Branch:** `sprint-7`. **Architecture:**
[SPRINT-7-ARCHITECTURE.md](SPRINT-7-ARCHITECTURE.md) (D-S7-1..9), plus the PM's pre-implementation
decisions on toolchain-neutral contracts and the Advanced `.bin` workflow.

## 1. Outcome

A Classic ESP32 project now carries its own **Arduino/C++ source** as project data. The user edits
it in the Code tab, presses **Build**, and the build service compiles it with the pinned
toolchain into an **immutable, content-addressed 4 MiB flash image**. **Run** then starts the
unchanged S6/R2 session with exactly that image.

- Nothing builds by itself.
- An edit makes the previous build stale at once.
- Run never uses a build that does not match the current source.

The two S6 examples now ship their sketches as editable source. A prebuilt image can still be run
once through **Advanced → Run prebuilt binary**.

## 2. Model: Project → Board → Programming environment → Source → Artifact → Runtime

Arduino is one environment, not the definition of the build system.

- **Profile.** A build *profile* names the board, the environment and the pinned toolchain
  configuration (`esp32-arduino-3.3.12`). A later profile (for example ESP32 + MicroPython) plugs
  in beside it.
- **Build protocol.** `tbi-lab.build/1` is toolchain-neutral: a profile plus files in, and an
  artifact identity plus diagnostics out.
- **Providers.** One provider per profile; `runtime/builder/arduino.ts` is the first.
- **Run contract.** The browser-side run contract resolves "what the board runs" to an immutable
  artifact whatever produced it. The three sources are a build, a pinned reference image, or an
  Advanced prebuilt image.
- **MicroPython is not implemented.** Nothing in the contracts forces it into a
  compile-to-binary model: a future profile may resolve to a runtime image plus files.

## 3. Project data (D-S7-1, D-S7-2)

- **Schema v3.** `programs[boardId] = { language: 'arduino-cpp', profile, fileName: 'sketch.ino',
  text }`, with at most one program in V1.
  - **Source handling.** The source is stored exactly as authored.
  - **Board lifecycle.** A new board gets a starter sketch; deleting the board deletes its
    program; duplication keeps it.
  - **Edits while running.** A source edit is a new edit class, `program`: allowed while a
    session runs, and never sent to it.
  - **Deterministic v2 → v3 migration.** It adds `programs: {}`, and a board that ran no firmware
    (`none`) now runs its program (`program`). A board on a pinned reference image keeps it.
- **Board firmware parameter.** `program` (the default) or a pinned reference sha256. The Sprint 6
  firmware picker is no longer shown in Properties (D-S7-5). The ESP32 panel says what the board
  runs and can switch a reference board to its code.
- **Package format 2.** The source travels inside `project` and is covered by the integrity hash.
  The reserved `source`, `firmware` and `toolchain` sections stay `null`. The importer accepts v1
  and v2; the exporter writes v2. See `packages/domain/PACKAGE.md`.
- **Never persisted.** Build results, artifact identities, build ids, logs and runtime state are
  never project data.
- **Line endings.** A `<textarea>` always yields LF line breaks. To keep bytes exact, a sketch
  whose line breaks are all CRLF stays CRLF when edited, and text that is never edited is never
  touched. A sketch with *mixed* line endings takes LF once edited (limitation, §12).

## 4. Build service (D-S7-7, D-S7-8)

`runtime/builder/` runs as `tbi-build.service` on the preview host, same-origin under `/build`
behind oauth2-proxy.

**API** (submit and poll, because the proxy has a 30 s upstream timeout and a cold compile takes
~30 s):

| Route | Purpose |
|---|---|
| `POST /v1/builds` | Submit a build: 200 on a cache hit, 202 with an id and a capability token otherwise, 429 when busy. |
| `GET /v1/builds/:id` | Poll status (Bearer token). |
| `GET /v1/lookup?key=` | Find an existing build of exactly this source; never builds. |
| `POST /v1/artifacts` | Advanced upload. |
| `POST /v1/artifacts/:sha/lease` | Pin an artifact before a Run. |
| `GET /v1/health` | Health. |

**Job.** Each build gets a private directory holding `sketch/sketch.ino` and an empty user
directory, so no sketchbook libraries are visible. arduino-cli 1.5.1 runs with:
- a fixed argv, no shell, a clean environment, its own process group and bounded output;
- a per-job core cache, the pinned read-only data directory and `--format json`;
- `SOURCE_DATE_EPOCH` and prefix maps for the sketch, the job directory and the toolchain data.

Then comes `esptool merge-bin` into the R2 layout (bootloader 0x1000, partitions 0x8000,
boot_app0 0xe000, app 0x10000, filled to 4 MB, DIO/40 MHz), followed by feature analysis. The
job directory is removed in all cases; stale directories are swept at start.

**Limits** (D-S7-8):

| Limit | Value |
|---|---|
| Source | 64 KiB |
| Active compiles | 1 |
| Queue | 3, then 429 |
| Hard compile timeout | 240 s (process-group kill) |
| Retained output | 256 KiB |
| Temporary storage per build | 512 MiB (watchdog) |
| Artifact cache | 256 MiB LRU |

- A cache hit, keyed by the source content key, returns in ~70 ms.
- Structured diagnostics come from arduino-cli's JSON and are mapped to `sketch.ino:line:column`.
  Server paths are scrubbed.

**Artifact store** `/var/lib/tbi-lab/artifacts`:
- Write-once `<sha256>.bin` (0444), with the sha256 always computed by the service, plus
  `.json` manifests.
- Publishing is atomic (write, then rename).
- Unmanaged reference images, the R1 images seeded at setup, are never evicted.
- A **lease**, taken by the browser just before it creates a session, keeps an artifact from
  eviction until the Session Host has made its private copy (D-S7-8). R2 already copies each
  image into a private session directory, so a running session is never affected.

**R2 integration.**
- The Session Host gained only a configuration override, `TBI_ARTIFACTS`, pointing at the shared
  store. Lookup → re-hash → private copy → QEMU is unchanged, and so is the R2 protocol.
- Verified on dev-lab: a service-built artifact runs; an unknown sha fails with
  `artifact_unknown`.

**Toolchain pins.**
- The profile record `runtime/builder/profiles/esp32-arduino-3.3.12.json` lists the toolchain
  versions, FQBN, epoch, prefix maps, image layout, and the sha256 of the arduino-cli binary,
  compiler, esptool, `boot_app0`, the partition CSV, `platform.txt` and `boards.txt` (arm64).
- The service verifies them at every start and refuses to serve on a mismatch.
- The pins are unchanged: arduino-cli 1.5.1, core 3.3.12, gcc esp-14.2.0_20260121, esptool 5.3.1,
  `esp32:esp32:esp32:FlashMode=dio`.

## 5. Security and isolation (controlled preview)

The unit runs as its own user `tbi-build`. It:
- sees no home directories (toolchain and Node are bind-mounted read-only);
- has `ProtectSystem=strict`, `PrivateTmp` and `PrivateDevices`;
- has `IPAddressDeny=any` except localhost, so neither the service nor a compile can reach the
  network;
- writes only its job directories and the shared store;
- has `MemoryMax=1536M`, `CPUQuota=80%` and `TasksMax=128`;
- listens on loopback only, with no public port and no secrets.

No third-party or user-installed libraries exist (D-S7-6): the user directory is empty and nothing
is downloaded. Core-bundled libraries for unmodelled hardware (Wi-Fi, I2C, SPI…) are detected and
refused at Run, not silently "simulated".

**S8** (not claimed here): per-build kernel sandboxing, per-user quotas and rate limits, per-user
artifact access, the host trusting manifests instead of browser-sent features, and multi-tenant
capacity.

## 6. Unsupported features (conservative)

The build reports what the simulator does not model, and Run refuses with the list named in the
user's language:

- **From ELF symbols** (sections are GC'd, so a linked API is a used API): interrupts, Wi-Fi,
  Bluetooth, ADC, PWM/LEDC, DAC, touch, sleep, I2C, SPI.
- **From the source:** internal pull-ups and pull-downs, and restart requests. `esp_restart` is
  always linked by the core's panic handler, measured, so the source is the only signal.
- **Pins:** exact pins when every use is a literal, otherwise all input-capable pins.
- **Limits of static analysis:** macros can hide usage, so runtime diagnostics (for example
  `guest_reset`) remain the backstop.
- **Prebuilt images** are not analysed at all (as decided).

## 7. Product UX

- **Code tab** beside Circuit, for projects with a program.
- **Editor** (D-S7-3, no Monaco or CodeMirror):
  - a textarea with a line gutter and line/column;
  - Tab indents; Escape then Tab leaves the editor (no keyboard trap);
  - always LTR; size shown against the 64 KiB limit.
- **Build bar:**
  - plain-status phase: Build required / Waiting (queue position) / Building… / Built / Build
    failed;
  - a Build button, disabled with a reason while a session runs (D-S7-9);
  - the toolchain identity;
  - a "code changed since the last build" note.
- **Diagnostics:** a list by line that jumps to the source. Compiler messages stay verbatim and
  LTR; severity and chrome are translated. A collapsible "Build details" shows the artifact id,
  sizes and bounded raw output.
- **Build output never goes to the ESP32 terminal.** The terminal shows runtime serial only and
  is unchanged.
- **Run without a current build** refuses before any runtime request with `Build required`,
  switches to the Code tab and focuses Build (D-S7-4).
- **Editing while running** is allowed (the session keeps its firmware); Build returns after Stop
  (D-S7-9).
- **Reopening a project** recovers its existing build by lookup and never rebuilds.
- **Advanced → Run prebuilt binary:**
  - accepts only a merged 4 MB Classic ESP32 flash image: the size and the two ESP image headers
    are checked, with no analysis or patching;
  - the service hashes it and a one-off Run uses it;
  - it is never stored in the project.
- **Languages:** English and Hebrew for every new string.

## 8. Reproducibility gate (phase 5, part 1): PASS

Heavy suite `runtime/tests/s7-build.runtime.test.ts` (`TBI_RUNTIME_HOME=… npm run test:runtime --
s7-build`). Each build ran through a fresh service with an empty store and new job directories:

| Sketch | 3 builds | Artifact sha256 | Build time | Equals R1 lock (informational) |
|---|---|---|---|---|
| TbiGpioProof (blink) | bit-identical | `7e877f84e64743988349ae6c71cd46e05bbca73c8af95fe17db01b4516f1f4ed` | 32.5 / 28.9 / 29.9 s | no (`5f177cbe…`) |
| TbiBanks (input echo) | bit-identical | `4a81f3488c6b016d1360103b6bd76779bc6e5e779f849b7010d3cf2694dff82d` | 28.8 / 29.8 / 28.9 s | no (`9ca3a5ce…`) |

- The same shas were produced by a standalone command-line build and by the deployed, hardened
  service, so the artifact identity does not depend on the job path or the environment.
- The difference from the R1 lock comes from the sketch file name and build paths (as
  anticipated). It is recorded, not required.
- The same suite covers a compiler error (line-mapped, no artifact, no server path leaked) and
  the hard timeout (the build is killed, no toolchain process and no temporary file remain).

## 9. Tests and evidence

**Routine CI** (no toolchain, no QEMU):
- Typecheck, lint and boundaries clean.
- `npm test`: 534 passed. Additions:
  - builder: protocol, service limits and queue, timeout and storage kill, cleanup, store LRU,
    leases and write-once, HTTP contract including Advanced upload validation, feature analysis;
  - domain: source key and profiles, schema v3 and migration, program validation and edits,
    package v2 round trip and v1 import;
  - app: build state, stale semantics, lookup, eviction, and the Run guard (refusal before
    runtime, lease before create, prebuilt, features).
- `test:e2e`: 113 passed, 3 heavy skipped.
  - New `s7.spec.ts` (8 tests) runs against a fake build service that reuses the real builder
    transport, queue and store with a scripted provider. It covers:
    - exact source bytes (typing, Tab, locale switch, reload, export v2) and CRLF preservation;
    - Build required → refused Run with zero runtime requests → Build → Run;
    - edit while running → stale, Build blocked, previous artifact never run;
    - diagnostics jump and Hebrew;
    - unmodelled features refused with zero runtime requests;
    - the Advanced prebuilt Run and a wrong-file refusal;
    - lookup on reopen with no rebuild, and DC projects never calling `/build`;
    - a current build whose artifact is evicted by another client's build: the lease fails,
      nothing reaches the runtime, and the page shows Build required → Build → current → Run
      (§13.1).
  - The S6 specs build before Run.
- `test:browser`: 4. Production build OK.

**Heavy** (real toolchain and QEMU):
- `s7-build.runtime.test.ts`: 5/5 (§8), plus the eviction test added after the endurance run
  (§13.1). The whole suite is rerun on the final commit with the final CI.
- The real-QEMU browser acceptance `s6-real.spec.ts`, now building the examples through the real
  build service, passed 3/3 through the deployed dev-lab internal origin: blink LED and serial,
  echo mirrors and transients, product-level determinism.

## 10. Performance (short checks; 1 vCPU / 3.9 GB host; not capacity claims)

| Measure | Result |
|---|---|
| Cold compile (standalone / hardened unit at CPUQuota 80 %) | ~29 s / ~36 s (26.5 s CPU); compile error ~4 s |
| Cache hit (build or lookup) | ~70 ms |
| Build service memory | idle 44 MB; peak during a compile ~0.55–0.59 GB (cgroup, incl. page cache) |
| Job temporary files | peak 94 MB (limit 512 MiB); removed after every build |
| Artifact size | 4 MiB + a small manifest per distinct build |
| App bundle (`index` JS) | 231 KB → 260 KB (+29 KB; gzip 66 → 74 KB); CSS 26 → 30 KB |
| Local DC Run → running / Stop (same in-page method, S6 `1cdd0c7` vs S7) | 21.8 → 17.5 ms / 6.7 → 5.6 ms (no regression) |
| Editor keystroke → paint, 1.3 KiB sketch | ~17 ms median (one frame) |
| Editor keystroke → paint, 59 KiB sketch | ~37–41 ms median; the app's own JS ~5 ms per keystroke, the rest is the browser's layout of a large textarea |

Two editor costs found by profiling were removed:
- hashing the whole source on every keystroke;
- a forced layout from the gutter's scroll sync.

## 11. Deviations and decisions made during implementation

- **Directory names:** `runtime/builder/` and `app/src/programs/`, not `build/`. The repository's
  global `.gitignore` rule `build/` would have silently excluded them; found when a commit was
  missing the files, and fixed before push.
- **Advanced `.bin` form:** exactly the merged 4 MiB image (the R2 artifact form). The choice is
  per Run, and nothing is stored in the project or exported. An app-only binary would need
  merging, which is binary tooling that was declined for V1.
- **CRLF preservation on edit** (§3), required by the exact-source rule because of the textarea.
- **Order of pre-run checks:** circuit checks (ground, orphan pads, one board) come before the
  build check.
- **One program per project** (D-S7-1): a second board placed in a project gets no starter
  program (it could not run anyway: one board per project).

## 12. Known limitations

- **Environment:** Arduino/C++ for the Classic ESP32 only; one `sketch.ino`; no third-party
  libraries.
- **Unmodelled facilities:** Wi-Fi, I2C, SPI, ADC, PWM, pulls, interrupts and restart are refused
  at Run.
- **Static feature detection** can miss usage hidden behind macros; runtime diagnostics remain.
- **Line endings:** a sketch with mixed line endings takes LF once edited in the browser.
- **Prebuilt images** are not analysed, not stored, and run once per upload.
- **Build latency:** the first build of new source takes ~30 s on this host, one at a time.
  Reopening finds existing builds; an evicted build (above 256 MiB) needs a new Build, and the
  source is never lost.
- **Build while running** is not allowed in V1 (D-S7-9).
- **Deployment** is a controlled preview (§5), not the S8 public design.

## 13. Integrated endurance run (phase 5, part 2): PASS

The post-S7 / pre-S8 run, which also stands in for the S6 run that was deferred.

**Setup**

| | |
|---|---|
| Tested commit | `7e1a596`: app, Session Host and build service, all serving the same commit on dev-lab |
| Environment | `https://dev-lab.tbi-tech.net` through Caddy and oauth2-proxy with an authenticated session (the cookie is not recorded and was deleted after the run); headless Chromium 153; host arm64, 1 vCPU (Neoverse-N1), 3.9 GB RAM |
| Window | 2026-09-28 05:47:04 → 13:32:54 UTC, **465.8 min** (planned 465) |
| Seed | `2026092701` |
| Harness | The S6 harness extended for S7 (git-ignored, not product code). It samples every minute and reports trends per hour. |
| Owner smoke | None reported during the window. No non-harness user load is attributed to this run. |

**Workload.** A seeded rotation of phases:
- ESP32 blink churn;
- echo with mirrored commands and transient presses (including Stop while a button is held);
- reconnects;
- the editor (wires, undo/redo, autosave);
- local DC;
- locale switches;
- code edit → Build → Run;
- queue bursts.

Timed checks ran alongside: determinism, persistence, security, post-GC heap and project reopens.

Source edits were of three kinds:
- binary-changing;
- comment-only, which reuses an existing artifact;
- edits while a session was running.

In addition:
- old source versions were revisited (oldest first once eviction had begun);
- a compile error was injected about every 30 min;
- a queue burst of 5 submissions ran each hour.

**Totals**

| Area | Result |
|---|---|
| ESP32 sessions | **392** created, 392 stopped, **0 failures**. QEMU was gone after every Stop: 318 orderly Stops plus 74 Stops while a button was held. |
| Runtime | 134,128 events; 444 mirrored commands; 74 transient presses; 52 forced disconnects, all reconnected, **0 resyncs** |
| Local DC runs | 331, with correct values |
| Editor | 1,444 edits; 653 autosaves; 400 wires routed; 400 undo/redo; 76 locale switches; 574 project reopens; 107 temporary projects created and deleted |
| Builds | 177 requests: **135 fresh compiles**, 35 cache hits, 311 "already current". There were **15 compile errors, all deliberately injected**; every one was reported at the broken line (26). |
| Build queue | 7 bursts. Each gave 4 × 202 and 1 × 429 at queue depth 4, and all 28 accepted builds completed. |
| Lookup | 159 hits; 4 misses, all of them evicted builds |
| Leases | 392, all 200; **0 lease misses** |
| Run-artifact checks | 392. The artifact each session ran was the one the page resolved: **0 wrong-source results**, 0 build-result key mismatches, 0 stale-run leaks (12 stale Runs refused before any runtime request). |
| Infrastructure | 0 build-service 5xx, 0 transport errors, 0 infrastructure failures, 0 page errors, 0 harness errors |
| Determinism | 12 checks, identical checkpoint hashes for simulated seconds 1–6 every time (see Anomalies) |
| Persistence | 8 checks: export equals stored, no forbidden or invalid data, only the two expected localStorage keys |
| Security | 17 checks: only ports 22/111/80/443 exposed; Session Host 127.0.0.1:7400 and build service 127.0.0.1:7420 loopback-only; unauthenticated `/` and `/build` → 302 to Google; 0 token log lines |
| Cleanup at the end | No QEMU left, no build job directories, no temporary projects; the 6 canonical projects valid; browser profile removed |

**Artifact store and eviction**

- **Store fill.** The store started at 160 MiB managed (40 artifacts from earlier trials). It reached the **256 MiB managed cap** at 118 min (07:45 UTC) and stayed exactly at the cap (64 managed images) to the end.
- **Reference images.** The 11 unmanaged R1 images were present throughout and **never evicted** (75 images in total at the end).
- **Evictions.** 69 observed in the store, from 07:53 UTC. The first 38 were artifacts from before the run; from 11:12 UTC the run's own older builds were evicted.
- **Revisits of old versions.** 20 revisits: 16 were still stored, **4 had been evicted** (variants 11, 14, 15 and 16, aged 306–395 min). Each evicted revisit went through the full sequence, observed live with no deviation:
  1. lookup returned 404, and the page showed Build required;
  2. Run was refused with `mcu_build_required` and no runtime request;
  3. Build made a fresh compile, not a cache hit;
  4. the rebuilt image had the **same sha256** as the evicted one (4/4);
  5. Run succeeded.

  This matches the §8 reproducibility result under real eviction.
- **Leases under concurrent sessions.** 392 leases, 0 misses. No leased artifact went missing and no hash mismatch occurred.

**Build service and runtime figures**

| Measure | Result (median / p95 per hour, range over the 8 hours) |
|---|---|
| Fresh build, submit → done | 32.0–33.6 s / 32.5–40.9 s |
| Compile error | 4.3–5.0 s |
| Cache hit | 54–73 ms (single p95 values of 248–273 ms in 4 hours, n = 3–5) |
| Lookup on reopen | 290–391 ms |
| Revisit → running | ~10.3 s when still stored; ~43–48 s when evicted (includes the fresh ~32 s compile) |
| Burst of 4 accepted builds, submit → done | 127–131 s, strictly serial |
| ESP32 Run → session created | 100–105 ms / 125–169 ms (last hour p95 277 ms, max 1.3 s) |
| ESP32 Run → first result | 500–559 ms / 546–725 ms (last hour p95 1.13 s, max 1.64 s) |
| ESP32 Stop | 96–111 ms / 131–258 ms |
| SSE reconnect | 1.07–2.01 s / 1.3–3.2 s |
| Local DC Run → result / Stop | 87–99 ms / 59–66 ms |
| Autosave, keystroke → saved | 341–349 ms / 377–551 ms |

**Resources** (hourly medians, first hour → last hour)

| Process | Trend |
|---|---|
| Session Host RSS | 87 → 93 → 91.5 → 81 → 76 → 77 → 77.5 → 89 MB. The range was 76–101 MB throughout and the last hour stayed below the second hour's maximum. File descriptors 22–27. |
| Build service RSS | 81 → 72 MB, falling slightly. Its cgroup memory (including page cache) was 294 → 387 MB, with peaks of 688–828 MB during compiles. The limit is 1536 MB. Tasks 11–18; job directory at most 7 MB. |
| QEMU per session | 64 MB median (max 72 MB); CPU 77 % median |
| Browser | total 460 → 375 MB; renderer ~180 MB flat; JS heap ~8 MB; post-GC heap 4.5–4.9 MB at every checkpoint; DOM ~1,270 nodes; 1 document |
| Host | free memory 1.70–1.94 GB (hourly medians). Swap rose 1.36 → 2.02 GB over the first 4 hours, then stayed flat at 2.0–2.1 GB. |
| Harness process | 256 → 514 MB. It keeps every variant's text and every record for the evidence file; this is the harness, not the product. |

**Browser storage.**
- Logical content stayed at 26–29 KB (15 records, 7 projects) throughout.
- On disk, Chromium's IndexedDB followed a bounded sawtooth, never above 5.5 MB. The compactions seen in the run:
  - 3.9 → 2.2 MB at about 170 min;
  - 5.3 → 0.13 MB at about 285 min;
  - later cycles down to 0.44 MB (hourly median) in the last hour.

  The end figure was 0.87 MB.
- An isolated experiment (a separate profile, overwriting one 26 KB record) reproduced the same cycle: the LevelDB write-ahead log grows to about 4 MB and is then compacted.
- The app writes only one record per project, an index entry, a device id and two localStorage keys. Build state and history are memory-only and bounded.
- The S6 review item (on-disk growth against constant logical content) is therefore resolved: it is storage-engine churn, and it is bounded.

**Anomalies and review flags** (none is a failure)

- **Determinism checkpoints differ from the S6 acceptance constants** (12/12, `determinism_known`). They are identical to each other across all 12 checks. The determinism project is the blink example, which in S7 runs its **built** sketch (`7e877f84…`, §8) instead of the S6 pinned R1 image (`5f177cbe…`), so different firmware gives a different trace. This was expected.
- **Six automatic trend flags**, which compare the first hour with the last:
  - **Session Host RSS "still rising at the end" (77 → 89 MB).** It is not monotonic: the same process was higher in hours 1–2 (up to 101 MB) and lower in hours 3–6. Kept for the S8 review; not treated as a leak.
  - **Run → session created / first result p95 in the last hour.** A few outliers (max 1.3 s / 1.6 s) while medians were unchanged (101 / 522 ms), on a 1-vCPU host at 81–100 % CPU during the evicted-revisit rebuilds. Earlier hours had p95 below 170 / 725 ms.
  - **SSE reconnect p95 2.2 s in the last hour** against 3.2 s in the second hour: no trend.
  - **Cache-hit p95 260 ms.** Single values with n = 4; the same happened in hours 1, 5 and 6; medians stayed at about 70 ms.
  - **Revisit → running p95 43 s.** This is the fresh compile after eviction (the intended path), which could only happen once the run's own builds were being evicted.
- **Swap** grew during the first 4 hours and then held at about 2.1 GB, with free memory stable; no service's RSS grew. Kept as an observation for the S8 capacity work on this 4 GB host.

**Comparison with S6.**
- The S6 465-min run was deferred, so there is no earlier long run to compare against; this run is the first.
- Against the S6 12-min trial, everything the trial checked held for 465 min: QEMU gone after every Stop, correct DC values with no `/runtime` traffic, matching determinism, persistence, security and bounded buffers. Serial peaked at 2,285 of 16,384 characters, warnings 0 of 20, checkpoints 120 of 120, 0 serial characters dropped.
- The S6 browser-storage review item is resolved (above).
- ESP32 Run → first result (median 500–559 ms) is in line with the harness's initial S6 figure of 558 ms.

**Result per criterion**

| Criterion | Result |
|---|---|
| No hard failure for the full duration | PASS (465.8 min, `hardFailure: null`) |
| Every ESP32 session starts, runs and stops; QEMU and session files cleaned | PASS (392/392, 0 failures) |
| Runtime stream: reconnects recover, no resync, buffers bounded | PASS |
| Local DC path correct with no runtime traffic | PASS (331 runs) |
| Builds: fresh and cached correct; compile errors line-mapped; no infrastructure failure | PASS |
| Queue limit enforced (1 active + 3 queued, then 429) and every accepted build completes | PASS (7/7 bursts) |
| Exact-source rule: no wrong-source result, no stale build run | PASS (0 / 0; 12 refusals) |
| Store bounded at 256 MiB with LRU eviction; R1 images never evicted | PASS |
| D-S7-8 lease: no leased artifact missing or mismatched | PASS (392/392) |
| Evicted old version → Build required → rebuild → Run | PASS, **observed live 4 times**, same image each time |
| Persistence and security checks | PASS (8/8, 17/17) |
| No unbounded growth in product processes or browser storage | PASS, with the review flags above |
| Determinism stable within the run | PASS |

**Conclusion: PASS.**
- The integrated S7 stack at `7e1a596` ran for 465.8 min under a mixed editor, build and runtime workload on the 1-vCPU preview host with no hard failure, no session failure and no wrong-source, lease or hash error.
- The artifact store operated at its cap with real eviction, and the evicted-version path was exercised live.
- Evidence: `evidence-2026-09-28T05-47-04-740Z.json` and the matching minute-by-minute samples in the harness directory (git-ignored).
- Nothing in these figures is a capacity claim for S8.

### 13.1 Tests added after the run (PM-approved)

Test-only additions: no product code changed, so the endurance evidence stands. They give the
live eviction path (above) direct automated coverage.

| Test | Level | What it proves | Result |
|---|---|---|---|
| Rebuild after eviction (`service.test.ts`) | Routine: real service, store and LRU; fake provider | A one-image store evicts the first build when another is published. The same source is then **not** a cache hit, compiles again, and the server-computed identity equals the first; lookup finds it again. | PASS |
| Rebuild after eviction (`s7-build.runtime.test.ts`) | Heavy: real pinned toolchain | Blink built, evicted by the input-echo build, rebuilt with a real compile. The artifact is bit-identical, and the sha256 is recomputed from the file on disk. | PASS (98 s) |
| Failed lease recovery (`s7.spec.ts`) | Browser: real app wiring, real builder transport, store and lease | The page holds a current build; another client's build evicts its artifact. Run → lease 404 → `mcu_build_required` with zero runtime requests → Build required with Build focused → Build (a fresh compile, same artifact id) → current → lease 200 → Run reaches running with the LED on. | PASS |

The browser test was checked against a mutation: with the app's "forget the build when its lease
fails" step removed, it fails, because the page stays on "current". Two test-only changes support
it:
- the fake build service's test reset accepts a store size in images (`capImages`);
- the default store size is unchanged.

## 14. Final verification

**Tested code head:** `50cf2a3`.
- Product code there is identical to the endurance-tested `7e1a596`: only the tests and this
  record changed (`git diff 7e1a596 50cf2a3` outside tests and docs is empty).
- The endurance result (§13) therefore stands, and the 465-min run was not repeated.
- A documentation-only commit that records this section follows `50cf2a3` and is not re-tested
  by the heavy suites.

**Owner authenticated smoke on dev-lab: PASS**, reported by the owner.
- Coverage, through Google login on `https://dev-lab.tbi-tech.net` (serving `7e1a596`):
  - the main flow: Code → edit → Build → Run → Stop;
  - the stale-build flow;
  - diagnostics;
  - the Advanced prebuilt `.bin`;
  - the Hebrew UI.
- Result: the main flow worked correctly, Hebrew appeared correct, and no issues were reported.

**Final CI** (local, from `50cf2a3`, 2026-09-28):

| Suite | Result |
|---|---|
| `npm ci` | PASS |
| Typecheck (all projects) | PASS |
| Lint, formatting and architecture boundaries | PASS |
| Unit (`npm test`) | **534 passed** (51 files) |
| Production build | PASS (`index` JS 260.6 KB, gzip 75.2 KB; CSS 29.9 KB) |
| Browser/e2e (`test:e2e`, Chromium) | **113 passed**, 3 heavy skipped (run below) |
| Legacy browser suite (`test:browser`) | **4 passed** |
| Heavy runtime suite (`test:runtime`: R1, R2 and S7 real toolchain) | **81 passed** (13 files, 19.5 min) |
| Reproducibility gate (part of the heavy suite) | PASS. Three fresh builds each were bit-identical, with the same shas as §8: TbiGpioProof `7e877f84…`, TbiBanks `4a81f348…` |
| Rebuild after eviction, real toolchain (§13.1) | PASS |
| Real-QEMU browser acceptance (`s6-real.spec.ts`, `TBI_S6_REAL=1`) through the dev-lab internal origin | **3 passed**: blink, input echo, determinism |

GitHub Actions runs on pull requests and on pushes to `main`. It runs for Sprint 7 with the
closure pull request / merge, and the tag waits for it to be green.

## 15. Deferred (Sprint 8 or later)

- **Capacity.** On the 4 GB preview host, swap reached about 2.1 GB during the first four hours of
  the endurance run and then stayed flat (§13). Track in the S8 capacity work.
- **Public hardening (S8).** Per-build sandboxing, per-user quotas and rate limits, per-user
  artifact access, the host trusting manifests instead of browser-sent features, and multi-tenant
  build capacity (§5).
- **MicroPython.** Enabled by the architecture as a future programming-environment profile (§2);
  not implemented.
- **Arduino-family boards beyond the Classic ESP32 path:** future scope.
- **Unmodelled peripherals** (Wi-Fi, I2C, SPI, ADC, PWM, pulls, interrupts, restart): still refused
  at Run (§6, §12).
- **Libraries, and Build while a session is running:** not in V1 (D-S7-6, D-S7-9).
- **Potentiometer:** remains deferred to V1.1 (PM-6).
