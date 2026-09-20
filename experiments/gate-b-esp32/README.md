# Gate B — ESP32 Classic Feasibility

Feasibility investigation. **Not product code.**

## Question

Can the original/classic ESP32 (Xtensa LX6, as used on common DevKit boards) realistically
execute in our intended architecture — and can its GPIO be driven and observed from outside
the emulator?

**No MCU substitution was made or assumed.** Everything below is the classic `esp32`
machine. Where a newer ESP32 variant would have helped, that is recorded as a finding for
the PM, not acted on.

## Verdict: CONDITIONAL PASS

Real classic-ESP32 firmware executes faithfully and cheaply on the dev host. **But the GPIO
peripheral in Espressif's QEMU fork is a stub**, so the bidirectional MCU <-> electrical
bridge that Gate C needs cannot be built on it as it stands. Per the sprint rule, the
workaround was **not** implemented; it is costed and handed back for a PM decision.

## Artifacts used (kept outside git)

| Artifact | Detail |
|----------|--------|
| Emulator | `espressif/qemu`, release **esp-develop-9.2.2-20260417** (published 2026-04-19) |
| Asset | `qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-aarch64-linux-gnu.tar.xz` |
| URL | `https://github.com/espressif/qemu/releases/download/esp-develop-9.2.2-20260417/qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-aarch64-linux-gnu.tar.xz` |
| SHA256 | `00de5985094c14e47d1b38464a006b8ed64fd0fa7a289c56da24f3a329f65339` |
| Size | 15,111,492 bytes compressed / 72 MB unpacked |
| License | **GPL-2.0** (with LGPL-2.1 components). NOTE: the prebuilt tarball ships **no LICENSE/COPYING file** — a compliance gap if these binaries are ever redistributed. |
| Installed at | `/home/ubuntu/tbi-tools/qemu` (outside the repository) |
| Extra host libs | `libsdl2-2.0-0`, `libslirp0`, `libgcrypt20`, `libpixman-1-0` |

| Test firmware | Detail |
|---------------|--------|
| Image | MicroPython **ESP32_GENERIC v1.29.0** (build 20260824) |
| URL | `https://micropython.org/resources/firmware/ESP32_GENERIC-20260824-v1.29.0.bin` |
| SHA256 | `e67ad6015a0a504c1fec9aa9bbf589d0432ed28e62546f4f8dd8a147f8bd95f6` |
| Size | 1,790,544 bytes |
| Target | `ESP32_GENERIC` = original ESP32, Xtensa LX6. Confirmed by the runtime banner: `Generic ESP32 module with ESP32` |
| License | MIT |

**Scope note:** MicroPython is used here purely as a convenient, trustworthy prebuilt
classic-ESP32 binary for proving that the emulator runs real firmware. This is **not**
MicroPython support, and no MicroPython capability is being built.

## Firmware image format

QEMU wants a **single merged flash image**, not separate binaries. The MicroPython release
`.bin` is a combined bootloader + partition table + application blob intended for flash
offset `0x1000`, so the test image is a 4 MB flash file with that blob written at `0x1000`.

## Result 1 — real classic-ESP32 firmware executes: **YES**

```
ets Jul 29 2019 12:21:46
rst:0x1 (POWERON_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)
configsip: 0, SPIWP:0xee
mode:DIO, clock div:2
load:0x3fff0030,len:4200
load:0x40078000,len:15236
load:0x40080400,len:3344
entry 0x400805a8
MicroPython v1.29.0 on 2026-08-24; Generic ESP32 module with ESP32
>>>
```

The mask ROM bootloader, the second-stage bootloader and the application all run, reaching
an interactive REPL.

## Result 2 — external GPIO interaction: **NO**

`gpio_probe.py` drives GPIO2 from guest firmware three different ways and then looks for the
result from inside the guest, from the QEMU monitor, and through the GDB stub.

```
firmware_executes            = True
gpio_out_before              = '0x0'
gpio_out_after_api           = '0x0'     <- machine.Pin(2, Pin.OUT).value(1)
gpio_enable_after_api        = '0x0'
pin_value_readback           = 0
gpio_out_after_w1ts          = '0x0'     <- direct write to GPIO_OUT_W1TS
gpio_out_after_direct        = '0x0'     <- direct write to GPIO_OUT
host_observed_gpio_out       = 0x00000000 <- QEMU monitor: xp/1wx 0x3ff44004
gdb_write_reply              = OK         <- GDB stub accepted a write to GPIO_IN...
gdb_host_readback            = 00000000   <- ...and the value did not stick
gpio_in_after_host_write     = '0x0'      <- guest still reads 0

PASS  firmware executes real classic-ESP32 code
FAIL  firmware-driven GPIO output retained (driver API)
FAIL  firmware-driven GPIO output retained (direct register write)
FAIL  GPIO output enable retained
FAIL  host can observe GPIO output state
FAIL  host can inject a GPIO input level
```

Note the GDB stub replies **`OK`** to a write that is silently discarded. A host tool can
believe it has set an input level when nothing happened — a trap worth recording.

### Root cause (confirmed in the fork's source)

`hw/gpio/esp32_gpio.c` at tag `esp-develop-9.2.2-20260417` is a stub:

- `esp32_gpio_read()` handles exactly one register, `A_GPIO_STRAP` (0x0038), and returns
  **0 for everything else**;
- `esp32_gpio_write()` is an **empty function body** — every write is discarded;
- `Esp32GpioState` holds only `strap_mode`. There is no output latch, no enable register,
  no input state, no GPIO matrix and no IOMUX routing.

This matches Espressif's own documentation, which mentions only strap-mode configuration.

### Other peripherals the firmware touched that are not implemented

Counted from QEMU's `-d unimp` log during a single boot:

| Peripheral | Accesses |
|-----------|----------|
| `esp32.iomux` | 72 |
| `esp32.analog` | 46 |
| `esp32.rtcio` | 38 |
| `esp32.apbctrl` | 32 |
| `esp32.i2s0` | 28 |
| `esp32.i2s1` | 2 |

IOMUX being unimplemented matters: even a complete GPIO register block would still need pin
routing to behave like real hardware.

### Switching ESP32 variant would not fix this

`hw/gpio/esp32s3_gpio.c` is a **49-line stub as well**. The gap is not specific to the
classic part, so there is no GPIO-related argument for substituting another ESP32 — which
the MCU Rule forbids in any case.

## Result 3 — cost on the dev host (native aarch64, 1 core)

| Metric | Value |
|--------|-------|
| Boot to REPL | **3.29 s** wall, ~3.1 s CPU |
| Peak RSS | **~209 MB** (`VmHWM`) |
| Virtual size | ~1.2 GB (reservation, not committed) |
| CPU while idle at REPL | ~0 % — the guest executes `WAITI` and QEMU sleeps |
| Unpacked tool size | 72 MB |

Comfortable on a 1-core / 3.8 GB host. These are **native** figures and are a *lower bound*
for any browser port.

## Result 4 — browser delivery: not available today

- Espressif's fork is based on **QEMU 9.2.2**.
- Upstream QEMU gained **Emscripten/WebAssembly** support in **10.1**, and that support is
  **experimental and limited to 32-bit guests via TCI**, QEMU's slow *interpreter* backend.
- So a browser-local classic ESP32 is **not a version bump**. It needs Espressif's ESP32
  patches rebased onto a WASM-capable upstream, plus a WASM build, plus validation.
- Browser startup and runtime cost are therefore **unmeasured**. Given TCI interpretation,
  expect materially worse than the 3.3 s / 209 MB native figures.

## Licensing

QEMU is **GPL-2.0**. Using it locally for Sprint 0 experiments creates no distribution
obligation. **Shipping it to browsers is distribution**, which would trigger source-offer
obligations and raise a combined-work question for our loader/glue code. Per the PM
decision of 2026-09-20 this remains **unresolved and uncommitted** in Sprint 0.

## Answers to the Gate B checklist

| Question | Answer |
|----------|--------|
| Can real classic ESP32 firmware execute? | **Yes**, verified |
| What emulator/runtime is available? | Espressif's QEMU fork, classic `esp32` machine, dual-core LX6 |
| Runs on / developed from ARM64 host? | **Yes**, official prebuilt aarch64 binaries; no local build needed |
| Can it be delivered to a browser? | **Not today** — see Result 4 |
| Expected browser startup cost? | **Unmeasured**; native lower bound 3.3 s |
| Expected runtime CPU/memory? | ~209 MB RSS, ~0 % idle CPU natively; worse under TCI/WASM |
| Firmware image format? | Single merged flash image |
| Can GPIO be observed/controlled externally? | **No** — device is a stub (Result 2) |
| Arduino supportable later? | Plausible — ESP-IDF based, same image format — but **untested** |
| MicroPython supportable later? | Demonstrated running (as a test artifact only) |
| Peripherals realistically emulated? | UART, SPI flash, eFuse, timers/WDT, crypto (AES/SHA/RSA), Ethernet MAC, SD/MMC, PSRAM. **Not** GPIO, IOMUX, RTCIO, analog, I2S |
| Licensing obligations? | GPL-2.0; fine internally, unresolved for shipping |
| GPL/distribution implications? | Yes — see Licensing |
| Remaining gaps? | GPIO/IOMUX device model; browser port; Arduino validation |

## Estimated engineering gap (not implemented)

To make Gate C possible on this runtime, someone must implement a real GPIO peripheral in
the QEMU fork:

1. **GPIO register block** — `GPIO_OUT/OUT1`, `W1TS/W1TC`, `ENABLE/ENABLE1`, `IN/IN1`,
   direction and interrupt-status registers, backed by actual state.
2. **External interface** — expose pin state out of QEMU and accept driven levels in, e.g.
   via `qemu_irq` lines plus a control channel (chardev/socket), so the electrical solver
   can sit on the other end.
3. **IOMUX/GPIO-matrix routing**, at least minimally, so pin function assignment behaves.
4. **Maintenance** — this is a carried patch against a moving GPLv2 fork.

Rough estimate, stated with its assumptions: **1-3 weeks** of focused engineering for basic
bidirectional digital GPIO without full IO-matrix fidelity, by someone comfortable in QEMU
device models; longer with IOMUX and peripheral routing. This has not been prototyped, so
treat it as an order-of-magnitude figure, not a commitment.

## Reproducing

```
python3 gpio_probe.py \
  --qemu  /home/ubuntu/tbi-tools/qemu/bin/qemu-system-xtensa \
  --flash /home/ubuntu/tbi-tools/fw/flash-4mb.bin
```

Exits non-zero while GPIO is unusable, so a future fix is detectable. Host stdlib only: no
virtualenv, no third-party packages, no change to system Python.
