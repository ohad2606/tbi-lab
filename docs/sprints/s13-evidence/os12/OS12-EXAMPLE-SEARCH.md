# OS-12: example library search and categories (P1 UX)

**Status:** implemented and tested locally (unit + browser). **Not deployed** (needs release authorization). No runtime, firmware, solver, security-policy or infrastructure change.

## What the user gets (Projects screen → "Start from an example")

- A labelled **search field** ("Search examples" / "חיפוש דוגמאות") above the cards. It filters **instantly** as the user types; **Escape** clears the words.
- **Category filters** as toggle buttons (`aria-pressed`, a drawn check mark so the state is not colour alone, keyboard-operable, visible focus ring), in a labelled group.
- A **live result count** ("Showing 6 of 22 examples", `role=status`).
- An **empty state**: "No example matches. Try fewer or other words, or clear the filters."
- **Clear filters**: one click resets the words and categories, and focus returns to the search field.
- **Opening an example is unchanged**: the same card and button, the same `openExample`.

Screenshots: `os12-en-filters.png` (EN, two categories, focus ring), `os12-he-search.png` (HE, RTL), `os12-he-empty.png` (empty state).

## How it works (`app/src/examples/discover.ts`)

- **The source of truth stays the example catalog.**
  - Each catalog entry gained `parts`: its circuit's part types.
  - The documents are a lazily loaded 60 kB chunk, so this small list lives in the start-up catalog. A unit test keeps it **equal to the document** (no drift).
  - No example definition or circuit logic is duplicated.
- **Categories are derived from part types** by an exhaustive rule table (TypeScript forces every catalog part to be classified), **never from titles**.
  - "Basic circuits" means: built only from the supply, passives, LEDs and switches.
  - An example may belong to several categories.
  - Only non-empty categories are shown.

  | Category | Examples |
  |---|---|
  | Basic circuits | 10 |
  | Sensors | 7 |
  | Lighting and displays | 16 |
  | Controllers and programming | 8 |
  | Switching and control | 13 |

  Every example has at least one category.
- **"Communication and IoT" is deliberately not offered.** The simulator has no networking, so the label would imply unsupported functionality. The I2C LCD and the sensors' protocols remain findable by search (`I2C`, `DHT22`, …).
- **Search** matches every query word (AND) against, **in every supported locale (not only the UI language):**
  - the example's title and summary;
  - the localized names of its parts;
  - the part **aliases from the domain catalog** (LDR, PIR, I2C, PCF8574, HC-SR04, DHT22, ESP32, ממסר, צג…);
  - its category names.
- **Matching rules:**
  - Insensitive to case, accents and niqqud, and punctuation (`hcsr04` finds HC-SR04).
  - Hebrew final letter forms match regular forms.
  - One Hebrew prefix letter is allowed (`הממסר` finds `ממסר`).
  - Categories combine with OR (adding one never hides a shown example). Words and categories combine with AND.
- **Deterministic, local, no service:** the index is built once per page from in-bundle data.
- **Cost:** +2.5 kB gzip on the start-up bundle, measured for OS-11 and OS-12 together against the `c3b148b` package.

## Defect found during the work

The visual check showed Hebrew `חיישן` (sensor) returning 6 of the 7 sensor examples. The cause is Hebrew final letter forms: `ן` (final nun) in the query against `נ` in `חיישנים`. Both sides are now normalized, and a unit test pins it (`חיישן` = the Sensors category).

## Tests

- **`app/tests/examples-discover.test.ts` (13):**
  - Catalog `parts` equal each document.
  - Every example has a category; every offered category is non-empty; the exact category list.
  - Categories are derived from parts.
  - OR across categories; the union of all categories = every example.
  - Aliases **LDR, PIR, I2C, HC-SR04/hcsr04, DHT22, ESP32** each find **exactly** the examples whose circuit has that part.
  - Multi-word: `ESP32 LCD`, `LCD ESP32`, `ESP32 PIR`, `relay ESP32`.
  - Hebrew `ממסר`/`הממסר`/`חיישן`; mixed `ESP32 צג`.
  - Category words (EN/HE).
  - Words AND categories; the empty result.
  - **Every example is found by its own title in every locale.**
  - Determinism.
- **`app/e2e/os12-examples.spec.ts` (2):**
  - EN: accessible name, `ESP32 LCD` → 1, `LDR`.
  - **Keyboard:** Tab to the first chip, Space toggles it.
  - Category combination widens.
  - Words + category → empty state.
  - **Clear filters** resets and refocuses.
  - Escape clears.
  - **Opening a filtered example** opens the editor.
  - HE (RTL): Hebrew label and chips, English and Hebrew queries, count; **no horizontal overflow at 1024 and 1400 px**.
- **Full regression:** typecheck, lint, unit **1164/1164**, e2e **199 passed / 0 failed** (22 env-gated skips).

## Impact on Alpha readiness

- A frontend-only slice. It changes no electrical result, runtime, firmware or policy, so it adds **no** new P0/P1 risk to the capacity, security or physics gates.
- It reaches testers only with the next approved frontend release (with OS-11), followed by the owner's retest of the Projects screen.
