# Classic-ESP32 runtime (R1)

The server-side MCU runtime for the original ESP32 (WROOM-32 DevKit; ADR-007). This is **not**
part of routine CI. It is provisioned and tested explicitly, on a host that can afford it.

```
runtime/
  provision/      provision.sh + versions.env: pinned, verified, scripted provisioning
  qemu/           patches applied to Espressif QEMU, licence notes (README.md)
  firmware/       runtime test firmware sources + artifacts.lock.json (pinned image hashes)
  harness/        host side: bridge protocol, sessions, overlays, the engine-closed loop
  tests/          *.runtime.test.ts, run by `npm run test:runtime`
```

## Provisioning (R1.4)

```sh
runtime/provision/provision.sh check     # host prerequisites (prints an apt line if missing)
runtime/provision/provision.sh all       # qemu + arduino + micropython + firmware
npm run test:runtime                     # all runtime tests against the provisioned runtime
```

Everything goes under `$TBI_RUNTIME_HOME`, which defaults to
`${XDG_DATA_HOME:-~/.local/share}/tbi-lab-runtime`. Nothing depends on a developer path. The
tests use the same default, or `TBI_RUNTIME_HOME` if set (`TBI_QEMU` overrides only the binary).
Each downloaded input is verified:

| Input                             | Verification                                                             |
| --------------------------------- | ------------------------------------------------------------------------ |
| Espressif QEMU                    | git fetch of the pinned commit; `rev-parse` must equal `QEMU_COMMIT`     |
| TBI patches                       | in-repo; their sha256 becomes part of the `runtimeId`                    |
| arduino-cli 1.5.1                 | tarball sha256 pinned per host architecture                              |
| arduino-esp32 3.3.12 + toolchain  | `core install` verifies each archive against the package index checksums |
| MicroPython ESP32_GENERIC v1.29.0 | sha256 pinned                                                            |
| Test firmware                     | rebuilt reproducibly; must equal `firmware/artifacts.lock.json`          |

Measured on the development host (1 vCPU aarch64, 3 GB RAM). Times and sizes: see
`docs/runtime/R1-REPORT.md`.

**Prerequisites (Debian/Ubuntu):** `build-essential git ninja-build pkg-config python3 python3-venv
flex bison curl libglib2.0-dev libpixman-1-dev libgcrypt20-dev libslirp-dev zlib1g-dev`.
`libslirp` is required because the Espressif tree compiles `net/slirp.c` even with
`--disable-slirp`.

**Reproducible firmware.** `provision.sh firmware` builds in a fixed staging path, maps host
paths out of debug and assert strings (`-ffile-prefix-map`), and pins `SOURCE_DATE_EPOCH`: the
Arduino core embeds `__DATE__`/`__TIME__`. The same pins give byte-identical images on any host
path. The test harness refuses any artifact whose sha256 differs from the lock.

## Session model

One session = one QEMU process = one private flash copy:

- The immutable artifact (mode 0444, named by its sha256) is verified.
- It is copied into a fresh 0700 directory.
- QEMU runs on the copy under `-icount shift=3,sleep=off` with `-no-reboot`.
- The directory is deleted at the end: guest flash/NVS writes are discarded.

The host answers every bridge frame before the guest continues. Commands apply only at 1 ms
simulation-time ticks. Pad feedback is solved and injected at the exact simulation time of the
pad event.

Session outcomes: `completed`, `guest_exit` (e.g. the guest requested a reset: unsupported),
`protocol_error_runtime`, `protocol_error_host`, `peer_lost`, `host_error`, `crashed`,
`timeout`, `stalled`, `start_failed`. Nothing restarts automatically.
