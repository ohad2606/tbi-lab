# Connections text alternative (A11Y-028, TBI-002)

## Problem
The circuit canvas is not readable by assistive technology: a screen-reader user hears the parts but not how they are connected. V1 does not promise canvas screen-reader support, so a text alternative is the minimum.

## Where
A native `<details>` disclosure, "Connections (text list)" / "חיבורים (רשימת טקסט)", in the side column under the Inspector, visible in every view. Native disclosure: Enter/Space toggle, expanded state announced, no focus trap, nothing moves focus. Content is rendered only while open.

## Content
- **Parts** table (`th scope=col/row`): reference, type, value (all quantity parameters, locale-formatted), unconnected pins.
- **Nets** list under its own heading: ground first ("Ground (GND)" / "אדמה (GND)"), then "Net 1", "Net 2"... in netlist order, a user net name appended verbatim, then the pin endpoints, e.g. `Net 1: PSU1 Positive (+), R1 a`.
- Pin names come from the catalog's terminal labels (the same names as the Inspector); references and values are isolated LTR (`bdi dir="ltr"` / LRI-PDI) inside RTL.

## Single source of truth
`describeConnections()` (`app/src/ui/connectionsText.ts`) is pure and re-derives everything from `connectivity(doc)` in `packages/domain`; nothing is stored, so the list cannot disagree with the circuit or the simulation. It returns translation keys; the panel translates.

## i18n
Keys `connections.*` in `messages.en.ts` and `messages.he.ts` (parity enforced by `app/tests/i18n.test.ts`). The HE ground term is "אדמה" (the glossary forbids protective-earth wording).

## Tests
`app/tests/connections-text.test.ts` (several nets, an unconnected pin, ground merging); `app/e2e/a11y-028-connections.spec.ts` (EN+HE: keyboard open/close, content, no trap).

## Status
- Slice 1 (e92ded8): parts table, nets list, details disclosure, HE/EN.
- Slice 2 (TBI-002, done): (1) every part reference is `bdi dir="ltr"`, pin labels `bdi dir="auto"`, in the table, nets and unconnected-pin cells; (2) table has a visually hidden `<caption>` with the part count, the nets list an `aria-label` with the net count; (3) the body is `role="region"` + `tabindex=0` + label (scrollable, keyboard-scrollable, focus ring); (4) selection sync: each part row has a toggle button (`aria-pressed`, label "Select R1 on the canvas") that selects the component; canvas selection (click or keyboard focus) marks the row (`data-selected`), scrolls it into view (`nearest`, focus is never moved) and underlines that part's pins in the nets list; no trap; (5) supply rails: a net holding a lab supply's positive terminal is named "Net N, supply rail (+)" / "רשת N, פס אספקה (+)"; ground stays "Ground (GND)". The ESP32 3V3/5V/VIN pins are not connectable terminals in the catalog (not wired, so in no net); if they become terminals, extend `supplyRefs`.
- Tests: `app/tests/connections-text.test.ts`, `app/e2e/a11y-028b-connections-sync.spec.ts` (EN+HE).

- Leftovers pass (2026-11-23, `app/e2e/a11y-028c-connections-reflow.spec.ts`, EN+HE): `--selection-bg` is now defined (it was only a fallback); the panel's own `:focus-visible` override (2 px, no halo) was removed so the global two-tone ring applies; the panel and its column no longer grow beyond the 300 px side column (`min-width: 0`, single `minmax(0,1fr)` column), overflow stays inside the focusable scroll region. Known limit: the whole app shell is desktop-first (`.app { min-width: 1024px }`), so the page still scrolls sideways at 320 CSS px; that is app-wide and not fixed here. Axe run on the panel not done.

## Out of scope / remaining
- Keyboard wiring lives in `keyboard-wiring-design.md` (A11Y-002/TBI-001; slices 1 to 4 merged, 5 and 6 open); it is separate from this panel. The canvas label "Schematic canvas" rename.
- A live-region announcement when connections change, wire-level detail, per-part pin-to-net view; selecting several parts from the list (single selection only).
- Manual screen-reader pass (NVDA/JAWS/VoiceOver) of table and list reading, Hebrew mixed-direction reading order, and whether the button label inside the row header reads well.
