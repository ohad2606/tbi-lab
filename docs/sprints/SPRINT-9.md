# Sprint 9 — Three views of one circuit

**Status:** implementation track, first pass complete on branch `sprint-9` (from `sprint-8`
`ed20843`). Not reviewed by the PM, not deployed anywhere. Sprint 8 is untouched: no Sprint 8 file,
deployment or validation record was changed, and the Sprint 8 dev-lab instance was not touched.
Architecture and decisions: [SPRINT-9-ARCHITECTURE.md](SPRINT-9-ARCHITECTURE.md).

## Product rule

**The 2D circuit editor is the construction/editing surface. 3D is a derived 360° visualization.
The professional schematic is a derived electrical/topological representation. All three use the
same authoritative circuit model.**

- The project document is the only editable state. Neither generated view writes to it, and
  neither keeps state of its own beyond a camera (zoom, pan, orbit).
- **No schema change.** `schemaVersion` stays 3. Nothing visual is persisted: no schematic
  coordinates, no 3D positions, no camera, no meshes. Old projects open unchanged and get both
  views.
- Views are re-derived on every document change, so they cannot drift from the circuit.
  Switching tabs changes neither the document nor the simulation.

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
- Technical labels (refs, pin names, values, net names) stay LTR.
- The views' notes follow the UI direction.

## Tests

| Suite | Result |
|---|---|
| Typecheck, lint, architecture boundaries, production build | PASS |
| Unit (`npm test`) | **613 passed**, 60 files (Sprint 8: 593); new: 5 connectivity, 6 schematic, 6 scene |
| Browser/e2e (`test:e2e`) | **121 passed**, 3 heavy skipped (Sprint 8: 114); new: 7 in `s9-views.spec.ts` |
| Legacy browser (`test:browser`) | 4 passed |

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
- Hebrew labels.

## Measurements

The host has 1 vCPU, ARM64, and **software WebGL** (SwiftShader). GPU-backed browsers are much
faster.

**Bundles:**

| Bundle | Size |
|---|---|
| Startup bundle (`index`) | 263.2 → **268.9 kB** (+5.7 kB; gzip 76.1 → 78.4 kB, +2.2 kB): tabs, lazy loader, strings, connectivity |
| `SchematicView` chunk | 17.3 kB (6.2 kB gzip), on first schematic open |
| `ThreeView` chunk | 7.0 kB (2.9 kB gzip), on first 3D open |
| `renderer` chunk (three.js + models) | 574.1 kB (143.3 kB gzip), on first 3D open |

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

## Limitations (first implementation, stated plainly)

**3D**
- 3D is a **visualization only**: no 3D editing, placing or wiring. It is not mechanical CAD
  and not a PCB view. Parts sit where the 2D layout puts them, so proportions follow the 2D
  drawing, not real dimensions.
- Models are procedural and simplified. There are no photoreal assets, no shadows, and no pin
  labels on the ESP32 board in 3D.
- The 3D view does not show simulation values. Only LED glow is mirrored.
- 3D picking (selecting a part in 3D) is not implemented.

**Schematic**
- The schematic is generated and **read-only**: it cannot be edited or annotated, and it does not
  print or export yet.
- Layout covers the educational topologies in the current catalog. It is not a KiCad-class
  placer or router; complex meshes fall back to net labels, which is correct but less pictorial.
- Large circuits produce tall drawings.
- Only connected ESP32 pins are shown, not the full 38-pin module symbol.
- Schematic values are design values. Live simulation values are not shown in the schematic.

**Performance**
- On this software-WebGL host, 3D activation (1.5–1.9 s) and orbit (about 110 ms per step) are
  slow. On a GPU-backed browser they should be far faster, but this was **not measured here**.

## Decisions for the product owner

1. **Schematic pin scope.** Show only connected ESP32 pins (current), or the full module symbol
   with every header pin?
2. **Tab label in Hebrew.** "סכמה" is used for Schematic. Confirm, or prefer "סכמה חשמלית" /
   "שרטוט חשמלי".
3. **3D proportions.** Keep the 2D layout's proportions (current: one source of placement), or
   introduce real part dimensions? Real dimensions would need per-part visual metadata, still
   outside the project schema.
4. **Wire colours.** Node-based colours (ground black, supply red, signals from a palette) are a
   presentation choice the 2D editor does not share yet. Should the 2D editor adopt them?
5. **Simulation values in the new views.** Should a later sprint show solved voltages and
   currents in the schematic or 3D?

## Future / backlog (not implemented)

- 3D picking synchronized with the selection.
- glTF models for selected parts, through the model registry.
- Schematic export (SVG/PDF) and print.
- Showing unconnected ESP32 pins.
- Live values in the schematic.
- 3D labels for ESP32 pins.
- Multi-board schematics with sheet-style layout.
