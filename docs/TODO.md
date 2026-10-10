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
