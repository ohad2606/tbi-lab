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

V1 implementation, Sprint 2: the first product surface. It includes the application shell,
schematic editing (lab PSU, ground, resistor, wiring), local projects in IndexedDB, and English and
Hebrew. **There is no simulation yet**; the electrical engine is integrated in Sprint 3.

## Repository layout

| Path | Contents |
|---|---|
| `app/` | The browser application (Preact + Vite) |
| `packages/domain/` | Project schema v2, catalog, validation, migrations, editing operations. Pure data |
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

