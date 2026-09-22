# ADR-008 — One electrical engine, two hosts

**Status:** Proposed · **Date:** 2026-09-22 · **Sprint:** 1

## Context
Mode A needs the solver in a browser Worker. Mode B needs it next to QEMU on the server (ADR-004). Two
implementations would inevitably drift apart, and "the same circuit gives different answers
depending on whether it contains an ESP32" is unacceptable under the physics rule.

## Decision
- The Gate A solver and the Gate C pin model are **promoted, not rewritten**, into one Electrical
  Engine package: pure TypeScript, with no I/O, timers, DOM or locale.
- Two thin hosts run **the same built artifact**, identified by one `engineVersion`:
  **A** = browser Web Worker adapter, **B** = Session Host (plus the MCU bridge).
- API: `compile(snapshot) -> CompiledCircuit`, `solve(pinStates, controls) -> SolveResult`. Errors are
  structured (`SingularMatrix`, `Convergence` including residual-verification rejection,
  `UnsupportedComponent`, `InvalidTopology`) and never yield partial results.
- A CI test asserts **bit-identical results in Node and a browser Worker** across the reference
  suite. Gate A already demonstrates this for the LED case.
- Transient simulation later extends the model contract with per-model state (`step(dt, state)`).
  It is not implemented in V1; AC is out of scope.

## Consequences
- Physics fixes land once and apply to both modes.
- The engine must stay free of platform APIs, which is already true of the Gate A code.

**Evidence:** Gate A (browser bit-identical to Node); Gate C bridge; V1-ARCHITECTURE §8.
