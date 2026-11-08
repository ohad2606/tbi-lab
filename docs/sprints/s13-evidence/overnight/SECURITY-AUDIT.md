# Security and multi-user isolation audit (overnight, 2026-10-13)

**Method.** A read-only code review of runtime/host, runtime/builder, runtime/identity, runtime/policy, deploy/dev-lab/s8 and the frontend import path. Each candidate was then verified by reading the code, and where fixed, by a test that fails before the fix and passes after.

**Not done:** intrusive or destructive tests against deployed systems. The fixes below are **implemented and tested locally; none is deployed** (DEV and staging still run `dc1bff8`).

## Holding controls (verified, with existing tests)

| Control | Where | Existing tests |
|---|---|---|
| Identity: the gate's `x-forwarded-user` → an HMAC principal; malformed or duplicate headers refused; forged `X-Tbi-*` stripped by Caddy | `identity/principal.ts`, Caddyfile | `identity.test.ts`, `s8-gate.runtime.test.ts` |
| Session ownership: every route checks owner + token (constant time); wrong session, owner or token all give one indistinguishable 404; 128-bit ids, 192-bit tokens; token in a header only | `host/http.ts`, `host/host.ts` | `host/tests/ownership.test.ts`; **under load on staging**: c5-deployed isolation (status, events, command, end by a foreign user → 404; owner unaffected) |
| Build ownership: status by owner + token; lookup and cache only within the caller's grants (no cross-user source or log leak); pending builds joined only by the same owner | `builder/service.ts`, `grants.ts` | `builder/tests/ownership.test.ts`, `s8-containment` |
| Tickets: HMAC, domain-separated, expiring, bound to principal and artifact | `identity/ticket.ts`, `host/host.ts` | ownership tests |
| Input limits: host 1 MiB create / 8 KiB command / 500 components…; builder 1 MiB, ≤ 16 files, safe names (no traversal), one 64 KiB sketch; prebuilt exactly 4 MiB | protocols | `http.test.ts`, `service.test.ts`, `failures.test.ts` |
| Frontend import: 2 MiB, prototype keys refused, exact key sets, integrity hash, finite in-range values | `domain/package.ts`, `validate.ts` | `package.test.ts` |

**No path was found by which one user can read, command or end another user's session or build.**

## Findings and outcomes

| # | Severity | Finding (verified) | Outcome |
|---|---|---|---|
| 1 | **High** | Unlimited event streams per session, each buffering up to 1 MiB: one user could exhaust the shared Session Host (MemoryMax 512 M), ending every user's sessions | **Fixed** (`e4ecbeb`): at most 4 streams per session (429); bound = sessions × 4 MiB. Test: `http.test.ts` |
| new | **High** (robustness) | A runtime launcher that throws escaped the bridge `listen` callback: the session never settled, and in the Session Host the uncaught exception would end the process for **every** user. Real triggers in the systemd launcher: a session layout mismatch, a failed `chmod`, or a failed env-file write (e.g. disk full) | **Fixed** (`e4ecbeb`): becomes a `start_failed` outcome. Test: `failures.test.ts` |
| 2 | Medium | When a sandboxed session ended, the launcher waited for its unit with synchronous `systemctl` + `sleep` (up to 100 rounds): the host's single event loop stalled every other user's ticks, commands and streams. This also bears directly on the five-session pacing criterion | **Fixed** (`d37bc34`): asynchronous wait. Test with a slow fake systemctl: 1018 ms stall before, < 150 ms after. **The deployed effect needs deployment approval to verify** |
| 4 | Medium | A build request (up to 1 MiB) was stored in a build record for up to 24 h before the 64 KiB source check | **Fixed** (`e4ecbeb`): refused at submit (413 `source_too_large`), no record. Test: `service.test.ts` |
| 6 | Low | Internal and runtime error text (it can name server paths) reached clients in the `failed` state event | **Fixed** (`e4ecbeb`): reason code only; text to the service log. Test: `failures.test.ts` |
| 9 | Low | Build status token compared with `!==` | **Fixed** (`8e6e0b4`): constant-time comparison |
| 3 | Medium | One global artifact store cap (256 MiB ≈ 64 images) shared by all users: users can evict each other's unleased builds (effect: "Build required" again; curated reference images are not evictable) | **Configuration for the alpha VM**: `TBI_ARTIFACT_CAP_MB` ≥ users × quota (5 × 128 = **640 MiB**). Recorded in the capacity procedure's preflight. Not changed here (deployed configuration) |
| 5 | Low–medium (defense in depth) | Both backend services are in the `tbi-gate` group, so either can reach the other's socket with any identity header | **Documented**: a unit and group change for a later hardening; needs approval |
| 7 | Low | Uploading a byte-identical copy of another user's image reveals `origin: build` | Documented (requires the exact 4 MiB bytes) |
| 8 | Low | A ticket is reusable until it expires (10 min), bound to its principal | Documented (only `maxSessions` limits it) |
| 10 | Low (suspicion) | Session-create fields bounded only by the 1 MiB body; a 500-component compile runs on the event loop | Documented; measure on the alpha VM |
| 11 | Low (requires a QEMU or toolchain escape first) | The host reads sandbox-writable files following symlinks; the job `ExecStopPost` `chmod` follows symlinks | Documented for a later hardening |
| 12 | Low | Pre-sandbox legacy units (`deploy/dev-lab/tbi-*.service`, `setup-build.sh`) still in the repository; they cannot start with current code | Documented (removing files needs approval) |
| 13 | Low | Frontend import: no count or length limits beyond 2 MiB; integer coordinates unbounded (e.g. 1e300) | Documented: self-inflicted (the importer's own browser only) |

**Release blockers from this audit: none open.** The two high findings and the medium event-loop
stall are fixed in code. They reach users only with the next approved deployment, so DEV and
staging (`dc1bff8`) still carry #1, #2 and the launcher crash path until then.
