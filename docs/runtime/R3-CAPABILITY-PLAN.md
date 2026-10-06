# Runtime R3 — capability plan: edge timing, I2C, microsecond inputs

**Status:** architecture only (Sprint 10, 2026-10-06). Nothing here is implemented or deployed. The
Sprint 8 backend (Session Host, build service, QEMU runtime) is unchanged; redeploying it is a
separate approval.

**Why:** four parts have tested device models in the engine (`packages/engine/src/peripherals/`) but
cannot be exposed for the ESP32, because the runtime cannot drive them honestly:

| Part | Model (engine, internal) | Missing runtime capability |
| --- | --- | --- |
| SG90 servo | pulse widths → angle | **A** — hardware PWM (LEDC) on pads, with exact edge timing |
| I2C LCD 16×2 | I2C bus + PCF8574 + HD44780 | **B** — the I2C controller bridged as bus transactions |
| HC-SR04 | echo timing from distance | **C** — inputs changed at exact sub-millisecond times |
| DHT22 | 40-bit frame and waveform | **C** — same |

The runtime exposes **generic capabilities**; device models consume them. Nothing in QEMU, the
bridge or the Session Host knows "servo", "LCD", "HC-SR04" or "DHT22".

## 0. What exists today (the baseline to extend)

- **QEMU** (Espressif fork, pinned, 5 TBI patches): GPIO register model (0003), synchronous bridge
  (0004), host-sync timers that do not perturb icount (0005). `-icount shift=3,sleep=off`: virtual
  time is deterministic, 8 ns per instruction.
- **Bridge v1** (`runtime/harness/protocol.ts`), line protocol on a private socket:
  - QEMU → host: `H` (hello, tick), `G vns pad drive level` (a pad event, **exact virtual time**),
    `T vns` (command tick, 1 ms), `S vns bytes` (serial out).
  - host → QEMU: `I pad level` (input), `R bytes` (serial in), `Q` (quit), each reply ends in `C`.
  - The guest is **blocked until the host answers** each frame. Input changes caused by a pad event
    are injected in the reply to that event, i.e. at its exact time; all other inputs only at 1 ms
    command ticks.
- **Session Host → browser**: `gpio` events aggregated per publish window (final level + transition
  count), `electrical` outcomes (the engine's results, including part `state`), `serial`. The
  browser never sees individual edge timestamps and never takes part in timing.
- **Upstream models found in the pinned source:** `hw/misc/esp32_ledc.c` stores the registers and
  computes a duty percentage, but generates no edges and does not route to pads.
  `hw/i2c/esp32_i2c.c` executes the controller's command list instantly against a QEMU-internal I2C
  bus with no devices attached and no bridge.

**Consequence (design principle):** timing-sensitive device semantics run **in the Session Host**,
next to QEMU's virtual clock, using the shared engine package. The browser receives device **state**
(servo angle, LCD text, measured echo) inside the `electrical` outcome it already displays.

## A. PWM / edge timing

**Representation.**
- Software-driven edges already arrive as `G vns pad drive level` with exact virtual time. A
  bit-banged servo pulse is therefore already measurable on the host; only the device wiring is
  missing.
- Hardware PWM (LEDC) gets a new QEMU patch (**0006**). LEDC is extended to resolve its channel →
  timer → GPIO-matrix routing (`GPIO_FUNCn_OUT_SEL` = LEDC signal index) and to report the
  **waveform**, not each edge: `W vns pad period_ns high_ns phase_ns`, re-sent whenever the
  configuration changes. `period_ns = 0` means the pad is static. The pad level at any time t is
  then a pure function of the last `W` frame. This keeps a 5 kHz PWM from becoming 10 000 frames per
  second.
- **Timestamp unit:** virtual nanoseconds (`bigint`), the bridge's existing clock.

**Transport.**
- `W` frames are synchronous like `G`. The host acknowledges with an empty `C`; device state is
  recomputed at that time.
- The Session Host expands a waveform into pulse widths only for consumers that need them (the servo
  model takes `high_ns` directly).
- Browser: an additive field on the `gpio` event (`pwm: { periodNs, highNs }` per pad). Old clients
  ignore it.

**Timing semantics.**
- Edge times are QEMU virtual time. Resolution is 8 ns for software edges (one instruction at
  `shift=3`) and one APB tick (12.5 ns) for LEDC.
- Circuit time **is** virtual time; wall clock never enters.

**Electrical meaning, a decision to record.** The engine solves operating points (DC, or
time-stepped). A pad switching faster than the circuit's time constants has no single honest DC
value. Phase A1 therefore:
- feeds **edge-consuming** devices (servo) exactly;
- reports the pad's duty for display;
- for an ordinary load (an LED on a PWM pad) reports **both** operating points (high and low) and
  their duty-weighted average current. This is exact for resistive and diode loads, which settle
  instantly.
- **refuses** PWM pads driving circuits that hold time-dependent parts (a capacitor) until the host
  time-steps the circuit at edge resolution (A2).

**Batching and backpressure.**
- Waveforms remove per-edge traffic for hardware PWM.
- For software edges: a per-session edge budget (for example 20 000 `G` frames per simulated second,
  enforced by the Session Host). Beyond it the session ends with a specific diagnostic
  (`edge_rate_exceeded`), never by silently dropping edges (the guest is synchronous, so nothing can
  be skipped honestly).

**Interaction with the simulation clock.** Unchanged command ticks (1 ms) for browser controls. Edge
and waveform effects apply at their own virtual time.

## B. I2C bridge

**Capture.** A new QEMU patch (**0007**) adds a `tbi-i2c-proxy` QEMU I2C target on each ESP32
controller's bus, **one per address the session declares** (the I2C devices in the circuit). The
upstream controller already turns the firmware's command list into bus calls (`i2c_start_transfer`,
`i2c_send`, `i2c_recv`, `i2c_end_transfer`). The proxy forwards each phase to the host
synchronously:

| QEMU → host | Meaning | Host reply |
| --- | --- | --- |
| `C vns bus S addr r` | START or repeated START, 7-bit address, read/write | `K 1` ACK or `K 0` NACK |
| `C vns bus W byte` | controller writes a byte | `K 1` / `K 0` |
| `C vns bus R ack` | controller reads a byte (`ack`: whether it will ACK) | `D byte` |
| `C vns bus P` | STOP | `C` |

- Addresses with no declared device have no proxy, so QEMU NACKs them, which is real behaviour.
- The patch also exposes the GPIO-matrix routing of the controller's SDA/SCL signals to pads
  (extending 0003), so the host knows which pads the bus uses.

**Electrical gating (no logical-only bus).** At each START the host checks, with the electrical
solution, that the routed SDA/SCL pads are wired to the device's SDA/SCL nets, that both lines have
a pull-up (module or external), and that the device is powered. If not, the device is absent: NACK.
I2C is never simulated as GPIO polling, and never succeeds without the wiring that makes it work.

**Device side.**
- The engine's `I2cBus` and targets (`peripherals/i2c.ts`, `hd44780.ts`): `begin(direction)`,
  `writeByte`, `readByte`, `end`, which are exactly the four phases above.
- The same objects serve a future line-level path (`I2cLineDecoder`) and MicroPython (`machine.I2C`
  uses the same controller), so nothing is Arduino-specific.

**Timing abstraction.**
- Transaction level, stamped with the virtual time of each phase. The upstream controller completes
  a command list instantly in virtual time.
- **Recorded limitation:** bus duration (9 SCL clocks per byte) is not added in the first phase; a
  later refinement can delay the controller's completion interrupt by the computed duration.

**Address conflicts.** Two devices declaring the same 7-bit address on one bus are refused when the
session is prepared (`i2c_address_conflict`, naming both parts), as `I2cBus.attach` already does. A
real bus would corrupt the transfer; the simulator does not invent which device wins.

**Transport to the browser.** None needed beyond device state: the LCD's text and backlight are part
results in the `electrical` outcome. An optional additive `i2c` diagnostic event (address, NACK
counts) helps debugging.

**Builder policy.** `Wire` / `i2c_driver_install` move from "unsupported" to "supported when the
runtime has capability B" (`runtime/builder/features.ts`). The refusal stays for runtimes without it.

## C. Microsecond digital input timing

**Need.** HC-SR04: the echo rises about 200 µs after the trigger falls and lasts 2d/c (58 µs/cm).
DHT22: 83 edges with 26–80 µs widths. Today an input not caused by a pad event changes only at the
next 1 ms tick: 17 cm of distance error, and an undecodable DHT22 frame.

**Scheduled input.**
- A new host → QEMU command `J vns pad level` (patch **0008**, in the bridge): apply this input at
  virtual time `vns`. The bridge arms a `QEMU_CLOCK_VIRTUAL` timer, which is deterministic under
  icount, and inserts the level change when it fires.
- A device's whole response goes in one reply as a list of `J` commands. A DHT22 frame is 83
  scheduled edges, one round trip.

**Accuracy.**
- Exact virtual time. Effective resolution is one instruction (8 ns), because the guest samples the
  pad when it executes a GPIO read.
- Needed: HC-SR04 about 1 µs (0.17 mm); DHT22 about ±5 µs. Both are far inside it.

**Clock relationship.**
- Host and browser wall clocks are not involved: the Session Host computes the schedule in virtual
  time from the device model and the environment value (distance, temperature/RH).
- Environment values come from the browser as mirrored live controls, applied at the next command
  tick, as for every live control today.

**Determinism and tests.**
- Same firmware, circuit and environment give the same trace hash. The existing R-MCU-1 style
  fingerprint pins it.
- Runtime tests use the engine's device models as the oracle: the expected echo width for a
  distance, and the decoded DHT22 values.

**Batching and load limits.**
- At most N pending scheduled inputs per session (for example 512). Beyond it the command is
  rejected with a diagnostic, never dropped silently.
- A minimum spacing of 1 µs between scheduled edges on one pad.
- Devices are rate-bounded by their own specifications (DHT22 period at least 2 s, HC-SR04 cycle at
  least 60 ms). The host refuses a re-trigger inside those limits exactly as the part does (the
  model gives no response).

**Not included:** interrupt-driven capture (`attachInterrupt`) stays unsupported. That is a separate
capability (GPIO interrupt delivery), and `pulseIn`-style polling suffices for both sensors.

## Protocol changes (summary)

| Layer | Change | Compatibility |
| --- | --- | --- |
| Bridge (QEMU ↔ host) | `H` announces version 2 and a capability list. New QEMU → host frames: `W` (waveform), `C` (I2C phase). New host → QEMU commands: `K`/`D` (I2C replies), `J` (scheduled input) | A v2 host still speaks v1 to a v1 QEMU (no capabilities); a v1 host refuses v2 frames (strict parser), so host and QEMU are upgraded together |
| Session Host ↔ browser | Additive optional fields: `gpio[].pwm`, optional `i2c` diagnostics; device states inside `electrical` (already generic part results); new failure/diagnostic codes `edge_rate_exceeded`, `i2c_address_conflict`, `input_schedule_full` | Old browsers ignore unknown fields; new codes map to a generic message |
| Session create | Accepts the Sprint 10 part types (the engine's part models) and per-capability circuit checks | A host built from this branch |
| Builder policy | PWM, I2C allowed per runtime capability | Per runtime id |

## Constraints preserved

- Sandboxing and QEMU isolation are unchanged: QEMU stays a separate, unprivileged process in its
  unit's mount view, and talks only the line protocol on a private socket.
- Admission policy, per-user ownership, run tickets and the artifact model are unchanged.
- R2 session semantics are unchanged: Run is one-shot, mirrors are revisioned, and commands apply at
  ticks. The additions are new frame types, plus inputs scheduled at exact virtual times.

## Would a backend redeploy invalidate the Sprint 8 validation?

- **Session Host only, rebuilt from this branch (no QEMU change).** The runtime id and determinism
  fingerprints are unchanged. The host bundle changes (engine with part models, create-session
  validation). The Sprint 8 runtime acceptance must be re-run on the deployed host:
  `r2-acceptance`, `r2-failures`, `s8-gate`, `s8-policy`, `s8-deployed-policy`, `s8-containment`,
  `s8-qemu-tasks`, `resources`. The R1 QEMU evidence stays valid.
- **Any QEMU patch (0006–0008).** It creates a new runtime id (the hash of the commit and every
  patch). All pinned determinism fingerprints must be re-baselined (R-MCU-1 repeated runs), the
  firmware artifacts re-verified, and the full runtime suite re-run. The R1/R2/Sprint 8 runtime
  evidence describes the old runtime id and does not transfer.

## Recommended phases

1. **R3a — Session Host with the Sprint 10 engine; no QEMU change.**
   - Lets every new local part (RGB LED, relay, transistor, LDR, PIR, buzzer, matrix) work in ESP32
     projects driven by digital GPIO. A bit-banged servo signal is also measurable from existing `G`
     frames.
   - Re-run the Sprint 8 runtime acceptance; no new determinism baseline.
   - Smallest step with the largest visible gain.
2. **R3b — capability C (scheduled inputs).**
   - The smallest QEMU change (bridge only).
   - Unlocks HC-SR04 and DHT22; their environment controls follow the existing environment-parameter
     path.
3. **R3c — capability B (I2C proxy).** Unlocks the I2C LCD and future I2C sensors.
4. **R3d — capability A (LEDC waveform).**
   - Unlocks the hardware-PWM servo (ESP32Servo) and LED dimming.
   - Requires the A1 electrical decision above (duty-averaged results for resistive and diode loads;
     refusal with capacitors).

Each phase is its own approval boundary, with its own runtime validation and evidence.
