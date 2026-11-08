# Sprint 12 — implementation plan: slices, durations, dependencies, critical path

**Status:** PROPOSED (2026-10-09), awaiting PM review together with
[SPRINT-12-ARCHITECTURE.md](SPRINT-12-ARCHITECTURE.md) and [ADR-011](../architecture/adr/ADR-011-runtime-bridge-v2.md).
Nothing below starts before D-0 approval.

**Duration basis.**
- Working days at the pace observed in Sprints 8–11: seven-day weeks, one implementer, subagents for
  search.
- **P50** = expected; **P90** = pessimistic (a hard QEMU or driver surprise).
- PM gates are assumed to take ≤ 1 day.
- The V1 roadmap's own estimates ran 2–3× above the actual pace on product work. They are close to
  actual pace on QEMU work: R1's patches 0001–0005 took about a week, including the 0005
  determinism blocker. The estimates below reflect that difference.

## Slices

| Slice | Content | Depends on | P50 | P90 | Exit evidence |
|---|---|---|---|---|---|
| **S12-0** | This package | — | done | — | PM review (D-0) |
| **S12-1** | **R3 feasibility probe** (architecture §6): scratch QEMU in `~/tbi-s12-probe`, probe sketches P-1..P-11, report | D-0 | 1.5 | 3 | Go/no-go report with phase logs; PM decision |
| **S12-2** | Bridge v2, host side (TypeScript only): v1+v2 parser, capabilities, `J`/`X`/`F`/`B`/`K`/`D` codecs with strict validation, session plumbing, `requires` in tickets (additive), host checks at `H` | D-0 | 1 | 1.5 | Unit tests T-PROTO-1..9; the v2 host passes the full Sprint 11 suite **on v1 QEMU** (no capabilities) |
| **S12-3** | **Patch 0006**: `H` v2 + capabilities, `J`/`X` queue with a host-sync timer, limits. Scratch provisioning (v2-dev id); **fingerprint continuity** on v1 workloads | S12-2 | 2 | 3 | T-DET-1/2/3, T-PROTO-10..12 (QEMU fail-closed), continuity table |
| **S12-4** | R2 Session Host devices: HC-SR04 and DHT22 drivers (trigger/start detection, solver-derived levels, schedule, budgets, contention); env params on the ADR-010 mirror; T_go per D-7 | S12-3 | 2 | 3.5 | T-R2-1..10 against the engine oracle; T-DET-4/5 |
| **S12-5** | R2 product: `sensor.hc_sr04` and `sensor.dht22` (catalog, palette, 2D, schematic, 3D, i18n EN/HE, env controls), 2 library-free examples, local e2e + opt-in real-QEMU e2e | S12-4 (the catalog part can start during S12-3) | 2.5 | 4 | T-UI-1..6, T-E2E-1/2 |
| **S12-10a** | Release tooling: `switch-runtime.sh` (side-by-side runtime bind, rollback), runtime.json `capabilities`, FU-11-1 (staging system artifacts), FU-11-2 (disk-backed deploy tmp + free-space check) | S12-3 | 1 | 1.5 | T-OPS-1..5 on staging |
| **S12-5c** | **R2 staging checkpoint** (v2-dev runtime with 0006): suites on staging, switch back to v1 | S12-5, S12-10a | 0.5 | 1 | Fallback deliverable: R2 proven on staging even if R3 slips |
| **S12-11** | **C-5 harness** plus an N=1..3 dry run on staging (test-only policy override, restored and verified); minimum-host projection for D-1 | S12-10a | 1 | 1.5 | C-5 report and curve; recommendation (no purchase) |
| **S12-6** | **Patch 0007** pad functions (`F`), host peripheral-owned pad semantics | S12-3; S12-1 = GO | 1.5 | 2.5 | T-R3-1/2, continuity re-check |
| **S12-7** | **Patch 0008**: TMP105 removal, `tbi-i2c-proxy`, controller fixes from the probe | S12-6 | 2 | 5 | T-R3-3..9, P-series promoted to tests |
| **S12-8** | R3 Session Host: `I2cBus` + HD44780/PCF8574 target, electrical gating, `i2c_no_pullup`, address conflict, budgets; build-service capability policy (`Wire` → `requires`) | S12-7 (unit work can start after S12-6) | 2 | 3 | T-R3-10..16, T-SEC-5..7 |
| **S12-9** | R3 product: `display.lcd1602_i2c` (catalog, 2D text, schematic, 3D, i18n), 1–2 examples, e2e | S12-8 | 2.5 | 4 | T-UI-7..10, T-E2E-3/4 |
| **S12-10b** | Runtime v2 final: provision from 0001–0008 (or 0001–0006 on NO-GO), pin new fingerprints, **R-MCU-1** (62 + 30 runs), full runtime suite, **staging Gate B** incl. rollback rehearsal | S12-5, S12-9 | 2 | 3 | Gate B record; Runtime v2 id; rollback timings |
| **S12-12** | Sprint record, evidence, matrix-perf label correction, PM report | all | 0.5 | 0.5 | `SPRINT-12.md` |
| | **Total** | | **≈ 22** | **≈ 36.5** | |

**Not in Sprint 12:**
- dev-lab deployment (Gate C) needs separate approval and is planned for the first days of
  Sprint 13;
- production;
- R4.

## Dependency graph

```
D-0 ─┬─ S12-1 probe ──(GO/NO-GO ≈ 15 Oct)───────────────┐
     └─ S12-2 ── S12-3 (0006) ─┬─ S12-4 ── S12-5 ──┐     │
                               ├─ S12-10a ─────────┼─ S12-5c (R2 on staging ≈ 24 Oct)
                               │                   └─ S12-11 (C-5 curve ≈ 25 Oct → D-1)
                               └─ S12-6 (0007) ◄────────┘ (GO)
                                    └─ S12-7 (0008) ── S12-8 ── S12-9 ──┐
                                                    S12-5 ─────────────┴─ S12-10b Gate B ── S12-12
```

**The R3 chain is the longest path:** S12-2 → S12-3 → S12-6 → S12-7 → S12-8 → S12-9 → S12-10b,
≈ 13 d P50. Total effort (≈ 22 d) exceeds the 19-day window, so **effort, not the chain, sets the
end date.**

## Proposed calendar (P50, assuming D-0 by Mon 12 Oct)

| Dates | Work | Milestone |
|---|---|---|
| Tue 13 – Wed 14 Oct | S12-1 probe; S12-2 | **R3 go/no-go report ≈ 14–15 Oct** |
| Thu 15 – Fri 16 Oct | S12-2 end; S12-3 (0006) | Continuity table for 0006 |
| Sat 17 – Thu 22 Oct | S12-4, S12-5 | R2 feature-complete on the branch |
| Fri 23 – Sat 24 Oct | S12-10a, S12-5c, S12-11 start | **R2 proven on staging ≈ 24 Oct**; C-5 curve ≈ 25 Oct |
| Sun 25 – Tue 27 Oct | S12-6 (0007), S12-7 (0008) | |
| Wed 28 – Sat 31 Oct | S12-8, S12-9 | **R3 feature-complete ≈ 31 Oct–1 Nov** |
| Sun 1 – Tue 3 Nov | S12-10b, S12-12 | **Runtime v2 Gate B on staging ≈ 2–3 Nov** |

## Meeting 31 October

| Outcome by 31 Oct | Confidence |
|---|---|
| R3 go/no-go decided | Very high (about 15 Oct) |
| R2 complete and proven on staging | High |
| C-5 curve on this host and minimum-host recommendation | High |
| R3 feature-complete on the branch | About 55 % |
| Runtime v2 (R2+R3) through staging Gate B | **About 45–50 %**; P50 2–3 Nov, P90 about 13 Nov |

**Options to pull Gate B to 31 October (PM choice):**
1. Run product-side part work (S12-5 and S12-9 catalog, 2D/3D, i18n) in **parallel background
   agents** while QEMU slices run. Saves about 2–3 days; every agent's output is still reviewed
   and tested before it lands.
2. Ship the I2C LCD in 3D as a body with 2D-rendered text first (a visible, documented fallback).
3. Accept R2-only Runtime v2 at 31 October, with R3 as a second runtime drop in Sprint 13. This
   costs one extra re-baseline (≈ 1 day) and lowers the risk.

## Toward 30 November (context; Sprints 13–14 are not authorised)

| Window | Proposed content |
|---|---|
| Sprint 13 (≈ 2–14 Nov) | Runtime v2 Gate B close-out; dev-lab Gate C (approval); C-5 on alpha hardware (needs D-1 by about 30 Oct); D-3 library allowlist if approved; any R3 tail; **feature freeze 14 Nov** |
| Sprint 14 (≈ 16–27 Nov) | Release hardening: external allowlist and onboarding, §19 acceptance journey EN/HE, in-product unsupported list, GPIO 4/16/27 verification, projector legibility (owner), runbook, backup and rollback, feedback channel, soak, internal dry run; RC about 25 Nov |
| 30 Nov | External five-person alpha (planning target) |

The 30 November target holds only if **D-1 (capacity) is decided by about 30 October**. It is the
single item that engineering cannot pull forward.
