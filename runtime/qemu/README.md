# Classic-ESP32 runtime: QEMU baseline, patches, licence

This directory holds the **patches** TBI Lab applies to Espressif's QEMU for the classic ESP32
runtime (ADR-007). It holds no QEMU source. `runtime/provision/provision.sh qemu` fetches the
pinned upstream commit, verifies it, applies these patches in order and builds
`qemu-system-xtensa`.

## Upstream (R1.1)

| Item            | Value                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository      | https://github.com/espressif/qemu (Espressif's maintained fork of QEMU)                                                                               |
| Release tag     | `esp-develop-9.2.2-20260417` (tag object `6cdce334…`)                                                                                                 |
| Commit          | `40edccac415693c5130f91c01d84176ae6008566`                                                                                                            |
| QEMU base       | 9.2.2                                                                                                                                                 |
| Why this commit | Latest Espressif release. The `esp-develop` head after it only adds ESP32-C6 (RISC-V) work, so moving to it would bring nothing for the classic ESP32 |
| Target built    | `xtensa-softmmu` only, machine `esp32`                                                                                                                |
| Configure       | See `cmd_qemu` in `runtime/provision/provision.sh`. No capstone, SDL, GTK, VNC, OpenGL, docs, tools or user-mode; gcrypt on, `-Werror` off            |

The pin is in `runtime/provision/versions.env`. A change of upstream commit or of any patch
produces a new `runtimeId`: sha256 of the commit plus each patch's sha256, first 16 hex digits.
Every determinism fingerprint is pinned per `runtimeId`, so such a change requires a new
repeated-run baseline (see `docs/runtime/R1-REPORT.md`).

## Patches (R1.1, R1.11)

All patches were written by TBI Lab (0001–0005 in R1, 0006 onward in Sprint 12). None contains code from a community fork
(a159x36, lcgamboa/PICSimLab) or from any AGPL project (Velxio). Those were inspected as
references in Sprint 0 (`docs/research/classic-esp32-gpio-implementations.md`). Nothing from
them was copied.

| #    | Patch                                                                       | Origin                                                                                                                                                                                                                                                                                          | Size          |
| ---- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 0001 | accel/tcg: defer sleep=off icount warp during a round-robin slice           | Sprint 1 determinism fix (TBI, `docs/research/sprint-1-simulation-time.md`), applied unchanged                                                                                                                                                                                                  | 3 files, +20  |
| 0002 | hw/xtensa/esp32: synchronous APP CPU reset under icount                     | Sprint 1 determinism fix (TBI), applied with a 9-line offset                                                                                                                                                                                                                                    | 1 file, +17   |
| 0003 | hw/gpio/esp32_gpio: classic ESP32 digital GPIO register model               | New in R1. Clean-room from the ESP32 TRM (IO_MUX and GPIO Matrix chapter) and the ESP-IDF `soc/gpio_reg.h` offsets. Property-gated (`classic-registers`), so the ESP32-S3/C3 subclasses keep the upstream stub                                                                                  | 3 files, +254 |
| 0004 | hw/misc/tbi_bridge: TBI synchronous runtime bridge + `tbi-serial` chardev   | New in R1. Replaces the Sprint 0/1 `tbi-gpio-bridge`/`syncsock` design. No demo devices, no ignore-mask                                                                                                                                                                                         | 2 files, +385 |
| 0005 | accel/tcg, util/qemu-timer: host sync timers must not shape vCPU scheduling | New in R1 (closure blocker). Adds `QEMU_TIMER_ATTR_HOST_SYNC`; icount round-robin slices ignore such timers, a vCPU stopped by one resumes its slice, kicks from servicing it are discarded, and they do not count when deciding whether a new guest timer is earliest. The bridge tick uses it | 6 files, +134 |
| 0006 | hw/misc/tbi_bridge: bridge v2 handshake and scheduled inputs                | New in Sprint 12 (ADR-011 §1–2). `H tbi-bridge 2 <tick> <caps>`; `J`/`X` scheduled inputs in one queue (512 entries, ≥ 1 µs apart per pad) served by one `QEMU_TIMER_ATTR_HOST_SYNC` timer, applied silently at the exact virtual time; anything outside the limits exits 3                     | 1 file        |

The patch SHA-256s are recorded in each build's `runtime.json` and in the R1 report.

What 0001 and 0002 fix is still present upstream. Evidence: the unpatched baseline sometimes
produced no guest output at all under `-icount shift=3,sleep=off` (1 run in 8 at `shift=3`,
3 runs in 3 at `shift=0`), and never did so without `sleep=off`.

## Licence (R1.11)

- QEMU is **GPL-2.0** as a whole. Individual files carry their own compatible licences; see
  upstream `LICENSE`, `COPYING` and `COPYING.LIB`. The provisioned install copies these, plus
  the exact patches, into `<install>/share/tbi-lab-runtime/source/`.
- The TBI patches are **GPL-2.0-or-later**, matching the files they modify. New files (the bridge)
  carry that notice. The GPIO model keeps the Espressif copyright line and adds a TBI Lab line.
- **Process boundary.** QEMU runs as a separate process. The TBI host (TypeScript) talks to it only
  over the documented line protocol on a private TCP socket (`runtime/harness/protocol.ts`).
  No TBI product code is linked into QEMU, and no QEMU code is linked into the product. Whether
  the harness is a separate work for GPL purposes is a legal question, and this design is
  meant to keep that answer clear. It is not a legal opinion.
- **Source offer.** Distributing the QEMU binary to anyone (including in a container image or
  appliance) requires offering the corresponding source: upstream commit, these patches, and the
  build scripts. Running QEMU only on TBI's own servers is not distribution under GPL-2.0.
  That is the V1 server-side model, but the position should be confirmed by counsel before
  any hosted launch. `provision.sh` plus this directory are exactly the "complete corresponding
  source" recipe.
- **ESP32 mask ROM images.** QEMU loads Espressif's ROM dumps (`pc-bios/esp32-v3-rom.bin`,
  `esp32-v3-rom-app.bin`) from the upstream tree. `pc-bios/README` states **no licence for these
  files**. TBI does not redistribute them; provisioning fetches them from Espressif's repository.
  **Before any distribution of a runtime image, the terms for these ROM files need a PM/legal
  decision.**
- **Firmware toolchain.** The arduino-esp32 core (LGPL-2.1 and others) and MicroPython (MIT) are
  used only to build or provide the runtime test artifacts. They are not part of the product.
