# Sprint 13 — plan: alpha hardening (critical path) and R4 (gated)

**Status: PROPOSED (planning only).**
- Nothing is implemented, merged, tagged or deployed.
- Dev-lab stays at `ba0f4a6` / Runtime v2 pending owner acceptance.
- R4 implementation waits for architecture approval ([SPRINT-13-R4-ARCHITECTURE.md](SPRINT-13-R4-ARCHITECTURE.md)).

**Window.** Mon 12 Oct – Fri 13 Nov (five weeks). The external alpha (five invited testers) is
**Mon 16 Nov** on the POC host:
- 1 vCPU;
- one active runtime session (D-2 ratified);
- Runtime v2 `b5b34b49cb7e4049`, unless R4 clears its gate by 5 Nov.

## 1. Tracks

1. **Alpha hardening, H1–H8: the critical path.** It ships on the validated Runtime v2. Product, documentation and operations only; no runtime change.
2. **R4 (PWM / servo): gated and off the critical path.** It runs in the slack. Hard cut-off: R4-B passed by **5 Nov**, otherwise R4 follows the alpha. PWM stays refused, as it is today.

## 2. Alpha hardening scope

Effort is in working days (P50 / P90).

| # | Item | Content | Acceptance | P50 / P90 |
|---|---|---|---|---|
| H1 | **In-product supported / unsupported capabilities** | One "What runs on the ESP32" panel (EN/HE), generated from the catalog's runtime flags, not hand-written: supported parts and features; refused ones with their reason codes (capacitor, matrix, PWM until R4, libraries, interrupts, ADC, Wi-Fi); the V1 timing contract in plain language (busy core 0 unsupported, µs limits) | Every refusal the builder/host can produce links to an entry; the EN/HE strings are reviewed | 2.5 / 4 |
| H2 | **Component ratings & failure diagnostics** | Extend `engine/ratings.ts` from 4 models + ESP32 pads to every V1 part **with datasheet absolute maximums only** (physics rule): RGB LED, 2N3904 (I_C, V_CEO, P_D), relay coil, the supply ranges of HC-SR04, DHT22, LCD1602/PCF8574, PIR, LDR and buzzer, the PSU current limit. Parts with no published maximum get **no** warning, and say so. Failure diagnostics: each warning explains what a real part would do and how to fix the circuit (EN/HE) | Unit tests per rating with the datasheet citation; examples free of warnings; seeded overstress cases warn | 4 / 6 |
| H3 | **EN/HE acceptance journey** | A scripted end-to-end journey run in both locales: first visit → example → edit → Build → Run → live parameter → Stop → save/reopen → language switch (same project, same result) → refusal case. The deployed-site runner (Gate C `live-s12.mjs`) generalised into a reusable suite, plus a manual checklist for native Hebrew review | Both locales green on dev-lab; the owner signs the HE review | 2 / 3 |
| H4 | **Onboarding for five invited testers** | First-run guide in the product (3 steps, EN/HE); a tester guide (what to try, known limits, how to report); access through the existing gate allowlist (the owner supplies five emails; an allowlist edit only, no new service) | A new user reaches a running example in ≤ 5 min without help (dry run) | 2 / 3 |
| H5 | **POC session queue limitations** | Today a second Run gets `runtime_busy`. Option (a), recommended: clear UX (who is waiting, retry guidance, an in-product "one simulator shared by testers" notice) and tester time slots in the guide. Option (b): a FIFO queue in the Session Host (new behaviour, needs a gate) | (a): the busy state is understandable in EN/HE and a retry succeeds after Stop; the lease expiry is documented | (a) 1.5 / 2.5; (b) 4 / 6 |
| H6 | **Runbook, backup and rollback** | Runbook: deploy (the frontend, services and runtime scripts as used in Gate C), rollback (three scopes), restart, logs, health, disk/memory checks, incident steps. Backup: server state (artifact store, policy, keys, release links), manual and documented, no new persistent service. Tester project data is local-first in the browser: export/import guidance (to verify that export exists). A **restore rehearsal** on staging | Rehearsed restore on staging; rollback commands verified; the owner has the runbook | 2 / 3 |
| H7 | **Internal dry run & feedback collection** | Dry run with the owner (and 1–2 internal users) on dev-lab, using H3 + H4; a zero-cost feedback channel (in-product link to a form or email template; PM to choose); a triage list | Dry-run exit: no P0/P1 open; feedback channel tested | 2 + 2 buffer / 5 |
| H8 | **Sprint 12 closure items C-6, C-7** | C-5 harness on the ratified 5 s / 0.995 criterion; CI on the closure commit | Harness N = 1 PASS by the ratified rule | 1 / 1.5 |
| | **Hardening total** | | | **≈ 19 / 28** |

## 3. R4 track (only after R4-A approval)

| Step | P50 / P90 |
|---|---|
| R4-P probe: 0009 LEDC waveform + routing feasibility, scratch | 2 / 3 |
| 0009 in tree + bridge `W` + negotiation | 4 / 6 |
| Session Host: waveform, servo expansion, A1 two-point solve, refusals | 3 / 5 |
| Builder capability + `ledcFade*` refusal | 0.5 / 1 |
| SG90 product part (catalog, 2D, schematic, 3D, inspector, i18n) + 2 examples | 3.5 / 5 |
| Runtime v3: clean provision, re-baseline (R-MCU-1 50 runs, pins), suites | 2 / 4 |
| R4-B staging, R4-C dev-lab | 1.5 / 2.5 |
| **R4 total** | **≈ 16.5 / 26.5** |

## 4. Schedule, gates and dependencies

| Date | Gate / milestone | Depends on |
|---|---|---|
| 12–13 Oct | **G13-0:** PM approves this plan, the H5 option and the H7 channel; **R4-A** architecture | — |
| 12–16 Oct | H8, H1, H2 sourcing; **R4-P** probe 14–15 Oct → go/no-go 16 Oct | R4-A |
| by 18 Oct | Owner Smoke S11 + S12 (C-1/C-2) → closure PR/merge/tag when approved | owner |
| 19–25 Oct | H2, H5, H4; R4 core (if go) | G13-0 |
| **23 Oct** | **R4 checkpoint:** on track for 5 Nov → continue; else defer R4 after the alpha | R4-P |
| 26 Oct – 1 Nov | H3 journey, H6 runbook + staging restore rehearsal; R4 product part | H1, H2 |
| 2–4 Nov | **R4-B** on staging (if continuing) | R4 complete |
| **5 Nov** | R4 cut-off. **Hardening Gate C** (dev-lab deploy of H1–H5, approval per deploy) | owner acceptance of S12 on dev-lab |
| 6 Nov | **RC freeze** (alpha build = commit + runtime id fixed) | Gate C |
| 9–11 Nov | **Internal dry run** (H7) | RC |
| 11–12 Nov | Fixes (P0/P1 only), re-verify | dry run |
| **12 Nov** | **Alpha go/no-go** (PM) | dry-run exit criteria |
| 13 Nov | Tester emails allowlisted, guide sent | owner |
| **16 Nov** | **External alpha** | — |

Availability: about 24 working days (about 33 calendar days at the seven-day pace of Sprints
11–12). Hardening fits at P50 with about 5 days of buffer; R4 fits only if both tracks stay near
P50. **Expected outcome: R4 follows the alpha with ≈ 60 % likelihood.** That does not affect the
alpha date, because PWM is already refused cleanly.

## 5. Critical-path risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| One implementer across two tracks | H | H | Hardening first; R4 only in slack, with the 23 Oct checkpoint and the 5 Nov cut-off |
| **One runtime session for five testers** (POC capacity) | H | H | H5 UX + tester time slots; the limitation stated in onboarding; D-1 (more capacity) after the alpha |
| Owner availability: smoke, HE review, five emails, dry run | M | H | Dates fixed now (smoke by 18 Oct, dry run 9–11 Nov, emails by 13 Nov) |
| A late runtime change destabilises the validated baseline | M | H | R4 only through R4-B by 5 Nov; else the alpha stays on Runtime v2 |
| Ratings sourcing limited by the physics rule | M | M | Only datasheet maximums; unrated parts say so; no invented limits |
| Build latency under load on 1 vCPU (D-2 "build ≤ 120 s under load" not yet measured on dev-lab) | M | M | Measure during H3/H7; mitigate through the same tester slots |
| Tester project data is local-first (browser storage) | M | M | Export/import guidance in H6 (verify export exists; if not, report it as a gap, not new scope) |
| Dev-lab deploys blocked pending owner acceptance of S12 | M | M | Hardening Gate C is on 5 Nov; work proceeds on staging/local until then |

## 6. Not in Sprint 13

- Production deployment.
- Infrastructure resize or paid services.
- The QEMU per-core redesign.
- The library allowlist (D-3).
- Internal pulls (D-4).
- `attachInterrupt`, ADC, Wi-Fi.
- The matrix in ESP32 projects.
- Capacity beyond one session (D-1).
