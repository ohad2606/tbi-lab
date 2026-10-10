# TBI Lab — Project Instructions

## Product

TBI Lab is a standalone desktop-first web application for electronics and embedded-system simulation.

Primary users:
- Makers
- DIY electronics users
- Students
- Technicians
- Embedded developers at beginner/intermediate levels
- Teachers and instructors

It is not intended to replace high-end professional PCB/CAD engineering suites.

The product should feel professional, powerful, fast and simple to use.

---

## Project Authority

The PM defines:
- product scope
- priorities
- architecture direction
- sprint boundaries
- feature acceptance

Do not expand scope without explicit PM approval.

If an attractive feature is outside the current sprint, report it as a future possibility instead of implementing it.

---

## Non-Negotiable Rule: Physics Must Be Real

TBI Lab must NEVER invent electrical or physical behavior.

Voltages, currents, component behavior, timing and MCU/electrical interactions must come from deterministic and technically valid models.

Never fake a result merely to make a simulation appear to work.

If something cannot be modeled reliably:
- mark it unsupported,
- document the limitation,
- or stop and request a decision.

The AI layer must never be treated as the source of electrical truth.

The simulation engine is the source of truth.

---

## Current V1 Direction

V1 starts with:

- ESP32 Classic / common ESP32 DevKit
- DC electronics only
- breadboard-style electronic circuits
- real voltage/current behavior
- laboratory DC power supply
- local electrical simulation where technically possible
- local-first project persistence
- desktop browser usage
- keyboard and mouse as first-class input methods
- first-class English and Hebrew product support

Later capabilities may include:
- Arduino C/C++
- MicroPython
- sensors
- relays
- transistors
- 555 timers
- multimeter
- oscilloscope
- logic analyzer
- AI circuit generation
- AI troubleshooting
- X-Ray electrical visualization driven strictly by simulation truth
- PWM visualization driven by real simulated timing/state
- synchronized Workbench / 3D / Schematic representations of one canonical circuit model
- additional product languages such as German, Spanish and others

Do not implement later capabilities unless they are part of the active sprint.

---

## Internationalization and Localization — Architectural Requirement

TBI Lab is not a bilingual product architecture.

It is a multilingual product architecture that launches first in English and Hebrew and must be capable of supporting an arbitrary number of additional languages later.

Launch languages:
- English (`en`)
- Hebrew (`he`)

Expected future language candidates include German, Spanish and other languages, but they must not be implemented before they are explicitly prioritized.

### Core principle

One project. Any supported language. Same electrical truth.

A project created while the UI is in Hebrew must be able to open later in English, German, Spanish or another supported locale without conversion of the electrical project and without any change to simulation behavior.

Language and locale must never affect:
- circuit topology
- component identity
- electrical values
- simulation results
- firmware
- net relationships
- project correctness

### Language-neutral project data

Persistent project data must use canonical, language-neutral identifiers.

Do not store localized display strings as domain identifiers.

Good conceptual example:

```json
{
  "type": "component.resistor",
  "id": "R1",
  "value": 1000,
  "unit": "ohm"
}
```

The localization layer may render that same component as:
- English: `Resistor`
- Hebrew: `נגד`
- German: `Widerstand`
- Spanish: `Resistencia`

The canonical project object remains unchanged.

### No hard-coded bilingual assumptions

Do not architect the product around `English vs Hebrew` logic.

Avoid application concepts such as:
- `isHebrew`
- `if language === he then ...` as a general architecture pattern
- duplicated English/Hebrew business objects

Prefer general concepts such as:
- `locale`
- `direction`
- translation keys
- locale-aware formatting
- terminology dictionaries

The architecture must support `N` locales rather than exactly two.

### Localized system text vs user-authored text

System-owned text must be localizable through translation keys.

Examples:
- buttons
- menus
- validation messages
- simulation warnings
- instrument labels
- component display names
- system-generated explanations
- error messages

User-authored content must not be silently translated or modified when the UI language changes.

Examples:
- project names
- user notes
- custom net names
- labels written by the user
- comments in firmware

Future explicit AI features may translate user-authored project notes or presentations, but this must be an intentional user action, not an implicit side effect of changing locale.

### RTL and LTR

Hebrew requires first-class RTL support.

However, RTL must not mirror or corrupt technical content that is naturally directional or language-neutral.

The following should remain LTR or use an appropriate direction-independent technical presentation even when the application UI is Hebrew:
- circuit canvas coordinates and topology
- firmware/code editor
- serial monitor content
- formulas
- component identifiers such as `R1`, `Q2`, `C3`
- GPIO labels
- voltage/current values
- units
- net identifiers
- oscilloscope axes and waveforms
- UART / SPI / I2C technical labels

Changing locale must never rearrange the electrical circuit itself.

### Code editor direction

Firmware source code is always LTR.

Do not allow RTL layout rules to alter code presentation.

### Search and discovery

Component search must eventually support localized names, technical English names and useful aliases.

Conceptually, components should be able to expose metadata such as:

```text
displayName.<locale>
keywords.<locale>[]
aliases[]
```

Examples of searches that should ultimately resolve to the same component:
- `resistor`
- `נגד`
- `10k`

or:
- `relay`
- `ריליי`
- `ממסר`

Do not implement the complete multilingual search system unless it is in the active sprint, but do not design component metadata in a way that prevents it.

### Professional terminology

TBI Lab should maintain a controlled technical terminology glossary per locale.

The goal is consistency across:
- UI
- AI Engineer
- documentation
- warnings
- presentations
- component descriptions

Do not invent awkward localized terminology when the accepted professional term is commonly used in English inside another language.

Technical terms such as `GPIO`, `PWM`, `MOSFET`, `Pull-up` or `Flyback` may remain in English when that is the clearest and most natural professional usage for the target locale.

### AI language behavior

The AI Engineer must be able to communicate naturally in the user's selected language while reasoning over canonical, language-neutral project state.

The AI must not depend on translated component names to identify circuit entities.

It should reason over stable identifiers, netlist data, firmware state and simulation measurements, then render explanations in the requested locale.

Changing AI response language must not change the electrical conclusion.

### Locale-aware formatting

Simulation and project data must be stored canonically.

Locale may affect presentation of:
- decimal formatting
- thousands separators
- dates/times
- textual units where appropriate

Locale must not alter numerical values or physical units in the underlying project state.

### UI layout resilience

Do not design UI controls around English string lengths.

Layouts must tolerate languages whose translations are significantly longer than English, including German.

Avoid brittle fixed-width controls that only fit the English label.

### Project URLs and identity

Project identity must be language-neutral.

Do not encode the project language into the project identifier or require different copies of the same project for different locales.

The same project must be able to open under any supported locale.

### Scope discipline for localization

The architecture must be localization-ready from the beginning.

This does NOT authorize implementation of all future translations now.

Current priority:
- make domain models language-neutral
- avoid hard-coded UI strings in product code when UI implementation begins
- support general locale/direction concepts
- ensure RTL-readiness

Future language translation work belongs to later approved sprints.

---

## Explicitly Out of Scope for Now

Do NOT implement unless explicitly approved:

- PCB design
- Gerber
- PCB routing
- 3D PCB
- AC simulation
- mobile UI
- FPGA
- Raspberry Pi / Linux SBC simulation
- realtime collaboration
- multiplayer
- CRDT
- classroom management
- billing
- production cloud infrastructure
- large component libraries
- additional language translation packs beyond the active approved locales
- visual polish unrelated to the active technical goal

---

## MCU Rule

The V1 MCU target is the original/classic ESP32 used by common ESP32 DevKit boards.

Do NOT silently substitute:
- ESP32-C3
- ESP32-S3
- ESP32-C6
- or another MCU

If ESP32 Classic presents a technical blocker, document the blocker and stop for a PM decision.

---

## Architecture Principles

Preferred architecture:

Browser / local:
- interactive simulation
- circuit state
- electrical calculations
- workspace interaction
- local autosave
- MCU execution where feasible

Cloud:
- accounts
- synchronization
- project backup
- AI services
- future billing
- services that cannot reasonably execute locally

The simulation UI must not depend on network round trips for normal interaction.

---

## Local-First Persistence

Project changes should eventually follow:

local write
→ immediate continuation of user work
→ background cloud synchronization

Network latency must not block circuit editing or simulation.

Do not implement cloud synchronization until explicitly requested.

---

## Performance

Heavy computation must not block the browser UI thread.

Prefer:
- Web Workers
- WASM
- clean simulation boundaries

when technically justified.

Do not add complexity merely because a technology is fashionable.

---

## Development Environment

Current development host:

- Ubuntu Linux
- ARM64 / aarch64
- 4 GB RAM
- 8 GB swap
- Node.js 24 LTS
- Python 3.14 system installation

The host is intentionally resource-constrained to reduce project cost.

Do not assume unlimited CPU or memory.

Do not replace or modify system Python unnecessarily.

Use isolated environments when a toolchain requires a specific Python version.

---

## Cost Discipline

TBI Lab currently operates under a strict cost-minimization requirement.

Prefer free/local/open-source solutions when technically sound.

Do not introduce:
- paid infrastructure
- unnecessary cloud services
- high compute requirements
- persistent background services

without explicit approval.

A paid solution may be recommended if technically justified, but must not be adopted silently.

---

## Engineering Discipline

For every task:

1. Understand the active sprint.
2. Inspect the existing code before making changes.
3. Keep scope narrow.
4. Prefer simple, testable architecture.
5. Add automated tests for deterministic behavior.
6. Run relevant tests before reporting completion.
7. Document meaningful technical decisions.
8. Report blockers honestly.
9. Never hide failed experiments.
10. Never fabricate successful results.

---

## Git Safety

Do not:
- force-push
- rewrite shared history
- delete branches
- delete significant files
- change repository remotes
- expose credentials or secrets

without explicit approval.

Never commit:
- API keys
- tokens
- private SSH keys
- credentials
- secrets

---

## Sprint Rule

Only implement work explicitly included in the current sprint.

Interesting ideas discovered during development should be listed under:

Future / Backlog

They must not be implemented automatically.

---

## Definition of Technical Success

A feature is not complete because it looks correct.

For simulation features, correctness must be verified numerically and with reproducible tests.

For unsupported behavior, explicit failure is preferable to incorrect simulation.
