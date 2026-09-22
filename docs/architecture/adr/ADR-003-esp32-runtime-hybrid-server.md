# ADR-003 — Classic ESP32 runtime is hybrid/server for V1

**Status:** Accepted (PM decision B1, 2026-09-22) · **Sprint:** 0 -> recorded in 1

## Context
Sprint 0 measured browser-local classic ESP32:
- the LX6 CPU under QEMU-WASM runs at ~10 M instructions/s, ~300x slower than native QEMU and ~24x
  slower than the real chip (estimate), using ~390-460 MB of memory;
- the ESP32 machine and peripherals are absent from every wasm-capable QEMU, and porting them is
  ~19,300 lines plus ~1,150 lines of GPIO.

Native execution is proven: MicroPython and Arduino firmware, bidirectional GPIO, both register
banks.

## Decision
V1 runs the **classic ESP32 server-side**, in a QEMU process per simulation session. Browser-local
classic ESP32 is an **R&D item**, with its measurements and porting research preserved. No other
ESP32 family member substitutes for the classic part.

## Consequences
- ESP32 projects need an online session (ADR-002).
- Hosting cost is roughly one core per active session (V1-ARCHITECTURE §12).
- Revisit if QEMU gains a wasm JIT for 32-bit guests or another runtime changes the numbers.

**Evidence:** SPRINT-0.md §5.6, §14.3, §15; `docs/research/browser-local-classic-esp32.md`.
