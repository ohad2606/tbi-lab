# Phase 5 — Browser-local classic ESP32

Can the original/classic ESP32 (Xtensa LX6) execute **inside the browser**, running real
firmware, with GPIO observable and injectable?

This is one of the fundamental architecture questions, so it is answered from evidence, not
assumption. **A generic Xtensa core does not count, and no C3/S3 substitute counts.**

## Summary of the evidence

| Question | Answer | Basis |
|---|---|---|
| Does QEMU support WebAssembly hosts at all? | **Yes**, since **10.1**, experimental | upstream release + source |
| Is the Xtensa *target* buildable for wasm? | **Yes** — QEMU's own CI builds it | `.gitlab-ci.d/buildtest.yml` |
| Does a wasm-capable QEMU contain the **classic ESP32 machine**? | **No** | upstream has no ESP32 machine |
| Does the ESP32-capable QEMU support wasm? | **No** — it is QEMU 9.2.2, predating wasm support | `VERSION` files |
| Does anyone ship browser-local classic ESP32? | **No** — the leading product runs it server-side | Espressif developer portal |

**Conclusion: browser-local classic ESP32 is not achievable in Sprint 0.** The blockers are
**porting effort** (the ESP32 machine) and **interpreted execution speed** (measured ~24x
slower than real silicon). Delivery size, memory, Worker hosting and licensing mechanics are
not the blocker. See Finding 6 for the measurements.

## Finding 1 — QEMU's wasm support exists, and includes Xtensa

QEMU 10.1 upstreamed experimental Emscripten host support for **32-bit guests via TCI**,
QEMU's interpreter backend. Xtensa is a 32-bit guest, so it is eligible.

More concretely, QEMU's own CI builds a wasm target set. In `v10.1.0`'s
`.gitlab-ci.d/buildtest.yml`:

```yaml
build-wasm:
  extends: .wasm_build_job_template
  timeout: 2h
  variables:
    IMAGE: emsdk-wasm32-cross
    CONFIGURE_ARGS: --static --disable-tools --enable-debug --enable-tcg-interpreter
```

`TARGETS` is **unset**, and the template only passes `--target-list` when it is set. So the
job builds QEMU's **default target list — which includes `xtensa-softmmu`**. Upstream
therefore already builds an Xtensa system emulator for WebAssembly, with a 2-hour CI budget
on far larger machines than ours.

## Finding 2 — the decisive gap: the ESP32 machine is not in any wasm-capable QEMU

Upstream QEMU has Xtensa boards (`sim`, `lx60`, `lx200`, `ml605`, `kc705`, `virt`) built
around the `dc232b` core. **It has no ESP32 machine at all.** ESP32 support lives in
Espressif's fork.

Measured with the GitHub compare API,
`qemu/qemu@v9.2.2 ... espressif/qemu@esp-develop-9.2.2-20260417`:

| Metric | Value |
|---|---|
| Commits ahead of upstream | **121** |
| Files changed | **237** |
| Lines | **+19,292 / -90** |
| ESP32-specific files | **159**, totalling **+16,261** lines |

Largest single additions: `hw/dma/esp_gdma.c` (+1,023), `hw/timer/esp_timg.c` (+855),
`hw/nvram/esp_efuse.c` (+670), `hw/timer/esp32_timg.c` (+665), `hw/misc/esp32_dport.c`
(+477), `hw/misc/esp_aes.c` (+476).

And the GPIO work Gate C depends on is **not in Espressif's fork either** — it is a further
~1,150 lines from `a159x36`, plus our 42-line correctness patch and 192-line bridge device.

So a browser-local classic ESP32 requires **all** of:

1. rebasing ~19,300 lines of ESP32 machine and peripheral code from QEMU **9.2.2 to 10.1+**,
   across roughly three upstream releases of device-model API drift;
2. carrying the ~1,150-line GPIO/IOMUX implementation on top;
3. carrying our GPIO correctness patch and external bridge;
4. getting that combination to build under Emscripten and validating it;
5. then measuring whether TCI-interpreted Xtensa is fast enough to be usable.

Steps 1-3 are ordinary but substantial porting work. Step 5 is unknown and cannot be
assessed before steps 1-4 are done.

## Finding 3 — the leading "browser ESP32" product runs it on a server

Velxio markets browser-based ESP32 simulation. Its architecture, per **Espressif's own
developer-portal article** about it, is:

> "ESP32 boards run on a QEMU fork with Xtensa LX6/LX7 and RISC-V system emulation"

with the split stated explicitly:

> "AVR and RP2040 boards run entirely in the browser via avr8js and rp2040js"

ESP32, ESP32-S3, ESP32-C3, STM32 and Raspberry Pi boards **boot a real QEMU machine on the
backend and stream GPIO and serial to the canvas**. Only the small 8/32-bit cores run in the
page. Velxio uses the **lcgamboa fork** for Xtensa LX6 — the same lineage Gate C uses — and
**ngspice compiled to WebAssembly** for the analog side, which is the same oracle TBI Lab
chose for Gate A.

This does not prove browser-local ESP32 is impossible. It does show that a well-resourced,
actively developed product in exactly this space concluded that server-side QEMU was the
practical route, while still running smaller MCUs client-side.

Velxio is **AGPL-3.0**. It was inspected as reference evidence only; no code was copied into
this repository or the product.

## Finding 4 — browser requirements, from QEMU's own build configuration

`configs/meson/emscripten.txt` in QEMU master pins the link flags:

```
-pthread -sASYNCIFY=1 -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM
-sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2GB -sWASM_BIGINT -sEXPORT_ES6=1
```

Concrete consequences for TBI Lab, independent of any porting work:

- **`-pthread` / `PROXY_TO_PTHREAD` require SharedArrayBuffer**, which requires the page to
  be **cross-origin isolated**: `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. That is a hosting constraint on the whole
  TBI Lab page, and it breaks embedding of non-CORP third-party resources.
- **`TOTAL_MEMORY=2GB` is reserved up front.** Combined with the wasm32 4 GB address-space
  ceiling, this is a heavy per-tab budget.
- **`EXPORT_ES6=1`** means the artifact is an ES module, which suits a Worker-hosted design.
- **`ASYNCIFY`** carries a known size and speed penalty.
- Execution uses **TCI, an interpreter**, for 32-bit guests. QEMU's wasm work compiles only
  hot translation blocks to wasm, so steady-state speed is well below native QEMU, which is
  itself well below real silicon.

## Finding 5 — reproducing the toolchain on this host

The Emscripten dependency chain from QEMU's own `emsdk-wasm32-cross.docker` (zlib 1.3.1,
libffi 3.4.7, pixman 0.44.2, glib 2.84.0) was reproduced **natively on this ARM64 host**,
without Docker, using Ubuntu's Emscripten 3.1.69 (QEMU's recipe pins emsdk 3.1.50).

Results and the problems hit, recorded because they are the reusable part:

| Dependency | Result | Notes |
|---|---|---|
| zlib 1.3.1 | **built** | needed the distro's frozen `EM_CACHE`; overriding it breaks emcc |
| libffi 3.4.7 | **built** | use the release tarball, not git: `autoreconf` needs libtool macros. `--disable-builddir` is required or configure re-execs into a bogus path |
| pixman 0.44.2 | **built** | meson cross file |
| glib 2.84.0 | **built** | needs `PKG_CONFIG_LIBDIR` isolation, or meson finds **host** pcre2/sysprof; and two libc stubs (below) |

The host-leak problem is worth recording: with only `PKG_CONFIG_PATH` set, meson picked up
`/usr/include/sysprof-6` and host pcre2, then failed compiling `gregex.c` with
`fatal error: 'pcre2.h' file not found`. Setting `PKG_CONFIG_LIBDIR` to the wasm target's
`pkgconfig` directory, disabling sysprof, and forcing the pcre2 subproject fallback is the
fix.

Two further problems, both caused by glib's configure probing with undefined symbols
allowed: it "detected" `pthread_getname_np` and `posix_spawnp`, which Debian's Emscripten 3.1.69
does not provide, so every final link failed. A 30-line compat library supplies them: the thread
name is cosmetic and returns empty; process spawning returns `ENOSYS`, since WebAssembly cannot
spawn processes. Both fail honestly rather than pretend.

## Finding 6 — MEASURED: the classic ESP32's LX6 CPU running in the browser

After the dependency chain, **QEMU 10.1 itself was built for WebAssembly on this ARM64 host**,
with the classic-ESP32 **LX6 CPU core** ported in, and run in Chromium.

**What this measures, and what it does not.** It runs the classic ESP32's CPU core on QEMU's
generic `sim` machine: real LX6 instructions, but **no ESP32 ROM, no peripherals, no GPIO**.
It is therefore **not** "classic ESP32 firmware in the browser" and is not reported as a PASS.
Its purpose is to measure the half of the problem that porting cannot fix: whether interpreted
Xtensa execution is fast enough to be worth porting the machine for.

### Porting done to get here

| Change | Size | Nature |
|---|---|---|
| ESP32 LX6 core config into QEMU 10.1 | 5 files, ~20,180 lines | Espressif-generated core files from the a159x36 tree; two include renames and one header path. Mechanical |
| `sim` machine: re-apply ELF entry after reset | ~15 lines | the ESP32 core's reset vector (`0x50000000`) is unmapped on `sim` |
| `meson.build`: skip nested `@block.syms`/`@qemu.syms` under Emscripten | ~5 lines | Debian's emcc does not expand nested response files; both lists are empty in a static build |
| Configure without SDL/UI; append compat library to the cross file's link args | config only | the cross file's `c_link_args` silently overrides `--extra-ldflags` |

The CPU core port being mechanical is itself a finding: the CPU is the easy ~20k lines. The
~19k-line *machine and peripheral* port measured in Finding 2 is not.

### The benchmark

`experiments/gate-b-esp32/lx6-bench/`: a deterministic bare-metal integer workload (xorshift32,
multiply-accumulate, data-dependent branch), compiled with Espressif's GCC 14.2 for the LX6. Its
hot loop is **13 LX6 instructions per iteration** using the zero-overhead `loop` instruction.
Every result is checked against an independent Python implementation.

One bug in our own benchmark was found and fixed on the way, and it is worth recording because
real firmware authors hit it too: reset leaves `PS.EXCM` set, and the Xtensa ISA disables
zero-overhead loop-back while EXCM is set. QEMU implements that rule correctly; our startup
code had not cleared EXCM, so every hardware loop silently ran wrong. Real ESP-IDF startup
clears it.

### Results

Native and wasm are built from **the same patched QEMU 10.1 source**, so the comparison is
like-for-like. Wasm figures are two full measurement passes in Chromium 153 on this 1-core host.

| Metric | Measured |
|---|---|
| Correct result under wasm | **Yes** — `0x7577d9f4` (2M) and `0x946faeb2` (20M) match Python and native |
| `qemu-system-xtensa.wasm` | **26.1 MB** raw, **9.07 MB** gzip -9 |
| `qemu-system-xtensa.js` loader | 339 KB raw, 85 KB gzip -9 |
| Module import | 24-54 ms (warm local server) |
| Import -> Emscripten runtime initialised | **1.0-1.3 s** |
| Fixed start-up overhead before guest compute | **~4.9-6.2 s** (runtime init + QEMU init + first translations) |
| Guest speed, wasm (TCI interpreter) | **~1.30 us/iteration = ~10 M LX6 instructions/s** |
| Guest speed, native QEMU 10.1 | 4.25 ns/iteration = ~3.06 G LX6 instructions/s |
| **wasm vs native QEMU** | **~300x slower** (297x and 317x in the two passes) |
| wasm vs a real 240 MHz ESP32 | **~24x slower** — *estimate*, assuming 1 instruction per cycle |
| Chromium RSS, idle baseline | ~390 MB |
| Chromium RSS, peak while running | 776-847 MB, i.e. **~390-460 MB attributable** |
| CPU | the single core was saturated: 28.1 s CPU for 31.8 s wall |
| Runs in a Worker | **Yes** — `PROXY_TO_PTHREAD` runs QEMU's `main()` in a pthread Worker; the page's 10 ms timer loop kept ticking (2,966 ticks over 31.8 s, ~93 % of ideal) |
| Cross-origin isolation | **Required and verified** (`crossOriginIsolated === true` under COOP/COEP) |

### What the numbers mean

- **Delivery is plausible.** ~9 MB compressed, ~1 s runtime init, runs in a Worker without
  blocking the page. These are ordinary numbers for a serious web app.
- **Execution speed is the real problem.** Interpreted LX6 runs at ~10 MIPS, roughly **24x
  slower than the real chip**. Firmware that mostly waits (blink, poll a pin, sleep) might be
  tolerable; anything CPU-bound — ESP-IDF start-up, Wi-Fi stacks, MicroPython itself — would run
  far slower than real time. Upstream QEMU 10.1 uses TCI only for 32-bit wasm guests; the
  translate-hot-blocks-to-wasm approach in `ktock/qemu-wasm` is not upstream and was **not
  measured** here.
- **This host understates a desktop somewhat.** Chromium's main thread, the QEMU Worker and
  everything else shared one core. A multi-core desktop gives the Worker a core of its own, but
  per-core TCI speed, which dominates, would not change by an order of magnitude.

## What this means for the architecture

- **Native classic ESP32 is proven** (Gates B/C, Phase 6): real firmware, real GPIO, both
  directions, Arduino and MicroPython.
- **Browser-local classic ESP32 is not demonstrated.** The blocker now has two measured parts:
  1. **porting effort** — the ESP32 machine and peripherals (~19,300 lines) plus GPIO
     (~1,150 lines) onto a wasm-capable QEMU; the CPU core port (~20,180 generated lines) turned
     out to be mechanical;
  2. **Xtensa execution performance** — ~10 MIPS under TCI, ~24x slower than real silicon
     (estimate), ~300x slower than native QEMU (measured).
  Browser memory, threading and delivery size were measured and are **not** the blocker.
- **This is a PM decision point**, because the obvious remaining route is a hybrid or
  server-side runtime — which Sprint 0 was explicitly told not to fall back to silently.
