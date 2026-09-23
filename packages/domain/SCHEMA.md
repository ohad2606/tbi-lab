# Project schema v2 — core (FROZEN at Sprint 2)

**Status:** frozen at the end of Sprint 2 (roadmap RC-1). Sprint 2 is the first sprint that persists
real user projects, so this model is not disposable.

**Change rule from Sprint 3 on:** additive or backward-compatible changes where possible. Any change
to persistence semantics needs an explicit migration (`src/migrate.ts`, `vN -> vN+1`) and a test.
Sprint 3 may **extend** the schema for the electrical engine (for example compile metadata). It may
not replace the persisted Sprint 2 model.

Reference: roadmap §6.1, architecture §3 and ADR-005. Types: `src/schema.ts`. Validation:
`src/validate.ts`.

## Document

```jsonc
{
  "format": "tbi-lab.project", // document marker
  "schemaVersion": 2, // integer; a NEWER version opens read-only
  "projectId": "prj_3f9c…", // language-neutral identity, no locale
  "createdWith": { "app": "0.1.0", "schemaVersion": 2 },
  "createdAt": "2026-09-22T12:00:00.000Z",
  "revision": {
    // carried from the proven Gate D shape
    "localRevision": 7, // +1 on every persisted local change
    "cloudRevision": null, // V1: always null, nothing acts on it
    "baseRevision": null, // V1: always null, nothing acts on it
    "updatedAt": "2026-09-22T12:03:10.000Z",
    "deviceId": "dev_…",
  },
  "name": "מחלק מתח", // user-authored, verbatim, never translated
  "components": [
    {
      "id": "PSU1",
      "type": "instrument.lab_psu",
      "typeVersion": 1,
      "params": {
        "setpointVoltage": { "value": 5, "unit": "volt" },
        "currentLimit": { "value": 0.1, "unit": "ampere" },
        "outputEnabled": false,
      },
    },
    { "id": "GND1", "type": "component.ground", "typeVersion": 1, "params": {} },
    {
      "id": "R1",
      "type": "component.resistor",
      "typeVersion": 1,
      "params": { "resistance": { "value": 4700, "unit": "ohm" } },
    },
  ],
  "nets": [
    { "id": "N_1", "role": null, "userName": null },
    { "id": "N_2", "role": "ground", "userName": "קו אדמה" },
  ],
  "connections": [
    { "component": "PSU1", "terminal": "positive", "net": "N_1" },
    { "component": "PSU1", "terminal": "negative", "net": "N_2" },
    { "component": "GND1", "terminal": "ref", "net": "N_2" },
    { "component": "R1", "terminal": "a", "net": "N_1" },
  ],
  "layout": {
    "components": { "PSU1": { "x": -120, "y": 0, "rotation": 0 }, "…": {} },
    "wires": [
      {
        "id": "W1",
        "from": { "kind": "terminal", "component": "PSU1", "terminal": "positive" },
        "to": { "kind": "junction", "junction": "J1" },
        "vertices": [],
      },
    ],
    "junctions": [{ "id": "J1", "x": -60, "y": -20 }],
  },
  "idCounters": { "PSU": 1, "GND": 1, "R": 3, "W": 4, "J": 1, "N": 2 },
}
```

## Core concepts and their rules

| Concept                     | Field(s)                               | Rule                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project identity            | `projectId`                            | `prj_` + opaque alphanumerics. Contains no locale. One project opens under every locale                                                                                                                                          |
| Schema version              | `schemaVersion`, `format`              | Integer. Older versions are migrated on open through the registry (none exist yet). A **newer** version is never guessed at: it opens read-only if its core still validates, otherwise the app reports that it cannot display it |
| Component instance identity | `components[].id`                      | Reference designator `<prefix><n>` (`R1`, `PSU1`, `GND1`). Unique per project. **Never reused** after delete, enforced by `idCounters`                                                                                           |
| Component type ids          | `components[].type`, `typeVersion`     | Namespaced, language-neutral (`component.resistor`). `typeVersion` lets one type evolve without a whole-project migration. Unknown types are rejected, never approximated                                                        |
| Terminals                   | catalog `terminals[].id`               | Language-neutral per type: `positive`/`negative` (PSU), `ref` (ground), `a`/`b` (resistor, push button, toggle switch), `anode`/`cathode` (LED, diode). Later: MCU header ids                                                    |
| Engineering values          | `params.<key>`                         | `{ value, unit }`: an SI number plus a canonical unit id (`ohm`, `volt`, `ampere`). Locale affects display only. Values are range-checked against the catalog                                                                    |
| Nets                        | `nets[]`                               | Opaque stable ids `N_<n>`. `role` is `"ground"` exactly when the net contains a ground reference terminal. `userName` is user-authored and verbatim                                                                              |
| Connections                 | `connections[]`                        | One record per wired terminal: `{component, terminal, net}`. A terminal belongs to at most one net. Kept in canonical order (component order, then terminal order)                                                               |
| Wires and junctions         | `layout.wires[]`, `layout.junctions[]` | Wires attach to a terminal or a junction **by reference**. Geometry never creates a connection: wires that cross without a shared junction are not connected. A junction exists only where three or more wire ends meet          |
| Position / rotation         | `layout.components`                    | Integer schematic units on a 20-unit grid, `rotation` in `{0, 90, 180, 270}`, clockwise                                                                                                                                          |
| Revision metadata           | `revision`                             | The Gate D fields, unchanged. `localRevision` advances on every persisted change                                                                                                                                                 |

### Netlist derivation

`nets` + `connections` are the canonical netlist, which is what a simulation snapshot reads. The
layout (including wires) is excluded from snapshots (architecture §2.3). The netlist is re-derived
from the wire graph after every edit (`src/nets.ts`), and the validator checks that it matches the
graph exactly. Net ids stay stable across edits: a merge keeps the majority id, a split gives the
larger part the old id and the rest a fresh one, and user net names travel with their net.

Because connectivity lives in explicit references rather than geometry, a later breadboard view
(PM-1, deferred) can derive the same netlist from a different drawing without changing this model.

### Additive changes after the freeze

| Sprint | Change                                                                                                                                                                                                           | Compatibility                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 3      | New type `component.led` (typeVersion 1): terminals `anode`, `cathode`; parameter `model`, a curated enum token (`model.led.vishay_tlhr5400`)                                                                    | Additive; `schemaVersion` stays 2                 |
| 3      | New parameter kind: language-neutral enum token (`ParamValue` gains `string`)                                                                                                                                    | Additive; existing parameters unchanged           |
| 3      | Catalog metadata `live: true` on the PSU's `setpointVoltage`, `currentLimit`, `outputEnabled` (may change while running)                                                                                         | Catalog only, nothing persisted                   |
| 3      | `createSnapshot(doc)`: derived, layout-free simulation input; never stored                                                                                                                                       | No persisted change                               |
| 4      | New type `component.diode` (typeVersion 1, refs `D<n>` shared with the LED): terminals `anode`, `cathode`; parameter `model`, curated enum token `model.diode.vishay_1n4148`                                     | Additive; `schemaVersion` stays 2                 |
| 4      | New type `component.push_button` (typeVersion 1, refs `SW<n>`): terminals `a`, `b`; **no parameters**. Catalog metadata `momentary: true`. Its pressed state is runtime-only and is never persisted              | Additive; nothing persisted for the pressed state |
| 4      | New type `component.toggle_switch` (typeVersion 1, refs `SW<n>`, shared counter with the button): terminals `a`, `b`; boolean parameter `closed` (default `false`, `live: true`), the persistent switch position | Additive                                          |
| 4      | Undo/redo: session-only, never persisted. An undo or redo commits a normal new revision (`localRevision` still only increases) and never lowers an `idCounters` entry                                            | No persisted change                               |
| 4      | Probes and circuit checks: presentation/derived state, never stored                                                                                                                                              | No persisted change                               |

### Sprint 5: no schema change

Sprint 5 adds **no** field to the project document and does not change `schemaVersion`.

- **Portable package.** A separate, independently versioned envelope wraps the unchanged
  document (`PACKAGE.md`).
- **Library metadata.** The recent-project index (name, last change) remains a separate
  IndexedDB store derived from each document. Deleting a project removes both in one
  transaction.
- **Duplicate, import-as-copy and example instantiation.** All use `copyAsNewProject`: a new
  `projectId`, `createdAt` and `createdWith`, and `revision` restarted at 1. The engineering
  content and user text are copied exactly; id counters are copied, so references continue
  from the source's numbering.

### Excluded by design

These are not part of the project document: simulation results, runtime state (CV/CC mode, currents,
pin levels, push-button pressed state), undo/redo history, probes, view state (zoom, pan, selection) and UI locale. Also excluded until their approved
sprints: MCU/firmware fields and `runConfig` (Sprint 6, additive), annotations/notes, and the export
package format (Sprint 5).
