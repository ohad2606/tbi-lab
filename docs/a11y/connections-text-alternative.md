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

## Out of scope / remaining slices
- Keyboard wiring (A11Y-002, TBI-001); the canvas label "Schematic canvas" rename (A11Y-028 wording).
- Selection sync (focusing a part in the list selects it), a live-region announcement when connections change, wire-level detail, supply-rail marking, per-part pin-to-net view.
- Manual screen-reader pass (NVDA/JAWS/VoiceOver) of table and list reading, and Hebrew mixed-direction reading order.
