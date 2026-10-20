# Genuine ESP32 Classic MicroPython — feasibility (Sprint 18, Workstream D)

**Status:** an isolated technical probe, not a product feature. Nothing is exposed in the app.
**Date:** 2026-10-20, DEV (`tbi-lab-srv`).

**Inputs:**
- Runtime v3 `2cb1406f94f52e4f` (the R4 runtime, now on DEV-Lab);
- the unmodified official MicroPython **ESP32_GENERIC v1.29.0** image, pinned in
  `runtime/firmware/artifacts.lock.json` as `micropython` (`23b8b47f…`).

The probe kit is in `mpy-probe/` (sources and harness only; images are rebuilt by `mkimg.py`, and
their shas are listed in `IMAGES.sha256`). Rules held throughout:
- no interpreter of our own, no translation of Python to Arduino or C++: the real interpreter runs;
- no unsupported API exposed as working.

## 1. Results by priority

| # | Priority | Result | Evidence |
|---|---|---|---|
| 1 | **Code delivery to the actual interpreter** | **Solved: the filesystem image**, deterministic, with no serial dependency (details below) | `mpy-probe/tbi-mklfs.c`, `mkimg.py`; P1 runs `main.py` from the image |
| 2 | **Deterministic execution** | **Yes.** P1 built twice gives a byte-identical image (`c79cf6e4…`); two runs give an identical frame stream (fingerprint `e332d8ce…`) and identical serial output | P1 |
| 3 | **GPIO and PWM** | **Work, exactly** (details below) | P1, `zz-mpy-host` |
| 4 | **I2C** | **Works** (Sprint 17C probe): `I2C(0, scl=22, sda=21).scan()` runs through the R3 bridge (bus phases, NACK → `[]`). Not repeated here | `SPRINT-17C-NEXT-PROPOSALS.md` §2 |
| 5 | **ADC guest crash: root cause** | **Found** (details below) | P2 + `-d unimp` |
| 6 | **IRQ: unsupported-behaviour detection** | **Feasible at register level, demonstrated** (details below) | P3, `probe-gpio-irq.patch` |
| 7 | **Reliable serial transport** | **Cause shown and fix demonstrated** (details below) | P4 |
| 8 | **Session lifecycle and resource limits** | See §3 | P1–P4, `zz-mpy-host` |

**Code delivery.** MicroPython v1.29 registers its `vfs` partition at run time:
- `ports/esp32/main.c`: with no `vfs`/`ffat` entry in the partition table, it takes the flash from
  the end of the app partition, so on the 4 MiB image 0x200000–0x400000 is LittleFS v2;
- `tbi-mklfs` builds that filesystem with **the interpreter's own littlefs sources** (v1.29.0
  `lib/littlefs`, 2.11 / disk format 2.1) and **its own `VfsLfs2` configuration** (read/prog/
  lookahead 32, block_cycles 100, cache 128);
- it reads no clock, so the image is a pure function of the program. An independent littlefs
  implementation, `mklittlefs` 4.0.2, lists the file;
- `mklittlefs` itself is unusable for this: it stamps a wall-clock creation time, so two builds of
  the same program differ;
- the program becomes **one flash image**: the pinned interpreter plus `main.py` at 0x200000. The
  existing build, ticket and Session Host path can run it like any firmware artifact.

**GPIO and PWM.**
- GPIO2 toggles at 50 ms of virtual time exactly.
- `PWM(Pin(18), freq=1000)` runs on high-speed LEDC channel 0 (APB, div 313, 16 bit). The duties
  8192 / 16384 / 32768 / 49152 are latched 20 ms apart, and `deinit()` idles the channel.
- **Through the real Session Host:** the LED on GPIO18 shows **exactly** 0.125, 0.25, 0.5 and 0.75
  × its high-state current; GPIO2's LED switches on and off; no diagnostics; Stop is clean.
- The duty-0 write MicroPython makes while creating the PWM lasts less than a tick and is not
  refused.

**ADC root cause.**
- `ADC(Pin(34)).read_u16()` starts a SAR ADC1 conversion and polls `SENS_SAR_MEAS_START1_REG`
  (`DR_REG_SENS_BASE + 0x54`) for `SENS_MEAS1_DONE_SAR` (bit 16).
- QEMU maps the SENS block as an *unimplemented device* that reads 0 (`hw/xtensa/esp32.c`: the
  second `esp32.rtcio` region is at `DR_REG_SENS_BASE`), so the bit never sets.
- The driver spun **12,616,389 reads** of that register until the guest panicked ("Guru
  Meditation … Cache error: cache disabled but cached memory region accessed") and rebooted. The
  host reports it as `guest_exit`.
- A real chip completes the conversion; the emulator has no SAR ADC model. Fix options: §2.2.

**IRQ detection.**
- `Pin.irq(handler, IRQ_RISING|IRQ_FALLING)` is accepted. The host drove GPIO4 high at 4.0 s and
  the program reads the pad HIGH, yet **0 callbacks** run (GPIO interrupts are not modelled). That
  is silent dead behaviour.
- A 5-line probe in `esp32_gpio.c` (writes to `GPIO_PINn` with INT_TYPE ≠ 0 and INT_ENA ≠ 0) logs
  `TBI-UNMODELLED gpio-interrupt pad 4 type 3 ena 0x1` at the exact call.
- The frame fingerprint is unchanged (`c17873d3…`): detection observes and changes nothing.
- The probe is not a product patch; product form: §2.2.

**Serial transport.**
- A 1000-byte burst handed to the bridge in one command is not all delivered: the program never
  received its 1000 bytes.
- The same bytes **paced at the line rate**, 11 bytes per 1 ms tick (115200 baud 8N1 =
  11.52 bytes/ms), arrive complete with the expected CRC (`3661192628`).
- The real link cannot deliver faster than its baud rate either, so pacing is the physically
  faithful transport, not a workaround.

## 2. Architecture proposal

### 2.1 Program delivery: "build" = filesystem image

- The build service gains a profile `esp32-micropython-1.29`: input `main.py` (+ optional modules);
  output = the pinned interpreter image + a LittleFS partition from a pinned `tbi-mklfs` (built
  from the pinned MicroPython sources).
- The artifact sha, ticket, store, grants and Session Host stay unchanged. Python syntax errors
  appear at run time as a traceback over serial, which is what the real board does. An optional
  `mpy-cross` syntax check at build would be the pinned compiler, not a re-implementation.
- `boot.py` is not written, so the interpreter's first-boot setup does not run (the filesystem
  mounts).

### 2.2 Fail-closed analysis without symbols: run-time refusal frames

Python has no linked-symbol analysis, so refusal must come from the emulator (EF-7 §3):
- a new bridge capability (e.g. `unmodelled`) and frame `U <vns> <facility>`;
- the host answers by refusing `unsupported_feature`, naming the facility, before any dead or
  crashed behaviour reaches the user.

Hooks, all found in this probe:

| Facility | Hook | Evidence |
|---|---|---|
| ADC | first read of `SENS_SAR_MEAS_START1/2` (or a write setting `MEAS1/2_START`) | P2: 12.6 M polls |
| GPIO interrupts | `GPIO_PINn` write with INT_ENA ≠ 0 | P3 probe |
| Touch, DAC, RMT, MCPWM, PCNT, sleep, Wi-Fi/BT | their register blocks' first access (today `unimp` regions) | `-d unimp` log lists `esp32.analog-apb`, `esp32.i2s0` and other unimplemented regions touched at boot; they need classifying (boot-time touches vs use) before they can refuse |

Boot itself touches some unimplemented regions (P2's log: `rtcio`, `iomux`, `i2s0`, `apbctrl`).
Only accesses that mean *use of the facility* may refuse, and each hook needs a test with an
Arduino and a MicroPython firmware that does not use the facility and must not be refused.

### 2.3 Serial input

The host paces serial input at the session's line rate (115200 8N1 default): at most
⌊rate × tick⌋ bytes per command tick, the remainder queued. This is deterministic (virtual time)
and faithful. It applies to Arduino sketches too; today their serial input is small enough not to
hit the loss.

## 3. Lifecycle and resources (measured)

| Quantity | Value |
|---|---|
| Boot to `main.py` | about 1.1 s of `ticks_ms`; first `main.py` output at about 1.6 s of virtual time |
| P1 run (2.5 s simulated) through the Session Host | 10.4 s wall, unpaced, 1 vCPU (boot dominates) |
| QEMU memory | Sprint 17C: RSS about 77 MB, peak about 112 MB, within the 384 MiB unit cap |
| Stop / Run | clean `ended/stopped`; each Run boots a fresh image (no state carried) |
| `machine.reset()` / `esp_restart` | reaches QEMU as a guest reset → `guest_reset`, as for Arduino (`-no-reboot`) |
| Exceptions | tracebacks arrive on serial; the session keeps running (REPL) |

## 4. Recommendation

Proceed to a **MicroPython slice** with three exit criteria, each from evidence above:
1. the build profile (§2.1) with a pinned `tbi-mklfs`, byte-reproducible;
2. Runtime v4 with `U` frames for ADC and GPIO interrupts (§2.2), each refusal tested, with no
   false refusals for the curated Arduino examples or MicroPython blink/PWM;
3. paced serial input (§2.3).

Product UI (editor mode, examples, EN/HE errors) only after those pass, since PWM, GPIO and I2C
already behave exactly. The ADC is not simulated in any case before the ADC decision
(EXPLORATION-FOUNDATION D-5); before that it is refused by name.
