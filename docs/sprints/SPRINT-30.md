# Sprint 30 — Dynamic Engineering Systems & MCU-Time Co-Simulation (DEV)

Branch `sprint-30` from `829f38b` (Sprint 29 docs head; deployed code `bf05304`). Target: DEV only
(tbi-lab-srv). Runtime unchanged: Runtime v5 `39f2229a66d45e43`, the S26 MicroPython home. The AI
provider service is unchanged and inactive. Alpha, RC5 and production untouched.

## 0. Baseline

Verified before any change:
- host `tbi-lab-srv`;
- `sprint-29` = `origin/sprint-29` = `829f38b`;
- DEV-Lab and staging served `bf05304` on Runtime v5 `39f2229a66d45e43`;
- rollback target `f0960cc` (S28) rehearsed in Sprint 29;
- pipeline lock free, then held by this session.

New worktree `~/projects/tbi-lab-s30`; evidence in `~/tbi-s30/evidence`. During the sprint a second,
orphaned process of this conversation was found. With the owner's approval it was to be stopped by
PID; it had already exited. The lock was taken over by the live process.

## 1. Owner decisions (this sprint)

| Id | Decision | Effect |
|---|---|---|
| **S30-L1** | **Light-load pad envelope.** The ESP32 Table 5-3 pad band (V_OH ≥ 0.8 × VDD, V_OL ≤ 0.1 × VDD — stated with **no** test current; the 40 mA / 28 mA drive figures are typical) is relied on while the pad carries at most **100 µA**: the JEDEC LVCMOS / TI "CMOS load" test current (TI's light-load V_OH row is at I_OH = −100 µA), 1/400 of the typical drive, 1/290 of the multi-pin ~29 mA. Above it: refused by name (`logic_mcu_output_uncharacterized`). An engineering assumption (provenance `ESP32_PAD_LIGHT_LOAD_A`), replacing Q7 (leakage-level only). | An ESP32 output can drive a logic input with a 33 kΩ … 119 kΩ pull-down. |
| **S30-A4** | **Above V_CC up to the I_CC test voltage.** For parts whose I_CC row is tested at "V_I = 5.5 V or GND" (SN74LVC1G00/02/08/32) an input between V_CC and 5.5 V is in the bounded high zone (counted with its ΔI_CC). Basis: overvoltage-tolerant inputs (no clamp to V_CC; V_I 0 … 5.5 V at any V_CC); above V_CC the input PMOS is off (V_GS > 0). Parts tested at "V_CC or GND" (1G86, 08A) keep S29-D3. Provenance `ABOVE_VCC_TO_ICC_TEST_V`. | The ESP32's HIGH band (2.64–3.3 V) is bounded at a gate V_CC of 3.0 V. |

Why both were needed (evidence `~/tbi-s30/evidence/M1-feasibility.md`; ESP32 datasheet v5.3 is still the current release, byte-identical to the Sprint 22 copy):
1. **Q7 alone rules out any defined boot level.** Before `setup()` the pad is an input, so the gate input needs a resistor to a rail. To keep the input within 0.6 V of GND against the input leakage (I_I ±5 µA + 50 nA), the resistor must be ≤ 119 kΩ. To keep the pad at leakage-level current when it drives HIGH (Q7), it must be ≥ 653 kΩ. Both cannot hold, for any resistive network.
2. **The band does not fit S29-D1/D3.** The ESP32 HIGH band is 0.66 V wide; the bounded band is 0.6 V wide (D1) and ends at V_CC (D3). No V_CC contains it.

## 2. M1 — ESP32 driving logic

Engine (`packages/engine/src/logic`):
- `bounds.ts`: `ESP32_PAD_LIGHT_LOAD_A`; the padLoad check limit is `max(100 µA, node leakage)`.
- `lvc1g.ts`: `highBandTop` (S30-A4) in `iccZones`; the corner zone checks extend to 5.5 V + 1 mV for those parts.
- EN/HE refusal text and provenance rows.

Verified (logic-s30, 1G08 at 3.0 V, GPIO18 → A with a pull-down, B at V_CC, Y → GPIO19):

| Pull-down | Boot (pad input) | GPIO18 LOW | GPIO18 HIGH |
|---|---|---|---|
| 47 kΩ, 100 kΩ | LOW | LOW, read LOW | HIGH, GPIO19 ≥ 2.9 V |
| 22 kΩ | LOW | LOW | refused: 3.3 V / 22 kΩ ≈ 150 µA > 100 µA (`limit` 100 µA in the detail) |
| 200 kΩ | refused: the leakage lifts A to ≈ 1 V | — | — |

Still refused:
- the same gate at 3.3 V (the ESP32 HIGH from 2.64 V is 60 mV below V_CC − 0.6 V);
- the 1G86 above V_CC (D3 kept);
- any LED-loaded gate output that the ESP32 reads back (V_OH ≥ 2.4 V at the 16 mA point, below V_IH 2.475 V).

Changed expectations, each tied to a decision:
- GPIO18 LOW into a 10 kΩ pull-down (38 µA) now runs in esp32-logic-and and -override; in -quad-and it passes the pad check and is then refused, as before, by Q1 (the 08A's I_CC only at 3.6 V); driven HIGH (330 µA) it stays refused;
- 3.3 V through 1 kΩ (PIR) into a gate at 3.0 V now runs (A4);
- the S29 review case M3 (3.8 V through 10 kΩ into a 1G08 at 3.3 V) now runs; the same input into the 1G86 stays refused, and so does anything above 5.5 V.

## 3. M2 + M4 — feedback and the integrated project

The examples `esp32-logic-feedback` (Arduino) and `mpy-logic-feedback` (MicroPython) are verified twins with one circuit:
- **Logic stage (3.0 V):**
  - GPIO18 (REQUEST) drives U2 (1G08) input A, with a 100 kΩ pull-down;
  - the PERMIT switch drives input B, with a 10 kΩ pull-down;
  - U2.Y feeds GPIO4 (the firmware's feedback) and U3.A; U3 is a second 1G08 used as a driver, with B at V_CC.
- **Power stage (5 V):** U3.Y → 1 kΩ → 2N3904 → SRD-05 relay on its own supply (1N4148 across the coil). The relay's NO contact grounds the LED (330 Ω from 5 V).
- U2.Y carries only leakage, so its light-load row holds (V_OH ≥ 2.9 V).
- The firmware raises the request, reads the gate right after and decides GRANTED or DENIED, then drops the request and checks for "released". It loops forever.

Evidence:
- **Engine** (s30-examples, logic-s30): in every GPIO18 mode and PERMIT position, U2/U3 = request · permit; GPIO4 reads ≥ 2.9 V or ≤ 0.1 V; the relay and the LED follow. The "Try" edits (22 kΩ, 200 kΩ) are refused by name.
- **Real QEMU** (s30-cosim, both languages, two runs each):
  - repeated transitions, with GRANTED, DENIED and released all printed;
  - every printed FB equals the level the circuit gave at that write;
  - DENIED exactly while the permit is open.
- **Browser:**
  - s30-logic-feedback e2e: library, own program plus twin, the 100 kΩ, EN/HE, PERMIT persists across save/reopen;
  - kit spec `s30-real` (staging and DEV-Lab): Build, Run, GRANTED, the relay on the canvas, PERMIT → DENIED, 3D, persistence, EN/HE.

## 4. M3 — MCU-time co-simulation: the timing contract

Architecture as found (verified in code; `~/tbi-s30/evidence/M3-timing-architecture.md`):
- **Clock ownership.** QEMU's virtual clock under `-icount shift=3,sleep=off` is the **only** clock. The host never advances time. Every bridge frame carries `<vns>` = `QEMU_CLOCK_VIRTUAL` in ns, as decimal ASCII, parsed to `bigint`; time going backwards is rejected. Host events carry `simNs` as a decimal string.
- **Units and representation.** Integer nanoseconds of virtual time (`bigint` in the host, decimal string on the wire and in events). There is no floating time and no wall clock.
- **GPIO output path.** A guest pad change sends `G <vns> <pad> <drive> <level>` over a blocking socket. The guest waits under the BQL until the host answers `C`. The host sets the pad mode, solves the DC operating point and, in the same reply, sends `I <pad> <level>` for every input whose level changed. **The firmware's next read sees the circuit's response at the same vns.**
- **Input reads.** A read returns the level cached in the GPIO model and does not block. A pad with no defined level (floating, or between V_IL and V_IH) is marked `Z`; reading it ends the run by name (`gpio_input_undefined`).
- **External changes.** Mirror and transient commands with `atSimNs` apply at the first command tick at or after that time (tick = 1 ms of virtual time). Commands without `atSimNs` apply at the next tick after their wall-clock arrival, which is **not** deterministic and is documented as such.
- **Scheduled inputs** (`J <vns> <pad> <level>`): strictly later than the frame they answer, at least 1 µs apart per pad, at most 512 queued; entries due at the same vns apply in arrival order.

Ordering rules and invariants:
1. One total order: QEMU's virtual time, and within one vns the order of the bridge frames.
2. Within a reply, commands apply in the order sent, before `C`. A response is never earlier than its cause, and a `J` is never at its trigger's vns.
3. A guest-caused circuit change has 0 ns virtual latency. An external change has at most 1 tick (1 ms) of latency, deterministic when it carries `atSimNs`.
4. The solve is DC and instantaneous. Gate propagation delay (t_pd, a few ns) is carried for display and is **not simulated**: below one instruction, a delayed read-back would be an invented delay.
5. Wall-clock time enters only pacing (holding QEMU, which is blocked) and watchdogs (stall 10 s, wall 240 s). It never enters a solve or an injected level.
6. Failure: if the host does not answer, QEMU stays blocked until the stall or wall watchdog kills the session. A lost bridge exits 4, a malformed reply exits 3 (`bridge_lost` / `runtime_protocol_error`).

Bounded POC (this sprint): `HostConfig.timingTraceCapacity`, a per-session trace that is:
- host-internal, off by default, never on the wire;
- made of `pad`, `control` and `solve` entries stamped with vns; the solve's wall time is a measurement only, excluded from fingerprints.

Measured on real QEMU (s30-cosim; evidence `~/tbi-s30/evidence/s30-cosim-*.json`):

| | Arduino | MicroPython |
|---|---|---|
| Virtual latency, write → circuit response visible to the firmware | 0 ns (the same vns), every write — by construction of the blocking exchange; evidenced by every printed FB equalling the level injected at that write | 0 ns |
| Scheduled toggle error (applied vns − atSimNs; times on 1 ms ticks) | 0 ns, 0 ns | 0 ns, 0 ns |
| Fingerprint (virtual trace to 6 s), two runs | `1849ef616934e1ac` = | `8d6dbbf617fe43ef` = |
| Transcript to 6 s, two runs | identical | identical |
| Host solve cost per edge (wall, QEMU blocked) | p50 20.3 ms, max 49.9 ms (18 solves) | p50 10.7 ms, max 21.4 ms (17 solves) |

Supported timing resolution and limits:
- Guest-caused changes are exact in virtual time, to 1 ns.
- External changes land on 1 ms ticks.
- Scheduled inputs are at least 1 µs apart per pad.
- No sub-microsecond analog timing is claimed. Nothing time-dependent is solved under an MCU: capacitors are refused (`mcuRuntime: false`), as are RC timing, the 555 and t_pd.
- The host's solve cost slows wall-clock progress only, never virtual time. At about 10–50 ms per edge on this 1-CPU host, a program toggling the bridge at kHz rates runs much slower than real time; the PWM path keeps its own budget (1000 solves per simulated second).

Not done (requires a reviewed architecture and explicit authorization): a transient analog solver under the running MCU.

## 5. Gates, review, deployment

Independent review (`~/tbi-s30/evidence/review.md`), on `a707b08`:
- **B1 (blocking), fixed in `04b7ab4`:** the pad check bounded `|I|`, whose kink at zero current made it fail-open. A HIGH pad tied through 220 Ω … 6 kΩ to a separate 3.3 V supply (zero nominal current, sinking at V_OH min) was accepted. Now two one-sided checks; a regression test covers 220 Ω … 6 kΩ refused and 7 kΩ / 10 kΩ running. The reviewer re-verified it, with no new false refusals.
- **M1–M4 (minor), fixed:** wording, a misplaced doc comment, and the co-simulation test paired from the first request write.

Gates (code `04b7ab4`; later commits change only e2e specs):
- unit 2367 passed / 3 skipped;
- browser e2e 325 passed / 40 skipped, plus 8 failing on S30-L1 expectations, each fixed in `a73d8b3` and rerun with their five files: 55/55;
- runtime (real QEMU) 245 passed / 19 skipped, 0 failed, including s30-cosim (both languages, two runs each) and s19b-x1.

Real-stack spec fix (`e38b444`): s20-logic-real's example D expected the S29 refusal. It now expects the refusals computed by the engine for the shipped circuit:
- at 3.0 V, GPIO19 `logic_mcu_input_not_guaranteed` (LED-loaded V_OH ≥ 2.4 V < V_IH 2.475 V);
- at 4.5 V, input A `logic_input_not_guaranteed` (V_OH min 2.64 V < V_IH 3.15 V).

Package and staging:
- **Package** `e38b444` (dev-lab profile): two builds byte-identical, 37 files, manifest `57fa212ee61f5e09`. It differs from the `a73d8b3` package (`1ad912c945ace313`, also reproduced) only through the embedded commit.
- **Staging** `tbi-s8` real-stack vitest: s8-policy, s28-assist, s8-gate, isolation 21/21.
- **Staging** real-QEMU browser:
  - on `a73d8b3`: p1 + s26 5, b2 11, b3 7, s29 2, s30 4;
  - b1 on `e38b444`: 16 passed / 2 skipped (older-host cases); on `a73d8b3` the single D failure was the spec above;
  - s30 on `e38b444`: 4/4;
  - no service restarts.

DEV-Lab deployment:
- **Deployed** `e38b444` (Runtime v5 `39f2229a66d45e43`, the S26 MicroPython home) in 4.5 s.
- **Backup** `~/tbi-s30/kit/deploy/devlab-backup-20261104T230254Z`.
- **Unchanged:** units, Caddyfile, polkit, policy and keys. The public origin answers 302. The AI provider service is active and `disabled` (`no_provider`).
- **Acceptance** 28/28. In the first run, 24 passed; the 4 s30-real cases then hit the gate's session-creation rate (20 per 10 min; the 21st creation was `rate_limited`). They passed alone after the window.
- **Rollback** `rollback-devlab.sh`:
  - back to `bf05304` in 2.4 s: units and runtime.json byte-equal to the backup, build records 104 rows / 0 incompatible, rollback check 4/4;
  - forward to `e38b444` in 2.2 s, 4/4.

Performance:
- **Engine solve**, one DC operating point, this 1-CPU host, 60 solves each:

  | | esp32-logic-and | esp32-logic-feedback (new; 2 gates + transistor + relay + LED) |
  |---|---|---|
  | S29 | p50 5.7 ms | — |
  | S30 | p50 6.0 ms (the extra one-sided pad check; within noise) | p50 16.3 ms, p95 49 ms |

- **Host co-simulation** cost per edge as in §4.
- **The timing trace** is off unless `timingTraceCapacity` is set; no service sets it.

## Future / Backlog

- A clearer contention code when firmware drives the read-back pin against a gate output that feeds further stages (today `no_steady_state` in the feedback examples).
- Transient (time-stepped) co-simulation under a running ESP32: capacitors, RC timing, LMC555 (needs an architecture review).
- Gate propagation delay in time, only if a program could observe it (it cannot at the ESP32's GPIO rate).
- The timing trace as a user-visible logic-analyzer view (it already has the events).
- Split the DEV-Lab acceptance run into two windows: at 28 cases it exceeds the gate's 20 session creations per 10 minutes.
- Phase C Admin (owner brief 2026-11-04) — after this sprint, by the owner's order.
