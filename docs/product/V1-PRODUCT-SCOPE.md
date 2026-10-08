# TBI Lab — V1 Product Scope

**Status:** **Approved in direction** by the PM. PM decisions PM-1..PM-8 are recorded as decided
(§21). · **Date:** 2026-09-22 · **Phase:** Product scope closure (after Sprint 1) ·
**Revised:** 2026-10-06, PM-6 catalog revision (§6.0, Sprint 10) · 2026-10-08, PM-9 limited
transient simulation, PM-10 the three views (Circuit / Schematic / 3D), PM-11 ESP32 I2C planned for
V1 (§4.4, §6.0a, §21; Sprint 10 closure)

**Release model:** V1 is a **controlled pilot**, not public general availability (§25).

**Baseline evidence.** Sprint 0 (`docs/sprints/SPRINT-0.md`, `SPRINT-0-SUMMARY.md`,
`SPRINT-0-ERRATA.md`) proved feasibility. Sprint 1 (`docs/architecture/V1-ARCHITECTURE.md`,
ADR-001..008, tag `sprint-1-complete`) defined the architecture and proved the deterministic
ESP32 <-> electrical execution contract. **This document defines what a user can and cannot do in
V1.** It is a product document: it does not redesign the architecture and does not reopen
feasibility.

**Rule used throughout.** A capability is in V1 only if (a) the physics or runtime behind it is
already proven, or (b) the work to prove it is named, bounded and accepted here. Anything else is
deferred explicitly. Nothing in this document promises behaviour the engine cannot produce —
CLAUDE.md, "Physics Must Be Real".

### Where each required deliverable lives

| Required item | Section |
|---|---|
| 1. Product goal | §1 |
| 2. Target users | §2 |
| 3. Core V1 user journey | §3 |
| 4. Exact included capabilities (incl. editing surface) | §4 |
| 5. Exact excluded capabilities | §5, §18 |
| 6. Component catalog | §6 |
| 7. ESP32 capability scope | §7 |
| 8. Firmware / code workflow | §8 |
| 9. Instruments | §9 |
| 10. Project / file behaviour | §10.3 |
| 11. Offline / online behaviour | §11 |
| 12. Localization | §12 |
| 13. Supported platforms | §13 |
| 14. Examples / templates / first run | §14 |
| 15. Error and feedback behaviour | §15 |
| 16. Product acceptance journey | §19 |
| 17. V1 / V1.1 / Future matrix | §20 |
| 18. PM decisions | §21 |
| 19. Risks | §22 |
| 20. Definition of Done | §23 |
| (added) Simulation controls | §10.1-§10.2 |
| (added) Visual quality and accessibility | §16 |
| (added) Performance expectations | §17 |
| (added) Conflicts found against Sprint 0/1 | §24 |
| (added) Export package contents and import rules | §10.4 |
| (added) Identity boundary — what needs an account | §11.2 |
| (added) Release model and pilot terminology | §25 |

---

## 1. Product goal

TBI Lab V1 is a **desktop-browser electronics laboratory** in which a user builds a DC circuit,
powers it from a laboratory power supply, runs it, and sees real, physically derived voltages and
currents — and can put a **classic ESP32 DevKit** into that circuit and run real ESP32 firmware
against it.

V1 must already feel like the beginning of a serious instrument, not a toy:

- every number shown comes from the solver or the emulated chip, never from an animation;
- unsupported behaviour is stated, not faked;
- the workspace is clean enough to project in a classroom;
- Hebrew and English are equally first-class, and neither changes the engineering data.

V1 is deliberately narrow: **DC, one MCU, a small catalog, one code workflow.**

### What makes V1 credible rather than a demo

| Property | Why it matters | Evidence |
|---|---|---|
| The solver refuses to return a wrong answer | Verified against exact equations; non-convergence is reported, not smoothed | Gate A: solutions failing verification are rejected |
| Real device physics | LED from a datasheet-fitted Shockley model; PSU current limit chosen by the solution itself | Gate A cases 5-7 |
| The ESP32 pin is real hardware | Driven-high pin into an LED measures **3.205 V**, not 3.3 V, from the datasheet driver resistance | Gate C case 1 |
| Reproducible MCU runs | Same inputs give the same observable timeline, to the timestamp | Sprint 1 release gate R-MCU-1 |
| Work is never lost to a server problem | The browser owns the project; simulation sessions are ephemeral | ADR-001, invariants 1-2 |

---

## 2. Target users

| User | What they need from V1 | Implication for scope |
|---|---|---|
| **Electronics student (beginner-intermediate)** | Build a small circuit, see V and I, understand why the LED current is what it is, try firmware | Low-friction editing, readable results, worked examples |
| **Instructor / lecturer** | Show a circuit live, change one value and show the effect, project it | Legible at projector scale, fast edit-run loop, example projects that open instantly |
| **Maker** | Try a DevKit wiring idea before building it | Real ESP32 pin behaviour and real firmware, DIO/flash realities surfaced |
| **Engineer demonstrating a circuit** | Trustworthy numbers and stated limits | Explicit model limits, no invented behaviour |

**Not targeted in V1:** PCB designers, analog/RF designers, professional SPICE users, mobile users,
classroom-management/administrative users.

---

## 3. Core V1 user journey

The smallest complete journey. Everything in §4 exists to serve it.

| # | Step | V1 behaviour | Mode |
|---|---|---|---|
| 1 | Create a project | Named, saved locally at once | Local |
| 2 | Build a circuit | Place components from the V1 catalog on a schematic canvas | Local |
| 3 | Wire | Draw wires terminal-to-terminal; wires joined at a point form one net | Local |
| 4 | Configure values | Resistance, LED model, PSU setpoint and limit, switch state | Local |
| 5 | Connect the lab PSU | PSU is a component instance with + and - terminals | Local |
| 6 | Run | Solve the operating point; results appear | Local (A) |
| 7 | Observe | Net voltages, component currents, PSU V/I and CV/CC, LED state | Local (A) |
| 8 | Add a classic ESP32 DevKit | Board symbol with real pin names | Local |
| 9 | Provide firmware | Write a sketch and build it, or upload a `.bin` (§8, PM-2) | Service |
| 10 | Run firmware against the circuit | Server session runs QEMU + engine together | Service (B) |
| 11 | See the interaction | Firmware drives pins and the circuit responds; circuit drives an input and the firmware reads it; serial output streams | Service (B) |
| 12 | Stop, edit, run again | Structural edits require a controlled stop/restart; value changes apply live | Both |
| 13 | Autosave | Every change is written locally, debounced | Local |
| 14 | Close and reopen | Exact restore, including after a full browser restart | Local |
| 15 | Switch Hebrew <-> English | UI language changes; project bytes do not | Local |

**Journey-level rule:** steps 1-8 and 12-15 never require the network. Only steps 9-11 do.

---

## 4. Exact included capabilities (V1)

### 4.1 Editing surface — the paradigm decision

**Options considered**

| Option | What it is | Strengths | Weaknesses |
|---|---|---|---|
| **Schematic** | Symbols and wires; connections are explicit nets | Matches how the solver thinks (nets/terminals); scales to more components; compact and projector-legible; unambiguous connectivity; the skill transfers to real engineering work | Less recognisable to an absolute beginner who has only seen a breadboard |
| **Breadboard** | Physical board with rows, holes and jumper wires | Instantly recognisable; matches what a maker physically builds; good for "wire it like this" instructions | Connectivity is implicit in geometry (row rules, rails, split gutter) and must be inferred; errors are geometric rather than electrical; visually heavy at projector scale; every new component needs a physical footprint; this is essentially Fritzing's territory |
| **Constrained combination** | Schematic model with an optional breadboard *view* | Best long-term story | Two representations to keep in sync, two sets of interactions, roughly double the editor work for V1 |

**Approved for V1 (PM-1): a professional schematic workspace, with standard, physically suggestive
symbols** — in particular, the ESP32 is drawn as a DevKit-shaped block with its real pin names
(`GPIO2`, `3V3`, `GND`) in their real order, so wiring knowledge transfers to a physical board.

Reasons, in order of weight:

1. **Correctness.** The project schema is already nets-and-terminals. A schematic edit *is* the data
   model; a breadboard adds an inference layer between what the user draws and what is solved, and
   every inference is a place for the product to be subtly wrong.
2. **Effort.** One editor, one interaction language. A breadboard needs footprints, row/rail
   semantics, jumper routing and its own validation before the first circuit runs.
3. **Teaching.** Instructors need something readable on a projector and editable live; schematics
   are denser and clearer at that scale.
4. **Expansion.** Every future component needs only a symbol, not a physical package.
5. **Localization.** A schematic canvas is language-neutral and stays LTR under a Hebrew UI without
   any mirroring question.

**Deferred:** a breadboard *view* over the same net model. Because connectivity lives in the data
rather than in geometry, adding that view later does not invalidate V1 projects — and the net/project
model **must not** be designed in a way that prevents it (PM-1).

### 4.2 Editing interactions required in V1

| Interaction | V1 requirement |
|---|---|
| **Placement** | Choose from the catalog and place on the canvas; new components get a unique reference (`R1`, `R2`, `D1`, `U1`) |
| **Move** | Drag, or arrow keys; wires stay attached |
| **Rotate** | 90° steps; matters for readable layout and for polarity clarity (LED, diode, PSU) |
| **Select** | Click; shift-click and rubber-band for multi-select |
| **Delete** | Removes the component and the wire segments that terminate on it; never silently leaves dangling nets |
| **Wiring** | Click a terminal, draw, click a target terminal or an existing wire. Orthogonal routing by default |
| **Junctions / nets** | Wires meeting at a point form one net; a junction dot is drawn where three or more segments meet; crossings without a junction are **not** connected |
| **Net naming** | Optional user name on a net; user-authored, never translated |
| **Property editing** | Inspector panel for the selected component; values entered with unit-aware input (`220`, `1k`, `4.7k`) |
| **Zoom / pan** | Wheel zoom, drag pan, zoom-to-fit; zoom level is view state, not project data |
| **Grid / snapping** | Visible grid; components and wire endpoints snap to it, so nets line up predictably |
| **Invalid connection feedback** | Immediate and specific: shorting a PSU's own terminals, wiring a reserved or input-only ESP32 pin as an output, connecting two terminals of the same component, or leaving a terminal unconnected before a run |
| **Undo / redo** | **Required.** Multi-step, covering placement, wiring, deletion and property changes |
| **Copy / paste / duplicate of a selection** | Desirable, not required for V1 |

**Not in V1:** buses, hierarchical sheets, multi-sheet projects, rats-nest/auto-routing, alignment
and distribution tools, component libraries beyond the V1 catalog, annotation graphics beyond simple
notes.

### 4.3 Capability summary

| Area | In V1 |
|---|---|
| **Editing** | Schematic canvas; place, move, rotate, select, multi-select, delete; wire; junctions; zoom/pan; grid snapping; undo/redo; property editing; invalid-connection feedback |
| **Views** (PM-10, §4.4) | Circuit (the authoritative editing surface), Schematic (derived), 3D bench (derived physical view) |
| **Simulation (no MCU)** | DC operating point in a browser Worker, re-solved on every relevant change; **limited transient** (PM-9, §6.0a): deterministic fixed-step time-domain simulation of capacitor circuits, local (non-ESP32) circuits only |
| **Simulation (MCU)** | Server session: classic ESP32 + bridge + engine co-located; deterministic closed loop at a 1 ms `hostCommandQuantum` |
| **ESP32** | Digital output, digital input, pin direction, internal pull configuration by the user, UART0 serial output, reset-on-start only (§7) |
| **Firmware** | Arduino C++ single sketch, built by the service, content-addressed; `.bin` upload (§8, pending PM-2) |
| **Instruments** | Lab PSU panel; probe/inspector measurements of node voltage and component current; serial monitor (read-only) |
| **Controls** | Run, Pause, Resume, Stop; explicit session state (booting, connected, paused, disconnected) |
| **Results** | Net voltages, component currents, PSU V/I + CV/CC, LED on/off + current, GPIO pin states, diagnostics |
| **Projects** | New, name, autosave, recent list, open, duplicate, delete, save-state indicator, export/import file (pending PM-7) |
| **Localization** | Full English + Hebrew UI, RTL chrome with LTR technical canvas, language-neutral project data |
| **Examples** | 6 curated example projects (§14) |
| **Platform** | Chromium-family desktop browsers (pending PM-5) |

### 4.4 Views: Circuit, Schematic and 3D (PM-10, 2026-10-08)

One project, three views of it. Only the first edits the circuit:

| View | Role |
|---|---|
| **Circuit** | The **authoritative** construction and topology editing surface (§4.2): placement, layout, wiring, deletion |
| **Schematic** | A **derived** professional electrical representation of the same nets; never a second source of truth |
| **3D** | A **derived** physical representation: the parts at real scale on a bench, wires as physical cables |

**3D supports:** inspection, camera navigation, selection, property access through the shared
Inspector, and the physical operation of approved controls (toggle switch, push button) during Run.
Operating a toggle switch changes its position parameter exactly as the Circuit view does (one
shared, undoable action); 3D can interact with simulation state.

**3D does not support:** topology editing, moving components as an authoritative layout, rewiring,
or an independent saved layout. The 3D placement is derived from the Circuit layout on every view
(a visual-only separation may move bodies apart in 3D; it is never saved). **Full 3D editing is
deferred** (beyond V1). This is a bench visualisation, not 3D PCB design (which stays out of scope,
§18).

This refines PM-1: the Sprint 9 product turned the single schematic workspace into the Circuit
editing view with a derived Schematic view; the net/project model is unchanged and language-neutral.

## 5. Exact excluded capabilities (V1)

Excluded means: **not built, not promised, and stated in the UI where a user might expect it.**

| Excluded | Why — evidence |
|---|---|
| AC analysis; waveform displays over time; transient analysis beyond the limited capacitor stepping of §6.0a | No AC engine. *2026-10-08 (PM-9): limited transient simulation IS in V1 (§6.0a: local circuits, capacitor, deterministic fixed step); general transient analysis and waveform displays are not* |
| Oscilloscope, signal generator, logic analyser | No instrument shows signals over time; the limited transient of §6.0a does not make them honest |
| Inductors | A DC operating point makes an inductor a short; no inductor model exists. *The capacitor, originally excluded here, ships for local circuits since Sprint 10 (§6.0a)* |
| Transistors (BJT/MOSFET) | No model exists; a new nonlinear model plus validation is a sprint of its own. *2026-10-06 (§6.0): one identified transistor with a validated model is approved* |
| ESP32 ADC, DAC, touch | The runtime's `analog` and `rtcio` peripherals are unimplemented (46 and 38 unimplemented accesses observed in one boot) |
| ESP32 PWM/LEDC | Not supported today: not in the emulated peripheral set. *2026-10-08: PWM for the servo is a **V1 planned capability**, runtime Phase R4 (§6.0a); until it ships, firmware PWM has no electrical effect* |
| ESP32 I2C | Not supported today. *2026-10-08 (PM-11): ESP32 I2C with the I2C LCD is a **V1 planned capability**, runtime Phase R3 (§6.0a); until it ships, those pins behave as plain GPIO* |
| ESP32 SPI (user-level), external UART wiring | Not modelled in the electrical engine; no device models to talk to |
| Wi-Fi, Bluetooth | Not modelled; the session has no network by design (invariant 14) |
| Deep/light sleep | The runtime's sleep timer uses the host clock, which breaks determinism |
| `esp_restart()`, watchdog reset, in-place EN/reset button | Still asynchronous in QEMU; PM decision P10 keeps them unsupported until they pass R-MCU-1 |
| GPIO 34-39 as outputs, or with internal pulls | **Hardware**: those pads are input-only and have no internal pulls |
| GPIO 32/33 outputs, until the bridge gap is closed | **Simulator limitation**, not hardware: the bridge events bank-0 outputs only (blocker B6). Pre-release fix (§7.2) |
| Drive-strength, open-drain, firmware-controlled pulls | Not driven from firmware register state (blocker B5) |
| MicroPython authoring | Sprint 0 used it as a test artifact only: "This is not MicroPython support" |
| Arduino library ecosystem / dependency management | Out of scope; V1 builds a single sketch against the core only |
| Cloud sync, accounts beyond service authorization, collaboration, billing, AI | Not designed; ADR-001 keeps the browser authoritative |
| PCB, Gerber, routing, netlist import/export, SPICE files | Out of product scope (CLAUDE.md) |
| Mobile, tablet, native apps | Desktop browser only |

---

## 6. Component catalog

### 6.0 PM-6 revised — the V1 catalog is open to the approved families (2026-10-06, Sprint 10)

**This decision supersedes the closed eight-item catalog of §6.1.** The original PM-6 freeze no
longer represents the approved product direction. §6.1 is kept below unchanged as the record of
the original decision, but its "no component may be added" rule is **no longer authoritative**.

**Still deferred:** the **potentiometer** stays **V1.1 (PM-6)**, with the ADC.

**Approved component families for V1 development:**

| Family | Approved members | Condition for exposure |
|---|---|---|
| Controllers | ESP32 family (current priority) | The architecture stays extensible to Arduino boards later. Board and programming environment remain separate concepts (§8) |
| Switching | Push button, toggle switch, multi-position switch | A multi-position switch only where the model supports it cleanly |
| Lighting | LED colours (datasheet model cards), RGB LED | RGB: genuine separate channels and one declared package (common cathode or common anode); emitted colour derives from the channel currents |
| Basic components | Resistor, diode, transistor, capacitor, photoresistor (LDR), buzzer, relay | Transistor: one clearly identified part and model, with documented limits. Capacitor: **only when the transient model is exposed honestly** (below). Relay: coil side and contact side never electrically merged. Buzzer: electrical model separate from optional sound |
| Sensors | Temperature/humidity, ultrasonic distance, PIR motion; more later through the same sensor abstraction | The simulated environment is a clear user control; device semantics are deterministic; no example-specific hard-coded outputs |
| Matrices | A small LED matrix; larger later | Only if the first abstraction is sound (no per-LED UI state) |
| Power | The existing lab supply | — |
| ICs | Common educational ICs such as the 555 | **Only when the pin-level behaviour is technically credible.** Never a "magic oscillator" block |
| Actuators | Servo | Its position derives from the actual control signal; no slider bypassing the electrical/control signal |
| Displays | Character LCD through **I2C only** | Legacy parallel-wired LCDs are **not** in scope. The I2C path uses a reusable bus/peripheral abstraction, not tied to Arduino APIs, so future MicroPython support can reuse the same device semantics |

This authorises the families. It does **not** require shipping all of them at once: complete
components are preferred over placeholders.

**Rules that still apply to every new component:**

1. **Physics must be real** (CLAUDE.md). Each model is deterministic and traceable to a datasheet or
   manufacturer model, with every assumption documented.
2. **Transient-dependent components** (capacitor, 555 and anything whose behaviour is defined over
   time) are exposed only once time-domain simulation is user-facing, deterministic, bounded and
   integrated with Run/Stop. Until then they stay internal.
3. **MCU-coupled behaviour** must come from the runtime. A component whose function depends on an
   ESP32 facility the runtime does not yet model (PWM/LEDC, I2C, microsecond input timing) may be
   exposed for local circuits only where it is meaningful there. Its ESP32 path stays refused with a
   specific reason until the runtime models that facility.
4. **Definition of done** for an exposed component: catalog, inspector, serialization, terminals,
   2D, schematic, 3D, simulation semantics, English and Hebrew, and tests for each layer, including
   cross-view agreement.
5. **Board and toolchain extensibility is unchanged:** boards and programming environments remain
   separate concepts. Arduino-family boards and MicroPython remain future work (§8.3).

### 6.0a Revised 2026-10-08 (PM, Sprint 10 closure): transient, I2C and the delivery state

**PM-9 — limited transient simulation is part of V1.** Shipped (Sprint 10): deterministic
fixed-step (1 ms, backward Euler) time-domain simulation of **local (non-ESP32) circuits**
containing the **capacitor**, integrated with Run/Stop (each Run starts at t = 0, discharged). The
capacitor is ideal (no leakage, no ESR); non-ideal effects are a later V1 polish item. **ESP32
transient integration is NOT supported:** the ESP32 runtime does not step time, and a capacitor in
an ESP32 project is refused with a specific reason. ESP32 transient integration stays a V1 roadmap
item. Rule 2 of §6.0 is thereby met for the capacitor in local circuits only.

**PM-11 — ESP32 I2C is a V1 planned capability** (no longer generic "future"), because the I2C LCD
remains a V1 target. Implementation is deferred to runtime Phase R3. LCD policy unchanged: **I2C
only**; legacy parallel-wired LCDs are not implemented.

**Delivery state after Sprint 10** (authoritative list: `docs/sprints/SPRINT-10.md`, Part V):

| Item | State |
|---|---|
| RGB LED, LDR, buzzer, relay, NPN transistor (2N3904), capacitor, PIR, 8x8 LED matrix | Shipped for **local circuits**; refused in ESP32 projects until runtime Phase R1 (Sprint 11 primary target) |
| LED colour cards (yellow, green) | Shipped, local and ESP32 |
| Ultrasonic (HC-SR04), temperature/humidity (DHT22) | Engine models only; need runtime Phase R2 (µs input timing): V1 roadmap |
| I2C LCD 16x2 | Engine model only; needs runtime Phase R3 (ESP32 I2C): V1 roadmap |
| Servo | Engine model only; needs runtime Phase R4 (PWM): V1 roadmap |
| 555 timer | Not started; V1 roadmap after an explicit pin-level model approval |
| Multi-position switch; larger LED matrices | Not started / engine abstraction only; V1 roadmap |
| Potentiometer | **V1.1+** (unchanged) |

### 6.1 The V1 catalog is CLOSED *(original PM-6 — superseded by §6.0 on 2026-10-06)*

The eight components below are the complete V1 catalog (PM-6). **No component may be added during
implementation without an explicit scope decision** — this includes transistors, sensors, relays,
555 timers, motors and any other part that seems small at the time.

#### Included in V1

| Component | Type id | User-editable properties | Model status | Live interaction | New engine work |
|---|---|---|---|---|---|
| **Lab DC power supply** | `instrument.lab_psu` | setpoint voltage, current limit, output enable | **Exists** (`LabPsu`, CV/CC active-set) | Yes — live mirror | None |
| **Ground / reference** | `component.ground` | — | **Exists** as the solver's reference net (`role: "ground"`) | No | Net-role handling only |
| **Resistor** | `component.resistor` | resistance | **Exists** (`Resistor`) | Value edit only | None |
| **LED** | `component.led` | model (curated list), optional label | **Exists** (`Diode` + `LED_TLHR5400` card, valid ~1-20 mA) | No | Add 1-2 more colour cards from datasheets |
| **Diode** | `component.diode` | model (curated list) | **Exists** (same `Diode` device) | No | One general-purpose model card (e.g. 1N4148) from a datasheet |
| **Push button (momentary)** | `component.push_button` | — (pressed state is runtime) | **New, trivial**: two-resistance switch | Yes — transient command | Small: a switch device with closed/open resistances chosen to stay well-conditioned |
| **Toggle switch (SPST)** | `component.toggle_switch` | default position | **New, trivial**: same switch device | Yes — live mirror | Shared with the push button |
| **Classic ESP32 DevKit** | `mcu.esp32_classic` | board variant, firmware reference, per-pin pull config | **Exists** (`GpioPin` per pad + runtime) | Yes — firmware drives it | Pin capability metadata for the UI |

**Why each belongs in V1**

- **PSU + ground + resistor + LED** are the minimum for a meaningful first circuit, and all four are
  already proven end-to-end including the current-limit and LED cases.
- **Diode** costs almost nothing: it is the same device model as the LED with a different card, and
  it unlocks polarity/protection teaching.
- **Push button and toggle switch** are what make journey step 11 real: they are the natural way for
  a user to drive an ESP32 **input** and watch the firmware react. Without them, "circuit drives
  firmware" requires editing a PSU setpoint, which is a poor teaching story.
- **ESP32 DevKit** is the V1 MCU by definition (CLAUDE.md MCU rule).

**Switch modelling note (engineering, for transparency).** A switch is modelled as a resistance that
takes one of two documented values (closed ≈ 10 mΩ, open ≈ 100 MΩ, exact values to be fixed with the
solver's conditioning in mind). An ideal open circuit would disconnect a subnet and can make the
matrix singular; the solver already refuses singular systems rather than inventing an answer, so the
open resistance is a **documented model parameter**, not a hidden fudge.

#### Deferred, with the reason

| Component | Decision | Reason |
|---|---|---|
| **Potentiometer** | **V1.1 (PM-6)** | Electrically cheap (a wiper splitting one resistance), but its main teaching use is feeding an **ADC**, which V1 does not support. It belongs with ADC |
| **Capacitor / inductor** | **Deferred until transient can be modelled honestly (PM-6)** *(capacitor: shipped for local circuits, §6.0a)* | In a DC operating point a capacitor is an open circuit and an inductor a short. Showing them without transient analysis teaches something false |
| **Transistor (BJT, MOSFET)** | **Future** | New nonlinear models plus validation against an independent reference; a dedicated sprint |
| **Relay** | **Future** *(superseded: shipped for local circuits, §6.0a)* | Needs a coil/contact model and, realistically, transient behaviour |
| **Sensors (LDR, thermistor, DHT…)** | **Future** | Most are meaningful only with ADC or a digital protocol |
| **555 timer, op-amps, logic ICs** | **Future** | Time-domain or multi-transistor models |
| **Multiple/second MCU** | **Future** | One QEMU per active MCU session is a fixed architectural cost (§12 of the architecture) |
| **Breadboard, jumper wires as objects** | **See PM-1** | Depends on the editing-paradigm decision |

---

## 7. ESP32 capability scope

**The target is the classic/original ESP32 (Xtensa LX6) on a WROOM-32-style DevKit board. No C3/S3/C6
substitution, silent or otherwise** (CLAUDE.md MCU rule; architecture invariant 5).

### 7.1 Pin behaviour comes from a board capability map, not numeric ranges

V1 represents a **real board**, so every pin-related product behaviour — what the editor offers, what
the connection validator refuses, what the inspector shows — derives from **explicit per-pin
metadata** in a board profile (`board.esp32_devkitc_wroom32`), not from hard-coded ranges.

Each pin carries at least:

| Attribute | Meaning |
|---|---|
| `headerLabel` | What is printed on the board (`IO25`, `SVP`, `TX0`, `CLK`) |
| `gpio` | GPIO number, where one exists |
| `exposed` | Present on the DevKit header at all |
| `digitalInput` | **Hardware** capability |
| `digitalOutput` | **Hardware** capability |
| `internalPull` | Whether the chip has an internal pull-up/pull-down on this pad |
| `role` | `general` \| `flash` \| `console_uart` \| `input_only` \| `power` |
| `strapping` | Boot-sensitive pin whose level at reset changes chip behaviour |
| `simulatorSupport` | `supported` \| `limited` \| `unsupported`, **with a reason** |

**Two layers, never conflated.** Hardware capability and simulator support are separate fields. A pin
that the chip can drive but our runtime cannot yet observe is shown as a **simulator limitation**, not
as a hardware property. This is a product rule, not a UI detail: mislabelling our own gap as silicon
behaviour would teach the user something false.

### 7.2 V1 board profile — ESP32-DevKitC (WROOM-32) policy

| Pins | Hardware | V1 policy |
|---|---|---|
| **GPIO 6-11** (`CLK`, `SD0`, `SD1`, `SD2`, `SD3`, `CMD`) | Broken out on the 38-pin header but connected to the module's SPI flash | **Reserved.** Never offered as ordinary user GPIO; wiring them is refused with the reason "used by the module's flash" |
| **GPIO 34, 35, 36 (`SVP`), 39 (`SVN`)** | **Input-only in hardware, and no internal pull-up/pull-down** | Digital input only; the inspector offers **no** pull option and explains why (external pull required) |
| **GPIO 32, 33** | Full digital input **and output**, with internal pulls | Input and output. **Runtime gap:** the Sprint 0/1 bridge events bank-0 outputs only (blocker B6). Either close that gap before release (preferred) or mark these as `simulatorSupport: limited` with the reason. **They are never described as input-only** |
| **GPIO 0, 2, 5, 12, 15** | Normal GPIO, but **strapping / boot-sensitive** | Usable, flagged in the editor: holding one at the wrong level at reset changes boot behaviour. The warning is informational, not a block |
| **GPIO 1 (`TX0`), 3 (`RX0`)** | Normal GPIO, wired to the board's USB-serial console | Usable, flagged: using them conflicts with the serial monitor |
| **GPIO 25, 26** | Normal GPIO; DAC-capable in hardware | Usable as digital I/O. DAC is **not simulated** in V1, and the pin says so |
| **GPIO 4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 27** | Normal GPIO with pulls | Fully usable |
| **GPIO 20, 24, 28-31, 37, 38** | Not available on a WROOM-32 module | Not shown |
| **`3V3`, `GND`, `VIN`, `EN`** | Power and enable pins | `3V3`/`GND` are wirable nodes. `EN` is **not** exposed as a control in V1, because chip reset is unsupported (P10) |

**Runtime artifact to clear before release.** The Sprint 0/1 harness masks GPIO **4, 16 and 27**
because the community QEMU fork wires them inside its machine model to its own demo peripherals (a
display backlight, a display command line and a servo). That is an **artifact of the fork, not of the
DevKit**. The production runtime must not carry those board devices, so these pins become ordinary
user GPIO. Until that is done they are `simulatorSupport: limited`, with that exact reason. This is
tracked with the Espressif-baseline port (P8).

**Sourcing rule.** Every row of the board profile must be verified against the ESP32 datasheet and the
DevKit schematic when the profile is implemented, and the source recorded with it. The table above is
**product policy**; the per-pin data is engineering data with provenance, exactly like the LED and pin
electrical models.

### 7.3 Supported ESP32 capabilities in V1

| Capability | Status | Evidence |
|---|---|---|
| Digital output on output-capable, non-reserved pins | **Supported** | Gate C: GPIO2/18/19 drive and are observed; direct register writes honoured |
| Digital input on input-capable pins | **Supported** | Gate C: GPIO5 (bank 0) and GPIO35 (bank 1) read injected levels |
| Pin direction / high-Z | **Supported** | Direction events reported; a pad losing output-enable stops driving |
| Datasheet-accurate pin electricals | **Supported** | 16.5 Ω / 17.68 Ω driver resistances; V_IH 2.475 V, V_IL 0.825 V; hold inside the undefined band |
| Internal pull-up / pull-down **configured by the user** on pins that have them | **Supported** | 45 kΩ pulls in the pin model |
| Deterministic firmware <-> circuit interaction | **Supported** | Release gate R-MCU-1: 62 full runs + 30 stressed boot runs, zero divergences |
| UART0 console **output** | **Supported** | Serial output is part of the determinism fingerprint |
| Arduino firmware, DIO flash mode, 4 MB image | **Supported** | Arduino core 3.3.12, FQBN `esp32:esp32:esp32`, `--flash-mode dio` |

### 7.4 Unsupported in V1, and what the user sees

| Capability | V1 behaviour |
|---|---|
| ADC, DAC, touch | Pin metadata marks the capability **not simulated**; firmware using it produces no electrical effect |
| PWM / LEDC | Not simulated today; firmware PWM has no electrical effect. PWM for the servo is **V1 planned** (runtime Phase R4, §6.0a) |
| I2C | Not simulated today; those pins behave as plain GPIO. **V1 planned** with the I2C LCD (runtime Phase R3, PM-11) |
| SPI, externally wired UART | No device models exist; those pins behave as plain GPIO |
| Wi-Fi, Bluetooth, deep/light sleep | Unsupported; sessions have no network, and sleep breaks determinism |
| `esp_restart()`, watchdog reset, EN/in-place reset | **Not exposed** (P10). Restart = Stop then Run, which is a fresh deterministic session |
| Serial **input** (host -> firmware) | V1.1. The monitor is read-only in V1 |
| Drive strength, open-drain | Not modelled (blocker B5); not offered in the inspector |

### 7.5 What "supported" means, and the limits of detection

**The V1 guarantee covers only the documented subset above.** Compiling successfully, or loading a
`.bin` successfully, does **not** imply that every ESP32 peripheral behaves like hardware.

| Firmware source | What V1 can honestly do |
|---|---|
| **Built by TBI Lab from user source** | The source is available, so implementation *may* add preflight/static diagnostics for common unsupported APIs (`analogRead`, `ledcWrite`, `Wire`, `SPI`, `WiFi`, `esp_deep_sleep_start`, `esp_restart`) and warn before the run. Scope of that check is a roadmap decision, not a promise here |
| **Uploaded `.bin`** | **No claim of complete detection.** The binary is opaque; V1 must not imply otherwise |
| **Either, at runtime** | Where access to an unsupported emulated peripheral is **reliably detectable**, show a clear diagnostic naming it. Never present fabricated, valid-looking behaviour in its place |

This is the product-level form of the physics rule: TBI Lab states what it simulates, warns where it
reliably can, and never invents a plausible result for something it does not model.

## 8. Firmware / code workflow

### 8.1 The options

| Option | Description | Beginner | Instructor | Infrastructure | Security | Offline |
|---|---|---|---|---|---|---|
| **A. Upload `.bin` only** | User compiles elsewhere and uploads a merged image | Poor: needs a full Arduino toolchain first | Poor for a class | None beyond the session service | Low risk: image is validated, hashed, sandboxed | Upload works offline; running still needs the service |
| **B. Integrated editor + server build** | Single sketch edited in TBI Lab, built server-side by `arduino-cli` | Strong: edit, build, run in one place | Strong | A build service, toolchain image, cache | Compiling untrusted code needs a sandbox and quotas | Editing offline is possible; building is not |
| **C. Both** | B as the main path, A as the advanced/fallback path | Strong | Strong | Same as B | Same as B | Same as B |
| **D. Curated prebuilt sketches only** | Ship example binaries; no user code | Weak: not really "your code" | Weak | None | Lowest | Best |

### 8.2 Approved: **both paths, deliberately narrow** (PM-2)

The approved V1 workflow is:

> **single Arduino sketch -> Build -> firmware artifact -> Run**

with `.bin` upload retained as the advanced path. **This is not an Arduino IDE replacement.**

- **Primary path:** a plain, single-file Arduino C++ editor (`setup()` / `loop()`), built by the
  service with the pinned core `esp32:esp32@3.3.12`, FQBN `esp32:esp32:esp32`, `--flash-mode dio`,
  4 MB. Build output is a merged flash image, content-addressed exactly as the architecture already
  defines (`fw_sha256_…`), stored in the browser next to the project.
- **Secondary path:** upload a `.bin`, with the existing validation (target, magic, size, flash
  mode; QIO rejected with `unsupported_flash_mode`, never converted — P7).
- **Reproducibility.** The Arduino-ESP32 core, toolchain and build flags are **pinned** and recorded
  with the artifact, so the same source produces the same firmware. The pinned identity is part of
  the build metadata and travels with an exported project (§10.3).
- **Explicitly not in V1 (PM-2):** a third-party Library Manager, arbitrary board packages, multi-file
  IDE/project systems, general Arduino-ecosystem support, a serial-upload/flash workflow, debugging,
  or anything resembling an IDE clone.

**Why C rather than A.** Option A makes the product's headline capability unreachable for exactly
the audience it targets: a student who must first install an Arduino toolchain will not get to step
10 of the journey. The ESP32 feature already requires a server, so the build service is an
**incremental** addition to an existing server boundary, not a new one.

**Why C rather than B alone.** Keeping `.bin` upload costs almost nothing: the artifact format,
validation and content addressing exist already, and it serves advanced users and any firmware we
cannot build.

**Cost and risk, stated honestly.**

| Item | Assessment |
|---|---|
| Build service | New work: a sandboxed `arduino-cli` runner, a build queue and a result cache keyed by source hash + toolchain version |
| Toolchain image size | The ESP32 Arduino core plus toolchain is on the order of a gigabyte on the build host. Not shipped to browsers |
| Compile latency | **Unmeasured.** A first build is typically tens of seconds; cached rebuilds should be fast. V1 must **measure it** and show progress, not promise a number |
| Security | Compiling untrusted source needs the same posture as running untrusted firmware: isolated, network-less, CPU/memory/time limited (architecture §11). P6 applies |
| Cost discipline | A build host plus a session host is the V1 server footprint. Both are covered by the capacity gate (P2) |
| Flash-mode advantage | For the compiled path we control the flags, so DIO is guaranteed and the QIO failure mode disappears |

**Decided (PM-2): both paths, as scoped above.**

### 8.3 MicroPython — decided: not in V1 (PM-4)

**MicroPython authoring is not part of V1 and is not advertised as a supported workflow.** Sprint 0's
MicroPython result stays what it was: feasibility evidence that the runtime boots a real classic-ESP32
binary. MicroPython authoring is a *different product surface* — a filesystem, a REPL, paste/run
semantics, and a different mental model — and none of it is proven or designed. It stays a candidate
for a later release because the runtime already boots it.

---

## 9. Instruments

V1 distinguishes three things deliberately:

| Concept | Meaning in V1 |
|---|---|
| **Measurement / probe** | A value the engine already computes, attached to a point the user selects. No instrument model |
| **Instrument** | A modelled device with controls and its own electrical behaviour (the PSU) |
| **Visual UI** | Presentation of the above. Never a substitute for either |

### 9.1 Laboratory PSU — **in V1**

| Control / display | V1 | Notes |
|---|---|---|
| Voltage setpoint | Yes | Live mirror: persisted by the browser, then mirrored to the session |
| Current limit | Yes | Same |
| Output enable | Yes | Same |
| Measured output voltage / current | Yes | From the solve |
| CV / CC indication | Yes | The mode is part of the solution, not a post-hoc label |
| Output impedance, loop dynamics, current sinking | **No** | Documented idealisations of the model |

### 9.2 Measurements — **in V1: probes and inspector, not a meter** (PM-3)

**Naming rule:** V1 must not call this a multimeter. It exposes **solver-backed values**; it does not
reproduce meter behaviour (leads, ranges, burden voltage, de-energized resistance measurement).

- Select a net -> its voltage. Select a component -> its current, terminal voltages, and derived
  values (e.g. LED forward voltage).
- Pin a probe so a value stays visible while running.
- Values V1 may expose: **node voltage, component/branch current, PSU measured voltage and current,
  GPIO pin state.** DC only.

### 9.3 Full multimeter — **decided: V1.1** (PM-3)

A DMM panel with V/A/Ω would be familiar, but:

- **DC V and DC A** add nothing the probes do not already give, beyond framing;
- **resistance** is *not* a solve of the existing circuit: an ohmmeter injects a test current into a
  **de-energized** network. That is a new measurement mode with its own semantics and its own
  failure cases (measuring resistance in a live circuit), and it is not proven.

Decided: probes in V1; the meter, including a correct Ω mode, in V1.1.

### 9.4 Oscilloscope — **deferred, explicitly**

Excluded: the engine has no general transient analysis (V1 has only the limited capacitor stepping
of §6.0a, local circuits). Displaying a "waveform" without a time-domain model behind every part
would be theatre. This is the clearest example of the physics rule in product form.

### 9.5 Serial monitor — **in V1 (read-only)**

The firmware's console output, streamed with its simulation timestamps. It is part of the
determinism fingerprint, so it is proven, and it is how a student sees `Serial.println()`. Serial
**input** is V1.1.

### 9.6 GPIO state view — **in V1, as part of the ESP32 symbol**

Pin level and direction shown on the board symbol while running. Not a logic analyser: no timeline,
no history. A GPIO **timeline** view is a strong V1.1 candidate because the events already carry
simulation timestamps.

---

## 10. Simulation controls and project/file behaviour

### 10.1 Controls

| Control | Behaviour | Notes |
|---|---|---|
| **Run** | Mode A: solve and display. Mode B: create session, load snapshot + firmware, boot, run | Mode B shows explicit `booting` / `connecting` states |
| **Pause** | Simulation time freezes | Mode B pauses by withholding the tick reply, so the timeline is unaffected |
| **Resume** | Continues from the same simulation instant | Commands issued while paused apply at the first quantum after resume |
| **Stop** | Ends the run, returns to the editable state at t = 0 | The way to "restart the firmware" in V1 |
| **Reset (EN / chip reset)** | **Not in V1** | P10: unsupported until it passes R-MCU-1. Not shown as a disabled button with no explanation — it is simply absent, and the docs say why |

### 10.2 Editing while running

| Edit | While running | User experience |
|---|---|---|
| Value change that the runtime supports (PSU setpoint, current limit, output enable, switch position) | **Applied live** | Persisted locally first, then mirrored; the applied simulation instant is echoed |
| Structural change (add/remove/rewire a component, change a resistance that redefines the network, change firmware) | **Controlled restart** | The UI states plainly: "this change restarts the simulation". One confirmation, then reload and run from t = 0 |
| Layout-only change (move, rotate, rename, notes) | **Allowed, no effect on the run** | Layout is not part of the simulation snapshot |

Resistance changes are a value edit for the engine; whether V1 applies them live or via restart is
an engineering call bounded by the architecture's "topology immutable while loaded" rule, and the
recommendation is: **live for a component's parameter, restart for anything that changes the
netlist**.

### 10.3 Projects

| Capability | V1 | Notes |
|---|---|---|
| New project | Yes | Opens on an empty canvas with the PSU already present (see §14) |
| Name / rename | Yes | User-authored text, never translated |
| Automatic local save | Yes | Debounced; proven in Gate D |
| Save-state indicator | Yes | "All changes saved" / "Saving…" / "Could not save" |
| Recent projects list | Yes | Local |
| Open, duplicate, delete | Yes | Delete asks for confirmation; duplicate copies the firmware reference, not a second copy of the binary |
| Export / import a project file | **Yes (PM-7)** | Must be **meaningfully portable** — see §10.4. A project must never export a dangling local firmware reference |
| Schema migration | Yes, conceptually | A project from an older schema migrates forward on open; a project from a **newer** schema opens **read-only** with a clear message. Gate D proved round-tripping but built no migration framework |
| Cloud storage, accounts, sharing links | **No** | Not in V1 |

---

### 10.4 Export must be portable (PM-7)

An exported project is a **package**, not a pointer. Conceptually it carries everything needed to
reproduce the project on another machine:

| Content | Why |
|---|---|
| Project / schema data (components, nets, connections, values, layout, annotations, `schemaVersion`) | The circuit itself |
| User-authored Arduino source, where the project has any | So the recipient can read, edit and rebuild it |
| The required firmware artifact(s) | So the project runs without a rebuild, and without the original machine |
| Firmware hashes and compatibility metadata (`sha256`, target, flash mode/size, pinned core and toolchain identity) | So the recipient knows exactly what produced it, and validation can refuse a mismatch |
| User-authored text (name, net names, notes) verbatim | Never translated or normalised |

**Import rules**

- Validate `schemaVersion`, artifact integrity (hash matches bytes) and target compatibility **before**
  anything is added to the user's projects.
- A newer schema opens **read-only** with a clear message; it is never silently down-converted.
- **Engineering values are never silently reinterpreted** — no unit guessing, no rounding, no
  "repairing" a value that does not parse. Refuse with a specific reason instead.
- An artifact that fails validation is refused, not converted (P7 applies: QIO is never rewritten).

The exact container format is an implementation decision for the roadmap.

## 11. Offline / online behaviour and the identity boundary

### 11.1 What works without the network

| Situation | V1 behaviour |
|---|---|
| Project **without** an ESP32, offline | Fully usable: create, edit, wire, configure, simulate, save, reopen |
| Project **with** an ESP32, offline | **Opens and edits normally.** All project data is local. Only *running the MCU* is unavailable, with an explicit "simulation needs a connection" state on the Run control |
| Project with an ESP32, online | Full journey |
| Connection lost mid-run | Session pauses; a reconnect grace of 60 s applies; on reattach, state and the recent serial tail are restored. Project work is never at risk |
| Grace expired / session terminated | The run ends with a clear message and a one-click way to start a new run. The project is untouched |
| Service unavailable or at capacity | Explicit, non-alarming message distinguishing "you are offline" from "the service is unavailable" |

**Hard rule (architecture invariants 1-3):** opening, editing and saving an ESP32 project must never
depend on the server.

### 11.2 The identity boundary (PM-8)

**Local functionality must not require an account merely because the product has server features.**

| Capability | Requires sign-in? |
|---|---|
| Create / open local projects | **No** |
| Edit circuits, configure values | **No** |
| Autosave locally | **No** |
| Import / export a project package | **No** |
| Browser-local non-MCU electrical simulation | **No** |
| **Arduino build service** | **Yes** — authenticated and authorized |
| **Classic ESP32 simulation service** | **Yes** — authenticated and authorized |

Before either service is exposed over the public Internet, **authentication, authorization, resource
limits and abuse protection are mandatory** (P6).

**Authentication does not imply cloud storage.** Signing in grants access to compute, nothing more.
Project ownership stays browser-local exactly as Sprint 1 defines it (ADR-001, invariants 1, 12). Cloud
project storage is a separate future decision and is **not** part of V1.

---

## 12. Localization (Hebrew and English, N locales later)

| Aspect | V1 rule |
|---|---|
| Language selection | Explicit switch in the UI; applies immediately; the choice is remembered per device (not stored in the project) |
| Direction | Hebrew UI is RTL for application chrome: menus, panels, dialogs, inspector labels |
| Canvas | **Always LTR** in its technical layout: circuit geometry, wires, component identifiers (`R1`, `D1`, `U1`), pin labels (`GPIO2`), numbers and units. Changing language never moves a component |
| Code editor and serial monitor | Always LTR |
| Component names and descriptions | Localized from the catalog via translation keys; the project stores only `component.resistor` |
| Property labels and enum values | Localized; stored as language-neutral keys (`resistance`, `cv`) |
| Validation, errors, warnings | Localized; identified by stable codes so support and logs are language-independent |
| Instrument labels | Localized, except technical terms that are standard in professional use in the target locale (`GPIO`, `PWM`, `CV`/`CC` may stay as-is) |
| Units and numbers | Canonical SI in the data; locale affects only formatting (decimal separator, grouping) |
| User-authored text | Project name, net names, notes, code comments: shown verbatim, never translated or re-written |
| Adding a language later | New translation bundle only; no schema change, no project conversion |

**Acceptance:** the same project file, byte-for-byte, opens in both languages with identical
topology, values and simulation results.

---

## 13. Supported platforms

| Target | V1 | Basis |
|---|---|---|
| Chromium desktop (Chrome, Edge) | **Supported for the V1 controlled pilot** | The only browser ever tested in this project: all browser proofs run on Chromium 153, including Web Worker, IndexedDB and full-restart persistence |
| Firefox desktop | **Next expansion target** (after V1) | Never tested; no test lane exists yet |
| Safari desktop | **Not a V1 commitment** | Never tested; IndexedDB and Worker behaviour differ enough to require real testing |
| Mobile / tablet browsers | **No** | Desktop-first product (CLAUDE.md) |
| Native desktop app | **No** | — |

**Expansion path:** add browser projects to the Playwright configuration, run the Gate A/Gate D
equivalents (Worker determinism, IndexedDB persistence across restart, WebSocket behaviour) in
Firefox, then Safari, and promise a browser only once those pass in CI. **Decided (PM-5): Chromium-family for the pilot, Firefox next,
Safari not committed, no mobile or native target.**

**Do not promise what is untested** — the product should say "works in Chrome and Edge; other
browsers untested" rather than listing browsers optimistically.

---

## 14. First-run experience, examples and templates

### 14.1 First run — the minimum

- **No tour, no multi-step onboarding.**
- A new project opens with an **empty canvas that already contains a lab PSU and a ground**, because
  every circuit needs them, and an empty canvas with no anchor is the least useful start.
- A single, dismissible panel offers: *Start from an example* / *Start empty*.
- The **example gallery** is the onboarding.

### 14.2 The six V1 examples

Each one doubles as a product demo and as an acceptance scenario.

| # | Example | Proves | Mode |
|---|---|---|---|
| 1 | **Resistor across the PSU** | The simplest complete loop: setpoint, measured current, Ohm's law | A |
| 2 | **Voltage divider** | Nets and node voltages; editing a value changes the result | A |
| 3 | **LED with series resistor** | Real device physics: forward voltage, non-obvious current | A |
| 4 | **Current-limited supply into a low resistance** | CV -> CC transition as a *physical* behaviour, not an error | A |
| 5 | **ESP32 blinks an LED** | Firmware drives the circuit; deterministic GPIO; serial output | B |
| 6 | **ESP32 reads a button and controls an LED** | The circuit drives the firmware; input thresholds; the complete closed loop | B |

Examples 5 and 6 ship with their sketch source (and, under PM-2 option A, a prebuilt image). Each
example is a normal project: openable, editable, and duplicable by the user.

**Not in V1:** a template system, user-authored templates, dozens of examples.

---

## 15. Error model and educational feedback

V1 separates two categories, and the UI must look different for each.

### 15.1 Physically valid but noteworthy — **informational, never an error**

| Situation | What the user sees |
|---|---|
| PSU enters current limit (CC) | A clear CC indication on the PSU with the measured values. This is the supply behaving correctly |
| Short circuit on a current-limited supply | Same: CC, at the limit, with a very low terminal voltage. Worth highlighting, not an error |
| LED below its conduction region / no visible light | LED shown off with its actual current |
| GPIO input inside the datasheet's undefined band | Shown as "held at previous level (undefined band)", with the threshold values |
| Simulation slower than real time | The simulated/wall ratio is shown, never hidden |

### 15.2 Technical errors — **block or stop, with a specific reason**

| Situation | V1 behaviour |
|---|---|
| Unconnected terminal / floating subnet | Flagged while editing, before running: which component, which terminal |
| No ground / no reference | Run is refused with an explicit message; the solver requires a reference net |
| Invalid connection (e.g. wiring a reserved or input-only pin as an output) | Refused at the moment of wiring, with the reason |
| Unsupported topology or unknown component | Refused with the component named, never approximated |
| Solver non-convergence | Mode A: the result is replaced by the error, not by a stale or partial number. Mode B: the run **pauses** at that simulation instant and says which components and which instant |
| Singular network | Reported as such ("the circuit has no unique solution") rather than returning nonsense |
| Unsupported ESP32 peripheral used by firmware | Runtime notice naming the peripheral where available (§7.3) |
| Wrong firmware target (not classic ESP32) | Rejected at load with the detected target |
| QIO firmware | Rejected with `unsupported_flash_mode` and an explanation of how to rebuild with DIO. **Never converted** (P7) |
| Firmware build failure (PM-2 option B/C) | Compiler errors shown with line references; the previous working firmware stays usable |
| Simulation service unavailable / at capacity | Explicit state; editing continues; retry offered |
| Session runtime crash | "Simulation stopped: runtime error", diagnostics retained, one action to start a new session. Project untouched |

**No AI explanations in V1.** Messages are written, localized strings with stable codes.

---

## 16. Visual quality and accessibility

### 16.1 Product-level visual principles (not designs)

1. **An engineering workspace, not a toy.** Restrained palette, real symbols, no cartoon styling.
2. **Projector-legible.** Readable at classroom distance: generous minimum text size, high contrast
   between wire, symbol and background, no information carried only by a thin line.
3. **Editing and running look different at a glance.** State is visible from across a room.
4. **Nets are unmistakable.** Wires, junctions and connection points are visually explicit; a
   crossing is never confusable with a junction.
5. **Selection is unambiguous**, including multi-selection.
6. **Values sit near what they describe**, without covering the circuit.
7. **First-class RTL**: the chrome mirrors cleanly while the canvas and all technical text stay LTR.
8. **Uncluttered by default**: measurements and overlays are opt-in per element.

### 16.2 Accessibility and input baseline

| Requirement | V1 |
|---|---|
| Keyboard access to core actions | Place, select, move, delete, wire, run/stop, open panels, switch language |
| Visible focus | Always, including on canvas objects |
| Contrast | Meets WCAG AA for text and essential UI |
| Not colour-alone | State (CC, error, pin level, run state) always carries a label, shape or icon as well |
| Mouse / trackpad | First-class: drag, wheel zoom, drag-pan |
| Screen-reader support of the canvas | **Not promised in V1**; panels, dialogs and forms are labelled properly |
| Touch / mobile | Out of scope |

---

## 17. Performance expectations (user-facing, not SLAs)

| Expectation | Basis |
|---|---|
| Editing and local simulation feel immediate | A nonlinear solve measured at 0.07-0.09 ms in a browser Worker; the UI thread stays responsive |
| Heavy work never freezes the UI | The engine runs in a Worker; long operations show progress |
| Starting an ESP32 session shows explicit stages | Session start includes creating the session, loading firmware and booting the chip. The **first seconds of boot progress slowly** by design (the ROM phase runs at roughly 0.06x real time) |
| Running firmware keeps up with real time on a capable host | 15.5 s of simulated time ran in 10.3 s wall on the constrained dev host at a 1 ms quantum |
| Display refresh is independent of simulation progress | Frames are throttled (≤ ~20 Hz) and never slow the simulation |
| No millisecond promises | Anything not measured is not stated. Production-class figures require the capacity gate (P2) |

---

## 18. V1 non-goals (decided, not copied)

| Non-goal | Decision and reason |
|---|---|
| PCB design, Gerber, autorouting, 3D PCB | **Excluded.** Different product; explicitly out of scope in CLAUDE.md. *The derived 3D bench view is in V1 (PM-10, §4.4); 3D editing is not* |
| 3D editing (topology, layout, rewiring in 3D) | **Excluded from V1** (PM-10). 3D is a derived view; the Circuit view is the only editing surface |
| SPICE netlist editor / import / export | **Excluded.** V1's audience does not need it; it would expose engine internals as a product surface |
| AC analysis | **Excluded.** No AC engine |
| General transient analysis | **Excluded from V1.** *Revised 2026-10-08 (PM-9): limited transient (local capacitor circuits, fixed step) IS in V1 (§6.0a); ESP32 transient integration is a V1 roadmap item* |
| Oscilloscope, signal generator, logic analyser | **Excluded.** Require general transient analysis |
| Full ESP32 peripheral coverage | **Excluded.** Each peripheral needs runtime support *and* an electrical story |
| Wi-Fi / Bluetooth simulation | **Excluded.** Sessions have no network by design |
| Additional MCU families | **Excluded.** CLAUDE.md fixes the classic ESP32 as the V1 target |
| Cloud project sync, collaboration, CRDT | **Excluded.** ADR-001 keeps the browser authoritative; sync is a later, separate design |
| Accounts as a product feature | **Excluded.** The only identity in V1 authorizes the **build and simulation services** (PM-8). It brings no profile, no cloud storage and no gating of local work (§11.2) |
| Billing | **Excluded** |
| AI features | **Excluded.** The engine is the source of truth; AI explanations would blur that in the first release |
| Mobile, tablet, native apps | **Excluded** |
| Full Arduino IDE replacement, library ecosystem | **Excluded.** V1 builds one sketch against the pinned core |
| MicroPython authoring | **Excluded** (PM-4); not advertised as supported |
| Fritzing-style breadboard/PCB workflow | **Excluded** (PM-1); a realistic breadboard view is a future consideration, not a V1 duplication of Fritzing |
| Instructor/classroom management | **Excluded** |

---

## 19. Product acceptance journey

One end-to-end scenario over the **approved** scope. **V1 (controlled pilot) is not ready until a
person can do all of this, in both languages, without a workaround.** This is product acceptance, not
a test specification. Full-chip **Reset is deliberately absent**, because that capability is
unsupported (P10).

| # | Step | Must be true |
|---|---|---|
| 1 | **Create a local project** and name it (Hebrew name accepted) | No sign-in required; saved locally at once; the name is shown verbatim |
| 2 | **Place components** on the schematic: PSU, ground, resistor, LED | Place, move, rotate, select, delete — mouse and keyboard |
| 3 | **Wire** them into a series loop | Junctions unambiguous; a deliberate mistake (unconnected terminal) is flagged specifically |
| 4 | **Configure** 220 Ω, PSU 5 V / 100 mA, output on | Unit-aware entry; values echoed in the inspector |
| 5 | **Run the passive circuit** | Results appear without a noticeable wait; no server involved |
| 6 | **Probe values** | Node voltage, component current, LED forward voltage, PSU measured V/I and CV; lowering the limit shows **CC as normal behaviour**, not an error |
| 7 | **Autosave and reopen** — close the browser completely, reopen, open the project | Exact restore: components, wires, values, name |
| 8 | **Export the project, then import it** (fresh profile or after deleting it) | The package is portable: schema data, any sketch source, firmware artifact and hashes. Import validates and never reinterprets engineering values |
| 9 | **Switch Hebrew <-> English** | UI mirrors; canvas geometry, identifiers, pin labels, numbers and units stay LTR; **no engineering data changes** |
| 10 | **Add a classic ESP32 DevKit** | Board symbol with real header labels |
| 11 | **Use supported DevKit pins**: GPIO2 -> resistor -> LED -> GND, and a push button into a supported input with a pull | Reserved flash pins are refused with a reason; input-only pins offer no pull; strapping pins are flagged but usable |
| 12 | **Provide firmware**: write and build a single-file sketch, **or** upload a compatible `.bin` | Build produces a content-addressed artifact with pinned toolchain metadata; QIO upload is rejected with a clear reason and never converted |
| 13 | **Start the MCU simulation** — authenticated | Sign-in is required **here**, not earlier; explicit states: creating, loading, booting, running |
| 14 | **GPIO output affects the circuit** | The LED responds to `digitalWrite`; the pin voltage reflects the real driver resistance, not 3.3 V |
| 15 | **The circuit affects GPIO input** | Pressing the button changes the level the firmware reads, through the datasheet thresholds |
| 16 | **Observe serial output** | The sketch's console output streams with its simulation timestamps |
| 17 | **Pause and resume** | Simulation time freezes and continues with no jump or drift |
| 18 | **Stop, edit, run again** | Structural edits state plainly that they restart the simulation; new results match the new values |
| 19 | **Lose and regain the simulation service** | The run pauses and reattaches within the grace period; after expiry the message is clear. **No project work is lost in either case** |
| 20 | **Reopen the ESP32 project while offline / signed out** | It opens, edits and saves normally; only running the MCU is unavailable, and it says so |
| 21 | **Run the same firmware and circuit twice** | The observable behaviour is identical both times — the determinism promise, visible to the user |

## 20. V1 / V1.1 / Future matrix

| Capability | V1 | V1.1 | Future |
|---|---|---|---|
| Schematic editor, wiring, nets, undo/redo | ● | | |
| Circuit view (editing) + derived Schematic + derived 3D bench view (PM-10) | ● | | |
| 3D editing (topology, layout, rewiring) | | | ● |
| Breadboard view over the same net model | | | ● |
| Lab PSU (CV/CC, enable, measured V/I) | ● | | |
| Resistor, LED, diode, ground | ● | | |
| Push button, toggle switch | ● | | |
| Potentiometer | | ● | |
| Capacitor, local circuits (limited transient, §6.0a) | ● | | |
| Capacitor in ESP32 projects (ESP32 transient integration) | ● *(roadmap)* | | |
| Capacitor non-ideal effects (leakage, ESR) | ● *(later)* | | |
| Inductor | | | ● |
| Transistor, relay (§6.0) | ● | | |
| 555 (after an explicit pin-level model approval, §6.0); op-amps | ● *(roadmap)* | | ● *(op-amps)* |
| Multi-position switch | ● *(roadmap)* | | |
| RGB LED, buzzer, LED matrix, servo, I2C LCD (§6.0) | ● | | |
| Sensors: LDR, PIR, ultrasonic, temperature/humidity (§6.0); thermistor | ● | | ○ |
| DC operating-point simulation (browser-local) | ● | | |
| Limited transient: fixed step, local capacitor circuits (PM-9) | ● | | |
| General transient analysis, waveforms | | | ● |
| AC analysis | | | ● |
| Probes / inspector measurements (V, I) | ● | | |
| Multimeter instrument incl. resistance mode | | ● | |
| Oscilloscope | | | ● |
| Serial monitor (output) | ● | | |
| Serial input to firmware | | ● | |
| Preflight static diagnostics for unsupported APIs (built source) | | ● | |
| GPIO state on the board symbol | ● | | |
| GPIO timeline / logic-analyser view | | ● | |
| Classic ESP32: digital I/O, direction, pulls, deterministic loop | ● | | |
| GPIO 32/33 outputs (close the bank-1 bridge gap) | ● *(pre-release fix)* | | |
| ESP32 ADC | | ● | |
| Potentiometer + ADC together | | ● | |
| ESP32 PWM for the servo (runtime R4) | ● *(planned)* | | |
| ESP32 PWM/LEDC beyond the servo, DAC, touch | | | ● |
| ESP32 µs input timing for sensors (runtime R2) | ● *(planned)* | | |
| ESP32 I2C with device models, incl. the I2C LCD (runtime R3, PM-11) | ● *(planned)* | | |
| ESP32 SPI with device models | | | ● |
| Wi-Fi / Bluetooth | | | ● |
| `esp_restart()` / WDT / EN reset (after R-MCU-1) | | ● | |
| Deep / light sleep | | | ● |
| Arduino sketch editor + server build (single file, pinned toolchain) | ● | | |
| `.bin` upload | ● | | |
| Multi-file sketches, libraries | | | ● |
| MicroPython authoring | | | ● |
| Local-first projects, autosave, recent, duplicate, delete | ● | | |
| Export / import portable project package | ● | | |
| Cloud sync, accounts, sharing | | | ● |
| Hebrew + English, N-locale-ready | ● | | |
| Additional languages (German, Spanish…) | | ○ | ● |
| Public / general-availability release (abuse posture, public-scale capacity) | | | ● |
| Example projects (6) | ● | | |
| Templates, user-authored templates | | | ● |
| Chromium desktop support | ● | | |
| Firefox support | | ● | |
| Safari support | | | ● |
| Mobile / native apps | | | ● |
| AI circuit generation / troubleshooting | | | ● |

● = planned there · ○ = candidate, not committed

*2026-10-06: the §6.0 revision moves the component families above into V1 development. 2026-10-08
(PM-9..PM-11): limited transient, the 3D bench view, ESP32 I2C, µs input timing and servo PWM move
into V1 as shown.*

**Confirmed outside V1** (PM): potentiometer; full multimeter / resistance mode; general transient
analysis and waveforms; oscilloscope; ADC/DAC; PWM/LEDC beyond the servo; externally wired UART; SPI;
3D editing; Wi-Fi/Bluetooth;
MicroPython authoring; additional MCU families; breadboard view; cloud project sync; collaboration;
mobile and native apps. Placement between V1.1 and Future is as shown above — nothing on that list is
automatically V1.1.

---

## 21. PM decisions — recorded as approved

All eight decisions raised in the first draft are **decided**; PM-9..PM-11 were added at the Sprint 10 closure (2026-10-08). The alternatives and their trade-offs
remain in the sections cited, so a later reversal is an informed one.

| # | Decision | Approved outcome | Where it is applied |
|---|---|---|---|
| **PM-1** | Workspace | **Schematic-only V1.** Professional schematic workspace, standard/physically suggestive symbols, ESP32 drawn as a DevKit block with real header labels. Breadboard deferred; the net/project model must not prevent a future breadboard view | §4.1 |
| **PM-2** | Firmware workflow | **Both, narrowly scoped**: single sketch -> Build -> artifact -> Run, plus `.bin` upload as the advanced path. Pinned Arduino-ESP32 toolchain. No Library Manager, no arbitrary board packages, no multi-file project system, no general ecosystem support. DIO and runtime compatibility rules still apply | §8 |
| **PM-3** | Measurements | **Probes / inspector only.** Solver-backed node voltage, component current, PSU V/I and GPIO state. **Not called a multimeter.** Resistance and a full meter move to V1.1 | §9.2, §9.3 |
| **PM-4** | MicroPython | **Not in V1**, and not advertised as a supported workflow. Sprint 0's result stays feasibility evidence | §8.3 |
| **PM-5** | Browser scope | **Chromium-family desktop** for the controlled pilot; **Firefox** next; **Safari** not committed; no mobile or native target | §13 |
| **PM-6** | Component catalog | ~~Closed eight-item catalog (§6.1)~~ **Revised 2026-10-06 (§6.0):** the approved families (switching, lighting incl. RGB, transistor, LDR, buzzer, relay, sensors, LED matrix, servo, I2C-only LCD, 555 and capacitor once their time-domain behaviour is honest) may be added. Potentiometer remains V1.1 | §6 |
| **PM-7** | Export / import | **In V1**, and **meaningfully portable**: schema data, user-authored source, firmware artifacts, hashes and compatibility metadata. Import validates; it never silently corrupts or reinterprets engineering values. Container format is a roadmap decision | §10.4 |
| **PM-9** | Transient simulation (2026-10-08) | **Limited transient is in V1:** deterministic fixed-step time-domain simulation of local (non-ESP32) capacitor circuits, integrated with Run/Stop. ESP32 transient integration is not supported today and stays a V1 roadmap item | §4.3, §5, §6.0a, §18, §20 |
| **PM-10** | Views (2026-10-08) | **Circuit** = the authoritative editing surface; **Schematic** = derived electrical representation; **3D** = derived physical representation (inspection, navigation, selection, shared Inspector, operating approved controls during Run). No topology editing, layout or rewiring in 3D; full 3D editing deferred | §4.4, §18, §20 |
| **PM-11** | ESP32 I2C (2026-10-08) | **V1 planned capability** (with the I2C LCD), implemented in runtime Phase R3. I2C-only LCD policy unchanged | §5, §6.0a, §7.4, §20 |
| **PM-8** | Release model | **V1 is a controlled pilot**, not public GA. Local work never requires an account; the build and simulation services require authentication and authorization. Auth, limits and abuse protection are mandatory before public exposure. Authentication does not bring cloud storage | §11.2, §25 |

### Additional PM corrections recorded

| Correction | Effect |
|---|---|
| **ESP32 pin capability model** | Numeric range claims ("outputs 0-31, inputs 0-39") are replaced by a **board capability map** with explicit per-pin metadata, including a separate `simulatorSupport` field. Hardware capability and simulator gaps are never conflated | §7.1, §7.2 |
| **GPIO 6-11** | Never exposed as ordinary user GPIO on a WROOM-style DevKit; they belong to the module's flash | §7.2 |
| **GPIO 34-39** | Represented as input-only **without** internal pulls, because that is the hardware | §7.2 |
| **GPIO 32/33** | Hardware output-capable. Our bridge's bank-0-only event limitation is labelled a **simulator limitation**, to be closed before release or stated as such | §7.2, §24 |
| **Unsupported peripherals** | The guarantee covers the documented subset only. Static preflight diagnostics are possible for source we build; **no perfect detection is claimed for uploaded `.bin`**; reliable runtime detection produces a diagnostic rather than fabricated behaviour | §7.5 |

## 22. Risks to product scope

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| S1 | **Scope leak through "just one more component"** (capacitor, transistor, sensor) | Physics claims weaken; V1 slips | Every component must state its model status here first; the matrix (§20) is the gate |
| S2 | **Users expect waveforms** because the product looks like a lab | Disappointment, or pressure to fake a scope | State the simulation scope prominently (DC, plus limited capacitor transient in local circuits, PM-9); ship the scope with general transient analysis |
| S3 | **Build service cost and latency** (if PM-2 = B/C) | Poor first-run experience; hosting cost | Measure compile latency early; cache by source hash; show progress; capacity gate (P2) |
| S4 | **The ESP32 journey needs the network**, and users will meet it offline | Perceived as broken | Explicit offline behaviour (§11); editing never blocked; message distinguishes offline from unavailable |
| S5 | **Unsupported-peripheral detection is best-effort** | A user writes `analogRead()` and believes the result | Pin-level static marking in the editor, runtime notice where detectable, and honest documentation |
| S6 | **Hebrew is treated as a translation pass at the end** | RTL defects, layout breakage, late rework | Both languages are acceptance criteria (§19) from the first UI sprint; no English-only screens |
| S7 | **Classroom visual quality judged too late** | Redesign after implementation | Projector legibility is an acceptance property, reviewed on a real projector before V1 |
| S8 | **No reset control** may read as a missing feature | Users try to restart firmware | Stop/Run is the documented restart path; the limitation is stated plainly (P10) |
| S9 | **Example projects become the de-facto test suite** and rot | Broken demos | Each example is an acceptance scenario with an owner and runs in CI |
| S10 | **Determinism promise is user-visible** and must survive every new feature | A regression breaks a stated product property | The pinned release-gate fingerprints already fail the build on drift |

---

## 23. Definition of Done

### 23.1 This product-scope phase

Complete when:

1. Every V1 capability is traceable to proven evidence or to explicitly accepted new work (§4-§9).
2. Every exclusion has a stated reason (§5, §18).
3. The component catalog is **closed** (§6.1, PM-6). *Superseded 2026-10-06: the catalog is open to the approved families of §6.0.*
4. The ESP32 promise is expressed as a **board capability map**, not numeric ranges (§7).
5. One firmware workflow is decided (§8, PM-2). ✔
6. The acceptance journey is agreed as the definition of "V1 exists" (§19).
7. The V1 / V1.1 / Future matrix is agreed (§20).
8. PM decisions PM-1..PM-8 are recorded (§21). ✔
9. Nothing contradicts Sprint 0 or Sprint 1 evidence (§24).
10. Only after sign-off is the implementation roadmap written.

### 23.2 V1 itself — readiness for the **controlled pilot**

V1's Definition of Done is **pilot readiness**, not public-scale readiness. It requires:

| Requirement | Note |
|---|---|
| The acceptance journey (§19) passes end to end, in English and Hebrew | Including export/import and the offline path |
| The catalog behaves per §6 (§6.0 since 2026-10-06), with model provenance recorded | No component added silently or outside the approved families |
| The board capability map is implemented and datasheet-sourced (§7.2) | Including the `simulatorSupport` field |
| The bank-1 output gap is closed, **or** GPIO 32/33 are labelled a simulator limitation | §7.2, §24 |
| The runtime carries no fork-specific board devices on GPIO 4/16/27 | §7.2 |
| The deterministic release gate R-MCU-1 still passes | Sprint 1 gate, with pinned fingerprints |
| Authentication, authorization and per-user limits protect the build and simulation services | P6, at pilot scale |
| Pilot capacity is measured on the hardware the pilot actually runs on | P2; **not** a public-scale capacity claim |
| Unsupported capabilities are stated in-product, not only in documents | §7.4, §7.5 |
| Visual legibility verified on a real projector | §16.1 |

**Explicitly not required for the pilot:** public-scale abuse protection, multi-region capacity, GA
support processes, marketing-facing browser breadth, or any cloud storage.

## 24. Conflicts and tensions found against Sprint 0 / Sprint 1

None of these invalidate earlier work; each is a place where a plausible product expectation meets
proven evidence.

| # | Tension | Resolution taken here |
|---|---|---|
| 1 | A **capacitor** is a natural "basic component" expectation, but the engine is DC-only | Originally excluded (§6.1 deferral table). **Resolved 2026-10-08 (PM-9):** the capacitor ships for local circuits with honest fixed-step transient (§6.0a); refused in ESP32 projects until ESP32 transient integration |
| 2 | A **multimeter with resistance** is a natural lab expectation, but Ω is not a solve of the live circuit | Probes in V1; Ω with the DMM in V1.1 (§9.3, PM-3) |
| 3 | **GPIO 32/33 outputs** are not evented by the bridge (blocker B6), although the hardware supports them | Corrected per PM: this is a **simulator limitation**, never presented as hardware. Closing it is a pre-release item; until then the pins carry that reason. GPIO 34-39 are input-only **in hardware**, which is a different statement |
| 4 | **Reset** is an obvious simulation control, but full-chip reset is not deterministic yet (P10) | No reset control in V1; Stop/Run is the restart path |
| 5 | **MicroPython** technically boots, which invites "so it is supported" | Explicitly not supported as an authoring workflow (§8.3, PM-4) |
| 6 | **Oscilloscope** is expected in anything called a lab | Excluded; requires transient analysis (§9.4) |
| 7 | **P6** requires auth/limits before public exposure | Resolved by PM-8: V1 is a controlled pilot. Auth and limits guard the two services; local work needs no account (§11.2) |
| 10 | The QEMU fork wires **GPIO 4, 16 and 27** to its own demo peripherals (display backlight, display command, servo), so our harness masks them | Product-visible: those are ordinary DevKit pins. The production runtime must not carry those board devices (§7.2), tracked with the Espressif-baseline port (P8) |
| 8 | Sprint 0 recorded **looser pre-registered tolerances** than the code asserts | No product impact; noted so that future claims quote the asserted values |
| 9 | Sprint 0 harnesses attach the firmware image **writable** (errata E-2) | Product requirement already in the architecture: each session boots from a verified copy |

---

## 25. Release model and pilot terminology

The two release stages are named, and the product must not blur them.

| Term | Meaning |
|---|---|
| **V1 controlled pilot** | The scope in this document, delivered to a **bounded, invited audience** (e.g. specific instructors and their classes). The build and simulation services are reachable only by authorized users. Capacity is measured for that audience. This is what "V1 is done" means (§23.2) |
| **Public / general-availability release** | A later release offered openly. It additionally requires public-scale abuse protection, capacity measured for open traffic, support processes and the browser breadth we choose to promise. **Not in V1, and not implied by V1** |

Rules that follow from this:

1. **Do not plan V1 against public-scale assumptions.** Pilot capacity is measured on the hardware the
   pilot runs on (P2), and no capacity claim is generalized beyond it.
2. **Do not gate local work on identity.** Creating, editing, saving, importing, exporting and
   browser-local simulation work without an account (§11.2).
3. **Do not add cloud project storage because authentication exists.** Sign-in grants access to
   compute. Project ownership stays local (ADR-001).
4. **Say which stage a statement belongs to.** Documentation, in-product text and any external
   material distinguish "pilot" from "generally available".
5. **Pilot feedback is a product input, not an automatic scope change.** New requests go into the
   matrix (§20), not into V1.
