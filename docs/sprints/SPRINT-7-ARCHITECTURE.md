# Sprint 7: Arduino Firmware Workflow (approved architecture)

**Status:** ARCHITECTURE APPROVED by the PM with decisions D-S7-1 to D-S7-9 (§25). Implementation
waits for the final implementation authorization.
**Base:** `sprint-6-complete^{}` = `1cdd0c7`. **Branch:** `sprint-7`. The final sprint record will be
`docs/sprints/SPRINT-7.md`.

Scope stays exactly as frozen for V1:
- Classic ESP32 only, exactly one `.ino` per project.
- Explicit Build → immutable artifact → Run.
- Pinned Arduino ESP32 core. Only what ships with the pinned core; no third-party or user-installed libraries.
- No multi-file sketches, no PlatformIO, no Wi-Fi, analog or PWM, no C3/S3, no reset.

## 1. What exists today (inspected)

| Area | Finding |
|---|---|
| Project | Schema v2 (`packages/domain/src/schema.ts`), frozen; no source or firmware fields. A migration framework exists (`migrate.ts`, `MIGRATIONS = {}`); a project with a newer schema opens read-only in an older app. |
| Board firmware | The board's `firmware` param is an enum: `none` or one of two pinned sha256 values (`firmware.ts`). Changing it is a structural edit. |
| Package `.tbilab` | `formatVersion 1`. Reserved top-level sections `source`, `firmware` and `toolchain` must currently be `null` (`package.ts`). `integrity.project` is the canonical-JSON sha256 of the project. |
| R2 firmware contract | `artifact.sha256` of the **merged 4 MiB flash image**. The host resolves `$TBI_RUNTIME_HOME/artifacts/<sha>.bin`, re-hashes it, and copies it into a private session directory. The host does **not** read the lock file, so any content-addressed `<sha>.bin` in that directory is runnable. `firmwareFeatures {internalPull[], gpioInterrupt[]}`: any non-empty list gives `unsupported_feature`. `esp_restart` gives `guest_reset` at runtime. |
| Toolchain (provisioned) | Pinned in `runtime/provision/versions.env`, listed in the table below. `provision.sh` already builds with `SOURCE_DATE_EPOCH`, `-ffile-prefix-map` and a fixed stage directory. R1 measured byte-identical images across two builds and two paths, but no automated rebuild gate exists. |
| Build time | R1: five sketches built in 2 min 26 s on 1 CPU (includes the core build). One sketch: 272 KB flash, 22 KB RAM. |
| Host | 1 vCPU, 3.9 GB RAM, `/tmp` is a 2 GB tmpfs, cgroup v2, `systemd-run` and `unshare` available. No bwrap, nsjail, docker or podman. The installed Arduino data is 7.7 GB and includes toolchains for every ESP32 family. |
| App | Dependencies are `preact` and `@tbi-lab/domain` only. Bundle: `index` 231 KB, `worker` 22 KB, CSS 26 KB. |

Provisioned toolchain pins:

| Input | Value |
|---|---|
| arduino-cli | 1.5.1 |
| arduino-esp32 core | 3.3.12 |
| xtensa-esp32-elf-gcc | esp-14.2.0_20260121 |
| esptool | 5.3.1 |
| FQBN | `esp32:esp32:esp32:FlashMode=dio` |
| Board defaults | 40 MHz flash, 4 MB, 240 MHz, `partitions=default` |
| Merge | `esptool merge-bin`: bootloader 0x1000, partitions 0x8000, `boot_app0` 0xe000, app 0x10000, filled to 4 MB |

## 2. Project representation (additive; schema v3)

Authored source belongs to the project. It lives in the project document, not in a component parameter and not in a build service.

```ts
// ProjectDocument, schemaVersion 3 (v2 → v3 migration: identity; `programs` absent = none)
programs?: {
  [boardComponentId: string]: {
    language: 'arduino';            // V1: only value
    profile: 'esp32-arduino-3.3.12'; // target board + pinned toolchain profile id (§4)
    fileName: 'sketch.ino';         // V1: fixed, one file
    text: string;                   // exact source; UTF-8; bytes preserved
  };
};
```

- **Board firmware param.** The board's `firmware` param gains the value `sketch`, which becomes the default for new boards. It means "run the build of this board's program". The pinned sha values remain valid (§12). `none` stays.
- **What persists.** Source edits change only `programs[..].text`. Autosave, reload, duplication, `.tbilab` export/import and undo/redo therefore all carry the source, because it is ordinary project data. Locale switching never touches it.
- **Edits while running.** Unlike params, a source edit is a new edit class, `program`. It is allowed while an ESP32 session runs (§15). It is not a structural edit.
- **What is never persisted.** No build state: no build id, no server path, no artifact hash, no logs, no timestamps. The browser holds the current build result in memory only. On reload it asks the build service whether a build for the current source key already exists (a lookup, §8); this is not a build.
- **Why schema v3 and not an optional v2 field.** v2 is frozen, and today's validator is strict. A version bump makes older apps open S7 projects **read-only** through the existing "newer schema" path instead of mis-validating them. All v2 projects load unchanged through the identity migration.
- **`.tbilab` package (D-S7-2): format version 2.** The exporter writes `formatVersion 2`; the
  importer accepts v1 and v2. The project, including `programs`, travels inside `project` and is
  covered by `integrity.project`. The v2 envelope keeps the reserved `firmware` and `toolchain`
  sections (`null` in S7) and defines `source` as `null` because the authored source is part of
  the project document. v1 packages (schema v2 projects) import through the v2 → v3 migration.
  An older app refuses a v2 package as "newer". A newer app must keep opening every v1/v2
  package: this is the future release-compatibility rule.

## 3. Explicit build semantics

- `sourceKey = sha256(canonical JSON {profile, fileName, textBytesSha256})`. It is computed in the browser and returned by the service.
- The UI shows one build state per program:

  | State | Meaning |
  |---|---|
  | `Build required` | No build, or the source changed since the last build. |
  | `Building…` | A build is running. |
  | `Build ✓` | The artifact matches the current `sourceKey`; artifact short id available under details. |
  | `Build failed` | Diagnostics are shown (§10). |

- Any source edit after `Build ✓` immediately returns to `Build required`. The previous artifact is never used for the edited source.
- **Run when the build is not current (D-S7-4).** The single Run/Stop control is unchanged. Run
  with no build or a stale build **refuses before any runtime request** with the localized
  `Build required` explanation (like the S6 pre-run refusals), and focuses the Build button. Run
  never builds automatically and never runs the previous artifact.

## 4. Toolchain pinning

- **Build profile `esp32-arduino-3.3.12`** is a versioned, immutable profile record in the repo (`runtime/build/profiles/esp32-arduino-3.3.12.json`) listing:
  - arduino-cli 1.5.1 and its sha;
  - core 3.3.12 and its package-index checksum;
  - xtensa gcc `esp-14.2.0_20260121`;
  - esptool 5.3.1;
  - the FQBN and board options;
  - the partition CSV and its hash;
  - the bootloader and `boot_app0` hashes;
  - the merge layout;
  - `SOURCE_DATE_EPOCH` and the prefix maps.
- `profileHash` = sha256 of the canonical profile record. It is returned with every build.
- **Toolchain.** The build service uses the already-provisioned toolchain, read-only. It never runs `core install` or `lib install` and has no index or network access (§7). A startup check hashes the key binaries against the profile and refuses to serve on a mismatch.
- **Pruning (optional, after measurement).** Keeping only the esp32 xtensa toolchain and dropping the other families would save several GB on the host. It is not needed for correctness.

## 5. Build service architecture

- **Service.** A new small Node service, `runtime/build/`, bundled like the Session Host, run by systemd unit `tbi-build.service`.
  - Runs as a dedicated system user `tbi-build`.
  - Listens on a unix socket `/run/tbi-build/build.sock`, or on 127.0.0.1:7420 with `IPAddressAllow=localhost`.
  - Caddy routes the same-origin `/build/*` there, inside the existing internal origin behind oauth2-proxy. It is never exposed directly.
- **One build job:**
  1. Validate the request (§6).
  2. Create a private per-build directory (0700) under the service's `StateDirectory`/`RuntimeDirectory` on disk, not on the 2 GB `/tmp` tmpfs.
  3. Write `sketch/sketch.ino`.
  4. Run arduino-cli with `execFile`: a fixed argv from the profile, no shell, `cwd` = the build directory, a clean environment (`HOME`, `PATH` and `SOURCE_DATE_EPOCH` only), `--build-path`/`--output-dir` inside the job directory, and `--config-file` pointing at a read-only config for the pinned data directory.
  5. Run `esptool merge-bin` with the fixed layout.
  6. Hash the merged image, run feature analysis (§16), then atomically publish `<sha>.bin` (0444) and `<sha>.json` (the manifest) into the shared artifact store.
  7. Delete the job directory in a `finally` block. Stale job directories are swept at service start.
- **Artifact store** `/var/lib/tbi-lab/artifacts`:
  - The build service owns it (write); the Session Host reads it.
  - The host's existing `$TBI_RUNTIME_HOME/artifacts` points there by symlink, with the two pinned demo images copied in.
  - **No R2 code change:** the host keeps resolving `<sha>.bin` and re-verifying the hash.
- **Core build cache.** Compiling the Arduino core dominates cold builds.
  - Warm path: a **read-only precompiled core cache** made at provisioning for the pinned profile, which arduino-cli links against.
  - If arduino-cli must write to its cache, each job instead gets a **fresh copy** of the pre-built cache in its private directory. There is never shared writable state between builds.
  - Which variant works, and its latency, is measured first (risk R2).

## 6. Build API contract (`tbi-lab.build/1`, HTTP + JSON)

- **`POST /build/v1/builds`**
  - Request:
    ```
    { protocol: 'tbi-lab.build/1', profile: 'esp32-arduino-3.3.12',
      source: { fileName: 'sketch.ino', text } }
    ```
  - Unknown keys are refused, only known profiles are accepted, and `text` is at most 64 KiB of UTF-8 with no NUL.
  - `200 { build }` when the same `sourceKey` was already built (cache hit, no compile).
  - `202 { buildId, token }` when queued. `buildId` is random and `token` is a capability, as with R2 sessions.
  - `429 { reason: 'busy' }` when the queue is full.
- **`GET /build/v1/builds/:id`** (Authorization: Bearer token) returns `{ state: 'queued'|'building'|'succeeded'|'failed'|'expired', build? }`.
  - The browser polls every 500 ms. A long synchronous request is avoided because the proxy's default upstream timeout is 30 s and cold builds may take longer.
- **`GET /build/v1/lookup?key=<sourceKey>`** returns `200 { build }` or `404`. This is used after reload; it never builds.
- **`build`** object:
  ```
  { sourceKey, profile, profileHash,
    status: 'succeeded' | 'failed',
    artifact?: { sha256, bytes: 4194304, appBytes, ramBytes },
    features?: { internalPull: number[], gpioInterrupt: number[], restart: boolean,
                 unsupported: string[] },
    diagnostics: [{ severity: 'error' | 'warning' | 'note', line?, column?, message }],  // ≤ 200
    log?: { text, truncated },   // bounded raw output, for the details view
    toolchain: { arduinoCli, core, gcc, esptool },
    timings: { queuedMs, compileMs, totalMs } }
  ```
- **Never returned:** server paths, other users' data, environment or host information.

## 7. Security and isolation (controlled preview)

**S7 controlled preview:**
- Access: only through oauth2-proxy (Google plus the exact-email allowlist). No port or socket is reachable from outside.
- The service is a systemd-hardened unit:

  | Setting | Value |
  |---|---|
  | User | `tbi-build` (not `ubuntu`; cannot read home directories, oauth2-proxy secrets or Session Host state) |
  | Hardening | `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges` |
  | Network | `IPAddressDeny=any` (with `IPAddressAllow=localhost` only if TCP), `RestrictAddressFamilies=AF_UNIX AF_INET` |
  | Writable paths | `ReadWritePaths` = its state directory and the artifact store only |
  | Toolchain | read-only |
  | cgroup limits | `MemoryMax=1536M`, `CPUQuota=80%`, `TasksMax=128` |

- No compiler network access: the builds inherit the unit's IP deny.
- Execution rules: a fixed executable, fixed argv, no shell, no user-supplied flags, paths or filenames (the file name is fixed to `sketch.ino`), and a clean environment.
- **Libraries (D-S7-6):** no third-party or user-installed libraries. Only APIs and headers shipped
  with the pinned core are available; no Library Manager, downloads, uploads or user-controlled
  versions. The build runs with the pinned data directory only (no user library directory).
  Core-bundled libraries whose hardware the simulator does not model (for example `WiFi`,
  `Wire`, `SPI`) compile but are reported by feature analysis (§16) and refused at Run with an
  explicit diagnostic rather than silently "working".
- **Resource enforcement:**
  - Source size limit.
  - A wall-clock timeout that kills the process group.
  - A bounded stdout/stderr buffer.
  - A temp-size watchdog (du every 2 s; kill above the limit).
  - One build at a time (§8), so the unit's cgroup limits are effectively the per-build limits.
- **Cleanup:** per-job directory removal always runs; stale directories are swept at startup.

**S8 public hardening (not claimed in S7):**
- Per-build kernel sandboxing (user namespaces or seccomp, a jailed filesystem view).
- Per-user quotas and rate limits.
- Artifact access control per user.
- Abuse detection.
- Multi-host build capacity.
- The Session Host reading the build manifest instead of trusting browser-sent `firmwareFeatures` (§16).

## 8. Limits (D-S7-8, controlled preview)

| Limit | Value |
|---|---|
| Source size | 64 KiB UTF-8 |
| Active compilations | 1 |
| Queued builds | 3, then `429 busy` |
| Hard compilation timeout | 240 s (process-group kill); no separate warm timeout |
| Retained compiler output | 256 KiB; ≤ 200 parsed diagnostics |
| Temporary storage per build | 512 MiB (watchdog), on disk not tmpfs |
| Artifact cache | 256 MiB LRU. Never evicts an artifact pinned by an active runtime session (the service asks the Session Host's `/health`-style listing, or the host marks pins with a lease file; chosen at implementation, no R2 protocol change). The pinned reference images are never evicted. |
| Build records | in memory, 24 h, 500 entries (lookup by `sourceKey`) |

A cache hit (same `sourceKey`) skips compilation and returns immediately. These are engineering
defaults for a private preview; no capacity claim is made.

## 9. Immutable artifact

- **Canonical bytes:** the merged 4 MiB flash image, exactly as in R1/R2.
- **Artifact id:** `sha256(bytes)`, hex. It is what `CreateSessionRequest.artifact.sha256` carries.
- **Manifest `<sha>.json`** (not part of the artifact bytes):
  - `sourceKey`, `profile`, `profileHash`;
  - app and RAM sizes;
  - features;
  - toolchain versions;
  - created time.
- **Store behaviour:**
  - The store is write-once: publishing uses an atomic rename, and an existing `<sha>.bin` is never rewritten.
  - Identical source produces the same `sourceKey`, which is a cache hit. Different source that yields the same image produces the same sha, which is deduplicated automatically.
- **Session safety:** a session copies its image into a private directory at start (existing R2 behaviour). Neither a rebuild nor an eviction can ever touch a running session.

## 10. Reproducibility gate (heavy)

- Build the blink and echo sketches 3 times each, in fresh job directories, through the real service.
- Require **bit-identical merged images** (option A).
- Also compare against the R1-provisioned `5f177cbe…`/`9ca3a5ce…`. Equality is expected only if the file name and stage path match the provisioning, so the gate records the result rather than assuming it.
- If any byte differs, the gate fails and the differing regions are reported. Option B (a normalized identity with proof that the runtime-relevant bytes are equal) is used only with PM approval, never silently.

## 11. Run integration

- Run with `firmware = sketch` and a current successful build sends `artifact.sha256` from that build and `firmwareFeatures` from its features.
- Everything else is the S6/R2 flow unchanged: one-shot sessions, snapshot, mirrors and transients, SSE, reconnect, the local DC path.

## 12. `.bin` advanced path (D-S7-5)

- The primary workflow is Arduino source → Build → immutable artifact → Run.
- A prebuilt `.bin` remains an **Advanced** path. It is not the normal firmware picker. The two
  S6 pinned demo artifacts become examples/test/engineering infrastructure: the heavy acceptance
  fixtures and the reference firmware for reproducibility comparison.
- The exact Advanced UX (which image form is accepted, how it is stored and how it travels in a
  package, given the 4 MiB merged image and the 2 MiB package limit) is specified at
  implementation start and reviewed before it ships; it must not create a confusing second
  workflow in the normal UI.

## 13. Examples

- `esp32-blink` and `esp32-input-echo` get their Arduino source embedded as `programs[U1]`: the text of `TbiGpioProof.ino` and `TbiBanks.ino` from `runtime/firmware/arduino/`, visible and editable.
- Their board uses `firmware = sketch`. Opening an example therefore shows `Build required`, then Build, then Run.
- They are the Build → Run acceptance projects. Their built artifacts must produce the same GPIO/electrical results as S6 (for blink: 1.939 V, 5.754 mA).

## 14. Serial terminal

- It is reused unchanged: runtime `Serial` output only, and it clears on each new session.
- Build output never goes to the terminal. Build diagnostics live in the source/build panel.

## 15. Source edits while a session runs (D-S7-9)

- Editing is allowed; it is ordinary project work, autosaved.
- The running session keeps its immutable artifact; the build state becomes `Build required`.
- A new Build is **not** allowed while an ESP32 session is running in V1 (the Build button is
  unavailable with a localized reason). After Stop, Build is available again.
- No change ever reaches the firmware of the active session.

## 16. `firmwareFeatures` generation (conservative)

- **Source of truth:** the build, not the user.
- **Two signals:**
  1. **Symbols in the linked ELF.** `xtensa-esp32-elf-nm`: `attachInterrupt*`, `gpio_isr_handler_add`, `gpio_install_isr_service` → interrupts used; `esp_restart` → restart used; library symbols → unsupported library.
  2. **Tokens in the preprocessed sketch** (arduino-cli `--preprocess`): `INPUT_PULLUP`, `INPUT_PULLDOWN`, `gpio_pullup_en`, `gpio_pulldown_en`, `gpio_set_pull_mode`.
- **Which pins.** Constant pin arguments are extracted where the pattern is literal, for example `pinMode(34, INPUT_PULLUP)`. Otherwise the declaration conservatively lists **all input-capable pins**.
- **Effect.** R2 treats any non-empty list as `unsupported_feature`, so Run is refused with an explicit diagnostic that names the feature. The build itself still succeeds, with a build warning ("Uses internal pull-ups: not simulated; Run will be refused").
- **Limitations.** Macros or wrappers may hide usage, and static analysis cannot prove absence. False negatives remain covered by runtime behaviour: pulls are not modelled, and `esp_restart` gives `guest_reset`. The product never claims these features are simulated.
- **Trust.** In S7 the browser forwards the features from the build response. In S8 the Session Host would read `<sha>.json` itself.

## 17. Source editor (D-S7-3)

- **Decision:** a **native `<textarea>` with a light custom layer.** No new dependency, native accessibility, IME and RTL safety, and near-zero bundle cost. It provides:
  - monospace, LTR, no spellcheck or autocorrect;
  - Tab and Shift-Tab indentation;
  - a line-number gutter synced to scroll;
  - a line:column indicator;
  - clickable diagnostic markers in the gutter that jump to the line;
  - the build state and Build button beside it.
- **Not in S7 (D-S7-3):** Monaco and CodeMirror.
- **Placement:** an "Arduino sketch" panel toggled from the editor (ESP32 projects only) that takes the canvas area side-by-side or as a switchable tab. It does not change the approved header.

## 18. Compiler diagnostics UX

- gcc output `sketch.ino:LINE:COL: error|warning|note: message` maps directly, because arduino-cli preprocessing keeps `#line` directives.
- The panel lists severity, `line:col` and the concise message; clicking one jumps to the line.
- Linker and core errors without a line appear as general diagnostics.
- A collapsed "Details" view shows the bounded raw output.
- Chrome and states are localized in Hebrew and English. Compiler messages, identifiers and code are not translated and are always LTR.

## 19. Deployment (dev-lab)

- `publish.sh` builds and installs the build-service bundle next to the Session Host bundle.
- New files:
  - `deploy/dev-lab/tbi-build.service`;
  - a Caddy `handle_path /build/*` → build service inside `http://:8080` (behind oauth2-proxy);
  - one-time provisioning of user `tbi-build`, `/var/lib/tbi-lab/artifacts` and the symlink.
- No new public ports. No Google scopes beyond sign-in. No cloud project storage.

## 20. Tests

**Routine CI (no toolchain):**
- Domain: schema v3 and the v2 → v3 migration; `programs` validation (size, fixed name, profile); `sourceKey`; package round trip with source; duplicate and import keep source; old v2 projects and packages still open.
- App: build-state machine (`required`/`building`/`ok`/`failed`/stale on edit); Run refusal when not current; the edit-during-run rule; diagnostics parsing (a corpus of real gcc outputs); the editor (gutter, Tab, jump to line); locale; no build state persisted.
- Build service (fake arduino-cli that emits recorded outputs and files):
  - API validation and limits, queueing and 429;
  - timeout kill and cleanup, output caps;
  - no user library path, feature analysis on fixture ELF symbol lists and preprocessed text;
  - artifact publish atomicity and LRU.
- E2E against a fake build service plus the fake Session Host: edit → Build → Run → Stop; a failure shows diagnostics; stale after edit; reload lookup.

**Heavy (real toolchain, `TBI_S7_REAL=1`, kept out of GitHub CI):**
- Build blink and echo; the reproducibility gate (§10).
- Run the built artifacts through real R2/QEMU with the full GPIO and electrical results.
- A compiler-error sketch.
- An unmodelled core library (`#include <WiFi.h>`): Build reports it, Run refuses with the diagnostic.
- Feature detection (`INPUT_PULLUP` → Run refused with the diagnostic).
- A timeout sketch (a huge template expansion or `-ftemplate-depth` bomb) killed with cleanup verified.
- A temp-size watchdog case.

## 21. Performance and resource measurement

- **Editor:** keystroke-to-paint p95 on a 64 KiB sketch; autosave latency.
- **Bundle:** size before and after.
- **Build latency:** cold (first after service start) and warm (core cache) medians over 5 runs; service CPU and RSS peaks; temp disk peak; artifact store growth.
- **Runtime:** runtime latency of built firmware against the S6 figures (Run → first result 558 ms).
- **Regression:** the local DC path against the S6 figures (Run 46 ms, Stop 37 ms, wire 4 ms).

## 22. Deferred integrated long run (post-S7, pre-S8)

- Extend the S6 harness with editor typing, autosave, repeated Builds (cache hits and fresh compiles), artifact store growth and eviction, and Build during Run.
- Keep the existing phases: R2/QEMU sessions, local DC, locale, persistence, security.
- Track the IndexedDB logical vs on-disk trend.
- Target: the PM-approved duration on the final S7 build.

## 23. Files and modules expected to change

- `packages/domain`: `schema.ts` (v3 `programs`), `migrate.ts` (2→3), `validate.ts`, `edit.ts` (program edit class), `firmware.ts` (`sketch` value; demos marked reference), `catalog.ts` (board default), `package.ts` and `PACKAGE.md` (documentation of carried source), tests.
- `app`:
  - new `src/build/` (client, state, diagnostics parser);
  - new `ui/SketchPanel.tsx` (editor, build bar, diagnostics);
  - `runtime/snapshot.ts` (sketch → built artifact, features);
  - `sim/format.ts` and `i18n` (new messages);
  - `examples` (source embedded);
  - e2e plus a fake build service fixture.
- `runtime/build/` (new): server, job runner, profile check, feature analysis, store, tests, profile JSON.
- `runtime/provision`: precompiled core cache and the store/symlink setup.
- `deploy/dev-lab`: `tbi-build.service`, Caddyfile route, `publish.sh`.
- **Not changed:** `runtime/host` (R2 protocol and semantics), `experiments/`.
- `docs/sprints/SPRINT-7.md` (final record).

## 24. Known risks

| Id | Risk |
|---|---|
| R1 | Cold compile time on 1 vCPU (the core build) may exceed a comfortable wait. Mitigated by the precompiled read-only core cache; measured first. |
| R2 | arduino-cli may require a writable core cache. The fallback is a per-job cache copy, which costs time and disk. |
| R3 | Reproducibility with a fixed `sketch.ino` name in a service path, measured by the gate. Demo-hash equality with the R1 lock is not guaranteed. |
| R4 | Memory. gcc (~0.5–1 GB) plus QEMU sessions plus the browser on a 3.9 GB host with swap. Builds during runs could slow QEMU wall-time; measured. |
| R5 | Static feature detection is incomplete by nature; runtime behaviour remains the backstop. |
| R6 | Schema v3 makes S7 projects read-only in S6-era builds. This is acceptable in internal development and is the designed guard. |
| R7 | Toolchain footprint: 7.7 GB installed; pruning is optional. |

## 25. PM decisions (approved 2026-09-27)

| Id | Decision |
|---|---|
| D-S7-1 | `schemaVersion 3` with `programs[boardId] = { language, profile, fileName, text }`; at most one Classic ESP32 program in V1; `fileName = sketch.ino`; build/session/runtime state is never project data; deterministic v2 → v3 migration. |
| D-S7-2 | Portable package format version 2; the importer supports v1 and v2; the S7 exporter writes v2. |
| D-S7-3 | Lightweight textarea editor with line numbers and line/column indication; no Monaco or CodeMirror in S7. |
| D-S7-4 | No silent auto-build. An edit makes the artifact stale. Run with a stale or missing build refuses before any runtime request with a localized `Build required`; the previous artifact is never run silently. |
| D-S7-5 | `.bin` stays as an Advanced path; the primary workflow is source → Build → artifact → Run; the S6 pinned demos become examples/test/engineering infrastructure. |
| D-S7-6 | No third-party or user-installed libraries; only what ships with the pinned core; no Library Manager, downloads, uploads or user-controlled versions. |
| D-S7-7 | A separate build service: its own Unix user, hardened systemd unit, loopback-only, same-origin `/build/...` behind HTTPS/oauth2-proxy, no public port, no Session Host or auth secrets, no network for builds, a shared immutable artifact store readable by R2. |
| D-S7-8 | Limits as in §8: 64 KiB source, 1 active compile, 3 queued, 240 s hard timeout (no separate warm timeout), 256 KiB output, 512 MiB temp per build, 256 MiB LRU cache that never evicts an artifact pinned by an active session. |
| D-S7-9 | Source editing during an ESP32 run is allowed and marks the next build stale; a new Build is not allowed while a session runs; Build returns after Stop. |

Toolchain: arduino-cli 1.5.1, arduino-esp32 3.3.12, `esp32:esp32:esp32:FlashMode=dio`, fixed
`SOURCE_DATE_EPOCH`, the existing gcc/esptool pins. No version change without evidence and PM
approval.

## 26. S8 boundary

Public authentication and authorization; per-user quotas and rate limits; per-build kernel sandboxing; per-user artifact access; the host trusting manifests rather than the browser; multi-tenant capacity; production artifact retention; cloud projects.

## 27. Sprint 7 acceptance and closure checklist

1. Schema v3 and migration; all v2 projects and packages still open; source round-trips (autosave, reload, duplicate, export/import, undo) byte-exactly; locale never rewrites it.
2. Sketch panel: editing, gutter, line:col, Tab, Hebrew/English chrome, LTR code.
3. Build states, including stale on edit, and the Run refusal when not current. No auto-build.
4. Build service behind oauth2-proxy only; hardening as in §7 verified (no network from a build, no access to home, secrets or host state).
5. Limits enforced: size, queue/429, timeout kill, output cap, temp watchdog, cleanup verified.
6. No third-party libraries; feature detection with explicit diagnostics; Run refused for unsupported features; Build unavailable while a session runs.
7. Reproducibility gate: 3× bit-identical merged images for blink and echo.
8. Built blink and echo run through real R2/QEMU with the S6 electrical results; determinism hashes stable across builds.
9. Source edit during Run never affects the session; the next Run needs a current build.
10. Diagnostics mapped to lines; raw details bounded.
11. Examples carry editable source and pass Build → Run.
12. Routine suites green (typecheck, lint, boundaries, unit, e2e, browser, production build); heavy S7 and S6 suites green.
13. Performance: bundle delta, editor latency, cold and warm build, service resources, no local-DC regression.
14. dev-lab deployment, with an authenticated smoke through Google: edit → Build → Run → Stop.
15. `docs/sprints/SPRINT-7.md` complete; the deferred integrated long run is scheduled against the S7 build.
