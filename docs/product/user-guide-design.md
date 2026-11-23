# User guide and keyboard shortcuts: design note (TBI-020, slice 1)

Status: design only, no code. Base: branch `co/20261119-kbwire-design-s2` (keyboard wiring slices 1 and 2, so `W`, `[`, `]` exist).
Every row in section 1 was read from the handler code on this branch; nothing is taken from documentation.
"Test" names the closest existing test found by searching `app/e2e` and `app/tests`; where the search found none, the cell says NO TEST.
A listed test is a pointer to check, not proof the exact key is asserted: slice 2 must re-verify each pointer (see 2.4).

## 1. Shortcuts inventory (from the real handlers)

Notation: file paths are under `app/src/ui/`. `Mod` = Ctrl or Cmd. "Part focused" = keyboard focus is on a part in the circuit view (`[data-hit="component"]`).

### 1.1 Global (document level)

| Key | Context | Action | File:line | Test |
|---|---|---|---|---|
| Mod+Z | Anywhere except text fields (`input`, `textarea`, `select`, contenteditable) | Undo project change | App.tsx:48-55 (matches `e.code === 'KeyZ'`) | e2e/sprint4.spec.ts:321; e2e/a11y-kbwire.spec.ts:245 |
| Mod+Shift+Z, Mod+Y | Same | Redo | App.tsx:49 | Mod+Y: e2e/sprint4.spec.ts; Mod+Shift+Z: NO TEST found |
| Esc | Anywhere (document listener, only while a part is armed for placing) and focus not in field/code editor/menu/dialog | Cancel placement | Editor.tsx:63-77 | e2e/editor.spec.ts:163 (verify it is the placement case) |
| Esc | Assistant panel open, no `dialog[open]` | Close panel (it is non-modal) | assist/AssistPanel.tsx:289-296 | e2e/s27-assist.spec.ts:171 |

### 1.2 Circuit view (Canvas)

| Key | Context | Action | File:line | Test |
|---|---|---|---|---|
| W | Part focused, not read-only, no modifier | Enter pin mode (while running: announces "not available") | Canvas.tsx:851-863 | e2e/a11y-kbwire.spec.ts:88 |
| Arrow Down/Right, Tab | Pin mode | Next pin (Tab leaves pin mode and moves focus natively) | Canvas.tsx:877-896 | e2e/a11y-kbwire.spec.ts |
| Arrow Up/Left, Shift+Tab | Pin mode | Previous pin | Canvas.tsx:878-896 | e2e/a11y-kbwire.spec.ts |
| Enter | Pin mode | Start a wire from this pin | Canvas.tsx:887-889 | e2e/a11y-kbwire.spec.ts |
| Arrow keys, Tab (+Shift) | Wiring (choosing target) | Cycle candidate targets; Tab is trapped on purpose | Canvas.tsx:899-906 | e2e/a11y-kbwire.spec.ts |
| Enter | Wiring | Connect to the chosen target | Canvas.tsx:903-905 | e2e/a11y-kbwire.spec.ts |
| Esc | Pin mode or wiring | Cancel, focus returns to the part | Canvas.tsx:866-874 | e2e/a11y-kbwire.spec.ts:82 |
| E | Circuit view, one wire selected, not read-only, no modifier (matches `e.code === 'KeyE'`) | Re-pick one end of the wire: announces the ends (while running: "not available"; no wire: says to select one) | Canvas.tsx onKbKey | e2e/a11y-kbwire-repick.spec.ts |
| 1, 2, Tab, Enter | Re-pick, choosing the end | 1 / 2 choose the first / second end; Tab switches the highlighted end, Enter chooses it | Canvas.tsx onRepickKey | e2e/a11y-kbwire-repick.spec.ts |
| Tab, Arrow keys, Enter, Esc | Re-pick, choosing the new pin | Cycle candidates (Tab trapped on purpose), Enter reconnects (one undo step), Esc cancels | Canvas.tsx onRepickKey | e2e/a11y-kbwire-repick.spec.ts |
| ] / [ | Circuit view, not in pin mode or wiring, no Ctrl/Alt/Meta/Shift (AltGr allowed) | Select next / previous wire (wraps, announces) | Canvas.tsx:982-986; wireKeyboard.ts:274 | tests/wire-keyboard-candidates.test.ts:283; e2e/a11y-kbwire.spec.ts:208 |
| Esc | Circuit view, in this order: probe mode on, else part armed, else a drawing mode, else clear selection | Cancel the first that applies | Canvas.tsx:972-981 | e2e/a11y-kbwire.spec.ts:100,235 (selection case); other branches NO TEST found |
| Delete, Backspace | Selection, not read-only | Delete selected parts/wires/junctions (announces wire removal or refusal) | Canvas.tsx:1018-1034 | Delete: e2e/keyboard.spec.ts:50, a11y-kbwire.spec.ts; Backspace: NO TEST found |
| Delete, Backspace | Selection, read-only | Does nothing; a selected wire announces "cannot delete" | Canvas.tsx:1013-1016 | NO TEST found |
| R | Parts selected, not read-only, no Ctrl/Meta | Rotate selected parts | Canvas.tsx:1035 | e2e/keyboard.spec.ts:40 |
| Arrow keys | Selection and not read-only | Move selection one grid step (Shift: 5 steps) | Canvas.tsx:992-1010 | e2e/keyboard.spec.ts:30 (plain arrows); Shift+arrow NO TEST |
| Arrow keys | No selection (or read-only) | Pan the view (Shift: faster) | Canvas.tsx:1004-1009 | NO TEST found |
| + or = | Circuit view | Zoom in | Canvas.tsx:988 | NO TEST found |
| - | Circuit view | Zoom out | Canvas.tsx:989 | NO TEST found |
| F | Circuit view (matches `e.code === 'KeyF'`, any modifier) | Fit the circuit to the view | Canvas.tsx:990 | NO TEST found |
| Space | A focused toggle switch, running | Toggle the switch | Canvas.tsx:953-962 | e2e/three-controls.spec.ts:97 is the 3D twin; Circuit view NO TEST found |
| Space (hold) | A focused push button, running | Press while held, release on key up | Canvas.tsx:963-969, 1038-1049 | 3D twin: three-controls.spec.ts:165; Circuit view NO TEST found |
| Space (hold) + drag | Elsewhere in the circuit view | Pan with the pointer | Canvas.tsx:969, 489 | NO TEST found |
| Tab / Shift+Tab | Circuit view | Browser focus order between parts; focus selects the part (not a key handler) | Canvas.tsx (focus handling) | e2e/keyboard.spec.ts:44-48 |

### 1.3 Schematic view

| Key | Context | Action | File:line | Test |
|---|---|---|---|---|
| Enter, Space | Focused symbol or module | Select it (`aria-pressed`) | SchematicView.tsx:241-246, 340-345 | NO TEST found |

### 1.4 3D view

| Key | Context | Action | File:line | Test |
|---|---|---|---|---|
| Arrow Left / Right | 3D view focused | Rotate by 22.5 degrees; not mirrored in RTL | ThreeView.tsx:420-431 | e2e/three-layers.spec.ts:151 is another control; rotate by key NO TEST found |
| Shift+Arrows | 3D view focused | Pan | ThreeView.tsx:418-424 | e2e/s9-semantics.spec.ts:227-229 |
| + or = / - | 3D view focused | Zoom in / out | ThreeView.tsx:428-430 | e2e/three-layers.spec.ts:144 (+); - NO TEST found |
| Home | 3D view focused | Reset camera | ThreeView.tsx:431 | e2e/s9-semantics.spec.ts:230 |
| Space or Enter | 3D view or its hidden control, selected switch/button, running | Toggle a switch; hold a push button | ThreeView.tsx:405-413, 454-463 | e2e/three-controls.spec.ts:97,165 |
| Esc | Layers panel open | Close it, focus back to its button | ThreeView.tsx:623-629 | NO TEST found |

### 1.5 Menus, tabs, fields, dialogs

| Key | Context | Action | File:line | Test |
|---|---|---|---|---|
| Arrow Left / Right | View tabs (Circuit, Schematic, 3D) | Previous/next tab, mirrored under RTL, wraps | Editor.tsx:122-137 | e2e/s9-views.spec.ts:45-51 |
| Arrow Down (button), Enter | App menu button | Open menu, focus first item | AppMenu.tsx:121 | e2e/header.spec.ts:309 |
| Arrow Up/Down, Home, End | App menu open | Move between items (wraps) | AppMenu.tsx:92-95 | e2e/header.spec.ts:309-313, 511 |
| Esc, Tab | App menu open | Esc closes and returns focus; Tab closes | AppMenu.tsx:87-91 | e2e/header.spec.ts:315 |
| Esc | Version status popover | Close | VersionStatus.tsx:63 | NO TEST found |
| Enter / Esc | Project name field | Commit / revert | TopBar.tsx:205-209 | e2e/commit-race.spec.ts:100; e2e/header.spec.ts:271 |
| Enter / Esc | Value field of a part (ValueControl) | Commit / revert | ValueControl.tsx:186-193 | e2e/pot-units.spec.ts (verify Esc) |
| Esc | Rename field in the project list | Cancel rename | Home.tsx:307 | NO TEST found |
| Esc | Example search field, text present | Clear the search | Home.tsx:417-421 | NO TEST found |
| Esc | Native `<dialog>` (Capabilities, Problem report, Home dialog, admin) | Closes the dialog (browser behaviour of `showModal()`) | Capabilities.tsx:92, ProblemReport.tsx:111, Home.tsx:338 | e2e/s13-capabilities.spec.ts:56; e2e/s14-report-problem.spec.ts:68 (focus kept inside, Esc returns focus) |

### 1.6 Code editor (CodeView, a plain textarea, no editor library)

| Key | Context | Action | File:line | Test |
|---|---|---|---|---|
| Tab | Editor, Tab mode "indent" (default), not read-only | Insert two spaces | CodeView.tsx:408-413 | e2e/a11y-003-editor-tab.spec.ts |
| Esc, then Tab | Editor | Leave the editor (no keyboard trap) | CodeView.tsx:399-402, 408 | e2e/a11y-003-editor-tab.spec.ts:85 |
| Shift+Tab | Editor | Always leaves the editor | CodeView.tsx:408 | e2e/a11y-003-editor-tab.spec.ts |
| Ctrl+M | Editor (Ctrl only; Cmd is not matched) | Switch Tab between indent and move focus; choice stored per browser | CodeView.tsx:403-407 | e2e/a11y-003-editor-tab.spec.ts:94 |

Note: Run, Stop, Build have no keyboard shortcut (buttons only). There is no Ctrl+S or Ctrl+Enter.

### 1.7 Findings

1. **Almost nothing is documented in the app.** The only `aria-keyshortcuts` are on Undo, Redo (TopBar.tsx:273, 288) and the 3D view (ThreeView.tsx:399). The 3D list there omits Space/Enter and `=`. None of 1.2, 1.4 (partly), 1.6 is announced anywhere. Everything in 1.2 and 1.4 is therefore undocumented to users.
2. **Esc is overloaded** (placement, probe mode, drawing mode, selection, pin mode, wiring, panels, dialogs). Priority order inside the circuit view is fixed (Canvas.tsx:972-981); document-level Esc handlers in Editor.tsx and AssistPanel.tsx must not fire when a dialog or field owns the key (they check). The guide must say "Esc steps back one level".
3. **`F`, `R`, `W`, Mod+Z/Y use `e.code`** (physical key), `[`, `]`, `+`, `-`, `?` would use the typed character. On a Hebrew layout the physical F key types a Hebrew letter but still fits the view. The guide and dialog must say "the key in the F position" for Hebrew layouts. `F` ignores modifiers (Ctrl+F in the circuit view also fits; browser find is shadowed only if the canvas has focus and the page does not prevent default, so Ctrl+F still opens browser find but the view also fits: low severity, confirm in slice 2).
4. **Conflict candidates:** (a) arrows mean "move part" with a selection and "pan" without one: the same key, two meanings by state; (b) Backspace deletes parts (no confirm, undo exists); (c) `?` must be ignored inside text fields and the code editor, where it is a character; (d) Ctrl+M is Tab-mode in the editor (no known browser conflict in Chromium); (e) Space in the circuit view is prevented by default everywhere on the canvas.
5. **Untested:** all of zoom/fit/pan/Space-pan, Backspace, Shift+arrow, schematic selection, 3D rotate and Layers Esc, read-only Delete. Slice 2 must add tests for each.
6. No handler for `?` exists yet; it is new work.
7. The inventory covers `app/src/ui`, `app/src/assist`. Admin (`admin-app`) is out of scope for user shortcuts.

## 2. Design: Help panel and shortcuts dialog

### 2.1 Entry points
- Key `?` (the typed character, so it also works with Shift+/ on US layouts and with the Hebrew layout's own `?` position) opens the shortcuts dialog. Ignored when focus is in `input`, `textarea`, `select`, contenteditable, or when another modal is open.
- App menu gets two items: "Help and guide" and "Keyboard shortcuts" (keyboard accessible without any shortcut, which is the primary path; `?` is only a convenience).
- Help panel: a non-modal panel following the Assist panel pattern (AssistPanel.tsx): heading receives focus on open, focus returns to the trigger on close, Esc closes unless a dialog is open.

### 2.2 Shortcuts dialog (accessible semantics)
- Native `<dialog>` + `showModal()` (same as Capabilities/ProblemReport), `aria-labelledby` to its heading, `aria-describedby` to a one-line intro.
- Focus: moves to the dialog heading (`tabindex=-1`) or the close button on open; focus is trapped by the native modal; Tab stays inside (this is already tested for ProblemReport at s14-report-problem.spec.ts:68, reuse the pattern). Esc closes, focus returns to the element that had it (or the app menu button if opened by `?`).
- Content: one table per context (Global, Circuit view, Wiring by keyboard, Schematic, 3D view, Code editor), real `<table>` with `<caption>`, `<th scope>`. Keys in `<kbd>` with `dir="ltr"`; the action text is translated and follows document direction. No information by colour; no hover-only content.
- RTL: dialog and tables follow `dir`; key names stay LTR (`bdi`/`dir="ltr"`); arrows are spatial and not mirrored, except where the code mirrors them (view tabs); the table says "mirrored in RTL" for those rows, matching the code.
- Platform: show `Ctrl` and `Cmd` as the code accepts both.
- Reflow at 320 px and 200% zoom; close button reachable; no timers.

### 2.3 One data source
New module `app/src/ui/shortcuts.ts` exports `SHORTCUTS: ShortcutDef[]`:
`{ id, scope, keys: string[] (e.g. "Mod+Z"), ariaKeys?: string, actionKey, whenKey?, handler: 'Canvas.onKeyDown#delete' }`.
- The dialog, the Help panel table, `aria-keyshortcuts` values (Undo, Redo, 3D host) and the public guide table are all generated from it. Texts live in `messages.en.ts` / `messages.he.ts` (`shortcut.<id>.action`), never `if (lang === 'he')`.
- Same data exported to JSON at build time for the public page (so site and app cannot drift).

### 2.4 Test that fails when a handler key is missing
Handlers are hand-written `e.key ===` branches, so the test closes the loop in two directions:
1. **Source scan (vitest):** read `app/src/ui/**/*.tsx` and `app/src/assist/*.tsx`, extract every `e.key ===`, `e.code ===`, `key:` lookups (`{ArrowRight: ...}[e.key]`) with their file; fail if a key literal appears in a handler file that has no entry in `SHORTCUTS` for that file, and keep an explicit allow-list (with reason) for non-shortcut uses (e.g. Enter/Esc in text fields, which are listed as "field editing" entries). The test fails on new keys until someone documents them.
2. **Behaviour (Playwright, one spec):** for each `SHORTCUTS` entry marked `testable`, a table-driven step presses the key in its context and asserts the effect, so "documented but dead" also fails. Entries not yet covered are listed in a `NO_TEST` allow-list that may only shrink (test asserts the list length against a recorded number).
3. Parity test: every `actionKey` exists in both message files; HE and EN dialogs show the same row count.
4. a11y spec `a11y-shortcuts.spec.ts` (EN and HE): `?` opens, focus inside, Tab trapped, Esc closes and restores focus, not triggered inside the code editor or a text field, axe has no violations, RTL screenshot.

### 2.5 Help panel contents
Short "first 10 minutes" steps, then links to the full guide sections and the shortcuts dialog. Text comes from the guide source (section 3) so the app and the web say the same thing.

## 3. Guide outline (HE + EN, simple language)

Facts allowed: only what `marketing/CLAIMS.md` marks OK plus behaviour read from code at HEAD. No Safari/Firefox/phone, no AI, no prices, no accessibility-compliance claim, capacitor not mentioned, no "real lab" or "100%". State: "Works on a computer, in Chrome or Edge." Plain words, one idea per sentence, steps numbered, key names and pin names (GPIO) in English LTR inside Hebrew text.

1. What TBI Lab is, in four sentences (browser lab for ESP32, simulated, DC only, says what it cannot simulate). Browser and computer requirement.
2. Getting around: the three views (Circuit, Schematic, 3D), switching with tabs and arrows, what each is for; the menu; saving and undo; rename.
3. Adding and wiring parts: palette, placing, moving, rotating, deleting; wiring with the mouse; wiring with the keyboard (`W`, Enter, `[` `]`, Esc); read-only examples.
4. Code: Arduino (C++) and MicroPython, files, the Tab key and `Esc` then `Tab` (and Ctrl+M), build messages, what the MicroPython support covers (link to TBI-005 panel when it exists).
5. Run: start, stop, buttons and switches while running, what "starting" means (a real ESP32 firmware in QEMU on our server, limited places in Alpha), serial output.
6. Probes and warnings: voltage and current probes; the "may be damaged" warnings; explanations of wrong wiring; "cannot simulate" messages; what to do next.
7. Examples: where they are, searching, twins in Arduino and MicroPython, opening read-only vs copying.
8. Keyboard shortcuts (generated table, section 2.3).
9. Known limits and how to report a problem (links to the in-app report; privacy contact support@tbi-tech.net as in the FAQ).

Each section: what you will do, steps, "if something goes wrong". Screenshots from the demo capture with real alt text; no screenshot carries information that is not also in text. Glossary kept in `marketing/glossary-he-en.md`. Drafted by tbi-docs; HE reviewed by the owner before use (see TBI-007).

## 4. Public pages /he/guide and /en/guide

- Source: one guide source (markdown with front matter, HE and EN files) rendered by the same site build that publish-landing already tests (`npx vitest run site`). The landing site source is NOT on this branch (no `site/` directory at this base); the page work must be done on the branch that holds the landing copy fix and reuse its templates.
- Page rules: `lang`/`dir`, skip link, one `h1`, heading levels in order, shortcuts as a real table, link text meaningful, alt text, works without JavaScript, reflow at 320 px, no information by colour only. A static page needs no tracking.
- Claims gate: a site test greps the guide for forbidden claims (list from CLAIMS.md "Do NOT say") and fails the build.
- Flow: tbi-docs writes, tbi-qa verifies copy against product, a11y-reviewer checks, push `co/*`, then publish-landing (owner-approved, YELLOW), report published commit and `--rollback`. The page must be re-checked when TBI-001 slices 3 to 6 ship (wires list, reconnect, junctions, help/polish) and when the Escape order changes.
- Add the pages to the landing nav only with owner approval of the nav copy.

## 5. Slices and estimates

| # | Slice | Owner | Estimate | Done when |
|---|---|---|---|---|
| 1 | This note and inventory | tbi-docs | done | owner reviews |
| 2 | `shortcuts.ts` data source + source-scan test + missing handler tests (zoom, fit, pan, Backspace, schematic Enter/Space, 3D rotate, Layers Esc, read-only delete) + generate `aria-keyshortcuts` | tbi-frontend-dev | 1.5 days | vitest red when a key is added without an entry |
| 3 | Shortcuts dialog + `?` + menu item, HE/EN keys, RTL, a11y spec | tbi-frontend-dev, a11y-reviewer | 1.5 days | a11y-shortcuts spec green in both languages |
| 4 | Guide text HE + EN (sections 1-9), glossary update | tbi-docs | 2 days (+ owner HE review) | tbi-qa copy check |
| 5 | In-app Help panel from the guide text | tbi-frontend-dev | 1 day | Esc/focus-return test, axe |
| 6 | Screenshots via demo capture with alt text | tbi-docs | 0.5 day | each image has alt and a text twin |
| 7 | Public /he/guide /en/guide + claims test + publish-landing | tbi-docs + tbi-frontend-dev | 1 day | live check, rollback recorded |
| 8 | Update after TBI-001 slices 3-6 | tbi-docs | 0.5 day each time | inventory test still green |

## 6. Open questions for the owner
1. `?` should it also open in the Hebrew keyboard layout via the typed `?` only (proposed), or also with Shift+/ by physical key?
2. Should plain `+`, `-`, `F` in the circuit view stay as they are (they work with Ctrl held too), or require no modifiers? Ctrl+`+` is browser zoom: today the app also zooms the canvas (finding 3). Changing it is a behaviour change, so it needs a directive.
3. Should Run/Stop get shortcuts? None exist, and none will be invented without a directive.
4. Is Backspace deleting parts (no confirmation, undo available) the wanted behaviour for beginners?
5. Public guide: publish before public launch (while Alpha is invite-only) or together with it? The a11y limitations A11Y-002 (partly closed by TBI-001), 018, 028 must be described honestly in the guide's limits section either way.
6. Which branch holds the landing site source for the public pages (not on this base)?
7. Do we want the shortcut table also as a printable one-page PDF? Not planned; would need an accessible PDF process.
