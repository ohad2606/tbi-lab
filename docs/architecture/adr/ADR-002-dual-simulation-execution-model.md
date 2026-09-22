# ADR-002 — Dual simulation execution model

**Status:** Proposed · **Date:** 2026-09-22 · **Sprint:** 1

## Context
Gate A proved the DC solver runs in a browser Web Worker at 0.07-0.09 ms per nonlinear solve with
the main thread unblocked. The classic ESP32 cannot run usefully in the browser (Sprint 0 Phase 5),
and V1 runs it server-side (ADR-003).

## Decision
- **Mode A — browser-local.** Projects without an MCU are simulated entirely in a Web Worker. No
  server is involved.
- **Mode B — hybrid.** Projects containing an `mcu.esp32_classic` instance are simulated in a
  server session (ADR-004).
- The mode is **derived from the snapshot**, never stored as a preference.
- **An MCU in the circuit always means Mode B**, even without firmware: an unprogrammed ESP32 is not
  electrically absent, and treating its pins as open circuits would invent behaviour. To simulate
  without it, the user removes it.

## Consequences
- The most common beginner circuits need no connectivity and cost nothing to host.
- MCU projects need a connection. The UI must state this plainly and keep editing available offline.
- Both modes share one engine (ADR-008), so moving a circuit between modes cannot change its
  physics.

**Evidence:** Gate A browser proof; Sprint 0 Phase 5; V1-ARCHITECTURE §4.
