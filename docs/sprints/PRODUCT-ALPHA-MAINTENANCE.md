# Product Alpha maintenance pass (after Sprint 5 and Runtime R1)

This pass implements exactly five PM review items on top of `runtime-r1-complete` (`1df4fa5`). It is
not Sprint 6, and it does not touch the R1 runtime (`runtime/`) or the schema (still version 2).

## 1. Unambiguous project names

The project id remains the identity. A display name is user-authored text, stored exactly as typed
(only surrounding whitespace is dropped). New names are compared by a key that is never stored or
shown (`projectNameKey`, `packages/domain/src/library.ts`):

- Unicode NFKC normalization, so composed/decomposed and compatibility forms compare equal;
- directional marks and isolates removed;
- whitespace trimmed and internal runs collapsed to one space;
- lowercased, i.e. case-insensitive for cased scripts such as Latin (Hebrew is unaffected).

| Action | Behaviour |
| ------ | --------- |
| Create | A name that reads the same as an existing project's name is refused. The message is inline and localized under the field; nothing is created. The field suggests the first free default name ("Untitled project", "Untitled project 2", …), so accepting the suggestion never conflicts |
| Rename (library and editor) | Refused the same way. The project id is preserved and nothing is written: a failed rename makes no revision. A case change of the project's own name is allowed |
| Duplicate | Always succeeds with the first free name in the active locale: "Project (copy)", "Project (copy 2)", "Project (copy 3)"; in Hebrew "פרויקט (עותק)", "פרויקט (עותק 2)", … |
| Import | An id collision still never overwrites anything (a new id is created). If the display name conflicts, the first free copy-style name is used and the notice says so (`import.doneRenamed`, `import.doneCopyRenamed`) |
| Open example | A second instance of the same example gets a copy-style name as well |
| Legacy duplicates | Never renamed at startup or on open, and remain openable. The rule applies only to future create, rename, duplicate, import and example actions |

## 2. Laboratory supplies in parallel

**Finding.** The investigation used the production engine, the Sprint 3 lab-PSU model (an ideal CV
source that becomes an ideal CC source at its limit).

Before this pass, every directly paralleled pair failed with the generic `singular_circuit` error:
equal CV setpoints, unequal CV setpoints, loads beyond one or both current limits, and
anti-parallel pairs.

These solved correctly, and still do:
- supplies that merely coexist;
- supplies on different nets;
- supplies in series;
- supplies joined through a resistor;
- a paralleled supply whose output is OFF (high impedance).

With the current model:

| Direct-parallel state | Unique operating point? |
| --------------------- | ----------------------- |
| Both in CV, equal setpoints | No. Any current split satisfies the equations |
| Both in CV, unequal setpoints | No. The two voltages contradict |
| One CC, one CV, equal setpoints | No. Which supply limits is ambiguous |
| All in CC | Yes. For example, 5 V/0.1 A ∥ 3 V/0.1 A into 10 Ω gives exactly 2 V. But the solver starts from all-CV, which is singular, so it cannot reach this state |

**Product rule applied: unsupported.**
- The engine refuses two enabled outputs across the same pair of electrical nodes (either polarity,
  including through closed switches) as `psu_parallel`, naming the supplies, before solving.
- No current sharing, balancing resistance or source priority is invented.
- Enabling the all-CC subset would require a solver change (active-set search), which is outside this
  pass.

**UX** (a titled explanation, not a solver failure):

| | English | Hebrew |
|-|---------|--------|
| Title | Parallel power supplies are not yet supported | ספקי כוח במקביל עדיין אינם נתמכים |
| Body | PSU1 and PSU2 are directly connected in parallel. The current simulator cannot determine a unique current sharing between supplies. | PSU1 ו-PSU2 מחוברים ישירות במקביל. הסימולטור אינו יכול עדיין לקבוע חלוקת זרם יחידה בין הספקים. |
| Guidance | Use one supply, or separate the outputs with circuit elements. | השתמשו בספק אחד, או הפרידו בין היציאות באמצעות רכיבי מעגל. |

## 3. One Run/Stop control

There is now exactly one control. The run semantics are unchanged.

| State | Label and treatment |
| ----- | ------------------- |
| Stopped, or after a failed run | "Run" / "הרצה", play icon, green |
| Starting or running | "Stop" / "עצירה", stop-square icon, red |

- Both faces are rendered in one grid cell and the inactive one is hidden. The button therefore
  always has the width of its longer label in the current locale, with no English-tuned width.
- The status pill reserves the width of its longest label in the same way, so a state change never
  moves the toolbar.
- The accessible name follows the visible label. The element never changes, so keyboard focus stays
  on it.

## 4. PSU output on by default

- A newly created supply has `outputEnabled = true`: the catalog default, used both by a new
  project's PSU1 and by a supply placed from the palette.
- Stored projects keep their own value; nothing is rewritten.
- The curated examples already set it explicitly.
- Export/import, duplicate and undo/redo carry the stored value, and a locale change writes nothing.

## 5. Branding on the Projects screen

- The header now shows the elongated TBI logo at 150 px (was 100 px) with a larger title.
- The source files were inspected (`app/src/assets/brand/README.md`). `logo_no_bg.png` has no alpha
  channel: a checkerboard is painted into its pixels, so it is not used.
- The asset is `logo_main.png` with its painted navy background turned into real transparency by
  colour-to-alpha. It is not redrawn, and it composites onto the navy header band without a visible
  box.
- It is a 2x asset (533 × 300, 128 KB); the originals are not committed.

## Tests

| Suite | Before | After |
| ----- | ------ | ----- |
| Unit (`npm test`) | 374 | 403: domain names 6, engine parallel PSU 9, app maintenance 14 |
| App browser acceptance (`npm run test:e2e`) | 67 | 77: `maintenance.spec.ts` adds 10 |
| Sprint 0 browser (`npm run test:browser`) | 4 | 4 |

Existing e2e tests were changed only where the approved behaviour changed:
- one control instead of two;
- re-importing your own export now gets a copy-style name;
- circuits set the PSU output explicitly in both directions;
- two waits no longer use "output on" as proof that the wiring is durable.

## Remaining concerns / backlog

- The save indicator's label ("Saving…" / "All changes saved") still changes width, which moves the
  end-aligned toolbar group while a save is in progress. This is not caused by Run/Stop and was not
  changed in this pass.
- Supporting an all-CC parallel operating point would need a solver change and a PM decision.
