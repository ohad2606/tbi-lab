# Sprint 5 — Product Alpha

**Status:** COMPLETE LOCALLY, awaiting PM review. Not pushed, not tagged, not merged (by
instruction).
**Date:** 2026-09-23 · **Base:** `5c9d16c` (Sprint 4 closure; `sprint-4-complete` pending PM
CI verification) · **Branch/worktree:** `sprint-5` in `~/projects/tbi-lab-sprint5`
**Authority:** PM long-run directive (2026-09-23): Phase A (Sprint 4 closure), Phase B (Sprint 5
Product Alpha); `docs/product/V1-IMPLEMENTATION-ROADMAP.md`; `CLAUDE.md`.

---

## 0. Phase A — Sprint 4 closure

| Item | State |
|---|---|
| Closure record | `31a1d04` was pushed before this directive. It recorded the Sprint 3 closure, the push, the product baseline `5f875a4`, the A15 fix `f359718`, failed run `35884629891` with its test-race explanation, green run `35889275941`, and all gates PASS |
| Additions required by this directive | `5c9d16c` (docs only): no Sprint 5 work in the Sprint 4 baseline; Product Alpha handoff status |
| Pushed | `main` = `5c9d16c` (fast-forward from `31a1d04`) |
| Tag | **`sprint-4-complete` NOT created.** It waits for the PM to verify `5c9d16c`'s CI |

Sprint 5 branches from `5c9d16c` exactly.

## 1. Goal and outcome

The goal was to turn the finished non-MCU laboratory core into a Product Alpha that someone can
use without a developer. A new user can now do all of the following, all tested in Chromium on
the real IndexedDB (§11, A20):

- start from one of six examples, or a new project;
- edit the circuit, run it and read probed results;
- rely on automatic saving;
- export a `.tbilab` file, delete the project and import it again;
- switch between English and Hebrew.

The electrical engine, the DC models and the Sprint 4 runtime semantics were **not** changed.

## 2. What was built

| Area | Where | What |
|---|---|---|
| Portable package | `packages/domain/src/package.ts`, `PACKAGE.md` | Versioned single-file envelope around the unchanged schema v2 document; strict import |
| Hashing | `packages/domain/src/sha256.ts`, `canonical.ts` | Pure FIPS 180-4 SHA-256 over canonical JSON (works where `crypto.subtle` does not) |
| Identity | `packages/domain/src/library.ts` | `copyAsNewProject` for duplicate, import-as-copy and examples |
| Storage | `app/src/persistence/store.ts`, `autosave.ts` | Insert-only `add`, atomic `delete`, quota detection, `Autosave.discard` |
| Library logic | `app/src/state/app.ts` | `renameInLibrary`, `duplicate`, `deleteProject`, `exportProject`, `importPackage`, `openExample`; notice tones |
| Library UI | `app/src/ui/Home.tsx`, `download.ts` | Examples, import, per-project actions, keyboard-usable delete dialog |
| Examples | `app/src/examples/` (`data/*.json` + `catalog.ts`), `app/tests/exampleRecipes.ts`, `scripts/build-examples.ts` | Six curated projects as product data, reproducible from recipes |
| Error UX | `NoticeBar.tsx`, `App.tsx`, messages | Tones, save-failure banner, quota wording, storage-unavailable screen with Reload |
| Polish | `TopBar.tsx`, `Palette.tsx`, `Inspector.tsx`, `Canvas.tsx`, `styles.css` | §9 |

## 3. Project library (A1–A3)

- **Create / open / recent:** as Sprint 2, sorted by last change. The app reopens the last
  project after a restart.
- **Rename** (library or editor): same `projectId`; a normal persistent edit with a new
  `localRevision`; engineering content untouched; the name is stored exactly as typed (trimmed).
- **Duplicate:** a new, independent project (`copyAsNewProject`):
  - new `projectId`, `createdAt` and `createdWith`; `revision` restarts at 1;
  - components, parameters (toggle positions included), nets and their user names,
    connections, layout and id counters are copied exactly;
  - the name is `"<name> (copy)"` in the UI language at that moment (`"<name> (עותק)"`), and is
    then ordinary user text;
  - simulation state, probes, undo history and button presses are never copied (none of them
    are in a document).
- **Delete:** a modal `<dialog>`. Focus starts on "Keep project"; Esc keeps the project. The
  store then:
  1. discards any pending autosave of that project;
  2. waits for an in-flight write;
  3. deletes the document and its index entry in one IndexedDB transaction.

  Deleting the open project returns to the library. Other projects are untouched (tested
  byte-for-byte). A failed delete leaves the project in place with a message.
- **Not undoable:** library deletion is not part of undo; the confirmation explains this and
  suggests exporting first. Undo/redo remains editor-session history.

## 4. Portable format (A4–A9)

The full specification is in `packages/domain/PACKAGE.md`. In summary:

- **File:** `.tbilab`, UTF-8 JSON, envelope `format: "tbi-lab.package"`, `formatVersion: 1`.
  - `project`: the exact document.
  - `source`, `firmware`, `toolchain`: sections that are `null` until Sprints 6/7.
  - `integrity`: `sha256` over `tbi-lab.canonical-json.v1`.
  - `exported`: provenance (app, version, time), never engineering state.
- **Never exported:** results, Worker/session state, probes, undo history, selection, camera,
  button press state, UI language.
- **Exported:** the toggle position, which is persistent.
- **Size limit:** 2 MiB. The examples are 4–8 KB and a 30-component project is 27.5 KB.
- **Hashing:** pure TypeScript SHA-256, tested against the NIST vectors (including one million
  `a`s) and against Node/OpenSSL for every length 0–300 plus random inputs up to 70 KB.
  - Why not Web Crypto: `crypto.subtle` exists only in secure contexts, the same trap as
    `randomUUID` in Sprint 4.
  - No dependency added.
  - The hash covers canonical engineering bytes, so it is identical whatever UI language
    exported the project (unit test and browser test A9/A14).
- **Import:** parse, then validate, then write. Twelve ordered checks with refusal codes:
  - size, ZIP detection, JSON only, and forbidden prototype keys;
  - the package format, its version and the envelope shape;
  - null MCU sections and a matching hash;
  - newer or old schema, full structural validation, and no unknown fields at any level.

  Nothing is executed. Refusal happens before any write; the browser test proves the stored
  bytes are unchanged. Messages are localized, say "Nothing was imported", and never show raw
  errors or paths.
- **Collision:** an id that is not stored locally is imported exactly. An id that already
  exists is **never overwritten**: the package becomes an independent copy with a new id (the
  name is kept), and the user is told. The write is an insert-only `add`, so a race cannot
  overwrite either.
- **Round trip:** export → delete → import restores the stored document exactly, including
  toggle state and Hebrew/Unicode user text (unit and browser tests).

## 5. Examples (A10, A11)

Each example is ordinary product data: a JSON project document built by a recipe through the
normal edit operations. A unit test requires the committed JSON to equal the recipe output.

Opening an example stores a **new** local project and names it in the current language. It
then runs through the same engine as any other project. There is no hidden state; the
suggested probes are editor UI state only.

| Example | Circuit | Expected (production engine; hand-checked where linear) |
|---|---|---|
| Ohm's law | 5 V → 1 kΩ | 5 mA, CV |
| Voltage divider | 9 V → 10 kΩ → 20 kΩ | V(R2.a) = 6 V, 0.3 mA |
| LED current limiting | 5 V → 220 Ω → red LED | 1.982 V, 13.72 mA (nonlinear) |
| Diode polarity | two 1 kΩ + 1N4148 branches | D1 forward 685.8 mV / 4.314 mA; D2 reversed −4.2 nA |
| Momentary push button | 5 V → button → 330 Ω → LED | 0 A released; 9.206 mA held; exactly the released state after release |
| Current limit (CC mode) | 5 V / 100 mA; 100 Ω plus 10 Ω behind a toggle | open: 50 mA CV; closed while running: 100 mA **CC**, 0.909 V, no error |

The browser test (A10/A11) opens every example and runs it. It compares the displayed probe
and PSU-panel values with the engine run on the stored project, holds the button, and flips
the toggle while running.

## 6. Error and recovery UX (A12)

There is one small system: a `Notice` holds a message key, parameters and a tone (`error`,
`warning`, `info`). Messages are keys only, so no exception text can reach the UI.

| Situation | What the user sees |
|---|---|
| IndexedDB unavailable at start-up | A calm screen: nothing was changed; allow site storage or use a regular window; **Reload** |
| Save fails | Banner: changes are not saved yet but are still in the editor; **Try again**; export a copy. A quota error gets its own wording |
| Storage full during duplicate/import/example | "Storage is full… existing projects are safe" |
| Import refused | Specific reason (not a project file, damaged, newer version, old format, invalid circuit, too large, unreadable) + "Nothing was imported" |
| Stored project damaged | Cannot be opened; other projects are not affected |
| Export or delete fails | The project is unchanged; try again |
| Worker failure / simulation validation | Sprint 3/4 messages, unchanged (tested again in Hebrew) |

Words such as "fatal" are not used. Every message states what is safe.

## 7. Localization (A13–A15)

- Every Sprint 5 string ships in English and Hebrew. The i18n test enforces an identical key
  set and no hard-coded strings in TSX.
- Hebrew terms: ייצוא (export), ייבוא (import), שכפול (duplicate), and the approved
  `אדמה (GND)`.
- Technical fragments inside Hebrew sentences (values, formulas, R2.a) are LTR-isolated in the
  bundle.
- User-authored names in messages and the delete dialog use first-strong isolation, so an
  English name in a Hebrew sentence keeps correct punctuation. The stored text is never
  altered (unit test).
- Browser tests:
  - A13/A15: every new surface in Hebrew contains only technical tokens; the chrome is RTL;
    the canvas and engineering values stay LTR.
  - A9/A14: a project created, edited and exported in Hebrew imports in English byte-identical,
    with the same hash.
- Switching language changes no project byte, toggle state, orientation, value, hash,
  connection or identity. The browser test switches locale four times during an autosave and
  sees exactly one new revision.

## 8. Schema discipline

**No project-schema change.** `schemaVersion` stays 2 and no document field was added. The
package is a separate envelope with its own `formatVersion`. Library metadata remains the
separate IndexedDB index. See `SCHEMA.md` ("Sprint 5: no schema change").

## 9. Product Alpha polish (no redesign)

- **Top bar:** three groups separated by rules:
  1. navigation: brand, "‹ Projects", project name;
  2. circuit work: undo/redo, Run/Stop and status;
  3. file and settings: save state, Export, language.

  The language label is visually hidden but stays accessible, because the select shows each
  language's own name. Nothing wraps at 1400 px.
- **Palette:** the seven parts are grouped under quiet labels: supply and reference, resistors,
  diodes, switches.
- **Inspector:**
  - probes and checks are lighter secondary sections;
  - the probes note appears only when probes exist;
  - keyboard help moved into a disclosure.
- **Canvas results:**
  - two-terminal parts turned upright put their reference, value, state and runtime labels
    beside the body instead of across their wires;
  - probe labels sit away from the wire leaving their terminal;
  - canvas text has a background-coloured halo.

  This is no label-placement engine; it only fixes the overlaps seen in the review.
- **Library:** a header with Import; an example grid; project rows with small actions; a
  danger-styled delete confirmation.

## 10. Accessibility

- The library is fully keyboard-operable (browser test).
- Delete uses a modal `<dialog>`: focus is trapped and starts on the safe choice, and Esc
  cancels.
- Import is a real button tied to an accessibly labelled file input.
- Actions have names that include the project ("Open Beta", "Actions for Beta").
- Visible focus is unchanged. State is never colour-only (notice tone is text plus colour; save
  state has an icon and text).
- Space is not rebound: it still belongs to switch actuators.

## 11. Acceptance criteria — results

| # | Result | Evidence |
|---|---|---|
| A1 | **Pass** | `sprint5.spec` A1-A3 (create, rename, duplicate, delete, full reload) + keyboard test; `library.test` restart on the same storage |
| A2 | **Pass** | `library.test` duplicate: new id and history, identical engineering content incl. toggle, independent afterwards; browser A1 |
| A3 | **Pass** | Dialog (Esc/Keep/Delete), other projects byte-identical, open-project deletion returns home; failed delete keeps the project |
| A4 | **Pass** | `package.test` envelope shape; browser A4-A6 download parsed against `PACKAGE.md` |
| A5 | **Pass** | Unit + browser: export → delete → import = identical stored document (toggle state, Hebrew/Unicode text) |
| A6 | **Pass** | Envelope has no runtime fields; exported while running with probes, no probe, pressed, result, history or selection data |
| A7 | **Pass** | 10 domain rejection tests, one covering 14 invalid-circuit cases (incl. prototype keys, extra fields, hash mismatch); browser: 7 refusals, stored bytes unchanged |
| A8 | **Pass** | Unit + browser: colliding import → copy with new id, local project untouched, `import.doneCopy` notice |
| A9 | **Pass** | Canonical hash independent of key order and UI language (unit and browser); NIST + OpenSSL cross-checks |
| A10 | **Pass** | All six instantiate as fresh stored projects and run (unit via the store; browser) |
| A11 | **Pass** | `examples.test` engine values vs hand calculation; browser displayed values equal the engine on the stored project (button held, toggle to CC) |
| A12 | **Pass** | Unit: quota/save/retry, storage failure on import, delete failure, damaged project, unreadable storage. Browser: quota banner + retry, worker crash in Hebrew, no internals |
| A13 | **Pass** | i18n key-set test; browser Hebrew completeness of library, dialog, rename, import error and editor |
| A14 | **Pass** | Browser A9/A14: Hebrew-created/exported → English import byte-identical, same hash, same name |
| A15 | **Pass** | Browser: `dir=rtl` chrome, canvas and probe readings `ltr` |
| A16 | **Pass** | Browser A16: rename + navigate, duplicate + open, export right after an edit, locale switches during autosave (+1 revision exactly), edit + leave + delete (no resurrection), example + immediate run, import + reload. Unit: delete with a pending autosave (fails without `Autosave.discard`) |
| A17 | **Pass** | §13: library, duplicate, export, import, example and reopen measured; the 30-part editor matches Sprint 4 |
| A18 | **Pass locally** | All Sprint 0-4 unit and browser tests pass (§12). Remote CI pending: not pushed, by instruction |
| A19 | **Pass** | No workflow change; nothing routine touches the ESP32/QEMU toolchain |
| A20 | **Pass** | Browser A20: example → edit → run → probe → export → delete → import → Hebrew run, with no developer steps |

## 12. Tests

| Suite | Count | Sprint 4 | Result |
|---|---:|---:|---|
| `packages/domain` (**new:** `package.test.ts` 23: SHA-256, canonical JSON, package, import rejection, copy identity) | 144 | 121 | pass |
| `packages/engine` (unchanged) | 57 | 57 | pass |
| `app` unit (**new:** `library.test.ts` 18, `examples.test.ts` 10) | 90 | 62 | pass |
| Sprint 0/1 (`experiments/`, unchanged) | 55 | 55 | pass |
| **Unit total** (`npm test`, 28 files) | **346** | 295 | pass |
| `app` Chromium acceptance (`npm run test:e2e`) (**new:** `sprint5.spec` 11, `sprint5-performance.spec` 1, insecure-context export/import 1) | **62** | 49 | pass |
| Sprint 0 browser (`npm run test:browser`) | 4 | 4 | pass |

`typecheck`, `lint` (ESLint, Prettier, boundary) are clean.

**Changed existing tests (not weakened):**

- `locale.spec` (Sprint 2 Hebrew completeness) now also scans the new library. Its allowlist
  gains three engineering-token categories that already appear in Sprint 4's own allowlist:
  the `SW` reference prefix, the `1N4148` model token and the `I` symbol in formulas. Its
  unit-stripping regex no longer removes the "V" from "CV", which had produced a stray "C".
- No other existing test changed. The only fixed waits in the new specs prove the absence of a
  write (after a delete).

## 13. Performance (measured on the 1-core ARM64 dev host; no SLA)

**Sprint 5 operations** (`sprint5-performance.spec`, 50 projects in the library; final run):

| Operation | Median | p95 |
|---|---:|---:|
| Library cold load (page reload → 50 rows rendered) | 152 ms | 177 ms |
| Library from editor | 49 ms | 62 ms |
| Duplicate (click → new row; the IndexedDB commit is awaited first) | 16 ms | 23 ms |
| Editor reopen (click → circuit rendered) | 20 ms | 40 ms |
| Example instantiation (click → stored and rendered) | 16 ms | 24 ms |
| Export (click → download received by Playwright) | 50 ms | 75 ms |
| Import, in-app (file `change` → editor rendered) | 137 ms | 155 ms |
| Import including Playwright's file transfer | 163 ms | 174 ms |

Import breakdown (instrumented once, not committed):

| Stage | Time |
|---|---|
| Parse + validate + hash | ≈ 4 ms (≈ 2 ms in Node) |
| IndexedDB collision check + insert | 5–60 ms (single-core noise) |
| Open + editor render | 16–125 ms |

**Sprint 4 comparison** (same specs, final run):

| Measurement | Sprint 4 | Sprint 5 |
|---|---:|---:|
| 30-part drag, median / p95 | 33 / 49 ms | 33 / 51 ms |
| 30-part Run → result, warm median | 13–14 ms | 15.3 ms |
| 30-part solve in worker | 0.8–1.7 ms | 2.3 ms |
| Long tasks per 11 Stop/Run cycles | 0–1 | 1 (76 ms) |
| Button transition, median | 119 ms | 120 ms |
| Toggle while running, median | 76–81 ms | 88 ms |
| Undo, median | 51–57 ms | 50 ms |

The Run → result differences are within this host's run-to-run spread. The engine is unchanged.

**Regressions found by measurement and fixed:**

1. `Intl.DateTimeFormat` was built per library row per render. It is now cached per locale.
2. Every library row subscribed to the whole app state, so any store update re-rendered all
   50+ rows. Rows now take locale and translation as props and are memoised.
3. Import re-rendered the library just before leaving it. It now opens the project first.

Before these fixes, duplicate took 37–42 ms and example instantiation 33–42 ms (medians).

## 14. Dependencies

**None added.** SHA-256 and canonical JSON are in-repo. The example generator runs with the
existing `vite-node` (from Vitest).

## 15. Report

### 15.1 Deviations

1. **Sprint 4 closure is two docs-only commits** (`31a1d04` + `5c9d16c`), not one. `31a1d04`
   was already pushed when this directive arrived; the two newly required statements went into
   `5c9d16c`. `sprint-4-complete` should target `5c9d16c`.
2. **Single JSON file instead of the roadmap §12.2 ZIP**, as the PM directive preferred.
   Detection of a future ZIP version is built in.
3. **A newer-schema package is refused on import** (A7). A newer-schema project already in
   local storage still opens read-only, as before.
4. **A hand-edited package is refused** (hash mismatch → "damaged or changed outside TBI
   Lab"). That is the purpose of the integrity hash; a teacher editing JSON by hand needs to
   know this.
5. **Duplicate names are localized at creation** (`(copy)` / `(עותק)`) and are then ordinary
   user text. Example project names follow the same rule.
6. **Suggested probes apply only when an example is first opened.** Probes are session UI
   state, so a reopened project starts without them.
7. **Examples number six**, as directed (the roadmap listed examples 1-4 for Sprint 5).

### 15.2 Product defects found and fixed during Sprint 5

- A probe pin on a part's centre intercepted clicks, so a probed part could not be selected
  there. Pins are now click-through (found by the A8 browser test).
- User-authored names inside Hebrew confirmation messages rendered with scrambled punctuation.
  They are now first-strong isolated (found in the visual review).
- A pending autosave could write a just-deleted project back. `Autosave.discard` prevents it
  (a design issue caught before shipping; the unit test fails without the fix).
- The three performance defects in §13.

### 15.3 Remaining Product Alpha risks

| Risk | Note |
|---|---|
| Remote CI | Sprint 5 has not run on GitHub (not pushed, by instruction) |
| Browser storage eviction | Projects live in best-effort IndexedDB. The app does not request `navigator.storage.persist()`, so a browser under storage pressure may evict them. Export is the user's backup; requesting persistence is a small follow-up decision |
| Firmware in packages (Sprint 6/7) | Version 1 is JSON-only. Firmware images need a format version 2 (ZIP or base64). This must be decided before the package freeze (end of Sprint 7); it does not block Sprint 6 |
| Pure-JS SHA-256 throughput | About 10 MB/s (Node on the dev host): a 4 MB firmware image would take roughly 0.4 s. Acceptable, but in Sprint 6 hash in the Worker, or use Web Crypto when available with this implementation as the fallback |
| Large libraries | Measured at 50 projects; no list virtualisation. Hundreds of projects are untested |
| Import latency | 137 ms median in-app on the floor host, dominated by IndexedDB and the editor render, not parsing |
| Single-core timing variance | Interaction figures vary by ±20–30% between runs on this host |

### 15.4 PM decisions

**No PM decision blocks Sprint 6.** Open, non-blocking items:

- **Procedural:** verify `5c9d16c`'s CI, then tag `sprint-4-complete` on it.
- **Before the Sprint 7 package freeze:** how firmware bytes enter the package (ZIP container
  vs base64 in JSON).
- **Optional:** whether Product Alpha should request persistent storage
  (`navigator.storage.persist()`).
