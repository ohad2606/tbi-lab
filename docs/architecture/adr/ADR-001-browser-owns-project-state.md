# ADR-001 — Browser owns project state (local-first source of truth)

**Status:** Proposed · **Date:** 2026-09-22 · **Sprint:** 1

## Context
Sprint 0 Gate D proved real IndexedDB persistence with exact restore across page reload and full
browser restart. Sprint 0 B1 puts classic-ESP32 execution on a server. Unless ownership is fixed
now, "the server runs the ESP32" tends to drift into "the server holds the project".

## Decision
- The **Project Document in the browser's IndexedDB is the only source of truth** for project
  content. Firmware artifacts are stored alongside it, content-addressed.
- The simulation service receives only an immutable, derived **Simulation Snapshot**, excluding
  layout, labels and notes. It has **no write path** to project data.
- **Persistent project state and simulation runtime state are separate types.** Runtime values are
  never written into the project; promoting a runtime value (e.g. a PSU setpoint turned during a
  run) is an explicit user action.
- Cloud sync is a future component beside the Project Store, using the revision fields already
  persisted since Gate D. It is not designed here.

## Consequences
- Editing, saving and non-MCU simulation work offline. Losing any simulation session cannot lose
  work.
- Every result is traceable to `(projectId, projectRevision, snapshotId)`.
- Server-side features that would "own" project data (shared server projects, server-side editing)
  need a new ADR.

**Evidence:** `experiments/gate-d-persistence/`; V1-ARCHITECTURE §2.
