# Keyboard wiring: design note (TBI-001 / A11Y-002)

Status: design only, no UI implemented. Criteria: WCAG 2.1.1 Keyboard, 2.5.7 Dragging Movements (single-pointer alternative; the keyboard path also covers it), 4.1.3 Status Messages.

## 1. Current state (read from code)

- `app/src/ui/Canvas.tsx`: the `<svg class="canvas">` has `tabIndex=0` and one `onKeyDown`. Components are `<g role="button" tabIndex=0>` (focusable, labelled). Space toggles a focused switch or pans; arrows move the selection (grid step, Shift = 5x) or pan if nothing is selected; `+ - F` zoom/fit; `R` rotates; `Delete`/`Backspace` deletes the selection (`deleteSelection`); `Escape` cancels probe/placing/mode, else clears the selection.
- Terminals (`<g data-hit="terminal" data-component data-terminal>`, around line 1105) are NOT focusable and have no label. Wires have no `tabIndex`/role either. So a wire can only be created by pointer: `onPointerDown` on a terminal sets `mode = {kind:'wiring', from, fromPos, vertices, cursor}`; clicks on empty canvas add waypoints; `finishWire` resolves the hit (terminal / junction / wire) to a `WireTarget` and calls `addWire(doc, from, to, autoRouteVertices(...), {waypoints})` from `packages/domain/src/edit.ts`. The wire is automatic (`Wire.auto`), routed canonically by `ui/routing.ts`.
- Wiring is refused while the simulation runs (`simActive`); a terminal press then just selects the part. Keep that rule.
- Selecting/deleting wires: only by pointer-click on a wire, then Delete works (selection model is shared). No keyboard way to select a wire or terminal.
- Live regions already exist (`role="status"` for route-conflict/limit notes in Canvas; `aria-live="polite"` in Inspector/McuTerminal). There is no general announcer.
- Gaps against the criteria: create (none), select wire (none), re-route (pointer only: drag segment `moveWireSegment`, move endpoints), delete (works once selected, but selection is pointer-only).

## 2. Proposed interaction model

Principle: keyboard operations call the same domain edits as the pointer (`addWire`, `deleteSelection`, reconnect edit). No new electrical logic, so nets cannot differ between input methods (prime rule: routing is presentation).

Focus model (roving, so Tab count stays small):
- Tab reaches the canvas, then components (existing). On a focused component, `Enter` ... is already used by switches via Space; use a dedicated key: **`W`** on a focused component enters "pin mode" (focus moves to its first terminal). Alternative: Tab order inside a component. Decision: roving tabindex inside the focused component's pins using `ArrowLeft/Right` (or Up/Down) in pin mode; `Tab` leaves pin mode as usual. Each pin gets `role="button"`, `aria-label` e.g. "R1 pin A, not connected" / "U1 GPIO4, connected to 2 wires, net N3".
- On a focused pin: `Enter` (or `W`) starts a wire (mode `wiring`, announced). Now `Tab`/`Shift+Tab` or `ArrowDown/Up` cycle the ordered candidate target pins (see 2.1); the canvas highlights the candidate and pans it into view. `Enter` completes -> `addWire`. `Esc` cancels (existing Escape branch for `mode.kind !== 'idle'`). `Space` is not used (conflicts with pan/switch).
- Optional waypoint: not needed; the router creates the route. Waypoints stay a pointer feature.
- Select a wire: with a pin focused, `Shift+Enter`... rejected (conflict). Instead a "Wires" list (a `<ul>` in a panel next to the Inspector, one `button` per wire "W3: R1.A to LED1.anode, net N2") plus `]` / `[` on the canvas to cycle wires in document order. Selecting sets the normal selection (`store.select`), so Inspector, highlight and `Delete` work unchanged.
- Delete: existing `Delete`/`Backspace` on selection; after deletion focus returns to the canvas (already done) and the announcer says "Wire W3 deleted".
- Re-route: "re-pick endpoint". With a wire selected, `E` then `1`/`2` (or `Tab` between ends) picks the end, then the same candidate cycle as creation, `Enter` commits via a reconnect edit (delete+add in one `transact` so undo is one step; verify an existing edit covers it, otherwise a small new domain edit). Route shape adjustment (segment drag) is out of scope: the auto router already re-routes from the new endpoints.
- Read-only / simulation running: pin mode announces "Wiring is unavailable while the simulation runs" and does nothing (same as pointer).

### 2.1 Pure logic: candidate targets for a source pin
`candidateTargets(doc, from: PinRef, opts) -> PinRef[]`, deterministic order:
1. Exclude `from` itself and pins already joined to `from` by an existing wire (same node; `addWire` returns `same_endpoint`/duplicate otherwise).
2. Sort by distance from `from` on the canvas (`terminalPosition`), ties by component id then terminal id. Nearest first makes the common case 1-2 key presses.
3. Do not drop pins that would produce an ERC warning (short, two outputs); the user may do it deliberately. Instead return a `hint` per candidate (e.g. "joins ground to 5V") surfaced in the announcement, computed from `connectivity.ts` nodes' `kind`. No hidden filtering, no invented verdicts.
Lives in `app/src/ui/wireKeyboard.ts` (pure, no DOM), reuses `terminalPosition` (layout.ts), `connectivity()` (connectivity.ts), `CATALOG`.

## 3. Screen-reader announcements
One visually hidden `role="status" aria-live="polite"` region owned by the Editor (`Announcer`), fed by a small store. Keys in both `messages.en.ts` and `messages.he.ts`, with parameters (no string concatenation, Hebrew word order differs):
`kbwire.start` ("Wire started from {pin}. Tab to choose a target, Enter to connect, Escape to cancel"), `kbwire.candidate` ("{pin}, {n} of {total}, {distance} away{hint}"), `kbwire.done` ("Connected {a} to {b}"), `kbwire.cancel`, `kbwire.refused` ("Cannot connect: {reason}", reason from the domain edit error code, localized), `kbwire.deleted`, `kbwire.running`, `kbwire.noTargets`. Canvas stays `dir="ltr"`; announcements follow the page language.

## 4. Conflicts with existing shortcuts
Taken: Space (pan/switch), arrows (move/pan), `+ - = F R`, `Delete/Backspace`, `Escape`. Pin mode is modal: while active, arrows/Tab belong to pin navigation, `Escape` exits first (already the order in `onKeyDown`). New keys: `W` (start from component), `[`/`]` (cycle wires), `E` (edit end). All must be checked against the shortcut list/help and `a11y-*` e2e specs, and must not fire when typing in inputs (Canvas handler is on the svg only, so OK). Native Tab/Shift+Tab must not be trapped: Esc or Tab out always exits.

## 5. ERC / failures: no fake results
- Success is announced only after `addWire` returns `ok`; on `!ok` announce the real error code message and leave state unchanged (mode stays so the user can pick another target).
- ERC/connectivity warnings come from the existing checks (`ui/checks.ts`) after the edit, shown in the existing problems UI; the announcer reads the first new one only if the checks produced it. Never announce "valid" or "no problems".
- Net identity in labels comes from `connectivity()`; if unavailable omit the net rather than guess.

## 6. Test plan
- vitest (`app/tests/wire-keyboard-candidates.test.ts`): ordering, exclusions, ties, hints, determinism; same netlist whether a wire is made by `addWire` directly or via the keyboard reducer (compare `connectivity()`); i18n parity of `kbwire.*` keys.
- Component-level (vitest + testing-library if present, else e2e): mode transitions start/cycle/commit/cancel; refused while running.
- Playwright (`app/e2e/a11y-kbwire.spec.ts`): create a wire between two pins with keyboard only, assert wire count and the live-region text, Esc cancels with no wire, select via `]` + Delete, re-route end, undo is one step, Hebrew UI announcement. Respect heavy.lock; run only when free.
- Golden/routing fixtures must be unchanged (no route code is touched).

## 7. Slices and estimates
1. Smallest vertical slice (about 1.5 days): `candidateTargets` pure fn + tests; focusable pins (roving tabindex, labels) on a focused component with `W`; Enter starts, Tab/Shift+Tab cycles, Enter commits via `addWire`, Esc cancels; announcer with `start/candidate/done/cancel/refused` EN+HE; Playwright create-by-keyboard.
2. Wire selection via `[`/`]` + announcements + Delete test (0.5 day).
3. Wires list panel (accessible alternative, screen-reader browse) (1 day).
4. Re-pick endpoint / reconnect edit incl. undo and tests (1 to 1.5 days).
5. Junction and wire-body targets (T-connections) in candidates (1 day).
6. Visual highlight/pan-into-view polish, shortcut help entries, HE review, docs (0.5 to 1 day).
Total about 5 to 6 days.

## 8. Open questions
- Roving pins within a component vs. all pins in the Tab order (large MCU boards have dozens of pins: roving preferred).
- Is `W` acceptable, or should Enter on a component enter pin mode (Enter currently unused on components)?
- Does an atomic "reconnect" domain edit exist? If not, one small edit in `edit.ts` is needed (requires PM nod since it touches domain).
- Hint wording for risky joins: PM/product to approve text.
