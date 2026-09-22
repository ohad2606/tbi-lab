# Sprint 0 — Errata

Corrections to the Sprint 0 record discovered after the sprint closed. The Sprint 0 documents and
the `sprint-0-complete` tag are **left unchanged**. This file qualifies them.

---

## E-1 — Gate C: "event-driven and deterministic" overstated what was proven

**Recorded:** 2026-09-22, Sprint 1 architecture closure.

**Where the wording appears** (at tag `sprint-0-complete`):

- `experiments/gate-c-bridge/README.md` (Timing and synchronisation): *"Semantics are
  event-driven and deterministic, not real-time"*
- `docs/sprints/SPRINT-0.md` §6.1: *"Semantics are event-driven and deterministic; Sprint 0 makes
  no real-time claim."*

**What Sprint 0 Gate C actually proved** — and this still stands:

- Bidirectional MCU <-> electrical exchange on the real classic-ESP32 runtime (all six required
  integration cases).
- Electrical behaviour that is not hardcoded: expected values came from an independent solver,
  and changing a component the firmware knew nothing about changed the result accordingly.
- **The electrical solver result is deterministic.** It is a pure function of circuit, pin states
  and controls, and bit-identical between Node and a browser Worker (Gate A).

**What it did not prove:**

- **The integrated MCU timeline was not deterministic.** The Sprint 0 bridge ran QEMU on host
  wall-clock time, and applied electrical responses asynchronously while the guest kept executing.
  When Sprint 1 repeated the same firmware in that real-time configuration, the GPIO event
  timelines **diverged by up to 9.48 s** between runs
  (`docs/research/sprint-1-simulation-time.md`, Result 1).
- "Event-driven" was accurate: every GPIO transition triggered a solve and an injection.
  "Deterministic" was accurate only for the electrical calculation, not for *when* events occurred
  or when responses reached the firmware.

**Effect on the verdict:** none. Gate C's PASS criteria were bidirectional exchange with non-hardcoded,
solver-derived behaviour on the real runtime. Those were met. This erratum **qualifies the wording**;
it does not invalidate the PASS.

**Follow-up:** deterministic closed-loop behaviour is now an explicit V1 release requirement for ESP32
simulation (V1-ARCHITECTURE §7, ADR-007), with an automated repeatability test.

---

## E-2 — Gate B/C harnesses attach the firmware image writable

**Recorded:** 2026-09-22, Sprint 1 architecture closure.

**Finding.** `experiments/gate-c-bridge/src/qemuRuntime.ts` and `experiments/gate-b-esp32/gpio_probe.py`
pass the firmware artifact to QEMU as a writable `-drive … if=mtd`. The guest can write its flash.
During Sprint 1, the Arduino GPIO proof image was found modified: its coredump partition had been
written by some run that panicked. As a result, its sha256 no longer matched the recorded
`d069fffc…cdd44`.

**Effect on Sprint 0 verdicts:** none. Gate B/C criteria were functional (boot, GPIO in both
directions, solver-derived levels). No Sprint 0 claim depends on boot time or on flash contents.
What the modified image did affect was Sprint 1's absolute boot-time figures; see
`docs/research/sprint-1-simulation-time.md` C0.

**Follow-up.** The image was restored from the build output (hash verified). The Sprint 1 closed-loop
harness boots each run from a scratch copy, as V1-ARCHITECTURE §11 requires. The Sprint 0 harnesses
are left unchanged as a record. Converting them is backlog.
