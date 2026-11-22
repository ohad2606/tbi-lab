# TBI-019: short component guides (design note)

Status: DESIGN ONLY, 2026-11-22 (branch `co/20261122-comp-guides`, base `co/main` e8425fe). No UI code in this slice.
Everything marked "verified" was read in the code on this branch; the two open PRs are described from their diffs and are not on `co/main`.

## 0. What a component guide is (and is not)

A component guide is a lesson of a few minutes about ONE part. It has a fixed shape:

1. What the part does (two or three sentences).
2. How it behaves, with real numbers taken from the simulator's own models.
3. A minimal working circuit, opened in the Lab with one click.
4. One "try it" step: a single action the learner does, and what they should see.

It is different from an example project. An example (`app/src/examples/catalog.ts`) is a finished circuit with a title and a summary; it answers "what can I build". A guide answers "how does this part behave", teaches in a fixed order, and ends in a concrete action. A guide points to an example for its circuit and never copies it.

Non-goals: no new physics, no new parts, no tutorial engine that edits the circuit for the learner, no videos, no AI-written lessons, no scoring.

## 1. What exists today (verified)

| Need | Real hook on this branch |
|---|---|
| Open a circuit from a curated list | `EXAMPLES` in `app/src/examples/catalog.ts` (`id`, `titleKey`, `summaryKey`, `probes`, `parts`). `AppStore.openExample(id)` in `app/src/state/app.ts` (about line 816) loads the document lazily, creates a fresh independent local project named from the example title, goes to the editor and sets `suggestedProbes`. `withExampleVariant` adds a verified twin in the other firmware language. |
| Find examples | `app/src/examples/discover.ts` (search over titles, summaries, part names and aliases in every locale; categories from part types). Entry: `ExampleFinder` in `app/src/ui/Home.tsx`. |
| First-run guidance | `app/src/ui/GettingStarted.tsx`: a three-step card on the Projects screen; keys `onboarding.*`. |
| Capability honesty | `app/src/ui/Capabilities.tsx`, generated from `packages/domain/src/capabilities.ts`. |
| Technical tokens inside a translated sentence | `app/src/ui/LtrMessage.tsx` with `messageParts` in `app/src/i18n/i18n.js`: `{param}` placeholders are rendered as `<bdi dir="ltr" class="ltr-value">`. |
| Translations | `app/src/i18n/messages.en.ts` (the `MessageKey` type) and `messages.he.ts`; parity enforced by `app/tests/i18n.test.ts`. |
| Tests that already pin real values | `app/tests/examples.test.ts` solves the example documents (`solve(example('led-current'))`) and asserts them. |
| Press a button while running | `AppStore.momentary(componentId, pressed)` (app.ts about line 1031) calls `session.setMomentary`; the press is transient and never saved. 3D view buttons respond to Space and Enter (`ThreeView.tsx` about line 455). |
| Non-modal side panel pattern | `app/src/assist` (TBI-017 note, `docs/design/TBI-017-ai-assistant-ui.md` section 1): heading takes focus on open, Esc closes, focus returns to the trigger, never traps focus. |

Open PRs (NOT in `co/main`; this design must not depend on them):

- PR #45 (TBI-020 s1+s2): `ShortcutsDialog.tsx`, `shortcuts.ts` (a shortcuts registry), `TopBar.tsx` and `App.tsx` changes.
- PR #46 (TBI-020 s3+s4): the Help panel. `GuideDialog.tsx` (a modal `<dialog>`; `openGuide(trigger)`; `GuideHost` mounted once in `App.tsx`), `guideMarkdown.ts` (a safe markdown-subset reader, no HTML), `docs/product/USER-GUIDE.en.md` and `.he.md`, a Help entry in `AppMenu.tsx`.

Note on naming: #46 calls the user guide "guide" in code (`GuideDialog`, `openGuide`). To avoid a clash this design uses the namespace `guides` for component guides (`app/src/guides/`, message keys `compguide.*`, test ids `compguide-*`).

## 2. Format of a guide

### 2.1 Data and text are separate

Structure lives in a typed catalog; every user-visible sentence is a translation key. No HE or EN text in the catalog and no numbers typed into message strings.

```ts
// app/src/guides/catalog.ts  (proposed; shape is the contract, names may change in review)
export interface ComponentGuide {
  id: string;                       // 'led-resistor', 'button', 'potentiometer', 'hc-sr04', 'lcd-i2c'
  part: ComponentTypeId;            // main part, from @tbi-lab/domain CATALOG
  titleKey: MessageKey;             // compguide.<id>.title
  minutes: number;                  // shown as "about N minutes"; tested range 2..5
  exampleId: string;                // MUST exist in EXAMPLES
  runtime: 'none' | 'esp32';        // 'esp32' = needs the ESP32 runtime service (see 4.3)
  sections: GuideSection[];         // fixed order, see 2.2
  facts: Record<string, FactSource>;// named real values, see 2.3
  tryIt: TryIt;                     // exactly one
}
```

### 2.2 Sections (fixed order, each a heading)

| Section id | Heading key | Body |
|---|---|---|
| `what` | `compguide.<id>.what.heading` / `.body` | what the part does; 2 to 3 sentences |
| `behaviour` | `compguide.<id>.behaviour.heading` / `.items.N` | 3 to 5 short statements, each may use `{fact}` placeholders |
| `circuit` | `compguide.<id>.circuit.*` | what the minimal circuit contains (names the parts) and the "Open this circuit" button |
| `tryit` | `compguide.<id>.tryit.heading` / `.action` / `.expect` | one action, one expected observation, both with placeholders |
| `limits` | `compguide.<id>.limits.*` (optional) | what the simulator does not model, taken from the model header comments |

Key pattern: `compguide.<id>.<section>.<field>`. Plain key naming lets a test enumerate the keys a guide requires from the schema.

### 2.3 Values (never invented)

Message text uses `{name}` placeholders. Each placeholder is declared in `facts` and has exactly one source:

```ts
type FactSource =
  | { kind: 'constant'; ref: 'HC_SR04.minRangeM' | 'V_IH_V' | ... }   // an exported engine/domain constant
  | { kind: 'solve'; component: string; field: 'current'|'voltage'|'terminal'; terminal?: string }  // from solving exampleId's document
  | { kind: 'formula'; fn: 'speedOfSound'|'hcsr04Echo'|...; args: ... }; // an exported engine function
```

- `constant` and `formula` import the same exported values the engine uses (for example `HC_SR04`, `speedOfSound`, `hcsr04Echo` from `packages/engine/src/peripherals/hcsr04.ts`; `V_IH_V`, `V_IL_V` from `packages/engine/src/esp32Gpio.ts`; `MODEL_RATINGS` from `ratings.ts`; `PTV09A` from `parts/potentiometer.ts`; `LCD1602_DC` from `parts/lcd.ts`). The engine entry point must export each one; if one is not exported, that is a small engine change that needs the runtime developer, not a copy of the number.
- `solve` runs the engine on the example document at build or test time (as `examples.test.ts` does) and the result is formatted with the existing unit formatter.
- Formatting happens in `LtrMessage`-style rendering: every value is a `<bdi dir="ltr">` isolate (units, `GPIO34`, `0x27`, `HC-SR04`, `kΩ`). Hebrew sentences stay Hebrew; only the token is LTR.
- A guide's displayed numbers are therefore computed, so they cannot drift from the models. (Today's example summaries contain typed numbers, such as "1.982 V, 13.72 mA", guarded only by `examples.test.ts`; guides should do better.)
- If a source cannot be evaluated (the solver fails, the part is outside model range), the guide shows no number and says so; it does not fall back to text.

### 2.4 Try-it

```ts
interface TryIt {
  action:
    | { kind: 'set-param'; component: string; param: string; to: number | string }      // e.g. resistor value, pot position, distance
    | { kind: 'hold-button'; component: string }                                         // momentary press while running
    | { kind: 'run' };                                                                   // just run and read the probe
  expect: { fact: string };                                                              // names a fact computed for the AFTER state
}
```

The learner performs the action in the real editor with the real controls (the guide never edits the project for them). Expected values are computed by evaluating the same sources for the after state (section 5).

## 3. Where in the UI

### 3.1 Placement

A non-modal side panel, the same pattern as the assistant panel: the circuit stays visible while the learner reads. Inline-end side in both directions (logical CSS: right in LTR, left in RTL). On narrow screens a bottom sheet with the same order.

Reason for not reusing the Help panel as is: the Help panel of PR #46 is a modal `<dialog>` that covers the editor; a lesson needs the circuit next to it.

### 3.2 Entry points (each independent; none needs #45 or #46)

1. Projects screen (`Home.tsx`): a "Component guides" card next to the example finder, listing the guides (five at first). Works on `co/main` today.
2. Editor: a "Guide" link in the Inspector for a selected part whose type has a guide (`app/src/ui/Inspector.tsx`; the selection already knows `component.type`). Nothing shown when no guide exists.
3. Palette (`app/src/ui/Palette.tsx`): same link on the part row, optional later.
4. When PR #46 lands: one line in the Help panel and the user guide ("Component guides"), which calls the same `openComponentGuide(id, trigger)`. Until then the single function `openComponentGuide` is the whole public surface, mirroring `openGuide(trigger)`; #46 needs only to call it. When PR #45 lands: one command in the shortcuts registry (`shortcuts.ts`) only if the owner decides the WCAG 2.1.4 question for single-key shortcuts (the same open question as in the TBI-017 note); until then no shortcut.
5. Search: guide titles and the part aliases join `discover.ts` results ("hcsr04" finds the HC-SR04 guide) as a separate result group.

### 3.3 Flow

1. Open guide (focus on its heading; Esc closes; focus returns to the trigger).
2. "Open this circuit" calls `store.openExample(guide.exampleId)`, then the panel stays open next to the editor. Probes come with the example (`suggestedProbes`).
3. The learner reads "How it behaves", does the "Try it" step, and the panel shows the expected result as text (not colour only).
4. Optional "I tried it" button for the learner's own tracking (slice G5, local only).

Consequence to decide (owner question 3): `openExample` always creates a NEW local project (a copy with a unique name). A guide opened five times makes five projects. Proposal: the guide remembers the project id it created in session storage and offers "Go back to my copy" instead of creating another.

## 4. How a guide links to an example, and how "try it" is verified

### 4.1 Link

`exampleId` references `EXAMPLES`. Test: every guide's `exampleId` exists, its `parts` include the guide's `part`, and the document loads through `loadExampleDocument`. A guide never owns circuit data, so a corrected example corrects the guide's numbers at once (they are computed from it).

### 4.2 Verification of the try-it step (test-side, deterministic)

For each guide a unit test in the style of `app/tests/examples.test.ts`:

1. Load the example document, apply `tryIt.action` to a copy (change the param, or call `setMomentary`), solve with the engine.
2. Compute the fact named in `expect` and assert the guide's rendered number equals the solved value at the displayed precision.
3. Assert the "before" and "after" differ in the way the text claims (for example the LED current rises when the resistance falls).

In the UI, completion is never auto-judged in slice 1: the learner reads the expected result and compares it with the live probe. A later slice may detect the action from the app state (e.g. the project's resistor value changed) to tick the step automatically; it must never block the learner and must work by keyboard.

### 4.3 Runtime-dependent guides

HC-SR04 and LCD need a program (a trigger pulse; I2C writes). Their examples (`esp32-distance-alarm`, `esp32-lcd-hello`) run on the ESP32 runtime service through the Session Host (see the example summaries "Runs on the ESP32 runtime service"), with MicroPython twins (`mpy-distance-alarm`, `mpy-lcd-hello`). A guide with `runtime: 'esp32'` shows the same availability text as the example finder. "Open this circuit" stays enabled: the circuit still opens (the design is viewable); the "Try it" step shows a plain-text note when the runtime is unavailable, using the existing capability states. To be confirmed in slice G4 by reading how Home.tsx and Capabilities present runtime availability.

## 5. Accessibility (WCAG 2.2 AA is the target; no compliance is claimed)

- Structure: the panel is a labelled region (`<section aria-labelledby>`); one `h2` (title), `h3` for each section; steps are an ordered list.
- Keyboard (2.1.1, 2.4.3, 2.4.7, 2.1.2): everything reachable with Tab; heading takes focus on open; Esc closes (unless a dialog is open); focus returns to the trigger; no focus trap; visible focus; target size at least 24 by 24 px (2.5.8).
- Screen reader: values are real text, units attached; an `aria-live="polite"` status announces only the result of "I tried it", never on open; the expected result is text next to the step, not an animation.
- No information by colour only (1.4.1): "expected" and "your circuit" are labelled with words.
- Reduced motion (2.3.3 is AAA; we follow it anyway): no animation in the panel at all; any highlight on the canvas uses an outline plus a label and is static under `prefers-reduced-motion: reduce`.
- Reflow and zoom (1.4.10, 1.4.4): the panel becomes a bottom sheet; text scales to 200 percent without horizontal scroll.
- Language (3.1.1, 3.1.2): the panel's `lang` follows the UI locale; technical tokens are `<bdi dir="ltr">` with `lang="en"` where they are English identifiers (the same approach as code spans in PR #46's `Inlines`).
- Images: none in slice 1. If diagrams are added later, each needs alt text and a text equivalent; the circuit itself is the real editor view.
- Known limits stay as in `docs/alpha/TESTER-GUIDE.md`; the guides do not change the A11Y-002, 018 and 028 status. A11y-reviewer reviews each UI slice; automated tests alone never support a compliance claim.

## 6. HE and EN

- Every key exists in both `messages.en.ts` and `messages.he.ts` (parity test already in `i18n.test.ts`; a new test lists required keys per guide from the schema).
- Hebrew is written as natural modern Hebrew by the docs writer, not literally translated; terms follow the shared glossary (`app/src/i18n/glossary.ts` (plus the company glossary kept outside this repo)). Parts keep their English names where the catalog does (`HC-SR04`, `LCD`, `GPIO`).
- Company voice in the lesson text: "we" (אנחנו), second person for the learner's action, short sentences.

Sample (draft wording, for owner review):

- EN `compguide.led-resistor.behaviour.items.1`: "We put a {r} resistor in series, so the LED settles at about {v} and {i}."
- HE: "אנחנו מחברים נגד של {r} בטור, ולכן ה-LED מתייצב על כ-{v} ועל {i}." (the tokens `{r}`, `{v}`, `{i}` render as LTR isolates, for example `220 Ω`, `1.98 V`, `13.7 mA`.)

## 7. Later link to the AI assistant (not in the first slices)

- Basis: the assistant panel (`app/src/assist`, TBI-017) is DEV-Lab only and inactive until the owner decides. The guides must work without it and must never send a guide to a provider.
- Link 1 (cheap): a guide's "Check your circuit" line opens the assistant panel on the learner's own project (the "Explain this circuit" action) after the example is open. The panel's own consent flow applies; nothing is sent on open.
- Link 2 (later): the assistant may cite a guide by id as a recommendation ("see the HC-SR04 guide") from a fixed list of ids; the response validator accepts only known ids (the same rule as known findings in `AssistGateway`). The assistant never writes the lesson and never changes the project (AI origin writes are rejected today).
- Guide text is static product content, so the assistant's "every number must appear in evidence" rule is not weakened.

## 8. Test plan

| Test | Where | What it checks |
|---|---|---|
| Guide schema | `app/tests/guides.test.ts` | ids unique; section order; every referenced key exists in `messages.en.ts` and `messages.he.ts`; no placeholder without a `facts` entry and no unused fact |
| HE/EN parity | same | same placeholder set in both languages for every key; no Latin-only Hebrew text and no Hebrew-only English text; no HE text in the catalog file |
| Link | same | `exampleId` exists in `EXAMPLES`, its `parts` include `part`, document loads |
| Values are real | same | each fact is evaluated from its source; rendered text equals the evaluated value at displayed precision; a grep test fails if a message string contains a digit followed by a unit (`/\d\s?(V|mA|A|Ω|kΩ|cm|µs|ms|m\/s)/`) outside placeholders, so numbers cannot be typed in |
| Try-it | same | action applied, engine solved, before/after as the text claims (section 4.2) |
| Component | `app/tests/guide-panel.test.ts` | renders headings in order; values wrapped in `bdi dir="ltr"` |
| E2E and a11y | `app/e2e/a11y-component-guide.spec.ts` | keyboard-only open, focus on heading, Esc, focus return, no trap, RTL layout, 200 percent zoom; the same style as `a11y-*.spec.ts` |
| Hebrew review | manual | native review of the five Hebrew texts by the owner before use |

## 9. The five first guides (outlines; every number has a source)

Numbers below were read from the files cited; in the shipped guides they come from the sources at build time (section 2.3), not from this note. Anything derived is marked "derived" with its arithmetic; "to verify by solver" marks values the first slice must confirm by a solve before text is written.

### 9.1 LED and resistor (`led-resistor`; example `led-current`)

- Part: `component.led` (default `model.led.vishay_tlhr5400`, `packages/domain/src/catalog.ts` about line 931) with `component.resistor`.
- Does: an LED passes current in one direction only and its voltage barely changes with current, so it needs a series resistor to set the current.
- Behaviour (real values):
  - Datasheet anchor: forward voltage typ. 2 V at 20 mA (`TLHR5400_ANCHOR`, `packages/engine/src/models.ts`); emission coefficient 1.9 (`RED_LED_EMISSION_COEFFICIENT`).
  - Example circuit `app/src/examples/data/led-current.json`: 5 V supply, 220 Ω, red LED. Solved operating point 1.9816 V and 13.72 mA, with the resistor drop plus the LED voltage equal to 5 V (asserted in `app/tests/examples.test.ts`, "LED current limiting").
  - Absolute maximum ratings: 30 mA forward current, 6 V reverse voltage, 100 mW (`MODEL_RATINGS` in `packages/engine/src/ratings.ts`). The product reports an over-stress warning; the solver never changes a number because of a rating.
  - Derived: resistor 220 Ω at 13.72 mA drops about 3.02 V (5 V minus 1.9816 V).
- Try it: change R1 from 220 Ω to 47 Ω (set-param), run, read the LED current; by estimate this is about 60 mA, above the 30 mA rating, so the over-stress warning appears (to verify by solver; the guide text appears only if that is true). Note: at 100 Ω the estimate is about 29.8 mA, just under the rating, so 100 Ω must not be used for this step.
- Limits: a nominal part, no temperature drift (model header, `models.ts`).

### 9.2 Push button (`button`; examples `push-button`, then `esp32-button` as a "go further" link)

- Part: `component.push_button`: normally open, momentary, SPST; its pressed state is a runtime input, not a project value (`packages/domain/src/catalog.ts` about line 980; `session.setMomentary` in `packages/engine/src/session.ts` about line 633).
- Behaviour:
  - Contact is open or closed; no contact resistance or bounce is modelled in the switch element (`session.ts` about line 905 builds it as a plain switch element; to confirm in slice G3 by reading the element solver, including whether a closed switch is ideal).
  - Example `push-button`: 5 V, SW1, 330 Ω, red LED (`app/src/examples/data/push-button.json`); the LED lights only while the button is held; pressing never changes the saved project.
  - ESP32 view (example `esp32-button`): 3.3 V through 1 kΩ to GPIO34 and a 10 kΩ pull-down; released it reads LOW, pressed it reads HIGH because the input is above V_IH = 0.75 x 3.3 V = 2.475 V (`esp32Gpio.ts`). Derived: pressed voltage 3.3 V x 10 kΩ / 11 kΩ = 3.0 V, if the pin draws no current (to verify by solver). GPIO34 has no internal pull (example summary), which is why the pull-down is there.
- Try it: run, hold SW1 (pointer or keyboard in the 3D view, or the Logic view row), see the LED current go from 0 to its solved value, release.
- Limits: transient press; bounce not modelled (to confirm).

### 9.3 Potentiometer (`potentiometer`; example `pot-divider`)

- Part: `component.potentiometer`, Bourns PTV09A linear (`packages/engine/src/parts/potentiometer.ts`): R_AW = R x p, R_WB = R x (1 minus p), p = position / 100.
- Behaviour:
  - Example `pot-divider`: 10 kΩ across 5 V, end A at GND and end B at +5 V, position 50 percent: the wiper reads 5 V x p = 2.5 V (example summary; `app/src/examples/data/pot-divider.json`).
  - Datasheet figures kept in the model: 1 kΩ to 1 MΩ, tolerance plus or minus 20 percent (not sampled; the model is a nominal part), rated 0.05 W, 20 VDC maximum operating voltage (`PTV09A`).
  - Derived: rated track current sqrt(0.05 W / 10 kΩ) = 2.236 mA; the model warns above it (header comment, "track_current").
  - Idealisation named in the model: end resistance is taken as 0 ohm (ASSUMPTION POT-1); position is the electrical share, not the shaft angle.
  - With an end unwired it is a rheostat; example `pot-led-dimmer` (1 kΩ, 470 Ω, red LED, 5 V; 6.5 mA at 100 percent per its summary) is the "go further" link.
  - Microcontroller note (important for honesty): `analogRead` and `machine.ADC` are not supported (example `esp32-pot-threshold` summary); the pot is read as a digital level: LOW at or below 0.825 V, HIGH at or above 2.475 V, and a read in between stops the run.
- Try it: run, drag the position slider from 50 to 80 percent, read the probe at the wiper: 5 V x 0.8 = 4.0 V (derived; to verify by solver).

### 9.4 HC-SR04 ultrasonic sensor (`hc-sr04`; example `esp32-distance-alarm`, twin `mpy-distance-alarm`; `runtime: 'esp32'`)

- Part: `sensor.hc_sr04`, terminals vcc, trig, echo, gnd (`packages/domain/src/catalog.ts` about line 383); behaviour in `packages/engine/src/peripherals/hcsr04.ts` and `packages/engine/src/parts/ultrasonic.ts`.
- Behaviour:
  - A trigger pulse of at least 10 us (`HC_SR04.minTriggerUs`) starts a burst of 8 cycles at 40 kHz, 200 us (`burstUs`); the ECHO line then stays high for 2 d / c.
  - c = 331.3 + 0.606 T m/s (`speedOfSound`): 343.42 m/s at 20 degrees C (derived).
  - Range 2 cm to 4 m (`minRangeM`, `maxRangeM`); outside it, or with a short trigger, the model gives no echo (and says that the real module's behaviour is not specified).
  - Example circuit: target 0.5 m, 20 degrees C (`esp32-distance-alarm.json`): echo width 2 x 0.5 / 343.42 = 2911.9 us (derived). The sketch divides by 58 (datasheet), giving 50.2 cm, a small difference from 50 cm: the guide can say why (58 assumes 340 m/s).
  - Alarm threshold in the sketch: 20 cm (`app/tests/exampleSketches/DistanceAlarm.ino`, `ALARM_CM`); at 20 cm the echo is 1164.8 us (derived).
  - Supply 4.5 V to 5.5 V; below 4.5 V the module is off (`HC_SR04_DC`, `ultrasonic.ts`). The echo line is 5 V logic, so the example divides it with 1 kΩ and 2 kΩ for GPIO18 (example summary).
- Try it: while running, change the target distance in the Properties panel from 0.5 m to 0.15 m; the red LED on GPIO2 lights (example summary, sketch threshold) and the echo width is 2 x 0.15 / 343.42 = 873.6 us (derived). Then set the target to 5 m: no echo (outside 4 m) and the sketch reports nothing in range (the sketch's 30 ms timeout, `DistanceAlarm.ino`).
- Limits: temperature is a parameter; the simulator has no noise or angle model (to confirm in the model header and list from `ultrasonic.ts`).

### 9.5 I2C LCD 1602 (`lcd-i2c`; example `esp32-lcd-hello`, twin `mpy-lcd-hello`; `runtime: 'esp32'`)

- Part: `display.lcd1602_i2c` (HD44780-compatible controller behind a PCF8574 backpack); terminals gnd, vcc, sda, scl; address options 0x20 to 0x27, default 0x27 (`packages/domain/src/catalog.ts` about line 478). Behaviour in `packages/engine/src/parts/lcd.ts`, `peripherals/hd44780.ts`, `peripherals/i2c.ts`.
- Behaviour:
  - Module supply 4.5 V to 5.5 V; below 4.5 V it is unpowered and does not acknowledge on the bus; above 5.5 V a rating warning, logic absolute maximum 7.0 V (`LCD1602_DC`).
  - The PCF8574 reads the bus with V_IH = 0.7 x VDD: at 5 V, 3.5 V is needed, which 3.3 V pull-ups do not reach; from 4.5 V the threshold is 3.15 V (derived), which is why the example powers the module from 4.5 V and uses two 4.7 kΩ pull-ups to a separate 3.3 V supply (example summary, `esp32-lcd-hello.json`).
  - The backpack has no on-board pull-ups in the model, so external pull-ups are required (header comment).
  - I2C on GPIO21 (SDA) and GPIO22 (SCL), 100 kHz (`LcdHello.ino`: `Wire.begin(21, 22, 100000)`); address 0x27; line 1 text, line 2 counts seconds.
  - Not modelled: busy flag and instruction time, reading the controller, the contrast potentiometer, characters outside ASCII and JIS X 0201 katakana (`hd44780.ts` header).
  - Backlight modelled as 20 mA from VCC while on (assumption A-R3-1, `lcd.ts`).
- Try it: change the module's address parameter from 0x27 to 0x26 while the sketch still writes to 0x27: the display stays blank, because nothing acknowledges at 0x27 (to verify in the runtime test before the text is written; if the runtime reports an error instead, the guide describes what it actually reports). Set it back to 0x27 to see the text.

## 10. Size and slice plan

All slices are size S unless noted. Order is also the dependency order. Test-first in each.

| Slice | Content | Size | Notes |
|---|---|---|---|
| G1 | `app/src/guides/` types, catalog with the first guide (LED and resistor), fact evaluators, `guides.test.ts` (schema, parity, link, real values, try-it), en/he keys | S | no UI; can land alone; needs engine to export the constants named in 2.3 (small change by `tbi-runtime-dev`) |
| G2 | `GuidePanel` (non-modal), `openComponentGuide`, Home card, Inspector link; component and e2e a11y tests | S | frontend-dev; a11y-reviewer before push; no dependence on #45/#46 |
| G3 | Button and potentiometer guides + tests | S | texts by tbi-docs, native Hebrew review by the owner |
| G4 | HC-SR04 and LCD guides (runtime-dependent) | S | confirm try-it behaviours against the runtime/e2e first (section 4.3); heavy tests need the pipeline lock |
| G5 | Wiring into Help panel and shortcuts once #45/#46 are merged; "Go back to my copy" project reuse; optional local "tried it" tick | S | only after the owner decides questions 3 and 4 |
| G6 | AI assistant link (section 7) | S | only after the owner activates TBI-017 |

The note's total effort is therefore six S slices instead of the backlog's M.

## 11. Open questions for the owner

1. Panel or dialog: is a non-modal side panel (circuit visible) accepted, or should guides live inside the Help panel of PR #46 as another section? (This note recommends the panel.)
2. Plain text of the first five guides: may tbi-docs write the Hebrew first and the owner review it, or is a Hebrew reviewer needed before any tester sees it? (A guide is customer-facing text; nothing is shown to testers without the owner.)
3. Each "Open this circuit" creates a new local project today. Reuse the learner's copy within a session (proposal) or always make a new one?
4. Should "I tried it" be remembered between sessions (localStorage, per device) or never stored? It would be a new kind of local data and needs a line in the privacy notice if stored.
5. HC-SR04 and LCD need the ESP32 runtime service. Is it acceptable that these two guides show "needs the ESP32 runtime" and degrade to read-only when it is unavailable, or should the first release be only the three guides that need no runtime (LED, button, potentiometer)?
6. Single-key or other shortcut for opening a guide: waits for the WCAG 2.1.4 decision already open in TBI-017 and TBI-020.
7. Where should the list of guides appear for future buyers (landing page)? Marketing copy about guides must wait until they exist on the release branch.
