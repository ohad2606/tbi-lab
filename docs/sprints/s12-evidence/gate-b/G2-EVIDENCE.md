# Gate B — G-2 evidence (round 2, 2026-10-10)

**Status: STOPPED for PM acceptance.** The investigation found a **pre-existing Session Host
defect** (present since R2, on dev-lab today) that also invalidates the Sprint 12 `s12-determinism`
pins. A fix is committed locally (not deployed). Every re-pin below is a **proposal**; only TbiDht22
is re-pinned (PM-accepted, and still equivalent under the fixed host). Gate B B4b–B7 not resumed.

Method: test-only instrumentation. The harness's `runSession` handler was wrapped (`vi.mock`) to
record every bridge frame and reply with its exact simulated time, plus the Session Host's
published events; the diagnostics are in [g2/](g2/) (`zz-*.ts.txt`). Old and new images ran the
same scenario on the same clean-built Runtime v2 `b5b34b49cb7e4049`.

## H-1 — Session Host publication defect (found here; fix committed locally)

QEMU arms bridge ticks on the 1 ms grid but reports the virtual clock at which the tick ran, which
can be an instruction past the deadline (+4 ns observed). The host published a window only on a tick
at an **exact** multiple of 10 ms (`runtime/host/session.ts`, since R2 `02a530b`):

- a single late tick at a boundary: that window was **skipped** (its GPIO activity folded into the
  next window, **its operating point never published**) — HC-SR04 workloads: 22 events missing in
  3 s, including the echo-high states;
- late ticks persisting (a row-scan workload): the session **stopped publishing entirely** while the
  simulation ran on (v1 runtime `33e35e4ac5e798d7` and v2 alike).

Fix (`97de8e7` + `1cc45ac`): before any frame is handled, every window that ends strictly before it
is published, stamped with its boundary; a tick exactly on a boundary closes it after its commands
(the V1 timing). Exact ticks: byte-identical output (`r1-determinism`, pacing, curated examples, R2,
R3, r2-acceptance all reproduce their pins/assertions). Regression test with late ticks: fails 3/3
without the fix. Unit suite 1013/1013, typecheck, lint.

Consequence: all seven `s12-determinism` pins were taken with windows skipped. Under the fixed host
(each 3/3 deterministic):

| Scenario | Pin today (defective host) | Fixed host, current images | Fixed host, new images |
|---|---|---|---|
| hcsr04-0.1m | `2371e2174c387d9c` | `b0d9a191756612ba` | `a6174faf18931c61` |
| hcsr04-1m | `caa97d8064a84841` | `efe9ac9393687eb6` | `f5c51475cc5dac18` |
| hcsr04-4m | `43dba895631b86e4` | `188a0e63e70a16bf` | `ce7868f0e5352722` |
| dht22 −10 °C/30 % | `85e3e8d5cf6c46bb` | `b87741773a4f3c7a` | `b87741773a4f3c7a` |
| dht22 21.5 °C/55.2 % | `838e065211c66629` | `414a2379065bc425` | `414a2379065bc425` |
| dht22 60 °C/95 % | `afcb868539a8f893` | `10af087aa4803ee2` | `10af087aa4803ee2` |
| lcd1602-hello | `2ec207126b9067ba` | `03d6e5f264ed9506` | `03d6e5f264ed9506` |

All columns measured with the final host (`1cc45ac`), 3 runs each ([g2/batch3-final-host.log](g2/batch3-final-host.log)); pins to be established at 10 runs on acceptance.

## Per image

All new hashes are reproduced byte-exact by five independent clean builds (two toolchain installs,
plain and symlinked runtime homes; [g2-builds.txt](g2-builds.txt)); no new image contains a host path.

| Image | Old → new sha256 | Exact behavioural difference | Electrical | Timing | Determinism | Proposal |
|---|---|---|---|---|---|---|
| **TbiDht22** | `a2e6b54c…` → `1c9a0e52…` | **none**: identical published streams (3 points), old and new host | identical | identical | 10/10 + 3/3 | re-pinned (`97a4567`), stands |
| **TbiLcd** | `2f70c09c…` → `d8819c06…` | bridge: all 566 records identical in content and order; times −8/−9 ns. Published stream **identical** under the fixed host (the earlier 1 ns stamp difference came from the first fix) | identical (5/5 states, LCD text and backlight) | −8/−9 ns, no startup shift | 3/3 | **re-pin** (equivalence proven under the fixed host); restored to old pin in `20c9289` until accepted |
| **TbiHcSr04** | `620e0627…` → `9fd371b1…` | bridge records identical in content and order (trigger widths 10.92/11.22 µs, echo widths 582 377 / 5 823 773 / 23 295 091 ns, echo rise = trigger fall + 200 000 ns, readings `D 582/5823/23295`); boot ROM and bootloader identical; **app start +1.000 000 ms**; steady state +0.999 988..0.999 992 ms (the loop 8–12 ns different over 3 s). The published difference is the setup measurement's echo straddling the 0.89 s window boundary in the old image only | same distinct operating points; sequence differs only by that window | startup +1 ms (real, from layout); device timing ns-exact (startup-independent test, below) | 10/10 + 3/3 | **re-pin** the 3 T-DET-4 pins with the deviation documented, **plus** the startup-independent device test |
| **TbiI2cProbe** | `6f75261c…` → `768f52b5…` | with the s12-r3 targets (LCD 0x27, register file 0x50): all 450 bus phases identical in address, data, order and ACK/NACK (scan 1–126, 152 writes, 105 reads, 129 NACKs); P-1..P-9 PASS, serial identical. Timing: app start +1 ms; 56 inter-probe gaps ±96 ns (cancelling pairs); one ±1.26 µs pair (other-core tick); one STOP +19 ns (first transaction 382 832 → 382 851 ns, D-9 window 360–450 µs) | identical (host level: 3/3 states and sequence) | as stated; within-transaction byte timing identical except that STOP | 3/3 | **re-pin** (no pin of its own; s12-r3 passes with it) |
| **TbiEdgeEcho** | `8cf4804d…` → `6ceb6ac3…` | identical edge capture logic; its `digitalRead`+`micros()` loop takes **≈ 12 µs** under QEMU (latency uniform 0–11 µs in a 240-edge sweep, both images), plus interrupt service (UART TX up to 115 µs, other-core tick ≤ 6.2 µs). The s12-bridge 5 µs spacing check therefore measured firmware polling, and passed with the old image by phase | n/a | firmware latency phase-dependent, both images | deterministic | **re-pin**, and move R2's strict criterion to TbiEdgeTime (below); EdgeEcho keeps X-cancel and quantum equality |
| **TbiR1Scan** | `5ddd7129…` → `b86f9c5e…` | repaired scenario (r1-matrix-perf's matrix, static then scanning): bridge records identical in content and order (10 299), serial identical, total transitions per pad identical. The new image's scan loop drifts against the old (+2.3 µs at 2.57 s → ≈ 20 µs after 1 s, ≈ 20 ppm: a different instruction count per loop from layout), so 9 of 182 published events differ where a row write falls on the other side of a 10 ms boundary | same total activity; 3 windows' end states differ by that attribution | ≈ 20 ppm loop-rate difference (real, firmware) | deterministic | **re-pin** (no pin; r1-matrix-perf is a performance measurement and passes) — PM to judge the 20 ppm deviation |

## Bridge scheduling measured separately (EdgeEcho question)

TbiEdgeTime (new test firmware, proposed; reproducible `b85bf69d…`): interrupts masked, GPIO input
register polled, edges timestamped with the CPU cycle counter. On the s12-bridge schedule all 8
edges are seen **0 to −50 ns** from their scheduled spacing, 1 ms and 10 ms quanta identical; in a
720-edge phase sweep every edge is within ±75 ns **except edges falling 543.0–549.2 µs into a
simulated millisecond**, which are seen exactly at 549.2 µs (lateness linear in phase): QEMU runs the
two cores in turn on one host thread and the other core services its 1 kHz tick then.

**New fidelity finding (F-R2-1):** a core polling an input is blind ≈ 6.2 µs per simulated ms;
an edge in that interval is observed up to 6.2 µs late. Real ESP32 cores run concurrently. It
affects any µs measurement (e.g. pulseIn) when an edge lands in the interval (≈ 0.6 % of edges).
Not caused by the images. Proposal: record as a V1 limitation; investigate per-core execution in
the emulator as backlog.

**Finding F-R2-2:** the first HC-SR04 reading of a session at 4 m is 23 294 µs against an oracle of
23 295.09 µs (−1.09 µs), outside T-R2-2's 1 µs bound; later readings are 23 295. Same for both images
and before the host fix; `s12-r2` does not see it (it reads only after a live change). The echo
edges themselves are ns-exact, so this is the firmware's first `pulseIn` call. Not widened.

## Proposed changes (for acceptance; not applied)

1. Accept the host fix (`97de8e7`, `1cc45ac`) and re-establish the seven `s12-determinism` pins at
   10 runs under it (the table above), with the HC-SR04 deviation documented.
2. Re-pin TbiLcd, TbiHcSr04, TbiI2cProbe, TbiEdgeEcho, TbiR1Scan to the reproducible images.
3. Add the startup-independent HC-SR04 test ([patch](g2/proposed-s12-r2-timing.patch)): every echo
   equals the oracle for its own trigger, to the ns (passes at 0.1/1/4 m and 1 m at 35 °C); the
   reading bound stays T-R2-2's — so its 4 m case fails on F-R2-2 until that is decided.
4. Add TbiEdgeTime and the strict bridge-timing test ([firmware](g2/proposed-TbiEdgeTime.patch),
   [test](g2/proposed-s12-bridge-timing.patch)): ±0.1 µs on the s12-bridge schedule, the other-core
   interval bounded at 6.5 µs and recorded; replace the EdgeEcho 5 µs spacing assertion with it.
5. Deploying the host fix to dev-lab (it has the defect today) is a separate Gate C decision.
