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

Do not implement later capabilities unless they are part of the active sprint.

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

