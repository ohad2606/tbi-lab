# TBI Lab — V1 Architecture

**Status:** DRAFT for PM review (Sprint 1). Authoritative once approved.
**Baseline:** tag `sprint-0-complete` (commit `d782e4a`). Evidence references point into that tree
and into the Sprint 1 research note `docs/research/sprint-1-simulation-time.md`.
**Decision records:** `docs/architecture/adr/`.

> **North star.** The browser owns the project. The simulation service owns only an ephemeral
> execution session. A project never becomes server-owned because it contains an ESP32.

---

## 0. How to read this document

- §1-§3 define **what exists and who owns what**.
- §4-§9 define **how simulation runs**: the two execution modes, the session, the protocol, time, the
  electrical engine and the MCU runtime.
- §10-§16 define **contracts and constraints**: firmware, security, resources, failure, versioning,
  licensing, localization.
- §17 lists the **invariants** every implementation sprint must preserve. §18 lists **decisions,
  assumptions, open questions and risks**, including those needing PM input.

"Proven" means demonstrated by a test in the Sprint 0 tree or a Sprint 1 spike. "Measured" figures
come from the 1-core ARM64 dev host and are **not** production projections.

---

## 1. System boundaries

### 1.1 Components

**Browser (the product; works offline):**

| Component | Responsibility |
|---|---|
| **UI shell** | Editing, presentation, controls. Not built in Sprint 1. |
| **Project Store** | The project source of truth: IndexedDB repository, schema validation, migrations, autosave, revision metadata. Promoted from the Gate D design. |
| **Component Catalog** | Language-neutral component type definitions (terminals, parameters, units, model binding). Display text lives in the localization layer, not here. |
| **Localization layer** | Locale, text direction, translation keys, terminology glossary, locale-aware *formatting* (never storage). |
| **Simulation Coordinator** | Chooses the execution mode (§4), builds immutable **Simulation Snapshots** from the project, owns the lifecycle of whichever simulation is active, and routes runtime state to the UI. |
| **Local Solver Worker** | Mode A host of the Electrical Engine, in a Web Worker. |
| **Simulation Client** | Mode B: WebSocket client for a remote simulation session. |

**Server (Mode B only):**

| Component | Responsibility |
|---|---|
| **Simulation Service** | One service. It terminates WebSocket connections, admits sessions, enforces limits, and spawns, supervises and reaps Session Hosts. It holds **no project data** beyond live sessions. |
| **Session Host** (logical: one per session) | The session controller: the Electrical Engine (the same code as the browser), the MCU <-> electrical Bridge, the MCU Runtime driver and the session event loop. Whether each Session Host is its own OS process, or several are multiplexed in one process with strict per-session state, is an **implementation choice** (§11). |
| **QEMU process** (**required**: one per active MCU session) | The classic-ESP32 emulator: always a separate OS process, never shared between sessions, connected to its Session Host over local IPC (the bridge socket for GPIO, QMP for lifecycle, a chardev for UART). This is both the isolation boundary for untrusted firmware and the GPL boundary (§15). |

No other services exist in V1: no separate firmware service, database, message broker or
orchestrator. Authentication and project sync are future boundaries (§2.6) and are **not**
designed here.

### 1.2 Overall system diagram

```mermaid
flowchart LR
  subgraph Browser["Browser — owns the project (works offline)"]
    UI[UI shell]
    L10N[Localization layer]
    CAT[Component Catalog<br/>language-neutral]
    PS[(Project Store<br/>IndexedDB)]
    COORD[Simulation Coordinator]
    subgraph W["Web Worker"]
      EA[Electrical Engine<br/>host A]
    end
    SC[Simulation Client]
    UI --- L10N
    UI <--> PS
    UI <--> COORD
    COORD --> CAT
    COORD -- "Mode A: snapshot, controls" --> EA
    EA -- results --> COORD
    COORD <--> SC
  end

  subgraph Server["Simulation Service — ephemeral sessions only"]
    GW[Session admission<br/>and supervision]
    subgraph SH["Session Host (one per session)"]
      LOOP[Session event loop]
      EB[Electrical Engine<br/>host B — same code]
      BR[MCU <-> electrical Bridge]
      RT[MCU Runtime driver]
      LOOP --- EB
      LOOP --- BR
      BR --- EB
      BR --- RT
    end
    subgraph GPL["GPL-2.0 boundary: separate process"]
      Q[QEMU classic ESP32<br/>+ GPIO + tbi-gpio-bridge]
    end
    GW --> SH
    RT <-- "local IPC: GPIO chardev, QMP, UART" --> Q
  end

  SC <-- "WebSocket: commands, frames<br/>(never per-GPIO traffic)" --> GW
```

The Mode B feedback loop (QEMU -> Bridge -> Engine -> Bridge -> QEMU) is entirely inside one
machine. The WebSocket carries commands and throttled observation frames only (ADR-004).

---

## 2. Project ownership and the local-first model (ADR-001)

### 2.1 Source of truth

The **Project Document in the browser's Project Store is the only source of truth** for project
content. Every other copy is derived and disposable:

| Artifact | Owner | Lifetime | May be lost without losing work? |
|---|---|---|---|
| Project Document | Browser (IndexedDB) | Persistent | **No** — this is the work |
| Firmware artifacts | Browser (IndexedDB, content-addressed) | Persistent | No |
| User preferences (locale, UI state) | Browser, **separate from projects** | Persistent | Yes |
| Simulation Snapshot | Derived from a project revision | Per run | Yes |
| Simulation runtime state (voltages, pin levels, serial log, sim time) | Solver Worker or Session Host | Ephemeral | **Yes, always** |
| Simulation session | Simulation Service | Ephemeral | Yes, always |

### 2.2 Persistent state is not runtime state

`persistent project state != simulation runtime state` is a type-level rule, not a convention:

- The Project Document contains only **what the user designed**: components, parameters, nets,
  layout, instruments' *settings*, MCU instances, firmware references, run configuration, labels
  and notes.
- Runtime values — node voltages, currents, pin levels, supply mode (CV/CC), serial output,
  simulated time, LED "lit" state — live in a separate **Runtime State** model. They are **never**
  written into the Project Document.
- Changes made while a simulation exists fall into **exactly three categories**. The browser
  classifies every change before anything reaches a simulation:

| Category | Examples | What the browser does | What the session receives | Persistent? |
|---|---|---|---|---|
| **1. Persistent project edit** | add/remove/rewire a component, change a component type, assign different firmware | writes the Project Document (new `localRevision`, IndexedDB) | nothing live; the next run gets a **new snapshot** (controlled restart, §5) | yes |
| **2. Live mirror of a persistent edit** | turn the PSU setpoint to 3.3 V, change a current limit, toggle PSU output, flip a panel switch whose position is part of the design | **first** writes the Project Document (new revision), **then** sends a `sim.control` carrying the new value and the revision it came from | the value, applied at a simulation instant (§7); acknowledged with that instant | yes — the **browser's** copy |
| **3. Transient runtime command** | pause, resume, stop, MCU reset (EN), a momentary button press, a temporary stimulus | no project write | the command | no |

  The server is **never authoritative for any project value**. In category 2 the session only holds
  a runtime copy of what the browser already persisted. If the session is lost, nothing is lost. If
  the command is rejected (`stale_snapshot`, `invalid_state`), the project still holds the user's
  value, and the next snapshot carries it.
- A category-2 change is a *topology-preserving* parameter change. Anything that changes topology is
  category 1, by definition.

### 2.3 What is sent to the simulation service

Only an immutable **Simulation Snapshot**: the minimum needed to simulate. It contains component
instances with type IDs and parameters, nets, MCU instances, firmware artifact bytes or reference
with hash, and run configuration. It **excludes** layout, labels, notes, project name and
revision history — none of these affect physics, and not sending them reduces exposure.

Each snapshot carries `snapshotId` (hash of its canonical content), `projectId` and the
`projectRevision` it was derived from, so every result can be traced to the exact design it
belongs to.

### 2.4 The server never mutates project state

The Simulation Service has **no write path** to the project. It cannot reach the browser's store,
and its protocol has no "update project" message. It returns runtime state and diagnostics only.

### 2.5 Connectivity matrix

| Capability | Offline | Needs the simulation service |
|---|---|---|
| Create, edit, save, reopen projects | ✅ | — |
| Switch UI language | ✅ | — |
| Simulate circuits without an MCU (Mode A) | ✅ | — |
| Simulate a project containing an ESP32 (Mode B) | ❌ | ✅ |
| Keep editing while a Mode B session is lost | ✅ | — |

If the server disappears, the network drops, or the session crashes, **editing and saving continue
unaffected**. Only the Mode B run stops, and the UI says so (§13).

### 2.6 Future sync boundary (not designed)

Cloud sync, when it comes, will sit **beside** the Project Store and replicate Project Documents
using the revision fields already persisted since Gate D (`localRevision`, `cloudRevision`,
`baseRevision`, `updatedAt`, `deviceId`). It will not route through the Simulation Service, and
simulation will never depend on it.

### 2.7 Data ownership diagram

```mermaid
flowchart TB
  subgraph Browser
    direction TB
    PD[(Project Document<br/>persistent · source of truth)]
    FW[(Firmware artifacts<br/>persistent · content-addressed)]
    PREF[(User preferences<br/>persistent · not project data)]
    SNAP[Simulation Snapshot<br/>derived · immutable per run]
    RS[Runtime State view<br/>ephemeral]
    PD -- "derive (read-only)" --> SNAP
    FW -- "reference / bytes" --> SNAP
  end
  subgraph Session["Simulation Service session (ephemeral)"]
    RTS[Runtime state<br/>voltages, pins, serial, sim time]
  end
  SNAP -- "send" --> Session
  RTS -- "frames" --> RS
  UI2[User edit] -- "cat. 1 and 2: persist FIRST" --> PD
  UI2 -. "cat. 2: then mirror as sim.control" .-> Session
  UI2 -. "cat. 3: transient command only" .-> Session
  Session -. "no write path" .-x PD
```

---

## 3. Project schema (conceptual) (ADR-005)

### 3.1 Language independence — the rule

> **One project. Any locale. Same electrical truth.**
> A project created with a Hebrew UI opens identically with an English UI, and vice versa, with no
> migration or rewrite. The same will hold for every locale added later.

1. Component **type IDs** are namespaced and language-neutral: `component.resistor`,
   `mcu.esp32_classic`.
2. **Property keys** are language-neutral identifiers: `resistance`, `setpointVoltage`.
3. **Enum values** are language-neutral tokens: `"cv"`, `"output"`, `"dio"`.
4. **Technical values** are stored as numbers in SI units, with canonical unit IDs (`"ohm"`,
   `"volt"`, `"ampere"`). Locale affects only how they are *displayed*.
5. **No translated catalog text is persisted** as project data. `Resistor` / `נגד` / `Widerstand`
   are rendered from translation keys at display time.
6. **User-authored text** (project name, labels, notes, custom net names, firmware comments) is
   stored **exactly as entered** and never replaced, translated or normalized because the UI
   language changed.
7. **One project, not one per language.** Project identity (`projectId`) contains no locale.

### 3.2 Representative example

Illustrative only; this is not a frozen wire format.

```json
{
  "projectId": "prj_01J8Z6K4Q7R3",
  "schemaVersion": 2,
  "createdWith": { "app": "0.1.0", "schemaVersion": 2 },
  "revision": {
    "localRevision": 14,
    "cloudRevision": null,
    "baseRevision": null,
    "updatedAt": "2026-09-22T10:15:00.000Z",
    "deviceId": "8eba27ed-18e4-40c0-98e3-eea2dae83153"
  },
  "name": "נורית מהבהבת",

  "components": [
    { "id": "PSU1", "type": "instrument.lab_psu", "typeVersion": 1,
      "params": { "setpointVoltage": { "value": 5, "unit": "volt" },
                  "currentLimit":    { "value": 0.1, "unit": "ampere" },
                  "outputEnabled": true } },
    { "id": "U1", "type": "mcu.esp32_classic", "typeVersion": 1,
      "params": { "board": "board.esp32_devkitc", "firmwareRef": "fw_sha256_d069fffc27f7d724" } },
    { "id": "R1", "type": "component.resistor", "typeVersion": 1,
      "params": { "resistance": { "value": 220, "unit": "ohm" } } },
    { "id": "D1", "type": "component.led", "typeVersion": 1,
      "params": { "model": "model.led.vishay_tlhr5400" } }
  ],

  "nets": [
    { "id": "N_GND",  "role": "ground", "userName": null },
    { "id": "N_VCC",  "userName": null },
    { "id": "N_LED",  "userName": "קו הנורית" }
  ],
  "connections": [
    { "component": "PSU1", "terminal": "positive", "net": "N_VCC" },
    { "component": "PSU1", "terminal": "negative", "net": "N_GND" },
    { "component": "U1",   "terminal": "pin.3v3",  "net": "N_VCC" },
    { "component": "U1",   "terminal": "pin.gnd",  "net": "N_GND" },
    { "component": "U1",   "terminal": "gpio.2",   "net": "N_LED" },
    { "component": "R1",   "terminal": "a",        "net": "N_LED" },
    { "component": "R1",   "terminal": "b",        "net": "N_D1A" },
    { "component": "D1",   "terminal": "anode",    "net": "N_D1A" },
    { "component": "D1",   "terminal": "cathode",  "net": "N_GND" }
  ],

  "layout": {
    "R1": { "x": 40, "y": 10, "rotation": 90 },
    "D1": { "x": 80, "y": 10, "rotation": 0 }
  },

  "firmware": [
    { "artifactId": "fw_sha256_d069fffc27f7d724", "target": "esp32",
      "format": "esp32.flash_image.merged", "sha256": "d069fffc…cdd44",
      "flash": { "size": "4MB", "mode": "dio", "freq": "40m" },
      "producer": { "kind": "arduino-cli", "coreVersion": "esp32:esp32@3.3.12" },
      "userLabel": "blink v2" }
  ],

  "runConfig": { "timing": "virtual" },

  "annotations": [
    { "id": "A1", "kind": "note", "anchor": { "component": "R1" },
      "text": "לבדוק ערך נגד מול הדאטהשיט" }
  ]
}
```

Notes on the example:

- `name`, `nets[].userName` and `annotations[].text` are **user-authored** and deliberately in
  Hebrew here. They are shown as-is under every locale.
- Nothing else is language-specific. Under an English UI the same file renders "Lab power supply",
  "Resistor 220 Ω", "LED"; under Hebrew it renders the Hebrew terms from the catalog. **The file is
  byte-identical in both cases.**
- `layout` is separate from `components`, so the simulation snapshot can omit it (§2.3).
- The PSU is a **component instance**, not a special top-level `psu` block as in the Gate D
  feasibility schema. This allows more than one supply.
- `typeVersion` lets a component definition evolve without a whole-project migration.
- `firmwareRef` points at a content-addressed artifact, so identical firmware is stored once.

### 3.3 Schema evolution

- `schemaVersion` is an integer, and migrations are pure functions `vN -> vN+1`, run in the
  browser when a project is opened.
- A project with a **newer** schema than the app supports opens **read-only** with an explicit
  message. The app never guesses (§13).
- Gate D's feasibility schema (v1: un-namespaced types, singleton `psu`) needs a v1 -> v2 migration
  if any v1 data is ever kept. Assumption: no user data exists yet, so v2 can start clean.

---

## 4. Simulation execution modes (ADR-002)

### 4.1 Mode A — browser-local (no MCU)

```mermaid
sequenceDiagram
  autonumber
  participant UI
  participant CO as Simulation Coordinator
  participant PS as Project Store
  participant WK as Solver Worker (Engine host A)
  UI->>CO: run simulation
  CO->>PS: read project revision r
  CO->>CO: build Simulation Snapshot (no layout / notes)
  CO->>WK: load(snapshot)
  WK->>WK: compile snapshot -> circuit
  WK->>WK: solve() — DC operating point
  WK-->>CO: result(values, diagnostics, engineVersion, snapshotId)
  CO-->>UI: runtime state
  UI->>CO: runtime control (e.g. PSU setpoint 3.3 V)
  CO->>WK: control(PSU1.setpointVoltage = 3.3)
  WK->>WK: solve()
  WK-->>CO: result
  Note over UI,WK: No network. Editing continues on the main thread throughout.
```

**Worker boundary (message contract):** `load(snapshot)`, `control(target, param, value)`,
`solve()`, `dispose()`, answered by `result` or `error` carrying `snapshotId` and `engineVersion`.
The Worker never touches IndexedDB, the DOM or localization. It receives and returns
language-neutral data only.

### 4.2 Mode B — hybrid ESP32

```mermaid
sequenceDiagram
  autonumber
  participant UI
  participant CO as Coordinator + Simulation Client
  participant SS as Simulation Service
  participant SH as Session Host (Engine host B + Bridge)
  participant Q as QEMU (classic ESP32)
  UI->>CO: run
  CO->>SS: session.create(protocolVersion, capabilities)
  SS->>SH: spawn Session Host
  SS-->>CO: session.created(sessionId, resumeToken, limits)
  CO->>SS: session.load(snapshot, firmware bytes + sha256)
  SH->>SH: validate snapshot and firmware, compile circuit
  SH->>Q: spawn QEMU (esp32 machine, firmware, bridge chardev)
  SH->>SH: initial DC solve (t = 0)
  SS-->>CO: state: ready (simTime 0)
  CO->>SS: run.start
  loop inside the Session Host — no network
    Q->>SH: GPIO event (pin, level, simTime)
    SH->>SH: update pin model -> solve -> interpret inputs
    SH->>Q: inject input levels
  end
  SS-->>CO: sim.frame (throttled, e.g. <= 20 Hz wall)
  SS-->>CO: serial.out (batched)
  UI->>CO: pause / control / stop
  CO->>SS: run.pause | sim.control | run.stop
```

The loop marked "no network" is the Gate C bridge, relocated server-side. **No step of the MCU <->
electrical loop crosses the WebSocket.**

### 4.3 How the mode is chosen

| Project contains | Mode |
|---|---|
| No MCU instance | **A** — browser-local |
| At least one `mcu.esp32_classic` instance | **B** — hybrid session |

Decisions:

- **An MCU in the circuit always means Mode B**, including when no firmware is assigned. An
  unpowered or unprogrammed ESP32 is not electrically "absent": its pins have protection
  structures, and modelling them as open circuits would invent behaviour. To simulate without the
  MCU, the user removes it from the circuit. A validated "MCU held in reset" model would be a
  later, explicit addition.
- The mode is **derived** from the snapshot, never stored as a user preference, so a project cannot
  be forced into the wrong mode.
- A Mode B project **offline** gives an explicit "simulation needs a connection" state. Editing is
  unaffected.

---

## 5. Simulation session model

### 5.1 Decisions

1. **Topology is immutable while a session holds a loaded snapshot.** Structural edits (add,
   remove or rewire components; change component types; change firmware) never hot-mutate a
   session. Applying them is a **controlled restart**: `session.load` with a new snapshot, which
   returns the session to `ready` at simulated time 0.
2. **Runtime controls are dynamic.** A defined set of commands may change during a run: PSU
   setpoint, current limit and output enable; switch or button positions; potentiometer position
   when that exists. Each is applied at a defined simulation instant (§7) and echoed with that
   instant.
3. **`reset` means the ESP32's reset (EN) event, not "start over".** It restarts the firmware at
   the current simulation time while the circuit stays powered, as pressing EN does on a real
   board. **`stop`** ends the run and returns to `ready` at t = 0.
4. **Client disconnect never kills a session immediately.** The session auto-pauses and enters
   `detached` for a grace period. It then either reattaches or expires.
5. **Initial session policy (PM decision P5; configurable, wall-clock based):**
   - on disconnect, pause;
   - reconnect grace **60 s**;
   - paused or disconnected idle timeout **10 min**;
   - maximum continuous active run **2 h**;
   - **1** active MCU session per user.

   These are policy values, not simulation inputs. They never affect the simulated timeline.

### 5.2 State machine

```mermaid
stateDiagram-v2
  [*] --> creating: session.create
  creating --> empty: host + limits allocated
  creating --> failed: admission / spawn error

  empty --> loading: session.load(snapshot, firmware)
  loading --> ready: validated, QEMU booted to reset, DC solve at t=0
  loading --> empty: invalid snapshot / firmware (rejected, nothing loaded)

  ready --> running: run.start
  running --> paused: run.pause
  paused --> running: run.resume
  running --> running: sim.control / mcu.reset (EN) — applied at a sim instant
  paused --> paused: sim.control (applied at resume instant)

  running --> ready: run.stop (discard run, t=0)
  paused --> ready: run.stop
  ready --> loading: session.load(new snapshot) — controlled restart
  paused --> loading: session.load(new snapshot)
  running --> loading: session.load(new snapshot)

  running --> detached: client disconnected (auto-pause)
  paused --> detached: client disconnected
  ready --> detached: client disconnected
  detached --> paused: session.attach(resumeToken) — was running or paused
  detached --> ready: session.attach — was ready
  detached --> terminated: grace period expired

  running --> failed: QEMU crash / engine fault / limit breach
  paused --> failed: QEMU crash
  loading --> failed: QEMU failed to start

  empty --> terminated: session.close / idle timeout
  ready --> terminated: session.close / idle timeout
  paused --> terminated: session.close / idle timeout
  running --> terminated: session.close / max run time
  failed --> terminated: diagnostics delivered, resources reaped
  terminated --> [*]
```

`failed` and `terminated` are final. A new run needs a new session, which the client can create
automatically from the unchanged project.

---

## 6. Browser <-> simulation protocol

### 6.1 Transport

**WebSocket for V1.** It is bidirectional, ordered, supports both JSON and binary frames, and every
target browser supports it. WebRTC data channels, WebTransport and polling were considered: the
first adds signalling complexity for no benefit here, WebTransport is not needed at V1 frame rates,
and polling cannot push serial output or state changes promptly.

- Control, state and serial messages travel as **JSON text frames**.
- The firmware image (≤ 4 MB for the validated flash layout) is sent **once per load** as a binary
  frame, preceded by a JSON header that declares its `sha256` and size. The server verifies the
  hash before use.
- One WebSocket per session.

### 6.2 Envelope

Every message:

```json
{ "v": 1, "type": "run.start", "sessionId": "ses_…", "seq": 42, "cmdId": "c-42" }
```

| Field | Meaning |
|---|---|
| `v` | `protocolVersion`. The server rejects unsupported versions with `protocol_mismatch` before anything else. |
| `sessionId` | Absent only on `session.create`. |
| `seq` | Per-direction monotonic sequence. The server executes client commands **strictly in `seq` order**; a gap is buffered briefly, and after a timeout it is an error. |
| `cmdId` | Client-chosen correlation ID. Every command gets exactly one `cmd.result` with the same `cmdId`. |
| `simTimeNs` | On every server event that refers to simulation state. |
| `wallTime` | Server wall-clock timestamp, for diagnostics only. **Never** used for physics. |

### 6.3 Client -> runtime (conceptual)

```json
{ "v":1, "type":"session.create", "seq":1, "cmdId":"c1",
  "client": { "app":"0.1.0", "engineVersion":"eng-1.0.0+sha.ab12" } }

{ "v":1, "type":"session.load", "sessionId":"ses_7f", "seq":2, "cmdId":"c2",
  "snapshot": { "snapshotId":"snp_sha256_…", "projectId":"prj_01J8…", "projectRevision":14,
                "schemaVersion":2, "components":[…], "nets":[…], "connections":[…],
                "runConfig": { "timing":"virtual" } },
  "firmware": { "artifactId":"fw_sha256_d069…", "sha256":"d069fffc…", "bytes":4194304,
                "target":"esp32", "format":"esp32.flash_image.merged",
                "flash": { "size":"4MB", "mode":"dio", "freq":"40m" } } }
/* followed by one binary frame containing the image */

{ "v":1, "type":"run.start",  "sessionId":"ses_7f", "seq":3, "cmdId":"c3", "snapshotId":"snp_sha256_…" }
{ "v":1, "type":"run.pause",  "sessionId":"ses_7f", "seq":4, "cmdId":"c4" }
{ "v":1, "type":"sim.control","sessionId":"ses_7f", "seq":5, "cmdId":"c5", "snapshotId":"snp_sha256_…",
  "category":"mirror", "projectRevision":15,
  "target":"PSU1", "param":"setpointVoltage", "value":{ "value":3.3, "unit":"volt" } }
{ "v":1, "type":"sim.input",  "sessionId":"ses_7f", "seq":6, "cmdId":"c6", "snapshotId":"snp_sha256_…",
  "category":"transient", "target":"SW1", "param":"pressed", "value":true, "durationNs":50000000 }
{ "v":1, "type":"mcu.reset",  "sessionId":"ses_7f", "seq":6, "cmdId":"c6", "target":"U1" }
{ "v":1, "type":"run.stop",   "sessionId":"ses_7f", "seq":7, "cmdId":"c7" }
{ "v":1, "type":"session.attach", "sessionId":"ses_7f", "seq":1, "cmdId":"a1",
  "resumeToken":"…", "lastEventSeq":1830 }
{ "v":1, "type":"session.close", "sessionId":"ses_7f", "seq":8, "cmdId":"c8" }
```

### 6.4 Runtime -> client (conceptual)

```json
{ "v":1, "type":"cmd.result", "seq":101, "cmdId":"c5", "ok":true, "appliedAtSimTimeNs":1832000000 }

{ "v":1, "type":"session.state", "seq":102, "state":"running", "simTimeNs":1832000000,
  "snapshotId":"snp_sha256_…" }

{ "v":1, "type":"sim.frame", "seq":103, "simTimeNs":1850000000, "frameOf":"latest",
  "nets":    { "N_LED": { "voltage": 3.2051 } },
  "components": {
    "D1":   { "current": 0.0057540 },
    "PSU1": { "mode":"cv", "current": 0.0061 },
    "U1":   { "gpio": { "2": { "dir":"output", "level":1, "togglesSinceLastFrame":0 } } } },
  "pace": { "simPerWall": 0.99 } }

{ "v":1, "type":"serial.out", "seq":104, "port":"uart0", "simTimeNs":1851000000,
  "data":"IN=1\n" }

{ "v":1, "type":"error", "seq":105, "cmdId":"c9", "code":"stale_snapshot",
  "message":"command references snpA; session holds snpB", "retryable":false }

{ "v":1, "type":"session.failed", "seq":106, "reason":"runtime_crash",
  "detail":{ "component":"qemu", "exitSignal":"SIGSEGV" }, "simTimeNs":2003000000 }
```

### 6.5 What is deliberately not streamed

No QEMU instructions, individual solver iterations, Newton steps or per-transition GPIO events.
`sim.frame` carries the **latest** values of UI-relevant quantities, plus aggregates such as
`togglesSinceLastFrame` so that fast activity is visible without flooding the link. Frame rate is
set by the client (default ≤ 20 Hz wall-clock) and is **independent of simulation progress** (§7.8).

Aggregates are **counts, not inferred physics**. The protocol never reports a PWM-averaged
"voltage" as a DC value: that would invent behaviour the DC engine does not model.

### 6.6 Command categories on the wire

Every mutating command carries `category` (§2.2):

- `"mirror"` — a live mirror of a persistent edit. It also carries the `projectRevision` that the
  browser **already persisted** it in. The session records the value as runtime state only.
- `"transient"` — pause, resume, stop, `mcu.reset`, momentary inputs and temporary stimuli. There is
  no project revision.

There is **no** category for "server-originated project change". The session answers every command
with `cmd.result`, carrying `appliedAtSimTimeNs`. That instant, together with the ordered command log,
is what makes a run reproducible (§7).

### 6.7 Ordering, staleness and errors

- **Ordering.** Commands execute in `seq` order. Server events are totally ordered by server `seq`
  and carry `simTimeNs`.
- **Stale commands.** Commands that depend on a snapshot carry `snapshotId`. If it is not the
  loaded snapshot, the command is rejected with `stale_snapshot` and is never applied to the wrong
  design. State-invalid commands (e.g. `run.pause` in `ready`) return `invalid_state`.
- **Error codes** (initial set): `protocol_mismatch`, `invalid_state`, `stale_snapshot`,
  `invalid_snapshot`, `unsupported_component`, `unsupported_schema`, `invalid_firmware`,
  `unsupported_target`, `limit_exceeded`, `engine_nonconvergence`, `runtime_crash`, `internal`.
  Each carries `retryable`.

### 6.8 Reconnect

`session.create` returns a `resumeToken`. After a disconnect, the client sends `session.attach`
with `lastEventSeq`. The server answers with a **full `session.state` and `sim.frame`** — runtime
state is small, so resending it is simpler and safer than event replay — plus the retained tail of
`serial.out` after `lastEventSeq`, from a bounded buffer (e.g. 64 KB). If the tail was truncated,
it says so.

---

## 7. Simulation time and determinism (ADR-007)

This section states exactly what is proven, what is required for release, and what is not claimed.
Evidence: `docs/research/sprint-1-simulation-time.md` (Results 1-3, and the Sprint 1 closure
sections C1-C6).

### 7.1 Three separate properties

These three properties are independent. Each is claimed, or not claimed, on its own evidence.

| Property | Meaning | V1 status |
|---|---|---|
| **Deterministic causality** | The same inputs produce the same observable events, in the same order, at the same **simulation** timestamps | **Required for release (R-MCU-1).** Achieved for the tested scope (§7.4) |
| **Timing fidelity** | How closely simulated durations match real ESP32 silicon | **Partial, and stated honestly** (§7.5). Not cycle-accurate |
| **Execution speed** | Simulated seconds per wall-clock second | **Host-dependent.** About 1.5x (unpaced) on the dev host in the V1 configuration (§7.7) |

**Deterministic does not mean cycle-accurate.** A run can be bit-reproducible and still take
longer in simulated time than real silicon would. **Execution speed never affects either of the
other two**: a slow host stretches wall time only.

### 7.2 Two clocks, never mixed

| Clock | Source | Used for |
|---|---|---|
| **Simulation time** | QEMU's virtual clock (`QEMU_CLOCK_VIRTUAL`) under `-icount` | Ordering, causality, stamping events, firmware timers, when commands apply |
| **Wall-clock time** | Host and browser clocks | Pacing, UI frame rate, timeouts, idle/grace policies, diagnostics |

**Causality is defined in simulation time only.** Wall-clock time, host scheduling and network
timing never decide the order or the instant of anything the firmware or the circuit can observe.
The Electrical Engine is a pure function of (snapshot, pin states, runtime controls), and is
bit-identical between Node and the browser (Gate A).

### 7.3 Release requirement R-MCU-1 — the closed-loop determinism contract

> Given an identical **project snapshot, firmware artifact, runtime configuration** (§14:
> `runtimeVersion`, including the scheduling tick and the serial backend), **initial state**, and
> **ordered command/input sequence**, where each command carries its simulation-time application
> instant, the ESP32 simulation must reproduce identically:
>
> - GPIO output events (level and direction);
> - electrical results (every solve: node voltages, branch currents, PSU mode);
> - digital input transitions injected into the MCU;
> - firmware-observable behaviour (the serial output stream);
>
> **each with the same simulation timestamp.**
>
> Internal emulator state (QEMU TB caches, host thread interleaving, memory layout) need **not** be
> bit-identical.

- **Scope.** This applies to ESP32 (Mode B) simulation. It does **not** block Mode A (browser-local,
  no MCU), whose solver is already deterministic (Gate A).
- **Status.** The ESP32 feature is **not V1-ready** until R-MCU-1 holds in the automated release-gate
  test **for the supported feature set** (§7.4 lists what is not yet covered).

### 7.4 How the closed loop is made deterministic

The mechanism has three parts. All three are measured; none is a correction constant.

1. **Instruction-count time.** QEMU runs with `-icount shift=3,sleep=off`: 8 ns of simulation time
   per executed instruction, and an idle guest jumps to the next timer deadline. This is the only
   validated setting (`shift=2` was unstable; `sleep=on` was not reproducible).
2. **A synchronous bridge ("syncsock").** The GPIO bridge device owns a private blocking socket to
   the Session Host. Every exchange runs **on the emulator thread, holding the Big QEMU Lock**:
   - A GPIO output event produces `O|D <pin> <level> <vns>`. The Session Host solves the circuit,
     sends back changed input levels (`I`), and releases the emulator (`C`). Inputs are applied
     before the guest executes its next instruction, at **zero elapsed simulation time**.
   - A **periodic virtual-time tick** (`T <vns>`) is the only point at which runtime commands (§6.6)
     are applied. A command is applied at the **first tick at or after its scheduled instant**, so
     command timing is quantized to the tick. The tick instant is recorded and echoed.
   - While an exchange is in progress, nothing in QEMU can run. Host or WAN latency stretches wall
     time only, and cannot change ordering.
3. **Two small QEMU fixes (18 added lines each).**
   - **Synchronous APP-CPU reset** (ESP32 machine). Releasing the second core from reset went through
     QEMU's asynchronous main-loop reset request, so the instant at which core 1 started depended on
     host timing. Under icount the reset is now applied synchronously
     (`experiments/sprint-1-spikes/esp32-appcpu-reset-determinism.patch`).
   - **icount warp race** (QEMU core, `accel/tcg`). With `sleep=off`, the main loop could jump the idle
     clock forward using a value that omitted a vCPU slice's not-yet-accounted instructions. The
     overshoot depended on host timing (observed: 992 ns). The warp is now refused while a slice is
     in flight (`experiments/sprint-1-spikes/icount-warp-race-determinism.patch`).
4. **A pristine initial state.** The guest can write its flash image: a panic writes the coredump
   partition, and that changes every later boot. Each session must boot from a fresh copy of the
   hash-verified artifact (§11). This is part of "identical initial state".

**Evidence.** The release-gate test `experiments/sprint-1-spikes/tests/closed-loop.esp32.test.ts`
drives the real engine and pin model:

- circuit: GPIO2 -> LED, GPIO2 -> 10 k -> GPIO5 <- 10 k <- PSU;
- 4 PSU commands scheduled in simulation time;
- for each run, it hashes the full timeline and the serial output.

| Runtime | Scenario | Stress | Runs | Distinct results |
|---|---|---|---|---|
| No fixes | 3 s boot window | QMP main-loop stress | 20 | **4** |
| No fixes | full 15.5 s | none | 10 | **2** |
| APP-CPU fix only, pristine image | full, 1 ms tick | QMP main-loop stress | 10 | **2** |
| **Both fixes** | full, 1 ms tick | QMP main-loop stress | 30 | **1** |
| Both fixes | full, 1 ms tick | none | 14 | **1** |
| Both fixes | full, 10 ms tick | QMP main-loop stress | 10 | **1** |
| Both fixes | full, 10 ms tick | none | 8 | **1** |
| Both fixes | 3 s boot window, 10 ms tick | QMP main-loop stress | 30 | **1** |

With both fixes: **62 full-scenario runs (40 stressed) and 30 stressed boot-window runs, with zero
divergences.** The hashes are also identical **across separate processes and batches**:

- 1 ms tick: timeline `1382cd99…`, serial `c4d82896…`;
- 10 ms tick: timeline `b779e313…`, same serial.

Each run has 90 GPIO events, 45 solves, 5 injected input transitions and 4 commands. The reference
fingerprints are pinned in the test.

**Not yet covered, and blocking the claim for these features:**

| Path | Why it is not deterministic yet | V1 treatment until fixed |
|---|---|---|
| Full-chip reset: `esp_restart()`, watchdog reset, in-place UI / EN reset | Still uses QEMU's asynchronous reset request | **Unsupported and open.** Each must satisfy R-MCU-1 before the product exposes it as supported behaviour. It does **not** block Sprint 1 closure (P10), and is not implemented now |
| Deep/light sleep | The RTC sleep timer uses the host real-time clock | **Unsupported** — detect and report |
| Wi-Fi / Bluetooth | Not modelled; timestamps use the host clock | **Unsupported** (already a V1 non-goal) |

The proof covers **one firmware and one circuit**. Every future peripheral or bridge feature must
extend the release-gate test before it is claimed.

### 7.5 Timing fidelity — the honest claim

Measured on the dev host (research note C4), with no correction constant anywhere:

| What | Simulated result | Fidelity statement |
|---|---|---|
| `delay(1000)` | 999.90-1000.51 ms | Peripheral-timer time is consistent: firmware `millis()`, `esp_timer` and the CPU cycle counter all agree with simulation time to < 0.06 % |
| Hardware timer, 100 ms period, over a 1 s window | 999.985 ms, 9 alarms | Timer intervals are exact in simulation time |
| 1M-iteration busy loop | 48.8 ms (11.7 M cycles) | **Instruction-bound code is about 1.9x slower than silicon.** The virtual CPU is 125 MHz-equivalent vs 240 MHz on the real chip. This is an estimate; no physical board was measured |
| Reset -> first `setup()` GPIO | 0.889 s (no tick), 0.468 s (10 ms tick), **0.379 s (1 ms tick)** | **Boot timing is not faithful.** It depends on the dual-core scheduling quantum (below). Real silicon boot time was not measured |

**Where the "~12.9 s boot" came from.** It was **not** the emulator's boot path. The firmware image had
been modified by the guest: an earlier panic had written the Arduino coredump partition, and every
later boot processed that core dump. The same firmware with only that partition changed boots in
12.789 s simulated; the pristine image boots in 0.889 s. The fix is artifact hygiene (§7.4 item 4).

**The remaining boot effect is the scheduling quantum.** Under icount, QEMU runs the two ESP32 cores
**round-robin on one thread**. It switches cores only at the next virtual-timer deadline: QEMU's 100 ms
kick period by default, or the bridge tick when one is configured. Early boot phases land on exact
multiples of the quantum (400.000 and 100.000 ms at 100 ms; 310.000 and 30.000 ms at 10 ms), and boot
shrinks from 0.889 s to 0.379 s as the quantum goes from 100 ms to 1 ms. Real silicon runs both cores
concurrently. Flash emulation and ROM/bootloader content are not the cause.

**Consequences:**

- The **tick is part of the timing model**, not just a polling interval. It is fixed per
  `runtimeVersion` (§14), because changing it changes the simulated timeline.
- **`hostCommandQuantum` = 1 ms of simulated time is the approved V1 default** (PM decision P9). At
  that value, boot to `setup()` takes 0.38 s simulated and the unpaced run is about 1.5x real time on
  the dev host. See §7.6 for exactly what the quantum is and is not.
- The UI and documentation may say: *"peripheral timers and `delay()` behave like the real chip;
  CPU-heavy code runs about 2x slower; boot time is not representative."* They must not claim
  cycle accuracy.

### 7.6 `hostCommandQuantum` — what it is, and what it is not

**Definition.** `hostCommandQuantum` is the **default scheduling quantum for host and runtime
commands**: the period of the bridge's virtual-time tick, and therefore the only set of simulation
instants at which a command from the Session Host can be applied. A command scheduled for instant `t`
is applied at the first tick at or after `t`, and the run echoes the actual application instant.

**Approved V1 default: 1 ms of simulated time** (PM decision P9).

**It is part of the runtime and reproducibility configuration.** It belongs to `runtimeVersion` (§14)
and to the `runConfig` carried in bug reports, because it participates in the simulated timeline.

**It is configurable internally.** Other values (e.g. 10 ms) are used in engineering and measurement
work, and both 1 ms and 10 ms are covered by the release-gate test. **V1 exposes only the approved
1 ms product mode**; the quantum is not a user-facing setting.

**It is NOT:**

| Not this | Because |
|---|---|
| the electrical solver timestep | The DC engine is quasi-static and event-driven. It solves at events (§7.7), not on a fixed grid |
| GPIO resolution | GPIO output events are timestamped at the instruction that produced them |
| PWM resolution | Peripheral behaviour comes from the emulated hardware, at instruction and peripheral-timer resolution |
| MCU instruction resolution | Instructions advance simulated time at 8 ns each (`shift=3`) |
| evidence of cycle accuracy | Nothing here is cycle-accurate (§7.1, §7.5) |

**The GPIO -> electrical -> GPIO-input path is independent of the quantum.** It is event-driven: it runs
at the relevant emulator boundary, as a synchronous exchange at the instruction that changed the pin,
and the response is applied with **zero elapsed simulation time** (§7.4). The quantum governs only when
commands *from the host* enter the simulation.

**Different quantum values may legitimately produce different timelines.** Determinism means identical
externally observable results for the **same complete runtime configuration, including the quantum** —
not identity across different configurations. The release-gate test holds one reference fingerprint per
quantum, which demonstrates both properties at once.

### 7.7 Electrical solve points

The DC engine is quasi-static: between events the network does not change, so no solve is needed.
Solves occur only at:

1. **t = 0**, after `session.load` (the initial operating point);
2. each **GPIO level or direction change** emitted by the MCU (synchronous exchange);
3. each **runtime command**, at the tick where it is applied;
4. each **MCU reset (EN)** event (once deterministic reset is in place, §7.4).

Each solve is one event at one simulation instant, processed in emission order:

1. update the pin models;
2. solve;
3. interpret the digital inputs (datasheet V_IH/V_IL, with hold in the undefined band);
4. inject any changed input levels before the guest continues.

### 7.8 Pause, reset, stop, pacing

- **Pause:** the Session Host withholds the reply to the next tick exchange, which freezes
  simulation time. Commands issued while paused apply at the first tick after resume.
- **MCU reset (EN):** conceptually a simulation event at the current time: the firmware restarts, the
  circuit stays powered, and the network state persists, as on real hardware. **Not supported in V1
  yet** — it needs the deterministic reset path first (§7.4, P10).
- **Stop:** discards the run. The next start begins at t = 0 from the same snapshot.
- **Pacing:** the simulation runs as fast as the host allows, capped at real time for interactive
  runs. The cap is applied by **delaying the tick reply**. Simulation time does not advance while
  the reply is withheld, so pacing cannot alter the simulated timeline.
- **Measured speed (V1 configuration, dev host, unpaced):** 15.5 s simulated in 10.3 s wall with a 1 ms
  tick (**~1.5x**), and in 8.6 s with a 10 ms tick (~1.8x). The ROM phase alone runs at about 0.06x
  (0.3 s simulated in ~5 s wall), so the first ~5 s of wall time after start show little progress. The UI
  shows `pace.simPerWall` rather than hiding it.
- UI frames are throttled independently (§6.5). Rendering never slows or speeds the simulation.

---

## 8. Electrical engine architecture (ADR-008)

### 8.1 One engine, two hosts

The Gate A solver (`experiments/gate-a-electrical/src`) and the Gate C pin model
(`experiments/gate-c-bridge/src/pinModel.ts`) are promoted — **deliberately, not rewritten** — into
a single package, the **Electrical Engine**, with two thin hosts:

| Host | Where | Adds |
|---|---|---|
| **A — Solver Worker** | Browser Web Worker | message adapter only |
| **B — Session Host** | Server, inside each Mode B session | the MCU Bridge (Gate C `bridge.ts`, relocated) |

Both hosts run **the same built artifact**, identified by one `engineVersion`. Divergence is guarded
by a cross-host test that asserts bit-identical results in Node and in a browser Worker. Gate A
already does this for the LED case; it becomes a CI requirement across the reference suite.

### 8.2 Boundaries

```
Simulation Snapshot (language-neutral JSON)
      │  compile()        — resolves nets -> node indices, instantiates component models,
      ▼                     rejects unknown types/terminals with structured errors
CompiledCircuit
      │  solve(pinStates, controls)   — pure; no I/O, no timers, no DOM, no locale
      ▼
SolveResult { nodeVoltages, componentObservables, supplyModes,
              diagnostics { residuals, iterations }, engineVersion, snapshotId }
```

- **Component-model boundary.** Each catalog `type` maps to a model implementing the existing
  `Device` contract: stamp, exact terminal currents, residual. Component *definitions* (terminals,
  parameters, units) live in the catalog; the *physics* lives in engine models. There is no
  catalog/UI knowledge inside models.
- **Nodes and nets.** Nets are persistent project objects with stable IDs. Nodes are engine-internal
  indices compiled from nets, rebuilt on every compile and never persisted. Ground is the net with
  `role: "ground"`. A circuit without one is rejected with an explicit error, rather than
  receiving an invented reference.
- **Deterministic I/O.** Inputs and outputs are plain data. Node ordering is by insertion; there is
  no hash-order dependence. This is already true of the Gate A code.
- **Errors never yield partial results.** `SingularMatrixError`, `ConvergenceError` (including the
  residual-verification rejection added in Gate A), `UnsupportedComponentError` and
  `InvalidTopologyError` surface as structured diagnostics. In Mode B, non-convergence **pauses**
  the run and reports it (§13). It never substitutes a guess.
- **Future transient boundary.** `solve()` stays the DC operating point. A later `step(dt, state)`
  with companion models (capacitors, inductors) will extend the Device contract with per-model
  state in and out. Nothing in V1 precludes it, and nothing in V1 implements it. AC analysis is out
  of scope.

---

## 9. MCU runtime boundary

### 9.1 Interface (conceptual)

```ts
interface McuRuntime {
  readonly target: 'esp32';            // classic ESP32 only — see 9.2
  load(image: FirmwareImage): Promise<void>;          // validate + prepare; no execution
  start(): Promise<void>;                              // boot from reset
  pause(): Promise<void>;
  resume(): Promise<void>;
  resetEn(): Promise<void>;                            // EN/reset event at current sim time
  terminate(): Promise<void>;
  simTimeNs(): bigint;

  onGpio(cb: (e: { pin: number; level?: 0|1; direction?: 'output'|'input'; simTimeNs: bigint }) => void): void;
  injectInput(pin: number, level: 0|1): void;          // applied per §7 semantics
  onSerial(cb: (e: { port: 'uart0'; bytes: Uint8Array; simTimeNs: bigint }) => void): void;
  onFault(cb: (e: { kind: 'crash'|'hang'|'limit'|'invalid_image'; detail: string }) => void): void;
}
```

The only implementation is **`QemuEsp32Runtime`**. It drives a separate QEMU process through:

| Channel | Carries |
|---|---|
| `tbi-gpio-bridge` chardev | GPIO events and injection (Gate C protocol, extended with timestamps) |
| QMP | stop, cont, system_reset, quit |
| UART chardev | serial output |

The interface is shaped by what the product needs, not by QEMU internals, so a different emulator
could replace QEMU behind it without touching the engine, the protocol or the browser. That is the
only abstraction added: one interface, one implementation, no plugin layer.

### 9.2 Classic ESP32, explicitly

- `target` is the literal `'esp32'`: the original ESP32 (Xtensa LX6, dual-core) of common DevKit
  boards.
- Firmware images are checked against the ESP image header's chip ID. A non-classic image (C3, S3,
  C6, …) is **rejected** with `unsupported_target` and is never run on a "close enough" model.
- The runtime build is pinned (§14). Swapping the emulated chip is a product decision, never an
  implementation shortcut.

---

## 10. Firmware artifact boundary

The runtime consumes a **Firmware Artifact** and does not care where it came from.

| Field | Meaning | Validated at `session.load` |
|---|---|---|
| `artifactId` | `fw_sha256_<prefix>`; identity **is** the content hash | hash of received bytes |
| `sha256` | full hash | must match bytes |
| `target` | `esp32` | must equal runtime target; image header chip ID checked |
| `format` | `esp32.flash_image.merged` (bootloader + partitions + app at offsets, whole flash) | size = flash size, ESP image magic `0xE9` at `0x1000` |
| `flash` | `size`, `mode`, `freq` | `mode` must be supported by the runtime version. **QIO is rejected** with the diagnostic `unsupported_flash_mode` (Sprint 0: the runtime stalls at "Failed to set QIE bit"). The server never converts or rewrites firmware. **DIO** is the supported V1 mode (P7) |
| `producer` | `{kind, toolchain/core version}` — informational | not trusted for anything |
| `runtimeCompat` | set of runtime versions it has been validated on (optional) | informational |

- **Producers.** An integrated compiler, a server compiler, a local compiler, an uploaded binary or
  a future workflow all end in the same artifact. **No editor or compiler workflow is designed in
  Sprint 1.**
- **Supported feasibility directions**, proven in Sprint 0: Arduino (official `esp32:esp32` core,
  FQBN `esp32:esp32:esp32`, `FlashMode=dio`) and MicroPython (`ESP32_GENERIC` prebuilt images).
  These are recorded as directions, not features.
- Artifacts are stored in the browser, content-addressed, and sent to the session per load. The
  server keeps them only for the lifetime of the session.

---

## 11. Session isolation and security

**User firmware and snapshots are untrusted input.** These are logical requirements; the
deployment technology (containers, VMs, seccomp profiles, cgroups) is chosen later.

| Concern | Requirement |
|---|---|
| Process isolation | **Required:** one QEMU process **per active MCU session**, unprivileged, never shared between sessions or users. This is where untrusted firmware runs. **Optional (implementation choice):** whether the host-side session controller (engine + bridge + driver) is also one OS process per session, or several controllers share a process with strict per-session state. Per-process is simpler to reason about; multiplexing saves memory (the controller's own footprint is not yet measured, §12). |
| CPU | Per-session CPU cap (planning figure: 1 core; §12). A runaway guest can only consume its own allowance. |
| Memory | Per-session hard limit (planning figure: 512 MB for QEMU + Session Host); exceeding it fails the session, never the host. |
| Time limits | Initial values (P5): reconnect grace 60 s, paused/disconnected idle timeout 10 min, maximum continuous active run 2 h, 1 active MCU session per user. Configurable. |
| Guest networking | **None.** QEMU is started without network devices or user-mode networking, and no host-forward. (The ESP32 Wi-Fi/Ethernet models remain unused.) |
| Filesystem | QEMU sees only a per-session scratch directory holding the flash image copy. No host paths, no shared directories, removed on reap. |
| Host interfaces | No QEMU monitor exposed outside the Session Host; QMP and chardevs bound to per-session local sockets; no GDB stub in production. |
| Malformed firmware | Validated before QEMU starts (§10). QEMU crash or hang -> `failed` with diagnostics, never a host-wide effect. |
| Malformed snapshot | Schema-validated and size-limited (components, nets, message bytes) **before** compile. Engine errors are structured. |
| Denial of service | Per-client session limits, admission control on host capacity, bounded message sizes, bounded serial and event buffers, server-side frame-rate caps. |
| Cleanup | Terminating a session kills QEMU and the Session Host, deletes scratch state, and releases limits. This is idempotent and runs on every exit path, including crashes. |

Authentication and authorization are **out of scope** for Sprint 1, but they are **required before
the Simulation Service is exposed publicly** (§18).

---

## 12. Resource model

### 12.1 Measured values (1-core Neoverse-N1 dev host)

Every figure here was measured. Anything not measured is marked **unknown**; no planning
assumption is substituted for a measurement.

| Component and configuration | Memory (RSS) | CPU | Source |
|---|---|---|---|
| Espressif QEMU 9.2.2, MicroPython idle at REPL, real-time | **~209 MB** | ~0 % idle | Sprint 0 Gate B |
| Selected GPIO-capable runtime (a159x36 + TBI patches), Arduino firmware, real-time | **~204 MB** | ~0.8 core | Sprint 1 |
| Same runtime, `icount shift=3,sleep=off`, chardev bridge | **84-132 MB** | ~0.91 core (CPU-bound) | Sprint 1 |
| Same runtime, V1 closed-loop configuration (icount + synchronous bridge + tick) | **145 MB** peak (`VmHWM`); ~90 MB sampled steady-state | ~0.8-0.9 core unpaced | Sprint 1 closure (§12.4) |
| Minimal Node engine host (engine + one socket, no WebSocket server, no session logic) | **53 MB** bare Node; **66 MB** with engine and socket loaded | ~0.1-0.3 ms per nonlinear solve | Sprint 1 closure |
| Full Session Host (session controller with WebSocket, protocol, buffers) | **unknown** | **unknown** | not built |

| Throughput and latency | Value | Source |
|---|---|---|
| Nonlinear DC solve | 0.07-0.09 ms (browser Worker, uncontended); 0.31 ms (Node, while QEMU competed for the single core) | Gate A; Sprint 1 |
| Bridge event -> solve -> inject, asynchronous bridge | ~3 ms wall | Gate C |
| Simulated/wall ratio | configuration-dependent; see §7.8 | Sprint 1 closure |

### 12.2 The dominant cost

**QEMU dominates, and CPU dominates within QEMU.** An actively running ESP32 session in the V1
timing mode consumed roughly one core on this host, because icount without sleep executes as fast as
the host allows. Pacing to real time (§7.8) is what would make a session cheaper on a fast host. The
electrical engine costs almost nothing, since it solves only at events.

Memory is second-order, but not small. The QEMU process alone is ~84-209 MB depending on
configuration (145 MB peak in the V1 configuration), and the Session Host adds an unknown amount on top of the 66 MB minimal figure.

### 12.3 Capacity planning — not yet possible, and not claimed

No concurrent-session capacity figures are given here. Per-session CPU on a production-class core,
the effect of pacing, and the full Session Host footprint are all unmeasured. Figures derived from
this 1-core ARM64 dev server would not be representative.

**Pre-production capacity gate.** Before any capacity or infrastructure commitment, the V1 runtime
configuration must be benchmarked on **representative production-class hardware**, measuring per
active session: CPU at pace = 1.0, CPU when unpaced, peak and steady RSS for QEMU and for the Session
Host, boot time, and the simulated/wall ratio. This gate does **not** block general product
implementation (PM decision P2).

Once measured, capacity follows from:
`sessions per host ≈ min(usable_cores / cpu_per_active_session, usable_memory / (qemu_rss + host_rss))`,
with paused, detached and idle sessions costing memory but little CPU.

### 12.4 V1 closed-loop configuration

**Scope of the measurement:**

- QEMU process only;
- pristine firmware image, full 15.5 s release-gate scenario;
- `-icount shift=3,sleep=off`, synchronous bridge;
- unpaced (as fast as the host allows).

Peak RSS is the kernel's `VmHWM`; the sampled figure is the maximum `VmRSS` in 200 ms samples.

| Tick | QEMU peak RSS | Max sampled RSS | QEMU CPU time | Wall time | Simulated/wall |
|---|---|---|---|---|---|
| **1 ms** (recommended) | **145 MB** | 90 MB | 8.5 s | 10.3 s | ~1.5x |
| 10 ms | **144 MB** | — | 7.5 s | 8.6 s | ~1.8x |

- **Memory limits must use the peak.** A first measurement pass reported 92-94 MB. That was sampled
  RSS on a modified image, and it understated the peak.
- The host-side process in this test ran under the TypeScript dev toolchain (vite-node, 112-114 MB),
  so it is **not** a Session Host figure. The Session Host remains **unknown** (§12.1).
- None of these figures is a capacity claim (§12.3).

Evidence: `docs/research/sprint-1-simulation-time.md` C5.

---

## 13. Failure and recovery model

**Invariant: an ephemeral simulation failure can never lose project work.** Project data is written
locally before and independently of any simulation, and no simulation path can write to it.

| Event | Project work | Simulation | User sees |
|---|---|---|---|
| Browser refresh | Intact (autosaved) | Mode A: re-run locally. Mode B: session `detached`; reattach with `resumeToken` if stored, otherwise it expires | Run resumes paused, or "session ended — start again" |
| Browser crash | Intact up to the last autosave (debounce window, milliseconds) | Session detaches, then expires | Same as refresh |
| Temporary network loss | Intact; editing continues | Session auto-pauses (`detached`); reattach within grace restores state and serial tail | "Reconnecting…", then resumes paused |
| Server runtime crash (QEMU or Session Host) | Intact | `failed` with diagnostics | "Simulation stopped: runtime error"; one action to start a new session |
| Simulation timeout (idle or max run) | Intact | `terminated` | "Session ended after inactivity" |
| Firmware crash (guest panic or reboot loop) | Intact | **Not** a session failure: the guest crash is simulated behaviour, and serial output shows it. A hard QEMU fault is `failed` | Firmware's own crash output in the serial view |
| Solver non-convergence | Intact | Mode A: result replaced by the error. Mode B: run **pauses** at that simulation instant with `engine_nonconvergence` | Which instant and which components, rather than a wrong number |
| Protocol mismatch | Intact | Refused at `session.create` | "Update required" |
| Stale snapshot | Intact | Command rejected (`stale_snapshot`); the Coordinator reloads the current revision (controlled restart) | Brief restart |
| Unsupported project schema (newer than the app) | Intact, **read-only** | Not started | "Created with a newer version" |

---

## 14. Versioning

Only dimensions that answer "what exactly produced this result?" are kept.

| Dimension | Form | Where it appears |
|---|---|---|
| `schemaVersion` | integer | project document, snapshot |
| component `typeVersion` | integer per type | each component instance |
| `protocolVersion` | integer | every message (`v`) |
| `engineVersion` | semver + build hash | every solve result; `session.state` |
| `runtimeVersion` | Session Host build (semver + hash) **plus the timing configuration**: icount shift, `hostCommandQuantum` (§7.6) and serial backend. Each of these changes the simulated timeline | `session.state` |
| `qemuBuild` | upstream fork + commit + our patch set hash (e.g. `a159x36@03be9af0+tbi.p1(sha)`). The patch set now includes the GPIO enable-gating fix, the bridge device, the ESP32 machine APP-CPU reset fix and the icount warp-race fix (QEMU core) | `session.state` |
| `firmware` | `artifactId` (content hash) | snapshot and `session.state` |
| `snapshotId` | content hash of the canonical snapshot | every result |

**Reproducibility requirement.** A bug report carries `{snapshotId, firmware artifactId,
engineVersion, runtimeVersion, qemuBuild, runConfig}`. With those, the exact run environment can be
reconstructed. Under the determinism contract (§7.3), so can the exact event timeline, given the
same ordered command sequence. The Mode A equivalent is
`{snapshotId, engineVersion}`.

Not versioned separately: the catalog as a whole (covered by per-type `typeVersion`) and the
localization bundles (they cannot change results, by §16).

---

## 15. Licensing boundary (ADR-006)

Engineering and compliance constraints only; this is not legal advice.

```mermaid
flowchart LR
  subgraph P["TBI Lab code (proprietary or project-licensed)"]
    B[Browser app]
    SS[Simulation Service]
    SH[Session Host<br/>engine + bridge + runtime driver]
  end
  subgraph G["GPL-2.0 — server-side only"]
    Q[QEMU fork<br/>+ ESP32 machine + GPIO<br/>+ tbi-gpio-bridge device<br/>+ TBI patches]
  end
  subgraph D["Dev/test only — not shipped"]
    NG[ngspice WASM oracle]
  end
  SH <-- "process boundary:<br/>sockets, QMP, chardevs" --> Q
```

- QEMU runs **server-side only** in V1, as a **separate process** behind IPC. No application code
  is linked into it. Everything *inside* the box — including our `tbi_gpio_bridge.c` and the GPIO
  fixes — is GPL-2.0 and tracked as such.
- **No approval exists to ship QEMU (native or WASM) to browsers.** Nothing in the V1 browser
  bundle contains QEMU.
- **Provenance** for every QEMU change is recorded (SPRINT-0.md §15): upstream fork, commit, patch
  files and licence headers. The production QEMU build will carry a manifest of the same form (§14
  `qemuBuild`). Sprint 1 added two patches to the GPL-2.0 tree, both recorded in
  `experiments/sprint-1-spikes/`:
  - the synchronous bridge mode, in `tbi_gpio_bridge.c`;
  - the synchronous APP-CPU reset, in `hw/xtensa/esp32.c` of the a159x36 fork;
  - the icount warp-race fix, in `accel/tcg/icount-common.c`, `accel/tcg/tcg-accel-ops-rr.c` and
    `include/sysemu/cpu-timers.h`. This is generic QEMU code and a candidate for upstream submission.
- The missing COPYING file in Espressif's **prebuilt binary** is a packaging/compliance finding. Our
  licence record uses the authoritative source-tree licensing.
- **Formal legal/licence review** of the QEMU integration is required before commercial
  distribution.
- **ngspice-wasm stays a dev/test oracle**: not a production dependency until its build and licence
  composition is resolved.

---

## 16. Localization / internationalization

Launch locales are English (`en`) and Hebrew (`he`), with first-class RTL. The architecture is **N
locales, not two**: no `isHebrew` logic, and no English/Hebrew duplicate objects.

| Kind of text/value | Stored as | Rendered by |
|---|---|---|
| Component type, terminal, parameter, enum | language-neutral IDs (`component.resistor`, `terminal`, `cv`) | catalog + translation keys |
| Component names and descriptions | **not stored in projects** | translation key -> locale bundle / glossary |
| Numbers and units | SI number + canonical unit ID | locale-aware formatting (decimal separator, grouping); unit symbols per glossary |
| System messages, warnings, errors | protocol/engine **codes** (`engine_nonconvergence`) | translation keys |
| User-authored names, labels, notes, net names | **as entered, verbatim** | shown as-is in every locale |
| Firmware source and serial output | bytes/text as produced | always LTR, never translated |

- **Engines and the protocol are language-free.** Errors travel as codes with structured
  parameters, and the browser localizes them. The server never produces localized text.
- **RTL does not reach technical content.** The circuit canvas, coordinates, component identifiers
  (`R1`), GPIO labels, values, units, formulas, code and serial output stay LTR or
  direction-independent under a Hebrew UI. Changing locale never rearranges the circuit.
- **No per-language projects.** `projectId` is locale-free, and one document opens under any
  locale.
- Future search (`displayName.<locale>`, `keywords.<locale>[]`, `aliases[]`) belongs in catalog
  metadata. The project schema does not block it.

---

## 17. Architecture invariants

Every implementation sprint must preserve these. A change that breaks one requires a new ADR.

1. **The browser's local project data is the project source of truth.**
2. **Losing a simulation session — for any reason — cannot lose project work.**
3. **Ordinary circuit simulation without an MCU does not require the server.**
4. **WAN latency is never inside the MCU <-> electrical feedback loop.** QEMU, bridge and engine
   are co-located in one Session Host.
5. **The classic ESP32 is never silently replaced** by another MCU or ESP32 family member. Images
   for other targets are rejected.
6. **Persisted engineering and project data is language-independent.**
7. **Changing UI language never rewrites project data,** including user-authored text.
8. **There is one electrical engine.** Browser and server run the same build; results are
   cross-checked for bit-identity.
9. **Runtime state and persistent project state are separate concepts and separate types.**
10. **Feasibility experiments stay separate from production code** unless deliberately promoted,
    and promotion is recorded.
11. **Simulation causality is defined in simulation time, never by host wall-clock scheduling.**
    Wall-clock time never influences an electrical value, an event's order, or the instant at which
    an input reaches the firmware (§7).
12. **The simulation service cannot mutate authoritative project state.** It has no write path, and
    live changes are persisted by the browser before they are mirrored to a session (§2.2).
13. **Unsupported behaviour fails explicitly** (unknown component, non-convergence, unsupported
    flash mode, wrong target). It is never approximated silently.
14. **Untrusted firmware runs only inside a per-session, network-less, resource-limited QEMU
    process.**
15. **QEMU stays behind a process boundary** and is never linked into, or shipped with, the browser
    application.
16. **Deterministic does not mean cycle-accurate.** Reproducibility (deterministic causality), fidelity
    to real ESP32 timing, and execution speed are separate properties, and each is claimed only as far
    as it has been measured (§7).
17. **Production capacity claims require representative measurements** (§12.3).
18. **The ESP32 feature is not V1-ready until the integrated closed loop satisfies the determinism
    contract** (§7.3, release gate R-MCU-1).

---

## 18. Decisions, assumptions, open questions and risks

### 18.1 Decisions made in this document

| # | Decision | Record |
|---|---|---|
| 1 | The browser owns the project; the server owns only ephemeral sessions | ADR-001 |
| 2 | Two execution modes, derived from the snapshot: A (no MCU) local, B (MCU) hybrid | ADR-002 |
| 3 | Classic ESP32 runs server-side in V1 | ADR-003 (from Sprint 0 B1) |
| 4 | QEMU, bridge and engine co-located per session; the WebSocket carries only commands and throttled frames | ADR-004 |
| 5 | Language-neutral project schema; user text verbatim | ADR-005 |
| 6 | QEMU is a separate GPL-2.0 process, server-side only | ADR-006 (from Sprint 0 B2) |
| 7 | Simulation time = QEMU virtual clock under `icount shift=3,sleep=off`. Closed-loop determinism contract R-MCU-1 is a release gate for ESP32 | ADR-007, §7.3 |
| 8 | One electrical engine package, two hosts | ADR-008 |
| 9 | Topology immutable during a session; edits = controlled restart; runtime controls dynamic | §5.1 |
| 10 | `reset` = ESP32 EN event within the run; `stop` = back to t = 0 | §5.1 |
| 11 | An MCU in the circuit always means Mode B; no "absent MCU" approximation | §4.3 |
| 12 | WebSocket; JSON control, binary firmware upload; full-state resync on reattach | §6 |
| 13 | QIO firmware rejected with a diagnostic, never converted (DIO required) | §10, P7 |
| 14 | Synchronous bridge: exchanges run on the emulator thread under the BQL; responses apply at zero elapsed simulation time | §7.4 |
| 15 | Runtime commands apply only at the periodic virtual-time tick (quantized to the tick) | §7.4 |
| 16 | The APP-CPU reset is synchronous under icount (QEMU machine fix), and a `sleep=off` warp is refused while a vCPU slice is in flight (QEMU core fix) | §7.4 |
| 18 | Every session boots from a fresh copy of the hash-verified firmware artifact; the artifact is never attached writable | §7.4, §11 |
| 17 | `hostCommandQuantum` (the tick) is part of `runtimeVersion`. **Approved V1 default: 1 ms simulated** (P9); internally configurable, product-exposed only at 1 ms | §7.6, §14 |

### 18.2 Assumptions

- No V1 user data exists yet, so schema v2 can start clean (Gate D v1 is feasibility-only).
- One QEMU process per active MCU session is **required** (§11). Whether each session also gets its own
  Session Host process is an implementation choice. It is assumed acceptable at V1 scale, pending the
  capacity gate (§12.3).
- Firmware images stay ≤ 4 MB (validated flash layout).
- UI frames at ≤ 20 Hz are sufficient for V1 presentation.

### 18.3 PM decisions (recorded 2026-09-22)

| # | Decision |
|---|---|
| P1 | **Closed-loop determinism (formerly "G2", now contract R-MCU-1, §7.3) is required** before the ESP32 simulation feature is V1-ready. Solver-only determinism (formerly "G1") remains valid evidence but is not sufficient. This gates the MCU feature only; browser-local non-MCU simulation is not blocked. |
| P2 | **Benchmark production-class hardware** before capacity or infrastructure commitments. This does not block general product implementation. |
| P3 | **The V1 product uses deterministic simulation mode only.** Wall-clock / real-time mode is engineering and debug only. |
| P4 | **Investigate start-up timing now**, as part of timing fidelity (§7.5). |
| P5 | Initial, configurable **session policy**: on disconnect, pause; reconnect grace **60 s**; paused/disconnected idle timeout **10 min**; maximum continuous active run **2 h**; active MCU sessions per user **1**. |
| P6 | **Authentication, authorization and resource limiting are mandatory before public exposure** of the simulation service. Not implemented in Sprint 1. |
| P7 | **Reject QIO firmware** with a clear diagnostic. Do not silently convert or rewrite firmware on the server. DIO is the supported V1 configuration unless runtime support changes. |
| P9 | **`hostCommandQuantum` = 1 ms of simulated time is the approved V1 default.** It is the scheduling quantum for host/runtime commands and part of the reproducibility configuration; it is internally configurable but V1 exposes only the 1 ms product mode. It is not the solver timestep, GPIO/PWM resolution, instruction resolution, or evidence of cycle accuracy (§7.6). |
| P10 | **The full-chip reset gap does not block Sprint 1 closure.** `esp_restart()`, watchdog reset and in-place UI/EN reset stay **unsupported and open**: each must satisfy the same deterministic closed-loop release gate (R-MCU-1) before the product exposes it as supported. Not implemented now. |
| P8 | **Prove the deterministic closed loop first** (done in Sprint 1 closure, §7.4). Then port and minimize the GPIO work onto a maintained Espressif QEMU baseline **before** productionizing the simulation service or expanding MCU peripheral scope. |

### 18.4 Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Deterministic mode too slow on production hosts | Simulation visibly slower than real time | Measure (P2); pace display honestly; faster cores |
| R2 | Determinism regresses: a new peripheral, the Espressif-baseline port (P8) or a QEMU rebase reintroduces a host-timing path | R-MCU-1 fails | The release-gate test runs with main-loop stress; each new feature extends it. Known open paths: full-system reset, sleep (§7.4) |
| R3 | Emulated boot timing is not faithful; it depends on the dual-core scheduling quantum | 0.38 s to `setup()` at a 1 ms tick (0.89 s without a tick) | Root cause found (§7.5). Tick fixed per `runtimeVersion`. Boot time is documented as non-representative |
| R11 | Upstream QEMU core changes (warp-race fix) must be carried through rebases | Determinism regresses silently on a rebase | Pinned release-gate fingerprints; offer the fix upstream |
| R4 | ~1 core per active session | Hosting cost | Pacing; pause idle and detached sessions; measure (P2) |
| R5 | Carrying QEMU fork patches (GPIO, bridge, fixes) | Maintenance on Espressif rebases | Preference A baseline; offer fixes upstream |
| R6 | GPL obligations for the server-side QEMU | Compliance | Process boundary; provenance manifest; legal review before distribution |
| R7 | Engine divergence between hosts | Different physics in A and B | Single build; bit-identity CI test |
| R8 | `shift=3` virtual CPU is ~1.9x slower than real silicon for instruction-bound code | Timing-sensitive firmware behaves differently from hardware | Documented; peripheral-timer timing agrees to < 0.06 %; revisit `shift` once stable |
| R9 | Full-chip reset (`esp_restart`, WDT, in-place UI/EN reset) is still asynchronous | Those paths are not deterministic | Declared unsupported and open (P10). Each must pass R-MCU-1 before the product exposes it |
| R10 | Command timing is quantized to `hostCommandQuantum` (1 ms) | A command lands up to one quantum after its requested instant | Record and echo the actual application instant; document the quantum |

### 18.5 Promotion plan (for later sprints, not Sprint 1)

| Feasibility code | Promoted to | Changes allowed |
|---|---|---|
| `gate-a-electrical/src` + `gate-c-bridge/src/pinModel.ts` | Electrical Engine package | packaging, compile-from-snapshot front end; **physics untouched** |
| `gate-c-bridge/src/bridge.ts` + `sprint-1-spikes/closed-loop/` | Session Host bridge | synchronous (syncsock) protocol, tick-scheduled commands |
| `gate-c-bridge/qemu-patch/*` + Sprint 1 bridge diff + APP-CPU reset and icount warp patches | production QEMU patch set (on the Espressif baseline, P8) | provenance manifest |
| `gate-d-persistence/src` | Project Store | schema v2, migrations |

Every promotion is a deliberate, reviewed step with its own tests carried over, per invariant 10.
