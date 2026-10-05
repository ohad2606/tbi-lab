# Sprint 9 — Three views of one circuit (architecture)

**Branch:** `sprint-9`, from `sprint-8` HEAD `ed20843`. Sprint 8 stays frozen for owner smoke and
closure; nothing here touches the Sprint 8 dev-lab deployment.

## Product rule

**The 2D circuit editor is the construction/editing surface. 3D is a derived 360° visualization.
The professional schematic is a derived electrical/topological representation. All three use the
same authoritative circuit model.**

```
Project document (components, nets + connections, layout)        ← the only editable state
  ├── 2D circuit editor (Canvas)                                  edits the document
  ├── connectivity graph (domain, derived)
  │     └── schematic layout (derived) → schematic renderer      read-only view
  └── 3D scene description (derived) → 3D renderer (lazy)         read-only view
```

Neither derived view stores anything in the document: no schematic coordinates, no 3D
positions, no camera state, no meshes. Each view is a pure function of the current document
(plus, for display only, the locale). Re-deriving on every document change is what keeps the
three views synchronized; there is nothing to synchronize by hand.

## What the inspection found (Phase A)

- **Model.** Schema v3 (`packages/domain/SCHEMA.md`): components with language-neutral types and
  terminal ids; an explicit canonical netlist (`nets` + `connections`, re-derived from the wire
  graph after every edit, `nets.ts`); a layout (positions on a 20-unit grid, rotation, wires that
  attach to terminals or junctions by reference, `layout.ts`/`route.ts`).
- **Catalog.** `catalog.ts`: 8 types — lab PSU, ground, resistor, LED, diode, push button, toggle
  switch, ESP32 DevKitC (WROOM-32). Terminal offsets are in schematic units; the ESP32 terminals
  come from the board capability map (`boards/esp32DevkitcWroom32.ts`, header J2/J3 order).
- **2D editor.** `app/src/ui/Canvas.tsx`, inline SVG, symbols in `app/src/ui/symbols.tsx` (ANSI
  line art, no text), the ESP32 drawn as its physical header layout. The editor is a
  "physical wiring" drawing: wire geometry is user-authored.
- **Views.** `Editor.tsx` has a Circuit/Code tab pair (only for ESP32 projects).
- **Stack.** Preact 10 + Vite 8; no 3D or graph dependency. Baseline production bundle:
  `index` 263.2 kB (76.1 kB gzip), CSS 29.9 kB, worker 21.8 kB.
- Ground: every ground terminal is the circuit reference (engine node 0). A project may hold
  several `role: ground` nets (one per GND symbol cluster); they are one electrical node.

## Decisions

### D-S9-1 Connectivity graph in the domain

`packages/domain/src/connectivity.ts` derives, from `nets` + `connections` only:
- electrical nodes: every `role: ground` net merges into one `GND` node (the engine's reference);
  other nets are one node each;
- per component, terminal → node;
- node kinds: `ground`, `supply` (a net on a lab PSU's positive terminal whose negative terminal
  is on ground: a rail), `signal`;
- unconnected terminals.

Pure and deterministic; reusable later (checks, AI explanations).

### D-S9-2 Schematic: symbol registry, layout, renderer — separate layers

- `app/src/views/schematic/symbols.ts` — per component type: schematic symbol key, pins (terminal
  id → local position and side), body extent, and how to label it. The ESP32's pins are generated
  from the board capability map (header label, side J2 = left / J3 = right, header order). Adding a
  component means adding a registry entry; the layout and renderer have no per-type code.
- `app/src/views/schematic/layout.ts` — deterministic automatic layout from the connectivity graph
  (not from 2D coordinates):
  - ground connections → ground symbols at the pin; supply rails → rail labels at the pin;
  - the MCU is a module block; each connected pin anchors a track that runs outward (left pins
    left, right pins right);
  - along a net: two-terminal parts to ground/rail hang as vertical "shunts" (to ground down, to a
    rail up, paired in one column when both exist), parts to another net continue in series;
    branches open new rows below;
  - parts not reachable from the MCU form their own groups; unconnected parts are listed apart;
  - anything a tree drawing cannot reach without crossing (cycles, a net on two MCU pins) is
    joined by **net labels** — standard schematic practice, exact topology, no autorouter;
  - lab supplies are drawn once as a DC source between their rail label and ground.
- `app/src/ui/SchematicView.tsx` — SVG renderer: draws symbols by key, wires as orthogonal
  polylines, junction dots, labels (refs and values LTR; locale-aware value formatting).
- **Invariant tested:** reconnecting the drawing (wire endpoints, junctions, net-label names,
  ground symbols, rail labels) reproduces exactly the model's electrical nodes.

### D-S9-3 3D: three.js, lazy-loaded, render on demand

- three.js (MIT, no runtime network, bundled locally by Vite) is the smallest maintainable choice:
  a hand-written WebGL renderer would need its own camera controls, picking, disposal and, later,
  model loading; three.js has OrbitControls and a glTF loader for future component models.
- Loaded with a dynamic `import()` only when the 3D tab opens; the main bundle does not grow by
  the library.
- `app/src/views/scene3d/scene.ts` — pure, deterministic scene description from the document:
  board/base plane from the layout bounds; per component a model key, X/Y from the 2D layout,
  rotation from the layout rotation, elevation derived (base plane, parts above it); wires from
  the 2D wire routes, lifted slightly above the plane, coloured by electrical node (ground black,
  supply red, signals from a fixed palette). Unit tests run on this description, without WebGL.
- `app/src/views/scene3d/models.ts` — procedural, simplified models per model key (resistor with
  its real colour code from its resistance value, LED, diode with cathode band, tactile button,
  toggle switch with lever position, lab supply with binding posts, ESP32 DevKitC with module
  can and header pins, a generic box for anything without a model). Higher-quality models later
  replace an entry here; the circuit schema never changes for visual detail.
- `app/src/views/scene3d/renderer.ts` — three.js scene, OrbitControls (rotate 360°, zoom, pan),
  reset and fit. No animation loop: it renders on control changes and on scene updates. On
  leaving the tab every geometry, material, texture and the WebGL context are released.
- If WebGL is not available the 3D tab shows a localized message; the other views are unaffected.

### D-S9-4 View tabs

Circuit · Schematic · 3D (· Code for ESP32 projects), a keyboard-accessible tablist. The Canvas
stays mounted (hidden) so its camera and editing state survive; Schematic and 3D mount only while
shown. Switching views never changes the document or the simulation.

### PM decisions, 2026-10-05 (details in SPRINT-9.md)

- **Schematic pins:** the ESP32 block shows only connected pins (default). A future
  "Show all pins" belongs in the layout as an option to `placeModule`; not implemented.
- **Hebrew term:** "סכמה חשמלית" (tab text may be "סכמה"; accessible name and tooltip in full).
- **3D sizing rule:** 2D determines placement; the component model determines visual size and
  height. Realistic relative dimensions later, as per-model metadata in the model registry,
  never in the project schema. Not mechanical CAD.
- **Colours:** node colours are 3D-only; the 2D editor is unchanged ("Color by net" later, opt-in).
- **Live values:** only the LED glow in 3D for Sprint 9.

### D-S9-5 Isolated preview on the dev-lab gate

A static build under `/s9-preview/` on the same origin, behind the same oauth2-proxy, from its
own web root (`deploy/dev-lab/s9-preview/`). Same-origin means the existing `/runtime` and
`/build` work unchanged and no CORS or gate rule is weakened; the price is a shared browser
origin, so the preview build gets its own storage namespace (IndexedDB database and
localStorage keys) and a permanent "experimental preview" strip. Both are build-time settings
(`VITE_STORAGE_NAMESPACE`, `VITE_PREVIEW_NAME`); without them a build behaves exactly as before.

## Plan

| Phase | Content |
|---|---|
| A | inspection (above), this record |
| B | connectivity graph (domain) + tests |
| C | schematic: registry, layout, renderer, tab, i18n, tests |
| D | 3D: scene description, models, renderer, lazy loading, fallback, tab, i18n, tests |
| E | integration, examples, Hebrew RTL review, performance and leak measurements |
| F | full regression, documentation, report |

Outcome: see [SPRINT-9.md](SPRINT-9.md). One change from the plan: the Schematic and 3D view
modules are lazy-loaded too (not only three.js), which keeps the startup bundle at +5.7 kB.
