# Sprint 6 — ESP32 Product Integration

**Status:** CLOSED (2026-09-27, §21). The long integrated endurance run is **deferred** by the
PM to post-S7 / pre-S8; it is not recorded as passed.
**Date:** 2026-09-26 · **Base:** `main` = `d04978d` · **Runtime foundation:**
`runtime-r2-complete^{}` = `db93cfe` (R1 runtime `979f09d739382157`, protocol
`tbi-lab.session/1`), unchanged.
**Implementation:** `19320ac` … `b959feb` on branch `sprint-6` (worktree `~/projects/tbi-lab-s6`);
closure record in §21.

## 1. Outcome

For the first time the Product Alpha browser runs a **Classic ESP32 DevKitC** project through the
frozen **R2 Session Host**:

1. place the ESP32 DevKitC from the palette and choose a prebuilt firmware in the inspector;
2. press **Run**: the browser builds an explicit snapshot of the persisted project and creates an
   ephemeral one-shot R2 session;
3. QEMU boots the ESP32; GPIO and the circuit interact in closed loop **on the server**, solved
   by the same production engine the browser uses;
4. the browser receives the ordered event stream: pin levels, operating points, serial output,
   warnings;
5. live persistent controls (toggle, PSU) are committed to the project first, then mirrored with
   their project revision; push buttons are transient runtime input;
6. **Stop** ends the session completely; the next **Run** creates a fresh one.

Ordinary DC projects are unchanged: they run in the browser-local Worker and never touch the
network. The browser remains the project authority; the server receives only the execution
snapshot and never stores anything of the project.

## 2. Architecture

```
Browser (project authority, IndexedDB, local-first)
  Run ──> SimulationDispatcher
            ├─ no MCU in the project ─> SimulationController ─> Worker (production engine)   [local]
            └─ Classic ESP32 present ─> McuSimulation ─> RuntimeClient ──HTTPS──┐           [R2]
                                                                                │ same origin
  dev-lab: Caddy :443 ─> oauth2-proxy (Google, allowlist) ─> Caddy 127.0.0.1:8080
                                                              ├─ /            static build
                                                              └─ /runtime/*   ─> Session Host 127.0.0.1:7400
                                                                                  └─ QEMU (ESP32) + engine,
                                                                                     co-located closed loop
```

| Piece | Where | Role |
|---|---|---|
| Board catalog item | `packages/domain/src/catalog.ts` | `board.esp32_devkitc_wroom32`, generated from the R1 capability map |
| Firmware list | `packages/domain/src/firmware.ts` | curated prebuilt artifacts by sha256 |
| Session snapshot | `app/src/runtime/snapshot.ts` | project → `CreateSessionRequest` |
| R2 client | `app/src/runtime/client.ts` | all HTTP/SSE transport details |
| ESP32 host | `app/src/runtime/controller.ts` | one-shot sessions behind the existing simulation contract |
| Runtime view | `app/src/runtime/view.ts` | ephemeral, bounded runtime state (never persisted) |
| Dispatch | `app/src/sim/dispatch.ts` | local versus R2 per Run |
| UI | `Canvas.tsx`, `symbols.tsx`, `McuPanel.tsx`, `SimControls.tsx`, `Palette.tsx` | board, pins, runtime panel, control |

The frozen protocol types are imported directly from `runtime/host/protocol.ts`, so both sides
use one definition. Nothing under `runtime/` changed.

## 3. Local versus R2 dispatch

Decided at every Run from the project being run (`requiresMcuRuntime`): a project containing a
Classic ESP32 board runs on R2; every other project runs in the local Worker, exactly as before.
Only one host is active at a time. A routine browser test proves that a DC project makes **zero**
`/runtime` requests.

## 4. The Classic ESP32 component

- **Type** `board.esp32_devkitc_wroom32` (reference `U1`), additive to schema v2 (a new type id;
  no field changes). The symbol draws the DevKitC headers in board order: J2 on the left, J3 on
  the right.
- **Connectable terminals** are exactly the pads the runtime supports (R1 map: digital I/O and
  input-only) plus one GND:
  - GPIO 0, 2, 4, 5, 12–19, 21–23, 25–27, 32, 33 are digital I/O;
  - GPIO 34, 35, 36, 39 are input-only;
  - GND.
- **Not connectable** (drawn as short dashed stubs): 3V3, 5V, EN, the other GND pins, the flash
  pins GPIO6–11 (D0–D3, CMD, CLK) and the UART0 console GPIO1/3 (TX/RX).
- **Caveats** are shown in the inspector's capability table, from the map:
  - strapping pins GPIO0/2/5/12/15: boot level not sampled;
  - input-only pads: no driver, no internal pull;
  - flash and console pins;
  - EN: reset not simulated.
- **Input-only enforcement:** if firmware drives GPIO34/35/36/39, the pad stays an input
  electrically (as on the hardware) and a runtime warning is shown (R2 diagnostic
  `output_on_input_only_pad`).
- **Not simulated,** stated in the panel: internal pull-up/pull-down, GPIO interrupts, chip
  reset, analog, PWM, Wi-Fi. Firmware that declares pulls or interrupts is refused by the host
  (`unsupported_feature`), never run with silent dead behaviour. All curated S6 firmware declares
  none; S7 will generate the declaration from the build.
- **Board GND is the circuit reference.** The circuit checks treat a wired board GND like a GND
  symbol, and a wired pad as referenced through the MCU. Unused board pins are not a
  "partially wired" warning.

## 5. Firmware artifacts (S6 scope)

S6 does not compile firmware (that is S7). A project selects a **prebuilt, immutable** artifact by
its content identity: the enum parameter `firmware` on the board holds the sha256 of the pinned
R1 flash image, or `none`.

| id | sha256 (prefix) | Behaviour |
|---|---|---|
| `tbi-gpio-proof` | `5f177cbe95f490dc` | blinks GPIO2/GPIO18 (800 ms pattern), prints GPIO5 |
| `tbi-banks` | `9ca3a5cea66e46a2` | copies GPIO34 → GPIO4 and GPIO35 → GPIO33, printing each change |

A routine test asserts these equal `runtime/firmware/artifacts.lock.json`. The Session Host
verifies the hash before every session and runs a private writable copy. The package format's
reserved `firmware` section stays `null`: it is for embedding artifact bytes, which S6 does not
do. Changing firmware is a structural edit (Stop first). No cloud firmware storage exists.

## 6. Project → session snapshot

`buildSessionRequest(doc)` builds the R2 `CreateSessionRequest` from the persisted document:

- **Fields:** `protocol`, `artifact.sha256` (the board's firmware), `board`, `circuit`,
  `attachments`, and `firmwareFeatures` only if any are declared.
- **`circuit`:** the project's own simulation snapshot at its current revision, including every
  PSU setting and toggle position, with the board **replaced** by what the runtime models:
  - each wired pad becomes an attachment `{gpio, component, terminal}` on another component
    terminal of the same net, chosen deterministically;
  - the board GND becomes a ground element `U1_gnd` on its net.
- **Refused before any network call,** with a localized message:
  - no firmware selected (`mcu_no_firmware`);
  - an unknown firmware;
  - more than one board (V1 runs one);
  - board GND unwired (`mcu_ground_unconnected`);
  - a pad wired only to other pads (`mcu_pin_without_circuit`).
- **Validation:** a routine test runs the frozen protocol's own `validateCreate` on the built
  request. The request contains no layout, identifiers of sessions, or runtime data.

## 7. The R2 client

`RuntimeClient` / `RuntimeSession` own every transport detail.

**Transport**

- Same-origin base path `/runtime` (configurable with `VITE_RUNTIME_BASE`).
- The session token travels **only** in the `Authorization` header, never in a URL. The event
  stream is read with `fetch` streaming rather than `EventSource`, which cannot set headers.
- Operations: `create`, `run`, `stop`, `terminate` (with `keepalive` on page hide), `status`,
  `command` (client `seq`), and `stream` (ordered events).

**Ordering, resume and resync**

- `seq` must increase by exactly one. A gap that isn't an explicit `resync` marker is a
  protocol error, never accepted silently.
- On a transport drop, the client reconnects with bounded backoff and resumes with
  `Last-Event-ID`. It gives up after 25 s, inside the host's 30 s lease.
- **Liveness watchdog:** a stream silent for 20 s is treated as dropped. The host sends a
  keepalive every 15 s, so a live stream is never that silent. Found by testing: a proxy can
  leave a dropped upstream half-open indefinitely (reproduced with the development proxy), so
  the client can't rely on the proxy to close it.

**Errors**

Typed `RuntimeTransportError`: `unreachable`, `busy`, `shutting_down`, `refused`, `not_found`,
`conflict`, `protocol`. A non-JSON answer (for example a login page from a proxy) is a protocol
error.

## 8. Session lifecycle in the UI (one Run/Stop control)

| R2 session | UI status | Control |
|---|---|---|
| creating / ready / booting | `starting` ("Starting…") | Stop (cancels; a session created after that is terminated at once) |
| running (first operating point received) | `running` ("Running · ESP32") | Stop |
| stopping | `stopping` ("Stopping…") | Stop, disabled and `aria-busy` |
| ended after Stop | `stopped` | Run |
| failed or lost | `failed` plus a localized message | Run (a fresh session) |

- **Sessions are one-shot.** Stop sends a graceful stop and waits for the terminal state. It
  terminates after 10 s if the session hasn't ended.
- **Nothing is resumed.** The next Run creates a new session with fresh flash, a fresh QEMU and
  empty serial and GPIO views. There is no Reset button (full-chip reset is unsupported).
- **Width stays fixed.** The control keeps its width in every locale: all status labels,
  including the two new ones, are sized in both font weights.

## 9. Persistent mirrors and transients

- **Persistent (toggle position, PSU setpoint / limit / output):**
  - The store commits the edit to the project FIRST (new revision, autosave, undo).
  - Only then is it mirrored: R2 `category: 'mirror'` with that `projectRevision`.
  - The host applies it at its next command tick; acks carry the revision.
  - A mirror the session can't take (for example `stale_revision`) **fails and releases the
    session** (`mirror_failed`), with a message saying the project keeps the change. It is never
    left running with divergent state.
  - Server data is never written into the project.
- **Transient (push buttons):**
  - R2 `category: 'transient'` press/release, ordered by the session's command sequence, with no
    revision and no project change.
  - Pointer up or cancel releases.
  - Stop, or losing the session, drops all held state.
- **Limitation:** R2 allows one mirror per project revision. An edit that changed live values
  of two components at once (only possible through undo of a multi-part change) would send two
  mirrors with one revision. The second is rejected, which fails the session explicitly rather
  than diverging silently.

## 10. Structural edits while running

The existing rule applies unchanged, and now also covers the `stopping` state:
- **Refused while a session exists, with the message "Stop to edit":** wiring, adding or
  removing parts, and any parameter that isn't live (resistor values, LED models, firmware).
  Placing from the palette is also refused.
- **Allowed:** layout edits (move, rotate, rename) and live controls (toggle, PSU).
- **After Stop,** editing resumes normally.

## 11. Runtime events and state

`McuSimulation` consumes the ordered events into an ephemeral `RuntimeView`:

- **state** → lifecycle;
- **electrical** → the operating point shown by the existing results, probes and LED glow, plus
  pad voltages;
- **gpio** → live levels: dots on the board pins and the "live pins" table;
- **serial** → a bounded view: the most recent 16 KiB, with a trimmed-characters count;
- **diagnostic** → runtime warnings (the last 20);
- **command** → rejections;
- **resync** → a visible "N runtime updates were missed" notice. Values are marked stale until
  the next operating point, and session status is re-read (the only current-state call the
  frozen protocol offers).

On Stop, reload or loss, the view is discarded. **Persisted:** only engineering data.
**Never persisted** (tests check the stored document, reload, and the exported package): session
id or token, QEMU state, serial buffer, GPIO results, event ids, transient button state.

## 12. Errors (localized, English and Hebrew)

| Code | Meaning |
|---|---|
| `mcu_no_firmware` / `mcu_unknown_firmware` | no firmware chosen / not offered |
| `mcu_multiple` | one board per project in V1 |
| `mcu_ground_unconnected` | board GND must be wired to ground |
| `mcu_pin_without_circuit` | pads wired only to other pads |
| `session_create_failed` | runtime service unreachable |
| `runtime_busy` | host at its session limit (429/503) |
| `firmware_unavailable` | artifact unknown, missing or hash mismatch on the host |
| `unsupported_feature` | declared pulls or interrupts |
| `invalid_attachment` | a pad the runtime cannot use |
| `startup_failed` | start failure or startup timeout |
| `runtime_crashed` | QEMU crash, bridge lost, protocol failure on the runtime side, internal |
| `guest_reset` | firmware requested a reset (unsupported) |
| `stalled` | no progress (for example, non-booting firmware) |
| `session_lost` / `session_expired` | lease expired or host ended it / maximum lifetime |
| `mirror_failed` | a persistent mirror was refused |
| `protocol_error` | malformed or incompatible response |

A server-side "no operating point" (`electrical_error`) shows the **same** localized engine
error as the local path (for example parallel supplies). Raw host detail is never shown; it
stays in the session status for diagnostics.

## 13. Hebrew and English

- **All S6 strings exist in both languages;** the type system and `tests/i18n.test.ts` enforce
  this.
- **Ground wording:** circuit ground in Hebrew uses the approved glossary term "אדמה (GND)". An
  earlier draft used "הארקה", which the glossary guard caught.
- **Technical tokens stay verbatim:** pin names (`pin.*` keys: IO34, VP, GND), logic levels
  HIGH/LOW, ESP32, DevKitC and GPIO numbers. The i18n guard and the Hebrew screen scanners
  declare exactly these.
- **LTR where required:** pin labels, levels, voltages and serial output are always LTR; the
  canvas stays LTR under Hebrew chrome.
- **Locale never touches engineering data:** switching locale changes no project value.

## 14. Deployment (dev-lab controlled preview)

**What changed:**
- `deploy/dev-lab/tbi-session-host.service` (hardened systemd unit):
  - the Session Host on **127.0.0.1:7400**, as user `ubuntu`, with a private `/tmp`,
    `ProtectSystem=strict` and a read-only home;
  - runtime `TBI_RUNTIME_HOME=/home/ubuntu/tbi-r1-clean/rt`;
  - SIGTERM releases every session.
- The Caddy internal origin gains `handle_path /runtime/*` → `127.0.0.1:7400` (unbuffered).
- `publish.sh` also publishes the host bundle of the same ref to `/srv/tbi-lab/session-host/<sha>`
  (outside the web root) and restarts the service.

**Security boundary (temporary, S6 preview):**
- `/runtime` sits behind the same oauth2-proxy gate as the site: Google login plus the exact
  email allowlist. Unauthenticated `GET /runtime/health` and `POST /runtime/sessions` get 302 to
  Google (verified).
- The Session Host port and QEMU's bridge ports are loopback-only. From outside, only 22/80/443
  are reachable (verified).
- Per-session bearer tokens authorize session routes and never appear in URLs.
- This is **not** the final S8 public authentication and rate-limiting design.

**Measured:** oauth2-proxy flushes `text/event-stream` immediately (362 events over 42 s, largest
gap 0.21 s at its default settings) and does not cut streams at its 30 s upstream timeout. No
proxy setting was changed for streaming.

**Deployed:** `19320ac` at `https://dev-lab.tbi-tech.net`.
- The full heavy acceptance (blink, input echo, determinism) passed through the deployed Caddy
  route and systemd Session Host (internal origin, loopback).
- The Google-login hop needs a browser check by an allowed user.
- **Sign out (preview UX):** when the build sets `VITE_SIGN_OUT_URL` (dev-lab:
  `/oauth2/sign_out`, the proxy's endpoint) a "Sign out" / "יציאה" link appears beside the
  language selector on the Projects screen and as the last item of the editor's menu. It is a
  plain top-level navigation; the app has no identity display and no knowledge of the provider.
  Without the variable (local builds, CI) there is no control.
- **Rollback:** point `/srv/tbi-lab/dev-lab/current` and `/srv/tbi-lab/session-host/current` at
  the previous build, and restore `/etc/caddy/Caddyfile.pre-s6`.

## 14a. Pre-soak UI polish (PM review of the deployed preview)

- **Brand:** the top bar shows the regular TBI logo in its light-surface version
  (`tbi-logo-light.png`, from the PM's `logo_no_bg.png` via `scripts/build-brand-assets.mjs`,
  38 px tall, aspect kept, no tile) and the "TBI Lab" wordmark. The round profile mark is not
  used in the product UI (favicon only). The large Projects-hero logo is unchanged.
- **Projects screen:** a wider shell (up to 112rem) with three separate areas: New project
  (with Import), Recent projects, and Examples. On wide desktops create/recent share the start
  column and examples take the wider end column (cards auto-fill, 3–4 per row); below 1180 px
  one column in the same order. The screen's header keeps only brand, language and Sign out.
- **Editor header (single row):** menu (≡) | labelled, visibly editable project-name field |
  save state, Undo, Redo, the one Run/Stop control and its status | language and the logo.
  The edges are exact: English has the menu at the far left and the logo at the far right;
  Hebrew the reverse (the leading/trailing edges of each direction). The status is plain text
  ("Status: Running" / "מצב: רץ") with a small dot: no border, background, hover, pointer or
  tab stop, `role="status"`, a reserved width so it never moves the header. The project-name
  field keeps the existing rename path; its text aligns left in English and right in Hebrew.
- **Menu:** Projects, New project… (the Projects screen's own create form, focused), Import
  project…, Recent projects (up to three, most recently changed first, never the open one;
  opened through the Projects screen's own open path), Export project, and Sign out when
  configured. It is a single list: keyboard
  operable (arrows, Home/End), Escape returns focus to the button, a click outside or Tab
  closes it, it closes after every action, opens from the button's leading edge, and stays
  inside the viewport. Import and export reuse the existing flows.
- **Header surface:** one light cool blue-grey (`--header-bg`) on Projects and the editor, so
  the transparent logo stays legible; the brand divider is kept; the dark Projects hero is
  unchanged.
- **Start screen:** the app always opens on the Projects screen (it no longer reopens the last
  project on start); a project opens only when the user chooses it.
- **ESP32 terminal:** for projects with a Classic ESP32 board, a terminal in the side column under the properties shows
  the board's serial console (UART0) as the session reports it: the chip's boot ROM lines
  (`ets Jul 29 2019 …`, `rst:0x1 (POWERON_RESET)…`) and the firmware's prints, with the session
  state (Not running / Starting session / Booting / Running · simulated time / Stopping /
  Session failed / Session ended). It is dark, monospace, LTR in every locale, bounded by the
  runtime view's 16 KiB serial window, follows new output unless scrolled back, and can be
  collapsed. After Stop the last output stays readable (marked as ended) until the next Run or
  another project; it is never stored. The inspector's ESP32 panel keeps live pins and
  warnings; its serial box moved to the terminal.
- Nothing in the project schema, simulation, R2 client, Session Host or persistence changed.

## 15. Tests and evidence

**Routine CI (no QEMU).**

- `npm test`: 489 tests.
  - S6 additions: R2 client against the real Session Host transport with the R2 fake runtime (5);
    ESP32 host, dispatch and snapshot with a scripted client (12); board, firmware and checks (5).
  - Updated: examples, i18n, and the closed-catalog guard (A16), which now also asserts that the
    only MCU type is the Classic ESP32.
- `test:e2e`: 87 passed (3 heavy skipped).
  - `s6.spec.ts` (9 tests) runs against `app/e2e/fixtures/fake-session-host.ts`, which uses the
    real `runtime/host/http.ts` transport, the real `EventLog` and validators, the real engine
    and a scripted MCU.
  - Covered:
    - board pins and capabilities;
    - no firmware, offline;
    - one-shot Run/Stop and fresh sessions;
    - mirror/transient/structural lock;
    - reconnect through a half-open proxy stream;
    - explicit resync after eviction;
    - lost session and busy host;
    - local DC isolation (0 runtime requests);
    - no runtime state across reload and export;
    - Hebrew.
- `test:browser`: 4. Typecheck, lint and boundaries: clean.

**Heavy, real QEMU (`TBI_S6_REAL=1`, `s6-real.spec.ts`).** Three tests, passing locally (twice)
and through the deployed site:
1. **Blink:**
   - Run → session → GPIO2 drives the LED (1.939 V, 5.754 mA through 220 Ω);
   - serial `TBI-ARDUINO-READY`;
   - Stop → QEMU gone;
   - project byte-identical.
2. **Input echo:**
   - toggle persisted first (revision +1), mirrored → firmware lights the LED; off again;
   - push button held → on, released → off, revision unchanged;
   - Stop → Run gives a new QEMU pid and a fresh boot.
3. **Determinism:** three full browser → Session Host → QEMU → browser runs of the same project
   and firmware give identical canonical checkpoint hashes for simulated seconds 1–6, and the
   hashes evolve. The trace hashes the runtime events with their simulation times; transport
   timing and event ids are excluded.

## 16. Performance (short check; 1-vCPU host; not a capacity claim)

Chromium 153.0.8010.12. Pre-S6 snapshot at `d04978d`; post-S6 at `19320ac`, same method:

| Local DC path (led-current) | Pre-S6 | Post-S6 |
|---|---|---|
| Run → settled result (median) | 45.5 ms | 46.1 ms |
| Stop | 32.5 ms | 37.4 ms |
| Wire route → rendered | 5.6 ms | 4.4 ms |
| Edit → autosaved (300 ms debounce) | 301 ms | 301 ms |
| Idle main-thread CPU | 0.01% | 0.02% |
| JS heap used / total | 5.1 / 8.8 MB | 4.8 / 9.1 MB |
| Renderer RSS (all Chromium) | 141.8 (450.6) MB | 142.2 (450.4) MB |
| Workers / IndexedDB | 1 / 72 KB | 1 / 72 KB |

| ESP32 session (esp32-blink, real runtime) | Post-S6 |
|---|---|
| Run → first operating point (median of 5) | 558 ms (404–618 ms) |
| Stop → stopped (median of 5) | 73 ms |
| Events received | ~16 /s |
| Main-thread CPU while running | 7.9% |
| JS heap used / total | 6.2 / 13.6 MB |
| Renderer RSS (all Chromium) | 155.2 (465.2) MB |

No local-path regression; the differences are within run-to-run noise.

## 17. Known limitations

- One ESP32 board per project; exactly the two curated prebuilt firmwares (no upload, no build).
- Not simulated, stated explicitly in the product:
  - internal pull-up/pull-down;
  - GPIO interrupts;
  - chip reset;
  - analog, PWM, UART beyond the console output;
  - Wi-Fi;
  - the board's 3V3/5V pins as supplies.
- A pad wired only to other pads can't run; it needs a circuit element in between.
- Board GND is the circuit reference, the runtime model's assumption.
- The two-mirrors-in-one-revision edge case (§9) fails the session explicitly.
- After a resync, only session status is refetched (the frozen protocol has no "current
  operating point" call). Values are marked stale until the next change.
- Pin labels on a board rotated 90°/270° are dense.
- ESP32 sessions need the runtime service, so they don't work offline. DC projects do.
- The deployment boundary is a controlled preview (§14), not the S8 public design.

## 18. S7 boundary

Out of S6 and belonging to S7:
- Arduino source editing;
- compilation and toolchain;
- generating firmware artifacts and their feature declarations (`firmwareFeatures`) from the
  build;
- multi-file projects, libraries, `.ino`;
- artifact storage and embedding (the package `firmware` section).

S6 provides the S7 hooks: artifacts by content identity, and the declaration path to the host.

## 19. Decisions (PM, 2026-09-27)

- **D-S6-1:** keep the two pinned demo firmware artifacts for S6; S7 replaces them with the
  Arduino build flow.
- **D-S6-2:** ESP32 pin labels stay screen-upright and LTR when the board rotates; they sit on
  the geometrically appropriate side, never sideways or upside down.
- **D-S6-3:** the always-on Session Host service on the private preview host is approved; QEMU
  stays per-session.
- **D-S6-4:** for the controlled preview, Google OAuth plus the exact-email allowlist is
  sufficient; public authentication, rate limits and quotas are S8. The R2 per-session limits
  stay.

## 20. Readiness (superseded by §21)

Functionally complete and verified by routine, heavy real-QEMU and deployed-site acceptance.

## 21. Closure (PM decision, 2026-09-27)

**Sprint 6 is closed** on the final product state below. The planned 465-minute integrated
endurance run is **deferred** to post-S7 / pre-S8 (S7 changes the firmware/build/artifact
workflow, so a long run is more valuable after it). It is **not recorded as PASS**.

**Closure evidence**

- Functional S6 implementation complete (`19320ac` … `b959feb`).
- Real-QEMU acceptance complete: blink, input echo and product-level determinism (3/3), run
  locally and through the deployed site's internal origin on every deployed build, last on
  `b959feb`. Determinism: identical canonical checkpoint hashes for simulated seconds 1–6.
- The authenticated private-preview path was exercised manually through Google OAuth on
  `https://dev-lab.tbi-tech.net` (final smoke on `b959feb`, 2026-09-27 13:56 UTC): open an ESP32
  example, rename, Run with real runtime traffic, Stop with QEMU gone and no session temp
  directory left, menu, export, recent project, sign-out (the next `/` redirects to Google),
  sign-in again.
- Routine regressions complete on the closure commit (counts below).
- The integrated endurance harness passed a representative 12-minute trial against the internal
  origin: 32 ESP32 sessions with QEMU gone after each Stop, 31 local DC runs with correct values
  and no `/runtime` requests, 4 matching determinism checks, persistence and security checks,
  and bounded buffers.
- **Review item for the deferred run:** browser storage grew during the trial (IndexedDB usage
  38 KB → 725 KB in 12 minutes while the project count stayed constant; in a later check the
  logical content was 17.8 KB against 202 KB on disk). The app overwrites projects in place, so
  this looks like storage-engine churn; whether it plateaus must be measured in the long run.
- No production capacity, concurrency or long-duration resource claims are made from S6 evidence.

**Final S6 product state**

- Classic ESP32 DevKitC in the product: capability-map pins, unsupported pins and features
  refused, never faked.
- Browser/R2 dispatch: DC projects in the browser Worker, ESP32 projects on the R2 Session Host;
  the browser stays the project authority.
- Immutable prebuilt firmware artifacts selected by content identity (two pinned demos).
- Same-origin `/runtime` behind the private-preview OAuth boundary; host and QEMU loopback-only.
- One-shot sessions under a single Run/Stop control with a non-interactive status.
- Live mirrors (toggle, PSU) persisted first and carrying their revision; transient push
  buttons.
- Reconnect handling with a liveness watchdog; explicit resync marking.
- GPIO visualization on the canvas and in the inspector.
- Bounded ESP32 serial terminal in the side column (boot ROM lines and firmware prints).
- Recent-project menu; finalized header (menu and logo edges per locale, editable project name,
  plain status, light header surface, approved light logo and favicon); the app opens on the
  Projects screen.
- dev-lab private deployment (`publish.sh`, `tbi-session-host.service`, Caddy `/runtime`).

**Final routine verification (on `b959feb` plus this docs-only closure):** typecheck, lint and
boundaries clean; `npm test` 495 tests in 46 files; `test:e2e` 103 passed, 3 heavy real-QEMU
tests skipped (run separately, 3/3); `test:browser` 4; production build OK.

**CI correction (GitHub Actions 36328598866 failed on `50c7df1`):** two timing defects that
only showed on the slower runner, both reproduced locally and fixed in the implementation:
the page `dir`/`lang` was applied in a post-paint effect, so the first Hebrew frame still had
`dir="ltr"` (project name left-aligned); and the menu focused its first item in a post-paint
effect that could take focus back after an immediate End key. Both now happen in the same commit
as the render. Two regression tests encode the causes (fail on the old code, pass now). Final
counts after the fix: `npm test` 495; `test:e2e` 105 passed, 3 heavy skipped; `test:browser` 4.

**Deferred to post-S7 / pre-S8:** the integrated long run (browser/editor, source autosave,
repeated Arduino builds, artifacts, R2/QEMU sessions, the local DC path and the IndexedDB
storage trend). Its harness exists as an uncommitted engineering tool from this sprint.
