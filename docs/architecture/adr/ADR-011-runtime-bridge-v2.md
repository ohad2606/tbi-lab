# ADR-011 — Runtime bridge v2: capabilities, scheduled inputs, pad functions and I2C transactions

**Status:** Proposed (awaiting PM architecture review) · **Date:** 2026-10-09 · **Sprint:** 12
(Runtime v2: R2 + R3)

**Related:**
- ADR-006: QEMU licensing and process boundary.
- ADR-007: simulation time contract.
- ADR-008: one electrical engine, two hosts.
- ADR-010: ESP32 part support and live part parameters.
- [R3-CAPABILITY-PLAN.md](../../runtime/R3-CAPABILITY-PLAN.md): capabilities B and C.
- [SPRINT-12-ARCHITECTURE.md](../../sprints/SPRINT-12-ARCHITECTURE.md).

## Context

Bridge v1 (`runtime/qemu/patches/0004`, `runtime/harness/protocol.ts`) is a strict, synchronous
ASCII line protocol between one QEMU process and the Session Host:

| Direction | v1 frames | Notes |
|---|---|---|
| QEMU → host | `H tbi-bridge 1 <tick_ns>` · `G <vns> <pad> <drive> <level>` · `T <vns>` · `S <vns> <hex>` | `H`, `G` and `T` block the guest until the host replies; `S` has no reply |
| host → QEMU (inside a reply) | `I <pad> <level>` · `R <hex>` (tick replies only) · `Q` · `C` | `C` ends the reply |

**Limits of v1:**
1. An external input changes either inside the reply to a pad event, or at the next 1 ms tick.
   HC-SR04 and DHT22 need input edges at exact sub-millisecond virtual times. At 1 ms resolution the
   HC-SR04 is off by 17 cm and the DHT22 frame cannot be decoded.
2. The host sees only GPIO-matrix "simple GPIO" output. Patch 0003 stores `FUNCn_OUT_SEL` and
   `FUNCn_IN_SEL` but does not route peripheral signals. A pad handed to the I2C controller is
   therefore indistinguishable from a GPIO.
3. The upstream ESP32 I2C controller (`hw/i2c/esp32_i2c.c`) runs command lists against a
   QEMU-internal bus that no host can see. The upstream machine also hard-wires a **TMP105
   temperature sensor at 0x48 on I2C0, reporting 25 °C** (`esp32_machine_init_i2c`). That is a
   device that does not exist in the user's circuit.
4. `H` carries only a version. Nothing tells the host or the build service what a given QEMU build
   can do.

## Decision

### 1. Version and capability negotiation

- QEMU sends `H tbi-bridge 2 <tick_ns> <caps>`. `<caps>` is a comma-separated, sorted list of
  capability tokens; `-` means none.
- Initial tokens:
  - `sched-input`: the `J` and `X` commands;
  - `pad-func`: `F` frames;
  - `i2c`: `B` frames with the `K` and `D` replies.
- A v2 host accepts `H … 1 …` and treats it as having no capabilities, so it runs exactly as today.
  It rejects any version other than 1 or 2, and any capability token it does not know (fail closed).
- A v1 host rejects `H … 2 …` (strict parser, unchanged). This is why the host is upgraded first
  (§6).
- **Capabilities are bound to the session.** At `H`, the host checks the ticket's required
  facilities (§5) against `<caps>`. If any is missing, it sends `Q` before the first guest
  instruction and the session fails with `unsupported_feature`. The firmware never runs on a runtime
  that cannot honour it.

### 2. Scheduled inputs (`sched-input`, R2)

**Host → QEMU, in any reply:**
- `J <vns> <pad> <level>`: apply `level` to `pad` at virtual time `vns`. `vns` must be strictly
  later than the frame being answered.
- `X <pad>`: cancel every pending scheduled input on `pad`.

**How QEMU applies them:**
- The bridge keeps a per-pad, time-ordered queue with a hard cap, **`TBI_SCHED_MAX` = 512 pending
  entries per process**.
- A single `QEMU_CLOCK_VIRTUAL` timer is armed at the earliest entry, with the
  **`QEMU_TIMER_ATTR_HOST_SYNC`** attribute from patch 0005. Execution stops at exactly `vns`, the
  level is applied, and the same vCPU resumes its slice.
- Because the timer is a host-sync timer, a scheduled sensor edge **does not change how the two
  cores are interleaved**. This is the property 0005 already proves for the command tick.
- A scheduled edge that the firmware never reads leaves the guest timeline bit-identical, which is
  tested (T-DET-3).
- Applying a `J` is silent: no frame is sent. The host already knows the schedule.

**Validation (fail closed, exit status 3):**
- `vns` not later than the current frame;
- `pad` ≥ 40;
- `level` > 1;
- the queue is full;
- two entries on the same pad less than **1 µs** apart.

The host enforces the same limits first. It never sends a command that QEMU would reject, so a
QEMU exit 3 always means a bug.

**Who decides the level.** The Session Host computes every scheduled level **from the electrical
solution**, never as an assumed logic value:
- For each sensor output state (driving low, or released), the host solves the circuit and turns
  the pad voltage into a logic level with the board's thresholds.
- The solver remains the only source of electrical truth. Supply, wiring, pull-ups, a 5 V echo
  through a divider, or a missing ground all change the result.
- The level comes from the engine's existing `interpretDigitalInput` (`packages/engine/src/esp32Gpio.ts`).
  Inside the band between V_IL and V_IH it holds the previous level, a documented semantic. A pad
  pushed beyond the absolute maximum is reported by the engine's existing pad check, as for any
  input. Physical-model limitations are in SPRINT-12-ARCHITECTURE §3.3.

**Contention.** If the firmware drives a pad (`G … drive=1`) while a schedule is pending on it:
- the host re-solves;
- it cancels the remainder (`X`);
- if the solution shows contention, it reports `pad_contention` on the existing electrical
  outcome path.

Nothing is applied that the electrical solution does not support.

### 3. Pad functions (`pad-func`, prerequisite for R3)

Patch **0007** extends the 0003 GPIO model.

**What it reports.** When a pad's routed function changes, QEMU sends **`F <vns> <pad> <func> <od>`**
(host replies `C`). The change can come from:
- `FUNCn_OUT_SEL` (a peripheral output signal index, or 256/0x100 for "simple GPIO");
- `GPIO_PINn_PAD_DRIVER` (open-drain);
- the input routing `FUNCm_IN_SEL` for the I2C signals.

`<func>` is a stable token:
- `gpio`;
- `i2c0-scl`, `i2c0-sda`, `i2c1-scl`, `i2c1-sda`;
- `periph:<index>` for any other signal.

**Behaviour while a pad carries a peripheral signal:**
- its `G` frames stop;
- the host treats the pad as **owned by that peripheral**;
- an open-drain I2C line that is not in a transaction is **released**, so the solver sees it pulled
  up by whatever pull-up exists in the circuit.

**Scope and limits:**
- Only the I2C signals are given meaning in Sprint 12. Any other `periph:` routing on a pad that
  joins the circuit refuses the session (`unsupported_feature: periph:<index>`), as it does today
  through the builder.
- Internal pull-ups and pull-downs (IO_MUX `FUN_WPU`/`FUN_WPD`) are **not** reported in Sprint 12.
  This is a recorded limitation and a requested decision (D-4).

### 4. I2C transactions (`i2c`, R3)

**Patch 0008:**
- removes the upstream TMP105 phantom device;
- adds a `tbi-i2c-proxy` I2C target on each ESP32 controller bus;
- carries the controller fixes the feasibility probe proves necessary.

**Frames.** The proxy forwards each bus phase synchronously:

| QEMU → host | Meaning | Host reply |
|---|---|---|
| `B <vns> <bus> S <addr> <rw>` | START or repeated START, 7-bit address | `K 1` (ACK) or `K 0` (NACK), then `C` |
| `B <vns> <bus> W <byte>` | controller writes one byte | `K 1` / `K 0`, then `C` |
| `B <vns> <bus> R <ack>` | controller reads one byte; `ack` = whether it will ACK it | `D <byte>`, then `C` |
| `B <vns> <bus> P` | STOP | `C` |

(The capability plan's draft used `C` for these frames. `B` is chosen so the letter `C` keeps one
meaning, end of reply. `K` and `D` are valid **only** in replies to `B` frames, and exactly one is
required.)

**Host side.**
- The engine's `I2cBus` and its targets (`packages/engine/src/peripherals/i2c.ts`, `hd44780.ts`)
  answer each phase.
- **Electrical gating at every START.** The device is present only if all of these hold:
  - the pads routed to SCL and SDA are wired to the device's SCL and SDA nets;
  - each line has a pull-up the solver can see;
  - the device is powered within its supply range.

  Otherwise it does not ACK, which is what a real bus does.
- Two devices declaring the same address on one bus refuse the session
  (`i2c_address_conflict`).

**Timing abstraction.** Phases are stamped with exact virtual time. The bus duration (9 SCL clocks
per byte) is not added in Sprint 12, as recorded in the capability plan. The probe measures
whether `Wire` depends on that duration.

### 5. Build-service policy follows the runtime's capabilities

- The build service is configured with the capability set of the runtime it issues tickets for,
  read from the provisioned `runtime.json`, never hand-typed.
- A facility the runtime supports moves from the ticket's `unsupported` list to a new **additive**
  `requires` list (for example `requires: ["i2c"]`).
- §1 ensures that a ticket requiring `i2c` never runs on a runtime without it, even if the build
  service and runtime configuration were ever mismatched.

### 6. Compatibility and deployment order

| Combination | Behaviour |
|---|---|
| v2 host + v1 QEMU | Runs exactly as today (no capabilities). New parts and `requires` tickets refuse with `unsupported_feature` / `unsupported_component` |
| v2 host + v2 QEMU | Full Runtime v2 |
| v1 host + v2 QEMU | Refused at `H` (fail closed). **Never deployed this way** |
| S12 frontend + S11 host | Run of a project with an R2/R3 part fails explicitly, naming the part (`unsupported_component`), as proven in Sprint 11 |
| S11 frontend + v2 host | Unchanged behaviour (the new parts are absent from the S11 catalog) |

**Order:**
- Deploy: host v2 (on v1 QEMU) → QEMU runtime v2 → frontend.
- Rollback: the reverse order. Each step is independently reversible.

## Consequences

- One protocol revision covers R2 and R3. R4 (LEDC waveforms, `W` frames) is a later capability
  token on the same mechanism and needs no further version bump.
- Every QEMU patch produces a new runtime id, so fingerprints must be re-verified
  (SPRINT-12-ARCHITECTURE §5).
- The upstream TMP105 removal is a guest-visible change for firmware that probes 0x48. No pinned
  firmware does. The removal is required regardless: a sensor that is not in the circuit is
  invented hardware.
- The host gains a per-session schedule (memory bounded by the 512 cap) and per-START
  electrical checks. Both are measured in the C-5 benchmark.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Lower the tick to 1 µs | 1000× more round trips. It still cannot place an edge between ticks, and it changes the quantum contract of ADR-007 |
| Host polls for pad reads (`pulseIn` read events) | Every GPIO read would become a round trip; reads are far more frequent than edges |
| Line-level I2C (bit-banged SDA/SCL as `G` frames) | The hardware controller does not produce pad edges in QEMU; it would require a cycle-level controller model |
| Keep the upstream TMP105 | Invented hardware: a 25 °C sensor answers at 0x48 in every circuit |
| A `C` prefix for I2C frames (draft) | Overloads the end-of-reply letter and makes the strict parser ambiguous to read |
