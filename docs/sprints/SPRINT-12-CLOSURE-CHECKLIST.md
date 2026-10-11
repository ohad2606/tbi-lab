# Sprint 12 — closure checklist

Status 2026-10-11: Gate B and Gate C accepted; dev-lab serves `ba0f4a6` on Runtime v2. Sprint 12
stays **open** until owner acceptance and the formal closure steps. Items marked **owner** or **PM**
need that person; nothing here merges, tags or redeploys without the approval named.

| # | Item | Owner | State |
|---|---|---|---|
| C-1 | Owner Smoke on dev-lab: the checklist in `SPRINT-12-GATE-C.md` (S12 examples, S11 examples, Hebrew, second-user refusal, refused parts) | owner | **open** |
| C-2 | Sprint 11 Owner Smoke and closure. Sprint 12 branched from Sprint 11, so S11 closes first or both together (PM to choose) | owner, PM | **open** |
| C-3 | Records complete: SPRINT-12.md (decisions D-2..D-10 as applied), GATE-B, GATE-C, G-2 rounds, `runtime/RUNTIME-V2-LIMITATIONS.md` | eng | done (verify on closure) |
| C-4 | Accepted limitations recorded with their regression tests (F-R2-1a–f, F-R2-2) | eng | done |
| C-5 | D-2 ratified (≥ 0.995× p5 over 5 s windows, one session on the POC host) | PM | done (recorded) |
| C-6 | C-5 harness: evaluate the ratified criterion (5 s windows, 0.995), keep the 1 s statistics as information; one N = 1 run | eng | open (≈ 0.5 d, test-only) |
| C-7 | Full CI on the closure commit: unit, typecheck, lint, e2e (CI); runtime suites as in Gate B (already green on `ba0f4a6`) | eng | open |
| C-8 | PR `sprint-12` → `main` with the record; CI green on the PR | eng, then PM | open (needs approval to open/merge) |
| C-9 | Fast-forward `main`; annotated tag `sprint-12-complete` | PM approval | open (**not authorized yet**) |
| C-10 | Housekeeping: staging stays installed (tbi-s8 on Runtime v2) as the Sprint 13 rehearsal target; scratch dirs `~/tbi-s12-rel/{g*,gb,gc}` kept until closure, then archived | eng | open |
| C-11 | Carry-forward list into Sprint 13 (below) | eng | done |

**Carried forward** (not Sprint 12 defects):
- R4 (PWM / servo, the A1 electrical decision).
- Internal pulls (D-4); library allowlist (D-3); I2C bus-duration timing; `attachInterrupt`; the matrix in ESP32 projects.
- The QEMU per-core scheduling redesign (F-R2-1; declined for V1).
- TI-S12-1 (an S12 frontend on an S11 host: `invalid_attachment` instead of `unsupported_component`; moot once both are deployed together).
- Capacity beyond one session (D-1).
