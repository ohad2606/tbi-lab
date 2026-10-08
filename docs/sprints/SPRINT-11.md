# Sprint 11 — R1: the Sprint 10 parts in ESP32 projects

**Status (2026-10-08):** in progress on `sprint-11` (worktree `~/projects/tbi-lab-s11`), from
`465b330` = `main` = `sprint-10-complete`. **dev-lab unchanged:** frontend `7da5c8b`, runtime
`80448f9`. Slices 0–6 authorised (PM, 2026-10-08); deployment (slice 7) **not** authorised.

Documents: [architecture](SPRINT-11-R1-ARCHITECTURE.md) (approved with conditions, §6) ·
[implementation plan](SPRINT-11-IMPLEMENTATION-PLAN.md) · [test matrix](SPRINT-11-TEST-MATRIX.md) ·
[ADR-010](../architecture/adr/ADR-010-esp32-part-support-and-live-part-parameters.md).

## Part A — architecture approved with conditions (PM, 2026-10-08)

Approved: bounded live-parameter commands (PIR, LDR); LDR digital threshold only (ADC tracked as
separate V1 work); static 8×8 matrix patterns conditional on measured performance; two curated,
tested ESP32 examples; ESP32 voltage and output-current warnings; one controlled deployment sequence
after implementation and validation. Mandatory conditions (architecture §6): matrix performance
measured (p50/p95/p99, CPU, solve frequency, impact on other sessions); protocol safety (identity,
names, ranges, payload size, ownership, frequency); a tested frontend–host compatibility matrix with
forward deployment and rollback; warnings that never alter results and stay distinct from
unsupported states; the GPIO32/33 documentation contradiction reconciled.

## Part B — GPIO32/33 documentation correction (2026-10-08)

The scope document still called GPIO32/33 outputs (blocker B6) an open pre-release item. Runtime
evidence says it is closed: `docs/runtime/R1-REPORT.md` gates R1-A3/R1-A4 "Met", and on 2026-10-08
`runtime/tests/banks.runtime.test.ts` passed **10/10** on the deployed runtime id
`33e35e4ac5e798d7` (GPIO32/33 driven HIGH and LOW in firmware order, the same electrical result as
bank 0, two-way loops across banks). The living scope document carries a dated correction; the
closed Sprint 10 records are left unchanged.
