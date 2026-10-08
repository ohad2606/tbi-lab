# Sprint 10 — Physical 3D, engine time-domain core, the approved component families

**Status (2026-10-08):** developed on `sprint-10` (worktree `~/projects/tbi-lab-s10`), from
`7f09d74` = `main` = `sprint-9-complete`. **dev-lab.tbi-tech.net serves frontend `db9eb20` and
runtime `80448f9`** (frontend `v0.10-dev · db9eb20` from `/version.json` and the served
`index.html`; runtime `v0.10-dev · 80448f9` from the Session Host's `/health`, also shown in the
version details as *Runtime ID*). Rollbacks kept: frontend `c6e8f25`, runtime/services release
`c31d62e`. Part R: realism pass 6 (wire jackets, shadow penumbra, studio room, Dupont). Part Q: realism pass 5 and the 3D layer model (Realistic / Engineering). Part P: runtime sync (the Session Host runs the Sprint 10 engine: yellow/green LED
cards end to end). Part O: realism pass 4. Part N: realism pass 3. Part M: operating the toggle switch and push button in 3D during Run.
Part L: false-hop fix, net wire colours, limited 3D picking. Part K: fresh 3D wire routes (owner review: PIR alarm, relay -> LED).
Part J: visual-only 3D body separation (owner review). Part I: realism
pass 2 + product footer. **Owner review PENDING**: the 3D view on a real GPU (checklist I.6) and
the separation (J).

Not done: no PR, merge, tag or production deployment. Backend: only the Session Host was updated
(Part P, owner-approved); the build service runs byte-identical code (`c31d62e`), the QEMU runtime is
unchanged (`33e35e4ac5e798d7`). The isolated preview `/s10-preview/` stays.

Architecture and scope: [SPRINT-10-ARCHITECTURE.md](SPRINT-10-ARCHITECTURE.md).

## Part R — realism pass 6 (owner: "continue", 2026-10-08)

Continues the realism run against the three CG cues of Q.10 E. Full tier only: the reduced
(software) tier renders exactly as before (same draw calls, programs and textures, R.3).
Images: full tier rendered in software at DPR 1, as before; **no hardware-tier timings**.

### R.1 Changes

- **Wire jackets**: an extruded PVC surface (faint die lines round the jacket, a slow handling
  ripple, a few scuffs), one 256 x 64 texture used as bump + roughness. Mapped by arc length
  (`wireSurfaceUv`: the tube's own rings, since its segments are not evenly spaced), each wire
  starting at its own point of the tile (from its id), so no two wires repeat the same stretch.
- **Shadows**: variance shadow maps with a blurred penumbra (radius 5, 12 samples). three.js'
  PCF uses a per-pixel rotated five-tap kernel; without temporal accumulation it left a dithered,
  saw-toothed edge along every wire's shadow.
- **Studio environment** (reflections): a room, not a light tent. Darker walls and floor
  (top `#c9ccd0`, horizon `#8c9095`, floor `#55595e`, were `#eceef0` / `#c4c8cc` / `#7e8286`), the
  same softboxes, plus a black flag on the right; studio intensity 0.85 -> 1.1 so overall exposure
  is unchanged (mat brightness within 1/255 of before). Chrome and steel now reflect contrast; the
  toggle's bushing and nut read as plated metal instead of grey plastic.
- **Dupont housing**: charcoal glass-filled nylon (`#18181b`, roughness 0.46; was near-void
  `#101012`, 0.5). A larger edge radius was tried and reverted: the rounded body no longer met
  the chamfered top cleanly.
- **Batching fix** (`db9eb20`): the jacket maps made the static batcher skip every jacket (textured
  materials were never merged): 233 -> 383 draw calls on the bench. A material flagged
  `userData.batchUv` now batches with its UVs; back to 233.

### R.2 Numbers (full tier, software, same cameras; `s10-evidence/realism6/stats-*.json`)

Draw calls, triangles, materials: identical on every one of the 23 cameras (bench 3/4: 233 draw
calls, 351k triangles, 73 materials). Textures 37 -> 39 (jacket surface, VSM blur target);
geometries 70 -> 71; GPU memory estimate 43.2 -> 43.5 MB.

### R.3 Software tier (`perf-3d.spec.ts`, A/B back to back)

Scene counts identical (bench: 85 draw calls, 5 programs, 16 textures; ESP32: 44; dense: 143).
Timings within noise (bench orbit 436 -> 431 ms/step, pan 422 -> 447, first open 6.29 -> 6.31 s,
re-open 5.41 -> 5.39 s; heap 10 MB after 20 cycles, 0 canvases left). Absolute timings are about
twice Part Q's: another session was running its own headless browser on this host (load ~3).

### R.4 Evidence

`s10-evidence/realism6/`: 23 same-camera before (dev-lab `c6e8f25`) / after (`db9eb20`) pairs,
`cameras.json`, stats. The visible differences are modest: smoother wire shadows (10, 11, 18),
metal with real reflection contrast (17 toggle, 12 PSU posts), charcoal housings (09). The jacket
texture is visible only in close-ups.

### R.5 Regression and deployment

- `db9eb20`: typecheck, lint, unit **847/847**, build, e2e **163 passed / 3 skipped**, browser PASS.
- Deployed with `deploy/dev-lab/publish-frontend.sh db9eb20` (all checks passed); dev-lab serves
  `db9eb20`. Rollback: re-point `current` to `c6e8f2541eced72ce33a50b5b220084da15edce8`.
  Backend untouched (Session Host runtime `80448f9`).
- Live (via the gate's origin): 3D 7/7, demo 40/40, Sprint 9 smoke ALL PASSED, real-QEMU control
  input-echo 17/17 and bench 17/17 (D1, D3 yellow and D4 green lit in 3D; Stop clean; no page
  errors). The extra lit-bench screenshot script timed out *taking the screenshot* under host
  load after Run; its session was left running (see R.6).

### R.6 Open item

The crashed screenshot script left one runtime session (`tbi-qemu@2f79fead…`, started 05:54:06
UTC) running after its browser exited. It ended on its own at 06:00:10 UTC (about 6 minutes),
well before the 30-minute maximum lifetime, but much later than the 30 s lease. No service was
touched and the host's logs were not read, so why the lease took about 6 minutes is not known.
Worth a look.

### R.7 Self-critique

The bar (a photographed bench) is still **not met**. This pass removes one artefact (dithered
shadow edges) and one material failure (metal reading as grey plastic); jackets and housings
improve only up close. Remaining cues, unchanged in rank: uniform surfaces and identical parts;
the miniature PSU and ground posts next to true-scale parts; missing edge highlights on small
parts (chip bodies, header plastic, PCB edge).

## Part Q — realism pass 5 and the 3D layer model (owner direction, 2026-10-07)

The owner checked dev-lab on a real GPU (ANGLE / Direct3D 11, Intel Iris Xe, full tier, DPR 1).
That made the full tier the primary target for this pass. This host still has only a software
rasteriser: every image here is the full tier rendered in software at DPR 1, the closest
available proxy. **No hardware-tier timings were measured here** (Q.6).

### Q.1 3D visualization layers (owner-approved architecture)

The physical scene and engineering information are now separate:

- `layers.ts` (pure): a layer registry with, per layer, a stable id, a localized name and a
  default per preset. Presets: **Realistic** (the default: the physical scene only) and
  **Engineering** (labels and grid). Visibility is a view preference in localStorage
  (`tbi-lab.3d.layers`), never project data and never part of the electrical schema.
- Renderer: two layer kinds, with no layer-specific conditionals in the scene builder.
  - Scene content tagged `userData.layer` is shown or hidden as a group (the grid; future debug
    geometry).
  - Overlay layers have build/update/visibility/dispose hooks. The **Labels** layer is
    screen-space annotations (three.js `CSS2DRenderer`, its own scene), drawn only while
    visible. Reference designators are no longer printed on the bench.
- UI: the 3D toolbar's *Labels* button became a compact **Layers** popover (preset radios, one
  checkbox per layer). English/Hebrew, RTL, keyboard; Escape returns focus.
- Changing layers rebuilds nothing and restarts nothing; selection, controls and the simulation
  are unaffected.
- Not implemented (the architecture admits them): electrical values, net/current visualization,
  simulation state, warnings, debug.
- Tests:
  - `layers.test.ts` (presets, manual toggle, junk-proof preference, EN/HE names, anchors per part,
    no project change);
  - `three-layers.spec.ts` (Realistic default, Engineering shows one correct tag per part, custom
    toggles, ten toggles leak nothing, project unchanged, simulation unaffected, Hebrew RTL panel).
- Evidence: `s10-evidence/realism5/layers-realistic-vs-engineering.jpg`.

### Q.2 ESP32

| Area | Change |
|---|---|
| Micro-USB B (rebuilt) | A drawn-steel shell, 0.22 mm wall, with slightly rounded upper corners and a flared mouth contiguous with the shell (the old lip floated 0.08 mm off). A dark cavity liner and rear wall (it read as an empty box). The insert tongue in the upper half with its five gold contacts. Two latch windows with spring fingers, a folded rear flap, soldered anchor tabs. Double-sided thin walls (the inside was being culled). A roughness grain on the shell (full tier) |
| PCB | Satin LPI mask: clearcoat 0.55 → 0.3, rougher (it read as glossy plastic). Silkscreen in a warmer off-white ink, stroke 0.17 → 0.13 of the cap height (it read as bold) |
| GLB | 771 KB, generated from code |
| SMD population | Already measured from Espressif's photo; the CP2102N carrier has no crystal, so none was invented |

### Q.3 Components, wiring, terminals

| Area | Change |
|---|---|
| Junctions | Three or more wires at one point: the jackets stop 2.6 mm short and the stripped conductors meet in one tinned twisted splice. Mechanical, like the direct-contact joints: no jacket T, no solder blob |
| LED (diffused) | Transmission thickness 4.5 → 1.6 mm (the refraction offset smeared the lead frame and anything behind into a band); epoxy roughness 0.62 so what is behind only blurs through; lit gain 1.7 so the glow stays saturated. The yellow card now reads yellow lit (the baseline rendered it orange) |
| Ground terminal | A black moulded terminal block with the earth symbol and GND printed in white (it was a plated plate: a prop) |
| Bench supply | Side louvres. It stays a stylized miniature (scale exception, Part H): a full-size supply would dominate the bench |

### Q.4 Workbench, lighting, composition

| Area | Change |
|---|---|
| Mat | A colour map over the whole mat: a soft light pool under the lamp (about 12 % darker at the corners) and a faint low-frequency mottle (±3 %): a manufactured surface, not a flat colour |
| Full tier | A subtle lens vignette (one cheap pass); exposure +6 % |
| Grid | Now the Grid layer, hidden in Realistic |
| AO | GTAO (full tier) is kept unchanged; no new post-processing beyond the vignette |
| Default framing | Fit and reset measure the parts (footprints at their own height) and the wire routes, not the bounding box's corners, which left a band of empty mat on wide benches. Fill 0.88 keeps the help note clear. The benchmark now fills the view |

### Q.5 Assets and licences

No new shipped non-code asset. The ESP32 GLB is regenerated from code; every texture (mat pool,
shell grain, panel, plates) is drawn at runtime. The manifest's ESP32 descriptor was updated (satin
mask, the rebuilt micro-USB). Everything remains original to the project.

### Q.6 Numbers

Full tier, benchmark three-quarter view (`80448f9` → this pass):

| Measure | Before | After |
|---|---|---|
| Draw calls | 251 | 233 |
| Triangles | 349k | 351k |
| Materials | 92 | 73 |
| Geometries | 90 | 70 |
| Textures | 55 | 37 |
| GPU memory (est.) | 44.5 MB | 43.2 MB |

The per-part label meshes and textures are gone.

Software renderer (default reduced tier, same procedure, back to back):

| Measure | Before | After |
|---|---|---|
| Benchmark first open | 3.8 s | 3.5 s |
| Benchmark re-open | 3.0 s | 2.8 s |
| Benchmark orbit / pan per step | 199 / 192 ms | 238 / 240 ms |
| Benchmark draw calls | 105 | 85 |
| Shader programs | 6 | 5 |
| 20 enter/leave cycles (open time) | 2.3–3.0 s | 2.5–3.1 s |
| Heap after the cycles | 10 MB | 10 MB |
| Canvases left | 0 | 0 |
| ESP32 orbit per step | 194 ms | 229 ms |
| Dense scene orbit per step | 277 ms | 307 ms |

The orbit cost per step rose about 15–20 %. Fewer draws and programs make it unlikely to be
scene cost. The most likely cause is the tighter default framing: a software rasteriser pays per
pixel, and the parts now fill more of the frame.

**Hardware tier (Intel Iris Xe): not measured here.** To record it on the owner's PC, open dev-lab
with `#diag3d`. The readout shows renderer, tier, DPR, draw calls, triangles, textures, geometries,
GPU memory and the last frame's CPU time; note first open, orbit smoothness and frame time.

### Q.7 Evidence

`s10-evidence/realism5/`, same cameras before and after (`cameras.json`), full tier at DPR 1:
- default views: benchmark, blink, PIR alarm, LED colours;
- benchmark three-quarter and the ESP32 front, rear and WROOM/header;
- the USB, front and three-quarter, and the buttons with the SMD area;
- wiring: Dupont, long wire, crossing, supply terminal, junction;
- components: LED unlit and lit, the LED close-up unlit and lit, diode, resistor, push button,
  toggle;
- the layers pair, `stats-*.json` and `perf/`.

### Q.9 Regression and deployment

Regression on `c6e8f25` (clean tree):

| Check | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Unit tests | 846/846 |
| Browser | PASS |
| Build | PASS |
| e2e | 163 passed, 3 skipped (+ `three-layers` ×2) |

Deployed frontend-only with `publish-frontend.sh c6e8f25`: all publisher checks passed. The
backend and Session Host are untouched; the runtime stays `80448f9`, and the services' start times
are unchanged.

Live checks through the gate's origin:

| Check | Result |
|---|---|
| live 3D | 7/7 |
| demo10 | 40/40 |
| Sprint 9 smoke | all passed |
| ESP32 3D controls, `esp32-input-echo` (real build, QEMU) | 17/17 |
| ESP32 3D controls, `esp32-bench` | 17/17 |
| `esp32-bench` running | yellow D3 and green D4 lit in 3D; Stop → stopped, no page errors |
| Version details | frontend `c6e8f25`, Runtime ID `v0.10-dev · 80448f9` |

Cleanup: no QEMU units, no session directories. Frontend rollback, which leaves the runtime
untouched:

```sh
sudo ln -sfn /srv/tbi-lab/dev-lab/80448f9426d10cf7cf1f8f809ed44cf1a5096675 /srv/tbi-lab/dev-lab/current.tmp &&
  sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
```

### Q.10 Self-critique (owner questions)

**A. Does the ESP32 look close to a real product photograph?** Closer, not there.
- Close up, the board surface, the satin mask, the silkscreen, the menisci and now the
  micro-USB are convincing.
- Still CG: perfectly clean edges everywhere, and the RF can's laser marking reads embossed.
- Unusual but physically possible: the board standing 10 mm up on its header pins.

**B. Do the small parts look like real components?**
- Resistor, diode and toggle switch: mostly yes.
- LEDs: lit, good; unlit from some angles, the transmission approximation still shows objects
  behind as a band.
- Push button and Dupont housings: correct but plain.

**C. Do wires and connectors feel physically plausible?** Yes for shape (bends, sag, arches,
crossings, junction splices). The jackets are still perfect uniform tubes.

**D. Does the scene feel like a physical electronics bench?** It now reads as a clean, well-lit
product render of a real bench setup: labels gone, a manufactured mat under a lamp, a composed
view. It does not yet read as a photograph.

**E. The three strongest remaining CG cues:**
1. Lighting and surfaces that are too perfect: no micro-variation between identical parts, no
   dust-free-but-real surface texture, uniform specular on every plastic.
2. The miniature, stylized bench supply and the ground posts next to true-scale parts.
3. Edges with no bevel highlights on many small parts (SMD bodies, Dupont housings, the PCB
   outline), which a camera always catches.

**Photographed-bench bar: not met.** The Realistic view is a substantial step toward it.

## Part P — runtime sync: the Session Host runs the Sprint 10 engine (owner-approved, 2026-10-07)

Owner decision: update the dev-lab runtime so that the yellow (TLHY5400) and green (TLHG4900) LED
cards work end to end (Project → Build → Session Host → Engine → Circuit → 3D/Schematic). The
red-only workaround and a visual-only benchmark were both rejected.

### P.1 The backend delta from `c31d62e`, classified

Nothing changed in the Session Host's or the build service's own code between `c31d62e` and
Sprint 10 HEAD:
- `runtime/host`, `runtime/builder`, `runtime/identity`, `runtime/policy` and the harness are
  identical;
- the units are unchanged;
- the only template diff, `tbi-qemu@` TasksMax 32 → 80, was already live since 2026-10-05.

The delta is the two workspace packages the Session Host bundle carries (`@tbi-lab/engine`,
`@tbi-lab/domain`):

| Category | What | Status |
|---|---|---|
| 1. Required for the LED cards | `engine/models.ts` (TLHY5400, TLHG4900 cards and anchors), `engine/registry.ts` (two cards and their validity ranges), `engine/ratings.ts` (their datasheet ratings) | Carried |
| 2. Engine, behaviour-compatible | `engine/circuit.ts`: an accept-by-residual path, reached only where Newton used to fail. `engine/session.ts`: the part-model registry and a discrete-state loop, which is one pass and unchanged without stateful parts; `advance()` is never called by the host. `engine/devices.ts`: optional time-step hooks and an internal `Capacitor`, an open circuit at DC. `esp32Gpio.ts`: two datasheet constants, used by browser diagnostics only. New part models: `bjt.ts`, `parts/*`, `pwl.ts`, `sources.ts` | Carried, but unreachable for the parts the runtime does not support (guard below) |
| 3. Unrelated | `domain`: editing, routing, connectivity, contacts, schema, validation. Bundled but not on any host code path; the host imports only the ESP32 board data (byte-identical) and `CATALOG` (for the guard) | Bundled, inert |
| 4. Security, admission, protocol | None | — |

My Session Host changes (`runtime/host`, three files):

| File | Change |
|---|---|
| `session.ts` | **Guard**: parts the ESP32 runtime does not simulate (catalog `mcuRuntime: false`, the app's own Run rule: capacitor, BJT, relay, RGB LED, LDR, buzzer, PIR, LED matrix) are refused exactly as `c31d62e` refused them: `failed / electrical_error` with `{ code: 'unsupported_component', components: [first in circuit order] }`, at the same point (after the private flash copy, before the first solve). So no capacitor is ever solved at DC under a running board, and no transient path is reachable. |
| `http.ts`, `identity.ts` | `/health` gains an additive read-only `runtime: { version, commit }`, stamped by the bundler. Nothing about the host. Unstamped builds report nothing, as before. The build service reads only `.sessions` (verified). |

One edge differs from `c31d62e`: a GPIO wired directly to one of those parts gets
`unsupported_component` instead of `invalid_attachment`. The app never sends such a request (its
Run guard refuses first).

Protocol compatibility:
- `tbi-lab.session/2`, request and response schemas, routes and command semantics are unchanged.
- Artifact lookup, re-hash and private copy, the QEMU invocation (the same `tbi-qemu@` unit and
  binary), Run/Stop, leases and session ownership are unchanged: the code paths are untouched.

### P.2 Model-card synchronisation

The browser and the runtime now execute the same `@tbi-lab/engine` (same commit): one
`MODEL_CARDS`, `MODEL_VALID_CURRENT_A` and `MODEL_RATINGS`, with no runtime-only copy. Forward
voltage, ratings and part numbers exist once (`packages/engine/src/models.ts`, `ratings.ts`).

### P.3 Tests

| Area | Result |
|---|---|
| DC A/B, `scripts/runtime-sync/engine-ab.ts` (`c31d62e` engine vs this engine, JSON byte for byte, on what the browser sends: every example, every ESP32 pad mode × switch × button, and the recorded Sprint 8 session request) | **102 identical**; 37 differ, all circuits with the yellow/green cards (old: `invalid_parameter`; new: solved); **0 unexpected**. Output in `s10-evidence/runtime-sync/engine-ab.txt` |
| Historical DC references | `c31d62e`'s eight engine test files and the Gate A golden data are byte-identical to HEAD's and pass |
| Host level (`runtime/host/tests/models.test.ts`, 9 tests, routine CI) | Red, yellow and green in one circuit: each within 1e-6 of an independent Shockley bisection. Reversed yellow/green block (< 1 nA). Over-driven red/yellow/green all raise `forward_current` under the app's rating rules. Capacitor, BJT, relay and RGB LED refused as before. `/health` identity stamped vs unstamped, malformed stamps dropped |
| Real QEMU, `r2-led-bench` (pinned TbiBanks, the app's exact benchmark request, kept in sync by `app/tests/runtime-fixtures.test.ts`) | Yellow/green at the engine's operating point. SW1 mirror → GPIO4 high → D1 lit; open → low. SW2 press → high; release → low. Stop: QEMU gone, private directory gone. **Pass** |
| Real QEMU, local R2 suite (Session Host from source) | 16/17. "Two concurrent sessions ×3" timed out waiting for the NVS firmware under load (60 s per wait); rerun alone: pass (57.7 s). Its circuit is one resistor, untouched by this change. Electrical equivalence vs the R1 loop (1e-9), determinism, failure injection and host-bundle shutdown/crash all pass |
| CI on `80448f9` | Typecheck, lint, unit **842/842**, build, e2e **161 passed / 3 skipped**, browser: all PASS |

### P.4 Deployment

New scripts:
- `deploy/dev-lab/publish-runtime.sh <ref>`: Session Host only. It builds `session-host.mjs` from a
  clean worktree, stamped with `VERSION` and the commit. `build-service.mjs` and `build-job.mjs`
  are sha256-checked byte copies of the release in use (the build service and its job sandboxes
  bind the same `services/current`). It writes `MANIFEST.json` (hashes, origins, the replaced
  release), switches `current` atomically and restarts **only `tbi-session-host`**. It then
  verifies over the socket: protocol unchanged, `runtime.commit`, `tbi-build`'s start time
  unchanged. Any failure rolls back automatically.
- `deploy/dev-lab/rollback-runtime.sh`: re-points to MANIFEST `replaces` (or a given release) and
  restarts only the Session Host.

Pre-update backup: `/var/backups/tbi-lab/pre-s10-runtime-20261007T195615Z` (root, 0700). It holds
the four units, the release symlinks, the sha256 of every `c31d62e` file, `policy.json` and the
QEMU binary, and the service start times. The `c31d62e` release directory stays in place.

Deployed:

| Item | Value |
|---|---|
| Runtime | `80448f9426d10cf7cf1f8f809ed44cf1a5096675` (services release `/srv/tbi-lab/services/80448f9…`) |
| `session-host.mjs` | sha256 `f01374d7…`, 180 KB (was 124 KB) |
| `build-service.mjs` / `build-job.mjs` | `31e0bc62…` / `011f703c…`, identical to `c31d62e` |
| Frontend | `80448f9` (`publish-frontend.sh`; adds the Runtime ID display) |

Service start times:

| Service | Start | Cause |
|---|---|---|
| `tbi-session-host` | 20:22:49 | The deploy (the only restart it made) |
| `tbi-build` | 2026-10-07 20:24:03 | The containment gate's own "a restarted build service…" case (by design); it now runs the byte-identical `build-service.mjs` from the new release directory |
| `tbi-session-host` | 2026-10-07 20:25:25 | The containment gate's "a restarted Session Host…" case |
| `oauth2-proxy` | 2026-10-04 13:27:40 | Unchanged |
| `caddy` | 2026-10-04 13:19:44 | Unchanged |
| Staging `tbi-s8-*` | 2026-10-05 | Untouched |

Policy, keys, units, Caddy routing, quotas, leases and the QEMU runtime were not changed.

Rollback, which restores the exact pre-update backend (no runtime identity on `/health`) without
touching the frontend:

```sh
deploy/dev-lab/rollback-runtime.sh        # -> /srv/tbi-lab/services/c31d62e8fc2544e6583d91520c7b1f6c491a4f91
```

### P.5 Post-deploy validation (dev-lab)

Backend gates, run against the live `tbi` instance (`TBI_S8_INSTANCE=tbi`, fresh test principals):

| Gate | Result |
|---|---|
| `s8-containment` | 9/9 (sandboxed bit-identical build, QEMU sandbox, crash and restart cleanup, cross-user isolation) |
| `s8-deployed-policy` | 7/7 (quotas, Advanced .bin rate, live-session admission, stale-health hold) |
| `s8-qemu-tasks` | 2/2 (real sessions with input bursts, nothing left behind) |
| `s8-gate` | 5/5 (oauth2-proxy → Caddy → socket isolation) |

Live checks through the gate's origin:

| Check | Result |
|---|---|
| live 3D | 7/7 |
| demo10 | 40/40 |
| Sprint 9 smoke | all passed |
| ESP32 3D controls on `esp32-input-echo` | 17/17 |
| ESP32 3D controls on **`esp32-bench`** | **17/17** (Build, Run, SW1/SW2 → GPIO34 → GPIO4 → D1, Stop) |
| `esp32-blink` | Build and Run |
| `esp32-bench` running | D3 (yellow) and D4 (green) lit in 3D; probes I(D3) = 7.2 mA, I(D4) = 13.52 mA; TbiBanks running; Stop → stopped, no page errors (`s10-evidence/runtime-sync/bench-running-3d.png`) |
| Version details | Runtime ID `v0.10-dev · 80448f9` |

Cleanup after everything: no `tbi-qemu@` or `tbi-build-job@` units, no session directories,
`/health` lists no live session.

One live Run was refused with `runtime_capacity`: my blink check had left its session to the lease
instead of pressing Stop. The preview plan's concurrency limit worked as designed, and the
session was released by its lease within 35 s.

### P.6 Endurance assessment

No new 465-minute endurance run. The change touches no lifecycle, admission, lease, protocol or
sandbox code. It touches the engine (per-solve numerics, covered by the A/B and the gates) and
adds a guard before the first solve and a read-only `/health` field. The task-limit, containment
and policy gates were rerun on the deployed instance.

### P.7 Transient stays unexposed

The runtime refuses every time-dependent part (`mcuRuntime: false`) and never calls `advance()`.
The app's Run guard for ESP32 projects is unchanged. No capacitor, 555 or transient UI became
available under the runtime.

## Part O — realism pass 4: physical wires, workbench, grounding (owner direction, 2026-10-07)

Owner assessment entering this pass: "Better 3D: YES. Photographed-electronics-bench WOW: NOT YET."

Priorities, in order:
1. P1: physical wires and connectors.
2. P2: workbench.
3. P3: ESP32 close-up detail.
4. P4: contact shadows, AO and lighting.
5. P5: component texture.

No breadboard: a breadboard is a real construction method and appears only when a project has
one (owner decision).

### O.1 Electrical route vs physical cable (P1)

`wireShape.ts` now separates the two:
`route polyline (unchanged, electrical) -> cleaned control polygon -> physical cable curve -> tube`.

Endpoints, connectivity, colours and the route itself never change. Every stage is a pure,
deterministic function of the route and the wire id, never of the camera or of time.

What the cable does:

| Behaviour | What happens |
|---|---|
| Cleaning | The router's sub-millimetre end jogs, duplicates and collinear points are dropped, so a wire curves into its lead instead of stepping into it |
| Wide asymmetric bends | Each corner bends over up to 14 mm of each adjoining run, shared in proportion. A run that ends at a terminal may be used almost whole. Arms never differ by more than 4x, so a bend cannot kink. Replaces 2-4 mm elbows |
| Relaxation | A run of 20 mm or more resting on the mat bows sideways by up to 1.6 mm (2 %), to a side fixed per wire: never ruler-straight |
| Gravity | Level spans in the air sag (up to 2.5 mm); sloping spans hang below their chord |
| Jumper arch | A Dupont jumper rises out of its housing, arches over and lands on the mat along the direction it then runs |
| Resting over crossings | A wire crossing another wire or a row of leads rests on it. Its profile is dilated 2.5 mm (narrow gaps are bridged, as a stiff wire would), its climb is limited to 0.4 mm per mm (long gentle sides, not a step), then it is simplified and smoothed |
| Safety | The shape steps down through five levels (narrower bends, no bow, no arch, half sag) until it is clear of every part body and never closer to another wire than the plain routes were. The last resort is the route as drawn |

Result: in every test scene, every wire gets a physical shape. In the benchmark scene that is
20 of 21 wires; the one exception is a supply wire that leaves the same post as another, where
any curve would bring the two closer.

Tests (`wire-shape.test.ts`):
- the cable never bends tighter in plan than its route did;
- the long feed bends at a radius of more than 6 mm;
- long runs bow between 0.3 and 2 mm;
- jumpers arch at least 3 mm above their housing exit;
- a crossing is one smooth hump.

Tubes: `wires.ts` tessellates by bend angle (about 9 degrees per segment on the full tier, 13 on
the reduced tier) instead of a fixed count per bend. Smooth wires got cheaper: benchmark
triangles fell 10 %.

Jacket: matte PVC (roughness 0.58, almost no clearcoat, faint sheen; the toy shine is gone).
Each palette colour is shown in 3D as a realistic pigment, less saturated and a little darker.
The shared palette (2D and 3D colour rules, red for + and black for -) is unchanged.

### O.2 Connectors

| Connector | Change |
|---|---|
| Dupont housing | Now seats 0.5 mm above the 0.45 mm solder meniscus (was 0.9 mm, set for the old tall joint), the pin stub entering it. Added: the rear wire opening, the tinned insulation-crimp wings round the jacket, and the locking lance bent out of the window |
| Lead ends | Unchanged; the cleaning above makes the wire meet the lead cleanly |
| Supply binding post and ground terminal | Unchanged (ring tongue on the post) |
| ESP32 micro-USB | A flared mouth lip, and solder fillets on the four anchor tabs |
| EN and BOOT switches | Solder fillets on all eight gull-wing feet |

The ESP32 GLB is 761 KB, down from 786 KB: the header joints' lathe went from 20 to 16 segments,
which pays for the new parts.

### O.3 Workbench (P2) and lighting, shadows, AO (P4)

Workbench (`stage.ts`):
- A finite ESD work mat: muted blue-grey `#7b8d97`, matte with a fine grain, 2 mm thick with a
  rounded bevelled edge. It covers the circuit plus a margin of max(28 mm, 30 %).
- Printed on the mat: a faint 0.5 in grid over the circuit and a millimetre scale along the
  front edge.
- The mat lies on a neutral desk that fades into the backdrop on the full tier. The reduced tier
  draws no desk plane; it clears to the desk colour.

Contact shadows:
- A soft 9-slice quad under every part, with strength and softness per part family (the ESP32's
  is broad and faint, standing on its pins).
- Drawn as one merged mesh, using the labels' material kind and a 4-band strength atlas, so no
  extra shader program is compiled.
- Present on both tiers.

Lighting:
- A neutral key (`#fffaf3`, 2.5) with a softer shadow (radius 4).
- Fill raised to 0.6 so black plastics and the mask stay readable.
- A gentle rim, and the studio environment at 0.85.
- GTAO is unchanged (full tier only); no new post-processing.

### O.4 Benchmark scene and diagnostics

`esp32-bench` (a new example, English and Hebrew):
- The `esp32-input-echo` firmware and input chain.
- A red LED on GPIO4, plus yellow (behind a 1N4148, 33 Ω) and green (68 Ω) LEDs fed from the
  3.3 V supply. Solved with the board removed: 7.2 mA yellow, 13.5 mA green, the supply in CV
  at 20.7 mA.
- One long feed across the bench, and a ground wire crossing it.
- It passes the circuit checks; the renderer has no special case for it.

Diagnostics:
- Open the app with `#diag3d` to see a readout in the 3D view: the WebGL renderer, hardware or
  software, the quality tier, pixel ratio, draw calls, triangles, materials, textures,
  geometries, estimated GPU memory and the last frame's CPU time.
- Hidden otherwise (e2e: `three-diagnostics.spec.ts`).

### O.5 Numbers

Full tier, benchmark scene (`5fab982` → `8611c9b`):

| Camera | Draw calls | Triangles | Materials | Geometries | Textures | GPU memory |
|---|---|---|---|---|---|---|
| Three-quarter | 244 → 251 | 387k → 349k | 89 → 92 | 88 → 90 | 54 → 55 | 45.0 → 44.5 MB |
| ESP32 close-up | 91 → 96 | 179k → 158k | | | | |

Software renderer (default reduced tier, same procedure; one run each, run-to-run noise about
±15 %):

| Measure | `5fab982` | `8611c9b` |
|---|---|---|
| ESP32 example: first open | 2.8 s | 2.9 s |
| ESP32 example: re-open | 2.1 s | 2.3 s |
| ESP32 example: orbit / pan per step | 163 / 156 ms | 177 / 172 ms |
| Dense bench: first open | 3.7 s | 3.7 s |
| Dense bench: orbit per step | 241 ms | 254 ms |
| Benchmark: first open | 2.9 s | 3.0 s |
| Benchmark: re-open | 2.4 s | 2.6 s |
| Benchmark: orbit / pan per step | 167 / 164 ms | 178 / 170 ms |
| Benchmark: 20 enter/leave cycles (open time) | 2.2–2.6 s | 2.2–2.5 s |
| Benchmark: heap after the cycles | 10 MB | 10 MB |
| Benchmark: canvases after leaving | 0 | 0 |
| Shader programs (ESP32 / dense / benchmark) | 5 / 6 / 6 | 5 / 6 / 6 |
| Benchmark: draw calls / triangles | 103 / 128k | 105 / 121k |

A back-to-back A/B with two runs each found orbit and pan equal within noise and re-open about
0.1 s slower. An earlier version cost about 1 s more per open, from one extra shader program for
the contact shadows, and was fixed.

### O.6 Evidence

`docs/sprints/s10-evidence/realism4/`: 17 `compare-*.jpg`, before and after at the same cameras
(`cameras.json`), full tier on this host's software renderer:
- whole scene: three-quarter, opposite side, low, top;
- ESP32: front, rear, USB, WROOM and header;
- wiring: Dupont, long wire, crossing, supply terminal;
- components: LED, diode, resistor, push button, toggle switch.

`software/` holds the same comparisons on the reduced tier; `stats-*.json` and `perf/` hold the
numbers.

### O.7 Real-GPU validation (mandatory for the WOW claim): owner checklist

This host has no GPU, so **nothing in this pass has been seen on real hardware**. On a normal
Windows PC with Chrome or Edge, hardware acceleration on, open dev-lab with `#diag3d`, then
Projects → **ESP32 bench: inputs and indicators** → 3D:
1. The readout says **hardware GPU** with the GPU's name, tier **full** and DPR 1–2. Record the
   line.
2. First open and orbit: smooth, with no stutter while dragging. Note the first-open time.
3. The mat: blue-grey, matte, with a visible rounded edge; no horizon line; the grid faint.
4. Wires: curves, a slight bow on the long feed, the hump over the crossing, jumpers arching
   out of their housings.
5. Shadows soft under the board, the PSU, the switches and the LEDs; nothing floats.
6. Glass diode clear with its internals; the LEDs translucent. Build and Run: yellow and green
   glow at once, the red one when the switch is closed or the button held (since Part P).
7. Metals: pins, USB shell and the RF can read as metal, not grey plastic.

Screenshots of the whole scene, one close-up and the readout are enough.

### O.8 Regression and deployment

Regression on `8611c9b` (clean tree):

| Check | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Unit tests | 830/830 (`wire-shape` +3, `workbench` +2) |
| Browser | PASS |
| Build | PASS |
| e2e | 161 passed, 3 skipped (+`three-diagnostics`) |

Deployed frontend-only with `deploy/dev-lab/publish-frontend.sh 8611c9b`: all publisher checks
passed, and dev-lab serves `8611c9be5a1fb08173afafa01135187364247918`.

Live checks through the gate's origin:

| Check | Result |
|---|---|
| live 3D | 7/7 |
| demo10 | 40/40 |
| Sprint 9 smoke | all passed |
| ESP32 3D controls on `esp32-input-echo` (real build, QEMU runtime) | 17/17 |

The backends were not restarted: `tbi-session-host` and `tbi-build` are active since
2026-10-04. Rollback:

```sh
sudo ln -sfn /srv/tbi-lab/dev-lab/5fab982f927524254e82660e1319ca333e35b69d /srv/tbi-lab/dev-lab/current.tmp &&
  sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
```

### O.9 Backend limitation found (STOP: a backend change would be needed) — RESOLVED in Part P

**Resolved (Part P):** the owner approved the runtime sync; dev-lab's Session Host runs the Sprint
10 engine, and `esp32-bench` builds and Runs end to end. The original finding follows.

On dev-lab, `esp32-bench` builds but does not Run. It fails with "D3: the value of 'Model'
cannot be simulated".

- With an ESP32 in the circuit, the whole circuit is solved by the R2 session host: the frozen
  Sprint 8 backend (`c31d62e`). Its engine predates the Sprint 10 yellow (`tlhy5400`) and green
  (`tlhg4900`) LED models.
- The same scene with all three LEDs on the red model builds and Runs, so the 1N4148 is
  supported there.
- This affects any ESP32 project with a yellow or green LED, not only this example.
- The failure is explicit, never a faked result.

Not changed. Options for the owner:
1. Approve a session-host update to the Sprint 10 engine, with its own regression.
2. Ship the benchmark with red LEDs only, which loses the colour check the brief asks for.
3. Keep it as a visual benchmark that is not runnable on dev-lab until (1).

The deployed example follows option 3 until a decision.

### O.10 Assessment (critical)

| Area | Change |
|---|---|
| Wires | The clearest change: elbows are gone, long runs relax, crossings drape, jumpers arch |
| Mat | Turns an infinite grey CG plane into a finite object on a desk |
| Contact grounding | Visible |
| Lighting | A small change |
| ESP32, Dupont, USB | Small changes, visible only up close |

**Not reached: "closer to a photographed electronics setup than a simulator illustration."** The
scene reads as a clean, well-made product render. What still gives it away:
- perfectly even lighting with no falloff, and no imperfection anywhere;
- the board standing 10 mm up on its header pins, with 14 mm housings on top: physically
  possible but unusual;
- the labels printed on the mat;
- the miniature bench supply, and the stylised ground posts;
- a T-shaped jacket where three wires meet at a junction (no splice);
- part surfaces without micro-texture (P5 was not reached in this pass);
- no real-GPU verification.

## Part N — realism pass 3: high-fidelity visuals (owner direction, 2026-10-07)

Scope frozen: the 3D control behaviour (Part M) is accepted and unchanged, apart from motion
curves. This block went into visual realism.

Method:
- The current deployed build (`5999a4c`) was captured at full quality at fixed close-up cameras
  (the evidence harness, `scripts/evidence`).
- Each part was judged against its real counterpart.
- The parts were changed where they read as "simulator", then recaptured at the same cameras.

### N.1 What read as artificial (before)

| Part | Problem |
|---|---|
| LED | An opaque red plastic cylinder; lit, the whole shell brightened uniformly; the legs rendered dark |
| 1N4148 | Orange "candy" plastic: the copper slugs filled half the tube, behind a strong orange tint |
| ESP32 header | Tall mirror-chrome solder cones under gold tips ("Christmas trees") |
| Metal overall | Dull grey: the environment's intensity was only 0.4, so flat metal (USB shell, legs) read as grey plastic |
| Push button | Round wire legs instead of stamped strips |

### N.2 Changes

| Part | Change | Type |
|---|---|---|
| LED | Frosted, translucent epoxy (transmission 0.82, roughness 0.4, the tint by absorption keeping hue): the lead frame shows inside. Lit, the light starts at the die: a glow core round it, the lens glowing most near the die and softer up the dome (no uniformly emissive shell). Current-driven brightness unchanged | procedural |
| 1N4148 | Clear glass with a light amber cast; real-size DUMET slugs (~0.55 mm in the 1.75 mm envelope) and the die visible inside | procedural |
| ESP32 | Header joints are low concave solder menisci (~0.45 mm) in satin lead-free solder; GLB regenerated (deterministic, 786 KB, was 721 KB) | hybrid (GLB + runtime) |
| Leads (shared) | Tinned leads satin (roughness 0.4), chrome slightly softer; formed axial leads bend round a ~2× diameter radius with smooth 12-sided tubes | material library |
| Push button | Flat stamped 0.7 × 0.3 mm legs (`kit.ts ribbon`, reusable for any flat lead or lug) | procedural |
| Lighting | A project-owned product-shot studio for reflections, procedural with no image asset: a soft sky over a darker floor, an overhead softbox, two strip lights and a front card. Environment intensity 0.4 → 0.75, key light trimmed | stage |
| Motion | Lever: ease-in-out (an over-centre snap). Cap: ease-out down, soft ease-in-out return. The electrical state is unchanged and immediate | renderer |

Resistor, toggle switch, Dupont housings, wires, the direct-contact joint and the WROOM module
were reviewed and kept. They are already at the standard (Parts H and I) and gain from the shared
material and lighting changes.

### N.3 Assets, sources, licences

All visuals remain original to this project: procedural code, or a GLB authored from code here.
No third-party asset ships. The licence gate (`manifest.ts`, `scene3d-realism.test.ts`) is
unchanged. Dimension references, as in Parts H and I:

| Part | References |
|---|---|
| ESP32 | [ESP-DIM], [WROOM] |
| LED | [V83012], [V83009] |
| 1N4148 | [V81857] |
| Resistor | [CFR25] |
| Tactile switch | [REP] 6 × 6 mm class |

The studio environment is code in `stage.ts`.

### N.4 Numbers (full tier, the evidence cameras)

| Scene | Draw calls | Triangles | Materials | Geometries | Textures | GPU memory |
|---|---|---|---|---|---|---|
| ESP32 overview | 162 → 162 | 176k → 189k | 43 → 44 | 49 → 49 | 33 → 33 | 37.2 → 37.5 MB |
| Parts bench | 149 → 149 | 196k → 202k | 41 → 43 | 44 → 44 | 34 → 34 | 6.4 → 6.5 MB |
| ESP32 input echo | 238 → 238 | 330k → 344k | 64 → 65 | 69 → 69 | 45 → 45 | 41.5 → 41.8 MB |

Software renderer (reduced tier), `5999a4c` → now:

| Measure | Before | After |
|---|---|---|
| ESP32 first open | 3.8 s | 2.6 s |
| Re-open | 2.0 s | 1.9 s |
| Orbit, per step | 206 ms | 162 ms |
| Pan, per step | 158 ms | 153 ms |
| Dense first open | 3.6 s | 3.3 s |
| Dense orbit, per step | 241 ms | 245 ms |
| Draw calls (ESP32 / dense) | 48 / 185 | 48 / 185 |
| Shader programs | 5 / 6 | 5 / 6 |
| Heap, ESP32 after open/close cycles | 10 MB | 10 MB |
| Heap, dense scene | 37 MB | 45 MB |

The dense heap figure is a single measurement. It includes one glow-core material per LED, and
garbage-collection timing may add to it.

### N.5 Evidence

`docs/sprints/s10-evidence/realism3/`: `compare-*.jpg`, before (`5999a4c`) and after, same
cameras, full tier on this server's software renderer:
- the ESP32 three-quarter, rear/underside, USB and buttons, WROOM, header pins, and wire into a
  header;
- the resistor, the LED unlit and lit, the diode, the toggle switch, the push button and the
  direct contact;
- LED colours, the parts overview and the echo overview;
- `stats-*.json` and `perf/`.

### N.6 Regression and deployment

Regression on `5fab982` (clean tree):

| Check | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS |
| Unit tests | 825/825 (89 files; +4 in `realism3.test.ts`) |
| Browser | PASS |
| Build | PASS |
| e2e | 160 passed, 3 skipped (9.8 min) |

Deployed frontend-only with `deploy/dev-lab/publish-frontend.sh 5fab982`: all publisher checks
passed, and dev-lab serves `5fab982f927524254e82660e1319ca333e35b69d`.

Live checks through the gate's origin:

| Check | Result |
|---|---|
| live 3D | 7/7 |
| demo10 | 40/40 |
| Sprint 9 smoke | all passed |
| ESP32 3D controls (real build, QEMU runtime) | 17/17 |

The backends were not restarted: `tbi-session-host` and `tbi-build` are active since
2026-10-04. Rollback:

```sh
sudo ln -sfn /srv/tbi-lab/dev-lab/5999a4c754fc2a812b2290e31312602e9ba7eda8 /srv/tbi-lab/dev-lab/current.tmp &&
  sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
```

### N.7 Honest assessment

- **Obvious improvements:** the LED, the 1N4148 and the ESP32 header joints.
- **Modest improvements:** metal everywhere, the push button's legs, the USB shell.
- **Not yet at the "photographed bench" bar:**
  - the ESP32's other features are unchanged this pass (USB stamping detail, SMD part detail,
    rear-side detail);
  - the bench is a clean grey plane with no breadboard;
  - wires run orthogonally in plan;
  - nothing has been seen on a real GPU yet.

## Part M — operating physical controls in 3D during a simulation (owner-approved, 2026-10-07)

Approved:
- the toggle switch and the momentary push button, operable in the 3D view while a simulation
  runs.

Not approved, and not implemented:
- general 3D editing (moving parts, wiring, topology), potentiometers, multi-position switches.

### M.1 One control-action path (`app/src/ui/controls.ts`)

The Circuit view and the 3D view call the same actions; neither has a control state of its own.
- **Toggle** (`toggleControl`): the persistent document edit the Circuit view always made.
  `setParam` on the type's `toggleParam`, through `store.apply`: revision, autosave, undo. While
  running, the store mirrors it to the session as a live control.
- **Momentary** (`pressControl`): the transient runtime input (`store.press` → the simulation
  controller), the same path for the analog circuit and an ESP32's input pin. Only while running,
  never persisted.
- **State** (`controlState`): the document's switch position and the session's pressed set. Both
  views render from it.

The Circuit view now calls these actions instead of its own copies; its behaviour is unchanged.

### M.2 Interaction descriptors and targeting

- **Actuator tagging.** The part builders tag their actuators (`userData.actuator`): the toggle's
  lever, a group pivoting at the bushing top with tilt ±0.38 rad (`TOGGLE_TILT`); the button's cap,
  with rest height and 0.45 mm travel (`TACTILE_TRAVEL_MM`). Batching never merges an actuator.
- **Actuator regions.** `pick.ts actuators(scene)` gives each control's region from the real
  dimensions: the lever's whole swing above the nut, or just the cap. A future control (a knob, a
  multi-position switch) adds a region there.
- **While running:** a hit on an actuator region operates it. The part's own body box encloses the
  lever, so it does not hide its own actuator, but other parts and wires in front still win.
  Clicking the switch body or the button housing selects the part.
- **Stopped:** actuators are not considered, so any click selects the part and nothing is operated.

### M.3 Gestures (ThreeView)

- **Pointer down on an actuator while running** is handled in the capture phase and stopped, so
  the camera never orbits from an actuator:
  - the toggle flips on press;
  - the button is pressed and the pointer captured.
- **Release always arrives:** pointer up, pointer cancel, lost capture, leaving the view (captured),
  or Stop / session end all release it. A held button never stays pressed.
- **Keyboard:** Space or Enter on the selected switch or button (the 3D view focused) toggles it,
  or holds the button until key-up. Auto-repeat changes nothing.
- **Accessibility:** a synchronized, visually hidden control for the selected switch or button,
  named for assistive technology (EN/HE):
  - "Toggle switch SW1, open" (`role=switch`, `aria-checked`);
  - "Push button SW1, released" (`aria-pressed`);
  - stopped, it adds "Run the simulation to operate it." and is `aria-disabled`.

  The Circuit view's controls remain available.
- **Cues:** the pointer cursor over an actuator while running (hover picking is throttled to
  animation frames), and a one-line hint under the view note while running. No toasts.

### M.4 Physical animation (renderer `setControls`)

- **State first, animation follows.** Each actuator moves to the pose its state requires: the
  lever swings about its pivot in 150 ms; the cap travels down 0.45 mm in 60 ms and returns in
  80 ms. Ease-out, no bounce.
- **Reduced motion:** with `prefers-reduced-motion` the pose changes at once.
- **Rendering cost:** frames are drawn only while something moves, refreshing the shadow map
  meanwhile; there is no permanent loop.
- **No rebuild:** a control-only change does not rebuild the scene; the scene's structural key
  ignores switch positions. Measured: the object count is unchanged, with about 3 frames per toggle.

### M.5 Tests

| Test file | Tests | What they check |
|---|---|---|
| `controls.test.ts` | 2 | Which parts are physical controls; state from the document and the session |
| `pick.test.ts` | +2 | Actuator regions; while running the lever and cap operate, stopped they select; the toggle body from the side selects |
| `three-controls.spec.ts` (e2e) | 2 | Toggle and push-button behaviour, below |

The toggle e2e test, on `rgb-mixer` SW3:
- stopped, a lever click selects and changes nothing;
- running, a click closes the switch: the 3D state, the Circuit's `data-closed`, the lever pose
  (−0.38 rad), the LED mix and the stored project all follow;
- a second click opens it again;
- Space on the selected switch toggles it, with the accessible name updated;
- a toggle in the Circuit view is followed by the 3D lever.

The push-button e2e test, on `push-button` SW1 → D1:
- press → pressed in 3D and Circuit, LED lit, cap down;
- release → off, cap back;
- leaving the view while held → released;
- pointer cancel → released;
- keyboard hold → pressed only while the key is down;
- Stop while held → released, cap back.

Live ESP32, on dev-lab with the real build service and QEMU (`esp32-input-echo`: SW1 and SW2 →
GPIO34 → firmware → GPIO4 → D1), operated only in 3D:
- the lever closes SW1: the Circuit agrees, GPIO34 goes high, the firmware drives GPIO4 high and D1
  lights;
- the lever opens SW1: GPIO4 goes low;
- SW2 held: GPIO34 and GPIO4 high, D1 lit;
- SW2 released: both low.

The live run (`.tmp/s10/live3dctl.mjs`) passed 17/17 checks. GPIO34 is an input-only pad, and the
runtime reports levels only for driven pins. So the firmware's echo, `digitalRead(34)` →
`digitalWrite(4)`, is the observation that the input reached it: GPIO4 followed every 3D operation.

Regression on `5999a4c`:
- CI: typecheck, lint, build pass; unit tests 821 passed; browser e2e 160 passed, 3 skipped;
  legacy suite pass.
- Live dev-lab: 3D 7/7, demo 40/40, Sprint 9 smoke 48/48, 3D controls on the ESP32 17/17.

### M.6 Performance

This host, software renderer:
- From a click to the shared state changing: 14–885 ms, single runs. The first click includes
  one-time setup of the part volumes, and the rest depends on the frames already in flight on the
  software GPU.
- No rebuild, about 3 animation frames per operation.
- Hover picking is at most one pick per animation frame, only while running.

### M.7 Evidence

`docs/sprints/s10-evidence/controls/`:
- `ctl-toggle.jpg`: rgb-mixer SW3 open → closed (blue joins the LED's mix) → open;
- `ctl-button.jpg`: push-button SW1 released, held with D1 lit, and a cap close-up held and
  released;
- `controls-run.webm`: a recording of both sequences;
- `esp32-3d-toggle-closed.png`, `esp32-3d-button-held.png`: the live dev-lab ESP32 run, D1 lit by
  the firmware.

### M.8 Limitations

- **Software renderer.** Rendered on the server's software renderer. On a real GPU the movement is
  smoother and quicker.
- **Toggling on press.** The toggle flips on press, so a drag that starts on a lever does not orbit
  the camera.
- **Haptics and sound.** There is no haptic or sound feedback; the movement is the feedback.
- **Accessible name.** It is set on the hidden control; a dedicated live region announcing every
  change is not added.

## Part L — false-hop fix, net wire colours, limited 3D interaction (owner review, 2026-10-07)

The owner accepted the Part K routing and approved two things:
- net-based wire colours, with a manual override;
- limited 3D interaction: selecting parts and wires, and editing safe properties.

Full 3D topology editing is not approved, and is not implemented: no moving parts, creating or
deleting wires, connecting terminals, or 3D routing edits in 3D.

### L.1 The false hop

- **Observed:** a purple wire made a raised bridge near a transistor and the supply, although a low
  route was clear.
- **The owner's case:** the owner's own project lives in their browser and is not available here.
  The case was reconstructed by searching transistor-beside-supply layouts with auto-routed wires.
  In 8 of them the deployed router (`1c5572b`) lifted the purple base wire (R3 → Q1.base) to
  8.9 mm.
- **Root cause:** conservative routing volumes. The TO-92 was its whole ±6.7 mm footprint box up
  to its full height, though its real body is 4.8 × 3.7 mm and its leads splay down to the bench.
  The supply's binding posts were a solid strip across its whole front, though they are two 2.2 mm
  posts 3.1–5.3 mm above the bench.
- **Fix:**
  - **Real routing volumes:**
    - the TO-92 is its D-body plus each lead, high near the body and low near the terminal;
    - the supply is its case plus two raised posts, which a wire may pass under;
    - the RGB LED, photoresistor and capacitor are their body plus low leads (the capacitor by its
      real package).
  - **Final actual-clearance check:** before any rise for a body, the low candidate route (resting
    on the bench, rising only to its ends) is tested against the body's volume by true 3D distance
    (tube radius plus 0.3 mm, corners included). If it is clear, no rise is made (`route3d.ts
    clearLow`).
- **Regression fixture:** `transistorPsuCircuit` in `route3d.test.ts`.
  - The base wire stays below 1.2 mm.
  - It is checked against the *built* transistor model: the body's box and every lead vertex, at
    least a wire radius away.
  - Nothing touches; the result is deterministic; the save is byte-identical.
  - A wire genuinely crossing a transistor still rises over it.

### L.2 Routing preference order (documented in route3d.ts)

1. valid connectivity;
2. no physical collision (checked against real volumes);
3. the shortest physically plausible path;
4. the lowest reasonable height;
5. the fewest bends;
6. the least deviation from the 2D route.

A conservative clearance never comes before the check that it is actually needed.

### L.3 Net wire colours: one resolution for 2D and 3D

`app/src/views/wireColors.ts`: `resolveWireColors(doc)` turns each wire plus the connectivity graph
into its resolved colour. The Circuit view (SVG stroke) and the 3D view (jacket) both use it; no
other colour logic exists.

- **Automatic:** by electrical node, from topology only; never current flow or drawing order.
  - **Red:** a node on one or more voltage-source positive terminals (the bench supply), and no
    negative one.
  - **Black:** a node on a source's negative terminal or the reference (ground), and no positive
    one.
  - **Neutral grey:** a node on both, such as a shorted supply. The circuit checks keep flagging it.
  - **Signal palette:** every other node, in the graph's stable order (orange, blue, green, purple,
    yellow, teal, brown).
- **Component boundary:** the colour stops at every component. With PSU+ → R → LED, only the
  PSU+ → R node is red.
- **Manual:**
  - a wire's `Wire color` property in the Inspector: Auto (shown with the colour it gives, e.g.
    "Auto (red)") or one of 9 colours;
  - it changes only that wire; the rest of its net stays automatic;
  - Auto restores the net colour;
  - it is saved in the project, round-trips through export and import, and survives a junction
    split;
  - it never changes a net.
- **Circuit view:** wires now show their resolved colour. A selected wire keeps its colour, with a
  soft halo behind it (so a blue wire is not confused with the selection).

### L.4 Data model

`Wire.color?: WireColor` (`red`, `black`, `orange`, `blue`, `green`, `purple`, `yellow`, `teal`,
`brown`) is optional; absent means Auto.

- No schema version change and no migration: older projects are Auto and electrically unchanged.
- The validator refuses an unknown colour.
- The package import allowlist now accepts `color`.
- **Forward compatibility:** a project carrying a manual colour cannot be imported into a build
  older than this one (its strict import refuses the unknown field).

### L.5 3D interaction (`pick.ts`, renderer, ThreeView)

- **Picking works on logical entities, not meshes.** Static meshes are merged across parts for
  speed, so a mesh no longer knows its part. The click ray is intersected with:
  - each part's routing volumes (body, leads, posts, jumper housings → the part);
  - each wire's drawn tube (slightly generous radius → the wire).

  The nearest hit wins. The bench, backdrop, labels and shadows are not in the set, so they never
  select anything.
- **Click vs drag:** a press moving less than 5 px is a click and selects; more is camera
  navigation. Picking runs only on a click; there is no per-frame raycast.
- **Selection:** it is the project's single selection, so the Inspector, Circuit and Schematic show
  the same part. A click on the empty bench clears it. Wire colour (and any existing safe property)
  is edited in the existing Inspector.
- **Feedback:** a thin blue ring on the bench round a selected part; a faint translucent sleeve
  round a selected wire.

### L.6 Tests

- **Colours** (`wire-colors.test.ts`, 7 tests):
  - A: PSU+ through a junction → all red;
  - B: PSU− and ground → black, and an ungrounded negative → black;
  - C: the colour stops at the resistor;
  - D/E: manual blue in 2D and 3D, only that wire, nets unchanged, Auto restores;
  - F: export/import round trip, unknown colour refused;
  - G: a conflict → neutral; two positives → red;
  - every example the same in 2D and 3D, deterministic.
- **Picking** (`pick.test.ts`, 5 tests): parts from above and at an angle; a lead or the PIR's pin
  header → the part; every wire; the bench and labels → nothing; deterministic and cheap.
- **False hop** (`route3d.test.ts`, +2): see L.1.
- **Browser e2e** (`three-pick.spec.ts`, 2 tests):
  - click the relay → selected, Inspector shows K1;
  - a drag orbits without changing the selection;
  - click a wire → selected; recolour it blue in the Inspector → 3D, the Circuit view and the stored
    project all show blue; Auto restores it;
  - a click on the bench clears;
  - the Hebrew control reads "אוטומטי (אדום)".

### L.7 Performance

This host, software only:

| Scene | Colour resolution | Pick (one click) | `deriveScene` |
|---|---|---|---|
| esp32-input-echo | 0.10 ms | 0.15 ms | 5.7 ms |
| pir-alarm | 0.07 ms | 0.09 ms | 4.1 ms |
| dense bench | 0.27 ms | 0.27 ms | 19.9 ms |
| stress project (42 parts) | 0.49 ms | 1.0 ms | 64.9 ms |

`deriveScene` is unchanged from `1c5572b`: 7.5, 3.4, 18.6 and 70.5 ms in the same run. The part
volumes for picking are computed once per scene, on the first click.

Regression on `3921186`:
- CI: typecheck, lint, build pass; unit tests 817 passed; browser e2e 158 passed, 3 skipped;
  legacy suite pass.
- Live dev-lab: 3D 7/7, demo 40/40, Sprint 9 smoke 48/48.

### L.8 Evidence

`docs/sprints/s10-evidence/interaction/`:
- the false-hop fixture before and after (top, angled);
- three examples in the Circuit view before and after net colours;
- 3D selection of a part and of a wire, with the Inspector.

### L.9 Remaining

- The owner's exact project was not available; the regression is a reconstruction. If the case
  recurs, an exported `.tbilab` of it would let it be pinned exactly.
- Parts not refined yet keep conservative volumes: the relay, buzzer, PIR, matrix and ESP32 are
  their bounding boxes. A round body (buzzer) can still lift a wire grazing its box's corner region,
  though the final 3D-distance check now catches most such corners.
- Deeper 3D editing is deferred. The 3D view derives everything (separation, fresh routes, drape)
  from the 2D project, so editing in 3D would need a second layout state with rules for writing it
  back to 2D. Recommendation: keep it deferred until there is a product need beyond selecting and
  editing properties.

## Part K — fresh 3D wire routes (owner review: PIR alarm, relay -> LED; 2026-10-07)

Owner findings:
- In "PIR alarm: motion activates buzzer", the wires leaving the PIR rose in a vertical bundle, with sharp bends, crowding, and paths that still followed the old 2D route after the separation.
- In the relay example, a short wire beside the relay climbed high before reaching its neighbour. That wire is K1.NO → R1, the resistor next to the LED.

The body separation itself was accepted.

### K.1 Root cause

- **One height per wire.** The old router (`wireHeights`, kept as the fallback) gave each wire a
  single height for its whole length: the highest thing anywhere along it, plus a per-wire level
  offset. One tall obstacle (the relay, the PIR dome) lifted the entire wire, and every end became a
  tall vertical riser. That produced the PIR "fence" and the relay climb.
- **Ends under a body.** The 2D route ends at the 2D terminal, often inside the real 3D body. The end
  hooked back to the real pin, and after a separation move it was stretched rather than re-routed.
- **Corners.** Corner radii were 2–3 mm.

### K.2 Order of operations (`scene.ts buildScene`)

1. base transforms from 2D;
2. body separation;
3. final transforms;
4. final terminal positions;
5. fresh plan paths (`freshWires`);
6. height profiles (`route3d.ts`);
7. natural drape (`wireShape.ts`, now keeping the router's radii);
8. labels.

Nothing is routed before the separation and stretched afterwards.

### K.3 Plan path, exit lanes, fan-out

- **Exit lane.** A pin under a part's body (relay, PIR, matrix, LED legs) leaves through an exit lane:
  straight out at pin level, past the body edge.
  - The side is the cheapest valid one: distance to the edge plus half the distance onward to where
    the wire is going. "Valid" means the lane passes no other pin of the part.
  - So a relay pin exits towards a nearby destination, not merely towards the nearest edge.
  - A lane never runs into another part.
- **Fan-out** (any multi-pin part, nothing PIR-specific). Every lane on one side gets its own
  distance:
  - lanes turning the same way turn one after another, the one nearest that way first, one pin pitch
    (2.54 mm) further out each, with concentric bends (radius 2.5 + k × 2.54 mm);
  - straight lanes come next; lanes turning the other way come last.
  - No two lateral runs share a line. The body separation reserves room for up to three lanes per
    side.
- **2D topology.** The 2D route supplies the path in between. Its stretch inside a lane part's zone is
  dropped, and the lane rejoins the route by the cheapest orthogonal connection. The connection
  never reverses, never re-enters the part, and pays heavily for crossing another part's body.
- **Clean-up.**
  - Back-and-forth spikes and collinear points are removed.
  - **Small lateral offset first:** a run grazing a bench-level body by up to 3 mm sidesteps it in
    plan with gentle tapers.
  - A destination right in a lane's corridor (a resistor lead under the PIR board's edge) gets a
    straight run.

### K.4 Height and bend rules (`route3d.ts`)

- **Local by default.** A wire rests just above the bench (centre 0.9 mm). A short local connection
  stays low (the relay → LED case).
- **Global only where needed.** Over an obstacle it rises to that obstacle's top + radius + 0.5 mm,
  only over that stretch, with ramps of at most 35°. The ramp is steeper only when the wire must
  climb more over its length, as to a jumper housing 25 mm up. Then it climbs evenly, not with a
  vertical riser.
- **Obstacles** (routing volumes):
  - a leaded part = its body at full height plus its leads only as high as the leads (2.8 mm);
  - the supply = case plus a low post strip; the ground post = plate plus post;
  - the ESP32 = board up to the module top, plus each wired pin's jumper housing;
  - the PIR = board and dome raised over its header, so a wire may pass **under** the board when there
    is room (the ground wire to GND2 does);
  - every terminal, header-pin stub and junction is a spot to clear.
- **Own part.** A wire may leave its own part. Where it runs back over the part's body, it clears it.
- **Other wires.** It passes under where the other wire is high enough. Otherwise it hops over
  locally, by a diameter plus 0.3 mm, never by lifting the whole wire.
- **Profile shape.**
  - Valleys narrower than 12 mm between two raised stretches are spanned (fewer, longer curves).
  - A wire that was found to pass under something is never pushed up into it.
  - The profile is simplified so it never falls below the requirement.
  - Bends: plan corners 4 mm, ramp knees 5 mm, lanes concentric. A jumper leaves its housing straight
    up for 2.5 mm, then droops.

### K.5 Collision fallback

The rules apply in this order:
1. plan sidestep of a shallow graze;
2. local height (hop or arch) over the obstacle, or pass under a raised one;
3. re-route with a different wire order when wires of different nodes still touch (deterministic, at
   most 4 rounds, fewest contacts wins);
4. then the previous safe route.

`deriveScene` keeps the old router, then the 2D placement, as fallbacks if anything of different
nodes still touches. No example or fixture uses a fallback (tested).

### K.6 Tests

`app/tests/route3d.test.ts`, 13 tests:
- **PIR alarm** (the owner example): the PIR overlaps nothing; three wires leave three separate pins
  along straight lanes at pin level; no vertical stretch over 1 mm; low within 12 mm of the module;
  through no body; no zig-zag; nothing touching; deterministic; byte-identical save; exact ends.
- **Relay → R1** in relay-load, and a relay wired to a nearby LED: below 1.5 mm, no climb, short.
- **Genuinely obstructed** wire across a relay: rises over it as an arch with no vertical riser, and
  is low at both ends.
- **Fixtures:** PIR beside the ESP32; two neighbouring modules (moved PIR, unmoved matrix); dense
  module wiring.
- **All 16 examples:** through no body, no zig-zag, nothing touching, every bend ≥ 2.5 mm.
- **Fan-out:** four matrix pins turn at four distances.
- **No fallback:** every example and fixture shows the fresh routes.
- **Determinism.**

Updated for the new local-height rules:
- `scene3d.test.ts`: crossing wires are a diameter + 0.3 apart at the crossing; a wire over parts
  clears them where it is over them.
- `semantics.test.ts`: header pins are checked at their real positions, and a wire over them clears
  them by the clearance.
- `wire-shape.test.ts`: the clearance reference uses the router's radii; drape is counted for wires
  that span in the air.

### K.7 Performance

This host, software only; `deriveScene` and the drape (`shapeWires`), before (`2eb6d9b`) → after:

| Scene | Derive before | Derive after | Drape before | Drape after |
|---|---|---|---|---|
| esp32-input-echo | 4.5 ms | 6.6 ms | 9.7 ms | 9.0 ms |
| pir-alarm | 2.2 ms | 2.9 ms | 7.3 ms | 6.6 ms |
| relay-load | 2.5 ms | 4.7 ms | 10.1 ms | 8.8 ms |
| dense bench | 15.7 ms | 16.2 ms | 24.7 ms | 30.0 ms |
| stress project (42 parts) | 16 ms | 74 ms | 131 ms | 129 ms |

The stress project needs three routing rounds, about 15 ms each, plus the safety check.

How the cost was brought down:
- the height profile is computed on a 0.25 mm grid with forward and backward slope passes (linear
  time);
- bounding-box prefilters run before every exact distance test;
- there is no general-purpose router.

Regression on `1c5572b`:
- CI: typecheck, lint, build pass; unit tests 803 passed; browser e2e 156 passed; legacy suite pass.
- Live dev-lab: 3D 7/7, demo 40/40, Sprint 9 smoke 48/48.

### K.8 Evidence

`docs/sprints/s10-evidence/wires/`, before (dev-lab `2eb6d9b`) and after, same cameras:
- **PIR alarm:** top, three-quarter, low side, pins close-up.
- **Relay example:** top, three-quarter, low side, relay/LED close-up.
- **Relay + LED, PIR + matrix, ESP32 + PIR, dense mixed:** top and angled.
- **Overviews:** six other examples.

Software renderer, reduced tier.

### K.9 Still artificial

- **2D topology.** Plan paths still follow the 2D route's orthogonal runs between ends (rounded
  corners), not free-form curves.
- **Very short climbs.** A wire to a jumper housing 25 mm up from a lead a few mm away is a steep ramp.
- **Crowded fans.** With more than three wired pins on one side and no room, lanes share distances and
  hop over each other.
- **Old drawings.** A 2D route drawn across a part (old or imported drawings) makes the wire arch over
  that part.

## Part J — 3D body separation (owner review, 2026-10-07)

Owner finding: the 2D circuit is correct, but in 3D physically larger parts can intersect (seen:
the LED matrix and the PIR module). Fixed generically, in the derived 3D scene only.

### J.1 Root cause

The 2D circuit places each part by its **symbol**; the 3D scene gives it its **real size**
(physical.ts). For the large modules the two differ a lot: the HC-SR501 board is 32 × 24 mm with
a 23 mm dome, its symbol 17.5 × 12.7 mm (`bbox` −60…50 × −40…40 layout units); the 1088AS matrix
is 32 × 32 mm, its symbol 28.6 × 44.5 mm but offset. Symbols that sit one grid step apart in 2D
put real bodies ~7 mm into each other. Nothing in the 3D derivation checked physical volumes.

### J.2 Algorithm (`app/src/views/scene3d/separation.ts`, wired in `scene.ts`)

`2D position → base 3D transform → physical collision check → minimal visual-only separation →
final 3D transform`. The project is never touched.

- **Collision volumes** (`scene.ts collisionBoxes`): each part is one or more boxes in its own
  frame, each with a height range: by default its physical footprint (`FOOTPRINT`, the capacitor's
  from its actual package) from the bench to its top; the PIR module as its board at its real
  height (8.5 mm standoff) over its pin header, so a low part may sit under its edge as on a real
  bench; for every **wired pin under a body** (PIR, matrix, relay, LED legs) the strip its wire
  leaves by at pin level, tagged with the pin's node (it may touch parts that have a terminal on
  that node, never others). Conservative, axis-aligned in plan.
- **Allowed to touch:** parts joined by a direct contact or with touching terminals form one rigid
  unit (moved together, never tested against each other); jumper housings belong to their board;
  wires are not obstacles (they are re-routed and re-shaped from the final positions).
- **Collision:** deeper than 0.4 mm on both plan axes and overlapping heights (merely touching
  parts, as close passives, are left alone).
- **Resolution, deterministic:** first overlapping pair in document order; the less anchored part
  moves (J.3) along ONE plan axis by the smallest distance that clears the other by 1.0 mm (never
  rotated, never lifted); of the four directions the one creating no new overlap wins, shorter
  first, ties +x, −x, +z, −z; repeated until clear (at most 48 rounds).
- **Following the move:** terminals, contacts and labels follow the final transform; each wire end
  on a moved part is dragged with it keeping the route orthogonal (the last run stretches, or moves
  across with the part), then the usual end rules, heights and the natural drape run on the final
  scene. A riser at an under-body pin's approach point is now a spot other wires clear (a gap
  the moved geometry exposed).
- **Electrical safety net:** if a moved part's wires or terminals would touch anything of another
  node (`touchingNodes`), the whole scene keeps the 2D-derived placement and the overlaps are
  reported. The separation can never suggest a connection.

### J.3 Displacement and priority rules

- Anchoring: ESP32 board > bench supply > ground post > large module (PIR, matrix, relay, buzzer)
  > small part; then the larger plan area stays; then the earlier part in the document stays. For
  PIR + matrix only the PIR (smaller board) moves.
- Cap: a part moves at most half its larger plan dimension, between 4 and 16 mm (a 32 mm module up
  to 16 mm, a resistor 6.7 mm). If the mover cannot clear within its cap, the other part is tried
  (never the board: the MCU stays where 2D put it). If neither can, both stay where 2D put them and
  the 3D view shows a non-blocking notice naming the parts (EN/HE, `view3d.overlap`): a part laid
  on another is not flung away and the circuit is not scattered.

### J.4 Effect on existing scenes

| Scene | Moved |
|---|---|
| All 16 curated examples | none (the PIR alarm's resistor and ground post sit under the PIR board's edge, which is physically fine) |
| Parts bench, dense bench | none |
| Shared mixed test circuit | R2 2.15 mm (under the bench supply), GND2 2.2 mm (on another ground post) |
| Stress project (big.tbilab, 42 parts) | R2 2.15 mm, GND2 2.2 mm (same arrangement) |
| PIR + matrix (owner case) | PIR 10.25 mm away from the matrix (its pin strips face the matrix) |
| ESP32 + PIR beside it | PIR 8.7 mm outward; board unmoved |
| Dense mixed bench | PIR 8.7 mm, C1 1.5 mm; board and passives unmoved |

### J.5 Tests

- `app/tests/separation.test.ts`:
  - **A.** PIR + matrix (2D boxes clear, 3D bodies overlap): no overlap after; only the PIR moves, along one axis, exactly the 1 mm gap; 2D unchanged; terminals, nodes and wire ends on the moved pins; drape keeps the ends.
  - **B.** ESP32 + module: board unmoved, module outward.
  - **C.** close passives and every curated example: nothing moved.
  - **D.** direct contact with overlapping bodies: not separated; a contact cluster moves as one.
  - **E.** determinism.
  - **F.** save/load: package text identical before/after, re-derived scene identical.
  - Also: cap and unresolved report, labels on the final position, dense mixed bench, cost.
- Cross-view agreement (`semantics.test.ts`): Circuit, Schematic and 3D agree for the four fixtures.
  3D terminal identity (ids, order, nodes) equals the netlist; only transforms differ.
- e2e `app/e2e/separation.spec.ts`:
  - PIR moved in 3D (`data-moved`) while the stored project keeps its coordinates;
  - a part laid on another shows the notice in EN and HE, and the view stays usable.

### J.5a Performance (this host, software only, mean of repeated runs)

| Scene | Collision pass | Safety check (only when something moved) | `deriveScene` before → after |
|---|---|---|---|
| esp32-input-echo (12 parts) | 0.36 ms | — | 3.3 → 4.0 ms |
| dense bench (43 parts) | 2.2 ms | — | 9.5 → 13.7 ms |
| stress project (42 parts) | 2.0 ms | 2.3 ms | 12.4 → 15.0 ms |
| PIR + matrix | 0.19 ms | 0.14 ms | 0.8 → 1.0 ms |

A plain pairwise pass (no spatial grid) is enough at these sizes. A pathological pile of 70 large
bodies resolves in ~25 ms. Rendering is unchanged (same meshes, only positions differ).

Regression on `2eb6d9b`:
- CI: typecheck, lint, build pass; unit tests 790 passed; browser e2e 156 passed, 3 skipped; legacy suite pass.
- Live dev-lab: 3D 7/7, demo 40/40, Sprint 9 smoke 48/48.

### J.6 Evidence

`docs/sprints/s10-evidence/separation/`:
- `compare-sep-*.jpg`, before (the deployed `1fc122f` release) and after, same cameras, top and
  angled: PIR + matrix, ESP32 + module, dense mixed;
- `notice-en.png` and `notice-he.png`.

Software renderer, reduced tier.

### J.7 Cases that can still overlap visually

- A part laid on (or almost on) another beyond the cap: it stays, with the notice.
- The safety net: if moving would make different nodes touch, the whole scene keeps its 2D
  placement, with the notice.
- Parts inside one direct-contact cluster: never separated, by design.
- Conservative boxes: round or irregular bodies (LED flange, TO-92, buzzer) are taken as their
  rectangles, so in rare cases parts are pushed a little more than strictly needed. Nothing is
  pushed less.
- Wires are not obstacles for the separation. Wire heights are recomputed afterwards, as before.

## Part I — realism pass 2 and the product footer (2026-10-07)

Owner direction: keep pushing towards "this looks real"; the most visible remaining artificial cues
were the floating labels, the geometrically perfect wires, the older component models, a slightly
glassy LED and a sterile bench. Plus the approved product footer.

### I.1 Labels: printed on the bench, not floating

The reference designators were white rounded cards hovering over every part (the strongest
"simulator UI" cue). They are now **printed on the bench beside their part** (`renderer.ts`
`label`, placement `labels.ts`): dark ink in the boards' stroke font on a thin decal, lit and
shadowed with the scene and hidden behind parts like real print. Placement is deterministic: in
front of the part, else to its right, left, behind, further out; never on another part's
footprint or another label (tested). A **Labels** toggle in the 3D view hides them (a per-browser
preference, `tbi-lab.3d.labels`; never project data).

### I.2 Wires: natural drape, still guaranteed clear (`wireShape.ts`)

- long level runs (≥ 14 mm) **sag** up to 2 mm (≈ 3.5 % of the span) along a smooth profile; the
  low point sits off-centre by a stable per-wire amount (hash of the wire id: asymmetry without
  randomness);
- a riser turns into its run with a **hand-formed bend** (radius up to 6 mm, limited by the riser
  and the run); plan turns stay 2 mm;
- out of a jumper housing the wire runs straight for 2.5 mm before it bends (strain relief);
- **every draped wire is checked** against every other wire (surface gap ≥ 0.12 mm, as the route
  guarantees) and every part body it does not connect to (never lower than its route there); if it
  fails it is retried at half sag, then drawn as the route. Ends, connectivity, colours unchanged.
- Result on the examples/benches: esp32-blink 4/4 wires draped, esp32-input-echo 11/13,
  night-light 10/10, parts bench 8/10, dense bench 28/30; shaping takes 7–58 ms (software CPU).

### I.3 LED material (moulded epoxy, not glass)

Tinted-diffused: transmission 0.55 → 0.32, roughness 0.5 → 0.62 (the frame inside shows as a
soft shape), satin moulded skin (clearcoat 0.55, roughness 0.22), deeper tint (the red read pale
salmon). Water-clear (3 mm green): transmission 0.92, roughness 0.1. The LED's internal frame is
excluded from ambient occlusion. Lit: unchanged principle (light from the die, lens glow profile,
halo, bench tint from the light pool). Checked on the led-colours example (red, yellow, green).

### I.4 Component audit (all components exposed in the palette)

| Component | Standard | This pass |
|---|---|---|
| ESP32-DevKitC V4 | WOW | – |
| Resistor | WOW | – |
| 1N4148 diode | WOW | – |
| LED (5 mm / 3 mm) | WOW (GPU check pending) | epoxy retuned |
| Push button, toggle switch | WOW | – |
| Bench supply, ground post | acceptable+ (symbolic scale) | – |
| Jumper wires / Dupont housings | WOW at the ESP32 | drape |
| RGB LED | was below | water-clear epoxy (full tier) → acceptable |
| Buzzer | was below (plain cylinder) | moulded can, real sound-hole recess → acceptable |
| Relay | was below (sharp box) | rounded glossy case → acceptable |
| PIR HC-SR501 | was below (stepped dome) | smooth Fresnel dome, milky translucent → acceptable |
| LED matrix 1088AS | was below (sharp box) | rounded body → acceptable |
| Capacitors | was below (plain cylinders) | electrolytic sleeve with rolled groove and seal; domed disc → acceptable |
| Photoresistor, TO-92 | acceptable | – |

### I.5 Bench

A soft light falloff across the bench (brighter under the lamp, ~10 % darker at the rim) on top of
the existing grain, contact shadows and AO. No dirt, scratches or randomness.

### I.6 Real-GPU validation

This host has only a software rasteriser (SwiftShader): every render in the evidence was made
there — the "full" tier forced for evidence, the "reduced" tier being what software rendering
gets in normal use. **Full-tier quality is not verified on real GPU hardware.** To make the owner's
check precise without telemetry, the build details (bottom-right version → hover/click) now show
**3D graphics: <the browser's WebGL renderer> (full / reduced quality)**, probed locally.

Owner checklist (normal PC, dev-lab, `v0.10-dev · <sha>` bottom right):
1. Version details → *3D graphics* names the GPU and says **full quality**.
2. ESP32 blink → 3D: the PCB reads black with visible traces; silkscreen readable when zoomed;
   header solder joints shiny, not white; the can brushed, not noisy.
3. Shadows soft, under parts, not hiding detail; no flicker while orbiting.
4. LED (unlit): deep red, milky; the frame inside soft. Run: the LED glows from inside, a faint red
   tint on the bench; no white blow-out.
5. 1N4148: amber glass with the internals visible; the band black.
6. Wires: gentle sag on long runs, round bends, jumper housings seated on the pins.
7. Labels printed on the bench; **Labels** button hides/shows them.
8. Orbit/pan/zoom feel immediate; opening 3D takes ~1–2 s at most.
A screenshot of steps 2, 4 (lit) and 7 with the *3D graphics* line visible is enough.

### I.7 Product footer (approved)

`ProductFooter.tsx` in the bottom bar (`<footer aria-label="Product information and build">`):
- EN: `TBI Lab · Developed by Ohad David · © 2026 TBI. All rights reserved. · support@tbi-tech.net`
- HE: `TBI Lab · פותח על ידי אוהד דוד · © 2026 TBI. כל הזכויות שמורות. · support@tbi-tech.net`
- the support address is a `mailto:` link (accessible name "Email support: …", visible focus
  ring); product name, copyright and address are LTR-isolated inside the RTL sentence;
- one muted line at the inline start; the version (`v0.10-dev · <sha>`) stays at the inline end in
  its own style; wraps on narrow windows, adds no horizontal overflow; never covers the workspace.

### I.8 Measurements (software renderer, default `reduced` tier; same procedure as Part H)

| | `eb30708` | this pass |
|---|---|---|
| ESP32 first 3D open | 3.6 s | 2.8 s |
| re-open | 2.5 s | 1.9 s |
| orbit / pan per step | 201 / 175 ms | 172 / 161 ms |
| dense bench first open / orbit per step | 4.1 s / 253 ms | 3.6 s / 243 ms |
| ESP32 draw calls / triangles (reduced) | 45 / 43.8k | 48 / 43.8k |
| shader programs (reduced) | 6 | 5 |
| heap after 7 enter/leave cycles | 10 MB | 10 MB |
| full tier ESP32 overview: draws / tris / materials | 124 / 131k / 43 | 129 / 131k / 43 |
| full tier parts bench: draws / tris | 104 / 140k | 114 / 148k |
| renderer chunk (gzip) | 205.7 kB | 208.0 kB |

The labels moved from 256×96 sprites with a depth-test-off pass to small decals (one program
fewer); the drape adds ~10 draws on wire-heavy scenes (bent tubes no longer merge into straight
runs) and 7–58 ms of CPU shaping per rebuild. Wire tubes stay adaptively sampled (bends only).

Evidence: `docs/sprints/s10-evidence/realism2/` — `compare-*.jpg` (eb30708 | this pass, same
camera, full tier rendered on the software GPU), `after/*.jpg` (all views incl. the component
audit `audit-*`, LED colours unlit/lit, labels off), `footer-*.png`, `stats-*.json`, `perf/`.

Deployed: `publish-frontend.sh 1fc122f`, all checks passed. Regression on `1fc122f`: typecheck,
lint, unit 779, e2e 154 passed / 3 skipped / 0 failed, legacy 4. Live through the gate's origin:
3D checks 7/7, Sprint 10 demo 40/40 (GND routing case), Sprint 9 smoke 48/48 (Build → Run → Stop).
Backends, Caddy and services unchanged (both services active, not restarted).

### I.9 What still reads as artificial

1. Wire routing is still orthogonal in plan (from the 2D route): the drape softens heights and
   bends, not the plan path. Free plan curvature would need clearance proofs in plan too.
2. No breadboard; parts stand on the bench by their leads.
3. Older parts are now "acceptable", not WOW: relay, PIR board, buzzer, matrix, LDR, TO-92 still
   lack the fine detail (pins, markings, PCB parts) of the benchmark set.
4. The lit LED's glow is a halo sprite plus a point light: no true bloom.
5. Full tier unverified on real GPU hardware (I.6).

## Part H — 3D realism pass, version-update banner (2026-10-06, overnight)

Owner direction: routing fix, version display and the first 3D step were accepted; the 3D target
was raised to "a user opens the 3D view and says: these components look almost real", with the
ESP32 DevKitC as the benchmark asset and the resistor, LED, 1N4148, push button, toggle switch and
wires/connectors as the first set to reach that standard. Plus the approved new-version banner.
Unchanged rules: 2D controls placement; physical metadata controls size; 3D is derived, read-only,
never infers connectivity; no camera state in the project.

### H.1 What changed (by area)

| Area | Before (`f81cf97`) | After |
|---|---|---|
| Lighting | hemisphere + key from the camera side (shadows hidden behind the parts), tiny gradient env | `stage.ts`: RoomEnvironment studio reflections (procedural, bundled with three), key light high from the back left (shadows fall towards the viewer), cool front fill, rim; soft PCF shadows 2048²; **GTAO** contact shading; 4× MSAA; Khronos-neutral tone mapping |
| Bench | flat light-grey box + grid | matte bench with fine grain (bump/roughness) fading into a gradient backdrop (no horizon), 0.5 in grid over the circuit only |
| ESP32 | procedural-looking glTF, wrong board length | **hybrid** benchmark asset (H.2) |
| Wires | uniform plastic tubes, sharp 1.2 mm bends, sphere ends | PVC jacket (satin, clearcoat, sheen), 2 mm plan / 3 mm riser bends, jacket runs into the jumper housing, **stripped tinned conductor** at leads and posts, adaptive tube sampling |
| ESP32 jumpers | 2.5 × 6 mm black block | Dupont female housing at its real 2.54 × 2.54 × 14 mm: chamfered wire end, latch window with the crimp showing, pin entry; seated on the solder joint |
| Direct contact | solder sphere + solder link (read as soldered) | **twisted tinned link** with wraps round both leads: a mechanical connection, deliberately not solder. Touching-but-not-connected keeps the red ring and the lead gap |
| LED | uniformly emissive plastic | transmissive epoxy (IOR 1.5; frosted diffused / glass-clear), visible lead frame, light from the **die**, lens glow profile brightest in the dome, halo, and a fixed pool of 4 point lights so a lit LED tints the bench (full tier) |
| 1N4148 | opaque amber cylinder | DO-35 **glass** (transmission, amber attenuation), DUMET slugs and die inside, painted cathode band |
| Push button | box + cylinder | moulded base, stamped steel cover with clamping tabs and boss, chamfered actuator, legs |
| Toggle switch | box + plain cylinder | phenolic base in plated frame, **threaded bushing**, keyed lock washer, chamfered hex nut, tapered chrome lever (persisted position), solder lugs |
| Bench supply | grey box | compact supply (reduced symbolic scale, Part H.6): powder-coated case, vents, rubber feet, dark front panel with legend, recessed LCD windows (design setpoints), knurled knobs, red/black binding posts |
| Ground | post on a plate | binding post on a plated plate engraved with ⏚ and GND; lug to the terminal (an abstract reference, not an earth rod) |
| Materials | ad-hoc colours, metals at metalness 0.55–0.6 | one PBR library (`models.ts createMaterials`): metals are metals (tin, nickel/chrome, stainless, gold), plastics by finish, powder coat, rubber |
| Camera | ~45° default | 3/4 inspection angle ~30° above the bench; FOV 35° |

### H.2 ESP32-DevKitC V4 — the benchmark asset

- **Dimension correction:** the board was 50.85 mm long (the 1.30/1.29 edge margins were added to
  48.26 a second time). Espressif's drawing gives **48.26 mm edge to edge**, pin 1 1.30 mm from the
  antenna edge. Fixed in `physical.ts`; footprint and bounds follow. Terminal positions unchanged.
- **Layout from the real board:** part positions measured on the board photograph in Espressif's
  user guide, scaled by the header pitch (14.65 px/mm), in one table (`assets/esp32Layout.ts`) used
  by both the geometry and the surface texture: EN/BOOT SMD switches, micro-USB B, CP2102N QFN-28,
  SOT-223 regulator, two SOT-23 auto-reset transistors, 24 chip passives / ESD diodes / power LED,
  ENIG test pads, module outline.
- **Geometry** (`esp32DevkitC.author.ts` → GLB, deterministic): 1.6 mm PCB with rounded corners and
  edge break, FR-4 edge; header pins with chamfered tips, **solder cones** on top, segmented PBT
  bodies; module substrate with castellations (plated edges + board fillets); RF can with stamped
  top panel; micro-USB shell with the B profile, latch windows, cavity, tongue with 5 gold contacts
  and SMD tails; tact switches (base, cover, skirts, gull-wing terminals, actuator); QFN with
  terminations; SOT-223 / SOT-23 with gull-wing leads; chip parts with terminations and fillets.
- **Surface** (runtime, `esp32Textures.ts`, drawn once per page): black mask over **copper pour and
  traces with clearance gaps** (as on a real board), tented vias, tinned SMD and pin pads, and the
  silkscreen **as printed** — short labels (34, 35, GND, CLK…) along the header, reading from the
  board edge, part outlines, EN / Boot — plotted with an original **stroke font** (`strokeFont.ts`;
  the vector-font look of real silkscreen, identical on every computer). The same drawing as a
  height map gives the relief (full tier). Underside: traces, vias, `ESP32-DevKitC V4`, J2/J3.
- **Markings atlas** (one texture): the can's etched marking (ESPRESSIF, ESP32-WROOM-32, FCC/IC
  ids, data-matrix pattern), CP2102N, regulator and SOT-23 top marks as on the photographed board.
  Text only; no logo artwork is reproduced.
- The silkscreen is part of the board's surface material (no floating text plane).

### H.3 Asset pipeline and licensing gate

`manifest.ts` is now the **visual descriptor table for every model key**: `procedural` / `gltf` /
`hybrid`, authoring source, anchors, materials, LOD, the live hooks the renderer may drive from
solved results (`ledGlow`, `rgbGlow`, `matrixDots`), provenance and licence; plus the non-component
visuals (wire, Dupont housing, contact, stage). **No third-party asset ships**: everything is
original code or a glTF authored from code here. A third-party asset can only be added with
source/author/licence/modification/attribution filled in — the test refuses it otherwise.

Reference material used while modelling (not shipped, not in the repository):
- Espressif, ESP32-DevKitC V4 dimension drawing (`esp32_devkitc_v4_dimensions`), and user guide
  "functional overview" photograph:
  <https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html>
  (fetched 2026-10-06; measured, never traced or embedded).
- Espressif ESP32-WROOM-32 datasheet (module outline 18 × 25.5 × 3.1 mm).
- Vishay 1N4148 (doc. 81857, DO-35), TLHR540x (83012), TLHG4900 (83009); Yageo CFR-25.
- JEDEC/EIA package outlines (QFN-28 5×5, SOT-223, SOT-23, SOD-523, 0402/0603/0805).

### H.4 Quality tiers (automatic, capability-based)

`chooseQuality(rendererString, override)`: a software rasteriser (SwiftShader, llvmpipe, softpipe,
"basic render") → **reduced**; any real GPU → **full**; `localStorage tbi-lab.3d.quality` overrides
(evidence/troubleshooting). Never by browser brand. Both tiers build **identical geometry** (tested).

| | full (GPU) | reduced (software) |
|---|---|---|
| Pixel ratio | ≤ 2 | 1 |
| Antialiasing | 4× MSAA (composer) | none |
| Shadows | soft PCF 2048² (rendered on rebuild only) | none |
| AO | GTAO, 5 mm radius (transparent parts excluded) | none |
| Environment | RoomEnvironment PMREM | none |
| Materials | physical: clearcoat, sheen, **transmission** (LED, glass) | standard; metals damped; translucent stand-ins |
| Board textures | ~36 px/mm + bump maps | ~18 px/mm, no bump |
| Bench | fading, grain, gradient backdrop | opaque, plain clear colour |
| LED light pool | 4 point lights | none |

### H.5 New-version banner (approved item)

`updateCheck.ts` + `UpdateBanner.tsx`: the compiled-in commit is compared with `/version.json`
(no-store) on window focus, when the tab becomes visible, and every 5 min while visible. A
different commit shows **"A new version is available" / "גרסה חדשה זמינה"**, the served
`v0.10-dev · <sha>` (LTR), **Reload** and **Later**. Never reloads by itself. Reload is held back
(with the reason) while a simulation/ESP32 session runs, a firmware build is in progress, or changes
are unsaved; it flushes the autosave before reloading. Later hides it for that build (per tab).
Failed/malformed responses are ignored. `stop()` removes the listeners and the timer.

### H.6 Scale notes

World 1 unit = 1 mm; one 2D grid step (20 units) = 3.175 mm (unchanged). Real dimensions
everywhere except two documented exceptions: the **bench supply** (reduced, symbolic scale: a real
~300 mm unit cannot stand in a breadboard-scale circuit) and the **ground** element (an abstract
reference point drawn as a binding post). The Dupont housing moved from a 6 mm stand-in to its real
14 mm, so wires leaving ESP32 pins now start 25 mm above the bench, as real jumper wires do.

### H.7 Measurements

Bundle (production build): `renderer` chunk 714.4 kB → 786.7 kB (gzip 184.8 → 205.7 kB);
`ThreeView` 21.6 → 21.8 kB; ESP32 GLB 483,268 → 721,168 bytes (≈ 23k vertices; budget 800 kB);
no new runtime dependency (GTAO, RoomEnvironment, EffectComposer are three.js examples).

Scene counters (`data-*` attributes; esp32-blink example). Full tier now counts **every pass** of
the frame (shadow is cached; AO normal pass, transmission, beauty, output); before, only the
beauty pass. The like-for-like single-pass figure is the reduced tier:

| esp32-blink | before (beauty pass) | after, reduced (single pass) | after, full (all passes) |
|---|---|---|---|
| draw calls | 40 | 45 | 124 |
| triangles | 34.3k | 43.8k | 131k |
| materials | 39 | 43 | 43 |
| shader programs | – | 6 | – |
| GPU memory estimate | 7.6 MB | 10.4 MB | 37.3 MB (board textures + bump at 36 px/mm) |

Timings on this host's **software** renderer (SwiftShader, 1 CPU), the default tier (`reduced`),
same procedure for both builds (`scripts/evidence/perf-3d.spec.ts`):

| | before | after |
|---|---|---|
| ESP32 first 3D open | 3.2 s | 3.6 s |
| re-open | 2.2 s | 2.5 s |
| orbit drag, per step | 175 ms | 201 ms |
| pan drag, per step | 147 ms | 175 ms |
| fit / reset (one frame each) | 372 / 44 ms | 39 / 352 ms (one software frame each; order-dependent noise) |
| dense bench (ESP32, 10 R, 10 LED, 6 D, 4 SW, 30 wires) first open | 3.3 s | 4.1 s |
| dense orbit, per step | 210 ms | 253 ms |
| JS heap after 7 enter/leave cycles | 10 MB | 10 MB |
| 3D canvases after leaving | 0 | 0 |

The first version of the pass cost the software tier much more (first open 6.0 s, re-open 6.1 s,
dense orbit 436 ms); recovered by sampling wire tubes only in bends, dropping bump maps and the
fading bench/backdrop in the reduced tier, keeping drawn textures for the page, and removing
shader variants from the reduced tier (9 → 6 programs: each is compiled again for every new WebGL
context on a software rasteriser). The two 20-cycle enter/leave e2e tests now need ~3 s per opening
(60 s → 150 s test limit); resources stay flat.
**Full tier forced on the software renderer is not usable** (a dense open took 57 s; the 7-cycle
ESP32 run exceeded 10 min): GTAO, MSAA and transmission are GPU work. That is why tier selection is
automatic. **No hardware-GPU measurement was possible on this host**; the full tier must be
checked on the owner's machine (expected cost on any integrated GPU: a few ms per frame; renders
are on demand, nothing runs while idle).

Deployed: `deploy/dev-lab/publish-frontend.sh eb30708` → all checks passed, "dev-lab now serves
eb307088…"; live through the gate's origin: realism checks 7/7, Sprint 10 demo checks 40/40 (GND
routing case included), Sprint 9 smoke 48/48 (ESP32 Build → Run → Stop, 3D LED lit while running).
Backends, Caddy and services unchanged. Regression on `eb30708`: typecheck, lint, unit 771, e2e
151 passed / 3 skipped / 0 failed, legacy 4.

Evidence: `docs/sprints/s10-evidence/realism/` — `compare-*.jpg` (before | after, same camera),
`after/*.jpg` (full tier), `reduced/*.jpg` (software tier), `stats-*.json`.

### H.8 Tests added

- `app/tests/scene3d-realism.test.ts`: descriptors for every model key; licence gate; DevKitC
  dimensions (drawing and authored asset: PCB 27.94 × 48.26 × 1.6, module 18 mm wide, 6.04 mm
  overhang, pin rows); stroke font covers every printed marking; silkscreen names; wire end kinds;
  scene determinism; tier choice by renderer string and override; pixel-ratio clamp.
- `app/tests/scene3d-anchors.test.ts`: Dupont housing top = ESP32 anchor (body only); both tiers
  build identical geometry.
- `app/tests/update-check.test.ts`: mismatch reported, same commit / bad responses silent, hidden
  tab not polled, `stop()` leaves no listener or timer.
- `app/e2e/version.spec.ts`: banner EN/HE, LTR version, never auto-reloads, Reload held during a
  running simulation, Later, Reload works; no banner when the served build is the running one.
- Existing: 20 enter/leave cycles keep resources flat (s10.spec), anchors, connectivity semantics.

### H.9 Acceptance questions (honest answers)

*Would a student recognise each benchmark part without its label?*
ESP32 DevKitC — yes (layout, silkscreen, module, USB, buttons match the real board). Resistor — yes.
1N4148 — yes (amber glass, band). Push button — yes. Toggle switch — yes. LED — yes, but the
diffused epoxy still reads slightly glassy/plasticky up close. Jumper wires — yes at the ESP32
(housings); elsewhere they are clean tubes.

*Does the scene look closer to a photographed electronics setup than to a simulator illustration?*
At close range (ESP32, resistor, diode, switches, contacts): yes. At the default overview: much
closer than before, but the floating reference labels (R1, D1…), perfectly orthogonal wire runs
at constant height, and the spotless bench still say "simulator". Those are the next steps (H.10).

### H.10 What still gives an artificial look

1. Reference labels floating over parts (needed for teaching; a subtler style or a toggle is a
   product decision).
2. Wire routing: orthogonal runs at exact heights (from the 2D route); real jumpers sag and curve.
   A natural-drape presentation must keep clearance guarantees: a design task, not a polish.
3. No breadboard: real setups put parts in a breadboard; ours stand on the bench.
4. Too clean: no dust, fingerprints, scuffs, solder flux, wire-jacket printing.
5. LED epoxy: no internal refraction of the frame, no bloom beyond the halo sprite.
6. Remaining older models (relay, PIR, matrix, buzzer, LDR, capacitors, TO-92, RGB LED) are at the
   previous standard.
7. Full tier verified only by renders on a software GPU; needs an owner check on real hardware.


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
