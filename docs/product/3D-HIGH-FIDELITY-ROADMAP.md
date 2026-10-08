# 3D view: high-fidelity, model-driven visualization (roadmap)

**Status (2026-10-08, Sprint 10 closure):** approved product direction (owner, 2026-10-06); the
derived 3D bench view is part of V1 (PM-10, `V1-PRODUCT-SCOPE.md` §4.4). **Sprint 10 delivered and
the owner accepted** (2026-10-08) the visual standard: the proof set (ESP32-DevKitC, axial
resistor, 5 mm LED) and every other catalog part's model, physical wires (routing, drape, jumper
exits), the Realistic / Engineering modes, selection and operating the toggle switch and push
button during Run (SPRINT-10.md Parts F–U). **3D does not edit topology or layout**; full 3D editing
is deferred. The physical-behavior items (section 7 onward) remain direction and architecture only;
none is implemented. Further realism work is stopped (owner, 2026-10-08).

*Original status (2026-10-06): first proof set implemented; every other part kept its model until
the owner approved the visual standard.*

## 1. Product statement

**TBI Lab's 3D view is intended to become a high-fidelity, model-driven visualization of both
circuit construction and predicted physical behavior. Visual effects must follow the simulator's
electrical/device models and must never imply unsupported physics.**

The user should feel that they built a real circuit and are watching the predicted physical
result. Three.js remains the rendering layer. The simulation and domain model remain the source of
truth.

## 2. Architecture (kept as is, extended)

```
Circuit model (domain)  ->  3D scene description (scene.ts)  ->  component visual asset/model  ->  three.js renderer
                             placement, anchors, nodes,          assets/: glTF or procedural      lighting, camera,
                             contacts, wire routes               geometry + materials             draw, live state
```

- **Product logic never lives in an asset or renderer node.** A glTF node or a builder draws what
  the scene description gives it. It never decides connectivity, values or state.
- **Dimensional rule (approved):** *2D determines placement. The component model determines its
  real-world physical dimensions.* The 2D layout maps each part's centre and rotation into world
  coordinates (1 grid step = 3.175 mm). The asset carries real dimensions. Nothing is placed twice
  by the user.
- **Anchors:** every 3D part exposes explicit electrical anchor points: lead ends, LED legs, header
  pins, binding posts. Wires terminate at them, never at a bounding-box edge.
  - In the proof set, the LED's anchors moved from the 2D terminal spacing to its real legs
    (2.54 mm pitch).
  - Wires approach them under the flange, as for the relay's and the ESP32's real pins.
- **Consistency invariant:** if the domain says two terminals are disconnected, the 3D view
  visibly shows separation. If it says they are connected, the wire or direct-contact geometry
  visibly ends at the actual anchors. Tested on the built geometry (`app/tests/scene3d-anchors.test.ts`):
  - connected resistor -> LED;
  - disconnected but touching in 2D;
  - direct contact;
  - ESP32 pin wiring.

## 3. Asset pipeline

- **Formats:**
  - **glTF/GLB** for complex parts (proof: `esp32-devkitc-v4.glb`).
  - **Procedural** geometry where it reaches the required realism cleanly (proof: resistor, LED,
    which are bodies of revolution).
- **Authoring:**
  - A glTF asset is produced by deterministic authoring code (`assets/*.author.ts`, pure three.js,
    no DOM), exported by `scripts/build-3d-assets.ts`.
  - The committed file must equal a fresh build byte for byte (`app/tests/assets3d.test.ts`).
  - An externally sourced model (vendor CAD, KiCad 3D library, artist model) can replace an
    authored one later. The manifest then records its source and licence.
- **Delivery:**
  - Local, bundled, fingerprinted files (Vite). No CDN, no runtime external dependency.
  - **Lazy:** nothing loads at app start-up. The 3D view fetches and parses the assets when it
    first opens, once per page (`assets/library.ts`). Clones share the parsed geometry and
    materials.
  - A failed asset falls back to the procedural model; the view never breaks.
- **Manifest** (`assets/manifest.ts`), per model: source (glTF or procedural), authoring code,
  real envelope, orientation convention, anchors, material strategy, level of detail, provenance,
  licence.

## 4. Proof set (implemented)

| Model | Source | Real dimensions | Anchors | Notes |
|---|---|---|---|---|
| ESP32-DevKitC V4 | glTF, 483 KB raw, 98 KB gzip; 17k vertices, 15k triangles | 27.94 x 50.85 mm PCB [ESP-DIM]; WROOM-32 18 x 25.5 mm [WROOM] | header pin tops; a wired pin's jumper-housing top | See below |
| Axial resistor (1/4 W) | procedural | body 6.3 x 2.45 mm, lead 0.55 mm [CFR25] | lead ends (12.7 mm spacing) | See below |
| 5 mm / 3 mm LED | procedural | Vishay package drawings [V83012]/[V83009] | real leg tips, 2.54 mm pitch | See below |

**ESP32-DevKitC V4:**
- rounded PCB with FR-4 edge;
- soldermask with clearcoat;
- ENIG pads and solder fillets on all 38 pins;
- square gold pins with chamfered tips;
- segmented PBT header housings;
- WROOM-32 module with castellated pads;
- stamped RF can;
- printed meander antenna;
- micro-USB B shell with an open mouth and tongue;
- EN/BOOT tactile switches;
- QFN USB bridge and SOT-223 regulator with gull-wing leads;
- 0603 passives with terminations;
- 0805 power LED;
- silkscreen and can marking drawn at runtime.

**Axial resistor (1/4 W):**
- lacquer-dipped "dog-bone" profile: rounded end caps, a narrower waist, and the dip meniscus
  running down each lead as a tapered neck;
- bands **painted on the lacquer** (a texture following the body curvature) with soft edges;
- beige carbon-film (4 bands) or blue metal-film (5 bands) body;
- formed leads with a real bend radius.

**5 mm / 3 mm LED:**
- drafted lens with a hemispherical dome;
- flange with the cathode flat;
- clearcoat epoxy skin over a tinted-diffused or water-clear body;
- visible lead frame: anode post, cathode anvil with reflector cup and die, bond wire;
- 0.5 mm square legs at the real 2.54 mm pitch.

**Camera:** standard views Top / Front / Side / Rear (EN/HE), plus the existing orbit, zoom, pan,
Fit and Reset.

**Lighting and materials:**
- Hemisphere fill, a shadow-casting key light, fill and rim lights.
- PBR materials (physical: clearcoat lacquers, metals).
- On real GPUs (`full` quality), a small procedural studio environment (16 px gradient cube,
  prefiltered) gives metals and lacquers something to reflect.
- On software rasterisers (`reduced` quality) the same scene renders without the environment and
  with standard materials. Measured on this host: the environment alone costs seconds per opening
  there.

## 5. Model roadmap (each a separate approval after the proof set)

Record for every model: target real-world dimensions, orientation convention, pin/lead anchor
coordinates, material strategy, level of detail, source/provenance/licence.

| Tier | Model | Target dimensions (source) | Anchors | Material / LOD notes |
|---|---|---|---|---|
| 1 | ESP32-DevKitC | **done** | header pins | — |
| 1 | Axial resistor | **done** | lead ends | — |
| 1 | 5 mm LED | **done** | legs | — |
| 1 | Diode 1N4148 (DO-35) | 3.4 x 1.75 mm glass, 0.5 mm leads [V81857] | lead ends | transparent glass, visible slug and studs, cathode band |
| 1 | Push button (6 x 6 tactile) | 6.0 x 6.0 x 3.5 mm + actuator [REP] | 4 legs (2 per terminal) | stamped frame, plastic body, actuator travel (behavior, section 7) |
| 1 | Toggle switch (sub-miniature SPST) | 8 x 6 x 6 mm, bushing Ø5 [REP] | solder lugs | lever pose from the persisted state |
| 1 | Capacitor (disc / radial can) | by value (physical.ts table) [REP] | leads | sleeve print, vent cross-scores on cans |
| 1 | 2N3904 (TO-92) | Case 29-11 [TO92] | E-B-C legs | flat face marking |
| 2 | Relay SRD-05VDC | 19.1 x 15.5 x 15.3 mm [SRD] | 5 pins (bottom) | translucent case optional; armature visible |
| 2 | RGB LED (common cathode) | [KB-RGB] | 4 legs at 1.27 mm | water-clear lens, 3 dies |
| 2 | LDR GL5528 | Ø5.1 x 2.1 mm [SENBA] | 2 leads at 3.0 mm | serpentine CdS track texture |
| 2 | Buzzer CEM-1205 | Ø12.0 x 9.5 mm [CEM] | 2 pins at 7.6 mm | sound hole, label |
| 2 | PIR HC-SR501 | 32 x 24 mm, Fresnel dome Ø23 [HC-SR501] | 3-pin header | faceted Fresnel dome |
| 2 | LED matrix 1088AS | 32 x 32 x 8 mm [VMP502] | 16 pins | dot array, diffuser |
| 2 | Bench supply and ground | symbolic scale (a real supply cannot stand on the grid) | binding posts | — |
| 3 | Servo SG90, I2C LCD 16x2, HC-SR04, DHT22, 555 (DIP-8), more boards | when their runtime or model phases are approved | — | — |

## 6. Wires (plan)

- Already: cylindrical insulated conductors (22 AWG class), rounded bends, levels so no wire
  touches what it does not connect, ends at anchors.
- Next:
  - smoother bend radii on long runs;
  - visible insulation end and conductor at the anchor;
  - sensible elevation over parts;
  - a test that no wire penetrates a part body (extends the existing wire-height invariant).
- Never: wire geometry implying a connection the domain does not have.

## 7. Physical behavior: model-driven animation (direction)

**Core rule: never animate an electrical or mechanical result merely for visual effect.** Every
animation or state derives from simulated electrical state, a device model state, runtime events,
or an explicit predicted-failure condition. The renderer consumes state; it never invents
physics.

```
Circuit + Runtime + Simulation  ->  device physical state  ->  3D animation / visual state
```

Examples (each only when its model or runtime exists):
- **LED:** brightness from the simulated current where available (analog, not a binary glow); an
  RGB LED mixes its colour from the channel currents.
- **Switches and buttons:** the tactile actuator depresses and releases; the toggle lever moves.
  The pose always agrees with the circuit input state.
- **Relay:** the armature and contacts move with the coil and device state. The contacts shown
  must match the electrical topology selected by the model.
- **Servo** (when PWM support exists): the arm turns to the predicted angle at a realistic slew
  rate. Command and visible angle stay synchronized; Stop/reset returns to the modelled state.
- **LCD / LED matrix** (when runtime support exists): the actual display content, never
  placeholder text.

### Generic device visual-state interface (proposal)

```ts
interface DeviceVisualState {
  electrical?: { currents?: Record<string, number>; voltages?: Record<string, number> };
  mechanical?: { pose: Record<string, number> };          // e.g. lever angle, armature travel
  thermal?: { stress: number };                           // 0..1 from a thermal/stress model
  failure?: { stage: 'none' | 'warning' | 'stress' | 'predicted' | 'failed'; mode?: string };
  animation?: { targets: Record<string, number>; rate?: Record<string, number> };
}
```

- Each component adapter (pure, outside three.js) maps the simulation outcome and device-model
  state to this.
- The renderer interpolates towards the targets.
- No component-specific knowledge is scattered through the scene.

### Animation layer (plan)

- target-state interpolation;
- deterministic reset;
- pause/stop;
- simulation-time synchronization;
- a reduced-motion fallback (`prefers-reduced-motion`: jump to target).
- **No perpetual loops**: render continuously only while an animation is active, the camera is
  moving or visual state is changing. A static scene stops rendering, as today.

## 8. Predicted failure visualization (direction)

**A failure event comes from a defined device/failure model, never from a UI warning.**

For every failure-capable component, define separately:
- safe operating region;
- warning region;
- failure threshold/model;
- post-failure electrical behavior;
- 3D visual state.

Rules:
- **Not all failures are instantaneous.** Where physically appropriate, use accumulated
  quantities: thermal energy, power over time, over-voltage duration, charge/energy, a junction
  temperature proxy. No arbitrary timers to trigger an animation.
- **A visual failure is never cosmetic.** If the model says the part failed, the electrical model
  transitions to the model-specific failed state (open, short, degraded value, stuck mechanism)
  where that is supported. Where the post-failure state cannot be modelled honestly yet, show a
  warning or predicted-failure indication without pretending the circuit changed.
- **Visual stages:** warning/heating -> visible stress -> predicted failure -> failed-state
  representation. For a severely over-stressed capacitor this might be bulging, venting and a
  brief smoke effect, then a failed part. Professional and educational, not game-like.
- **Accuracy language:** effects are described as *simulated*, *predicted*, *model-based*. The
  product never claims that a real part will fail in exactly the same way or at exactly the same
  moment. Tolerances, manufacturer variation, temperature, ESR and construction differ.

## 9. Proof-of-concept order (after the proof-set visual standard is approved)

1. LED analog brightness.
2. Button and toggle mechanical movement.
3. Relay armature movement.
4. Servo arm movement, once PWM support exists (runtime R4).
5. Capacitor charge visual indication.
6. One carefully modelled predicted-failure example. The candidate is chosen only after its
   electrical/thermal failure model is defined.

## 10. Performance guardrails

Measured for each proof:
- model load time;
- GPU memory (estimate);
- first 3D open and repeated enter/leave;
- frame time;
- lower-end (software-rasterised) behavior.

Practices:
- lazy loading (no 3D asset at start-up);
- geometry and material reuse (clones share);
- static batching per material;
- merged repeated features;
- instancing where meshes stay separate;
- LOD when a model's detail costs more than its on-screen size justifies;
- texture compression when textures grow (today all textures are small runtime canvases).

The Sprint 10 measurements are in the Sprint 10 record (Part F).
