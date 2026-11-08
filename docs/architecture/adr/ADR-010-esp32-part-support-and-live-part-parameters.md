# ADR-010 — ESP32 part support and live part parameters in the session contract

**Status:** Accepted with conditions (PM, 2026-10-08) · **Date:** 2026-10-08 · **Sprint:** 11 (R1)

## Context

Sprint 10 added eight part models to the shared electrical engine (ADR-008) but refused them in
ESP32 projects with one catalog flag (`mcuRuntime: false`), enforced at placement, at browser Run
and by the Session Host. R1 makes seven of them usable with the ESP32
([SPRINT-11-R1-ARCHITECTURE.md](../../sprints/SPRINT-11-R1-ARCHITECTURE.md)).

Two contract questions arise:
1. **Which parts may run under a board, and who decides.** The engine attaches pads generically
   and would solve any part; the host never steps simulated time (ADR-007 time contract: the MCU
   advances virtual time, the solver gives operating points at events). A time-dependent part (the
   capacitor) solved at DC under a board would be an open circuit — false physics.
2. **Live environment inputs during an ESP32 run.** PIR motion and LDR illuminance are live part
   parameters. The browser already mirrors them as `control.params`; the host's `tbi-lab.session/2`
   mirror validator accepts only the PSU fields and `closed`, so such a mirror is rejected (400).

## Decision

1. **Support is declared once, in the catalog, and enforced by every guard from that one
   declaration.** A part is ESP32-eligible unless its catalog entry says otherwise. The palette, the
   browser Run guard and the host read the same data.
2. **The host also refuses time-dependent circuits from the engine's own property**
   (`EngineSession.timeDependent`), independent of the catalog: no simulated-time stepping exists on
   the host, so no time-dependent part may run there until a separate, approved host time-stepping
   phase.
3. **The mirror command gains an optional, bounded `params` object** within `tbi-lab.session/2`
   (no version bump; additive): 1–8 keys, finite numbers, booleans or short strings, ≤ 512 bytes.
   The host checks part identity, allowed names (the catalog's live parameters for that type),
   value kind and range **when the command arrives** (409 `unsupported_control` / `invalid_value`),
   and the engine checks the same domain rule again when it applies; commands are limited per
   session per second (409 `rate_limited`). Any refusal is explicit, never silent (PM conditions,
   architecture §6.1).
4. **No new bridge frames or emulator changes.** R1 uses the digital pad contract of ADR-007 only.
   ADC, PWM/LEDC, I2C and microsecond input timing remain refused (builder and host) until their own
   phases (R2–R4, ADC) are approved.
5. **Compatibility is a tested matrix, not an assumption** (architecture §6.2): an S10 frontend on
   an S11 host is fully supported; an S11 frontend on an S10 host is not a supported state but fails
   explicitly. **Deployment order is part of the contract:** host before frontend; rollback frontend before
   host. A new frontend never meets an old host in normal operation; if it does, the host refuses
   explicitly (`unsupported_component`, or a command refusal reported as such).

## Consequences

- Seven parts run with the ESP32 with the same engine and values as in local circuits; the
  capacitor stays local-only, by data and by an engine backstop.
- Environment inputs (motion, light) work live in ESP32 runs; the command remains ordered by
  `projectRevision` and applied at the 1 ms tick, so determinism under a given command schedule is
  preserved.
- No runtime id or fingerprint changes; the release gate is extended with a part-model workload
  (ADR-007: every new bridge or peripheral feature extends the gate).
- Old clients are unaffected; a capability-discovery field on `/health` is not needed while
  deployment order holds, and can be added later without breaking this contract.

**Evidence:** `runtime/host/protocol.ts:96-101, 299-318` (today's validator);
`packages/engine/src/session.ts:82-85, 390-402` (engine `params` with `liveParams`);
`runtime/host/session.ts:256-272` (catalog guard, `solve()` only); `app/src/state/app.ts:840-864`
(browser already mirrors params); `docs/runtime/PHASE-R1-DEPLOYMENT-PLAN.md` §3.
