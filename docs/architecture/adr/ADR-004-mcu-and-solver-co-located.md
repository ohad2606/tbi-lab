# ADR-004 — MCU runtime and electrical solver are co-located

**Status:** Proposed · **Date:** 2026-09-22 · **Sprint:** 1

## Context
Gate C closed the MCU <-> electrical loop on one host: firmware write -> host observation < 1 ms,
electrical change -> solve -> injection 3 ms. Splitting that loop across a WAN (server QEMU <-> browser
solver) would put WAN round trips (typically tens to hundreds of milliseconds) inside every GPIO transition and make electrical behaviour
depend on network conditions.

## Decision
For Mode B, **QEMU, the MCU <-> electrical bridge and an Electrical Engine instance run together in one
Session Host** on the server. The browser <-> session WebSocket carries only commands, snapshots,
firmware, and **throttled observation frames** (latest values plus aggregate counters, ≤ ~20 Hz
wall-clock). It never carries per-GPIO-transition traffic or solver internals.

## Consequences
- Network latency and loss affect *display* and *control latency* only, never electrical results.
- The engine must run server-side as well as in the browser, which ADR-008 guarantees.
- Disconnects pause the session rather than corrupting it (V1-ARCHITECTURE §5, §13).

**Evidence:** Gate C timings; V1-ARCHITECTURE §4.2, §6.5, §7.
