# Sprint 7 — Arduino Firmware Workflow

**Status:** IMPLEMENTATION COMPLETE (phases 1–4 of the approved sequence), deployed to the dev-lab
private preview. **Not closed:** the post-S7 integrated endurance run (phase 5) and the PM's
authenticated smoke are pending. Not pushed beyond the branch, not tagged.
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
- `npm test`: 531 passed. Additions:
  - builder: protocol, service limits and queue, timeout and storage kill, cleanup, store LRU,
    leases and write-once, HTTP contract including Advanced upload validation, feature analysis;
  - domain: source key and profiles, schema v3 and migration, program validation and edits,
    package v2 round trip and v1 import;
  - app: build state, stale semantics, lookup, eviction, and the Run guard (refusal before
    runtime, lease before create, prebuilt, features).
- `test:e2e`: 112 passed, 3 heavy skipped.
  - New `s7.spec.ts` (7 tests) runs against a fake build service that reuses the real builder
    transport, queue and store with a scripted provider. It covers:
    - exact source bytes (typing, Tab, locale switch, reload, export v2) and CRLF preservation;
    - Build required → refused Run with zero runtime requests → Build → Run;
    - edit while running → stale, Build blocked, previous artifact never run;
    - diagnostics jump and Hebrew;
    - unmodelled features refused with zero runtime requests;
    - the Advanced prebuilt Run and a wrong-file refusal;
    - lookup on reopen with no rebuild, and DC projects never calling `/build`.
  - The S6 specs build before Run.
- `test:browser`: 4. Production build OK.

**Heavy** (real toolchain and QEMU):
- `s7-build.runtime.test.ts`: 5/5 (§8).
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

## 13. Remaining before closure

1. **Post-S7 integrated endurance run.** It reuses and extends the S6 harness
   (`~/projects/tbi-lab-s6/.tmp/endurance/`) with editor typing, source autosave, repeated builds
   (fresh and cached), artifact store growth and eviction, R2/QEMU sessions, the local DC path,
   and the IndexedDB logical vs on-disk trend. The duration is the PM's. It needs a fresh
   authenticated cookie at the start.
2. **PM authenticated smoke on dev-lab** through Google login: Code → Build → Run → Stop, an edit
   making the build stale, Advanced prebuilt, and Hebrew.
3. **CI** on the pushed branch/PR when the PM asks for it.
