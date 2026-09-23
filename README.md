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

V1 implementation, Sprint 4: the complete non-MCU laboratory core. Draw circuits with a lab PSU,
ground, resistors, LEDs, a 1N4148 diode, a push button and a toggle switch, press Run, and see
DC operating-point values solved by the production engine in a browser Web Worker. Press the
button or flip the switch while running and the circuit re-solves. Probes read node voltages and
branch currents, the PSU panel shows measured V/I and OFF/CV/CC, undo/redo covers project edits,
and circuit checks flag partial wiring, floating parts and ambiguous drawings. Local projects live
in IndexedDB; the UI runs in English and Hebrew.

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

