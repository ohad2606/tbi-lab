# Sprint 10 — Physical 3D, engine time-domain core, the approved component families

**Status (2026-10-06):** developed on `sprint-10` (worktree `~/projects/tbi-lab-s10`), from
`7f09d74` = `main` = `sprint-9-complete`. **dev-lab.tbi-tech.net serves `afe3605`**, shown in the
app as `v0.10-dev · afe3605` and in `/version.json` (Part G). The old preview routes are retired.
**Owner review PENDING**: confirm the version, then the ESP32 GND routing case.

Not done: no PR, merge, tag, production deployment or backend deployment. The backends are unchanged
(`c31d62e`, runtime `33e35e4ac5e798d7`). The isolated preview `/s10-preview/` stays.

Architecture and scope: [SPRINT-10-ARCHITECTURE.md](SPRINT-10-ARCHITECTURE.md).

## Part G — build identity: why the owner saw an old build (2026-10-06)

**Root cause (gate request log, no assumption).**
- Every authenticated page load from the owner's Windows Chrome today was
  `https://dev-lab.tbi-tech.net/s9-preview/`. That is the old Sprint 9 preview: its own web root,
  its own build with the "Sprint 9 preview · experimental" banner, and the old routing.
- That browser requested `/` only once, a sign-in redirect at 09:29.
- `/` itself served the reported builds: `index.html` and the fallback are `no-store`, only
  content-hashed `/assets/*` are immutable, and there is no service worker.
- The post-deploy checks validated `/` through the gate's internal origin, never the route the
  owner was actually using.

**Changes (`cab4914`–`afe3605`).**
- **Build identity, one object per build, made at build time** (`app/buildInfo.config.ts`):
  - inputs: `VERSION` = `0.10-dev`; the exact commit (`TBI_BUILD_COMMIT`, set by the deploy script,
    else git); environment; build time;
  - compiled into the app and emitted as `/version.json`, so the visible version is the code
    running.
- **Status line** at the bottom of every screen: `v0.10-dev · <short sha>`.
  - Hover, focus or click shows product, version, environment, full commit and build time.
  - Runtime ID shows as "not reported by the backend": no backend API exposes it, and the backend
    is unchanged.
  - Technical tokens stay left-to-right in Hebrew.
- **`publish-frontend.sh` + `verify-build.mjs`:**
  - before the switch: the build's `/version.json` names the commit (dev-lab, clean), the bundle
    carries it, every referenced asset is present;
  - after the switch, on the gate's origin: `/version.json` (commit, `no-store`), `/` byte for byte
    (`no-store`), every asset (hash, immutable);
  - the public HTTPS site is up and gated (302 to Google sign-in);
  - any mismatch rolls back and fails;
  - it ends with "dev-lab now serves <commit>".
- **Old preview routes retired** (`retire-preview.sh`, no Caddy change, `/` never redirected):
  - `/s9-preview/` and `/s10-preview/`, deep links included, now show a "this preview has been
    retired" page (EN/HE) linking to `/`;
  - the old builds stay on disk; the re-open commands are in the deploy log;
  - projects created in a preview stay in that browser's preview storage (re-open the route to
    export them).
- **Not changed (needs approval if wanted):**
  - the public `/version.json` is behind the Google sign-in like everything else, so the script
    reads it through the gate's origin. Making that one file public would be an auth change.
  - a tab left open across a deploy keeps running the old code (lazy chunks of the old build are
    no longer served). A "new version available, reload" prompt would close that gap.

**Tests.**
- Unit `build-info.test.ts`: fields, deterministic apart from the timestamp, malformed identities
  refused, dirty marker, Hebrew keys, no preview name in a normal build.
- Browser `version.spec.ts`: visible version = served `/version.json`, details, Hebrew LTR, no
  preview label.
- Hebrew translation scans skip the status line (technical identity).
- The 3D asset spec waits for the scene stats (race fixed).

**Validation.**
- Full suite on `afe3605`:
  - typecheck, lint with boundaries, build: pass;
  - unit: **755 passed**, 80 files;
  - browser: **148 passed**, 3 skipped, **0 failed**;
  - legacy browser: pass.
- An overlapping run by a second session in this worktree was stopped and discarded; this result is
  from a fresh run.

**dev-lab now serves `afe3605`** (`afe3605be57b865231d2c88cdb6762bfc5aa529c`), verified by
`publish-frontend.sh`.

| Post-deploy check | Result |
|---|---|
| Served `/version.json` | commit `afe3605…`, environment `dev-lab`, clean; `no-store` |
| Served `/` | the release `index.html` byte for byte; `no-store` |
| Served assets | content-hashed, immutable |
| Public site | 302 to sign-in |
| Live checks | **40/40**: visible `v0.10-dev · afe3605` equals `/version.json` (EN and HE, LTR), details, the owner GND case (route, no marker, netlist), 3D asset, examples |
| Sprint 9 smoke | 48 passed, including ESP32 Build -> Run -> Stop |
| Services, backend files, Caddy, QEMU and runtime ID | unchanged |

Rollback target `9c94329` intact:
```
sudo ln -sfn /srv/tbi-lab/dev-lab/9c94329691e69dabc42abc938f21b3a7388167d5 /srv/tbi-lab/dev-lab/current.tmp
sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
```

Evidence: [s10-evidence/version/](s10-evidence/version/). It includes the GND case with
`v0.10-dev · afe3605` visible, and the version details in EN and HE.

**Owner review: PENDING.** Open `https://dev-lab.tbi-tech.net/` and confirm the status line reads
`v0.10-dev · afe3605` before checking the GND routing case.

## Part F — second owner block: header-row routing, and the high-fidelity 3D proof set (2026-10-06)

**Owner review BLOCKED again (two issues).**
1. The live demo still let an ESP32 GND wire run visually along the J3 pin column.
2. The 3D realism target was raised to high-fidelity component visualization.

Smoke stopped and R1 not started. New standing rule: dev-lab is the only owner/dev test target;
every validated frontend goes there with a rollback; report the exact commit served.

### F.1 Routing: remaining root cause and fix (`5bc708c`)

**Root cause (measured on the deployed `2b014c2`).** The point keep-out only stopped a route
crossing a pin's centre.
- The deployed owner route left the GND pin straight up the J3 column's own line,
  `(140,-180) -> (140,-220)`, then went round the board. That is the rail's continuation.
- Other routes ran one grid step beside a whole header (only a soft "hug" cost, with the pin's own
  neighbours exempt).
- Measured with a 30-unit band around each header row: 1985 of 1985 routes in the blink example
  and 1191 of 2093 in a fresh project entered it.
- Two contributing defects:
  - the grid search priced an endpoint's straight exit per step, preferring short band crossings;
  - stored wires from older versions were never repaired, so a project saved before the fix kept
    its old route.

**Header-row exclusion band (rank 2, after the point keep-out).**
- Each board header row is its pins and stubs, from the board edge to the pin points, built from
  the board's header geometry for any rotation, not hard-coded to one screenshot.
- That row is grown by `HEADER_CLEARANCE` = 50 units: the nearest usable line is 60 units from the
  pin centres, about 54 units of clear space to a marker.
- Only a hop endpoint's straight, perpendicular, outward exit may cross the band. The search
  exempts every step of that exit line. Widening continues while a keep-out remains.
- The point keep-out (10 units), the stub lead-ins and the same-net / overlap / body ranking stay
  as before.

**Stored wires.**
- `repairWireRoutes` runs when a project is opened, imported or copied from an example. A stored
  wire that enters a keep-out or a band is re-routed: presentation only, the same endpoints and
  nets. Every other wire keeps its exact route.
- The `wire_over_terminal` check still guards what routing cannot prevent: a part dropped with a
  lead on a wire.
- Two examples were adjusted to the rule:
  - esp32-input-echo: the pull-down branch moved three grid steps clear of J2;
  - rc-fade: W4 as a clean L.

**Owner case result.** GND leaves straight out to the right (60 units), goes over the top of the
board, runs down 60 units clear of J2, and turns into the ground:
`140,-180 200,-180 200,-240 -80,-240 -80,220 -20,220`.

**Audits.**
- Band intrusions: 0 of 49,625 routes from every ESP32 terminal to every ground position (blink).
- Pins crossed: 0 in every sweep.
- Body crossings occur only where a pin is boxed in by its neighbours and a junction or part on
  three sides. All are in the input-echo example's original layout.
- Route time: median 2–4 ms; p99 18–40 ms.

**Tests.** The required cases assert measured geometry, not only nets:
- domain `route-keepout.test.ts`:
  - visible ink gaps to every unrelated pin marker and stub (≥ 12 next to the route's own ends,
    ≥ 50 elsewhere) and band length 0;
  - owner case both ways, the position sweep, legacy repair, generic third terminal, dense pins,
    boxed-in pin, save/load.
- browser `routing-keepout.spec.ts`:
  - reads the drawn SVG (wire, markers, stubs, in world units, with real stroke widths);
  - the owner flow, and a legacy project opening repaired.
- Sprint 4 A12/A13 updated: legacy crossing repaired on open; the check fires when a part is dropped
  onto a wire.

### F.2 High-fidelity 3D proof set (`904f7f7`, `2c96547`)

ESP32-DevKitC, resistor and 5 mm LED only. Every other part waits for the owner's approval of the
visual standard. Architecture, asset pipeline, model records, tiered roadmap, and the approved
model-driven behaviour and failure direction: [3D-HIGH-FIDELITY-ROADMAP.md](../product/3D-HIGH-FIDELITY-ROADMAP.md).

**Models.**
- **ESP32-DevKitC V4: a glTF asset**
  - authored in the repository from Espressif's dimension drawings;
  - deterministic export, byte-identical rebuild checked by test;
  - loaded lazily when 3D opens;
  - silkscreen and can marking drawn at runtime.
- **Resistor: procedural.**
  - lacquer dog-bone with end caps and lead necks;
  - bands painted on the body;
  - carbon-film (4 bands) or metal-film (5 bands) finish;
  - formed leads.
- **LED: procedural.**
  - drafted lens and dome, flange flat;
  - visible lead frame;
  - legs at the real 2.54 mm pitch as its anchors (wires now end on the legs).

**Consistency tests on the built geometry** (`scene3d-anchors.test.ts`):
- connected R -> LED;
- disconnected-but-touching (more than 0.5 mm apart);
- direct contact (joint on the leg, link to the lead);
- ESP32 pin wiring (wire on the housing over the pin).

**Camera.** Standard views Top / Front / Side / Rear (EN/HE).

**Asset sizes.**
- ESP32 GLB: 483,268 bytes raw, 98 KB gzip (dev-lab serves it uncompressed, immutable-cached);
  17k vertices, 15k triangles.
- Resistor and LED: no files (procedural).

**Bundle.**
- Start-up chunk unchanged by the 3D work (byte-identical size before and after it).
- Since the deployed `bd78d2e`, +7.0 kB raw / +2.8 kB gzip (302.7 -> 309.7 kB, 96.9 -> 99.7 kB),
  from the routing code.
- The lazy 3D chunk: 634.5 -> 713.5 kB raw (159.4 -> 181.5 kB gzip), mostly the glTF loader.

**Performance** (this host: 1 vCPU ARM, no GPU, Chrome with SwiftShader).
- `reduced` quality is what software rasterisers get. First open and re-opens are unchanged from
  before:
  - esp32-blink: 8.96 s / 0.47 s / 0.59 s before, 8.94 s / 0.54 s / 0.56 s after;
  - asset fetch and parse: 38–89 ms.
- GPU memory estimate and frame time (`reduced` quality):

  | Scene | GPU memory (est.) | Frame median |
  |---|---|---|
  | esp32-blink | 9.1 MiB | 4.2 ms |
  | board alone | 7.3 MiB | 3.5 ms |
  | resistor | 0.7 MiB | 0.6 ms |
  | LED | 0.4 MiB | 1.3 ms |

- `full` quality (real GPUs: studio environment and physical materials) cannot be measured on real
  hardware here. Forced on this software rasteriser it costs 10.9 s first open and about 2.8 s
  re-open, against 4.2 / 0.55 s before. Shown honestly, not claimed for GPUs.
- Repeated enter/leave keeps resources flat (the existing 20-cycle browser test passes).
- Rendering stays on demand (no loop).

**Evidence.** Before/after front/top/side views and the owner's GND case on the live demo:
[s10-evidence/3d-proof/](s10-evidence/3d-proof/).

### F.3 Validation and deployment

| Check | Result |
|---|---|
| Full suite on `9c94329`: typecheck, lint with boundaries, build | pass |
| Unit | **748 passed**, 79 files |
| Browser, complete suite | **147 passed**, 3 skipped, **0 failed** |
| Legacy browser | 4 passed |

- The run on `2c96547` had 1 real failure: Sprint 4 A12/A13 tested the warning on legacy geometry
  that opening now repairs. The test was updated (`9c94329`) and the complete suite re-run clean.

**dev-lab.tbi-tech.net now serves `9c94329`** (`9c94329691e69dabc42abc938f21b3a7388167d5`),
published with `publish-frontend.sh`; previous release `2b014c2`.

| Post-deploy check | Result |
|---|---|
| Installed tree | byte-identical to an independent clean pre-build (17 files) |
| Served files | **17/17** hash-match |
| Sprint 10 demo checks | **36/36**: owner GND route, no marker, exported netlist (only U1.gnd in the new ground's net), GLB not fetched at start-up, fetched once on 3D open, no re-fetch, standard views |
| Sprint 9 smoke | all 48 passed, including ESP32 Build -> Run -> Stop on the unchanged backend |
| Services, start times and PIDs | unchanged |
| Backend files `c31d62e`, the session-host bundle in both running hosts, Caddy | unchanged |
| QEMU `538af3d7…`, runtime `33e35e4ac5e798d7` | unchanged |

Rollback (atomic, no restart):
```
sudo ln -sfn /srv/tbi-lab/dev-lab/2b014c283e906471a10de0247a84601d7387e330 /srv/tbi-lab/dev-lab/current.tmp
sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
```
Earlier targets are also intact: `bd78d2e` and `198ca92`.

**Owner review: PENDING.** First the GND routing case, then the 3D visual standard (proof set).
R1 not started; no PR, merge, tag or production change.

## Part E — owner smoke BLOCKED: wire routed through ESP32 pins (2026-10-06)

**Report (owner).** In an ESP32 project, connecting the ESP32 GND pin to a ground gave an
automatic route straight down the right-hand pin row (J3), over many unrelated pin circles: it
looked as if those pins were tied together. Release blocker; smoke stopped; R1 not started.

**Root cause** (`packages/domain/src/route.ts`, reproduced numerically).
- The router compared routes lexicographically by:
  1. overlap with an existing wire;
  2. length through a body;
  3. "touches", which included passing through a terminal.
- A terminal was only an exact point (no clearance), and only L-shapes and three-segment
  channels were tried.
- In the blink example the GND pin is already wired out to the right. Every clean way round
  started by running 20 units along that wire (rank 1), and going left crossed the board
  (rank 2). The route down the J3 column, through 18 pins, therefore won on rank 3.
- Sweep with the old router, a ground at every grid position around the board:
  - GND wire: 698 of 4186 routes passed over unrelated pins;
  - every ESP32 terminal: 1196 of 5700 (blink) and 2509 of 5375 (input-echo).
- A fresh project's single GND wire, and the re-routing of a dragged wire (Sprint 9), were already
  clean (0 of 4186 and 0 of 2093). The defect needs existing wires near the pin.

**Fix (`0bc0e98`): terminal keep-out.**
- **Keep-out rule.** A route segment closer than `TERMINAL_KEEP_OUT` = 10 units (half a grid step)
  to a terminal, board header pin (all 38, wireable or not) or junction ENTERS it. This is larger
  than every marker drawn there (terminal mark r 3.5, junction dot r 4.5, hit area r 9).
  - Only the hop's own source and destination are exempt.
  - A board's drawn pin **lead-ins** (the stubs from the board edge to each pin) are keep-out
    too, so a wire never runs along the board edge where the stubs meet it (that reads as a bus).
- **New ranking:**
  1. keep-out;
  2. overlap with an unrelated wire;
  3. body;
  4. running along a wire attached at the hop's own endpoint (same terminal, same net: nothing
     false is implied);
  5. T-touches on wires;
  6. **pin-field clearance**: a header pin one grid step beside the route; the pins next to the
     route's own endpoint are exempt;
  7. bends and crossings;
  8. length.
- **Detours.** When none of the short shapes is clean, a deterministic grid A* runs with the same
  priorities (any number of bends, around the board or dense parts). Its area widens (doubling)
  while a keep-out remains. It is used only when it is better.
- No fake bridges over pins: routes never enter the pin zones.

**Connectivity is unchanged in kind.**
- Nets come only from explicit endpoints, junctions and direct contacts (terminal snapped to
  terminal).
- A wire crossing a pin or a wire never connects. A stored wire that does cross pins (an older
  project) still connects nothing it crosses, and keeps the `wire_over_terminal` warning.
- No schema or serialization change. Stored wires are not rewritten on load. A wire is re-routed
  only when a part it is attached to is moved (Sprint 9 behaviour, now with the new rule).

**Result (same sweeps).**
- 0 routes over unrelated pins: GND 0 of 4186, both directions; all terminals 0 of 5700 and 0 of 5375.
- 0 through a body in blink.
- In input-echo, 8 pins are boxed in at every position (215 each, 1720 routes) by neighbour
  pins, an adjacent resistor or a junction on three sides. They cross a body instead of a pin,
  which is the intended fallback.
- Time per new-wire route: median 2–3 ms, p99 about 20 ms, worst about 16 ms warm.

**Regression tests.**
- `packages/domain/tests/route-keepout.test.ts` (8):
  - the owner case in both directions (exact route, no pin, lead or body entered, pin-field clearance);
  - committed nets: only U1.gnd joins ground, and every other pin keeps its previous node;
  - an old header route connects nothing and is flagged on exactly the crossed pins;
  - a ground at every grid position: about 1000 routes, 0 entering a pin;
  - generic third terminal on the straight path;
  - dense 900-unit pin column (longer safe path);
  - boxed-in pin;
  - save/load.
- `app/tests/route-keepout-views.test.ts` (2): schematic and 3D follow connectivity for the routed
  wire and for an old header route.
- `app/e2e/routing-keepout.spec.ts` (1): the owner flow in the browser (ESP32 example, new
  ground, wire); route, markers, nets, schematic, 3D, reload.

**Validation of the fix (`2b014c2`).**

| Check | Result |
|---|---|
| Typecheck, lint with boundaries, production build | pass |
| Unit (domain routing and connectivity, schematic, 3D, cross-view, serialization) | **741 passed**, 77 files (731 + 10 new) |
| Browser, complete suite | **145 passed**, 3 skipped (the usual heavy specs), **0 failed** (144 + the new owner-flow spec) |
| Legacy browser | 4 passed |

- The first full run (on `0bc0e98`) had 1 failure: the Sprint 5 library test, which after
  `reload()` checked `isVisible()` before the app had rendered. That is a test race in an
  untouched area; the spec passed 3 of 3 repeats.
- It was fixed in the test (wait for the app before branching, `2b014c2`), and the complete
  suite was re-run clean.

**Republished (frontend only).**
- `2b014c2` (`2b014c283e906471a10de0247a84601d7387e330`) via `publish-frontend.sh`; previous
  release `bd78d2e`.
- Installed tree byte-identical to an independent clean pre-build (16 files).
- Rollback targets intact: `bd78d2e` (16/16) and `198ca92` (14/14). Rollback:
  ```
  sudo ln -sfn /srv/tbi-lab/dev-lab/bd78d2ebb400703d2714673487acc19d8c677a5e /srv/tbi-lab/dev-lab/current.tmp
  sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
  ```

| Post-deploy check (against `/`, fresh principals) | Result |
|---|---|
| Served files against `2b014c2` | **16/16** hash-match |
| Sprint 10 demo checks, now including the owner's GND case (route, no marker, exported netlist: only U1.gnd in the new ground's net) | **32/32** |
| Sprint 9 demo smoke, including ESP32 Build → Run → Stop on the unchanged backend | **all passed**, 0 failed |
| Services (6): start times and PIDs | unchanged |
| Backend files (`c31d62e`), session-host in both running hosts, Caddy, QEMU `538af3d7…`, runtime `33e35e4ac5e798d7` | unchanged |

Screenshot of the corrected route on the live demo: [s10-evidence/esp32-gnd-route-demo.png](s10-evidence/esp32-gnd-route-demo.png).

**Owner smoke: PENDING again.** First item: the ESP32 GND routing case. Phase R1 has not started.

## Part D — promotion to the normal demo (2026-10-06)

**Approved:** the Sprint 10 frontend and local simulation only. Static files, from the exact
validated commit. No backend, service, runtime, build-service, Caddy or auth change.

**What was promoted.**
- `bd78d2e` (`bd78d2ebb400703d2714673487acc19d8c677a5e`), published with
  `deploy/dev-lab/publish-frontend.sh bd78d2e`. It builds in a clean temporary worktree, copies to
  `/srv/tbi-lab/dev-lab/<sha>` and switches `current` atomically. No service is restarted.
- Switched at 2026-10-06 07:37:39 UTC; the previous release was `198ca92` (Sprint 9).
- The script's own checks passed: the installed tree is byte-identical to a pre-build of the same
  commit made before the switch (16 files), its manifest matches, and the rollback target is intact.

**Bundle (accepted):**
- Start-up chunk: 272.8 kB raw / 81.3 kB gzip (Part A) → 356.3 / 102.5 (Part B) → **promoted
  302.7 kB raw / 96.8 kB gzip**.
- Start-up time about 202 ms, against 190 ms for Part A and 212 ms for Part B.
- Accepted as is. Moving the engine off the main thread and loading only the active locale stay as
  lazy-loading candidates (Part C).

**Rollback.**
- A snapshot was taken before the switch: the 14 files of `198ca92` hashed, and the service
  releases, unit start times, backend hashes, Caddy configuration and runtime were fingerprinted.
- The rollback target was verified again after validation (14/14).
- Rollback is one atomic switch back. It needs no service restart:
  ```
  sudo ln -sfn /srv/tbi-lab/dev-lab/198ca926e3ef1e49f1944816a3e7d501b9bbbbbe /srv/tbi-lab/dev-lab/current.tmp
  sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
  ```

**Post-promotion validation (against `/`, through the gate's internal origin, fresh principals).**

| Check | Result |
|---|---|
| Served files against `bd78d2e` | **16/16** hash-match |
| Sprint 9 demo smoke | **47/47** |
| Sprint 10 demo checks | **29/29** |
| Services: caddy, oauth2-proxy, tbi-build, tbi-session-host, tbi-s8-build, tbi-s8-session-host | start times and PIDs identical to the snapshot |
| Backend files in `/srv/tbi-lab/services/current` (= `c31d62e`) | 3/3 hashes identical |
| Session-host bundle in each running host's own mount view | `c4965cb2…` (unchanged) |
| Caddy configuration | unchanged |
| QEMU | binary `538af3d7…f9df` unchanged; runtime id `33e35e4ac5e798d7` |
| Rollback target `198ca92` | intact |

What the two runs cover:
- **Sprint 9 smoke (47 checks):**
  - landing and project list; an existing example; an existing stored project;
  - ESP32 Build → Run (GPIO2 blinks; LED lit in 3D) → Stop, through the real build service and Session Host;
  - stale build refused; cached build;
  - schematic and 3D; reloads;
  - contacts and routing;
  - Hebrew RTL, with code, serial and schematic staying LTR;
  - every request same-origin, every asset 200, no 4xx/5xx, no console errors.
- **Sprint 10 checks (29 checks):**
  - no preview badge; assets served from `/assets/`;
  - all 8 new parts offered in a local project; lazy example chunk;
  - local simulation of all eight parts:
    - RGB LED, with a live channel change;
    - photoresistor, 3.728 V → 6.641 V with the live light level;
    - relay: hold → NO lights the LED and NC silences the buzzer;
    - 2N3904 night-light;
    - PIR → transistor → buzzer;
    - matrix dots 2.2 2.7 7.2 7.7;
  - capacitor transient: time advances, the LED fades in, discharges when the switch opens, Stop removes the time, Run restarts at t = 0;
  - schematic and 3D;
  - export and re-import of a matrix project, with language-neutral tokens;
  - ESP32 palette rule in EN and HE (RTL); no servo, I2C LCD, HC-SR04 or DHT22 offered;
  - no page errors.

**ESP32 capability gating is unchanged.** RGB LED, LDR, buzzer, relay, transistor, PIR, matrix and
capacitor are disabled in ESP32 projects. Servo, I2C LCD, HC-SR04 and DHT22 remain internal.

**Owner smoke: PENDING.** Runtime expansion waits for it. Each runtime phase (R1 backend redeploy
with the emulator unchanged, R2 microsecond inputs, R3 I2C, R4 PWM/servo) is its own approval. The
R1 plan, prepared and not executed: [docs/runtime/PHASE-R1-DEPLOYMENT-PLAN.md](../runtime/PHASE-R1-DEPLOYMENT-PLAN.md).

## Part C — pre-promotion pass (2026-10-06)

**Component-support rule.** A component is usable in a board project only when that board's runtime
can simulate it honestly. The deployed ESP32 runtime supports digital GPIO and serial only, so:
- the eight completed parts stay **COMPLETE for local circuits**;
- servo, I2C LCD, HC-SR04 and DHT22 stay **INTERNAL**;
- in an ESP32 project the palette **disables** the parts the runtime cannot simulate, with one
  localized note at the top of the palette ("Requires runtime support not available for ESP32
  yet." / "דורש תמיכת Runtime שעדיין אינה זמינה ל־ESP32."). A local project that already holds
  such parts disables the ESP32 board. The Run refusal (`mcu_component_unsupported`) remains the
  backstop for imported projects (`3c97f37`).

**Start-up bundle.** Byte attribution through the build's source maps, first-night build `d3b79b0`
→ Part B → after the change below:

| Start-up chunk | Raw | Gzip |
|---|---|---|
| `d3b79b0` (Part A) | 272.8 kB | 81.3 kB |
| Part B (`3ba2292`) | 356.3 kB | 102.5 kB |
| Now (`bd78d2e`): example documents lazy | 302.7 kB | 96.8 kB |

Where the Part B growth (+83.5 kB raw, +21.2 kB gzip) came from:

| Area | Δ raw | Δ gzip (alone) |
|---|---|---|
| Example documents (7 new examples; 16 inlined in all) | +29.5 kB (62 kB in all) | +2.5 kB (5.7 kB in all; repetitive JSON) |
| Engine code on the main thread (ratings → part registry → part models, BJT, devices) | +24.7 kB | +8.4 kB |
| i18n messages (EN + HE for the new parts) | +14.7 kB | +6.1 kB |
| UI (canvas, inspector, symbols, sound toggle) and domain catalog | +14.6 kB | +4.2 kB |

Done: the example **documents** moved to their own chunk, loaded when an example is opened and
**prefetched on idle** after start-up, so they still work offline once the app has loaded (browser
test). Metadata (titles, probes) stays eager.

Measured start-up (navigation → project list, 12 runs, this host): Part A 189–190 ms median, Part B
212 ms, now 202 ms.

Candidates not done (follow-up, each with its own risk):
- **Engine off the main thread** (about −25 kB raw, −8 kB gzip). The worker would compute rating
  warnings and attach them to the outcome, with a light GPIO-only path for ESP32 outcomes. Medium
  risk: it changes the warning data flow.
- **Only the active locale eager** (about −34 kB raw, −12 kB gzip). It touches the whole i18n
  layer; medium risk.
- **Part-specific 3D builders** are already in the lazy 3D chunk; nothing to move.

**555 timer — feasible, not started.** The time-stepped engine and the 2N3904 Gummel–Poon model now
exist, so a pin-level 555 (two comparators, an SR latch, the discharge transistor, the resistor
divider) can be simulated honestly. It is a separate component task: real pin-level model,
schematic, 2D, 3D, inspector, serialization and tests. No behaviour-only oscillator block without a
separate approval.

**Multi-position switch — not started**; not part of the runtime work.

**Validation (pre-promotion).**

| Check | Result |
|---|---|
| Full suite on `bd78d2e` (final code): typecheck, lint + boundaries, build | pass |
| Unit (domain, engine incl. ngspice cross-checks, transient, diagnostics, serialization, schematic, 3D, cross-view) | **731 passed**, 75 files |
| Browser, complete suite | **144 passed**, 3 skipped (the usual heavy specs), **0 failed** |
| Legacy browser | 4 passed |
| Preview `3ba2292`, fresh run, as published | **62/62**; clean rebuild byte-identical to the 14 published files; 14/14 served files hash-match disk |
| Preview `bd78d2e` (republished with the final code) | **68/68** (the 62 + ESP32 palette rule EN/HE, local-project board rule, lazy example chunk); 16/16 served files hash-match disk |
| Services, normal demo (`198ca92`), demo `index.html` | unchanged |

**Runtime expansion (architecture only):** [docs/runtime/R3-CAPABILITY-PLAN.md](../runtime/R3-CAPABILITY-PLAN.md):
PWM/edge timing, I2C bridge, microsecond inputs, protocol changes, revalidation impact and phases.
No backend change is made in Sprint 10.

## Part B — the approved component families (2026-10-06, after the PM-6 revision)

Scope commit: `b02fbaf` (`V1-PRODUCT-SCOPE.md` §6.0). Architecture: SPRINT-10-ARCHITECTURE.md §5.
Datasheet facts with SHA-256 and pages: [s10-evidence/datasheets/FACTS.md](s10-evidence/datasheets/FACTS.md).

### B.1 Component matrix

COMPLETE means every column is done and tested; anything else says what is missing.

| Component | 2D | Simulation | Schematic | 3D | Inspector | Serialization | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| RGB LED (Kingbright WP154A4SUREQBFZGC, common cathode) | ✔ per-channel glow from solved currents | ✔ 3 fitted dice (ngspice 1e-6) | ✔ block + glyph + part no. | ✔ clear lamp, 3 dice, live mixed colour | ✔ channel currents, EN/HE | ✔ | ✔ engine, ngspice, cross-view, browser | **COMPLETE** (local circuits) |
| Photoresistor (Senba GL5528) | ✔ | ✔ R(E) power law, light = live environment | ✔ + part no. | ✔ CdS disc | ✔ environment slider, resistance | ✔ (lux) | ✔ | **COMPLETE** (local) |
| Buzzer (CUI/Same Sky CEM-1205-IC) | ✔ sound waves when sounding | ✔ datasheet V-I curve, sounding 3–6 V | ✔ + part no. | ✔ can, "+", marking | ✔ | ✔ | ✔ incl. optional sound toggle | **COMPLETE** (local) |
| Relay (Songle SRD-05VDC-SL-C) | ✔ blade follows armature | ✔ coil/contacts separate, hysteresis, chatter refused | ✔ block, coil + changeover glyph | ✔ case on its real pins | ✔ coil/contact current, state | ✔ | ✔ | **COMPLETE** (local) |
| NPN transistor (2N3904, Fairchild SPICE card) | ✔ | ✔ Gummel–Poon DC (ngspice 1e-6 V) | ✔ block + NPN glyph | ✔ TO-92, E-B-C | ✔ I_C/I_B/I_E, V_CE, region | ✔ | ✔ | **COMPLETE** (local) |
| PIR motion sensor (HC-SR501) | ✔ dome toggles motion | ✔ powered state, 3.3 V/1 kΩ output from VCC | ✔ block | ✔ board, Fresnel dome, pots, header | ✔ motion = environment | ✔ | ✔ | **COMPLETE** (local) |
| LED matrix 8×8 (1088AS) | ✔ per-dot glow, pin names | ✔ 64 dots, any-size abstraction | ✔ block | ✔ face lit live, 16 pins | ✔ dots lit | ✔ | ✔ | **COMPLETE** (local) |
| Capacitor (ideal, non-polarised) | ✔ | ✔ time-stepped (backward Euler), Run/Stop | ✔ + value | ✔ disc / NP can by value | ✔ charge, energy, rated V | ✔ (farad) | ✔ | **COMPLETE** (local) |
| Servo (SG90) | — | internal: pulse → angle | — | — | — | — | ✔ (internal) | **INTERNAL** — needs ESP32 PWM/LEDC (runtime) |
| I2C LCD 16×2 (PCF8574 + HD44780) | — | internal: I2C bus + controller | — | — | — | — | ✔ (internal) | **INTERNAL** — needs the I2C controller bridged (runtime) |
| Ultrasonic (HC-SR04) | — | internal: echo timing | — | — | — | — | ✔ (internal) | **INTERNAL** — needs µs input timing (runtime) |
| Temperature/humidity (DHT22) | — | internal: 40-bit frame | — | — | — | — | ✔ (internal) | **INTERNAL** — needs µs input timing (runtime) |
| 555 timer | — | — | — | — | — | — | — | **NOT STARTED** (only when pin-level behaviour is credible) |
| Multi-position switch | — | — | — | — | — | — | — | **NOT STARTED** |
| Potentiometer | — | — | — | — | — | — | — | **V1.1** (unchanged) |

"Local" = circuits without an ESP32. With an ESP32 every new part is refused at Run with a
specific message (`mcu_component_unsupported`): the deployed Session Host predates the part models.

### B.2 Engine

- **Part-model framework** (`3d6fda2`): multi-terminal parts, ideal contacts, discrete state settled
  by a bounded fixed point (hysteresis kept between solves; `no_steady_state` for a circuit that
  never settles), declared live parameters. The original eight types keep their frozen path: the
  Gate A golden values and every DC result are unchanged.
- **Time-stepped simulation** (`26b9016`): `EngineSession.advance(dt)`, backward Euler, per-part
  history, discharged at t = 0, failed steps do not advance time. Active only when the circuit holds
  a capacitor; otherwise the DC path is untouched.
- **2N3904 Gummel–Poon DC** with SPICE temperature scaling; matches ngspice within ~1e-6 V.
- **Solver robustness**: at the Newton limit with no device limiting, an iterate is accepted only
  if it passes the exact-equation verification (a femtoamp node beside the transistor's 1 Ω
  internal resistance). Converging circuits are unaffected.
- **Primitives**: `PwlLoad` (datasheet V–I curves), `RegulatedOutput` (output current drawn from
  the module supply), `ConstantSink`, `Npn`, capacitor history.

### B.3 Diagnostics (`4e1b6e7`)

Amber warnings, never changing a solved value, with EN/HE text:
- ESP32 pads: two pads driving opposite levels on one net (contention), output HIGH wired to GND,
  output LOW wired to a supply +, a pad sourcing more than 40 mA or sinking more than 28 mA (the
  datasheet drive specification the pad model is built from).
- Every new part's datasheet ratings: RGB per-die current/reverse/power, relay coil voltage and
  contact current, 2N3904 I_C/V_CEO/V_CBO/V_EBO/power, LDR power and voltage, buzzer and PIR supply
  voltage, capacitor rated voltage (a design value).
- `no_steady_state` (a self-interrupting relay); "outside the model's documented range" for LDR
  light, buzzer bias, RGB and matrix currents.

### B.4 I2C and peripherals (internal)

`packages/engine/src/peripherals/`: an I2C bus (transaction and line level, 7-bit addresses,
conflicts refused), PCF8574 + HD44780 (the I2C LCD), SG90 pulse decoding, HC-SR04 echo timing and
DHT22 frames. MCU- and language-agnostic: no Arduino or MicroPython API. They are not exposed
because the deployed ESP32 runtime cannot drive them (architecture §5.6).

### B.5 Sensors and the simulated environment

Environment parameters (catalog `environment`, always live): the light on the photoresistor (lux,
log slider) and the motion in front of the PIR (a box, or a click on its dome). They are persisted
in the project, shown in the inspector's "Simulated environment" section, mirrored live and read by
the part models; no sensor output is hard-coded.

### B.6 3D

New models at datasheet dimensions (representative where none is published, and marked so):
RGB lamp with three dice and 1.27 mm leads, GL5528 disc with its CdS track, CEM-1205 can, Songle
relay on its pins, TO-92 2N3904 (E-B-C, marked face), HC-SR501 board with Fresnel dome and trim pots,
1088AS matrix with a live-lit face, disc ceramic or bipolar can for the capacitor. Live presentation:
RGB colour mixed from channel currents, matrix dots from dot currents, LEDs as before. Wiring to pins
under a body (relay, PIR, matrix) comes in along each pin's perpendicular and drops outside the body;
crossing wires keep a full level apart (a pre-existing height rule could let them touch).

### B.7 Examples

`rgb-mixer`, `light-sensor`, `night-light` (LDR + 2N3904), `pir-alarm` (PIR + 2N3904 + buzzer),
`led-matrix`, `rc-fade` (time-stepped), `relay-load`. Each has engine-level expected results.

### B.8 Tests (HEAD `3ba2292`; full run on `c5f55c4`)

| Suite | Result |
|---|---|
| Typecheck, lint, boundary check, build | pass |
| Unit (vitest) | **730 passed**, 75 files (Part A: 657) |
| Browser (Playwright) | 139 passed, 3 skipped as usual, 3 failed: Hebrew checks flagging the new part numbers (RGB, GL5528, 2N3904…) as untranslated; the allowlists were extended (`3ba2292`) and those 3 specs rerun: **pass**. Effective 142 passed |
| Legacy browser | 4 passed |
| Preview validation (`3ba2292`, deployed) | **62/62** (Part A checks plus 11 for the new parts) |

New engine tests compare against ngspice (RGB, 2N3904) and closed forms (LDR divider, buzzer curve,
relay hysteresis, backward-Euler recursion); cross-view agreement covers every new part at every
rotation.

### B.9 Performance (this host, Node, same method before/after)

| Measure | Part A (`d3b79b0`) | Now |
|---|---|---|
| DC solve, LED current example | 0.76 ms | 0.62 ms |
| DC solve, voltage divider / CC mode / diode polarity | 0.15 / 0.17 / 0.39 ms | 0.15 / 0.18 / 0.39 ms |
| DC solve, dense 42-part circuit | 0.18 ms | 0.13 ms |
| 3D scene derivation, dense circuit | 28.5 ms | 25.3 ms |
| New: PIR alarm / LED matrix (64 diodes) / night light | — | 1.2 / 3.5 / 0.7 ms |
| New: one 1 ms time step, rc-fade | — | 0.45 ms (≈45 % of one worker core while running; budget 50 %) |
| Startup bundle (index) | 282.7 kB (81.7 gzip) | 367.1 kB (102.7 gzip) |
| 3D chunk (lazy) | 623.6 kB | 634.4 kB |

No regression in DC solving. The time-stepped run is the one new continuous cost, bounded by the
tick budget; making each step cheaper (reusing the compiled circuit) is a follow-up.

### B.10 Screenshots

`s10-evidence/parts/`: each new part on the canvas while running, schematic blocks, 3D close-ups,
and the deployed preview (`preview-s10-*`).

### B.11 Blockers and decisions still required

1. **ESP32 + new parts**: the deployed Session Host predates the part models, so every new part is
   refused in ESP32 projects. Lifting it needs a backend redeploy from this branch (approval).
2. **Servo, I2C LCD, HC-SR04, DHT22**: need runtime work (PWM/LEDC routed to pads with edge times;
   an I2C controller bridge; microsecond input timing). Sprint 8 backend changes, not made here.
3. **555**: not started; with the transient core and the BJT in place a pin-level model is now
   feasible, as its own task.
4. **Multi-position switch**: not started.
5. **Time-step CPU**: acceptable within the budget; to be optimised before denser time-stepped circuits.


## Scope decision (2026-10-06, after the first owner review)

The PM revised PM-6: the closed eight-item catalog is superseded by the approved component families
in `docs/product/V1-PRODUCT-SCOPE.md` §6.0. The potentiometer remains V1.1. The yellow and green LED
cards are accepted and stay. The physical-scale 3D direction is accepted. Sprint 10 continues on the
same branch and preview, in the PM's tier order (RGB LED, LDR, buzzer, relay, servo, I2C LCD; then
sensors, matrix, transistor, capacitor/555). The rest of this record is updated as that work lands;
the section below records the first overnight outcome.

## Scope outcome (read first)

The authoritative product scope keeps the V1 catalog **closed at eight types** (PM-6). Transistors,
capacitors, relays, sensors, 555s and I2C displays are deferred; RGB LED, buzzer and servo are
undecided. The roadmap also says transient analysis is not in scope for V1.

The Sprint 10 brief asked for catalog expansion **within** that authoritative scope. So:
- **Catalog growth delivered:** the only approved item, the datasheet-sourced LED colour cards (two
  added).
- **Recorded as a PM decision required:** every new component type. None is exposed.
- **Engine work for deferred devices is internal and unexposed:** a tested time-domain core and a
  capacitor primitive, ready for when the PM revises PM-6.

## 1. Physical-scale 3D (the visible step change)

**Rule kept:** the user places a part once, in 2D. "2D layout → position"; physical metadata →
size, height and shape. Nothing 3D is stored in a project.

**World scale (`physical.ts`, the one convention).**
- 1 scene unit = 1 mm.
- One 2D grid step = **3.175 mm** (1/8 in).

With this step the ESP32 symbol's pin columns are exactly the real **25.40 mm** header rows, and
the symbol's outline contains the real board. The cross-view invariant test found the reason
this matters: at a 2.54 mm step, a resistor placed beside the board in 2D would stand on its
header in 3D. Two-terminal parts sit on a 12.7 mm (0.5 in) lead span. Along the header the real
2.54 mm pitch is used, and wires end on the real pin.

**Dimensions and sources** (datasheet or drawing; "representative" where no single part exists):

| Part | Modelled as | Key dimensions (mm) | Source |
|---|---|---|---|
| ESP32-DevKitC V4 | Black PCB with silkscreen pin names; WROOM-32 module (antenna trace, marked shield can) overhanging the top edge; micro-USB, EN/BOOT, regulator, USB-UART bridge, passives; 2 × 19 male header pins standing on the bench; a jumper housing on every wired pin | PCB 27.94 × 50.85 × 1.6; rows 25.40; pitch 2.54; module 18 × 25.5, overhang 6.04 | Espressif dimensions drawing (PDF + DXF); WROOM-32 outline |
| Resistor | Carbon-film "dog bone", colour bands from the value, leads bent to the bench | Body 6.3 × Ø2.4; leads Ø0.55 | Representative 1/4 W |
| LED red / yellow | T-1¾ tinted diffused lens: flange with the cathode flat, anode post and anvil inside, 2.54 mm leads splayed to the terminals; glow plus halo when lit | Ø5 / flange Ø5.8 × 1.1; height 8.7; dome R2.49 | Vishay doc. 83012 |
| LED green | T-1 clear lens, same construction | Ø2.9; height 4.4; dome R1.4 | Vishay doc. 83009 |
| Diode 1N4148 | DO-35 amber glass with the junction slug, studs and cathode band | 3.4 × Ø1.75; leads Ø0.5 | Vishay doc. 81857 |
| Push button | 6 × 6 tactile: body, steel cover with tabs, round actuator, four legs (pairs joined) | 6 × 6 × 3.5 | Representative |
| Toggle switch | Sub-miniature: body, chrome band, bushing and nut, lever leaning by its persisted state | 8 × 6 × 6; bushing Ø5 | Representative |
| Ground | Small black binding post, its lug reaching the terminal | Post Ø3 × 4.6 | Representative |
| Lab supply | Bench unit at **reduced, symbolic scale** (a real one is ~300 mm): case, panel, displays showing the setpoints, knobs, red/black posts at the terminals | 10.4 × 11 × 12.6 | Stated as symbolic |

**Materials and lighting.**
- Soldermask, gold pins, tinned leads, plastics, translucent lenses and glass.
- Neutral tone mapping keeps colours true (ACES had turned a red LED salmon).
- A sky/bench hemisphere, a key light, a fill light and a rim light that puts highlights on metal.
- Soft shadows from the key light on devices with a real GPU (see Performance).

**Wires.**
- Round, smooth-bent insulated wire, coloured by node.
- Ends meet each part's physical attach point: the lead end, the top of a header pin's jumper
  housing, or a binding post.
- Heights are chosen in mm so a wire never touches anything it is not connected to:
  - wires run above the parts, pins and wire ends they pass over;
  - wires that cross get different heights;
  - a wire never runs under the board it ends on.

**Kept from Sprint 9:**
- no geometry implies a connection;
- touching-but-unconnected terminals show a gap and a ring;
- direct contacts show a solder joint;
- orbit, pan, zoom, fit, reset and keyboard control;
- lazy loading;
- resource release.

## 2. Simulation engine

**Inspection** (recorded in the architecture document): DC operating point only.
- MNA with dense LU.
- Newton–Raphson with junction limiting and gmin, inside the lab-PSU CV/CC active set.
- Every result verified against the exact equations.
- No time base.

**Added: an internal time-domain core** (`Circuit.transient`, `Capacitor`, `TimeStep`). It is
not exposed.
- **Additive.** Without a time step every device and every DC result is untouched; the Gate A
  golden values stay bit-identical.
- **Companion models.** Backward Euler or trapezoidal, solved with the same Newton, active-set
  and verification loop.
- **Time zero.** Either the DC operating point, or a true t = 0⁺ discharged state.
- **Stimulus hook.** `beforeStep(k, t)` may change device values. A declared discontinuity is
  integrated with backward Euler (SPICE breakpoint practice); without that, the trapezoidal rule
  integrates across the jump with a 200× larger, first-order error, as a test shows.
- **Deterministic and bounded** (at most 100 000 steps).

**Validation:**
- closed-form RC charge and discharge;
- convergence order: trapezoidal 2nd, backward Euler 1st, including through a jump;
- charge conservation to 1e-15 C;
- determinism and bounds;
- the capacitor is open at DC (a capacitor-only node is refused);
- an RC + LED discharge cross-checked against **ngspice** (the Gate A oracle): within 2e-4
  relative.

**Pad model, invalid combinations** (new tests). The engine solves these as drawn: it neither
hides nor corrects them.

| Case | Result |
|---|---|
| HIGH fighting LOW on one node | about 97 mA contention through 16.5 + 17.679 Ω |
| Output HIGH shorted to GND | 200 mA |
| Output LOW sinking from 3.3 V | the current its driver model allows |
| Undriven input | held at 0 V by its datasheet leakage; reads LOW every time |

## 3. Approved catalog growth: LED colour cards

| Model id | Part | Anchor | Ratings |
|---|---|---|---|
| `model.led.vishay_tlhy5400` | Yellow 5 mm, GaAsP on GaP | V_F 2.4 V at 20 mA (doc. 83012 rev. 2.7) | 30 mA, 6 V, 100 mW |
| `model.led.vishay_tlhg4900` | Green 3 mm clear, GaP on GaP | V_F 2.4 V at 20 mA (doc. 83009 rev. 2.7) | 30 mA, 6 V, 100 mW |

Each is built exactly like the red card: N assumed as documented, I_S fitted to the anchor, valid
1–20 mA. Datasheet file hashes are in `models.ts` and `PROVENANCE.md`.

| Layer | Where |
|---|---|
| Catalog and serialization | Enum options; old projects unchanged; unknown ids still refused |
| Inspector | Names in EN/HE |
| Engine | Card, registry, ratings |
| 2D canvas | Glow in the datasheet colour |
| Schematic | Part number (new: also TLHR5400, 1N4148) |
| 3D | Package and lens |
| Example | New, below |
| Tests | Engine (anchor 1e-12; session vs independent bisection 1e-9; N sensitivity < 0.4 %; ratings), domain, 3D, browser |

**New example: "LED colours: one resistor, different currents".** Red, yellow and green LEDs, each
from 5 V through 180 Ω. 16.7 mA flows through red and 14.5 mA through the others, because each
colour has its own forward voltage. It is DC only and runs in the browser.

## 4. Schematic

Generated and read-only as before. LEDs and diodes now carry their part number, a
language-neutral LTR token. No new symbol was needed: no new component type.

## 5. Tests

**Final run** on code `3685829` (the last code commit; the record commit after it is docs only):

| Check | Result |
|---|---|
| typecheck, lint (incl. boundaries), production build | pass |
| unit (`npm test`) | **657 passed**, 67 files (Sprint 9: 636) |
| browser (`npm run test:e2e`) | **136 passed**, 3 heavy real-QEMU skipped as usual (Sprint 9: 133) |
| legacy browser | **4 passed** |

The full run was on `297646a`; `3685829` only types one test table, and typecheck and lint were
rerun on it.

**New in Sprint 10:**
- **LED cards:** engine 6, domain 1, 3D 1 (`led-cards`, `led.test`, `scene3d`).
- **Transient core:** 8 tests, including the ngspice cross-check.
- **GPIO contention and edge cases:** 4.
- **LED colours example:** 1.
- **Browser** (`s10.spec.ts`): 3. They cover the example in 2D, the schematic and 3D, the
  inspector cards in EN/HE, and 20 physical-3D cycles that keep resources flat and write
  nothing.

The Sprint 9 floor is unchanged and passing:
- direct contact, the touching marker and routing;
- the schematic and 3D read-back invariant (updated to physical attach points);
- 3D navigation and the 20× release test;
- Build/Run/Stop and the stale-build guard;
- import/export and compatibility;
- Hebrew.

## 6. Performance

All numbers come from this 1-vCPU server, where Chrome renders with **SwiftShader (software
WebGL)**. A real desktop GPU was **not available to measure**. Same method for both builds:
- open to the first painted frame;
- orbit timed per painted drag step;
- JS heap after garbage collection, after 20 enter/leave cycles.

| | Sprint 9 (`198ca92`) | Sprint 10, software GPU (`reduced`: no shadows/MSAA) | Sprint 10 forced `full` (shadows + MSAA) on software |
|---|---|---|---|
| LED current — 3D first / repeat open | 1.84 / 1.27–1.36 s | 2.27 / 1.62–1.69 s | 3.77 / 2.87–3.09 s |
| LED current — orbit per step | 129 ms | **119 ms** | 212 ms |
| ESP32 echo — 3D first / repeat open | 1.93 / 1.36–1.40 s | 2.46 / 1.78–2.13 s | 3.65 / 3.05–3.22 s |
| ESP32 echo — orbit per step | 140 ms | **120 ms** | 233 ms |
| ESP32 echo — heap after 20 cycles / canvases left | 7.5 MB / 0 | 7.9 MB / 0 | 8.9 MB / 0 |
| ESP32 echo — geometries / textures / objects | 48 / 13 / 319 | 35 / 18 / 77 | 35 / 20 / 77 |
| Dense test circuit (42 parts) — scene description | 12.7 ms | 16.0 ms | — |
| DC solve, LED example / dense circuit | 0.71 / 0.20 ms | 0.44 / 0.12 ms | — |
| Transient core (new) | — | 40 900 steps/s linear RC; 28 200 steps/s RC + LED (5.0 Newton iterations per step) | — |

**How the 3D cost was brought down.** A Chrome trace showed openings blocked up to 15 s in the GPU
process executing our WebGL commands.
- The image-based environment prefilter (PMREM) cost seconds per opening and cannot be shared
  across viewers' contexts. Removed.
- Fewer shader programs: header pins are one merged geometry (no instanced variant), and the
  displays use the plain textured variant.
- Static batching merges opaque meshes by material: about 300 draws became about 60.
- The shadow map renders only when the scene changes.
- **Adaptive quality:** a software rasteriser (SwiftShader, llvmpipe…) gets no shadows and no
  MSAA, and every real GPU gets both. The choice shows in the view's `data-quality`, with a
  per-browser override (`localStorage tbi-lab.3d.quality`).

**Bundles** (gzip in brackets):

| Chunk | Sprint 9 | Sprint 10 | Notes |
|---|---|---|---|
| `index` | 274.4 kB | 282.7 kB (81.7) | The new example document and LED card provenance |
| `ThreeView` | 11.6 kB | 15.8 kB | Physical scene description |
| `renderer` | 577.1 kB | 623.6 kB (158.9) | Models, batching; three.js unchanged |
| `SchematicView` | 17.8 kB | 17.9 kB | |

Three.js and the models stay lazy: nothing 3D enters the startup bundle.

## 7. Compatibility

- **No schema change** (`schemaVersion` 3), no migration. Every existing project and example
  opens unchanged with the same connectivity; the examples' documents are byte-identical.
- The LED `model` enum gained two values. A project that uses them is refused by an older build
  (an unknown model id is never reinterpreted); every other project still opens there.
- 3D placement is unchanged (2D layout); only sizes and appearance changed.
- Direct contacts stay zero-length wires. The Sprint 9 tests all pass (see Tests).

## 8. Preview

- **Route:** `deploy/dev-lab/s10-preview`, installed and published. It is additive, inside the
  same Google gate, with its own web root and its own browser storage (`s10-preview`), and shows
  a "Sprint 10 preview · experimental" badge.
- **Install:** the Caddyfile was backed up and validated, then reloaded gracefully (Caddy PID
  unchanged).
- **Untouched:** every backend service (start times identical) and the dev-lab demo release.
- **Validation:** 51/51 checks through the gate's real internal origin.

## 9. Known limitations

- **No new component types.** PM-6 keeps the catalog closed; see the scope outcome.
- **The time-domain core is internal.** No user-facing capacitor or transient feature exists.
- **The bench supply is at reduced, symbolic scale** (stated); the other parts are at real size.
- **Real-GPU performance was not measured** (only SwiftShader here).
- **Software-GPU devices get no shadows or MSAA** (adaptive quality).
- **Push buttons don't move in 3D.** A held button is a canvas interaction, and the views are
  tabs, so a held button can never be visible in 3D; nothing was built for it.
- **Some parts can be hidden.** The ESP32 stands about 10 mm tall on its pins, so parts placed
  right beside it in 2D can be hidden behind it at some camera angles. Orbit or pan to see them.
- **An ESP32 traffic-light example was not added.** Curated example sketches are shared build
  records registered with the build service, so adding one would change backend configuration.
- **The earlier limitations stand:** 3D is visualization only (no editing or picking), the
  schematic is read-only (no export or print), live values are limited, and the router is not a
  PCB-class autorouter.

## 10. Deferred / for a PM decision

- **A PM-6 revision**, to choose which new component types to approve. Candidates and what each
  needs:

  | Candidate | Needs |
  |---|---|
  | Capacitor | Builds on the new transient core |
  | Transistor | A new nonlinear model with ngspice validation |
  | Relay | Coil and contact coupling, plus time |
  | RGB LED | Three of the existing LED cards in one package |
  | Potentiometer + ADC | The V1.1 item |
  | Sensors, servo, buzzer | ADC, PWM/LEDC or digital-protocol peripherals (Future) |
  | I2C display | An I2C device bridge (Future) |

- **A product decision on exposing transient simulation** (Run semantics, time base, UI).
- **More curated ESP32 examples**, which need build-service system records.
- **Remaining 3D-effort items:** ESP32 pin labels in 3D, 3D picking, real-GPU measurement, and a
  realistic-size bench supply option.
