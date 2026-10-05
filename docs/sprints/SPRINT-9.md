# Sprint 9 — Three views of one circuit

**Status:** **Sprint 9 formally opened** (2026-10-05) from `sprint-9` `3bbeb4c` (which includes
`sprint-8-complete`). S9-M1 to M3 are done. The owner's S9-M4 review found three issues
(false-looking wire connections, direct terminal contact, 3D pan); they are fixed (see "Owner
review fixes" below). The refreshed **isolated preview** at
`https://dev-lab.tbi-tech.net/s9-preview/` serves `198ca92` and awaits the owner's re-review. **Not
ready for closure** until then. No PR, merge, tag or production deployment. dev-lab keeps the
validated Sprint 8 deployment. Production for Sprint 9 also waits for the separate
carried-forward capacity/security track.
Architecture and decisions: [SPRINT-9-ARCHITECTURE.md](SPRINT-9-ARCHITECTURE.md).

## Product rule

**The 2D Circuit view is the construction/editing surface.  
3D is a derived visualization.  
Professional Schematic is a derived electrical/topological representation.  
All three use one authoritative circuit model.**

- The project document is the only editable state. Neither generated view writes to it, and
  neither keeps state of its own beyond a camera (zoom, pan, orbit).
- **No schema change.** `schemaVersion` stays 3. Nothing visual is persisted: no schematic
  coordinates, no 3D positions, no camera, no meshes. Old projects open unchanged and get both
  views.
- Views are re-derived on every document change, so they cannot drift from the circuit.
  Switching tabs changes neither the document nor the simulation.

## Official Sprint 9 scope (opened 2026-10-05)

**Objective:** turn the working new views into a coherent, production-quality first release of
the **Circuit**, **Professional Schematic**, **3D** and **Code** views, all derived from one
authoritative project/circuit model.

**Permanent rule:** the 2D Circuit view is the construction/editing surface; the Schematic is a
derived electrical/topological representation; the 3D view is a derived visualization. Neither
may become a separate editable circuit model.

**In scope:**
- **Schematic polish:** symbol, label and group spacing, ESP32 block readability, connected-pin
  layout, routing, net-label placement, less needless height, consistency across the examples.
  Read-only; connected ESP32 pins only by default; no second netlist; no write from viewing or
  selecting. Not a schematic editor.
- **3D first-release polish**, targeted and low-risk only: framing/fit, camera defaults,
  readability, clearly misleading proportions, simple wire elevation, cheap stable
  materials/lighting, EN/HE labels and tooltips, navigation friction, loading/fallback. Not 3D
  editing, PCB/CAD, mechanical placement, pin-level 3D interaction, 3D routing, physics or a new
  asset pipeline.
- **Component representation review** (ESP32 DevKitC, resistor, LED, diode, push button, toggle
  switch, ground, lab supply), keeping the generic fallback.
- **View synchronization:** edits, rewiring, values, project switches, import, old projects,
  simulation; no manual refresh, no stale topology.
- **Live simulation:** LED glow in 3D only (no broad overlays).
- **Localization and RTL**, and **performance** (lazy loading, disposal, no work while inactive).

**Three.js** is the approved rendering technology, as a rendering layer only. The layers stay
separate: project/circuit model → scene description (`scene.ts`, pure) → component model
definitions (`models.ts`) → renderer (`renderer.ts`: three.js objects, camera/control state);
no product or domain logic in three.js objects. Lazy-loaded; no animation loop; every geometry,
material, texture and the WebGL context released on leaving.

**Milestones**

| Milestone | Content | Status |
|---|---|---|
| S9-M1 Foundation | schematic MVP, 3D MVP, localization, isolated preview, owner visual review PASS | **done** |
| S9-M2 Polish | schematic readability, targeted 3D usability, component review, synchronization review | **done** (below) |
| S9-M3 Regression and compatibility | full regression, old projects, import/export, repeated view switching/resources | **done** (below) |
| S9-M4 Owner preview review | refreshed isolated preview; owner visual review | preview live at `8ac8b86`; **awaiting owner** |
| S9-M5 Closure | after owner PASS: final CI, closure proposal, PR, merge, tag | not started |

No production deployment from Sprint 9 until the separate capacity/security track is complete.

**Separate carried-forward track (Sprint 8 Phases 5–6): NOT part of Sprint 9's product scope.**
Required before production; tracked apart and not touched by this sprint's UI work:
- capacity: measurements on the 1-vCPU host and a temporary 4-vCPU host (queue wait, session
  slowdown, stall-timeout margin, memory headroom, sandbox overhead, cross-user compile cost),
  CPU weighting under load, metrics/events/operator tooling, final admission and global caps,
  swap/memory pressure under mixed load;
- security/validation: the adversarial suite, the multi-user endurance run, the rest of Phase 6.

**Stop conditions:** a polish change that would need a schema redesign, a component-system
rewrite, 3D editing, a backend or runtime change, or a capacity-policy change is stopped and
reported first.

## S9-M2/M3: polish, regression and compatibility (2026-10-05)

**Schematic**
- Groups the MCU does not reach (independent branches) were stacked one below another even
  with nothing beside them. They now stand **side by side in rows** (each row's tracks at one
  height, so all rail labels line up with the supply column), 1.5 column pitches apart, wrapping
  at 900 units; without an MCU the first group continues the supply column's pitch.
  Drawing sizes (units): diode polarity 310×560 → **350×240**; voltage divider, LED current,
  push button and CC mode each 110 narrower; no example grew; ESP32 examples unchanged.
- Pin names and net labels 10 → 11 units (the ESP32 input example fits at about 0.75 scale).
- Checked unchanged and correct: read-only, connected ESP32 pins only, symbol orientation
  (diode/LED cathodes, supply polarity), selection writes nothing.

**3D**
- **Labels capped on screen:** near labels were about twice the size of far ones. Labels keep
  perspective (a 68-part circuit is not buried in labels at fit) but never exceed 26 px; applied
  per render, one distance per label.
- **Fit/reset frame the content's box:** the camera distance is solved from the projected box of
  the content (labels included) at 95 % of the view instead of wrapping a sphere around a flat
  circuit: tighter and centred on every example.
- **Keyboard camera:** the 3D view is focusable (visible focus ring); ← → rotate, + / − zoom, Home
  resets (the same actions as the buttons; arrows not mirrored under RTL); the view's note names
  the keys in EN and HE.
- Tried and reverted: constant-size labels everywhere (they buried the 68-part circuit at fit).

**Component representation review** (no model or symbol changed):

| Part | Schematic | 3D | Verdict |
|---|---|---|---|
| ESP32 DevKitC | module block, connected pins by name on their header side | board, module can, USB, EN/BOOT, header pins | identifiable. Its board is narrow (set by the 2D header spacing) and connectable pins run out sideways to their 2D terminals: deferred to the 3D effort, since changing it moves where wires meet the board |
| Resistor | zig-zag, value | axial with the real colour code | clear |
| LED | diode + emission arrows, cathode bar | 5 mm lens, glows when running | clear; on the small side relative to the board (≈ 0.55) |
| Diode | diode, cathode bar | axial, cathode band | clear, orientation visible |
| Push button | normally-open push switch | tactile switch, red cap | clear, distinct from the toggle |
| Toggle switch | SPST in its persisted position | lever in its persisted position | clear |
| Ground | ground symbol | post on a plate | clear |
| Lab supply | DC source, + on top | bench box, red/black posts | clear; deliberately symbolic size |

**Synchronization review:** verified (and now covered by `app/e2e/s9-sync.spec.ts`): a project
switch reopens on Circuit and the generated views show only the new project; a value change
(R1 10 kΩ → 4.7 kΩ) appears in the schematic at once and rebuilds the 3D scene; deleting a part
removes it from both; a current package and an **old package (format 1, schema v2)** import,
migrate and open in every view; viewing Schematic/3D changes nothing that export carries and the
export re-imports alike; LED glow follows a run across view switches, a return to 3D shows the
current state, Stop returns it dark at once; Circuit → Schematic → 3D → Code in EN and HE keeps
code, pin names and values LTR.

**Tests (at `8ac8b86`):** typecheck, lint, boundaries and build pass; unit **617** passed
(+1: schematic row packing, 12 independent branches wrapped, faithful, no crossings); browser
**129 passed**, 3 heavy skipped (+7: six in `s9-sync.spec.ts`, the 3D keyboard test); legacy
browser 4 passed. The existing 20× 3D enter/leave resource test passes unchanged.

**Measurements** (preview build, this 1-vCPU host, software WebGL, three runs after settling):

| | Before (preview `83edd67`) | After (`8ac8b86`) |
|---|---|---|
| Startup bundle `index` | 270.1 kB | 270.2 kB (78.8 kB gzip) |
| `SchematicView` chunk | 17.3 kB | 17.7 kB |
| `ThreeView` chunk | 7.4 kB | 7.8 kB |
| `renderer` chunk (three.js) | 574.5 kB | 575.2 kB (143.8 kB gzip) |
| Schematic, first open / again | 120–150 / 60–130 ms | 124–130 / 56–66 ms |
| 3D, first open / again | 1.3–1.4 s / 0.32–0.36 s | 1.41–1.44 s / 0.39–0.52 s |
| Orbit (60 drag steps) | ≈ 100 ms per step | ≈ 92–96 ms per step |
| Heap after 20 enter/leave cycles, after leaving | 7.2 MB | 7.2–7.3 MB; 0 canvases left |

**Preview (S9-M4):** `8ac8b86` published to `/srv/tbi-lab/s9-preview/` with
`deploy/dev-lab/s9-preview/publish.sh` (static files only; no service restarted; the dev-lab
page and service start times unchanged). The 51-check browser validation of the published files
passes (main app, schematic, 3D incl. 20 cycles and LED glow, Hebrew, WebGL fallback, isolated
storage). Evidence: `s9-evidence/m2-schematic-diode-polarity.png`, `m2-3d-cc-mode.png`,
`m2-3d-big-board.png`.

## Owner review fixes: electrical semantics and 3D pan (2026-10-05)

The owner's S9-M4 review found three concrete issues; Sprint 9 is not ready for closure until
they are reviewed again. Rule applied throughout: **a connection exists only in the domain
model; no view may draw one the model does not have, or hide one it has.**

**1. Wire crossings never connect; routing keeps wires off headers.**
- Already true in the domain since Sprint 2: connectivity comes only from explicit wire
  endpoints (terminals, junctions); crossings are drawn with a bridge, junctions with a dot.
  Now proven by regression tests: a wire run down the ESP32 header crosses the 18 other pins of that header and
  connects to none (each connectable pin it crosses is flagged); crossing wires stay separate nets; an
  explicit junction joins them; save/load keeps exactly the explicit connectivity.
- **Root cause of the observed defect:** a wire keeps its stored vertices when a part it is
  attached to moves, so its fixed horizontal-first route could end up running straight down the
  ESP32 header. And the router did not know the board's **unconnectable** header pins (3V3, EN,
  flash pins…): only connectable terminals were obstacles.
- **Fix:** every pin a board draws is now a routing obstacle; after a move or rotation, each wire
  the part drags along whose route now runs over a header, a body or an unrelated terminal is
  re-routed (the router's shapes through its own vertices, or straight between its ends,
  whichever is strictly better). Clean wires and wires moved rigidly with the selection are
  never touched; endpoints never change, so nets cannot change. Not a PCB router.
- In 3D (same rule): a wire whose route passes over a terminal, a header pin, a junction or
  another part's body is lifted above every terminal and every other wire's riser there; wires
  whose routes meet anywhere but a shared end get different heights, 0.45 apart (more than a
  wire's 0.28 diameter). The previous index-based heights let two wires touch in the
  representative mixed circuit; the new invariant test catches that.

**2. Direct terminal-to-terminal contact.**
- **Representation:** a contact is an ordinary wire between two terminals of different parts,
  with no vertices, whose terminals coincide. **No schema change**; nets, validation, snapshots,
  simulation, import/export and every view already treat a wire as a connection, and older
  readers load it as the zero-length wire it is. Chosen over a new field or a geometric rule: it
  is stored (not visual-only), and it needs no migration.
- **Made and broken only by placement edits** (add, move, rotate): a terminal of a part that was
  placed or moved landing exactly on another part's terminal gets a contact. Placement snaps to
  the 20-unit grid and every terminal offset is a grid multiple, so the snap tolerance is half
  a grid step of pointer travel; terminals one grid step apart stay separate. A contact whose
  terminals no longer coincide after an edit is removed; it is not stretched into a wire. At
  least one side must be a lead (resistor, LED, diode, switch): a lead may touch a lead, a
  header pin, a binding post or a ground post, but a header pin laid on a binding post is not a
  physical contact. Bodies, wires and unconnectable pins never make one.
- **Nothing is inferred on read.** A project made elsewhere can hold touching terminals that are
  not connected (the owner's R1/D1 case). They stay separate, and every view says so: the canvas
  shows a red not-connected marker plus a new check, *"R1 b touches D1 anode but is not connected
  to it"* (EN/HE). In 3D, both leads stop short (a visible gap) and a red ring marks the spot,
  instead of leads that look joined. Moving either part off and back joins them.
- Drawn as a connection: a dot on the canvas, a solder joint in 3D, one continuous node in the
  schematic. The simulation conducts through it exactly as through a wire; the LED current is
  equal to 12 digits.

**3. 3D pan.** Right-drag already panned (OrbitControls), but middle-drag zoomed and the view's
note was easy to miss. Now: left drag orbits; **right or middle drag pans**; Shift/Ctrl-drag also
pans (for trackpads); the wheel zooms; one finger orbits, **two fingers pan and pinch-zoom**;
**Shift + arrow keys** pan; the existing ← → + − Home keys are kept. Standard OrbitControls behaviour throughout; the
keyboard pan moves camera and target along the camera's screen axes. Fit and Reset re-centre on
the circuit. Panning never touches the project.

**4. Visual semantics audit.** A new invariant test (`app/tests/semantics.test.ts`) reads each
view's drawing back by geometry alone and requires **domain connectivity == schematic read-back
== 3D read-back**. The circuit canvas must also mark every spot where geometry alone suggests a
connection the model lacks. It covers every curated example, the mixed ESP32 circuit, a wire down
a header, crossing wires, a junction, a contact, touching-but-separate terminals, and a sequence
of moves and a rotation. The audit found and fixed one schematic defect: a part with one pin on
ground or a rail and the other open was drawn as fully unconnected, losing that connection. It
now carries its ground/rail mark.
Known gap: a wire drawn with manual waypoints straight over an **unconnectable** header pin is
not flagged on the canvas (it can never connect; the router avoids it).

**Commits** (on `d5302ec`): `a4315d5` direct contact (domain, check, canvas dot) · `22782be`
routing · `b5eaa56` 3D joints, wire heights, pan · `b3a0d75` schematic fix + invariant test ·
`198ca92` browser tests. Each commit typechecks, lints and passes the unit suite on its own.

**Tests (at `198ca92`):** typecheck, lint, boundaries and build pass. Unit **636** passed (+19):
- domain: wire semantics and routing (5), contacts (7);
- engine: a contact conducts like a wire (1);
- 3D: joints, wire heights (2);
- the invariant test (4).

Browser **133 passed**, 3 heavy skipped (+4, in `s9-semantics.spec.ts`):
- header routing;
- a contact made and broken across the canvas, schematic, 3D and simulation;
- an imported touching pair marked in the canvas and 3D;
- 3D pan: right and middle drag, Shift + arrows, Fit and Reset re-centre, repeated navigation
  keeps resources flat and writes nothing.

Legacy browser 4 passed. Mutation check: with the old 3D wire heights, or without the open-lead
gap, the invariant test fails.

**Compatibility:** no schema change (`schemaVersion` 3), no migration. Every existing project,
example and package opens unchanged and keeps its connectivity exactly; nothing is inferred on
read. New behaviour applies only to new edits: placement contacts, and re-routing of wires
dragged by a move. A project with contacts loads in an older build as zero-length wires, with
the same nets.

**Bundles:**

| Chunk | Before | After |
|---|---|---|
| `index` | 270.2 kB | 274.4 kB (79.5 kB gzip) |
| `ThreeView` (the scene description, now with joints and heights) | 7.8 kB | 11.6 kB |
| `renderer` | 575.2 kB | 577.1 kB |
| `SchematicView` | 17.7 kB | 17.8 kB |

**Preview:** `198ca92` published with `publish.sh` (static only). The 51-check validation of the
published files passes; the dev-lab page (`f8423e91…`) and every service start time are
unchanged. Evidence:
- `s9-evidence/fix-contact-canvas.png` and `fix-contact-3d.png` (a solder joint);
- `fix-touching-canvas.png` and `fix-touching-3d.png` (marker and check; gap and red ring);
- `fix-header-routing.png` (the ground wire runs beside the header, not down it).

## Approved product decisions (PM, 2026-10-05)

| | Decision | Implementation |
|---|---|---|
| A | **ESP32 schematic: only the connected pins** (default; keeps the schematic readable). A "Show all pins" option may come later. | Already the behaviour; unchanged. The layout skips a module pin whose terminal has no node (`placeModule` in `layout.ts`); an optional "show all pins" would be a layout option there, not implemented. Now also pinned by a browser test (EN and HE: exactly `GND`, `IO34`, `IO4` for the input-echo example). |
| B | **Hebrew: the full product term is "סכמה חשמלית"**; the tab may show the short "סכמה" with the full term as accessible name and tooltip. | Tab text "סכמה"; `aria-label` and `title` "סכמה חשמלית" (`view.name.schematic`). The schematic's accessible name ("סכמה חשמלית של …"), its controls' label and the 3D fallback text use the full term. Checked: correct logical character order, no bidi control characters, rendered correctly (screenshots below). English unchanged: "Schematic". "שרטוט חשמלי" is not used anywhere. |
| C | **3D: 2D determines placement; the component model determines realistic visual size/height.** Not mechanical CAD; no large refactor now. | No change to placement (no 3D position state, no schema change). Model sizes were reviewed against real parts (below); none is obviously unrealistic relative to the others, so no model was changed. Realistic relative dimensions are a follow-up. |
| D | **2D wire colours unchanged.** Node colours stay 3D-only; "Color by net" may come later as an optional mode, not a default. | Unchanged: `Canvas.tsx` and `symbols.tsx` are identical to Sprint 8 (`git diff ed20843` is empty for both). Recorded in the backlog. |
| E | **Live values: no broadening.** LED glow in 3D is enough for Sprint 9; switch/LED state and optional current/voltage visualization later, optional, never cluttering the schematic. | Unchanged: the only live visual in the new views is the 3D LED glow. |

**3D sizing review** (relative to the board, measured against its length: real ESP32 DevKitC
54 × 28 mm):

| Part | Model vs real, relative to the board |
|---|---|
| Resistor body (6.3 × 2.5 mm) | ≈ 0.8 length, 0.7 diameter |
| Tactile switch (6 × 6 mm) | ≈ 0.8 |
| LED (5 mm) | ≈ 0.55: on the small side |
| ESP32 board width | ≈ 0.6: set by the header spacing of the 2D board drawing, i.e. by placement |
| Bench supply | symbolic (a real one is several times the board's size) |

Realistic relative dimensions (per-model size metadata, in the model registry, never in the
project schema) are a follow-up.

## What was built

### Views

- The workspace tabs are now **Circuit · Schematic · 3D**, plus **Code** for ESP32 projects.
- The tabs are a keyboard tablist: Tab focuses the active tab, and the arrow keys move between
  tabs in reading order (mirrored under RTL).
- The circuit canvas stays mounted while hidden, so its zoom and edit state survive.
- Schematic and 3D mount only while shown, and their code loads on first use.

### Connectivity graph (domain)

`packages/domain/src/connectivity.ts` reads only the canonical netlist, never the layout:
- every ground net is one reference node `GND`;
- a grounded lab supply's positive node is a rail (`supply`);
- other nets are `signal` nodes;
- each component maps terminal → node.

### Professional schematic

**Symbol registry** (`app/src/views/schematic/symbols.ts`): each type → conventional symbol and
terminal↔pin mapping.

| Part | Symbol |
|---|---|
| Resistor | ANSI zig-zag |
| LED | diode with emission arrows |
| Diode | diode |
| Push button | normally-open push switch |
| Toggle switch | SPST, drawn in its persisted position |
| Lab supply | DC source, + on its positive pin |
| Ground | ground symbol |
| ESP32 DevKitC | module block |

The ESP32 module block:
- shows its connected pins by header name (IO4, IO34, GND), with the J2 header on the left and
  J3 on the right, as on the board;
- has the reference (U1) above and the part name inside;
- does not show the physical board drawing.

**Layout** (`layout.ts`) is deterministic and works from topology, not from 2D coordinates:
- Ground connections become ground symbols, and rails become `+V` labels with the supply's
  design voltage.
- Each connected MCU pin anchors a track running outward along the node:
  - parts to ground hang down;
  - parts to a rail stand up;
  - parts to a new node continue in series;
  - branches open rows below.
- Parts no MCU reaches form their own group. The supply and loads straight across it stand in a
  column on the left. Unwired parts are listed apart.
- Cycles, and nodes on two MCU pins, are joined by **net labels** (the user's net name, else the
  pin name, else the net id), never by crossing wires.

**Renderer** (`app/src/ui/SchematicView.tsx`):
- SVG, technical LTR under every locale;
- values formatted for the locale; junction dots;
- zoom, pan and fit;
- clicking or pressing Enter on a symbol selects that component (session selection, shown in the
  inspector); nothing is written.

### 3D view

**Scene description** (`app/src/views/scene3d/scene.ts`) is pure and deterministic:
- Plan position comes from the 2D layout, and the layout rotation becomes a rotation about the
  vertical axis. Elevation is derived: the base plane at 0 and each part on it.
- Wires follow their 2D routes. They are lifted 0.7–1.3 units, staggered so crossing,
  unconnected wires pass over one another.
- Wires are coloured by **electrical node**: ground black, a supply rail red, other nodes from a
  fixed palette.

**Procedural models** (`models.ts`), whose leads end exactly at each part's terminals:

| Part | Model |
|---|---|
| ESP32 DevKitC | PCB with WROOM-32 can and antenna area, micro-USB, EN/BOOT, a header pin at every position; connectable pins run out to their terminals as in the circuit view |
| Resistor | axial, with its **real colour code** derived from the resistance: 4 bands if two digits are exact, 5 if three are, otherwise no bands rather than invented ones |
| LED | 5 mm, model colour, anode and cathode legs |
| Diode | axial, with cathode band |
| Push button | tactile switch |
| Toggle switch | lever showing the persisted position |
| Ground | post |
| Lab supply | bench box with display, binding posts (red +, black −) |
| Any other type | generic box |

**Renderer** (`renderer.ts`, three.js 0.186.1, MIT, bundled locally, no network):
- Navigation: orbit through 360°, zoom, pan; buttons for zoom ±, rotate left/right, fit and
  reset camera, all with localized names. Navigation cannot edit anything.
- Renders on demand, coalesced to at most one render per frame. There is **no animation loop**.
- Geometries are shared by shape: the representative circuit uses 48, down from 243.
- Leaving the tab disposes every geometry, material and texture, and the **WebGL context**.
- Reference designators float above parts, LTR.
- **Live state:** while a simulation runs, an LED glows from its solved forward current. This is
  the circuit canvas's existing visual cue (full at 20 mA), presentation only.
- **No WebGL:** a localized explanation (EN/HE) is shown; the other views keep working.

### Localization

- All new UI strings are in English and Hebrew.
- Schematic tab: "Schematic" / "סכמה", with the full Hebrew term "סכמה חשמלית" as its accessible
  name and tooltip (decision B).
- Technical labels (refs, pin names, values, net names) stay LTR.
- The views' notes follow the UI direction.

## Tests

| Suite | Result |
|---|---|
| Typecheck, lint, architecture boundaries, production build | PASS |
| Unit (`npm test`) | **616 passed**, 60 files (Sprint 8: 593); new: 5 connectivity, 6 schematic, 6 scene, 3 preview deployment/storage |
| Browser/e2e (`test:e2e`) | **122 passed**, 3 heavy skipped (Sprint 8: 114); new: 8 in `s9-views.spec.ts` |
| Legacy browser (`test:browser`) | 4 passed |

(Counts at the HEAD after the product decisions; the first pass at `009783f` had 613 and 121.)

The project-format tests (validation, migration, packages, fuzz) are unchanged and pass.

**Schematic** (`app/tests/schematic.test.ts`). The central invariant: the drawing is read back
and must give exactly the model's electrical nodes. Read-back uses wires, pins on wires,
junctions, ground symbols, rail labels and net labels of the same name. This is checked for:
- the representative circuit (ESP32 + LED + resistors + push button + supply + grounds);
- all 8 curated examples;
- a cycle through the board plus a node on two MCU pins;
- parallel parts, a floating supply, open pins and an unwired part.

Further checks:
- zero wire crossings in all of them;
- ESP32 pins by name and side;
- ground and rail marks;
- signal flow direction;
- LED orientation;
- determinism;
- independence from 2D geometry and from design values;
- delete and reconnect are reflected;
- every type has a symbol.

**3D scene** (`app/tests/scene3d.test.ts`):
- one part per component at its layout position, terminals exactly at the circuit's terminal
  points, a dedicated model for every catalog type;
- wires on 2D routes, above the plane, coloured by node;
- add, delete, move, rotate and reconnect are reflected, while design values change visual
  detail only;
- the toggle position is shown;
- deterministic, and the document is never mutated;
- the colour-code table.

**Browser** (`app/e2e/s9-views.spec.ts`):
- tabs and arrow-key navigation;
- the schematic follows circuit edits (delete, add);
- selecting in the schematic writes nothing;
- three.js is not requested before the 3D tab opens;
- the scene follows edits and project changes;
- camera controls and orbit/zoom gestures write nothing;
- 20 enter/leave cycles: the same geometry count every time, no 3D canvas left after leaving,
  no "too many WebGL contexts" warning (more cycles than Chrome's live-context limit);
- WebGL disabled: localized fallback, Circuit and Schematic still work;
- view switching during a run keeps the run and the project unchanged, and the running LED is
  lit in 3D;
- Hebrew labels, and the Hebrew schematic tab's accessible name and tooltip "סכמה חשמלית";
- the ESP32 block shows exactly its connected pins, in English and Hebrew.

## Measurements

The host has 1 vCPU, ARM64, and **software WebGL** (SwiftShader). GPU-backed browsers are much
faster.

**Bundles:**

| Bundle | Size |
|---|---|
| Startup bundle (`index`) | Sprint 8 263.2 → `009783f` 268.9 → **270.1 kB** (gzip 76.1 → 78.4 → 78.7 kB): tabs, lazy loader, strings, connectivity; then the decision strings and the preview hooks (+1.2 kB) |
| `SchematicView` chunk | 17.3 kB (6.2 kB gzip), on first schematic open; unchanged by the decisions |
| `ThreeView` chunk | 7.4 kB (3.1 kB gzip), on first 3D open; unchanged by the decisions |
| `renderer` chunk (three.js + models) | 574.5 kB (143.5 kB gzip), on first 3D open; unchanged by the decisions |

(The `ThreeView` and `renderer` sizes first recorded here, 7.0 and 574.1 kB, predate the LED
glow commit; the values above are rebuilt from `009783f` and from the current HEAD.)

**Activation** (representative ESP32 circuit):

| Measure | Result |
|---|---|
| Schematic, first open | 301 ms |
| Schematic, again | 97 ms |
| 3D, first open | 1.9 s, including chunk load and shader compilation |
| 3D, again | 1.5 s, a fresh WebGL context each time |

**Interaction.** One orbit drag step took about 110 ms here, which is software rendering of the
full canvas. Renders are coalesced per frame, and nothing renders while the view is idle.

**Layout cost** (68-part circuit, 19 pins in use):

| Function | Time |
|---|---|
| `schematicLayout` | 3.5 ms |
| `deriveScene` | 2.3 ms |

**Memory** (JS heap after GC):

| Point | Heap |
|---|---|
| Before 3D | 2.7 MB |
| With 3D open | 7.3 MB |
| After 20 enter/leave cycles, in 3D | 8.7 MB |
| After leaving | 7.1 MB |

The retained part is the loaded three.js module code. There is no growth trend, and no GPU
resource remains after leaving.

**Idle editor.** With the 3D view closed, nothing of it runs; the existing performance suites
pass unchanged.

**Remeasured on the preview build** (published files, same host, representative ESP32
circuit, three runs after the page had settled):

| Measure | Result |
|---|---|
| Schematic, first open | 120–150 ms |
| Schematic, again | 60–130 ms |
| 3D, first open | 1.3–1.4 s |
| 3D, again | 0.32–0.36 s |
| Orbit drag step | ≈ 100 ms |
| Heap: before / in 3D / after 20 cycles in 3D / after leaving | 2.8 / 7.4 / 8.8 / 7.2 MB |
| 3D canvases left after leaving | 0 |

Opening the schematic **immediately** after a project loads took 5.3–5.6 s in two of five runs
(0.29 s in another): on this 1-vCPU host the first chunk load competes with the project's
start-up work. Not seen once the page had settled; not measured on a multi-core machine.

## Visual validation

Screenshots are in [s9-evidence/](s9-evidence/):
- schematic of the ESP32 input-echo circuit, in English and Hebrew;
- schematic of the voltage divider;
- a 68-part schematic;
- 3D front, side, rear and zoomed;
- 3D in Hebrew with a running LED lit.

Manual review against the requested checks:

**3D**
- PSU, board, parts and wires are identifiable from every side.
- Wire colours follow nodes.
- Fit and reset frame the whole circuit.
- Zoom keeps the board legible.

**Schematic**
- Signal flow reads outward from the MCU pins.
- ESP32 pin names are legible.
- The supply column and rail labels are conventional.
- No overlapping symbols and no crossings in the examples.
- On the 68-part circuit, rows are generously spaced. It is tall, but it stays readable.

Fixes made during this review:
- Analog groups now sit level with their supply column instead of far below it.
- Side labels of vertical parts clear the symbol (switches, LED arrows, source circle).
- 3D framing was tightened, the grid kept on the base, and label sprites enlarged.
- LED, resistor, diode and button models were enlarged, since they read as specks next to the
  board.

## Isolated Sprint 9 preview

**URL:** `https://dev-lab.tbi-tech.net/s9-preview/`. Experimental; for the owner's visual review.

```
browser ─HTTPS─> Caddy :443 ─> oauth2-proxy (same Google login + allowlist as dev-lab)
   ─> Caddy internal origin (unix socket)
        /s9-preview/*        → /srv/tbi-lab/s9-preview/current   Sprint 9 static build (new)
        /runtime/*, /build/* → Sprint 8 backends, unchanged (same origin, used by both apps)
        everything else      → /srv/tbi-lab/dev-lab/current      Sprint 8, unchanged
```

- **Static only.** `deploy/dev-lab/s9-preview/publish.sh <ref>` builds a ref in a clean worktree
  and installs it under `/srv/tbi-lab/s9-preview/<sha>`. Unlike `deploy/dev-lab/publish.sh` it
  builds no backend, writes nothing under dev-lab's releases or `services/`, and restarts
  nothing. Published: `83edd67`.
- **One additive gate route.** `install-route.sh` installs `s9-preview.caddy` as
  `/etc/caddy/tbi-s9-preview.caddy` and adds one `import` line to the internal origin of
  `/etc/caddy/Caddyfile` (backed up first, validated, graceful reload; `--remove` takes it out).
  Every existing dev-lab route is unchanged; no TCP port, CORS or header rule was added or
  weakened. The preview's HTML is `no-store` and `noindex`; hashed assets as for dev-lab.
- **Same backends, unchanged.** Sprint 9 is frontend-only; the preview app calls the same-origin
  `/runtime` and `/build` of the validated Sprint 8 services, under the same identity.
- **Never mistaken for dev-lab.** An amber strip on every screen: "Sprint 9 preview ·
  experimental — An experimental preview, separate from the validated deployment. Its projects
  are stored apart." (Hebrew: "תצוגה מקדימה Sprint 9 · ניסיונית …"); the page title starts with
  "Sprint 9 preview". A first version put a badge in the top bar; the visual check showed it
  collapsing the project name over the save status at 1280–1400 px, so it moved to the banner
  row (`83edd67`); the top bar is exactly as in Sprint 8.
- **Its own browser storage.** Same origin as dev-lab, so the build sets
  `VITE_STORAGE_NAMESPACE=s9-preview`: projects in the IndexedDB database `s9-preview/tbi-lab`,
  preferences under `s9-preview/…` keys. The preview never reads or writes dev-lab's projects
  (relevant while Sprint 8's owner smoke is pending). To look at an existing project in the
  preview, export it from dev-lab and import it there.
- **Rollback / removal:** re-point `current`, or `install-route.sh --remove` (dev-lab is then
  exactly as before).

**Validation of the preview** (2026-10-05):

- Gate, through the real Caddy internal origin: `/s9-preview` → 308 `/s9-preview/`; the index and
  all 9 published files are served byte-identical to the release; a missing asset is 404; the
  public URL (page and assets) redirects to Google sign-in without a session.
- Sprint 8 after the route was added: the dev-lab index is served byte-identical to its release
  (`c31d62e`); its assets, SPA fallback, `/runtime` and `/build` answer as before; both release
  links are unchanged; oauth2-proxy, tbi-build and tbi-session-host have the same start times
  (not restarted).
- Browser, 51/51 checks, against the published preview files served at `/s9-preview/` exactly
  as the route serves them (loopback harness, not committed):
  - **main app:** loads from `/s9-preview/assets/`; strip and title; a project opens; Circuit,
    Code (sketch shown, LTR under Hebrew) and back; storage namespaced (only the
    `s9-preview/tbi-lab` database, every preference key prefixed); top bar not crowded;
  - **schematic:** opens; ESP32 shows exactly `GND`, `IO34`, `IO4`; resistor, LED, button,
    supply and ground symbols; voltage divider, LED current, push button and ESP32 blink
    render; selecting R1 selects it in the inspector; no project write;
  - **3D:** opens; three.js loaded only on the 3D tab, from the preview path; 13 wires; board,
    resistors, LED, switches, supply and grounds present; rotate buttons, drag orbit,
    right-drag pan, wheel zoom, fit and reset each change the rendered image; no project write;
    20 enter/leave cycles leave no canvas, cost the same 48 geometries each time, no "too many
    WebGL contexts" warning; heap 8.9 → 7.2 MB on leaving; the LED is dark when stopped and lit
    while the simulation runs;
  - **Hebrew:** RTL document; tabs "מעגל · סכמה · תלת־ממד · קוד"; schematic tab title and
    accessible name "סכמה חשמלית"; schematic accessible name "סכמה חשמלית של …"; drawing and
    pin names LTR, note RTL; 3D controls localized; no page errors;
  - **WebGL unavailable:** localized explanation; Schematic and Circuit keep working.
- **Not validated by me:** the signed-in path through Google login (headless cannot sign in as
  the owner; the gate checks above cover routing and protection), and ESP32 Run/Build from the
  preview against the Sprint 8 backends (unchanged code and endpoints; the LED-glow run uses
  the local DC engine). Both are part of the owner review.

Screenshots of the preview in [s9-evidence/](s9-evidence/): `preview-projects-en.png`,
`preview-he-tabs.png`, `preview-schematic-he-esp32-input-echo.png`, `preview-3d-he.png`,
`preview-3d-en-led-lit.png`, `preview-3d-no-webgl.png`.

## Development-history caveat

The commits between `6f6442b` and `009783f` do not pass their tests on their own: a change to
the shared test fixture (`packages/domain/tests/circuits.ts`, the mixed circuit wiring the new
project's own supply and ground) was used by every test run from Phase C on but committed only
in `009783f`. Published history was not rewritten. Commits since `009783f` were made to be
independently valid (code before its tests, nothing relying on a later commit); the full checks
ran at `1679128`, `83edd67` and the final HEAD, not separately at every intermediate commit.

## Owner visual review (2026-10-05)

**Sprint 9 visual review: PASS for the currently approved scope.** The existing implementation
is accepted as the first version: 2D Circuit as the editing/construction surface, the derived
read-only Professional Schematic, the derived 360° 3D visualization, one synchronized circuit
model, 3D orbit/pan/zoom/fit/reset, the current component models, LED live glow, English and
Hebrew, the WebGL fallback and the isolated preview architecture. No product change follows from
the review.

**3D is deliberately an initial implementation**, a foundation and first usable visualization,
not a finished 3D experience. The owner intends to invest substantially in it later, in a
deliberately planned, dedicated 3D-focused effort (not by growing this sprint into a 3D/CAD
sprint). The rule stays: **3D is a derived visualization of the authoritative circuit model, not
a separate circuit editor**; the user must never place or wire the same circuit again in 3D.

Future 3D direction: see **Future 3D backlog** below.

Owner's list as given (recorded, not implemented):
- substantially higher-quality component models;
- more realistic relative component dimensions;
- improved ESP32 board/model detail;
- better physical representation of connectors and headers;
- improved wire geometry/routing in 3D, and better depth/elevation of wires;
- improved materials and lighting;
- clearer component identity at normal zoom;
- ESP32 pin identification / labels;
- component selection/picking where useful;
- better camera/navigation ergonomics, and improved fit/framing;
- performance on real desktop GPUs and on lower-end systems;
- richer live simulation visualization, possibly live state for switches and other components;
- optional electrical-state overlays where educationally useful.

The build-latency finding stands: a fresh ESP32 compile takes about 30–36 s on the current
dev-lab host, an identical-source build is a cache hit (effectively instant), and Sprint 9
introduced no frontend build-performance regression.

## Owner review: build latency (2026-10-05)

During the owner's visual review one Build took more than 10 s. Classified as **not a Sprint 9
regression**:

> First build of a sketch may require a real Arduino/ESP32 compile and take roughly 30–36 seconds
> on the current single-vCPU dev-lab host. Rebuilding identical source is served from cache and
> should be effectively instant.

- **The observed build** (05:31:45 UTC) was the first build of the "ESP32: switch input to LED"
  example's source on the Sprint 8 backend (Sprint 8 deliberately did not carry the Sprint 7
  cache forward): one real compile, 34.2 s wall, 25.8 CPU-s, 727 MB peak. That example's build is
  now cached for every user.
- **Measured** through the deployed `/build/` route (the preview's same-origin path), fresh test
  principals, 5 runs each:

| Case | Wall time | Cache | Queue | Compile |
|---|---|---|---|---|
| First build of the (now cached) example | 1–11 ms | hit | 0 | 0 |
| Identical source again | 1–8 ms | hit | 0 | 0 |
| Trivial edit | 33.7–36.7 s (median 34.2 s) | fresh | 0–2 ms | 33.5–36.3 s |
| Reverted to a cached source | 1–3 ms | hit | 0 | 0 |
| Real code edit (one run) | 35.7 s, then 2 ms | fresh, then hit | 0 | 35.4 s |

  A comment-only edit compiles to an identical image (same artifact SHA); a code edit gives a new
  one, and reverting returns the old one from cache. Sprint 8 recorded 30–36 s for a fresh
  compile, so this is the known single-vCPU limit, not a change.
- **Frontend overhead:** none. With the same mocked `/build`, the Sprint 8 and Sprint 9 frontends
  both send the request ≈ 1 ms after the click and show the result 6–19 ms after the last
  response; Sprint 9 changed no build or runtime client code.
- **Host during the measurements:** CPU busy (median 88 %, the compile itself), load ≤ 1.25, no
  QEMU session, no queue (≤ 2 ms), light swap traffic.

Build behaviour and backend policy are unchanged.

## Owner visual-review checklist

1. Sign in at `https://dev-lab.tbi-tech.net/s9-preview/`; the amber "Sprint 9 preview ·
   experimental" strip is shown; the project list is the preview's own (empty at first).
2. Open "ESP32: switch input to LED": Circuit and Code work; Build and Run work against the
   Sprint 8 backend. **The first build of a sketch may require a real Arduino/ESP32 compile and
   take roughly 30–36 seconds on the current single-vCPU dev-lab host; rebuilding identical
   source is served from cache and should be effectively instant.**
3. Schematic: only `GND`, `IO34`, `IO4` on the ESP32 block; resistor, LED, button, supply and
   ground symbols readable; also Voltage divider, LED current, Push button, ESP32 blink.
4. Click a part in the schematic: the inspector selects it; the save state does not change.
5. 3D: orbit all the way round, right-drag pan, wheel zoom, fit, reset; wires and parts
   identifiable from every side.
6. LED current → Run: the LED lights in 3D.
7. Switch tabs 10–20 times: the browser stays responsive.
8. עברית: tabs "מעגל · סכמה · תלת־ממד · קוד"; the schematic tab's tooltip is "סכמה חשמלית";
   RTL layout with code, pin names and values LTR.
9. Verdict: 3D sizes, schematic layout and labels, the preview strip — acceptable, or what to
   change.

## Limitations (first implementation, stated plainly)

**3D**
- 3D is a **visualization only**: no 3D editing, placing or wiring. It is not mechanical CAD
  and not a PCB view. Parts sit where the 2D layout puts them (decision C); model sizes are
  approximate (the sizing review above), not realistic relative dimensions yet.
- Models are procedural and simplified. There are no photoreal assets, no shadows, and no pin
  labels on the ESP32 board in 3D.
- The 3D view does not show simulation values. Only LED glow is mirrored.
- 3D picking (selecting a part in 3D) is not implemented.
- The ESP32 board is narrower than the real one and its connectable pins run out sideways to the
  wires' 2D terminal points (placement comes from the 2D layout); the LED is small relative to the
  board. Both are deferred to the dedicated 3D effort.
- On a large circuit the reference labels at fit are small (perspective, by design, so they do
  not bury the circuit); zoom in to read them.

**Schematic**
- The schematic is generated and **read-only**: it cannot be edited or annotated, and it does not
  print or export yet.
- Layout covers the educational topologies in the current catalog. It is not a KiCad-class
  placer or router; complex meshes fall back to net labels, which is correct but less pictorial.
- Large circuits produce tall drawings (an ESP32 with many used pins); independent groups now
  pack into rows. Wide drawings fit below scale 1 (the ESP32 input example at about 0.75): text
  stays readable but small; zoom is available.
- Only connected ESP32 pins are shown (decision A, by design); there is no "show all pins" option yet.
- Schematic values are design values. Live simulation values are not shown in the schematic.

**Performance**
- On this software-WebGL host, 3D activation (about 1.4 s first, 0.4–0.5 s again) and orbit
  (about 95 ms per step) are slow. On a GPU-backed browser they should be far faster, but this
  was **not measured here**.

## Decisions for the product owner

The five first-pass questions were decided by the PM on 2026-10-05 (see "Approved product
decisions" above). Open: the owner's re-review of the preview after the owner-review fixes
(`198ca92`).

## Future 3D backlog (deferred to a dedicated 3D effort)

The current 3D view is a foundation and first usable visualization. A deliberately planned,
dedicated 3D-focused effort (not this sprint) should consider:
- substantially higher-quality component models (e.g. glTF through the model registry);
- realistic relative component dimensions (per-model size metadata; 2D keeps placement);
- improved ESP32 board/model detail, and the board's real width;
- physical connectors and headers (pins down into the board, wires meeting the header);
- better wire geometry/routing and depth/elevation in 3D;
- better materials and lighting;
- clearer component identity at normal zoom;
- ESP32 pin identification / labels;
- component selection/picking where useful;
- camera/navigation ergonomics and fit/framing beyond Sprint 9's improvements;
- performance on real desktop GPUs and lower-end systems (measured; this host has software WebGL);
- richer live simulation visualization: switch and other component state;
- optional electrical-state overlays where educationally useful.

The rule holds throughout: **3D is a derived visualization of the authoritative circuit model,
not a separate circuit editor**; nobody places or wires a circuit again in 3D.

## Future / backlog (not implemented)

- 3D picking synchronized with the selection.
- **A dedicated 3D effort** (owner direction, 2026-10-05): see "Future 3D backlog" above.
- glTF models for selected parts, through the model registry.
- Schematic export (SVG/PDF) and print.
- "Show all pins" for the ESP32 schematic block, as an option (default stays connected-only).
- Realistic relative component dimensions in 3D (per-model size metadata; 2D keeps placement).
- "Color by net" for the 2D editor, as an optional visualization mode, never the default.
- Optional live state in the views (switch and LED state, current/voltage), never cluttering the
  schematic.
- 3D labels for ESP32 pins.
- Multi-board schematics with sheet-style layout.
