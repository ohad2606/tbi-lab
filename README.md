# TBI Lab

TBI Lab is a desktop-first browser-based electronics and embedded systems simulation environment.

Primary focus:

- makers and DIY electronics
- students and technicians
- ESP32-based development
- realistic electrical simulation
- laboratory-style tools
- AI-assisted circuit design and troubleshooting

## Status

V1 Product Alpha (Sprint 5): the complete non-MCU laboratory. Start from one of six curated
examples or a new project, then build circuits from a lab PSU, ground, resistors, LEDs, a 1N4148
diode, a push button and a toggle switch. Press Run to see DC operating-point values solved by
the production engine in a browser Web Worker, then probe voltages and currents and interact with
switches while the circuit runs. Projects are saved automatically in this browser. A local project
library supports rename, duplicate and delete, and portable `.tbilab` files support export and
import (format: `packages/domain/PACKAGE.md`). The UI runs in English and Hebrew.

## Repository layout

| Path | Contents |
|---|---|
| `app/` | The browser application (Preact + Vite) |
| `packages/domain/` | Project schema v2, catalog, validation, migrations, editing operations, snapshots. Pure data |
| `packages/engine/` | The one electrical engine (promoted from Gate A): DC solver, device models (LED, 1N4148, switches), compile-from-snapshot |
| `experiments/` | Frozen Sprint 0/1 feasibility evidence. Never imported by production code |
| `docs/` | Product scope, architecture, ADRs, roadmap, sprint records |

## Development

Requires Node.js 24.

```sh
npm install
npm run dev          # app at http://localhost:5173
npm run typecheck
npm run lint         # ESLint + Prettier + experiments/ import boundary
npm test             # fast unit suites (experiments + domain + app)
npm run test:e2e     # browser acceptance suite (Chromium; builds the app)
```

The real-ESP32 suite (`npm run test:esp32`) needs the locally provisioned emulator toolchain and is
not part of routine CI.

