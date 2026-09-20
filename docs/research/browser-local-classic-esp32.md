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

**Conclusion: browser-local classic ESP32 is not achievable in Sprint 0.** The blocker is
**build/porting effort**, not CPU architecture, not licensing, and not browser limits.

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
| glib 2.84.0 | see below | needs `PKG_CONFIG_LIBDIR` isolation, or meson finds **host** pcre2/sysprof and the emscripten compile fails on missing headers |

The host-leak problem is worth recording: with only `PKG_CONFIG_PATH` set, meson picked up
`/usr/include/sysprof-6` and host pcre2, then failed compiling `gregex.c` with
`fatal error: 'pcre2.h' file not found`. Setting `PKG_CONFIG_LIBDIR` to the wasm target's
`pkgconfig` directory, disabling sysprof, and forcing the pcre2 subproject fallback is the
fix.

## What this means for the architecture

- **Native classic ESP32 is proven** (Gates B/C, Phase 6): real firmware, real GPIO, both
  directions, Arduino and MicroPython.
- **Browser-local classic ESP32 is not demonstrated and is not near.** The blocker is
  cleanly classified: **porting effort**, with a measured size (~19,300 + ~1,150 lines), not
  an architectural impossibility.
- **This is a PM decision point**, because the obvious remaining route is a hybrid or
  server-side runtime — which Sprint 0 was explicitly told not to fall back to silently.
