# Sprint 13 — execution plan (PM authorization 2026-10-12, capacity amendment 2026-10-12)

Authorized:
- Alpha hardening H1–H8, with amendments; H5 is now **five-session capacity (P0)**.
- R4 feasibility probe: timeboxed to 2 working days, scratch build only.

Not authorized:
- Full R4 implementation.
- Infrastructure change, purchase or migration.
- Deploys outside the release gates; production.
- Merge, tag or sprint closure.

**Targets:**
- Alpha **16 Nov**, fallback **30 Nov**.
- Five independent testers using it **concurrently**.
- Quality and physics correctness take precedence over both dates.

## 1. Critical path (updated)

```
Owner: infra approval (≤ 23 Oct) ─► alpha host provisioned ─► H5 capacity track ─► 5-session acceptance (5 Nov)
H1 ─► H2 ─► H3 journey ─┐                                                               │
H4, H6, H8 ─────────────┼─► hardening Gate C (Owner Smoke first) ─► RC freeze (6 Nov) ─► dry run (9–11 Nov) ─► go/no-go (12 Nov) ─► Alpha (16 Nov)
H5 policy/build admission ┘
R4 probe (2 d, slack only) ─► PM go/no-go ─► (full R4 only if approved; cut-off 5 Nov; never on the critical path)
```

**The capacity track is now the longest chain:** owner decision, then provisioning, then
benchmarking, then fixes. It sets the earliest possible alpha date.

## 2. H1–H8: sequence and acceptance criteria

Each slice is independently tested and committed on `sprint-13`.

| Order | Item | Acceptance criteria |
|---|---|---|
| 1 | **H8** Sprint 12 closure items | C-5 harness on the ratified 5 s / 0.995× rule: **done** (`138541f`, N = 1 PASS: 5 s p5 0.9982). Closure CI on the final S12 commit; Owner Smoke checklist ready (§7) |
| 2 | **H6** persistence, runbook, backup | Export → empty browser → import → identical project → build → run, same result: **verified** (§3). Runbook (deploy, three rollback scopes, restart, health, logs, disk/memory). Server-state backup, manual; restore rehearsed on staging |
| 3 | **H1** supported / unsupported panel | Generated from the catalog's runtime flags and the builder's feature rules, not hand-written; EN/HE; every refusal code the builder or host can emit links to an entry; the V1 timing contract in plain language. Unit tests: no refusal code without an entry |
| 4 | **H2** ratings and the failure framework | Per part, from published datasheets only, kept separate: **recommended operating conditions** (an operating-limit notice: "outside the specified range; the result may not match a real part") and **absolute maximum ratings** (damage risk). Unreliable-result indicator when an operating point is outside a model's validity range; explicit model-limitation notes; parts without published limits are labelled so. No invented limits, no permanent-damage modelling. Unit tests cite the datasheet table per value; the examples stay warning-free; seeded overstress cases warn |
| 5 | **H5** five-session capacity (P0) | §4 |
| 6 | **H3** EN/HE acceptance journey | First visit → example → edit → Build → Run → live parameter → Stop → export/import → language switch (same project, same result) → refusal case, automated in both locales on the deployed site, plus the native Hebrew review (owner) |
| 7 | **H4** onboarding for five testers | First-run guide (3 steps, EN/HE), tester guide; allowlist entries (owner). Dry-run user reaches a running example in ≤ 5 min |
| 8 | **H7** feedback form | Zero-cost online form: expected / actual, severity, steps, the app version and commit prefilled. Prepared but **not enabled** until the PM approves external data collection. A dry-run exit with no P0/P1 open |

The busy state (H5 amended): a clear, localized "the simulator is at capacity" state with retry.
It remains as the safety net for over-capacity or quota cases; there are no time slots and no
queue system.

## 3. Project export / import: verification result — PASS

`app/e2e/s13-export-real.spec.ts`, real QEMU (staging backends, Runtime v2), 1/1 in 1.0 min:
- **Machine A:** opened the R2 distance-alarm example, changed the HC-SR04 distance to 0.3 m, prepended a marker line to the Arduino source, exported `.tbilab` (format v2, integrity hash verified by `parsePackage`).
- **Machine B (empty browser profile):** imported it.
  - The project document is equal to the exported one in every engineering field (components, parameters, nets, layout, programs).
  - The source is byte-identical; the parameter shows 300 mm.
  - Build and Run on QEMU print "Distance: 30.x cm" with the LED off: the same result.
  - After a reload it is still there and identical.
  - A tampered package (one value changed, hash not) is refused with a notice; nothing is written.
- **Conclusion:** a reliable, user-controlled backup workflow exists (Projects → Export / Import; the app menu → export the current project). Not a gap.

## 4. H5 (revised): five-session capacity track

### 4.1 Measured basis (this host, 1 OCPU Ampere A1, Runtime v2, paced, 120 s)

| Workload (one session) | Host CPU (share of 1 core) | QEMU RSS | 5 s p5 |
|---|---|---|---|
| HC-SR04 (R2) | 0.41 | 85 MB | 0.9990 |
| DHT22 (R2) | 0.38 | 77 MB | 0.9997 |
| GPIO (R1) | 0.35 | 82 MB | 0.9995 |
| I2C LCD (R3) | 0.34 | 84 MB | 0.9997 |

- **Firmware build:** full compile ≈ 31–33 s wall, 24–25 s CPU, ≈ 0.7 GB peak (journal, Gate B). Cached or failed steps 4–5 s.
- **On one core:** N = 2 already misses the rule (Gate B: 0.87 / 0.94 at 1 s); N = 3 saturates.

**Projection for five sessions:**
- 5 × 0.41 ≈ 2.1 cores, plus ≈ 0.15 for the services, plus 0.8 per build job (CPUQuota 80 %).
- That is ≈ 3.0 cores with one build in progress, ≈ 3.8 with two.
- On one core, pacing quality already degrades above ≈ 75 % busy. Target ≤ ≈ 60 % at peak, so **6 OCPU**.
- Memory: 5 × 384 MB (the QEMU unit cap) + 2 × 1 GB (build job cap) + ≈ 1.5 GB services/gate + OS gives ≤ 6 GB, so **16 GB** leaves ample headroom.

### 4.2 Software changes required for five concurrent users

| Gap found | Effect today | Change (gated slice) |
|---|---|---|
| The build service compiles **one job at a time** globally; global queue `maxQueued 3` | A 5th simultaneous Build is refused `builder_busy`: a user-facing failure | Alpha policy global `build.maxQueued` ≥ 10 (each user's own 1 active + 1 queued). Measure the wait. If the 5th user's wait exceeds about 2 min, add parallel build workers (a builder code change, separately gated) |
| `deferWhileLiveSessionsAtLeast: "cpus"` | With sessions ≥ cores, every build waits | On 6 OCPU the threshold is 6 > 5 sessions; keep `"cpus"` |
| `maxLiveSessions: "cpus"` | With 6 OCPU, 6 live sessions; per user 1 | No change (5 testers × 1) |
| Busy / quota states | Must be understandable | H5 busy state (above) |

### 4.3 Capacity acceptance (C-5, ratified rule: p5 ≥ 0.995× over 5 s windows, tick-gap p99 ≤ 100 ms, no failures)

Run on the approved alpha host, exact configuration recorded (`lscpu`, `free`, kernel, runtime
id, commit, policy hash):
1. **Sessions:** N = 1…6, mixed R1/R2/R3 (sonar, DHT22, LCD, GPIO), 150 s each, 3 repeats.
2. **Builds while 5 sessions run:** 5 simultaneous submissions (one per user) and a queued burst. No refusal, wait time per position, and the build ≤ 120 s under load (D-2).
3. **Life cycle under load:** session create, Stop, QEMU crash, client disconnect / lease expiry. Each cleans up: no unit, process or session file left; the other sessions unaffected.
4. **Soak:** 5 sessions for 2 h, plus builds every 10 min. Rate, tick gaps, RSS growth and failures recorded.
5. **Isolation and authorization under load:** s8-containment (non-restart cases), s8-deployed-policy, cross-user access refused.
6. **Evidence:** JSON per run, host configuration file, summary table. PASS at every N ≤ 5 is the alpha gate (**5 Nov**).

Harness work needed: concurrent-build and fault-injection drivers in `c5-capacity`, a soak mode,
and a host-configuration capture (≈ 1.5 d, testable locally at N = 1–2).

### 4.4 Infrastructure options (for owner approval; nothing changed)

**Today:** 1 VM, `VM.Standard.A1.Flex` 1 OCPU / 4 GB, Ubuntu 26.04, 96 GB boot volume (21 GB
free). It hosts dev-lab, staging and builds; home region il-jerusalem-1.

**Prices:**
- Ampere A1: **$0.01 per OCPU-hour, $0.0015 per GB-hour** (Oracle). That is ≈ $7.30 per OCPU-month and ≈ $1.10 per GB-month at 730 h.
- **The free allowance is inconsistent in Oracle's own pages:**
  - the Always Free documentation states **1,500 OCPU-h / 9,000 GB-h per month (2 OCPU / 12 GB)**;
  - the A1 pricing page still states **3,000 / 18,000 (4 OCPU / 24 GB)**.
- The owner must read the tenancy's actual allowance and account type in the console (§7). An Always-Free-only account cannot exceed the allowance at all: that needs Pay As You Go.

| Option | Shape | Expected capacity (projected, to verify) | Monthly cost if allowance 4/24 | …if 2/12 | Downtime / migration | Security / operations | Rollback |
|---|---|---|---|---|---|---|---|
| **A. Resize the current VM** | 6 OCPU / 16 GB (shared with dev-lab and staging) | 5 sessions + builds ≈ 50 % busy, **but dev and staging tests share the cores** (they perturb alpha pacing) | ≈ $14.60 | ≈ $33.60 | Shape change = stop/start of the instance: ≈ 5–15 min outage of dev-lab and staging; no data migration | No new attack surface; one host to operate | Resize back to 1/4 (another restart) |
| **B. Dedicated alpha VM (recommended)** | Alpha 6 OCPU / 16 GB; current VM unchanged 1/4 (dev, staging) | 5 sessions + 2 builds ≤ ≈ 63 % busy, **isolated** from dev and staging work | ≈ $21.90 (3 OCPU over) | ≈ $45.30 (5 OCPU + 8 GB over) | None for dev-lab. ≈ 1–2 days to provision: OS, users, the **exact** runtime and release-artifact bytes copied and hash-verified (no rebuild), `install.sh`, gate (Caddy + oauth2-proxy), DNS name and OAuth redirect | A second public host: firewall, OAuth secrets, SSH keys, patching; the same gate model | Testers back to dev-lab (one session) or fallback date; terminate the VM, cost stops |
| C. Dedicated alpha VM, 4 OCPU / 16 GB | 4 / 16 | ≈ 75 % busy at peak; `cpus` = 4 < 5 sessions: needs explicit policy values, builds deferred at ≥ 4 live → **likely fails** the no-user-facing-failure rule | ≈ $7.30 (1 OCPU over; tenancy total 5/20) | ≈ $30.70 (3 OCPU + 8 GB over) | as B | as B | as B |

Block storage: Always Free includes 200 GB of block volume. The current 96 GB boot volume plus a
≈ 60 GB alpha boot volume stays within it (verify in the console).

**Recommendation: B, 6 OCPU / 16 GB, Pay As You Go, in the home region.**
- Five-session headroom measured against the ratified rule.
- Dev stays small (PM item 1).
- No downtime.
- Trivial rollback; about $22–45 a month while it runs.

Benchmark both 6 and 4 OCPU on the new VM (a shape change on an idle alpha VM is harmless before
the alpha) and keep the smaller one that passes §4.3 with margin. Production scaling stays
incremental (PM item 5): the same per-session measurements give the sizing rule (≈ 0.41 core per
paced session at peak workload, plus build capacity).

## 5. Build-time benchmark plan

| Scenario | Host | Measure |
|---|---|---|
| B-1 idle | current (1 OCPU) and alpha | wall/CPU per example (5 curated + a large sketch), cold vs cached |
| B-2 one live session | current | build time, and the session's 5 s p5 during the build |
| B-3 five live sessions | alpha | build time; session pacing during it |
| B-4 five simultaneous builds | alpha | queue position → wait; no refusals; build ≤ 120 s under load |
| B-5 startup | both | Run click → `running` (session create + QEMU boot to setup), with and without load |

User-visible numbers are reported; changes (parallel build workers, cache warm-up) are recommended
only if a scenario misses the ≤ 120 s build or the ≤ 30 s start target.

## 6. R4 probe plan (2 working days, scratch only)

- **Scope.**
  - A scratch QEMU tree outside the repo (pinned `40edccac` + 0001–0008 + probe 0009).
  - Never in `runtime/qemu/patches`, never deployed, no runtime id.
  - Run on staging/local only, outside the capacity benchmark windows (single CPU).
- **Day 1.**
  - Observe the 3.3.12 LEDC driver's register sequence for `analogWrite`, `ledcAttach` + `ledcWrite`, and a 50 Hz servo pattern (12–16 bit).
  - Implement the timer/channel → period/high/phase computation and the LEDC → GPIO-matrix routing check.
- **Day 2.**
  - Emit `W` frames to a scratch host stub.
  - Compare against hand calculation for duty 0 / 25 / 50 / 100 % at 1 kHz and 5 kHz, and for servo 1.0 / 1.5 / 2.0 ms.
  - Measure the frame count per configuration change, and check that unchanged-config sketches keep their fingerprints.
- **Stopping conditions** (stop and report as no-go or needs-decision):
  1. The driver relies on LEDC behaviour the model cannot reproduce honestly (e.g. fade or interrupt-driven duty updates on the plain `ledcWrite` path).
  2. Routing needs changes outside LEDC/GPIO-matrix (a core-model change).
  3. Any existing fingerprint changes for a sketch that does not use LEDC.
  4. Waveform error beyond one LEDC clock tick.
  5. The timebox is exhausted.
- **Output.** Evidence and a go / no-go recommendation; full R4 only after PM approval. R4 never takes time from H5 or the alpha candidate, which stays free of experimental QEMU changes.

## 7. Actions requiring the owner

| # | Action | Needed by |
|---|---|---|
| O-1 | **Oracle console, read-only:** tenancy account type (Always Free vs Pay As You Go); the A1 allowance actually shown (2/12 vs 4/24); service limits / quota for A1 cores in il-jerusalem-1; current A1 usage; block storage used | **16 Oct** (feeds the 23 Oct decision) |
| O-2 | **Approve the infrastructure option** (B recommended), Pay As You Go upgrade if needed, the monthly cost ceiling | **23 Oct** (earlier gives more benchmark time) |
| O-3 | DNS record for the alpha host name (e.g. `alpha.tbi-tech.net`); add its redirect URI to the Google OAuth client | with O-2 |
| O-4 | Owner Smoke on dev-lab: Sprint 12 checklist (SPRINT-12-GATE-C.md) and Sprint 11; approval of closure (PR/merge/tag) | **18 Oct** |
| O-5 | Five tester emails (allowlist); approve the external feedback form (data collection) | **12 Nov** |
| O-6 | Native Hebrew review of the H3 journey and the H1/H2 texts | 1–4 Nov |
| O-7 | Dry-run participation | 9–11 Nov |

## 8. Release risk register (updated)

| # | Risk | L | I | Mitigation / trigger |
|---|---|---|---|---|
| R-1 | **Five-session capacity not in place by 5 Nov** (decision, provisioning or benchmark late) | M | **Critical** | O-1 by 16 Oct, O-2 by 23 Oct; harness extensions done before the VM exists; trigger: no host by 26 Oct → fallback 30 Nov |
| R-2 | Build service serial: 5 simultaneous builds queue (≈ 2.7 min for the 5th) or are refused (`maxQueued 3`) | H | H | Alpha policy queue ≥ 10 (no refusals); parallel workers if B-4 > 2 min (gated code change) |
| R-3 | Pacing degrades below 0.995× at 5 sessions + builds | M | H | 6 OCPU, ≤ 60 % peak target; build CPUQuota/weight already below QEMU's; verified at 5 Nov |
| R-4 | Free-allowance ambiguity / account type blocks provisioning ("out of host capacity", Always-Free-only account) | M | H | O-1 early; PAYG; fallback: option A (resize) |
| R-5 | A second host's security posture (new gate, secrets) | M | M | Same install scripts and gate model as dev-lab; checklist in the runbook; no new services |
| R-6 | One implementer across H1–H8, the capacity track and the R4 probe | H | H | R4 probe only in slack; H1/H2 scope fixed; P0 order: H5 > H6 > H1/H2 > H3/H4/H7 |
| R-7 | Owner availability (O-1…O-7) | M | H | Dates fixed above |
| R-8 | Ratings coverage limited by published data | M | M | Unrated parts say so; no invented limits |
| R-9 | Late runtime change | L | H | The alpha candidate stays on Runtime v2 unless R4 clears R4-B by 5 Nov |
| R-10 | Testers' projects are local-first | L | M | Export/import verified (§3); guidance in the tester guide |

## 9. Schedule

| Date | Milestone |
|---|---|
| 12–16 Oct | H8 ✓; H6 runbook; H5 policy + harness extensions (local); O-1; R4 probe (2 d, slack) |
| 16–23 Oct | H1, H2; R4 probe report → PM; **23 Oct infrastructure decision** |
| 23 Oct – 1 Nov | Alpha host provisioning (if B) → capacity track runs; H3; H4 |
| **5 Nov** | **Five-session acceptance benchmark**; hardening Gate C (after Owner Smoke) |
| 6 Nov | RC freeze |
| 9–11 Nov | Internal dry run (H7) |
| **12 Nov** | **Alpha go/no-go** |
| **16 Nov** | Alpha; fallback **30 Nov** if R-1 triggers |
