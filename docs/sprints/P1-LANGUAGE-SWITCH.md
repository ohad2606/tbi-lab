# P1 — Language switching must never lose code (DEV)

Branch `p1-language-switch` (from `002029d`, the Sprint 26 head). Target: DEV-Lab only. Alpha and
RC5 unchanged. Runtime unchanged: Runtime v5 `39f2229a66d45e43`.

## Owner report (2026-11-01)

ESP32 ultrasonic distance alarm example → Code tab → Arduino → MicroPython → Arduino: the example's
Arduino code was gone; the Arduino starter program was in its place.

## Root cause

`setProgramProfile` (`packages/domain/src/edit.ts`) replaced the board's whole `ProgramSource`
with the new language's starter program. The Code view applied it through `store.apply` after a
`window.confirm`, and autosave then wrote the replaced program to IndexedDB. Switching back did
the same again: the other language's starter, not the earlier code.

The data was really lost: the stored project no longer contained the code. Only the session's undo
history held it (undo right after the switch restored it; after a reload or once the history moved
on, nothing could). Code lost this way before this fix cannot be recovered by the fix.

## Fix

### Project model — schema v7

`ProgramSource` gains one optional field:

- `alternates: ProgramVariant[]` — the board's program in each other language, complete
  (`language`, `profile`, `fileName`, `text`, `files`, `libraries`), sorted by profile; a
  `ProgramVariant` is a `ProgramSource` without `alternates` (no nesting).

Migration v6 → v7 is the identity: a v6 document means exactly the same in v7 and carries no
`alternates`. Builds before v7 open a v7 file read-only, by name (the established newer-schema
rule). Validation (`checkProgram`, also applied to every kept variant) refuses an empty list, a
duplicate profile, the active profile, nesting, and every per-program rule the active program has
(paths, sizes, NUL, libraries). Nothing is migrated destructively; nothing is deleted.

### Switching (`setProgramProfile`)

- The active program (every file and pinned library, byte for byte) is kept in `alternates`.
- If the project already has code for the target language, it is restored exactly
  (`restored: true`). Its pinned library versions are kept and none is removed; only a library the
  circuit now needs and the kept code lacks (a part placed while the other language was active) is
  added, exactly as placing that part would have added it.
- Otherwise the target language's starter program opens (`restored: false`) with the libraries the
  circuit's parts need for that language.
- No code is translated, converted or generated. Nothing crosses from one language to the other.
- One undo step reverts the switch.

### Code view

No confirmation dialog any more (nothing is discarded). A notice says what happened:
`program.language.restored` ("its code is back exactly as you left it; your … code is kept") or
`program.language.started` ("this project has no … version of its program (for a built-in
example: none has been verified), so the … starter program is open; your … code is kept
unchanged"). EN and HE; the language names are LTR-isolated. The key `program.language.confirm` is
removed.

### Verified example twins

`EXAMPLE_VARIANTS` (`app/src/examples/catalog.ts`) pairs built-in examples whose two versions run
on exactly the same circuit:

| Arduino | MicroPython |
|---|---|
| `esp32-blink` | `mpy-blink` |
| `esp32-led-fade` | `mpy-fade` |
| `esp32-pot-threshold` | `mpy-pot-threshold` |
| `esp32-lcd-hello` | `mpy-lcd-hello` |
| `esp32-lcd-library` | `mpy-lcd-library` |

Opening one of these examples keeps the twin's program as the other language's code, so switching
shows the verified version. `circuitKey` compares components (id, type, version, parameters), nets
and connections; when they differ the twin is not attached (fails closed) and the starter opens.
A unit test asserts every declared pair is identical.

### Ultrasonic distance alarm in MicroPython

> Superseded on branch `mpy-expansion` (DEV, not released): `machine.time_pulse_us` was validated
> against the HC-SR04 model and allowed, and every built-in ESP32 example now has a verified twin
> (docs/sprints/MPY-EXPANSION.md). The text below describes RC6.

Not supported, and the product says so. `machine.time_pulse_us` (needed to time the HC-SR04 echo)
is in the refused list (`runtime/builder/pyFeatures.ts`, `MACHINE_REFUSED_NAMES`) on Runtime v5;
Sprint 12 G2 measured it as research only, with no product validation. No MicroPython version of
the example was written: switching to MicroPython opens the starter and says no verified version
exists; switching back restores the Arduino example exactly.

## Tests

- `packages/domain/tests/language-switch.test.ts` (8): byte-exact round trip (CRLF, non-ASCII),
  independent edits on both sides, multi-file and pinned libraries without cross-language leakage,
  a part placed while the other language is active, no-op switch, identity migration, validation
  refuses malformed kept code.
- `app/tests/language-switch.test.ts` (6, real persistence on fake IndexedDB, real example data):
  the owner's reproduction with save and reload; every twin pair identical; twins incl. libraries
  both ways; a modified example and an unsaved edit kept; export/import; undo.
- `app/e2e/p1-language-switch.spec.ts` (5): the distance alarm, EN/HE × desktop/tablet, stored
  document and reload checked, no dialog; a multi-file program with a pinned library.
- Updated: schema pins (7), the MicroPython-profile unit test and `s19b-micropython` e2e (no dialog;
  the fade twin; exact return), Sprint 5 import cases (future version 8).
- Real QEMU (staging, Runtime v5): the distance alarm after Arduino → MicroPython → Arduino builds,
  runs and measures the HC-SR04 (0.5 m → "Distance: 50.x cm", 0.1 m → alarm pin high), EN and HE;
  the LED fade's MicroPython twin builds and runs after a switch.

## Limitations

- A DEV-Lab rollback to `d677926` opens projects saved by this build (v7) read-only, by name.
- Restoring kept code may add a library needed by a part placed meanwhile; a library the user had
  unpinned on a part's behalf is pinned again in that case.
- Twins exist for the five pairs above only; other MicroPython examples (e.g. `mpy-button`) have no
  Arduino twin, and other Arduino examples have no MicroPython one.
- Projects created from an example before this build carry no twin; switching opens the starter.
- Code lost by the old behaviour before this fix is not recoverable.
