# Architecture Decision Records

Short, durable records of decisions that should outlive any particular implementation. The
authoritative narrative is `../V1-ARCHITECTURE.md`; each ADR states the decision and why, and points
at the evidence.

| ADR | Title | Status |
|---|---|---|
| [001](ADR-001-browser-owns-project-state.md) | Browser owns project state (local-first source of truth) | Proposed |
| [002](ADR-002-dual-simulation-execution-model.md) | Dual simulation execution model | Proposed |
| [003](ADR-003-esp32-runtime-hybrid-server.md) | Classic ESP32 runtime is hybrid/server for V1 | Accepted (PM, Sprint 0 B1) |
| [004](ADR-004-mcu-and-solver-co-located.md) | MCU runtime and electrical solver are co-located | Proposed |
| [005](ADR-005-language-independent-project-data.md) | Language-independent project data model | Proposed |
| [006](ADR-006-qemu-licensing-runtime-boundary.md) | QEMU licensing and runtime boundary | Accepted (PM, Sprint 0 B2) |
| [007](ADR-007-simulation-time-contract.md) | Simulation time contract | Proposed — needs PM input (P1, P3) |
| [008](ADR-008-one-electrical-engine-two-hosts.md) | One electrical engine, two hosts | Proposed |

Status values: **Proposed** (awaiting PM review), **Accepted**, **Superseded by ADR-NNN**.
