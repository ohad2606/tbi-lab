# Sprint 26 — Managed libraries and multi-file programs (DEV)

Branch `sprint-26` (from `3c4cbd6`; the rest of the Sprint 25 closure merged in `d677926`). Target: DEV only (tbi-lab-srv).
Runtime unchanged: Runtime v5 `39f2229a66d45e43`.

## Phase 0 — baseline (2026-10-31)

| Item | Finding |
|---|---|
| Build protocol | `tbi-lab.build/1`: `{profile, files[{name,text}]}`, 1–16 files, names without paths, 1 MiB body; `sourceKey` already hashes every file (sorted by name). The providers accepted exactly one file. |
| Build sandbox | `tbi-build-job@`: `PrivateNetwork=yes`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`, toolchain read-only, 1 GiB / 80 % CPU / 260 s. Unchanged by this sprint. |
| Arduino libraries | none beyond the core's (empty per-job sketchbook); the analyzer reports any other library as `library:<name>`. The LCD examples drove the PCF8574 by hand. |
| MicroPython delivery | `main.py` as source in the interpreter's own LittleFS partition (`tbi-mklfs`, flat names), `mpy-cross` as a syntax check; imports outside an allow-list refused. |
| Project | schema v5, one `ProgramSource {language, profile, fileName, text}` per board; undo covers code (coalesced typing); package format v2. |
| Editor | one textarea with a line gutter; diagnostics assumed one file. |
| LCD1602 I2C | PCF8574 + HD44780 model (writes); reads and clocks above 100 kHz refused by name (Sprint 25). |

## Architecture

### Project model (schema v6)

`ProgramSource` gains two optional fields:

- `files: {path, text}[]` — further files, sorted by path, never the entry file;
- `libraries: {id, version}[]` — the managed libraries pinned for the program, sorted by id.

A v5 document means exactly the same in v6 (migration v5 → v6 is the identity, like v3 → v4 and
v4 → v5); a one-file program carries neither field, so its document is byte-identical to before.
Builds before v6 open a v6 file read-only, by name (the established newer-schema rule).

Path rules (`programPathIssue`, shared by the editor, validation, the build service and both
providers): relative `/`-separated paths of portable names (no `.`/`..`, empty segments,
backslashes, dot files, spaces), at most 3 levels and 96 characters, unique ignoring case, never
the entry file.
- Arduino: `.ino .cpp .c .h .hpp` in the sketch folder; `.cpp .c .h .hpp` under `src/` (arduino-cli
  compiles the sketch folder and `src/` recursively); `sketch.*` reserved.
- MicroPython: `.py` files whose segments are Python identifiers; `boot.py` reserved.
Limits: 16 files with the entry, 64 KiB per file, 256 KiB per project.

### Managed library registry

`packages/domain/src/libraryRegistry.ts`: id, name, language, exact version, source URL + commit
(+ tag), SPDX licence and copyright, tree checksum, dependencies, profiles, runtime capabilities,
served component types, what code names it by (`#include` header / module), validated operations,
limitations, usage example.

Sources are vendored byte for byte in `runtime/libraries/<id>/<version>/` (`.gitattributes`:
`-text`), packed by `scripts/gen-library-sources.ts` into `runtime/libraries/sources.json`, and
verified against the registry's tree checksum (canonical JSON of `[{path, sha256}]`) before any use.
Nothing is fetched at build time; build jobs keep no network.

| Library | Version | Licence | Serves | Validated |
|---|---|---|---|---|
| LiquidCrystal_PCF8574 (Matthias Hertel) | 2.2.0 (tag commit `4cb67f4`) | BSD-3-Clause | `display.lcd1602_i2c`, Arduino | begin, setBacklight, clear, home, setCursor, print |
| python_lcd `I2cLcd` (Dave Hylands) | `0.0.0-git.7affb0b` (no tags upstream) | MIT | `display.lcd1602_i2c`, MicroPython | I2cLcd, clear, move_to, putstr, backlight_on |

Both drivers only write to the PCF8574 (checked in the source: no `requestFrom` / `readfrom`); the
part's own refusals (any read, a clock above 100 kHz) still apply to whatever a library does.

### Dependency resolution

`resolveLibraries(doc, program)`: the libraries serving a placed component (for the program's
language and profile) plus those its code names (`#include <…>` / `import` / `from … import`,
comments ignored), with their dependencies; a pinned version is kept. `settleLibraries` runs inside
every circuit and program edit, so a library appears or goes in the same undo step as the part or
include that needs it; opening a project never rewrites it; user code is never edited.

### Build

- Request: optional `libraries: [{id, version}]`; file names may be relative paths. The service
  checks the whole set (`checkRequestFiles`) and resolves the libraries (`requestLibraries`: exact
  id and version of the request's language and profile, dependencies present; otherwise 422
  `unknown_library`, never another version) before anything is held.
- Cache key: `sourceKey(profile, files, libraries + tree)`; a request without libraries keeps its
  earlier key exactly.
- Arduino: every file written at its path under `sketch/` (folders created by the provider, files
  created exclusively); the pinned libraries in the job's own sketchbook `user/libraries/<name>`,
  read-only to the tools. The argv and configuration are unchanged, so the core seed is shared.
  Diagnostics name the project file and line; one in a library names the library file in its
  message. The analysis reads every project file; a pinned managed library is supported when the
  runtime announces its capabilities.
- MicroPython: every module at its path in the interpreter's file system, the libraries' modules in
  `/lib` (on `sys.path`), each project file syntax-checked by `mpy-cross` (diagnostics name the
  module); a project module may not shadow a library module. `tbi-mklfs` now creates folders
  (strict segment checks) — a new pinned MicroPython build home.

## Gates and deployment (2026-10-31, head `d677926`)

`d677926` = the Sprint 26 work (`2437b80`, `bd38c01`, `99759ac`), the gate test fixes (`92a9658`)
and a merge of the Sprint 25 closure commits the branch had not yet carried (`a0c2b85`, `f695238`,
`6c026c9`: the v5 night-light schedule, the current input-echo fixture, the s13 live test).

| Gate | Result |
|---|---|
| Typecheck, lint, format, boundary | clean |
| Unit | 2038 passed, 3 skipped (207 files) |
| Browser e2e (fake services) | 309 passed, 40 skipped on `99759ac` with 5 failures, all expectations S26 made out of date: "ESP32 LCD" now finds 4 examples; A7's damaged/future cases moved one past schema v6; the LTR-isolated S26 file and library names added to the Hebrew technical-token list. The 3 specs: 17 passed after the fix |
| Runtime suite (real toolchain, real QEMU v5) | 223 passed, 12 failed, 19 skipped of 254 on `99759ac`. Fixed: `s18f-build-seed` (built only a program's first file; now the whole request with its libraries), `r1-determinism` night-light (closure fixture missing until the merge; 2/2), `s8-policy` and `s8-qemu-tasks` (staging still ran S25 and refused schema v6; 9/9 on S26 staging). Remaining 8 known: the 7 R2 gate-workload tests (`psu_sinking`, Sprint 22 rule) and `s19b-x1` — unchanged owner decisions |
| Sprint 26 real tests | `s26-multifile.runtime.test.ts` 8/8 |
| Package | built twice, byte-identical: 34 files, manifest `6fdc715fb6ea2e96` |
| Staging browser (tbi-s8, real QEMU) | s26-real 2/2; b1 16 passed + 2 skipped; b2 11/11 (a first run hit the staging session-creation rate limit, 20 per 10 min, at 15:20:40 — rerun alone); b3 7/7; services 0 restarts |
| DEV-Lab deploy | `d677926`, Runtime v5 `39f2229a66d45e43`; the only unit change is the MicroPython bind (S24 → S26 build home); polkit, Caddy, policy and keys unchanged; 0 restarts |
| DEV-Lab acceptance | 13/13 (S25 regression cases + the two S26 library cases, EN/HE) |
| Rollback rehearsal | back to `a0c2b85` in 0.9 s (record tool: 113 rows, 0 incompatible), Build/Run/Stop 4/4; forward in 0.8 s, Build/Run/Stop 4/4 and the S26 library cases 2/2 |

After a rollback, schema-v6 projects open read-only on `a0c2b85` (never rewritten).

## Status

See the DEV report (`~/tbi-s26/report/`).
