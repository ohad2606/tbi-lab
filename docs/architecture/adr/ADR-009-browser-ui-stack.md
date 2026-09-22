# ADR-009 — Browser UI stack: Preact, Vite, inline SVG, in-house localization

**Status:** Accepted (engineering decision, Sprint 2) · **Date:** 2026-09-22 · **Sprint:** 2

## Context
Sprint 2 introduces the first production UI. The roadmap (§7.1) recommends native SVG with no
graphics framework, and names React + Vite as the default application framework, with Preact or
vanilla TypeScript acceptable if justified. The PM direction for Sprint 2 asks for the smallest
maintainable solution that suits schematic interaction, precise terminals and wiring, zoom/pan, RTL
chrome with an LTR canvas, and interaction that will grow more complex later. It also rules out a
heavyweight graphics framework without concrete benefit.

## Decision
- **Preact 10** (MIT) for the application UI, used through the standard hooks API with the automatic
  JSX runtime. It keeps React's component model and ecosystem compatibility (`preact/compat`,
  unused today) at about a tenth of React's size. No framework preset or Babel is involved: Vite's
  built-in transform compiles the JSX.
- **Vite 8** (MIT) as the dev server and bundler, scoped to `app/`. Vitest keeps its own Vite.
- **Inline SVG in the DOM** for the schematic canvas: one `<g>` per component, wires as polylines,
  and one `viewBox` camera. Hit-testing, focus, keyboard access and crisp text come from the DOM.
  The canvas is rendered inside `dir="ltr"` and is never mirrored. **No** canvas/graphics library
  (Konva, PixiJS, fabric.js) and **no** diagram framework (React Flow, JointJS). Our net and
  terminal model is domain-specific, and those frameworks would impose their own.
- **In-house localization:** typed per-locale message bundles (the reference key set is English,
  and every other bundle is typed against it), a locale registry with `dir`, `{param}`
  interpolation, and `Intl` for number and date formatting. Unicode isolates (`LRI`…`PDI`) keep
  technical values LTR inside RTL sentences. Adding a locale means adding a bundle and a registry
  entry.
- **State:** a small framework-independent store (`app/src/state/app.ts`) over pure domain
  operations (`packages/domain`), so all editing logic is unit-testable without a DOM.

## Consequences
- The production bundle measured at Sprint 2 is **69 KB JS (24 KB gzip)** and **7.5 KB CSS**,
  including the domain package.
- Interaction baseline on the 1-core dev host, dragging in a 30-component, 29-wire circuit: median
  33-34 ms and p95 50-69 ms per pointer move (two runs), rendered frame included (the full re-render path is
  exercised on every move). This is recorded as the Sprint 3 budget baseline. SVG is not a
  bottleneck at V1 scale.
- If profiling ever shows SVG to be the bottleneck, the rendering layer can change without touching
  the domain model, which has no knowledge of the view.
- Dependency vetting (roadmap §7.1): Preact and Vite are MIT, actively released, and have no RTL
  behaviour of their own (direction is set by the app on `<html>` and opted out on the canvas).
  Bundle impact was measured, not assumed.

**Evidence:** `app/`, `docs/sprints/SPRINT-2.md` §12, `app/e2e/performance.spec.ts`.
