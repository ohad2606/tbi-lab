# TBI-014 First five minutes (onboarding): design note

## What exists today
- Projects screen with an inline "Getting started" card (Sprint 13 H4, flag `tbi-lab.onboarding.v1`),
  aimed at the ESP32 build flow (open example, Build, Run). It stays as is.
- ~30 curated examples (`app/src/examples/catalog.ts`), opened with `store.openExample(id)`, which also
  sets suggested probes. Capabilities dialog (`<dialog>` + `showModal`), application menu (editor top bar).
- No axe helper in the repo; no shortcuts dialog (TBI-020 is separate).

## What a brand-new user sees
Opening the app on a device with no flag and no saved projects shows a modal welcome over the Projects
screen: title, one-line intro, three steps, and three buttons.
1. Open the example: LED with a current-limiting resistor on the lab supply (`led-current`, no ESP32, no build wait).
2. Press Run: the local simulator solves the circuit.
3. Read the probe on the canvas (e.g. `I(D1)`) and any warning in the message bar. Numbers come from the simulator.

"Start with the example" calls `store.openExample('led-current')`, closes the dialog, announces
"Example opened. Press Run to start the simulation." (polite `role=status`) and moves focus to the Run button,
so the whole path is Enter, Enter. The next step after the example is Run itself (step 2), then the probe
(step 3); the Projects screen card remains the pointer to the ESP32 flow.

## Dismiss and memory (localStorage only, no server, no tracking)
- Key `tbi-lab.firstRun.v1` = `seen` (per device, namespaced like other prefs).
- "Start with the example" and "Don't show again" set it. "Skip" and Esc hide the dialog for this page
  session only (nothing stored), so a reload gives a brand-new user another chance, never a nag within a session.
- Not shown automatically when the device already has projects (existing testers) or outside the Projects screen.
- Reopen: application menu entry "Welcome and first steps" (editor top bar). The Projects screen has no
  menu, so there it is reachable only after opening a project (see slices).

## Accessibility
Native `<dialog>` + `showModal()`: modal, focus trapped by the browser, Esc closes (`cancel` handled),
labelled by its title and described by the intro, initial focus on the primary button, focus returns to the
opener when reopened from the menu. Steps are an ordered list. Buttons are real buttons (>= 24px). No
timers, no motion. Status announcement uses a persistent live region (a region inserted with its text is
often not announced). Focus after Start goes to Run (documented, intentional).

## i18n / RTL
Keys `firstRun.*` and `menu.firstRun` in both bundles (parity test). Dialog carries `dir` from the locale;
the technical token `I(D1)` is wrapped with the LTR isolate (`isolateLtr`) inside the sentence.

## Out of scope
Guided tour overlays/spotlights, step-by-step coach marks inside the editor, the guides (TBI-019), the AI
panel, the shortcuts dialog (TBI-020), analytics, server-side state, per-example "next example" paths,
ESP32 Build onboarding (the existing card covers it), and any change to simulation.

## Remaining slices
1. Help entry on the Projects screen (reuse the existing "Show getting started" link to reopen both).
2. Next-step card in the editor after the first Run (change a value, add a probe), once Run is observed.
3. Screen-reader pass (NVDA/VoiceOver/TalkBack) and a real axe check if the helper is added.

## Coexistence with the "Fastest start" block (PR #18, merged together)
- One example, one constant: both the welcome dialog and the Projects-screen "Fastest start" block open `led-current` (`FIRST_RUN_EXAMPLE` in `firstRun.ts`).
- Roles: the dialog is the automatic, modal first-run (new device, no projects, once); the inline Getting-started card stays the dismissible, reopenable pointer (quick LED button plus the ESP32 build steps).
- Decision for the owner if wanted: hide the card's quick block while the dialog is open or after "seen" (not done; they never compete, since the dialog is modal and shown only on a device with no projects).
