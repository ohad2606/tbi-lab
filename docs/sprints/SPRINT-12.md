# Sprint 12 — Runtime v2 (bridge v2, R2, R3): sprint record

**Status (2026-10-09):**
- **D-0 conditionally approved** (PM, 2026-10-09). The architecture package is pushed.
- **R3 feasibility probe complete: GO** (Part B).
- **D-1 capacity assessment complete** (Part C). No infrastructure change was made.
- D-2..D-10 are awaiting PM decision (Part D).
- No product code, no QEMU patch in `runtime/qemu/patches`, no Bridge v2 implementation, no
  deployment.
- Sprint 11 stays open until the owner's smoke acceptance.

**Documents:** [SPRINT-12-ARCHITECTURE.md](SPRINT-12-ARCHITECTURE.md) ·
[SPRINT-12-IMPLEMENTATION-PLAN.md](SPRINT-12-IMPLEMENTATION-PLAN.md) ·
[SPRINT-12-TEST-MATRIX.md](SPRINT-12-TEST-MATRIX.md) ·
[ADR-011](../architecture/adr/ADR-011-runtime-bridge-v2.md) · evidence `s12-evidence/r3-probe/`.

---

## Part A — Push of the architecture package (PM authorization 1)

- **Diff verified before the push:** `e54675b..7721156`, 5 files, +949 lines, documentation only
  (ADR-011, its index line, the architecture document, the implementation plan, the test matrix).
- No secrets.
- Working tree clean (0 porcelain lines).
- `git push -u origin sprint-12` created the remote branch.
- **Remote heads after the push:**
  - `sprint-12` = `7721156509e54ebb6b4bfbd98b25bca76b668ae1`
  - `sprint-11` = `e54675b` (unchanged)
  - `main` = `465b330` (unchanged)

---

## Part B — R3 feasibility probe (architecture §6): **GO**

### B.1 Setup and isolation

| Item | Value |
|---|---|
| Location | `~/tbi-s12-probe` (outside the repository; never in `runtime/qemu/patches`, never deployed, no pinned runtime id) |
| QEMU source | `git archive` of the pinned `40edccac…` + TBI patches 0001–0005, **identical to the deployed runtime source** (`diff -rq` against `~/tbi-s8-rt/build/work-33e35e4ac5e798d7`: only downloaded subprojects and `__pycache__` differ). Same configure flags as `provision.sh` |
| Probe-only changes (`s12-evidence/r3-probe/probe-qemu.diff`, `tbi_i2c_probe.c`) | (1) TMP105 phantom removed. (2) Two diagnostic targets on I2C0: 0x27 "port" (PCF8574-like) and 0x50 "regs" (256-byte register file; NACKs data byte 0xEE). (3) Controller MMIO, command and IRQ trace into a log, only when `TBI_PROBE_I2C_LOG` is set. (4) **One controller fix**: data-byte NACK (B.3) |
| Probe binary | sha256 `0ea40d81…66437d0` |
| Firmware | `TbiI2cProbe.ino` built with the pinned core (arduino-cli 1.5.1, arduino-esp32 3.3.12, `FlashMode=dio`, `SOURCE_DATE_EPOCH` 1767225600), empty sketchbook, merged 4 MiB image sha256 `b83c9544…3fea`. A `DebugLevel=error` variant was used only to read the driver's error codes |
| Linked driver (verified from ELF symbols) | IDF **`i2c_master`** (new driver): `i2c_new_master_bus`, `i2c_master_transmit/receive/probe`, `i2c_master_isr_handler_default`, `s_i2c_hw_fsm_reset`, `s_i2c_synchronous_transaction`; precompiled `libesp_driver_i2c.a` |
| Session configuration | The repo's unchanged harness (`runtime/harness/session.ts`): synchronous bridge, 1 ms tick, `-icount shift=3,sleep=off` |
| Sprint 11 runtime and deployments | Untouched. The gate evidence went to a separate runtime home (`~/tbi-s12-probe/rt/results`); `~/tbi-s8-rt` was only read |

### B.2 Results

| # | Probe | Result | Measured |
|---|---|---|---|
| P-1 | `Wire.begin(21,22,100000)` | **PASS** | `true`; boot completes; no driver error |
| P-2 | 3-byte write to 0x27 | **PASS** | `endTransmission` = 0; target log START_SEND, 3 bytes, FINISH in order |
| P-3 | Write to an absent address (0x3F) | **PASS (expectation corrected)** | Returns **4**, not the 2 the package assumed. The controller raised `ACK_ERR` (the TRM NACK interrupt, raw 0x400). The **unmodified Espressif driver** then returns `ESP_ERR_INVALID_STATE` (259), which Wire maps to 4 (`Wire.cpp` `endTransmission`). Evidence: the `DebugLevel=error` build prints `i2c_master_transmit failed: [259] ESP_ERR_INVALID_STATE`. The error code is driver behaviour, not emulation |
| P-4 | Target NACKs a data byte | **FAIL on upstream → PASS with fix** | Upstream ignored the target's NACK (returned 0, so the write looked successful). With the fix: `ACK_ERR`, driver 259, Wire 4 |
| P-5 | Set pointer 0x10, `requestFrom(0x50,4)` | **PASS** | `4a,4b,48,49` = regs[0x10..0x13] |
| P-6 | Repeated START (`endTransmission(false)` then read 2) | **PASS** | `5f,5c` = regs[5], regs[6] |
| P-7 | 100-byte write (above the 32-byte FIFO and 16 commands) + read back 99 | **PASS** | 0 mismatches; the driver splits it into FIFO-sized segments with END and re-arm |
| P-8 | Scan 0x01–0x7E | **PASS** | ACKs exactly `[27 50]`; **0x48 (removed TMP105) NACKs** |
| P-9 | HD44780-via-PCF8574 4-bit init + "Hello" | **PASS** | The **engine's** `I2cLcd` model, fed the 47 bytes the target received: row 1 `Hello`, row 2 blank, display on, 2 lines, backlight on |
| P-10 | Determinism, 10 runs | **PASS** | 10/10 identical: bus/controller log hash `ee122b4d90f4398a` (8 861 virtual-time-stamped lines, process pointers stripped), serial hash `7ebacf54d1e33aed`, end at 955 738 345 ns, 9 PASS each |
| P-11 | Non-I2C regression: pinned gate fingerprints on the probe binary | **PASS** | `gate.runtime.test.ts` **6/6 with the pinned fingerprints** (1 ms, 1 ms + main-loop stress, 10 ms; full workload and early-boot window), probe binary with all probe changes in |

### B.3 Controller change required so far

The data-byte NACK fix is in `esp32_i2c_do_transaction`, WRITE opcode:
- When the target NACKs a data byte with `ack_check_en` set and an expected ACK, set `ACK_ERR`
  and end the command list, as the TRM specifies.
- Size: **8 lines of code (one replaced, seven added) plus a 2-line comment**, against the ≤ 200-line GO criterion.
- No other controller behaviour was needed for P-1..P-11.

### B.4 Findings that change the design

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F-1 | **Pad-function reporting (patch 0007) is required, not optional.** On `Wire.begin` the existing 0003 GPIO model reports pads 21 and 22 as **push-pull outputs driven high** (`G 890260872 21 d1 l1`, `G 890264960 22 d1 l1`). Electrically an I2C line is open-drain and released | Pad-event recording in the probe run (`results/pads.json`) | Without 0007 the solver would be told SDA/SCL are driven at 3.3 V: false physics. Confirms ADR-011 §3 |
| F-2 | **The bus duration is not modelled.** A 3-byte write completes in **11.4 µs** of virtual time and a 100-byte write in **46.7 µs**. The driver programs 100 kHz (SCL high/low periods of 400 APB cycles each), where real hardware takes about **0.37 ms** and **9.2 ms** | Target log timestamps | Function is correct; timing is 30–200× fast. Firmware timing around transfers (`micros()` deltas, display refresh rates) would be unrealistic. **Decision D-9** |
| F-3 | Address NACK in a non-empty write returns 4 with this core (B.2 P-3) | Driver error 259 | The product's help text and the test matrix use 4, not 2. Zero-length probes (scanners) still return 0/2 through `i2c_master_probe` |
| F-4 | The driver resets its state machine after an error (FIFO and timing registers re-written) and issues STOP as a separate command segment | Controller trace | Works on the upstream model; it will be kept under regression (T-R3-4/5) |

### B.5 Go/no-go

**GO.**
- All GO conditions in architecture §6 are met: P-1..P-3 and P-5..P-11 pass; P-4 passes with an
  8-line fix; the change is explained against the TRM.
- **No-go triggers did not occur:**
  - no SCL-level timing was needed for function;
  - no cycle-accurate state machine, bus-clear or clock stretching was needed;
  - determinism and non-I2C regression hold.
- **Time used:** about 0.5 working day (the timebox was 1.5, maximum 3).
- **Not covered by the probe**, carried to the implementation tests:
  - `Wire1` / I2C1 (T-R3-9);
  - `Wire.setClock` other than 100 kHz;
  - controller timeout paths;
  - MicroPython `machine.I2C` (not in Sprint 12).

---

## Part C — D-1 capacity assessment (no change made)

### C.1 Verified facts

| Item | Value | Source |
|---|---|---|
| VM | `VM.Standard.A1.Flex`, **1 OCPU, 4 GB**, region il-jerusalem-1 (**single AD**), created 2026-09-20, Ubuntu, 100 GB boot volume (55 GB used) | Instance metadata `/opc/v2/instance/shapeConfig`, `lscpu`, `df` |
| Workloads on this VM | dev-lab (`tbi-*`) and staging (`tbi-s8-*`) stacks: two session hosts, two build services, Caddy, oauth2-proxy, plus development tools (about 1.1 GB for the editor server and CLI) | `systemctl list-units 'tbi*'`, `ps` |
| Memory now | 3.9 GB total, about 2.2 GB available, 1.6 GB of the 8 GB swap in use | `free -m` |
| Limits | `tbi-qemu@` MemoryMax 384 M; build job 1 G (observed peak 0.7–0.83 G); session host and build service 512 M each | unit templates (`deploy/dev-lab/s8/*.in`) |
| Policy | `maxLiveSessions: "cpus"` → **1 live session**, and builds are deferred while it runs | `policy.json` |
| **Real-time pacing** | **Documented but not implemented.** V1-ARCHITECTURE §7.8 specifies a real-time cap by withholding the tick reply; no pacing code exists in `runtime/host` or `runtime/harness`. Sessions run unpaced and consume all available CPU | `grep` (no matches), V1-ARCHITECTURE §7.8 |
| Measured cost | One light session alone ≈ 3.4–3.9× real time on 1 vCPU (QEMU 0.70 + host 0.24 CPU-s/s at 3.88×) ⇒ **≈ 0.25 vCPU per session at 1.0× real time** if paced. Heavier firmware: ≈ 0.67 vCPU (earlier "1.5× unpaced" figure) | `s11-evidence/matrix-perf/run-1.json`, V1-ARCHITECTURE §7.7 |
| **Oracle Always Free A1** | "All tenancies get the first **1,500 OCPU hours and 9,000 GB hours** per month for free … equivalent to **2 OCPUs and 12 GB** of memory." Applies to free and paid accounts. Idle instances may be reclaimed (7-day p95 CPU, network and memory < 20 %) | docs.oracle.com FreeTier `resourceref.htm`, fetched 2026-10-09 |
| Resize | Changing OCPU/memory of a running A1 Flex instance **reboots it** and requires host capacity (single AD: no alternative AD) | Oracle docs (resizing instances) |

**Corrections:**
- My earlier statement (Sprint 11 assessment) that the free tier "historically allowed 4 OCPUs/24
  GB" is **outdated**. The current official allowance is 2 OCPUs/12 GB. A secondary report
  (Linuxiac, 14 Jun 2026) describes the cut; Oracle's A1 pricing page still shows the old figures,
  and the docs page is treated as authoritative.
- The background research labelled the two stacks "prod and dev-lab"; they are **dev-lab and
  staging**. Production is not on this VM's TBI units.

**Not verified (needs the owner's console):**
- whether the tenancy is Always-Free-only or Pay-As-You-Go;
- whether other A1 resources already use part of the free allowance;
- the PAYG A1 prices ($0.01 per OCPU-hour and $0.0015 per GB-hour come from search-indexed text;
  the fetched pricing page rendered without figures).

### C.2 Requirement for five concurrent sessions

| Workload mix | CPU at 1.0× real time (paced) | Plus overhead (build, second stack, OS) | Memory (limits) |
|---|---|---|---|
| Light (R1 examples) | 5 × 0.25 = **1.25 vCPU** | +0.5–1 vCPU | 5 × 384 M + 1 G build + 4 × 512 M + OS ≈ **6 GB** (≥ 8 GB recommended) |
| Heavy (busy loops, I2C/LCD refresh, serial-heavy) | 5 × 0.67 = **3.3 vCPU** | +0.5–1 vCPU | Same |

**Without pacing**, five sessions share whatever CPU exists and each runs at (capacity ÷ 5). On
1 vCPU that projects to **≈ 0.7× real time each** (light), below the C-5 criterion.

### C.3 Options

| Option | What | Cost / month | Meets 5 × light | Meets 5 × heavy | Risks |
|---|---|---|---|---|---|
| **a** | Resize this VM to the free ceiling, **2 OCPU / 12 GB**, **plus implement pacing** (D-10) **plus** stop staging during the alpha | $0 (if no other A1 usage) | **Likely** (1.25 + overhead ≈ 1.8–2 vCPU; tight) | **No** | Reboot (minutes of dev-lab downtime); capacity availability in a single AD; idle reclaim not a concern under load; tight headroom |
| **b** | Second free A1 instance for the runtime | $0 | No: the free total is 2 OCPU, so it would split 1 + 1 | No | More operations for no capacity gain |
| **c** | PAYG resize to **4 OCPU / 16–24 GB** (+ pacing) | ≈ **$19** (4/16) to ≈ $28 (4/24), using the unverified prices | Yes (comfortable) | **Yes** (≈ 1.2× each unpaced; paced 1.0×) | Requires PAYG (unverified); reboot; billing alerts advised; capacity in a single AD |
| **d** | Reduced-concurrency alpha on the current VM: 1–2 live sessions, a queue or scheduled slots for 5 testers | $0 | No (by design) | No | Tester experience (waiting); needs a queue or slot UI or rules (policy work) |
| e | Other provider (for comparison only, not evaluated in depth) | ≈ €6.5–28 | — | — | Migration, new provider, data and auth re-setup |

**Recommendation (for owner and PM decision; nothing adopted):**
- **Engineering minimum, whatever the hardware:** implement real-time pacing (D-10). Without it no
  host size gives predictable per-session speed, because sessions consume all CPU.
- **Then:**
  - **Free path:** option **a**. Measure C-5 on 2 OCPU in Sprint 13 and keep **d** as the
    fallback if C-5 fails.
  - **Low-cost path:** option **c** gives margin for heavy workloads.
- **Inputs needed early in Sprint 13 to keep 30 November:**
  - the owner confirms the account type and the free-allowance usage (a console check, no change);
  - the decision itself, by about 30 October.

---

## Part D — Decisions D-2..D-10: wording, options, consequences, recommendations

D-2..D-8 are worded exactly as in architecture §12. D-9 and D-10 are new and come from the probe
and capacity evidence.

**D-2 — "C-5 pass criteria (§8)".**
- **Proposed criteria (§8):**
  - every session p5 rate ≥ 1.0× real time;
  - tick gap p99 ≤ 100 ms;
  - no session failures;
  - build ≤ 120 s under load;
  - memory headroom ≥ 25 %.
- **Options:**
  - (1) accept;
  - (2) relax the rate to ≥ 0.8× for heavy workloads only;
  - (3) tighten the tick gap to ≤ 50 ms.
- **Consequences:** (1) sets the bar the hardware decision must meet; (2) lowers hardware need but
  slows heavy sketches visibly.
- **Recommendation:** accept (1). With pacing, ≥ 1.0× is the user-visible definition of "runs in
  real time".

**D-3 — "Third-party Arduino libraries (`DHT.h`, `LiquidCrystal_I2C`)".**
- **Options:**
  - (1) Sprint 12: none; library-free curated examples;
  - (2) a pinned, licence-reviewed allowlist in Sprint 12;
  - (3) an allowlist in Sprint 13.
- **Consequences:**
  - (1) keeps scope and supply chain unchanged, but testers who paste typical tutorials hit
    "library not available";
  - (2)/(3) need build-sandbox library provisioning, licence review, and **symbol-level detection
    of internal pulls**. The Adafruit DHT library calls `INPUT_PULLUP` internally, which the
    sketch-token scan cannot see (audit A-7).
- **Recommendation:** (1) for Sprint 12; decide (3) by Sprint 13 start, with D-4.

**D-4 — "Internal pull-ups (`INPUT_PULLUP`, `Wire`'s automatic internal pull-ups)".**
- **Options:**
  - (1) unmodelled; they do not satisfy I2C gating; an explicit diagnostic;
  - (2) model IO_MUX pulls in the GPIO model in a later runtime (lifts today's `INPUT_PULLUP`
    refusal too).
- **Consequences:**
  - Probe evidence: core 3.3.12 enables internal pull-ups on SDA/SCL (`enable_internal_pullup =
    1`).
  - Under (1), a circuit relying only on them gets `i2c_no_pullup`, which is conservative: about
    45 kΩ is out of the I2C rise-time specification at 100 kHz.
  - Most LCD backpacks have on-board pull-ups, so the common case works.
- **Recommendation:** (1) in Sprint 12; (2) as a backlog candidate for after the alpha.

**D-5 — "Branch base: `sprint-12` from `sprint-11` head (`e54675b`) before Sprint 11 is merged".**
- **Options:** (1) accept; (2) wait for the Sprint 11 merge and rebase.
- **Consequences:** (1) is already in effect; `sprint-12` contains Sprint 11 unchanged. (2) would
  block Sprint 12 on owner smoke.
- **Recommendation:** accept (1).

**D-6 — "Patch numbering by landing order (0006 bridge v2, 0007 pad functions, 0008 I2C; LEDC
later 0009)".**
- **Options:** (1) accept; (2) keep the capability plan's reserved numbers (0006 LEDC, 0007 I2C,
  0008 scheduled input) with gaps.
- **Consequences:** patches apply in file order. (2) would leave a hole at 0006 until R4 and makes
  the series depend on a patch that does not exist.
- **Recommendation:** (1).

**D-7 — "DHT22 T_go value if the datasheet gives only a range".**
- **Options:** (1) the datasheet's typical value; (2) the range midpoint; (3) the minimum.
- **Consequences:** it affects only when the sensor's first edge occurs; decoding firmware
  tolerates the specified range. The choice is documented as an assumption either way.
- **Recommendation:** (1) the typical value, documented as an assumption.

**D-8 — "Scope confirmation: the R2/R3 parts include full product-side work (catalog, 2D/3D, i18n,
examples) in Sprint 12".**
- **Options:** (1) confirm; (2) runtime-only in Sprint 12, product parts in Sprint 13.
- **Consequences:**
  - (2) saves about 5 days in October but leaves the capabilities invisible to testers and moves
    the work into the hardening sprint.
  - (1) is what the 30 November alpha needs.
- **Recommendation:** (1), with the parallel-agent option (Part E) to protect the date.

**D-9 (new, from probe F-2) — "Model the I2C bus duration in Sprint 12, or record it as a
limitation".**
- **Options:**
  - (1) model it: the controller's completion interrupt is delayed by the computed bus time,
    9 SCL clocks per byte plus START/STOP, from the SCL high/low period registers the driver
    programs;
  - (2) a documented limitation for the alpha.
- **Consequences:**
  - (1) makes transfer timing real at any `setClock`, costs about 0.5–1 day in patch 0008, and
    changes completion from instantaneous to timer-driven. That is deterministic: a virtual timer,
    the same mechanism as the bridge tick.
  - (2) leaves I2C 30–200× faster than real hardware.
- **Recommendation:** (1). "Physics must be real" applies to timing, and the cost is small.

**D-10 (new, from Part C) — "Implement real-time pacing (V1-ARCHITECTURE §7.8) before the alpha".**
- **Options:**
  - (1) add it to Sprint 12 as a small slice in the Session Host, about 1–1.5 days: withhold the
    tick reply until wall time catches up with simulated time, so pacing cannot change the
    timeline;
  - (2) Sprint 13;
  - (3) not for the alpha.
- **Consequences:**
  - Without pacing, per-session speed depends on how many sessions run, and builds starve.
  - Any capacity measurement (C-5) taken without pacing is not representative of the alpha.
  - It is an ADR-007/§7.8 behaviour already specified, not new design.
- **Recommendation:** (1) or early (2). It must precede the C-5 measurement on the alpha host.

---

## Part E — Updated critical path, parallel work, forecast

### E.1 What changed since the package

| Item | Package (09 Oct, before the probe) | Now |
|---|---|---|
| R3 go/no-go | Expected 14–15 Oct | **GO on 09 Oct** (≈ 0.5 day used) |
| R3 controller risk | Unknown, up to 5 days of fixes | **8-line fix measured**; remaining R3 risk is ordinary implementation |
| Patch 0007 | Planned | **Confirmed necessary** by measurement (F-1) |
| Bus timing | Recorded limitation | **D-9**: +0.5–1 d if approved |
| Pacing | Not in scope | **D-10**: +1–1.5 d if approved; prerequisite for a meaningful C-5 |
| Capacity | "4/24 possibly free" | **Free ceiling 2 OCPU/12 GB** (verified); 5 heavy sessions need paid capacity or reduced concurrency |

### E.2 Remaining Sprint 12 effort (P50 / P90, working days)

| Scope | P50 | P90 |
|---|---|---|
| Package slices S12-2..S12-12 (S12-1 done) | 20.5 | 33.5 |
| + D-9 bus timing | +0.75 | +1 |
| + D-10 pacing | +1.25 | +1.5 |
| **Total if D-9 and D-10 are approved** | **≈ 22.5** | **≈ 36** |

Window: 13–31 Oct = 19 calendar days.

### E.3 Critical path

```
PM reconciles D-2..D-10 ──► S12-2 bridge host ─► S12-3 (0006) ─► S12-6 (0007) ─► S12-7 (0008 + D-9) ─► S12-8 ─► S12-9 ─► S12-10b Gate B
                                                     └─► S12-4 ─► S12-5 ─► S12-5c R2 on staging (≈ 23 Oct)
Owner: account type + free-allowance check ─► D-1 decision (≤ 30 Oct) ─► (Sprint 13) resize/fallback ─► C-5 on alpha host (needs D-10) ─► 14 Nov freeze
```

### E.4 Work that can proceed in parallel

Each item is independent of QEMU and needs only the authorization named.

| Work | Needs | Benefit |
|---|---|---|
| S12-10a: FU-11-1 (staging system artifacts) and FU-11-2 (disk-backed deploy tmp), plus `switch-runtime.sh` | Sprint 12 scope (already authorized) after D-0 reconciliation | Off the critical path; unblocks the R2 staging checkpoint |
| S12-11: C-5 harness and N=1..3 dry run on staging | In scope | Gives the per-session cost curve that D-1 uses |
| D-10 pacing slice | D-10 | Makes C-5 meaningful; independent of QEMU |
| Product-side parts (catalog, 2D, schematic, 3D, i18n) for HC-SR04, DHT22, LCD, by parallel agents | D-8 | Saves about 2–3 days of the critical path |
| DHT22 T_go datasheet extraction | D-7 | Unblocks S12-4 |
| Owner: account type and free-allowance check in the Oracle console (read-only) | Owner | Unblocks D-1 |
| Owner smoke of Sprint 11 | Owner | Allows the Sprint 11 merge and tag (separately authorized) |

### E.5 Forecast

| Target | Forecast | Confidence | Basis |
|---|---|---|---|
| R2 proven on staging | ≈ 23 Oct | High | Package plan minus the probe days |
| R2 + R3 Runtime v2 through staging Gate B by **31 Oct** | P50 ≈ 31 Oct – 1 Nov (with D-9, D-10); P90 ≈ 12 Nov | **≈ 55–60 %** (was 45–50 %) | R3 risk retired by the probe; added D-9/D-10 effort |
| …with parallel product-part agents (D-8 option) | P50 ≈ 29–30 Oct | ≈ 65–70 % | 2–3 days off the critical path |
| **30 Nov external alpha (5 testers)** | Feasible | **≈ 60 % overall** | The runtime track is no longer the main risk. **Capacity is**: it needs D-10 pacing, the D-1 decision by about 30 Oct, and C-5 passing on the chosen host by about 14 Nov. Fallback (option d, reduced concurrency) keeps a 30 Nov alpha possible at a lower concurrency |

### E.6 Scope reduction

**No scope reduction is proposed.** The probe removed the main reason one was anticipated (R3
infeasibility).

**Reductions available if the dates slip, with the evidence for each:**

| Reduction | Evidence it is safe | Cost to the alpha |
|---|---|---|
| R2-only Runtime v2 at 31 Oct; R3 as a second drop in early Sprint 13 | 0006 is independent of 0007/0008 (architecture §2) | One extra re-baseline (≈ 1 d); the LCD arrives about 1 week later |
| D-9 deferred (I2C bus timing as a documented limitation) | F-2: function is correct without it | I2C transfers 30–200× faster than real hardware |
| LCD 3D as a body with 2D-rendered text first | Rendering only; no physics impact | Visual fidelity of one part in 3D |
| Alpha at reduced concurrency (option d) | C.2: one vCPU sustains about two light sessions at ≥ 1.7× | Testers wait or use time slots |

---

## Stop point

Stopped before:
- full Bridge v2 / R2 / R3 implementation (pending reconciliation of D-2..D-10);
- any production change, deployment, merge or tag;
- any infrastructure change.

The probe tree and binary stay in `~/tbi-s12-probe` (scratch, not deployed). Deployments
(dev-lab `0487ce6`, staging R1) and the runtime `33e35e4ac5e798d7` are untouched.
