# Phase 2 — Existing classic-ESP32 GPIO implementations

Investigation of whether an existing QEMU implementation gives us working classic-ESP32
GPIO, instead of writing one from scratch. Source review plus experimental reproduction.

**No MCU substitution anywhere in this work.** Everything below concerns the classic
`esp32` machine (Xtensa LX6).

## Candidates and provenance

| | **espressif/qemu** (our Gate B baseline) | **a159x36/qemu** | **lcgamboa/qemu** (PICSimLab) |
|---|---|---|---|
| Branch / tag | `esp-develop-9.2.2-20260417` | `esp-develop-9.2` | `picsimlab-esp32` |
| Commit | tag, published 2026-04-19 | `03be9af00c1026247d1e93eb0e4487add6af27de` (2026-07-07) | `e39508f79cb0681bbe15cfcebd40a3f45cdc3c48` (2026-09-19) |
| **QEMU base version** | **9.2.2** | **9.2.2** | **9.2.2** |
| Upstream of | — | fork of `espressif/qemu` | fork of `qemu/qemu` |
| Derivation | — | original qemu-esp32 lineage | from `a159x36`, per PICSimLab docs |
| `hw/gpio/esp32_gpio.c` | **108 lines (stub)** | **1091 lines** | **321 lines** |
| License | GPL-2.0 (+LGPL-2.1 parts) | GPL-2.0 (Espressif copyright header retained) | GPL-2.0 (PICSimLab project GPL-2.0) |
| Maintenance | Espressif releases 2024/2025/2026 | last push 2026-07-07 | last push **2026-09-19** |

**All three share the same QEMU 9.2.2 base.** A port between them is a same-version change,
not a rebase across QEMU releases. This is the single most important Phase 3 input.

### Velxio — inspected as reference only, nothing reused

Velxio (`davidmonterocrespo24/velxio`) is **AGPL-3.0**. Per the PM decision of 2026-09-20 it
may be inspected as technical evidence but **no code is copied into this repository or the
product**, and none has been. Two facts were taken from its public documentation only:

1. It uses the **lcgamboa QEMU fork** for classic ESP32 (Xtensa LX6), corroborating this
   lineage as the practical one.
2. Its ESP32 emulation runs **server-side**, not in the browser — see the browser findings
   below. It also uses **ngspice compiled to WebAssembly** for the analog side, which is the
   same oracle we chose for Gate A track A2.

## Register map fidelity

a159x36's `include/hw/gpio/esp32_gpio.h` was checked field by field against ESP-IDF's
authoritative `components/soc/esp32/register/soc/gpio_reg.h`. **All 20 offsets checked
match exactly**: `GPIO_OUT` 0x04, `OUT_W1TS` 0x08, `OUT_W1TC` 0x0c, `OUT1` 0x10,
`OUT1_W1TS` 0x14, `OUT1_W1TC` 0x18, `ENABLE` 0x20, `ENABLE_W1TS` 0x24, `ENABLE_W1TC` 0x28,
`ENABLE1` 0x2c, `STRAP` 0x38, `IN` 0x3c, `IN1` 0x40, `STATUS` 0x44, `STATUS1` 0x50,
`ACPU_INT` 0x60, `PCPU_INT` 0x68, `PIN0` 0x88, `FUNC0_IN_SEL_CFG` 0x130,
`FUNC0_OUT_SEL_CFG` 0x530.

This is the layout of the real part, not an invented one.

## Capability comparison

| Capability | espressif | a159x36 | lcgamboa |
|---|---|---|---|
| `GPIO_OUT` / `OUT1` real state | no | yes | yes |
| `W1TS` / `W1TC` (out and enable) | no | yes | yes |
| `GPIO_ENABLE` / `ENABLE1` | no | yes | yes |
| `GPIO_IN` / `IN1` | no | yes | yes |
| GPIO interrupts + trigger types | no | yes (per-CPU, edge/level) | yes |
| IOMUX region | no | yes (separate MMIO region) | partial (PINn regs) |
| GPIO matrix (`FUNC_IN/OUT_SEL`) | no | yes | yes (+ change notifications) |
| RTC IO region | no | yes | no |
| External output lines | no | 32 (`esp32_gpios`) | 32 (`esp32_gpios`) |
| External **direction** lines | no | no | **yes** (`esp32_gpios_dir`) |
| External input injection | no | 40 (`esp32_gpios_in`) | 40 (`esp32_gpios_in`) |
| **Drive gated on output-enable** | n/a | **NO** | **YES** |

### The output-enable finding

This is the one place where "it works" and "it is electrically correct" diverge, and it is
exactly the trap the PM warned about.

On real hardware a pad drives the net only when its output enable is set. In
`a159x36/hw/gpio/esp32_gpio.c` the emission is:

```c
if (s->gpio_out != oldvalue) {
    uint32_t diff = (s->gpio_out ^ oldvalue);
    for (int i = 0; i < 32; i++)
        if ((1 << i) & diff)
            qemu_set_irq(s->gpios[i], (s->gpio_out & (1 << i)) ? 1 : 0);
}
```

There is **no `gpio_enable` term**. A pin configured as an input whose `GPIO_OUT` bit
changes still reports a drive. Its `W1TS` path has the same issue in the input mirror:
`case A_GPIO_OUT_W1TS: s->gpio_out |= value; s->gpio_in |= value;` sets `GPIO_IN`
unconditionally, while the plain `A_GPIO_OUT` case correctly masks with `gpio_enable`.

lcgamboa's variant gates both, and additionally reports direction changes:

```c
if (((1 << i) & diff) && ((1 << i) & s->gpio_enable)) {
    qemu_set_irq(s->gpios[i], (s->gpio_out & (1 << i)) ? 1 : 0);
    ...
}
...
qemu_set_irq(s->gpios_dir[i], (s->gpio_enable & (1 << i)) ? 1 : 0);
```

For TBI Lab this matters directly: an ungated model would let a pin configured as an input
appear to drive the simulated network, which would produce wrong voltages and currents in
the Gate A solver. Electrically, an input pad is high impedance.

## The missing piece in every candidate

None of the three exposes GPIO **outside the QEMU process**. All of them expose `qemu_irq`
lines, which are in-process wiring; PICSimLab consumes them by linking QEMU as a shared
library. TBI Lab needs a process boundary (QEMU <-> our solver), so a small bridge device is
required whichever implementation is chosen. That device is
`experiments/gate-c-bridge/qemu-patch/tbi_gpio_bridge.c` (192 lines, GPL-2.0, ours).

## Port size, if we take the Preference A route

Comparing `espressif/qemu@esp-develop-9.2.2-20260417` with `a159x36:qemu@esp-develop-9.2`
(GitHub compare API): **88 commits ahead, 10 behind, 132 files changed, +60,918 / -553**.

That total is dominated by things we do not want:

| File | Change | Wanted? |
|---|---|---|
| `hw/display/ttgos3_board_skin.c` | +17,764 | no — board artwork |
| `hw/display/ttgo_board_skin.c` | +13,348 | no — board artwork |
| `hw/sensor/mpu6050_image.h` | +8,775 | no |
| `hw/misc/servo*_skin.c` | +10,127 | no |
| **`hw/gpio/esp32_gpio.c`** | **+1,012 / -24** | **yes** |
| **`include/hw/gpio/esp32_gpio.h`** | **+118** | **yes** |
| `hw/xtensa/esp32.c` | +264 / -58 | partly — machine wiring |
| `include/hw/misc/esp32_reg.h` | +5 / -1 | yes |

**The GPIO/IOMUX surface we actually need is roughly 1,150 lines across three files**, on an
identical QEMU 9.2.2 base.
