# TBI Lab — Product TODO

This document records approved product-development items that are not necessarily part of the active sprint.

Items in this file are approved product direction, not automatic authorization to expand the active sprint. Implementation must still be scheduled by the PM.

---

## X-Ray Electrical Visualization

**Status:** Approved / Backlog  
**Priority:** High product-value feature; schedule after the core simulation and workbench foundations are stable.

### Goal

Provide a professional engineering visualization layer that makes otherwise invisible electrical behavior understandable without inventing or distorting physics.

X-Ray is not a decorative animation system.

Every displayed direction, magnitude, state, warning, pulse, highlight or measurement must be derived from deterministic simulation state.

### Core rule

**Simulation truth drives visualization. Visualization never invents simulation truth.**

If current is zero, no current-flow animation may imply otherwise.

If direction changes, the displayed direction must change accordingly.

If a value is unknown or unsupported, the UI must show that explicitly rather than fabricate an approximation.

### Current-flow visualization

Support visualization of conventional current direction by default.

Planned representation may include:

- small directional arrows along conductors and relevant current paths;
- motion or pulse rate derived from actual current/activity;
- optional current magnitude overlays;
- optional voltage overlays;
- selected-path highlighting;
- component activity derived from simulated electrical state;
- clear no-flow/open-circuit behavior;
- current-limit and fault-state indication where applicable.

Avoid meaningless particle effects or arbitrary animation speed that falsely implies a physical quantity.

If animation speed or density is mapped to current magnitude, the mapping must be documented and intentionally designed as a visualization scale rather than presented as literal electron velocity.

### Conventional-current convention

Default engineering direction:

**Conventional current: higher potential toward lower potential as resolved by the simulation.**

Electron-flow visualization may be considered later only as an explicit alternate educational/advanced view. It is not required now.

### View integration

X-Ray should eventually work across all three TBI Lab views, with different presentation density:

#### Workbench View

Primary engineering/debugging implementation.

Possible information:
- current direction;
- current magnitude;
- node voltage;
- component voltage drop;
- component power;
- active/inactive state;
- selected current path;
- warnings and limits.

#### 3D View

Use the same simulation truth with a stronger spatial presentation.

Possible information:
- 360-degree flow visualization;
- directional arrows along real wire paths;
- component-state highlighting;
- voltage/current callouts.

3D remains a visualization view, not the primary circuit editor.

#### Schematic View

Keep the presentation restrained and engineering-oriented.

Possible information:
- net/path highlight;
- directional current arrows;
- current labels;
- voltage labels;
- selected branch/path tracing.

### X-Ray display levels

Consider user-selectable visualization density:

1. **Off** — clean circuit view.
2. **Subtle** — minimal activity highlighting.
3. **Direction** — directional current arrows and selected path information.
4. **Detailed** — engineering overlays such as current, voltage, power and relevant warnings.

Exact UX is to be designed later.

### Trace / diagnostic use

Future X-Ray capabilities may include:

- Trace Current Path;
- highlight where a current path is interrupted;
- show why a branch is inactive;
- highlight open switch / missing ground / broken connection;
- correlate AI troubleshooting explanations with highlighted physical paths;
- “Why?” actions tied to real simulation values.

The AI must consume canonical circuit/simulation data and may request X-Ray highlights, but it must never generate electrical values independently.

---

## PWM Visualization

**Status:** Approved / Backlog  
**Dependency:** Requires real PWM-capable MCU/simulation integration and timing/transient support sufficient to represent the signal correctly.

### Goal

Represent PWM behavior accurately and intelligibly rather than reducing it to a static ON/OFF state.

Potential information:

- PWM frequency;
- duty cycle;
- instantaneous digital state where relevant;
- average/effective effect only when physically meaningful for the modeled load;
- waveform relationship to the connected circuit;
- synchronized visualization in X-Ray and measurement tools.

Example engineering label:

`PWM — 1 kHz — 35% duty`

### Visualization rule

PWM animation must be driven by actual simulated signal timing or a validated representation of it.

Do not invent visual pulses merely to suggest that PWM exists.

When the simulation engine cannot resolve a behavior at the required time scale, show the limitation explicitly.

### Relationship to instruments

PWM visualization should eventually integrate with:

- oscilloscope;
- logic analyzer;
- GPIO inspector;
- X-Ray flow visualization.

The oscilloscope/logic analyzer remains the authoritative time-domain representation where implemented.

---

## Engineering Quality Rules for Visualization

These rules are non-negotiable:

1. TBI Lab is an engineering simulator, not an animation product.
2. No visual effect may contradict the electrical solver.
3. No current, voltage, power, timing or direction may be invented for visual appeal.
4. Unsupported physics must be marked unsupported.
5. Numerical overlays must come from canonical simulation results.
6. Visualization scales and abstractions must be documented.
7. Direction must be derived from signed simulated quantities.
8. Component behavior must use the same device models as the solver.
9. X-Ray must remain useful on larger circuits and avoid visual overload.
10. Professional clarity takes priority over cinematic effects.

---

## Related approved product direction

TBI Lab ultimately has three synchronized representations of one canonical Circuit Model:

- **Workbench View** — authoritative editing and engineering workspace.
- **3D View** — 360-degree physical visualization; not a full 3D circuit editor.
- **Schematic View** — professional schematic representation, initially primarily derived from the canonical model.

All views, X-Ray overlays, instruments, AI explanations and measurements must refer to the same electrical truth.


---

## MCU Pin Capability & Connection Validation

**Status:** Approved / Required Product Capability  
**Priority:** High. This is part of professional simulator correctness and must be considered before broad MCU/component expansion.

### Goal

TBI Lab must understand the electrical and functional capabilities of every MCU/board pin and warn the user when a connection is invalid, unsafe, unavailable, reserved, unsupported, or technically possible but not recommended.

This is not a cosmetic pinout overlay. It is a validation layer tied to the exact selected controller/board model.

### Core principle

**A pin is not just a GPIO number.**

Validation must consider the exact:
- MCU family and variant;
- module/package;
- development board;
- board routing;
- flash/PSRAM reservations;
- power pins and voltage domains;
- strapping/boot pins;
- USB/JTAG/debug use;
- input/output capability;
- ADC/DAC capability where relevant;
- hardware peripheral routing;
- current/voltage limits;
- protocol-specific constraints;
- board-default or recommended pins.

The simulator must never assume that pin capability is identical across different ESP32 variants or different boards built around the same SoC.

### Important ESP32 design rule

ESP32-family peripherals may support flexible GPIO routing, so TBI Lab must not reduce validation to a simplistic list of fixed I2C/SPI/UART pins.

For each supported board, distinguish:

1. **Required / fixed**
   - Function cannot work on arbitrary GPIO because of silicon, package or board-level constraints.

2. **Unavailable / reserved**
   - Pin is consumed by flash, PSRAM, USB, board hardware, or another fixed function.

3. **Valid**
   - Pin supports the requested function correctly.

4. **Valid but conflict-prone / conditional**
   - Pin works only if another feature is disabled or avoided.

5. **Valid but not recommended**
   - Technically usable, but may conflict with boot behavior, debugging, board defaults or common peripheral use.

6. **Recommended / default**
   - Board/vendor/common-library default pins for the requested function.

### Validation severity

Use at least three user-facing severity levels:

#### Error
The requested connection cannot work correctly or violates a hard constraint.

Examples:
- output connected to an input-only pin;
- peripheral assigned to a pin that the selected board does not expose;
- use of a pin reserved by onboard flash/PSRAM;
- voltage outside a pin's supported electrical range.

#### Warning
The connection may work but has a meaningful engineering risk or side effect.

Examples:
- boot/strapping pin usage;
- conflict with USB/JTAG/debug functionality;
- shared peripheral/resource conflict;
- board-specific caveat.

#### Recommendation
The connection is valid, but another pin assignment is preferred.

Examples:
- preferred/default I2C pins;
- pins commonly used by board libraries/examples;
- cleaner routing or fewer conflicts.

Warnings and recommendations must never be presented as hard errors unless the actual device/board documentation makes them hard constraints.

### Pin Inspector

Selecting an MCU pin should eventually show structured information such as:

- GPIO number;
- physical board pin;
- current mode/direction;
- supported functions;
- digital input/output capability;
- ADC/DAC/PWM capability where applicable;
- supported peripheral routing;
- electrical voltage domain;
- current limitations where modeled;
- boot/strapping role;
- reserved/shared functions;
- currently assigned function;
- active conflicts;
- recommended use.

### Connection-time feedback

When the user begins or completes a connection, TBI Lab should be able to provide immediate validation.

Examples:

- **Cannot connect:** GPIO X is not output-capable on this controller.
- **Conflict:** This pin is currently used by USB/JTAG.
- **Warning:** This is a boot-strapping pin; the attached circuit may affect startup.
- **Recommendation:** I2C can be routed here, but this board's default SDA/SCL pins are X/Y.
- **Electrical error:** The connected signal is 5 V while this MCU pin is limited to 3.3 V logic.

### Protocol-aware validation

Validation must understand the intended function, not only the wire.

For protocols such as:
- I2C;
- SPI;
- UART;
- PWM;
- ADC;
- interrupts;
- future buses/peripherals,

the system must evaluate:
- whether the pin supports the role;
- whether the peripheral can be routed there;
- whether pins conflict with each other or board resources;
- whether required electrical support exists, such as pull-ups for I2C;
- whether the selected board/library has preferred/default assignments.

### Electrical + functional validation

Pin validation must combine two layers:

1. **Functional capability**
   - Can this pin perform the requested MCU/peripheral function?

2. **Electrical compatibility**
   - Is the connected voltage/current/loading safe and valid?

A connection may be functionally valid but electrically unsafe, or electrically safe but functionally invalid. TBI Lab must distinguish these cases.

### Firmware correlation

When firmware is available, TBI Lab should eventually compare code configuration against physical wiring.

Examples:
- firmware initializes I2C on GPIO 8/9 while the display is wired to GPIO 4/5;
- code configures GPIO as input while the circuit expects it to drive a transistor;
- ADC code targets a pin without ADC capability;
- two firmware peripherals attempt to claim conflicting resources.

This should feed the AI Engineer and diagnostics layer.

### AI behavior

The AI Engineer must use the same canonical pin-capability data as the simulator.

It must not invent pin assignments from memory.

When suggesting or generating a circuit, the AI must:
- select compatible pins;
- prefer recommended pins when appropriate;
- explain meaningful caveats;
- validate the proposed mapping before presenting it as correct.

### Data source quality

Pin capability information must come from authoritative technical sources such as:
- MCU datasheets;
- technical reference manuals;
- official board schematics;
- official pinout documentation;
- vendor SDK/peripheral documentation.

Do not encode unverified community pinout assumptions as engineering truth.

Board/MCU definitions should be versioned so corrections can be made without silently changing historical project meaning.

### Scope discipline

Do not build a universal MCU database immediately.

Start with the exact V1 controller/board and make the data model extensible.

Additional ESP32 variants, Arduino boards and other controllers are added only when they enter the approved product scope.



---

## IoT & Robotics — System-Level Project Simulation

**Status:** Approved Product Direction / Backlog  
**Priority:** Strategic expansion after the electrical/MCU core is stable.  
**Scope rule:** Build on the same canonical circuit, firmware and simulation truth. Do not create a separate fake “robotics simulator” that bypasses electrical correctness.

### Product vision

TBI Lab should eventually support complete embedded-system projects, not only isolated circuits.

Target experience:

**Build → Wire → Code → Simulate/Test**

Examples include:
- robot car;
- line follower;
- sonar/radar demonstrator;
- robot arm;
- sumo robot;
- weather station;
- soil-moisture / irrigation system;
- rain detector;
- occupancy / presence system;
- environmental monitoring;
- macro pad / control panel;
- other IoT and maker projects.

### Layered architecture

This direction must be implemented in layers.

#### Layer 1 — Electrical / firmware truth

Authoritative existing core:
- controller;
- wiring;
- power;
- GPIO;
- buses;
- sensors;
- actuators;
- firmware;
- electrical limits and failures.

No higher-level IoT/robotics visualization may contradict this layer.

#### Layer 2 — Virtual environment inputs

Allow supported sensors to receive physically meaningful environment inputs.

Examples:
- temperature;
- humidity;
- light level;
- distance;
- soil moisture;
- rain/wet state;
- presence/motion;
- orientation/position where supported.

Inputs must use documented sensor models and supported ranges.

Do not invent measurements merely to animate a project.

#### Layer 3 — Actuator behavior

Translate validated electrical/firmware outputs into modeled actuator behavior.

Examples:
- servo angle;
- DC motor speed/direction;
- relay state;
- LED/light output;
- buzzer state;
- stepper motion later.

The actuator result must be derived from the electrical and firmware state.

#### Layer 4 — Robotics / physical scene

Later, support projects whose behavior depends on physical motion or geometry.

Examples:
- robot car test drive;
- line-following track;
- ultrasonic obstacle detection;
- sonar sweep;
- robot arm motion;
- sumo arena.

This requires a real scene/kinematics/physics model and must not be approximated as a decorative animation.

### Important distinction: IoT vs Robotics

IoT support can expand earlier because many projects require only:
- realistic sensor inputs;
- network/protocol behavior;
- firmware;
- actuator outputs;
- dashboards or state visualization.

Robotics is significantly harder because it adds:
- geometry;
- kinematics;
- motion;
- collision;
- wheel/ground interaction;
- sensor field-of-view;
- timing;
- potentially rigid-body physics.

Therefore IoT environment simulation should precede full robotics scene simulation unless a narrow robotics vertical slice is explicitly approved.

### Project templates

TBI Lab should eventually offer complete project templates.

A template may include:
- canonical circuit;
- controller definition;
- firmware starter code;
- virtual environment;
- test scenarios;
- measurement points;
- expected/validated behavior.

Templates are not canned animations. They are real TBI Lab projects using the same simulation engines as user-created projects.

### Test / Drive / Simulate modes

System-level projects may expose a context-specific test mode.

Examples:
- **Test Drive** for a robot car;
- **Simulate Environment** for a weather station;
- **Run Track** for a line follower;
- **Sweep** for a sonar project;
- **Exercise Arm** for a robot arm.

These modes must remain views/controllers over the canonical model, not separate sources of truth.

### IoT networking

Future IoT support may include:
- Wi-Fi/network state;
- HTTP/MQTT;
- local services/endpoints;
- cloud integrations only when explicitly approved.

Do not introduce production cloud dependencies merely to demonstrate IoT.

Network simulation must distinguish between:
- simulated local network behavior;
- real external network access;
- unsupported behavior.

### AI integration

The AI Engineer may eventually:
- propose complete IoT/robotics projects;
- select compatible sensors/actuators;
- generate validated wiring;
- generate firmware;
- diagnose electrical vs firmware vs environment problems;
- create test scenarios.

AI-generated projects must pass the same electrical, pin-capability and simulation validation as manually built projects.

### Professional quality rule

The goal is not to make a visually impressive robot animation.

The goal is to let a user answer engineering questions such as:
- Is the motor driver wired correctly?
- Does the power supply support stall current?
- Are the GPIO assignments valid?
- Does the ultrasonic sensor detect the obstacle at this geometry?
- Does the line sensor see the track?
- Is the servo commanded beyond its modeled range?
- Does the firmware react correctly to sensor timing?
- Does the IoT node behave correctly when a sensor value changes?

If TBI Lab cannot model a requested physical behavior reliably, it must label it unsupported rather than fake it.

### Phasing

Recommended order:

1. Sensor environment controls for IoT projects.
2. Actuator-state visualization.
3. Complete IoT project templates.
4. Narrow robotics vertical slices with validated kinematics/geometry.
5. Broader robotics scene/physics support only if justified by product demand.



---

## Guided Learning & Circuit Advisor

**Status:** Approved Product Direction / Backlog  
**Priority:** High user-value feature after core circuit analysis is trustworthy.  
**Audience:** Beginners, students, makers and any user who wants the simulator to explain correct engineering choices rather than merely report whether a circuit runs.

### Goal

TBI Lab should include a learning/advisory area that can analyze:
- a natural-language question;
- an incomplete circuit;
- an unsafe circuit;
- a working-but-suboptimal circuit;

and explain the correct ways to implement the intended function.

Unlike the educational TBI product, this advisor may provide direct solutions, calculations and recommended circuit changes.

### Core rule

Advice must be grounded in:
- actual selected component models;
- the electrical solver;
- authoritative ratings;
- the controller/pin capability model;
- documented engineering practice.

The AI must not invent a solution from memory and present it as electrically verified.

### Example: LED from a bench supply

If a user connects a bench supply directly to an LED or asks how to power an LED, TBI Lab should explain that an LED requires current limiting.

It must NOT teach that setting the source equal to the LED's nominal forward voltage is a generally safe substitute for current limiting.

LED forward voltage varies with current, temperature, part variation and device model.

Preferred solutions:
1. series resistor sized for the target current; or
2. a suitable constant-current driver/source.

For a 5 V source and an LED whose modeled forward voltage is approximately 3.0 V at the chosen operating current, a 10 mA design target gives:

`R = (5 V - 3 V) / 0.01 A = 200 Ω`

The product may recommend the next suitable standard value such as 220 Ω after validating the resulting current against the actual LED model and rating.

The exact recommendation must be calculated from the selected LED model and target operating current, not hard-coded.

### Advisor output

A useful answer should be able to include:
- what is wrong or risky;
- why it is wrong;
- one or more valid solutions;
- calculated component values;
- expected voltage/current/power after the fix;
- component rating margins;
- trade-offs between alternatives;
- optional direct application of the fix after user approval.

### Solution classes

The advisor may propose multiple valid engineering approaches when appropriate.

Examples:
- resistor vs constant-current driver for an LED;
- transistor vs MOSFET vs relay depending on isolation/load requirements;
- voltage divider vs level shifter vs optocoupler depending on signal requirements;
- pull-up/pull-down selection;
- flyback protection for inductive loads;
- decoupling/filtering where required;
- appropriate power-supply voltage/current limits.

The advisor should distinguish:
- simplest valid solution;
- recommended robust solution;
- alternate valid solutions.

### Learning behavior

The learning area should explain the engineering reasoning, not only state the answer.

When relevant it should show:
- formulas;
- substituted values;
- expected simulation result;
- why another approach is unsafe or less robust.

The user should be able to move from explanation to the actual circuit and see the same numbers in X-Ray, instruments and the solver.

### Apply / compare

Future interaction may include:
- **Explain only**
- **Show recommended fix**
- **Apply fix**
- **Compare alternatives**

Any applied fix must be validated through the same simulation and pin/electrical validation layers as a manually built circuit.

### Scope discipline

Do not build a separate educational simulator.

This feature is an advisory layer over the same professional TBI Lab project, solver, component models and AI Engineer.

The product must remain useful to experienced users while making correct engineering decisions accessible to beginners.
