# Sprint 8 — Public Hardening & Capacity

**Status:** PHASES 0–3 COMPLETE (identity, ownership, containment); awaiting the PM checkpoint.
Phases 4–6 not started. Nothing deployed to dev-lab or production; `main` unchanged. No product code has changed and nothing is
deployed.

**Base:** `sprint-7-complete^{}` = `a2ad7c6`. **Branch:** `sprint-8`. **Architecture:**
[SPRINT-8-ARCHITECTURE.md](SPRINT-8-ARCHITECTURE.md) (D-S8-1..13, owner decisions Q1–Q6).

## Phase 0

Spikes ran on the preview host with transient artifacts only, and all were removed afterwards
(verified). The dev-lab configuration was not changed, and the four services stayed active.

### A. Build sandbox → systemd template units (D-S8-6)

**The real pinned build ran inside a per-job systemd sandbox.**
- **Isolation.** The job had its own dynamic uid and saw only read-only system binaries, the
  read-only toolchain and its own job directory. It had no network and a restricted syscall set.
- **Bit-identical output.** The TbiGpioProof image is bit-identical to Sprint 7
  (`7e877f84…`) when the compiler's working directory equals the service's (the sketch
  directory).
- **Outcome 1 holds.** Checked against every property in mandatory outcome 1:
  - no access to the artifact store, home directories, credentials, another job's workspace,
    service code or the gate configuration;
  - `/etc` empty;
  - no network beyond an isolated loopback;
  - other processes invisible;
  - writes possible only to the job directory.
- **Limits.** Memory, task and time limits each stopped only the offending job (results
  `oom-kill`, a thread limit, `timeout`), leaving no process or unit behind.
- **Crash behaviour.** If the controlling service dies, the job still ends at its own time limit,
  and a restarted service can stop leftover jobs by exact name.
- **Overhead.** About 0.1 s per job, under 0.5 % of a 30 s compile.

**Permission model.**
- The service does not get general unit control. A fixed, reviewed template unit plus a narrow
  polkit rule let `tbi-build` start and stop only instances of that template.
- Tested with a temporary template and rule:
  - starting an instance: allowed;
  - any other unit, including restarting caddy: denied (caddy was not restarted);
  - any transient unit: denied;
  - a transient unit reusing the template's name: refused.

**Bubblewrap** was not needed. It is not installed here, it depends on AppArmor's
unprivileged-namespace allowance, and it would still need separate cgroup and syscall plumbing.
The template-unit mechanism demonstrated every required property with nothing added to the host.

### B. Identity propagation (D-S8-1)

- **The stable subject is available at the gate.** oauth2-proxy's session carries Google's numeric
  subject next to the email (verified in its own logs, redacted).
- **Header behaviour of oauth2-proxy v7.15.4** (tested on a throwaway local instance with a local
  test user):
  - it overwrites forged `X-Forwarded-User` and drops a forged `X-Forwarded-Email`;
  - it passes custom `X-TBI-*` headers through, so the internal Caddy must strip them (confirmed
    to work).
- **Opaque principal.** The backend derives it with an HMAC over `issuer|subject`. It was stable
  per subject and different between subjects.
- **Unix sockets.** oauth2-proxy → Caddy → backend over unix sockets works end to end, and other
  local users cannot connect when the sockets sit in a private directory. This Caddy version does
  not support a socket-mode suffix, so permissions come from the parent directory.

### C. Ownership state on `node:sqlite` (D-S8-10)

The built-in SQLite (3.53.4, Node v24.21.0, no experimental warning) passed:
- grants separate from blobs, with an identical image stored once for two users;
- cross-user lookup and lease denied with the same answer as "unknown";
- shared system records visible to all;
- an atomic quota check with no partial rows;
- retention applied from a policy value over stored timestamps (global grants kept);
- 4 concurrent writer processes (1,000 transactions, no errors);
- lookups at about 34 µs;
- persistence across reopen;
- a writer killed mid-transaction left no partial state.

No new dependency is needed.

### D. Test hygiene (D-S8-13) — commit `2b8d3af`

- **Fixture cleanup.** The e2e fake build service keeps all its temporary data under one parent
  per process. That parent is removed on reset, on exit and on SIGTERM, and a start sweeps parents
  left by killed processes.
- **Shutdown.** Playwright now stops the fixture with SIGTERM.
- **Heavy test store.** The heavy S7 test store moved to disk (`/var/tmp`).
- **New tests** in `app/tests/fake-build-service.test.ts` (3).
- **Results.** Unit 537 passed. A full e2e run (113 passed) left no directory and no fixture
  process.
- **Also found, then fixed at the PM's decision (Phase 0 close-out):**
  - the R1 heavy test `failures.runtime.test.ts` left a 4 MiB image in `/tmp` on every run
    (11 had accumulated);
  - two browser specs (`commit-race`, `sim-restart`) left browser-profile directories when
    interrupted.
- **Close-out mechanism.** A shared helper, `app/e2e/fixtures/temp-dirs.ts`, creates owned
  directories named `<prefix><pid>-*`. They are removed by the caller, at exit and on
  SIGINT/SIGTERM, and swept by the next run when their owner died. The fixture and both specs use
  it. The R1 test writes its image to disk (`/var/tmp`), removes it in `finally` and at exit, and
  sweeps images left by dead runs.
- **Coverage.** 4 hygiene tests. The R1 invalid-firmware test, `commit-race`, `sim-restart` and
  `s7` pass and leave nothing behind. Unit suite: 538 passed.

### E. Clean capacity and swap baseline (1 vCPU preview host)

**Cleaned.** About 0.9 GB of stale test, harness and cache data in the RAM-backed `/tmp`:
- the Sprint 7 fake stores;
- the old R1 firmware staging tree;
- leaked invalid-firmware images;
- Node and Playwright caches;
- large files in this session's scratch area.

Swap fell from **1,435 MB to 603 MB** as a direct result. The development tools and another
session's scratch data (about 176 MB) were left in place and are accounted to `user.slice`.

**Measured** (per-service cgroups, 1 s samples, 338 samples):

| Phase | Session Host (incl. QEMU) | Build service | Product swap | Host available | Simulation speed | Build |
|---|---|---|---|---|---|---|
| Idle | 72 MB | 31 MB | ≤ 5 MB | 2.26 GB | — | — |
| One live session | 241 MB | 31 MB | ≤ 5 MB | 2.09 GB | median 3.5× real time | — |
| One fresh build | 86 MB | 302 MB (peak 555) | ≤ 5 MB | 1.82 GB | — | 32.1 s |
| Build while a session runs | 250 MB | 303 MB (peak 529) | ≤ 5 MB | 1.70 GB | median 1.6× (about half) | 60.6 s |

Other results:
- **Session storage.** Each session adds about 4 MB to the RAM-backed `/tmp` and releases it at
  Stop.
- **Responsiveness.** Service health answers took 2–5 ms median and 22 ms max. Memory pressure
  stayed near zero (≤ 1.1 % over 10 s); CPU pressure reached saturation when a build and a session
  overlapped.

**Conclusions.**
- **Swap.** The earlier 1.37–2.1 GB swap observation was development and test pressure: stale
  tmpfs data plus interactive tools. The product services held almost no swap in any phase, and
  there is no evidence of a product leak.
- **Capacity.** On one vCPU, CPU is the binding resource. A build and a session halve each other
  (the build doubles to about 61 s, and the session runs at about half speed). Memory is not the
  limit for one session plus one build.

### F. Findings that affect later phases

1. **The QEMU bridge uses TCP loopback** (`tbi-bridge syncport=<ipv4>:<port>`, R1 patch 0004).
   A QEMU sandbox with no network (mandatory outcome 2) would cut it. Options:
   - **(a)** extend patch 0004 so the bridge can use a unix socket or an inherited descriptor. This
     means a new runtimeId, and the R1/R2 heavy suites and determinism hashes are the gate.
   - **(b)** allow QEMU loopback TCP only. This is weaker than "network denied".

   **PM decision: (a).** The bridge moves to a unix socket or an inherited descriptor, whichever
   is simpler and safer. There is no TCP exception without owner approval.
2. **Build/publish split.** A dynamic-uid job cannot write a service-owned directory. Job
   directories must be created for, or by, the job unit, and outputs handed back to the service
   for publishing (Phase 3 design detail).
3. **Build and session contention.** Priority and admission must keep builds from halving live
   sessions (D-S8-9); measured, not assumed.

## Phase 1 — Identity foundation (commit `7e45c0b`)

**Principal.** The trusted gate asserts one subject header. Each backend derives an opaque
principal from it (`runtime/identity/principal.ts`):
- `p_` + HMAC-SHA256(key, `issuer|subject`), 26 base64url characters;
- stable per account, distinct between accounts and between issuer labels;
- it contains no email or provider identifier;
- the key reaches the services as a systemd credential.

**The gate.**
- oauth2-proxy sets `X-Forwarded-User` to the provider's stable subject (for Google, the numeric
  `sub`), always overwriting what a client sends.
- The internal Caddy strips every `X-Tbi-*` header.
- The backends listen on unix sockets (mode 0660, group `tbi-gate`) reachable only by the proxy.
- The internal origin itself becomes a unix socket that only oauth2-proxy can reach (group
  `tbi-gate`).

**Backends.** Every route except health answers 401 without a valid identity. Development and
tests keep TCP; a test gate (`runtime/identity/test-gate.ts`) and the Vite preview proxy
(`TBI_TEST_GATE=1`, subject from a test cookie) play the gate.

**Tests.**
- Routine (`runtime/identity/tests`): derivation, header handling (missing, repeated, malformed,
  forged), 401 on both backends, unix-socket listening.
- Heavy `s8-gate.runtime.test.ts`: the real oauth2-proxy and Caddy binaries over unix sockets.
  Forged headers are replaced or stripped, requests without a login get 403, the same login gives
  the same principal, and other local users are refused by the sockets.

## Phase 2 — Ownership and authorization (commit `d6888ef`)

The five concepts are kept apart:

| Concept | Implementation |
|---|---|
| Identity | sha256 of the bytes, computed by the store |
| Blob storage | `store.ts`, now the blob layer only, shared and deduplicated |
| Grants | `grants.ts` on `node:sqlite`: per principal or `global`, holding the private build record |
| Cache visibility | own grants, plus shared records for the curated system sources (the example programs and the starter program) |
| Retention | timestamps only; the policy period lands in Phase 4 |

**Build service.**
- Lookup, cache hit, build status and lease are scoped to the caller.
- Another user's identical private source is compiled again. The blob is stored once, but no
  cache hit is visible across users.
- A pending build is shared only with its own owner.
- "Not yours" gives exactly the same 404 as "not present".
- R1 reference images and curated builds are global.

**Advanced `.bin`.**
- Gated by the `allowPrebuiltBinary` capability (403 `capability_disabled` when off).
- Granted to the uploader only, and run through the same lease and ticket path as built firmware.

**Run tickets** (`runtime/identity/ticket.ts`). A lease issues an HMAC over:
- the principal;
- the sha256;
- the server-side feature record;
- the expiry.

**Session Host, protocol `tbi-lab.session/2`.**
- Creating a session needs a valid ticket for this principal and exactly this artifact.
- Features come from the ticket; the client-sent list is gone. A ticket that declares a restart or
  an unmodelled facility is refused too.
- A session belongs to its creator, and every route needs owner plus token.
- lookup → re-hash → private copy → QEMU is unchanged.

**Deviation (D-S8-5).** No separate stream ticket was added.
- The app already reads the event stream with `fetch` and an `Authorization` header.
- The host simply stopped accepting `?token=` in URLs.
- That gives the same outcome (no secret in URLs or logs) with less machinery.

**Migration.**
- Sprint 7 manifests load as blobs, and their build records grant nobody anything, so users build
  again: "Build required" is the existing UX, and the source is never lost.
- R1 reference images stay global.
- Blobs are removed by LRU as before.

**Tests.**
- `runtime/builder/tests/ownership.test.ts` (10) and `runtime/host/tests/ownership.test.ts` (3):
  - cross-user lease, lookup, status and session denial;
  - a sha alone is not enough;
  - prebuilt ownership and the capability;
  - global system artifacts;
  - no cross-user cache hit;
  - ticket tampering, wrong key, expiry, other principal and other artifact.
- `app/e2e/s8.spec.ts`: two users in the browser.
- All existing suites adapted.

## Phase 3 — Containment (commit `00cbaf4`)

### QEMU bridge (owner decision 1: option a)

- **Transport.** Patch 0004's `tbi-bridge` connects to the host over a unix-domain socket
  (`syncpath=`); the TCP `syncport` is removed.
- **Why a socket, not an inherited descriptor.** A socket path also works when systemd, not the
  host, starts QEMU, which the sandbox requires.
- **Patch 0005.** Re-anchored, with unchanged content.
- **New runtimeId `33e35e4ac5e798d7`** (was `979f09d739382157`).
- **Determinism.** The R1 gate's 16 timeline and serial hashes are identical to the previous
  runtime; only the runtimeId and the two changed patch hashes differ.
- **Provisioning.** The runtime was provisioned into a separate home (`~/tbi-s8-rt`), so the
  dev-lab Session Host keeps its runtime.

### Build sandbox (mandatory outcome 1)

**How a step runs.**
- Each tool step (compile, merge, symbol listing) is one instance of the fixed template
  `tbi-build-job@<job>.service`.
- The build service may only start, stop, kill or clear instances of it (polkit); it never
  defines a unit.
- The driver runs exactly one allow-listed pinned tool.

**What the job sees.** An empty root with:
- read-only `/usr`;
- the toolchain at `/opt/tbi-arduino`;
- Node and the driver, read-only;
- its own `/job`.

It does not see the store, home directories, credentials, another job, or the network.

**Limits and hardening.**
- Its own user `tbi-buildjob`, private network, PID and IPC namespaces, and a syscall filter.
- Memory 1 GiB with no swap, CPU 80 % at low weight (20), 64 tasks, 512 MiB per file, 260 s.
- Control-group kill.

**Output handling.**
- Output is untrusted: only a well-formed merged image is published, and the store hashes it.
- `ExecStopPost` makes the job group-writable after every step, so the service can always remove
  it.

**Evidence.**
- The staging build is bit-identical to Sprint 7 (`7e877f84…`).
- Sketches referring to the store, a home file, the service keys or `/etc` fail to compile ("No
  such file").

### Runtime containment (mandatory outcome 2)

**How a session runs.** Each session's QEMU is `tbi-qemu@<session>.service`, started by the
Session Host (`tbi-runtime`), which may only manage that template's instances.

**Sandbox.**
- User `tbi-qemu` (no login, no home).
- An empty root with read-only `/usr` and runtime, and ONLY its session directory at `/session`.
- Private network (loopback only), PID and IPC namespaces.
- Memory 384 MiB with no swap, CPU 100 % at high weight (200), 32 tasks, 16 MiB per file, lifetime
  limit.
- Its exit is recorded by `ExecStopPost`.

**Storage.** Session directories are on disk (`/var/lib/tbi-runtime/sessions`), not the
RAM-backed `/tmp`.

**Cleanup.** A restarted host or build service first stops its predecessor's sandbox instances.

**Evidence (staging).**
- QEMU runs as `tbi-qemu`, as PID 1 of its own PID namespace.
- Its network namespace has only `lo`.
- Its view contains `/session/flash.bin` and none of `/home`, the store, the keys, the session
  root or `/etc/passwd`; `/root` is systemd's empty root-only directory.
- `/tmp` does not grow by the 4 MiB flash copy.
- Stop, an external SIGKILL and a host restart each leave no unit, process or session directory
  behind.

### Priority groundwork for Phases 4–5

- Live sessions and builds already have separate control groups with CPU weights 200 and 20: a
  build yields to a running session.
- Admission (refusing or delaying builds before a session degrades) needs only policy on top of
  these units.

### Deployment (not applied to dev-lab)

`deploy/dev-lab/s8/` holds:
- the two service units and the two sandbox templates;
- the polkit rule;
- the gate's tmpfiles entry;
- `install.sh` (`staging` | `dev-lab`).

Also updated: `deploy/dev-lab/Caddyfile` and `oauth2-proxy.cfg` (unix sockets, `X-Tbi-*`
stripped), and `publish.sh` (bundles in `/srv/tbi-lab/services/<sha>`).

For validation, a **staging instance** (`tbi-s8-*` units, own store and keys, not routed by
Caddy) ran beside dev-lab, which kept serving `a2ad7c6` unchanged.

### Validation fixes (found by the Phase 3 runs, fixed before the checkpoint)

| Found | Cause | Fix |
|---|---|---|
| Deeply nested test session directories: QEMU never started | a unix socket path must fit in 108 bytes | the harness puts the bridge socket in a short private directory (named after the owning process, swept like a host root) when the session directory is too deep; the sandbox layout (81 bytes) is unaffected |
| A host signalled right after it reported "listening" skipped its cleanup | the Phase 1 entrypoint registered SIGTERM/SIGINT after listening | both entrypoints register their signal handlers first; 5/5 repeated checks clean |
| A build step's cleanup hook failed (result `exit-code`) | `chmod -R` also touched the service's own files; a user name cannot be resolved in an empty `/etc` | the hook changes only what the job created (`find /job -uid <job uid>`); the build succeeded before, the unit now also ends cleanly |
| A runtime unit's exit hook could not start (result `resources`) when its host was restarted | the host's unit sent SIGTERM to the `systemctl start --wait` waiters too, so a session directory was removed while its unit was still stopping | `KillMode=mixed` (SIGTERM to the host only); the launcher reports the end only once the unit is inactive; a service start also clears its template's stale failed-unit records |
| Reproducibility in the S8 runtime home gave other shas | that test home links `arduino/` through a symlink, and paths resolved through it are not covered by the prefix maps | test-environment artefact only; with the real toolchain path the gate is bit-identical to Sprint 7 (below); the sandbox binds the real path at `/opt/tbi-arduino` |

### Validation (all from `sprint-8`, before the checkpoint commit)

| Suite | Result |
|---|---|
| Typecheck, lint, architecture boundaries | PASS |
| Unit (`npm test`) | 560 passed |
| Browser/e2e (`test:e2e`) | 114 passed, 3 heavy skipped (below) |
| Legacy browser (`test:browser`) | 4 passed |
| Production build | PASS |
| Heavy runtime suite, runtime `33e35e4ac5e798d7` (R1, R2, S7, S8) | **95 passed** (15 files) |
| S8 containment against staging (`s8-containment.runtime.test.ts`) | 9 passed (rerun after the last fixes) |
| S8 real gate (`s8-gate.runtime.test.ts`) | 5 passed |
| S7 reproducibility gate, real toolchain path | bit-identical: TbiGpioProof `7e877f84…`, TbiBanks `4a81f348…` (same as Sprint 7 §8); rebuild after eviction bit-identical |
| Real-QEMU browser acceptance (`s6-real.spec.ts`) on the S8 staging stack (sandboxed build service and runtime) | **3 passed** (blink, input echo, determinism); no QEMU process, sandbox unit, session file or warning left |

**Runtime identity and determinism.**
- Before: `979f09d739382157`; after: `33e35e4ac5e798d7`.
- Cause: patch 0004 (the bridge: unix socket instead of TCP) and patch 0005 re-anchored to it.
- R1 gate trace hashes (timeline and serial, 1 ms and 10 ms ticks, stress, early boot) are
  unchanged.
- R1/R2 acceptance expectations are met.
- Sprint 7 evidence is not invalidated: the product behaviour tested there (build results, the run
  path, determinism) is unchanged. What changed is who may do what, and where it runs.

### What is running on the host now

- **dev-lab:** unchanged. Its services, runtime `979f09d739382157` and Caddy/oauth2-proxy still
  serve `a2ad7c6`.
- **Staging instance** (validation only, not routed by Caddy):
  - units `tbi-s8-build`, `tbi-s8-session-host` and the `tbi-s8-build-job@`/`tbi-s8-qemu@`
    templates;
  - the polkit rule `50-tbi-s8.rules`;
  - keys `/etc/tbi-s8`, store `/var/lib/tbi-s8-artifacts`, state `/var/lib/tbi-s8-{build,runtime}`,
    bundles `/srv/tbi-lab/s8-staging`;
  - runtime `~/tbi-s8-rt/qemu-33e35e4ac5e798d7`.
- **New system accounts** (shared, no login): users `tbi-buildjob`, `tbi-runtime`, `tbi-qemu`;
  groups `tbi-buildio`, `tbi-runtimeio`, `tbi-gate`.
- **Removal:** `deploy/dev-lab/s8/install.sh staging --uninstall` removes everything except the
  accounts.
