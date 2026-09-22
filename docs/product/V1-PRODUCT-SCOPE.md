# TBI Lab — V1 Product Scope

**Status:** DRAFT for PM review · **Date:** 2026-09-22 · **Phase:** Product scope (after Sprint 1)

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

**Recommendation for V1: schematic-style editing, with component symbols that stay physically
suggestive** — in particular, the ESP32 is drawn as a DevKit-shaped block with its real pin names
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

**Deferred:** a breadboard *view* over the same net model (V1.1/Future). Because connectivity lives
in the data rather than in geometry, adding that view later does not invalidate V1 projects. **This
is PM decision PM-1.**

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
| **Simulation (no MCU)** | DC operating point in a browser Worker, re-solved on every relevant change |
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

## 5. Exact excluded capabilities (V1)

Excluded means: **not built, not promised, and stated in the UI where a user might expect it.**

| Excluded | Why — evidence |
|---|---|
| AC analysis, transient analysis, waveforms over time | The engine is a DC operating-point solver. "DC only. No transient, no AC, no reactive components" (Gate A) |
| Oscilloscope, signal generator, logic analyser | All require a time-domain engine that does not exist |
| Capacitors, inductors | Meaningless in a DC-only engine: a capacitor is simply an open circuit. Including them would teach the wrong thing |
| Transistors (BJT/MOSFET) | No model exists; a new nonlinear model plus validation is a sprint of its own |
| ESP32 ADC, DAC, touch | The runtime's `analog` and `rtcio` peripherals are unimplemented (46 and 38 unimplemented accesses observed in one boot) |
| ESP32 PWM/LEDC | Not in the emulated peripheral set, and a DC engine cannot represent a duty-cycled waveform honestly |
| ESP32 I2C, SPI (user-level), external UART wiring | Not modelled in the electrical engine; no device models to talk to |
| Wi-Fi, Bluetooth | Not modelled; the session has no network by design (invariant 14) |
| Deep/light sleep | The runtime's sleep timer uses the host clock, which breaks determinism |
| `esp_restart()`, watchdog reset, in-place EN/reset button | Still asynchronous in QEMU; PM decision P10 keeps them unsupported until they pass R-MCU-1 |
| GPIO 32-39 as **outputs** | The bridge reports bank-0 outputs only (blocker B6). Inputs on 32-39 are proven (GPIO35) |
| Drive-strength, open-drain, firmware-controlled pulls | Not driven from firmware register state (blocker B5) |
| MicroPython authoring | Sprint 0 used it as a test artifact only: "This is not MicroPython support" |
| Arduino library ecosystem / dependency management | Out of scope; V1 builds a single sketch against the core only |
| Cloud sync, accounts beyond service authorization, collaboration, billing, AI | Not designed; ADR-001 keeps the browser authoritative |
| PCB, Gerber, routing, netlist import/export, SPICE files | Out of product scope (CLAUDE.md) |
| Mobile, tablet, native apps | Desktop browser only |

---

## 6. Component catalog

### 6.1 Included in V1

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

### 6.2 Deferred, with the reason

| Component | Decision | Reason |
|---|---|---|
| **Potentiometer** | **V1.1** | Electrically cheap (a wiper splitting one resistance), but its main teaching use is feeding an **ADC**, which V1 does not support. It belongs with ADC |
| **Capacitor / inductor** | **Future (needs transient)** | In a DC operating point a capacitor is an open circuit and an inductor a short. Showing them without transient analysis teaches something false |
| **Transistor (BJT, MOSFET)** | **Future** | New nonlinear models plus validation against an independent reference; a dedicated sprint |
| **Relay** | **Future** | Needs a coil/contact model and, realistically, transient behaviour |
| **Sensors (LDR, thermistor, DHT…)** | **Future** | Most are meaningful only with ADC or a digital protocol |
| **555 timer, op-amps, logic ICs** | **Future** | Time-domain or multi-transistor models |
| **Multiple/second MCU** | **Future** | One QEMU per active MCU session is a fixed architectural cost (§12 of the architecture) |
| **Breadboard, jumper wires as objects** | **See PM-1** | Depends on the editing-paradigm decision |

---

## 7. ESP32 capability scope

**The target is the classic/original ESP32 (Xtensa LX6, ESP32 DevKit class). No C3/S3/C6
substitution, silent or otherwise** (CLAUDE.md MCU rule; architecture invariant 5).

### 7.1 Supported in V1

| Capability | Status | Evidence |
|---|---|---|
| Digital output on GPIO 0-31 (bank 0) | **Supported** | Gate C: GPIO2/18/19 drive and are observed; direct register writes honoured |
| Digital input on GPIO 0-39 | **Supported** | Gate C: GPIO5 (bank 0) and GPIO35 (bank 1) read injected levels |
| Pin direction / high-Z | **Supported** | Direction events are reported; a pad that loses output-enable stops driving |
| Datasheet-accurate pin electricals | **Supported** | 16.5 Ω / 17.68 Ω driver resistances, V_IH 2.475 V, V_IL 0.825 V, hold in the undefined band |
| Internal pull-up / pull-down **set by the user in the editor** | **Supported** | 45 kΩ pulls exist in the pin model |
| Deterministic firmware <-> circuit interaction | **Supported** | Release gate R-MCU-1: 62 full runs + 30 stressed boot runs, zero divergences |
| UART0 serial **output** (the console the sketch prints to) | **Supported** | Serial output is part of the determinism fingerprint |
| Arduino core firmware, DIO flash mode, 4 MB image | **Supported** | Arduino core 3.3.12, FQBN `esp32:esp32:esp32`, `--flash-mode dio` |
| Firmware-initiated behaviour that only uses the above | **Supported** | — |

### 7.2 Unsupported in V1, and what the user sees

| Capability | V1 behaviour |
|---|---|
| ADC, DAC, touch | Pin marked **not simulated** in the editor; using it in firmware produces no electrical effect and raises a runtime notice |
| PWM / LEDC | Same. A duty cycle cannot be shown honestly by a DC engine |
| I2C, SPI, external UART devices | No device models exist; the pins behave as plain GPIO |
| GPIO 32-39 as outputs | Editor marks these pins **input-only in V1** and refuses to treat them as drivers (blocker B6) |
| Flash pins (GPIO 6-11) and board-reserved pins | Marked reserved in the editor; wiring them is blocked with an explanation |
| Drive strength, open-drain | Not modelled; the editor does not offer them |
| Wi-Fi, Bluetooth, deep/light sleep | Unsupported; firmware using them will not behave like hardware, and the session reports it |
| `esp_restart()`, watchdog reset, in-place reset button | **Not exposed** (P10). Restarting means Stop then Run, which is a fresh, deterministic session |
| Serial **input** (host -> firmware) | Deferred to V1.1; the monitor is read-only in V1 |

### 7.3 Diagnostics the user sees

V1 gives **pin-level, static diagnostics** (from a per-board capability table in the catalog) and
**best-effort runtime notices**:

- **Static (reliable):** reserved pin, input-only pin, unsupported peripheral role, "this pin has no
  electrical model in V1". These come from data we control and are shown while editing.
- **Runtime (best-effort):** the runtime can report accesses to unimplemented peripherals (QEMU
  already counts them: `iomux` 72, `analog` 46, `rtcio` 38, `apbctrl` 32, `i2s` 30 in one boot).
  V1 surfaces a **single, honest notice** — "the firmware used a peripheral TBI Lab does not
  simulate" — with the peripheral name when available.
- **What V1 does not claim:** complete detection of every unsupported firmware behaviour. The
  product says what it simulates; it does not promise to catch everything it does not.

---

## 8. Firmware / code workflow

### 8.1 The options

| Option | Description | Beginner | Instructor | Infrastructure | Security | Offline |
|---|---|---|---|---|---|---|
| **A. Upload `.bin` only** | User compiles elsewhere and uploads a merged image | Poor: needs a full Arduino toolchain first | Poor for a class | None beyond the session service | Low risk: image is validated, hashed, sandboxed | Upload works offline; running still needs the service |
| **B. Integrated editor + server build** | Single sketch edited in TBI Lab, built server-side by `arduino-cli` | Strong: edit, build, run in one place | Strong | A build service, toolchain image, cache | Compiling untrusted code needs a sandbox and quotas | Editing offline is possible; building is not |
| **C. Both** | B as the main path, A as the advanced/fallback path | Strong | Strong | Same as B | Same as B | Same as B |
| **D. Curated prebuilt sketches only** | Ship example binaries; no user code | Weak: not really "your code" | Weak | None | Lowest | Best |

### 8.2 Recommendation — **Option C, deliberately narrow**

- **Primary path:** a plain, single-file Arduino C++ editor (`setup()` / `loop()`), built by the
  service with the pinned core `esp32:esp32@3.3.12`, FQBN `esp32:esp32:esp32`, `--flash-mode dio`,
  4 MB. Build output is a merged flash image, content-addressed exactly as the architecture already
  defines (`fw_sha256_…`), stored in the browser next to the project.
- **Secondary path:** upload a `.bin`, with the existing validation (target, magic, size, flash
  mode; QIO rejected with `unsupported_flash_mode`, never converted — P7).
- **Explicitly not in V1:** multi-file projects, third-party libraries or a library manager, board
  variants beyond the classic ESP32, a serial-upload/flash workflow, debugging, an IDE clone.

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

**This is PM decision PM-2.** If the PM chooses A for V1.0, the journey's step 9 becomes
"upload a `.bin`", the six examples ship as prebuilt images, and the editor moves to V1.1.

### 8.3 MicroPython — explicit decision

**Recommendation: not in V1.** Sprint 0 used MicroPython only as a convenient trustworthy binary and
said so in writing. MicroPython authoring is a *different product surface* — a filesystem, a REPL,
paste/run semantics, and a different mental model — and none of it is proven or designed. It is a
strong **V1.1/V2** candidate because the runtime already boots it. **PM decision PM-4.**

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

### 9.2 Measurements — **in V1 (probe/inspector form)**

- Select a net -> its voltage. Select a component -> its current, terminal voltages, and derived
  values (e.g. LED forward voltage).
- Pin a probe so a value stays visible while running.
- **DC voltage and DC current only.**

### 9.3 Multimeter as an instrument — **recommend V1.1** (PM-3)

A DMM panel with V/A/Ω would be familiar, but:

- **DC V and DC A** add nothing the probes do not already give, beyond framing;
- **resistance** is *not* a solve of the existing circuit: an ohmmeter injects a test current into a
  **de-energized** network. That is a new measurement mode with its own semantics and its own
  failure cases (measuring resistance in a live circuit), and it is not proven.

Recommendation: ship probes in V1, ship the DMM (including a correct Ω mode) in V1.1.

### 9.4 Oscilloscope — **deferred, explicitly**

Excluded: the engine has no transient analysis. Displaying a "waveform" of a DC operating point
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
| Export / import a project file | **Recommended yes** (PM-7) | One `.tbilab.json` file; optionally embeds the firmware image (≤ 4 MB) so a teacher can hand out a complete, runnable project |
| Schema migration | Yes, conceptually | A project from an older schema migrates forward on open; a project from a **newer** schema opens **read-only** with a clear message. Gate D proved round-tripping but built no migration framework |
| Cloud storage, accounts, sharing links | **No** | Not in V1 |

---

## 11. Offline / online behaviour

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
| Chromium desktop (Chrome, Edge) | **Supported** | The only browser ever tested in this project: all browser proofs run on Chromium 153, including Web Worker, IndexedDB and full-restart persistence |
| Firefox desktop | **Not promised in V1** | Never tested; no test infrastructure exists for it |
| Safari desktop | **Not promised in V1** | Never tested; IndexedDB and Worker behaviour differ enough to require real testing |
| Mobile / tablet browsers | **No** | Desktop-first product (CLAUDE.md) |
| Native desktop app | **No** | — |

**Expansion path:** add browser projects to the Playwright configuration, run the Gate A/Gate D
equivalents (Worker determinism, IndexedDB persistence across restart, WebSocket behaviour) in
Firefox, then Safari, and promise a browser only once those pass in CI. This is PM decision **PM-5**.

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
| PCB design, Gerber, autorouting, 3D | **Excluded.** Different product; explicitly out of scope in CLAUDE.md |
| SPICE netlist editor / import / export | **Excluded.** V1's audience does not need it; it would expose engine internals as a product surface |
| AC analysis | **Excluded.** No AC engine |
| Transient analysis | **Excluded from V1**, but the API was deliberately shaped so it can be added later |
| Oscilloscope, signal generator, logic analyser | **Excluded.** Require transient |
| Full ESP32 peripheral coverage | **Excluded.** Each peripheral needs runtime support *and* an electrical story |
| Wi-Fi / Bluetooth simulation | **Excluded.** Sessions have no network by design |
| Additional MCU families | **Excluded.** CLAUDE.md fixes the classic ESP32 as the V1 target |
| Cloud project sync, collaboration, CRDT | **Excluded.** ADR-001 keeps the browser authoritative; sync is a later, separate design |
| Accounts | **Excluded as a product feature.** The only identity V1 may need is authorization for the simulation service (P6) — see PM-8 |
| Billing | **Excluded** |
| AI features | **Excluded.** The engine is the source of truth; AI explanations would blur that in the first release |
| Mobile, tablet, native apps | **Excluded** |
| Full Arduino IDE replacement, library ecosystem | **Excluded.** V1 builds one sketch against the pinned core |
| MicroPython authoring | **Excluded from V1** (PM-4) |
| Fritzing-style breadboard/PCB workflow | **Excluded from V1** (PM-1); a realistic breadboard view is a future consideration, not a V1 duplication of Fritzing |
| Instructor/classroom management | **Excluded** |

---

## 19. Product acceptance journey

One end-to-end scenario. **V1 is not V1 until a person can do all of this, in both languages,
without a workaround.** This is product acceptance, not a test specification.

| # | Step | Must be true |
|---|---|---|
| 1 | Open TBI Lab in a supported browser, first visit | An empty project or the example gallery is reachable in one action |
| 2 | Create a project and name it (Hebrew name accepted) | Saved locally; the name is shown verbatim |
| 3 | Place a PSU, ground, resistor and LED | Placement, move and rotate work with mouse and keyboard |
| 4 | Wire them into a series loop | Junctions unambiguous; a deliberate mistake (unconnected terminal) is flagged specifically |
| 5 | Set the resistor to 220 Ω and the PSU to 5 V / 100 mA, output on | Unit-aware entry; values echoed in the inspector |
| 6 | Run | Results appear without a noticeable wait |
| 7 | Observe | Node voltages, LED current and forward voltage, PSU mode CV, LED shown lit — all derived from the solve |
| 8 | Lower the current limit until the supply enters CC | CC is shown as a **normal supply behaviour**, not an error, with correct values |
| 9 | Stop, close the browser completely, reopen, open the project | Exact restore: components, wires, values, name |
| 10 | Switch the UI to Hebrew | UI mirrors; canvas geometry, identifiers, pin labels and numbers stay LTR; **no project value changes** |
| 11 | Add a classic ESP32 DevKit and wire GPIO2 -> resistor -> LED -> GND, and a push button to a GPIO input with a pull | Reserved and input-only pins are visibly marked and refused where appropriate |
| 12 | Provide firmware (write and build a sketch, or upload a `.bin` — per PM-2) | Content-addressed artifact attached to the project; QIO rejected with a clear reason if uploaded |
| 13 | Run | Explicit session states: creating, loading, booting, running |
| 14 | Watch the firmware drive the circuit | The LED responds to `digitalWrite`; the pin voltage reflects the real driver resistance, not 3.3 V |
| 15 | Press the button in the UI | The firmware reads the new level and reacts; the serial monitor shows its output |
| 16 | Pause and resume | Simulation time freezes and continues; no jump or drift |
| 17 | Stop, change the resistor, run again | The restart is explicit and quick; new results are consistent with the new value |
| 18 | Simulate a network interruption | The run pauses and reattaches within the grace period; after expiry the message is clear. **No project data is lost in either case** |
| 19 | Close and reopen the ESP32 project **while offline** | The project opens and edits normally; only running the MCU is unavailable, and it says so |
| 20 | Re-run the same firmware and circuit twice | The observable behaviour is the same both times (the determinism promise, visible to the user) |

---

## 20. V1 / V1.1 / Future matrix

| Capability | V1 | V1.1 | Future |
|---|---|---|---|
| Schematic editor, wiring, nets, undo/redo | ● | | |
| Breadboard view over the same net model | | ○ | ● |
| Lab PSU (CV/CC, enable, measured V/I) | ● | | |
| Resistor, LED, diode, ground | ● | | |
| Push button, toggle switch | ● | | |
| Potentiometer | | ● | |
| Capacitor / inductor (with transient) | | | ● |
| Transistors, relays, op-amps, 555 | | | ● |
| Sensors (LDR, thermistor, digital sensors) | | | ● |
| DC operating-point simulation (browser-local) | ● | | |
| Transient analysis | | | ● |
| AC analysis | | | ● |
| Probes / inspector measurements (V, I) | ● | | |
| Multimeter instrument incl. resistance mode | | ● | |
| Oscilloscope | | | ● |
| Serial monitor (output) | ● | | |
| Serial input to firmware | | ● | |
| GPIO state on the board symbol | ● | | |
| GPIO timeline / logic-analyser view | | ● | |
| Classic ESP32: digital I/O, direction, pulls, deterministic loop | ● | | |
| GPIO 32-39 as outputs (bridge extension) | | ● | |
| ESP32 ADC | | ● | |
| ESP32 PWM/LEDC, DAC, touch | | | ● |
| ESP32 I2C / SPI with device models | | | ● |
| Wi-Fi / Bluetooth | | | ● |
| `esp_restart()` / WDT / EN reset (after R-MCU-1) | | ● | |
| Deep / light sleep | | | ● |
| Arduino sketch editor + server build | ● (PM-2) | | |
| `.bin` upload | ● | | |
| Multi-file sketches, libraries | | | ● |
| MicroPython authoring | | ○ | ● |
| Local-first projects, autosave, recent, duplicate, delete | ● | | |
| Export / import project file | ● (PM-7) | | |
| Cloud sync, accounts, sharing | | | ● |
| Hebrew + English, N-locale-ready | ● | | |
| Additional languages (German, Spanish…) | | ○ | ● |
| Example projects (6) | ● | | |
| Templates, user-authored templates | | | ● |
| Chromium desktop support | ● | | |
| Firefox support | | ● | |
| Safari support | | | ● |
| Mobile / native apps | | | ● |
| AI circuit generation / troubleshooting | | | ● |

● = planned there · ○ = candidate, not committed

---

## 21. PM decisions required

Each decision below changes product scope, not implementation detail.

### PM-1 — Primary editing paradigm

| Option | Implication | Engineering cost / risk |
|---|---|---|
| **A. Schematic only (recommended)** | Clearest mapping to the data model; fastest to build well; least risk of connectivity bugs | Lowest. One editor |
| B. Breadboard only | Most familiar to makers; weakest for correctness and for larger circuits; effectively re-treads Fritzing | High: footprints, row/rail semantics, geometric connectivity inference, its own validation |
| C. Both | Best long-term; halves the quality we can reach in V1 | Highest: two editors, two interaction models, sync between them |

**Recommendation: A.** Keep the breadboard as a *view* to add later, which the net-based schema
already allows.

### PM-2 — Firmware / code workflow

| Option | Implication | Engineering cost / risk |
|---|---|---|
| A. `.bin` upload only | V1 ships sooner; the headline journey is out of reach for beginners without an external toolchain | Lowest |
| B. Editor + server build only | Best beginner story; no path for firmware we cannot build | Medium-high: sandboxed build service, queue, cache, quotas; compile latency unmeasured |
| **C. Both (recommended)** | Beginners get edit-build-run; advanced users keep upload; QIO problem disappears on the built path | Same as B plus a small amount; upload already exists in the artifact design |

**Recommendation: C**, narrowly scoped: one file, pinned core, no libraries. If the PM prefers to
de-risk V1.0, option A with the editor in V1.1 is coherent — but the product then demos far worse.

### PM-3 — Multimeter

| Option | Implication | Engineering cost / risk |
|---|---|---|
| **A. Probes/inspector only in V1 (recommended)** | Users can read every voltage and current; no instrument metaphor | Low |
| B. DMM with DC V and A | Familiar framing, no new physics | Low-medium (UI work, little engine work) |
| C. DMM with V, A and Ω | Resistance needs a de-energized test-current measurement mode: new semantics, new failure cases | Medium, plus a new measurement concept to validate |

**Recommendation: A for V1, C for V1.1.**

### PM-4 — MicroPython

| Option | Implication | Engineering cost / risk |
|---|---|---|
| **A. Not in V1 (recommended)** | One code story to do well | None |
| B. MicroPython authoring in V1 | Needs a filesystem/REPL product surface; doubles the firmware story | High, and unproven as a product surface |

**Recommendation: A.** Revisit for V1.1 — the runtime already boots MicroPython, so the cost is
product design, not feasibility.

### PM-5 — Browser support scope

| Option | Implication | Engineering cost / risk |
|---|---|---|
| **A. Chromium-family only at V1 (recommended)** | Honest: it is the only family ever tested | Low |
| B. Chromium + Firefox | Broader reach; must build and maintain a second test lane before promising it | Medium; unknown until the suites actually run there |
| C. Chromium + Firefox + Safari | Broadest; Safari's IndexedDB/Worker differences are a real risk on a constrained dev host | High |

**Recommendation: A**, with Firefox as the first V1.1 expansion once its test lane is green.

### PM-6 — Minimum credible catalog

| Option | Implication | Engineering cost / risk |
|---|---|---|
| A. PSU, ground, resistor, LED, ESP32 | Smallest; cannot demo "circuit drives firmware" naturally | Lowest |
| **B. A + diode + push button + toggle switch (recommended)** | Enables the full closed-loop story and basic teaching circuits | Small: one new switch device, one diode card |
| C. B + potentiometer + capacitor | Looks richer; capacitor is misleading without transient, and the potentiometer's real use needs ADC | Medium, and it weakens the physics claim |

**Recommendation: B.**

### PM-7 — Project export / import

| Option | Implication | Engineering cost / risk |
|---|---|---|
| **A. Include in V1 (recommended)** | A teacher can hand out a complete runnable project without accounts or cloud; also the user's own backup path in a local-first product | Low-medium: one serialization format, size limits, validation on import |
| B. Defer to V1.1 | Users have no way to move a project between machines, which is a real gap in a local-first product with no sync | Lower now, more support pain later |

**Recommendation: A**, single file, optional embedded firmware image, validated on import.

### PM-8 — Is V1 publicly available, or a controlled pilot?

This is a scope question, not an implementation one. **PM decision P6 makes authentication,
authorization and resource limiting mandatory before the simulation service is publicly exposed.**

| Option | Implication | Engineering cost / risk |
|---|---|---|
| A. Public V1 | Requires identity, authorization, per-user limits and abuse handling **inside V1 scope**, plus the production capacity gate (P2) | Significant, and currently unplanned in any sprint |
| **B. Controlled pilot (recommended)** | Instructors/classes onboarded with issued access; the same limits still apply but the surface is bounded | Moderate: still needs authorization and limits, but not a public-scale abuse posture |
| C. Local/offline-only V1 (no MCU) | Removes the server entirely — and with it the product's headline capability | Low cost, high product loss |

**Recommendation: B**, and the answer determines whether "accounts" enter V1 at all.

---

## 22. Risks to product scope

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| S1 | **Scope leak through "just one more component"** (capacitor, transistor, sensor) | Physics claims weaken; V1 slips | Every component must state its model status here first; the matrix (§20) is the gate |
| S2 | **Users expect waveforms** because the product looks like a lab | Disappointment, or pressure to fake a scope | State DC-only prominently in the product, not only in documents; ship the scope in a transient release |
| S3 | **Build service cost and latency** (if PM-2 = B/C) | Poor first-run experience; hosting cost | Measure compile latency early; cache by source hash; show progress; capacity gate (P2) |
| S4 | **The ESP32 journey needs the network**, and users will meet it offline | Perceived as broken | Explicit offline behaviour (§11); editing never blocked; message distinguishes offline from unavailable |
| S5 | **Unsupported-peripheral detection is best-effort** | A user writes `analogRead()` and believes the result | Pin-level static marking in the editor, runtime notice where detectable, and honest documentation |
| S6 | **Hebrew is treated as a translation pass at the end** | RTL defects, layout breakage, late rework | Both languages are acceptance criteria (§19) from the first UI sprint; no English-only screens |
| S7 | **Classroom visual quality judged too late** | Redesign after implementation | Projector legibility is an acceptance property, reviewed on a real projector before V1 |
| S8 | **No reset control** may read as a missing feature | Users try to restart firmware | Stop/Run is the documented restart path; the limitation is stated plainly (P10) |
| S9 | **Example projects become the de-facto test suite** and rot | Broken demos | Each example is an acceptance scenario with an owner and runs in CI |
| S10 | **Determinism promise is user-visible** and must survive every new feature | A regression breaks a stated product property | The pinned release-gate fingerprints already fail the build on drift |

---

## 23. Definition of Done — product scope phase

This phase is complete when:

1. **Every capability in V1 is traceable** to proven evidence or to explicitly accepted new work
   (done: §4-§9 cite Sprint 0/1 evidence).
2. **Every exclusion has a stated reason**, not merely an omission (done: §5, §18).
3. **The component catalog is closed** for V1, with model status per component (done: §6).
4. **The ESP32 promise is exact**, pin-level, with user-visible diagnostics defined (done: §7).
5. **One firmware workflow is chosen** (pending PM-2).
6. **The acceptance journey is agreed** and is the definition of "V1 exists" (done: §19, pending
   PM sign-off).
7. **The V1/V1.1/Future matrix is agreed** so later features have a home (done: §20).
8. **The PM decisions in §21 are answered.**
9. **No item in this document contradicts Sprint 0 or Sprint 1 evidence** (checked; see the
   conflicts noted in §24).
10. After sign-off, this document becomes the authoritative product scope, and the implementation
    roadmap is written from it — **not before**.

---

## 24. Conflicts and tensions found against Sprint 0 / Sprint 1

None of these invalidate earlier work; each is a place where a plausible product expectation meets
proven evidence.

| # | Tension | Resolution taken here |
|---|---|---|
| 1 | A **capacitor** is a natural "basic component" expectation, but the engine is DC-only | Excluded from V1 with the reason stated (§6.2). Including it would violate the physics rule |
| 2 | A **multimeter with resistance** is a natural lab expectation, but Ω is not a solve of the live circuit | Probes in V1; Ω with the DMM in V1.1 (§9.3, PM-3) |
| 3 | **GPIO 32-39 outputs** are not evented by the bridge (blocker B6) | Those pins are marked input-only in V1; the bridge extension is a V1.1 item |
| 4 | **Reset** is an obvious simulation control, but full-chip reset is not deterministic yet (P10) | No reset control in V1; Stop/Run is the restart path |
| 5 | **MicroPython** technically boots, which invites "so it is supported" | Explicitly not supported as an authoring workflow (§8.3, PM-4) |
| 6 | **Oscilloscope** is expected in anything called a lab | Excluded; requires transient analysis (§9.4) |
| 7 | **P6** requires auth/limits before public exposure, but no sprint owns that work | Raised as PM-8: it decides whether V1 is public or a controlled pilot |
| 8 | Sprint 0 recorded **looser pre-registered tolerances** than the code asserts | No product impact; noted so that future claims quote the asserted values |
| 9 | Sprint 0 harnesses attach the firmware image **writable** (errata E-2) | Product requirement already in the architecture: each session boots from a verified copy |
