# ADR-006 — QEMU licensing and runtime boundary

**Status:** Accepted (PM decision B2, 2026-09-22) · **Sprint:** 0 -> recorded in 1

## Context
QEMU (Espressif, a159x36 and lcgamboa forks, upstream 10.1) is GPL-2.0, and so are our
modifications (enable-gating fix, `tbi-gpio-bridge` device, QEMU 10.1 patches).

## Decision
- QEMU is approved in principle as a **server-side** V1 component. **Shipping QEMU (native or WASM)
  to browsers is not approved.**
- QEMU runs as a **separate process** behind explicit IPC (chardev sockets, QMP). No application
  code is linked into it.
- Every QEMU modification keeps exact **upstream/fork provenance** and licence headers. Production
  builds carry a provenance manifest (`qemuBuild`, V1-ARCHITECTURE §14).
- The missing COPYING file in Espressif's prebuilt tarball is a packaging finding. The licence record
  uses the source-tree licensing.
- **Formal legal/licence review** is required before commercial distribution.
- The **ngspice-wasm** oracle stays dev/test-only.

## Consequences
- The GPL boundary coincides with a process boundary that also serves isolation (V1-ARCHITECTURE §11).
- Offering our GPIO fixes upstream would reduce the patch set we carry.

**Evidence:** SPRINT-0.md §15; V1-ARCHITECTURE §15. Engineering constraints only, not legal advice.
