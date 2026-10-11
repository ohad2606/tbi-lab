# Runtime R2: Session Host, protocol, lifecycle and isolation (report)

Branch `runtime-r2`, based on `main` = `73d1eae` (tag `product-alpha-maintenance-complete`).
Runtime: the closed R1 baseline `979f09d739382157` (Espressif QEMU `40edccac` + patches
0001–0005). R2 does not modify the R1 runtime, patches, firmware or provisioning.

**This is engineering validation of one host, not production-capacity validation.** Every limit
below is an engineering control with a default. None of them is a capacity claim. All
measurements come from a 1-vCPU, 4 GB aarch64 development host.

## 1. Architecture

```
 Browser (owns the project; local-first; persists every edit first)
   |  HTTPS/WAN: JSON requests + Server-Sent Events (high-level only)
   v
 Session Host process (runtime/host)            one per machine; no global session state
   SessionHost   registry, admission, leases, housekeeping, private temp root (0700)
   HostSession   one per session, nothing shared:
     private dir s-<id>/ (0700)  flash.bin (0600, verified copy of the immutable artifact)
     EngineSession               the SAME production engine the browser runs (packages/engine)
     command queue, event log    bounded, per session
     R1 harness runSession() ---- loopback TCP (127.0.0.1, per-session port) ----+
                                                                                 v
                                     qemu-system-xtensa (one per session, minimal env)
                                     tbi-bridge: synchronous H/G/T/S <-> I/R/Q/C
```

The MCU ↔ electrical loop runs entirely inside the host machine:

1. A pad event (`G`) blocks the guest.
2. The host solves the circuit with `EngineSession`.
3. The host replies with the input levels (`I`) at the pad event's own simulation time.
4. The guest resumes.

The WAN only carries lifecycle requests, commands and coalesced events. QEMU, the bridge, the
engine, the command schedule and the session state are co-located. No stop condition was
reached; §21 gives the evidence.

Components (all new code is under `runtime/host/`, except for the engine extension):

| File | Role |
|---|---|
| `protocol.ts` | Frozen protocol `tbi-lab.session/1`: types, strict validators (pure) |
| `stateMachine.ts` | Lifecycle (pure) |
| `eventLog.ts` | Bounded, ordered event log with replay and resync (pure) |
| `config.ts` | Engineering controls and defaults |
| `session.ts` | `HostSession`: artifact verification, private copy, engine, bridge handlers, queue |
| `host.ts` | `SessionHost`: registry, tokens, leases, limits, shutdown, stale-root recovery |
| `http.ts` | HTTP/SSE adapter (`node:http` only) |
| `main.ts` | Process entry; `npm run host:build` bundles it to `runtime/host/dist/session-host.mjs` |
| `packages/engine/src/session.ts` | `EngineSession` gains optional MCU pad attachments (below) |
| `runtime/harness/session.ts` | R1 harness: new *optional* R2 controls (below) |

### Engine extension (same physics, no fork)

`new EngineSession(snapshot, { pins })` attaches board pads to component terminals. Each
attachment adds the production `GpioPin` device between that node and GND, which is the device
the R1 electrical tests already validated. `setPinMode(gpio, 'input'|'output-high'|'output-low')`
is transient session state. Without attachments, the outcome is byte-identical to the browser
outcome (tested). Invalid attachments are refused with `invalid_attachment`. No new device,
model or solver was added.

### R1 harness extension (backward compatible)

`runSession` gains optional `signal` (abort, then SIGTERM, then SIGKILL after `killGraceMs`),
`env`, `startupTimeoutMs`, `quitGraceMs` and `killGraceMs`, plus the outcomes `start_timeout`
and `terminated`. Each option defaults to the R1 behaviour.

One behaviour change: a stall is now counted only after the bridge handshake. Before the
handshake, the startup timeout (or R1's wall timeout) owns the failure. Without this, a slow
start was reported as `stalled` instead of `start_timeout`. §16 records the R1 suite re-run.

## 2. State machine

```
creating --prepared--> ready --run--> running --stop/terminate--> stopping --exit--> ended
   |  \--> ended          | \--> ended      \--> failed                  \--> failed
   \--> failed            \--> failed
```

- `creating`: the host verifies the artifact, makes the private copy, checks capabilities and
  compiles the circuit. No QEMU exists yet.
- `ready`: prepared, no QEMU. `run` starts a fresh boot, and is accepted exactly once.
- `running`: QEMU, the bridge and the engine are live.
- `stopping`: an orderly quit or terminate is in progress.
- `ended` / `failed`: terminal. Both carry a reason and are reported only after the QEMU process
  has exited and the private directory has been removed.
- Terminal sessions stay inspectable (status plus the final events) for `retainEndedMs`, then
  disappear.
- No transition leaves a terminal state. There is no restart and no reset. Full-chip reset is
  unsupported: a clean reset means a new session.
- A guest `esp_restart` is reported as `failed(guest_reset)` and is never repeated.
- `stop` and `terminate` are idempotent: a second call returns the same completion.

**A session is one-shot (binding for S6).** One Session Host session is exactly one execution:
one boot of one private flash copy. `stop` ends that execution: the session goes to
`ended(stopped)`, its QEMU and private flash are gone, and it can never run again (`run` is
accepted only in `ready`, which is never re-entered). A later product-level **Run** therefore
creates a **fresh session** from the browser's current persisted project revision; it never
resumes or restarts a stopped one. Product "pause/resume" is not a Session Host operation.

Reasons:

- `ended`: `stopped`, `terminated`, `lease_expired`, `lifetime_exceeded`, `host_shutdown`.
- `failed`: `artifact_unknown`, `artifact_hash_mismatch`, `artifact_missing`,
  `unsupported_feature`, `invalid_attachment`, `electrical_error`, `mirror_failed`,
  `start_failed`, `start_timeout`, `stalled`, `runtime_crashed`, `runtime_protocol_error`,
  `host_protocol_error`, `bridge_lost`, `guest_reset`, `storage_limit`, `internal`.

## 3. Protocol `tbi-lab.session/1` (frozen)

The API is the smallest practical one: `GET /health` plus seven session routes (create, status,
run, stop, terminate, commands, event stream), eight routes in all.

| Route | Result |
|---|---|
| `GET /health` | protocol version and session counts by state (no identifiers) |
| `POST /sessions` | 201 `{sessionId, token, status}`; 400 invalid; 429 session limit; 503 shutting down |
| `GET /sessions/:id` | status: state, reason, detail, simNs, lastEventSeq, times, runtime pid/outcome, mirror `revisions` |
| `POST /sessions/:id/run` | 202; 409 if not `ready` |
| `POST /sessions/:id/stop` | 202; idempotent |
| `DELETE /sessions/:id` | terminate; answers once resources are released; idempotent |
| `POST /sessions/:id/commands` | 202 accepted / 409 rejected (with reason; mirrors also return `revisions`); 400 malformed |
| `GET /sessions/:id/events` | Server-Sent Events; resume with `Last-Event-ID` or `?after=` (400 malformed, 409 ahead of the stream; see §5) |

- **Create body:**
  - `protocol`;
  - `artifact: {sha256}`;
  - `board: 'board.esp32_devkitc_wroom32'`;
  - `circuit`, the browser's `SimulationSnapshot` of the project revision;
  - `attachments: [{gpio, component, terminal}]`;
  - optional `firmwareFeatures: {internalPull?, gpioInterrupt?}`;
  - optional `limits: {maxLifetimeMs}`, which can only tighten the host limit;
  - `commandQuantumUs`, for tests only.
- **Validation:** unknown fields are refused. Validation is total and never throws.
- **Authentication:** every session route needs that session's token, as
  `Authorization: Bearer`, or as `?token=` for EventSource. An unknown ID and a wrong token give
  the same 404.
- **Session IDs:** 128-bit random hex. Tokens are 192-bit random; only their SHA-256 is stored,
  and comparison is constant-time.

## 4. Persistent vs mirror vs transient

The category is an explicit field on every command (`category: 'mirror' | 'transient'`). It is
never inferred from names or payload shape. Lifecycle operations are separate routes and are
never commands.

| Directive category | Wire representation | Semantics |
|---|---|---|
| **A. Persistent edit** (toggle position, PSU output, PSU setpoint / current limit) | *No runtime message.* The edit happens only in the browser and is persisted there first. | The runtime is never the source of truth. The session starts from a snapshot of a persisted revision. |
| **B. Live mirror** of A | `category:'mirror'`, with a required `projectRevision` (the revision in which the browser persisted the value), `component`, `control` | Applied at a command tick through `EngineSession.applyControl` (the same code path as the browser). If it cannot be applied, the command is rejected (`unsupported_control`) and the session ends `failed(mirror_failed)`: it no longer represents the project and says so. The project is untouched. |
| **C. Transient** | `category:'transient'`, `action: press/release`, `component` | Runtime-only (push buttons). Never enters a project. A rejected transient never fails the session. |

### Mirror revision semantics (browser authority, mechanically enforced)

- Every `category:'mirror'` command must carry `projectRevision` (a non-negative integer);
  validation refuses a mirror without it (400). A `transient` command must not carry one (400):
  transients take no part in revision semantics and never change the revisions below.
- Per session the host keeps `revisions = {snapshot, accepted, applied}`:
  - `snapshot`: the revision of the snapshot the session was created from;
  - `accepted`: the highest mirror revision accepted into the queue (starts at `snapshot`);
  - `applied`: the highest revision the runtime actually represents (starts at `snapshot`).
- On receipt a mirror is rejected, never guessed or applied:
  - `stale_revision` if `projectRevision < accepted` (an older edit arriving late; whatever it
    carries never reaches the engine);
  - `duplicate_revision` if `projectRevision == accepted` (a retry of an already accepted edit,
    or the snapshot's own revision).
  Accepted mirrors therefore carry strictly increasing revisions. Gaps are allowed (the browser's
  revision is the authority; revisions need not be contiguous). One persisted edit is one mirror;
  several controls of one component edited together go in one `control` object.
- A mirror refused for any other reason (`late`, `out_of_order`, `queue_full`, ...) does not
  consume its revision: the browser may resend it with a new `seq`.
- Retries are idempotent twice over: the same `seq` is `duplicate`, the same revision under a new
  `seq` is `duplicate_revision`. One persisted edit can never become a second runtime mutation.
- At apply time (command tick, client order) the host checks again that the revision is above
  `applied` (defence in depth; unreachable through `submit`), applies it through
  `EngineSession.applyControl`, and only then sets `applied` to it.
- Surfaces that tell the browser where the runtime stands:
  - the command response (202/409) for a mirror includes `revisions`;
  - every `command` event for a mirror (applied or rejected) carries its `projectRevision`;
    transient acks carry none;
  - `GET /sessions/:id` includes `revisions`;
  - every `electrical` outcome carries the engine's `appliedRevision`.
  The session represents browser revision R when `revisions.applied >= R` and the session is not
  failed. `accepted > applied` means mirrors are still queued. After `failed(mirror_failed)` the
  session is stale for good: `applied` stays at the last revision that was really applied.

Structural edits (topology, adding or removing parts, resistor values) are persistent edits with
no live mirror in V1. The browser marks the session stale and creates a new one. This keeps the
protocol small and avoids a partially mirrored circuit. Recorded as decision D3.

Mirrorable controls are exactly the ones the browser engine already supports live:
`setpointVoltage`, `currentLimit`, `outputEnabled` and `closed`.

## 5. Command ordering

- The command quantum stays **1 ms of simulation time** (`COMMAND_QUANTUM_US = 1000`, ADR-007).
  It only decides when host commands become visible, at command ticks (`T` frames). Patch 0005
  keeps these ticks from shaping guest scheduling (§11).
- Each command carries a client `seq`, which must strictly increase per session, and an optional
  `atSimNs` (decimal-string nanoseconds). Without `atSimNs`, a command applies at the next tick
  after receipt.
- On receipt, the host checks in this order and rejects with a reason (logged as a `command`
  event and returned as 409):
  1. `duplicate` (`seq` ≤ last);
  2. `not_running`;
  3. `unknown_component`;
  4. mirrors only: `stale_revision` / `duplicate_revision` (§4);
  5. `late` (`atSimNs` ≤ the last tick already executed; never applied late);
  6. `out_of_order` (`atSimNs` earlier than an already queued timed command; never reordered);
  7. `queue_full` (`maxQueuedCommands`).
- A duplicate `seq` burns nothing: the last accepted `seq` still stands.
- Accepted commands apply at the first tick ≥ `atSimNs`, in client order, and are acknowledged
  (`command`, `applied`/`rejected`) with that tick's simulation time. After any applied command,
  the circuit is solved again and changed input levels are injected **in the same tick reply**,
  so the guest sees them before its next instruction.
- GPIO pad events and electrical feedback are **not** quantised. Each is solved and injected at
  the pad event's own simulation time. Nothing is rounded to 1 ms. The host's per-window
  coalescing affects only what is *published* to the client, never what the guest sees.
- **Published event order** is deterministic and documented:
  - `seq` strictly increases per session;
  - `simNs` of runtime events never decreases along `seq`;
  - at a publish point (every `publishIntervalUs`, default 10 ms of simulation time, a whole
    number of quanta), the order is: the command acks of that tick, then `gpio` (the final
    drive/level per changed pad, with its transition count, in GPIO order), then `electrical`
    (the latest operating point, only if it changed), then `serial` (base64, `dropped` count if
    the window was over `serialWindowMaxBytes`);
  - lifecycle `state` events carry `simNs: null`;
  - the same session inputs give the same event stream (§11).
- **Sampled state publication, not a lossless event trace** (clarified 2026-10-11, Sprint 12
  Gate B H-1; the wire format and `tbi-lab.session/1` are unchanged):
  - Window `k` covers simulation time `((k-1)·P, k·P]`, `P = publishIntervalUs`. Runtime activity
    is attributed to a window by **its own simulation time**, never by the time a bridge tick
    reports (QEMU can report a tick an instruction past its grid time). The window is published
    **once**, stamped `k·P`, as soon as a frame at a later time arrives (or the boundary tick
    itself has been handled). A frame stamped exactly `k·P` that arrives after the boundary tick
    goes into window `k+1`.
  - **Every window with activity is published; none is skipped, merged, repeated or reordered.**
    At the end of a session, the partial window is published once, stamped with the last frame's
    time.
  - What a window carries is **sampled state**:
    - `gpio`: per changed pad, the final drive/level plus the exact number of transitions;
      individual edges and their times are **not** published;
    - `electrical`: the operating point at the end of the window, only if it changed;
      intermediate operating points (e.g. an echo pulse that starts and ends inside one window)
      are **not** published;
    - `serial`: **lossless** up to `serialWindowMaxBytes` per window; any excess is counted in
      `dropped`, never silently lost;
    - `command` acks and `diagnostic`s are individual events, each stamped with its own time.
  - **Lossless per-edge traces are not part of the client protocol.** The guest always sees every
    edge at its own simulation time (above). Exact edge timing is verified at the bridge, and only
    by test instrumentation (`runtime/tests/*.runtime.test.ts`). A client-visible lossless trace
    (e.g. for a future logic analyser) needs its own protocol decision.
  - Tests: `runtime/host/tests/publication.test.ts`, which checks exact, single, repeated and
    persistent late ticks, events on and around a boundary, and stop/restart, all against the
    exact-tick stream.
- **Resume (SSE).** Events are held in a per-session ring (`eventLogCapacity`). The resume point
  is `Last-Event-ID` (sent by EventSource on reconnect) or `?after=`; the header wins; absent or
  empty means from the start. Validated before the stream opens:
  - malformed (anything but 1–15 decimal digits) → **400**;
  - greater than the last event the session has produced → **409** (it cannot be an id this
    stream sent; never reinterpreted as another point in the stream);
  - still retained → exactly the events after it, in `seq` order, then live events;
  - already evicted (older than the ring) → first an explicit
    `resync {seq: oldestRetained-1, missed: n}` event (SSE `id` = `oldestRetained-1`, so a
    further reconnect continues correctly), then every retained event in order. The client is
    told it lost `n` events and must treat its view as incomplete (take the next `electrical` /
    `gpio` events and `GET` status as the new baseline). It is never silently continued from the
    oldest retained event.

## 6. Lease policy (disconnect and reconnect)

- An attached event stream, or any authenticated request, keeps a session alive.
- When the last stream closes, the lease clock starts from that moment. With no stream and no
  request for `leaseMs` (default 30 s), the session ends `ended(lease_expired)` and everything is
  released.
- A client that reconnects inside the lease resumes the event stream from its `Last-Event-ID`,
  losing nothing that is still in the ring (otherwise it gets `resync`).
- The lease is wall-clock and host-side only. It never touches the simulated loop, which keeps
  running during a brief disconnect. The WAN is never in the loop.
- Project work is never at risk: the project lives in the browser. A lost session means only
  that the browser creates a new one from its persisted state.

## 7. Isolation

Each session has its own:

- 0700 directory and 0600 flash copy;
- QEMU process and minimal environment;
- loopback bridge port and socket;
- `EngineSession` instance;
- command queue, event log, serial window and timers;
- abort controller.

The host holds only the session map, its temp root and the housekeeping timer. There is no
module-level mutable state.

Evidence (§9, repeated runs):

- two concurrent sessions of one artifact: both guests write NVS and both see a fresh image
  (`TBI-NVS-BOOTS=1`, never 2);
- terminating A leaves B running, still advancing, and stoppable;
- A's ID with B's token gives 404, and the reverse too;
- two concurrent gate sessions give the byte-identical event stream of a solo run.

## 8. Limits (engineering controls; they fail closed)

Controls are set by the operator (`TBI_HOST_*` environment variables); a client can only tighten
its own lifetime. They are not capacity figures.

| Control | Default | On violation |
|---|---|---|
| `maxSessions` (live) | 4 | create → 429 |
| `maxLifetimeMs` | 30 min | `ended(lifetime_exceeded)` |
| `startupTimeoutMs` (run → handshake) | 20 s | `failed(start_timeout)` |
| `stallTimeoutMs` (< 1 ms of simulated progress) | 10 s | `failed(stalled)` |
| `maxQueuedCommands` | 256 | command rejected `queue_full` |
| `eventLogCapacity` | 4096 events | oldest dropped; a lagging client gets `resync` |
| `serialWindowMaxBytes` (per 10 ms window) | 16 KiB | excess counted in `dropped` |
| `maxSessionStorageBytes` | 16 MiB | `failed(storage_limit)` |
| `quitGraceMs` (Q → exit) | 3 s | SIGKILL; `failed(internal)` unless an end was requested |
| `killGraceMs` (SIGTERM → SIGKILL) | 2 s | SIGKILL |
| `leaseMs` | 30 s | `ended(lease_expired)` |
| `retainEndedMs` | 60 s | terminal session forgotten |
| `maxRequestBytes` | 1 MiB (commands 64 KiB) | 413 |
| SSE backlog per client | 1 MiB | stream closed; the client resumes |

## 9. Failure semantics

In every case the session reaches a terminal state with an inspectable reason. It never
restarts. No project data is involved, the artifact is unchanged, and no QEMU or private
directory remains. "R" is the real QEMU runtime (heavy suite); "F" is the fake runtime (routine
CI).

| Injected failure | Result | Evidence |
|---|---|---|
| Unknown / mismatched / vanished artifact | `failed(artifact_unknown / artifact_hash_mismatch / artifact_missing)` before any process | F |
| Invalid firmware (erased flash, correctly hashed) | `failed(stalled)`; the ROM prints `invalid header: 0xffffffff` | R |
| Malformed request (bad JSON, unknown fields, traversal, oversize, wrong type) | 400 / 413 / 415; no session created; the host keeps serving | F |
| Malformed bridge frame / time going backwards | `failed(host_protocol_error)` | F (R1: R) |
| QEMU rejects the host (malformed reply) | `failed(runtime_protocol_error)` | R1: R |
| QEMU crash (SIGSEGV) | `failed(runtime_crashed)`; one `running` state (no restart) | R ×3, F |
| Guest reset request (`esp_restart`) | `failed(guest_reset)`; booted exactly once | R ×3, F |
| Startup timeout (no handshake) | `failed(start_timeout)` | F |
| Stall | `failed(stalled)` | R, F |
| Runtime ignores SIGTERM | SIGKILL after `killGraceMs` | F |
| Duplicate / late / out-of-order / unknown-component commands | rejected with a reason; the session is unaffected | F |
| Mirror that cannot be applied | `failed(mirror_failed)`, with the seq and the error | F |
| No operating point during run (PSU paralleled) | `failed(electrical_error)`, with the engine code | F |
| Client disconnect | lease, then `ended(lease_expired)` | R (SSE, bundle), F |
| Terminate during startup / while running | `ended(terminated)` | R ×3, F |
| Host SIGTERM with active sessions | all sessions end `host_shutdown`; exit 0; temp root removed | R ×3 (bundle), F |
| Host crash (SIGKILL) | QEMU loses its bridge peer and exits by itself (R1 exit 4); the next host removes the stale root | R ×3 (bundle) |
| Serial flood / event overflow / storage growth | `dropped` counts / `resync` / `failed(storage_limit)` | F |

## 10. Security

- No shell anywhere. QEMU is started with `spawn(file, argv)`. The executable is fixed by host
  configuration (the provisioned runtime); no request field reaches argv, except numbers the host
  derived itself.
- Clients name firmware only by SHA-256 (validated as 64 lowercase hex characters). The host
  derives `<artifactsDir>/<sha>.bin` itself, so a client can never supply a path and path
  traversal is impossible. Tested with a `../` component ID, an encoded `..%2F` session path, and injected `path`/`qemu` fields, all refused.
- Every request is validated structurally and strictly:
  - unknown fields refused;
  - IDs match `^[A-Za-z][A-Za-z0-9_]{0,31}$`;
  - numbers are finite and bounded;
  - component, net and connection counts are bounded;
  - JSON only (415 otherwise);
  - size-bounded (413);
  - malformed JSON gives 400.
- Every request handler's errors are caught and turned into a response for that request (500 for an unexpected error). After the malformed-input battery, the host is tested to still be healthy with the session untouched. There is no dedicated test that forces a 500.
- QEMU runs with a minimal environment (`LANG=C`), `-monitor none`, `-display none`,
  `-no-reboot`, no QMP, and no filesystem sharing. Its only file is the private flash copy.
- Private directories are 0700 and flash copies 0600, under a per-host 0700 temp root.
- Session IDs and tokens are opaque and unguessable. A wrong token looks exactly like a missing
  session.
- The host binds `127.0.0.1` by default. It is not meant to face the internet directly
  (decision D1).
- Messages are bounded everywhere: requests, commands, per-window serial, event ring, SSE
  backlog.

## 11. Determinism and the 1 ms vs 10 ms regression

The gate workload runs through the Session Host: the R1 release-gate circuit as a real domain
project, the VEXT stimulus sent as four scheduled persistent mirrors, and TbiGpioProof.
Published event streams are hashed; state events and `seq` are excluded because they depend on
wall time.

| Case | Runs | Distinct stream hashes |
|---|---|---|
| Gate, 1 ms quantum | 5 per heavy pass | 1 (`0b6b7597506b3550` in passes 1–3; `72935ade7dce072d` from pass 4, see §16) |
| Gate, 1 ms vs 10 ms quantum (mirrors on 10 ms multiples) | 2 per pass | 1 (same hash) |
| **TbiTiming, no host commands, 1 ms vs 10 ms** | 2 per pass | 1 (`6c9dddce6df617fc`); every GPIO marker and serial byte at identical simulation times |
| Gate, two concurrent sessions vs solo | 3 per pass | 1 (same hash as above) |

The command quantum does not shape guest scheduling (R1 patch 0005 remains effective through the
host), and feedback is not rounded.

## 12. Electrical equivalence (same engine as the browser)

- **Unit level (routine CI, `packages/engine/tests/mcu-pins.test.ts`).** `EngineSession` with
  pad attachments is compared against a reference `Circuit` built from the production devices,
  to 1e-12, for:
  - resistor load;
  - LED operating point;
  - GPIO HIGH driving an LED and GPIO LOW;
  - PSU CV feeding an input through 10 kΩ (external input);
  - PSU in CC with a pad sinking LOW;
  - hysteresis hold;
  - the full R1 gate circuit at every VEXT/mode combination.

  Also covered: no attachments gives a byte-identical browser outcome; invalid attachments are
  refused; pad modes are per session.
- **End to end (heavy).** Every operating point the host published in a gate session (GPIO2
  voltage, GPIO5 voltage, LED current) was compared with the R1 reference loop's solve in force
  at that simulation time, for 41 operating points. The largest difference was **0**
  (bit-identical). Every published GPIO2 window state matched R1's pad events.

## 13. GPIO capability enforcement (R1 map `ESP32_DEVKITC_WROOM32`)

- GPIO6–11 (flash) and GPIO1/3 (console) cannot be attached: `failed(invalid_attachment)`, with
  the map's reason. Tested for 6, 9, 11, 1 and 3.
- GPIO34/35/36/39 are input-only. They can be attached as inputs. If the guest enables output on
  one, the pad **stays an input** electrically, as it does on the hardware (there is no output
  driver), and the host emits `diagnostic {warning, output_on_input_only_pad}` once per pad.
  Tested.
- GPIO32/33 are ordinary digital I/O, as in R1.
- Internal pull-ups/downs and GPIO interrupts are not simulated in V1, and the runtime cannot
  observe them (QEMU's IO_MUX/interrupt model is not implemented upstream). The mechanism is the
  create-time declaration `firmwareFeatures`: declaring either refuses the session with a
  `diagnostic {error, unsupported_feature}` and `failed(unsupported_feature)`, instead of running
  with silently dead behaviour. Populating the declaration from source analysis belongs to S7
  (decision D5).

## 14. Measurements (1 vCPU / 4 GB aarch64; evidence, not capacity)

Gate workload, per session. Ranges cover heavy passes 2 and 3 (see `r2-evidence/`).

| Metric | 1 session (×3 per pass) | 2 concurrent (each) |
|---|---|---|
| create (verify, copy, compile) | 19–27 ms | 18–23 ms |
| run → first serial byte (QEMU start + ROM boot) | 5.5–5.9 s | 11.1–11.3 s |
| wall time for 10 s of simulated time | 11.5–11.9 s | 24.1–24.2 s |
| QEMU RSS / peak RSS | 74–80 MB / 146–153 MB | 72–76 MB / 150–151 MB |
| private storage | 4 MiB (the flash copy) | 4 MiB |

Other measurements:

- lease expiry to release: 1.52–1.53 s at `leaseMs` 1.5 s;
- SSE disconnect to release: 2.07–2.27 s at 2 s;
- QEMU exit after a host SIGKILL: 50–51 ms (×3 per pass).

On one vCPU, two sessions share the core: each runs at about half speed. This measures the dev
host; it is not a capacity figure.

## 15. Tests and the CI vs heavy split

- **Routine CI (`npm test`, 453 tests in total; no QEMU, no toolchain).** A Node fake runtime
  (`runtime/host/tests/fixtures/fake-runtime.mjs`) speaks the real R1 bridge protocol. It writes
  to its private flash copy, toggles pads off the tick grid, echoes inputs and injects each
  failure mode, so the whole host is exercised in CI. Tests:
  - host: 42 (lifecycle 12, failures 19, protocol 7, http 4);
  - engine pin equivalence: 8.
- **Heavy (`npm run test:r2`; provisioned runtime, `TBI_RUNTIME_HOME`).** Builds the host bundle
  and runs 16 tests: `r2-acceptance` (5) and `r2-failures` (11). Most repeat internally (×3 or
  ×5); results go to `$TBI_RUNTIME_HOME/results/r2-*.json` and are copied to
  `docs/runtime/r2-evidence/`.
- **Full runtime suite (`npm run test:runtime`).** R1 plus R2.
- **Soak (`npm run test:r2:soak`, `R2_SOAK_MINUTES`).** Heavy-only endurance runner (§16.1). It
  is not a vitest suite and never runs in routine CI.

§16 records the repeated passes.

## 16. Evidence runs

All runs used runtime `979f09d739382157`.

| Run | Content | Result |
|---|---|---|
| Heavy pass 1 (`npm run test:r2`) | R2 heavy, 16 tests | 16/16 ✓ |
| Heavy pass 2 (`npm run test:r2`) | R2 heavy, 16 tests | 16/16 ✓ |
| Heavy pass 3 (`npm run test:runtime`) | full runtime suite: R1 (59) + R2 (16) | 75/75 ✓ (R1 unaffected by the harness extension) |
| Heavy pass 4 (`npm run test:r2`, pre-push audit code) | R2 heavy, 16 tests | 16/16 ✓ |
| Routine: `npm test` (pre-push audit code) | unit, product, host (fake runtime), engine | 453/453 ✓ (host suite ×3 consecutive: 42/42) |
| Routine: typecheck, lint, boundaries | | ✓ |
| `npm run test:e2e` / `npm run test:browser` | product app / browser engine | 77/77 ✓ / 4/4 ✓ |

Pass 1 started before the last two host edits (the input-only pad guard, and removing an unused
reason from the frozen protocol); passes 2 and 3 ran the final code.

Every hash was identical across all three passes:

- gate: `0b6b7597506b3550` (5 per pass, plus 2 in the quantum case and 3 concurrent);
- TbiTiming at 1 ms and 10 ms: `6c9dddce6df617fc`;
- electrical equivalence: 41 operating points, largest difference 0.

Evidence JSON for passes 2, 3 and 4: `docs/runtime/r2-evidence/runtime-979f09d739382157/`.
**Pre-push audit (pass 4).** Mirror `command` events now carry `projectRevision` (§4). The gate
stream contains the mirror acks, so its hash changed from `0b6b7597506b3550` to
`72935ade7dce072d`. A real gate session hashed both ways shows that this is the only change: the
new stream hashes to `72935ade7dce072d`, and with the new field stripped from the acks it hashes
to the pre-audit `0b6b7597506b3550`. Pass 4 results:

- gate: one hash ×5, identical at 1 ms and 10 ms, and ×3 concurrent;
- TbiTiming (no commands): unchanged, `6c9dddce6df617fc` at both quanta;
- electrical equivalence: 41 operating points, largest difference 0;
- isolation, failure injection and cleanup: unchanged.

The audit did not touch the shared R1 harness or runtime, so R1 was not re-run. Evidence:
`r2-*.pass4.json`.

Hygiene found during the runs:

- The routine host-test helper leaked a 4 MiB artifact directory per test host into `/tmp`
  (270 found; this filled the 2 GB tmpfs on the dev host). Fixed: directories are removed after
  each test file. Verified at zero after three consecutive runs.
- The closed R1 test `failures.runtime.test.ts` leaves `tbi-invalid-fw-<pid>.bin` (4 MiB) in
  `/tmp` per run. It was not modified (R1 baseline); recorded for a future R1 maintenance item.
- No Session Host root or session directory survived any R2 run. One leftover root came from an
  early development build, before stale-root recovery existed; it was removed by hand.

### 16.1 Overnight soak (pre-push endurance gate)

**This is engineering endurance evidence from one 1-vCPU / 4 GB aarch64 host. It is NOT a
capacity benchmark and makes no capacity claim.**

**Setup**

- Harness: `runtime/soak/r2-soak.ts`, run with
  `TBI_RUNTIME_HOME=<provisioned home> R2_SOAK_MINUTES=480 npm run test:r2:soak`. It is
  heavy-only and never runs in routine CI.
- Each round rotates through six phases:
  - A: lifecycle churn;
  - B: concurrent isolation;
  - C: long deterministic sessions;
  - D: mirror/transient command stress;
  - E: SSE reconnect / bounded log;
  - F: failure injection and host-process recovery.
- Every random choice is seeded per (seed, round, phase). `R2_SOAK_REPLAY=<phase>:<round>`
  replays one phase instance. The replay is exact for A, B, C and F; for D and E it reproduces
  the command and connection sequence, but submit timing relative to simulation time follows
  wall clock.
- Hard failures stop the run and preserve the evidence:
  - orphan QEMU;
  - leaked private directory;
  - artifact mutation;
  - cross-session contamination;
  - command-order or revision invariant violation;
  - silent SSE loss;
  - event-order or determinism divergence;
  - a limit not enforced.
- SIGINT, SIGTERM and SIGHUP release every host, child host and QEMU and remove the soak's
  private temporary root.

**Run**

| | |
|---|---|
| Start / end | 2026-09-24T22:12:59Z / 2026-09-25T06:13:39Z |
| Wall time | 480.7 min, budget 480; the last phase finished past the budget |
| Git | `d9d3e14` plus this harness, uncommitted at run time |
| Harness sha256 | `r2-soak.ts` `c859da18…0d12`; `r2-support.ts` `f1124061…df1b` (identical to the committed files) |
| Seed | 20260925 |
| Runtime | `979f09d739382157` (QEMU 9.2.2) |
| Node | v24.21.0 |
| Host | Neoverse-N1 ×1, 3.8 GiB |
| Verdict | **PASSED**: 0 failures, 0 warnings |
| Evidence | `r2-evidence/runtime-979f09d739382157/r2-soak-20260924T221259Z.json`, including 1,667 telemetry samples |

**Phases** (118 rounds)

| Phase | Runs | Content |
|---|---|---|
| A | 118 | 472 lifecycles: 236 stop, 118 terminate, 118 terminate-early. Every one had a fresh flash copy equal to the artifact and `TBI-NVS-BOOTS=1`. Plus 118 session-limit (429) checks. |
| B | 118 | Concurrent TbiNvs pairs: both `BOOTS=1`; tokens never cross; the survivor keeps advancing (A terminated first 59 times, B first 59 times). Concurrent gate pairs: 236 streams, all equal to the solo reference. |
| C | 117 | TbiTiming for 30 s at 1 ms and 10 ms, and the gate with scheduled mirrors for 120 s (59 runs at 1 ms, 58 at 10 ms). Also, in every run, an R1 reference-loop equivalence check. |
| D | 117 | 17,048 command batches; details below. |
| E | 117 | 3,393 SSE connections; details below. |
| F | 117 | Each of these 117 times: crash, guest reset, stall, start failure, terminate during startup, terminate while running, lease, lifetime, host SIGTERM, host SIGKILL plus restart. |

Totals:

- 3,405 sessions created, 3,405 released and verified (QEMU gone, private directory gone);
- 705 checkpoints, each checking for orphans, leaks and artifact hashes;
- 635,336 events.

**Determinism** (every value identical in every run)

| Workload | Hash | Runs |
|---|---|---|
| Gate, 15.5 s | `72935ade7dce072d` | 353 (B concurrent + C) |
| Long-gate prefix | `72935ade7dce072d` | 117 |
| Long gate, 120 s | `a86b3e0ad86eef28` | 117 (1 ms: 59; 10 ms: 58) |
| TbiTiming, 30 s | `6c9dddce6df617fc` | 234 (117 × 1 ms and 10 ms) |

- TbiTiming is idle after setup, so its 30 s hash equals its 4 s hash.
- 1 ms vs 10 ms equal with no commands: 117/117.
- Electrical equivalence against the R1 reference loop: 4,797 operating points, largest
  absolute difference 8.9e-16 (tolerance 1e-9).
- The reference loop's 9,477 off-grid pad events confirm that feedback isn't quantised.

**Commands (D)**

- 259,861 submitted; 182,228 accepted.
- 160,107 applied, each exactly once and in client order.
- The accepted commands not applied were the ones still queued when a session was stopped
  (C long-gate tails and D batch ends).
- Rejected, each with the expected reason:

  | Reason | Count |
  |---|---|
  | `stale_revision` | 15,362 |
  | `duplicate_revision` | 15,563 |
  | `duplicate` | 10,177 |
  | `late` | 13,506 |
  | `out_of_order` | 11,733 |
  | `queue_full` | 11,292 (at the exact bound, 16) |

- Revision checks after every command and every 25 ms:
  - `accepted` and `applied` never moved backwards;
  - `accepted > applied` held exactly while mirrors were queued;
  - every electrical outcome's `appliedRevision`, PSU setpoint, switch and button state matched
    the accepted commands;
  - rejected commands never changed the engine;
  - transient commands never touched revisions.
- The bounded event log (128 events) wrapped 3,476 times in total across D and E, and never
  exceeded its capacity.

**SSE (E)**

- 819 resync markers, each with the exact `missed` count (33,345 events in total). No
  unmarked gaps, duplicates or reordering in 47,970 validated events.
- 468 each: retained replays, current-id replays and post-resync continuations.
- 936 each: malformed ids refused (400), future ids refused (409) and header-vs-`?after=`
  precedence checks.
- 117 lease expiries after repeated attach/detach.

**Cleanup**

- 0 orphan QEMU at any of 705 checkpoints.
- QEMU exited on its own after a host SIGKILL in about 25 ms on average (2,922 ms over 117).
- The next host removed the stale root every time.
- Artifacts identical before and after.
- The soak added no `tbi-*` entries to the global temp directory.
- Teardown: no QEMU left, private root removed.

**Telemetry** (start / min / max / final)

| Metric | Start | Min | Max | Final |
|---|---|---|---|---|
| Soak-process RSS (in-process Session Host + harness) | 180 MB | 129 MB | 276 MB | 264 MB |
| JS heap | 38 MB | 17 MB | 40 MB | 25 MB |
| FDs | 24 | 24 | 34 | 24 |
| Concurrent QEMU | 0 | 0 | 2 | 0 |

- QEMU peak RSS stayed at about 146 MB in every hour.
- The soak's temporary storage stayed between 4 and 12 MiB (final 4 MiB: the erased test image).
- Free space in `/tmp` stayed between 1.246 and 1.255 GB.

**Trend flagged for PM review (not a failure).** Soak-process RSS rose from an hourly median of
211 MB (hour 0) to 249 MB (hour 4), then stayed flat at 249–251 MB through hour 8:

| Hour | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| RSS median (MB) | 211 | 214 | 227 | 238 | 249 | 250 | 251 | 251 |

Over the same period, JS heap stayed flat (about 24 MB median), and FDs and temporary storage did
not grow. The rise-then-plateau shape fits native allocator and cache growth settling, not an
accumulating leak. It should be watched in any longer-running deployment.

**Found by the shakedown (before the overnight run)**

- Four harness bugs, all fixed:
  - a false apply-time rejection;
  - long sessions hitting the host's 30 s lease: correct host behaviour, so the harness now
    renews it as a client would;
  - a long-gate schedule placing a command on the 15.5 s comparison boundary;
  - a routine-test helper that couldn't be reused outside vitest.
- One unresolved event: a single stall case in a shakedown ended `stalled` without the ROM's
  `invalid header` line. It didn't reproduce in 4 replays or in 117 overnight runs.
  - Suspected cause (not proven): CPU starvation on the 1-vCPU host, which the 3 s stall
    detector would have interpreted as no progress.
  - That case's window was widened to 5 s, and diagnostics were added.
- No host, protocol or runtime code changed after the pre-push audit (`d9d3e14`).

## 17. Unsupported behaviour (explicit)

- Full-chip reset and guest `esp_restart`: the session fails with `guest_reset`; a new session is
  required.
- Structural or topology edits during a run: they are not mirrored; the browser starts a new
  session.
- Internal pulls and GPIO interrupts: refused when declared; not detectable at runtime (S7
  provides the declaration).
- Real-time pacing: sessions run unpaced, as fast as the host allows, which is close to real time
  on this host. Pacing policy is open (D2).
- Electrical failure mid-run (no operating point): the session fails with `electrical_error`. It
  is not paused.
- The board ground is assumed to be the circuit reference (GND1).
- Reattaching to a terminal session: impossible by design.
- More than one board per session, or multiple MCUs: out of scope.

## 18. Open deployment decisions (constrain S6 and deployment)

- **D1 — exposure and authentication.** The host binds loopback and uses per-session bearer
  tokens. A deployment needs TLS and user authentication in front of it (a proxy). SSE uses
  `?token=`, which a proxy must not log.
- **D2 — pacing.** Unpaced simulation versus wall-clock pacing, and what the UI shows when
  simulation runs slower than real time.
- **D3 — structural edits.** Restart on edit. **Confirmed by the PM** (2026-09-24).
- **D4 — bridge transport.** The bridge uses a loopback TCP port per session, which is safe on a
  single-tenant host. On a multi-tenant host it would need a Unix socket or a network namespace
  (a runtime patch change, deferred).
- **D5 — the `firmwareFeatures` declaration** must be produced by the S7 build (source/ELF
  analysis). Until then, the browser declares what it knows.
- **D6 — per-host limits.** The defaults are placeholders pending real load testing, and
  `maxSessions` must be sized to cores.
- **D7 — process sandboxing** beyond a minimal environment (cgroups/rlimits, seccomp, a separate
  user) for public deployment.
- **D8 — artifact distribution.** Artifacts are provisioned by `provision.sh`; no ROM
  redistribution is needed now.

## 19. Readiness

R2's acceptance evidence is complete for one engineering host. The evidence shows:

- create → run → stop → cleanup;
- every injected failure reaching an inspectable terminal state with cleanup;
- lease expiry after a disconnect;
- two concurrent isolated sessions;
- the artifact never modified;
- fresh writable state in every session;
- deterministic command ordering;
- identical guest timelines at 1 ms and 10 ms command quanta;
- synchronous, unquantised GPIO/electrical feedback;
- browser/server electrical equivalence (same engine, bit-identical results);
- no orphan process or directory after a QEMU crash, a host SIGTERM or a host SIGKILL.

Every item was repeated (×3 or ×5 inside each pass, across 4 passes). It was then repeated
throughout an 8-hour overnight soak on the final code (§16.1: 3,405 sessions, 0 failures).

No stop condition was reached:

- the WAN is not in the loop;
- the quantum stays decoupled;
- the browser keeps ownership of the project;
- one physics implementation;
- no shared mutable QEMU or flash state;
- no ROM redistribution;
- R1 scheduling unchanged.

R2 is **not** validated for production capacity, public exposure or multi-tenant hosting. That
needs D1, D4, D6 and D7. S6 can build on the frozen protocol `tbi-lab.session/1`, taking D2, D3
(confirmed by the PM: restart on structural edit) and D5 into account.

## 20. R2 closure record (2026-09-25)

Runtime R2 passed PM review, implementation CI and the overnight endurance gate. It is
**closed**.

**Baseline and results**

| Item | Record |
|---|---|
| Final implementation baseline | `76c3b799600105f36e8aad78981c33f42073a48a` (on `main` as a fast-forward from `73d1eae`) |
| Implementation CI | GitHub Actions run `36113974192`: PASS (typecheck, lint, unit/domain/host tests, E2E, browser acceptance) |
| Routine baseline | `npm test` 453/453; E2E 77/77; browser 4/4; typecheck, lint and boundaries clean |
| Heavy acceptance | R2 heavy suite 16/16 on the final protocol code (§16, pass 4); earlier R1 regression 75/75, including R1 59/59 (§16, pass 3) |
| Overnight soak | 480.7 min, seed 20260925, 3,405 sessions created and released, 0 failures, 0 warnings (§16.1) |
| Soak evidence | `docs/runtime/r2-evidence/runtime-979f09d739382157/r2-soak-20260924T221259Z.json` |

**Frozen contract: `tbi-lab.session/1`**

- **The browser remains the project authority.** The runtime only mirrors persisted edits. A
  mirror carries its `projectRevision`, and the session reports
  `revisions = {snapshot, accepted, applied}` (§4).
- **Mirror revisions.** A stale mirror (`stale_revision`) or a duplicate one
  (`duplicate_revision`, or a repeated `seq`, `duplicate`) is rejected and never mutates the
  runtime. A rejected mirror does not consume its revision. Retries are idempotent. Transient
  commands take no part in revision semantics.
- **SSE resume after event-log eviction** starts with an explicit
  `resync {missed}` marker. A malformed `Last-Event-ID` is refused with 400 and a future one
  with 409. History is never skipped silently (§5).
- **Sessions are one-shot (binding for S6).** Stop ends that execution session. A later
  product-level Run creates a fresh session and never resumes a stopped one. Full-chip reset
  remains unsupported.

**Architecture invariants**

- The WAN stays outside the MCU ↔ electrical feedback loop.
- The browser and the Session Host share one production electrical implementation.
- Firmware artifacts are immutable. Each session writes only its private copy, which is
  discarded at the end.
- `hostCommandQuantum = 1 ms simulated time` only schedules commands. It is not a CPU, GPIO,
  solver or instruction timestep.

**Limits and observations**

- No production-capacity claim is made. Public or multi-tenant deployment still requires D1,
  D4, D6 and D7 (§18).
- The soak-process RSS rise and plateau (§16.1) is a deployment observation, not a demonstrated
  leak.
- The single shakedown stall case without the ROM line (§16.1) remains documented and is
  non-blocking.

Sprint 6 has not started.
