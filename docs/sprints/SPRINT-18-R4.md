# Sprint 18 — R4 final hardening, R4-B (staging) and R4-C (DEV-Lab)

**Environment:** DEV only, host `tbi-lab-srv` (verified). **Branch:** `sprint-15-r4` (PR #7, draft,
not merged). **Date:** 2026-10-20. Alpha and production untouched. Progress log (restartable):
`~/tbi-s18/PROGRESS.md` on DEV.

## 0. Baseline (verified, not assumed)

| Item | Value at start |
|---|---|
| `sprint-15-r4` | `6d8fded` = origin; PR #7 draft, CI 3/3 green |
| DEV-Lab | frontend + services RC4 `71c4ce7`, Runtime v2 `b5b34b49cb7e4049`, no live sessions |
| Staging `tbi-s8` | the same RC4 bundles (hash-equal) on Runtime v2 |
| Owner direction | `origin/main` `15c8469`: digital logic + 555 near-term (`docs/TODO.md`), MCU pin-capability rule (CLAUDE.md) |

**Correction to the Sprint 17C report:**
- The 17C record said staging was "not touched". Its full real-QEMU run included the
  staging-instance suites (`s8-containment` and others), which restart `tbi-s8` services by design:
  the restarts were 2026-10-19 20:00–20:08 UTC. Staging content was unchanged (bundle hashes equal).
- From this sprint on, those five suites are excluded from DEV regressions and run only as the
  staging gate's B2.

## 1. Workstream A — R4 final hardening

### F-17C-2 (PWM scaling): evidence-based optimization and limit — `3ac52b6`, review fixes `067a84b`

**Profile:**
- Every latched LEDC change re-solved every A1 operating point: 1 + N + C(N,2) + 1 solves, so 38
  for 8 pads.
- A duty change moves no operating point, because only the averaging weights depend on the duty.
- `combinePwm` itself cost 3.1 ms for 8 pads, almost all of it duty-independent.

**Micro-benchmark** (this host, engine only):

| Pads | DC solve | combinePwm before | combinePwm after (analysis cached) |
|---|---|---|---|
| 1 | 0.23–0.43 ms | 0.13 ms | 0.04 ms |
| 2 | 0.35–0.46 ms | 0.17 ms | 0.04 ms |
| 4 | 0.26–0.41 ms | 0.62 ms | 0.07 ms |
| 8 | 0.31–0.43 ms | 3.10 ms | 0.25 ms |

**Changes:**
- `EngineSession.stateKey` (engine): a canonical key of every transient solve input. The cache's
  correctness rests on its completeness; the independent review verified it.
- Host cache:
  - the solved points of a PWM pad configuration (16 entries), keyed by `stateKey` plus the
    switching and duty-0 pads;
  - an entry is stored only if solving left the engine's state unchanged;
  - `analysePwm` (refusal checks, peaks, ranges) is cached with the points.
  - Plain non-PWM solves are unchanged.
- **Budget:** `PWM_SOLVE_BUDGET_PER_SIM_S = 1000` uncached solves for **changes of the
  switching-pad configuration** per simulated second.
  - Beyond it the session is refused: `pwm_unsupported` / `pwm_rate_exceeded`, with EN/HE text.
  - The refusal is deterministic and nothing is slowed or approximated.
  - Misses caused by other inputs (digital edges, live controls) are not charged: they cost what
    every solve cost before.

**Measured** (`runtime/host/tests/r4-pwm-scaling.test.ts`, `TBI_PERF=1`; fake runtime, unpaced):

| Scenario | Before | After |
|---|---|---|
| Solves per latched change, 8 channels fading | 39.2 | **0** after the first configuration |
| Host reaction per change (steady), 8 channels | 18.9 ms | **0.33 ms** |
| 1 / 2 / 4 channels, steady reaction | — | 0.09–0.12 / 0.10–0.21 / 0.22–0.23 ms |
| Staggered 8-channel fade through 100 % (512 ms period), first 1.1 s | — | 288 solves (exact, asserted); the second period all cache hits |
| A new configuration every 1 ms cycle | — | refused `pwm_rate_exceeded` at 70.5 ms simulated, identical on every run |
| Cached vs uncached: every reaction's operating point and every published event | — | **byte-identical** |

**Independent review** (read-only agent): the cache, `stateKey` and the `analysePwm` split are
correct. Fixed in `067a84b`:
- the budget scope;
- a refusal during the I2C backlight re-solve now ends the reaction;
- failure-path parity with the uncached code;
- stored builds carry `FEATURES_ANALYZER`, so builds cached before a new rule are rebuilt;
- C++14 digit separators no longer hide calls from the source rules;
- new tests: `stateKey` per input kind and for a relay armature moved by a solve; budget scope;
  exact solve count.

### F-17C-1 (CPU clock changes): documented and refused early — `3ac52b6`

**Probes on Runtime v3** (scratch images; shas in `~/tbi-s18/f17c1/artifacts.txt`):

| `setCpuFrequencyMhz(f)` | Result |
|---|---|
| 160, 80, 40 MHz | returns 1; the next `delay(100)` never returns; simulated time stops ~1.2 s after the call; `stalled` |
| 20 MHz | returns 1 and reports 40 MHz; stalls the same way |
| 240 MHz (no change: the core returns early) | runs to completion |

**Refusal at Build:**
- The core's `main.cpp` calls `setCpuFrequencyMhz(F_CPU/1000000)` at boot, so the symbol is
  always linked; the builder therefore refuses from the source (`cpu_frequency`).
- What is refused: any `setCpuFrequencyMhz` call except the literal 240, and
  `rtc_clk_cpu_freq_set_config(_fast)`, `rtc_clk_cpu_freq_set_xtal` and `esp_pm_configure`.
  The last group was not measured; refusing it is conservative.
- The capability panel lists the facility (21 entries), with EN/HE texts.
- The emulator root cause (the FreeRTOS tick after a clock change) is not fixed: it needs a QEMU
  change and is not in scope. The runtime `stalled` failure remains the backstop for hidden paths.

### Preserved

- Strict duty-0 refusal (O-R4-1), unchanged; a duty-0 write that lasts less than a tick is
  tolerated, as before.
- M2 (`timer-apb-clock`), M6 (`pwm_supply_limited`), M3 and M8, with their tests.

### Regression (DEV, Runtime v3, suites run one at a time)

| Suite | Result |
|---|---|
| Unit (`b7da1c1`) | **1362 / 1362** |
| Typecheck, lint | pass |
| Browser e2e (`067a84b` + `b7da1c1`) | **235 passed, 0 failed, 30 skipped** (heavy real-stack specs, incl. the 6 new R4-B tests). One failure on `067a84b` was mine (the capability panel now has 21 entries), fixed in `b7da1c1` |
| Real QEMU, full suite on `3ac52b6` (dev QEMU build) | **37 files, 187 passed, 4 opt-in skipped**; the 5 staging-instance suites excluded (they run as B2) |
| Real QEMU, affected suites on `067a84b` | `s15-r4`, `s15-examples`, `failures`, `r2-failures`, `s7-build`, `s13-build-parallel`, `gate`: **7 files, 50 passed** |
| Real QEMU on the **release** binary (`TBI_QEMU`) | `gate`, `r1-determinism`, `s12-determinism`, `s15-r4`, `s12-r3`, `s12-bridge`, `failures`: **7 files, 55 passed**, every determinism pin unchanged |
| CI on `b7da1c1` (PR #7) | 3/3 green, run 39379989161 |

## 2. Workstream B — R4-B (staging) and R4-C (DEV-Lab)

**Gate interpretation** (for PM confirmation):
- R4-PROBE §7 required O-R4-1 resolved before R4-B, by a bench result **or** a PM decision to keep
  the refusal as documented behaviour.
- The Sprint 18 directive ("preserve the strict Duty-0 refusal until physical evidence becomes
  available", "deploy … first into safely isolated DEV staging", "deploy the approved R4 pair to
  DEV-Lab") is recorded as that decision, together with the ratification of M2/M6 and of the R4
  pair.
- O-R4-1 itself stays open: no measurement exists.

**Isolation (prerequisite):**
- Staging and DEV-Lab have separate unit prefixes, sockets, stores, keys, session roots and polkit
  rules.
- They run as the **same users** (`tbi-runtime`, `tbi-build`, `tbi-qemu`; D10 open). The union of
  the two polkit rules lets `tbi-runtime` stop either instance's QEMU units.
- The host only ever stops its own prefix (`runtime/builder/runner.ts` `stopTemplateInstances`),
  and R4 does not change the launcher, host startup or deploy scripts.
- Guard applied: no live DEV-Lab session before and during staging work; DEV-Lab state verified
  unchanged by snapshot after B1, B5 and the forward step.

**Release inputs:**

| Input | Value |
|---|---|
| Runtime v3 | clean build `~/tbi-s18-rt-release/qemu-2cb1406f94f52e4f`: id reproduced from source + patches 0001–0010 |
| Release-binary caveat | the binary is **not byte-identical** to the dev build: QEMU builds are path-dependent. It was therefore validated directly (§1, 55 tests) |
| Release artifact set | `/srv/tbi-lab/release-artifacts/ff0ea83b43e6c57d`: 18 images, each sha-verified |
| Package | `~/tbi-s18/rel/r4-b7da1c1`, `rc4` profile, build time 2026-10-20T07:00:00Z, manifest **`a4ef5d4f51a27655`**; a second build at another path is **byte-identical** (26 files, 8 source maps) |

### R4-B on staging `tbi-s8` — PASSED

| Step | Result |
|---|---|
| B0 backup | `/var/backups/tbi-lab/s18-staging-pre-20261020T062312Z`: units, polkit rule, `/etc/tbi-s8`, bundles, with SHA256SUMS |
| B1 install | `install.sh staging` from a clean checkout of `b7da1c1`, `TBI_S8_RUNTIME` = the release v3 prefix, 4.7 s. `/health` reports `b7da1c1`; bundles byte-equal to the package; runtime.json `2cb1406f94f52e4f` with `pwm` |
| B2 deployed suites (`TBI_S8_INSTANCE=tbi-s8`) | **32 passed, 2 skipped**: s11-deployed (6 + 2 old-host skips), s8-containment 9/9, s8-deployed-policy 7/7, s8-policy 7/7 (policy restored byte-equal), s8-qemu-tasks 2/2, s13-deployed-security 1/1 |
| B3 real-QEMU browser (bounded root relays, stopped by PID) | **24 passed, 2 skipped** (details below) |
| B4 resources (2 s sampling, 9 sessions) | QEMU cgroup memory peak 93–137 MiB (page cache included; cap 384 MiB), 0.66–0.89 of the vCPU per session; Session Host RSS ≤ 79 MiB |
| B5 rollback rehearsal | to RC4 + Runtime v2 from B0 in **1.4 s**; live state byte-equal to the backup (verified as root); sessions on RC4 8 passed, 2 skipped. Forward to R4 in **2.9 s**; bundles = package; sessions 8 passed, 2 skipped |

B3 batches:
- **Batch 1, R4:**
  - LED fade (GPIO18 waveform, average shown);
  - SG90 at 0 / 90 / 180°;
  - three PWM channels at 25 / 50 / 75 %: every pad a waveform, LED currents 1 : 2 : 3 within
    display rounding; the project persists across a reload and runs again;
  - duty 0 into an LED refused, named, in English, then the same message in Hebrew;
  - a CPU clock change refused at Build (`cpu_frequency`);
  - QEMU SIGKILLed during a run → `runtime_crashed`, and a new Run works;
  - the Session Host restarted during a run → a named failure, and a new Run works;
  - **8 / 8**.
- **Batch 2, R1–R3:** s6 blink / input echo / product determinism; s11 motion alarm, night light,
  R1 parts; s12 HC-SR04, DHT22, LCD. **9 passed, 2 skipped** (old-host cases).
- **Batch 3, S13:** live night light and distance alarm; OS-09 (LCD miswired) and P4 (drive
  strength). **4 passed.**
  - journey EN→HE and HE→EN, and export/import: the first attempts hit the specs' default 60 s
    test timeout during the first (cold) build;
  - cold because `FEATURES_ANALYZER` invalidates cached builds once, by design;
  - rerun with a 10-minute test timeout: **3 / 3 passed**.

### R4-C on DEV-Lab — DEPLOYED

**DEV-Lab now serves `b7da1c1be66c43023c19eac220a96b86ca9ec5d6`** (frontend and Session Host /
build service) on **Runtime v3 `2cb1406f94f52e4f`**, since 2026-10-20 07:24 UTC.

- Pre-check: 0 live sessions. Backup: `~/tbi-s18/r4c/devlab-backup-20261020T072311Z` (units,
  polkit rule, Caddyfile, tmpfiles, policy, runtime.json, links; SHA256SUMS).
- `/srv/tbi-lab/services/b7da1c1…/`: byte copies of the package, plus a MANIFEST.json that replaces
  `71c4ce7`.
- `/srv/tbi-lab/dev-lab/b7da1c1…/`: the package frontend.
- Both `current` links switched; `install.sh dev-lab` with the release v3 prefix.
- **The only unit change:** the QEMU runtime bind. The build, build-job and session-host units, the
  polkit rule and the Caddyfile are unchanged.
- Through the gate's internal origin: `index.html`, `version.json` and all assets, **23 files,
  byte-identical** to the package; `/version.json` = `b7da1c1`. The public site stays gated (302).
- Deployed suites on DEV-Lab (`TBI_S8_INSTANCE=tbi`): **15 passed, 2 skipped**: s8-deployed-policy
  7/7, s8-qemu-tasks 2/2, s11-deployed 6 + 2. This is the same set and profile as the RC4
  deployment.
- **Rollback, rehearsed:** `~/tbi-s18/r4c/rollback-devlab-r4.sh back`.
  - It switches both links to `71c4ce7` and the runtime to v2 (`switch-runtime.sh`), and restarts
    the host, always as a pair.
  - Measured 1.16 s; afterwards units and runtime.json are byte-equal to the backup, `/health` and
    `/version.json` report `71c4ce7`, and s8-qemu-tasks passes 2/2.
  - `forward`: 1.1 s, then 8 passed and 2 skipped.
- Known rollback effect (S3): an RC4 frontend shows "invalid" for projects containing a servo and
  leaves them stored unchanged.
- **Not done:** browser runs through the real Google login (needs the owner; RC4 precedent).

### Owner acceptance checklist on DEV-Lab (real Google login)

1. `/version.json` shows `b7da1c1…`.
2. ESP32 **LED fade** example: Build → Run. The LED dims up and down; selecting GPIO18 on the
   board shows a PWM waveform; Stop.
3. ESP32 **servo sweep**: Build → Run. The SG90 angle shows 0°, about 90° and 180° in turn; Stop.
4. **Duty 0:** in the fade example, replace `analogWrite(LED_PIN, 1);` in `setup()` with
   `ledcAttach(LED_PIN, 1000, 8); ledcWrite(LED_PIN, 0); while (true) delay(1000);` → Build → Run.
   The simulator stops with the "duty 0 … not verified" message naming GPIO18. Switch to עברית:
   the same message in Hebrew. (This is the case verified on staging; `analogWrite(pin, 0)` was
   not separately verified.)
5. **CPU clock:** add `setCpuFrequencyMhz(80);` to `setup()` → Build. The build lists
   "CPU clock change"; Run is refused.
6. **EN/HE and persistence:** switch languages (code and serial stay left-to-right), reload,
   reopen the project: unchanged.

## 3. Findings and limitations (new or confirmed)

- **F-18-1:** QEMU release builds are not byte-reproducible across build directories; only the
  runtime id is. Validate a release binary on the pinned suites (`TBI_QEMU`).
- **F-18-2:** `FEATURES_ANALYZER` bumps make every cached build cold once after a deploy (first
  Build ~30–40 s). The Sprint 13 real specs need a longer test timeout on a cold store.
- **D10:** staging and DEV-Lab still share users. Acceptable on DEV with the guard above; required
  before any shared or Alpha staging.
- **F-17C-1:** the emulator root cause remains. Refused at Build for every visible path.
- **The budget's limit:** misses from non-PWM inputs while many PWM pads switch still cost a full
  set of solves each, as before R4's cache. That is unbounded only in the same way as GPIO toggling
  is today.

## 4. Approvals still needed

1. Confirmation of the gate interpretation (§2): the duty-0 refusal as documented behaviour.
2. Owner acceptance on DEV-Lab (checklist above).
3. Merge of PR #7, and any Alpha decision. Neither was requested; neither was done.
