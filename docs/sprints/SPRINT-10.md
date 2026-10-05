# Sprint 10 — Physical 3D, engine time-domain core, approved catalog growth

**Status (2026-10-06, overnight):** developed on `sprint-10` (worktree `~/projects/tbi-lab-s10`),
from `7f09d74` = `main` = `sprint-9-complete`. Ready for the owner's morning review on the
isolated preview `https://dev-lab.tbi-tech.net/s10-preview/`.

Not done: no PR, merge, tag or production deployment. The normal demo (`/`) still serves
Sprint 9 (`198ca92`), and the backends are unchanged (`c31d62e`).

Architecture and scope: [SPRINT-10-ARCHITECTURE.md](SPRINT-10-ARCHITECTURE.md).

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
