# Sprint 8 — Public Hardening & Capacity

**Status:** **CLOSED** (2026-10-05) for Phases 0–4 (identity, ownership, containment,
policy/admission) plus the QEMU `TasksMax` closure fix. Owner smoke PASS (Run/Stop repeated
after the fix). Merged to `main` through PR #2 (CI run 37295624782 green on `4a4a6d9`); this
docs-only commit is the closure commit, tagged `sprint-8-complete`. **Phases 5–6 are not done
and are carried forward** (see "Closure" at the end). **Production deployment is deferred.**
dev-lab runs this code (`c31d62e` release, QEMU unit at `TasksMax=80`).

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
- Memory 384 MiB with no swap, CPU 100 % at high weight (200), 32 tasks (80 since 2026-10-05, see the closure blocker below), 16 MiB per file, lifetime
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

## Phase 4 — Policy, quotas, rate limits and admission

### Policy model

- One JSON policy (`runtime/policy/policy.ts`; deployed as `deploy/dev-lab/s8/policy.json`):
  - read by both services from `TBI_POLICY_FILE` (a systemd `LoadCredential`, root 0400);
  - validated at load, so a bad policy stops the service from starting.
- Two plans only: `preview` (every user by default) and `system` (explicit principal assignments).
  There is no Free/Basic/Pro.
- A plan holds:
  - `requests`;
  - `build` {maxActive, maxQueued, submissions, failures, cooldownMs};
  - `runtime` {maxSessions, creations, maxLifetimeMs};
  - `storage` {maxArtifacts, maxBytes, retentionDays, prebuiltUploads};
  - `capabilities.allowPrebuiltBinary`.
- `global` holds the build queue, live-session capacity, resource floors and the retention sweep
  interval.
- `'cpus'` resolves to `availableParallelism()` on the host.

| Plan value | preview | system |
|---|---|---|
| HTTP requests | 600 / min | 6000 / min |
| Builds in flight (active + queued) | 1 + 1 | 1 + 3 |
| Build submissions (compiles only) | 20 / 10 min | 200 / 10 min |
| Compile failures before cool-down | 10 / 10 min | 100 / 10 min |
| Cool-down | 5 min | 1 min |
| Live sessions | 1 | 4 |
| Session creations | 20 / 10 min | 200 / 10 min |
| Session lifetime cap | 30 min | 30 min |
| Stored artifacts / bytes | 32 / 128 MiB | 256 / 1 GiB |
| Retention after last use | 30 days | 365 days |
| `.bin` uploads | 10 / h | 100 / h |
| `allowPrebuiltBinary` | true | true |

**Global values:**
- build queue 3, maximum queue wait 10 min;
- defer builds while live sessions ≥ `'cpus'`;
- live sessions ≤ `'cpus'`;
- minimum free disk 1024 MB, minimum available memory 256 MB;
- retention sweep every hour.

### Quotas

- **In flight.** Per-principal in-flight builds are counted from the service's own queue/active
  records (by submitter). Admission is checked and recorded synchronously in one tick, so
  simultaneous submissions cannot race past it (tested over HTTP).
- **Storage.**
  - A grant now stores its artifact's `bytes`. The schema upgrades in place, versioned by
    `PRAGMA user_version` 1 → 2, and bytes are backfilled from the store.
  - Usage = the principal's own grants only. System/reference records are never counted.
  - When over quota after a build or upload, the user's own least-recently-used **unleased**
    grants are dropped. A blob is deleted only when no grant holds it and it has no lease.
  - If nothing can be freed, the request is refused (`storage_quota`) before work.
- **Failures.** Compile failures are recorded in a window. Past the limit, that user alone gets
  `build_cooldown`; nothing is consumed permanently.
- **No compile slot.** Cache hits and lookups never take a compile slot or a submission.

### Rate limits

- `RateLimiter` keeps persistent sliding windows in SQLite:
  - table `rate_event` (key = rule:principal);
  - `BEGIN IMMEDIATE` for the check-and-record.
- It lives in `stateDir/rates.db` (build) and `TBI_HOST_STATE/rates.db` (Session Host).
  Windows survive restarts and are exact across connections (tested with two connections).
- Refusals return `429 rate_limited` with `Retry-After` = time until the oldest event leaves the
  window. A refused attempt consumes nothing.
- The per-request rate is an in-memory backstop per principal (`MemoryRate`), deliberately not
  persisted.

### Admission algorithm

**Build** (in order; the first refusal wins, and the rate is taken last so refusals are free):
1. per-user in flight → `build_quota`
2. failure cool-down → `build_cooldown`
3. storage quota → `storage_quota`
4. disk/memory floors → `storage_pressure` / `memory_pressure`
5. global queue full → `builder_busy`
6. submission rate → `rate_limited`

**Build deferral (CPU is binding):**
- The build service polls the Session Host `/health` every second (`TBI_RUNTIME_HEALTH`).
- While live sessions ≥ the defer threshold, the queue pump starts no new compile. Running
  compiles and sessions are never stopped.
- A queued build that cannot start within `maxQueueWaitMs` ends as `capacity_timeout` (not run
  late).
- **Unknown capacity fails closed** (correction after the Phase 4 review): if the health
  reading is stale (older than 5 s) or the Session Host is unreachable, no new compile starts.
  Queued builds keep waiting, running builds are untouched, and a wait past `maxQueueWaitMs`
  ends as `capacity_timeout`. A fresh reading with free CPUs lets the queue go on. Reason: on
  the 1-vCPU host a compile must never start on top of a live QEMU session nobody can see.
  (Without `TBI_RUNTIME_HEALTH` configured — no runtime on that host, development only —
  builds are not deferred.)

**Session** (Session Host `create`, in order):
1. ticket
2. per-user live sessions → `session_quota`
3. global `min(maxLiveSessions, host maxSessions)` → `runtime_capacity` (503, Retry-After 15)
4. disk/memory floors
5. creation rate → `rate_limited`

The plan's lifetime caps each session.

**Advanced `.bin`:**
- The capability is checked from policy **before the body is read** → `403 capability_disabled`.
- When enabled, the upload rate and storage quota apply exactly as for compiled firmware.
- `TBI_ALLOW_PREBUILT` is removed.

**Retention:**
- The hourly sweep drops private grants whose last use is older than the owner's plan period.
- Leased artifacts and system/reference records are exempt.
- Timestamps are stored; no expiry date is stored.
- No cleanup was run against dev-lab data.

### Failure codes (stable)

| Code | HTTP | Meaning |
|---|---|---|
| `build_quota` | 429 | user's builds in flight at limit |
| `build_cooldown` | 429 | too many recent compile failures |
| `rate_limited` | 429 | a rate window is full (Retry-After set) |
| `builder_busy` | 503 | global build queue full |
| `session_quota` | 429 | user's live sessions at limit |
| `runtime_capacity` | 503 | host live-session capacity reached |
| `capability_disabled` | 403 | `.bin` not allowed for this plan |
| `storage_quota` | 403 | storage quota full and nothing evictable |
| `storage_pressure` / `memory_pressure` | 503 | host below resource floor |
| build failure `capacity_timeout` | — | queued build could not start in time |

The app maps each code to its own error and localized message (en/he). Host-capacity refusals
are shown as "busy".

**Admission events.**
- One JSON line per decision on stderr (journal): `{event, service, action, outcome, who}`.
- `who` is the first 10 characters of the opaque principal.
- No emails, source, binaries, headers or secrets are logged.

### Validation

| Suite | Result |
|---|---|
| Typecheck, lint, boundaries, production build | PASS |
| Unit (`npm test`) | **587 passed** (57 files), including 23 new policy tests, 3 app refusal tests and the grants schema upgrade |
| Browser/e2e | 114 passed; legacy browser 4 passed |
| S8 containment + real gate on staging (Phase 4 bundles) | 14/14 |
| **S8 policy staging validation** (`s8-policy.runtime.test.ts`) | **6/6** |
| R2 failures (bundle host given the open test policy) | 11/11 |
| S7 reproducibility, real toolchain | 6/6, bit-identical `7e877f84…` / `4a81f348…` |
| Real-QEMU acceptance (`s6-real.spec.ts`) on staging under the **real** policy | 3/3; 6 admission events, all `admitted` |

**What the staging policy run covers:**
- two principals with a validation policy;
- the build quota (A refused while B admitted);
- the submission rate with a wait;
- a restart keeping windows;
- `.bin` allowed and then denied before the body is read;
- the session quota and global capacity;
- a live session deferring a build that then completes;
- the creation rate surviving a host restart;
- bounded admission events.

Afterwards:
- the real policy was restored (`cmp` identical);
- no QEMU, unit, session or job was left.

The identity, ownership and containment suites are unchanged and pass.

**Policy unit tests also cover:**
- concurrency, both via HTTP and via two DB connections;
- restart persistence;
- one user cannot fill the queue;
- bounded progress;
- cache hits are free;
- failure cool-down per user;
- `capacity_timeout`;
- resource floors;
- LRU eviction respecting leases;
- system storage not counted;
- retention exemptions.

### Capacity findings

- This host has 1 vCPU, so `'cpus'` = 1:
  - **one live session at a time, globally**;
  - new builds wait while it runs (up to 10 min, then `capacity_timeout`).
- That is the intended "CPU is binding" behaviour. On a larger host the same policy scales with
  the CPU count, with no change to the policy file.

### Deviations and risks

- **Request rate in memory.** The per-request rate is in memory only (resets on restart). Build,
  session, failure and upload windows are persistent.
- **Schema upgrade.** The grants schema change (`bytes`) is an in-place upgrade. Found because
  staging still held the Phase 2 schema; covered by a test.
- **`TBI_ALLOW_PREBUILT` replaced** by policy. Its unit-file entry is removed.
- **R2 test policy.** R2's bundle host now runs with an explicit open test policy, because its
  scenario holds several sessions at once.
- **Staleness.** Deferral relies on the Session Host health poll. Originally a stale reading did
  not defer builds; corrected to fail closed (see below). Consequence: if the Session Host is
  down for longer than `maxQueueWaitMs` (10 min), queued builds end as `capacity_timeout`.
- **Not deployed.** dev-lab still serves `a2ad7c6` on runtime `979f09d739382157`; Phase 4 has
  been deployed to staging only.

### Correction: stale runtime health fails closed (after the Phase 4 review)

- `BuildService.pump`: a configured live-session watch returning `null` (stale/unreachable)
  now holds the queue exactly like "CPUs occupied". No separate recovery path: the existing
  1-second retry and `capacity_timeout` apply.
- Regression tests (`policy.test.ts`, "runtime health freshness"):
  1. fresh health, no session → the build starts;
  2. fresh health, CPU occupied → it waits;
  3. stale health → it does not start;
  4. health fresh and free again before the timeout → the waiting build starts;
  5. health stays stale → `capacity_timeout`, never compiled;
  6. a running build is not stopped when health goes stale; the next one waits until health is
     fresh.
- Staging (`s8-policy.runtime.test.ts`, new case): with `tbi-s8-session-host` stopped a submitted
  build stays `queued`; after the host starts again it compiles. 7/7 on staging; the real
  policy was restored (`cmp` identical).
- Validation after the fix: typecheck, lint, boundaries, production build PASS; unit **593
  passed** (57 files; policy suite 29/29, three consecutive runs); staging containment + gate
  14/14; staging policy 7/7.

## First dev-lab deployment (after the Phase 4 approval)

**Deployed commit:** `c31d62e`. App, build service, build-job driver and Session Host all come
from it via `publish.sh c31d62e`. The service bundles and app are byte-identical to `57b91a2`
(the corrected Phase 4 code); `c31d62e` adds only deployment fixes and tests.

**Procedure:**
1. Backup to `/var/backups/tbi-lab/pre-s8-20261004/` (root 0700):
   - the Sprint 7 unit files, `Caddyfile`, `oauth2-proxy.cfg` and `oauth2-proxy.service`;
   - a tarball of `/var/lib/tbi-lab` and `/var/lib/tbi-build` (139 store entries);
   - the release symlinks (all `a2ad7c6`).
2. `publish.sh` (app plus `/srv/tbi-lab/services/<sha>`).
3. `TBI_S8_RUNTIME=~/tbi-s8-rt/qemu-33e35e4ac5e798d7 install.sh dev-lab`.
4. The Sprint 8 `Caddyfile` and `oauth2-proxy.cfg`; caddy and oauth2-proxy restarted.

**Deployment fixes found on the real host** (both in `c31d62e`):
- **Internal-origin socket.**
  - Caddy 2.6.2 creates its unix listener with its umask (0755 `caddy:caddy`), and connecting
    needs write permission. So oauth2-proxy could not reach the origin: about one minute of
    errors for signed-in requests, before any owner use.
  - Fix: `/run/tbi-gate` is setgid (`2750 caddy:tbi-gate`), and a caddy drop-in sets
    `UMask=0007` (`s8/caddy-gate.conf`). The socket is now `0770 caddy:tbi-gate`.
  - The Phase 1 gate test ran Caddy and oauth2-proxy as one user, so it could not see this.
    The post-deploy checks now cover it.
- **Gate request log.** oauth2-proxy's default request-log format wrote the account email on
  every request (pre-existing since Sprint 6). `request_logging_format` now omits the user.

**Migration:**
- New `grants.db` at schema v2, plus `rates.db` for the build service and the Session Host.
- Sprint 7 artifacts stay as blobs. Their build records grant nobody, so a user's first build
  is "Build required" or a rebuild (by design, Phase 2). R1 references stay global.
- The store's existing 256 MiB LRU evicted two older managed blobs during validation builds
  (one of them the curated TbiBanks build, rebuilt on demand). Both are in the backup tarball.

**Rollback:**
- `deploy/dev-lab/s8/rollback-dev-lab.sh /var/backups/tbi-lab/pre-s8-20261004` restores the
  Sprint 7 units, gate configuration and app release `a2ad7c6`, and removes the Sprint 8
  templates, polkit rule and caddy drop-in.
- The Sprint 7 bundles are still in `/srv/tbi-lab/{build-service,session-host}/a2ad7c6…`.
- Checked without touching dev-lab: the Sprint 7 build service, run on a copy of the
  post-deploy store, loads it and leases a Sprint 8-written artifact (200).

**Post-deploy validation (dev-lab, real policy, fresh test principals per run):**

| Check | Result |
|---|---|
| Services active; identities | `tbi-build` / `tbi-runtime` / jobs `tbi-buildjob` / QEMU `tbi-qemu`, all nologin without home; nothing as `ubuntu` |
| Unauthenticated `/`, `/build/*`, `/runtime/*`, `/assets/*` (also with forged `X-Forwarded-User`, `X-Tbi-*`, `X-Forwarded-Email`) | 302 to Google |
| TCP 7400/7420/8080 | closed (only 80/443 public, 4180 loopback) |
| Sockets as `ubuntu`, `nobody`, `tbi-buildjob`, `tbi-qemu` | refused (all three sockets) |
| Sockets as `oauth2-proxy` (origin) | 200 for `/`, `/build`, `/runtime` |
| `s8-containment` (`TBI_S8_INSTANCE=tbi`) | **9/9**: sandboxed bit-identical build `7e877f84…`, no compile access to store/home/keys, cross-user lease 404, QEMU sandbox (own user, no network, session dir on disk), crash and restart cleanup |
| `s8-deployed-policy` (new, real policy, twice) | **7/7**, covering the items below |
| Real gate binaries (`s8-gate`) | 5/5 |
| Real-QEMU browser acceptance (`s6-real.spec.ts`) through the dev-lab sockets | **3/3** |
| After all runs | no QEMU, unit, session directory or job directory left |
| Logs (product services since deploy) | no email, no source, no Authorization, ticket or cookie, no binary payloads; admission events are bounded |

`s8-deployed-policy` covers:
- the installed policy is the repository policy;
- build quota 1 + 1 (`build_quota`, another user admitted);
- `.bin` allowed, private (404 for another user even with the sha), upload rate 10/h
  (`rate_limited`, Retry-After);
- `session_quota`;
- `runtime_capacity` 503;
- a session is invisible and un-endable to another user;
- a live session holds a queued build;
- stale health (Session Host stopped) admits no compile until it is back;
- bounded admission events.

**Not verifiable by me:**
- The signed-in Google path, which needs the owner's login. The oauth2-proxy session shows
  `user` = Google's numeric subject, which the gate forwards as `X-Forwarded-User`.
- Capability denial on dev-lab. The real policy allows `.bin`; denial was validated on
  staging.

## Closure blocker: QEMU task limit (2026-10-05)

**Observed.** During the owner's first Run on dev-lab (05:32:39 UTC) the session's QEMU was
killed after 5 s: the kernel logged `cgroup: fork rejected by pids controller` for its unit and
QEMU exited `status=5/TRAP`. A retry 14 s later ran normally. The dev-lab QEMU slice showed
`pids.peak` 32 (= `TasksMax`) and `pids.events max 1`. Not caused by Sprint 9 (frontend only).

**Measured** (real sessions of the owner's example, `esp32-input-echo`, through the session
host, cgroup `pids.current` every 5–20 ms plus the kernel's exact per-unit `pids.peak`):

| | Result |
|---|---|
| Idle / steady state while running | 4 tasks |
| Burst | about 5.4 s into a run (with or without input commands) |
| Peak per session, staging, 37 sessions held past the burst | 6–38 (most 7–9; 18–27 in about a quarter; 38 once) |
| Peak per session, dev-lab after the fix, 10 sessions | 7–20 |
| Shutdown | the unit, its cgroup and every QEMU task gone after every Stop; no growth over any run of cycles |
| Rejected forks after the fix | 0 (staging and dev-lab) |

**Root cause: an undersized limit, not a leak.** The flash is a file-backed `-drive` with QEMU's
default threaded AIO; the block layer's thread pool spawns one worker per concurrent request (at
most **64** by default; idle workers exit after ~10 s). The burst of flash reads ~5 s into a run
spawns workers. QEMU's legitimate ceiling is therefore 4 + 64 + 1 (the unit's `ExecStopPost`)
= **69** tasks; 32 was below it, so an ordinary burst could be refused and QEMU died.
- **Proved** on staging with temporary drop-ins (removed afterwards): capping the pool
  (`-object main-loop,thread-pool-max=2`) fixed the peak at 5 in 8/8 sessions; an uncapped pool
  under `TasksMax=6` reproduced the owner's failure exactly in 3/3 sessions (same kernel
  message, `status=5/TRAP`, session `failed`).
- No leak: counts return to zero after every Stop, no process, unit or cgroup survives, the
  per-session peaks do not grow across cycles; no unexpected child process (all tasks are QEMU
  threads).

**Fix.** `deploy/dev-lab/s8/tbi-qemu@.service.in`: `TasksMax=32` → **`TasksMax=80`** (the
ceiling 69 plus headroom; still a finite bound). A pure resource-limit change: no application,
runtime or QEMU-argument change. Alternative not taken (needs a QEMU command-line change): cap
the pool with `-object main-loop,id=main-loop,thread-pool-max=N` and keep a tighter limit.

**Regression test.** `runtime/tests/s8-qemu-tasks.runtime.test.ts` (staging, or
`TBI_S8_INSTANCE=tbi` for dev-lab; fixture `fixtures/s8-input-echo-session.json`, the request the
app sends for that example):
- the loaded unit's `TasksMax` is finite and at least 69 + 8 headroom (fails at 32: "expected 32
  to be greater than or equal to 77", verified before the fix);
- `TBI_S8_QEMU_CYCLES` (default 5) real sessions held past the burst with input commands: running
  throughout, no rejected fork, peak ≤ 69 and ≤ limit − 8; after Stop the unit, cgroup and QEMU
  process are gone; no accumulation of units.
`s8-containment` now expects `TasksMax=80`.

**Deployment** (2026-10-05 06:08 UTC). The installed `tbi-qemu@.service` (and the staging
`tbi-s8-qemu@.service`) edited to exactly the new template's rendering (backup
`/etc/systemd/system/tbi-qemu@.service.pre-tasksmax.20261005T060803Z`), then `daemon-reload`.
No service restarted: the template applies to each new session; there was no live session. The
build service, Session Host, Caddy and oauth2-proxy keep their start times; dev-lab still serves
`c31d62e`; the Sprint 9 preview is untouched. Rollback: restore the backup and `daemon-reload`.

**Validation after the fix.**
- Staging: `s8-qemu-tasks` 10 sessions (peaks 7–38) and the full `s8-containment` **11/11**.
- dev-lab (`TBI_S8_INSTANCE=tbi`, fresh test principals): `s8-qemu-tasks` 10 sessions (peaks
  7–20) **2/2**; `s8-containment` **7/7** (unit properties, sandboxed bit-identical build, no
  compile access outside the sandbox, cross-user lease, QEMU sandbox, crash cleanup). The two
  tests that restart the instance's build service and Session Host were not rerun on dev-lab:
  unaffected by a QEMU task limit, and they would restart dev-lab's services.
- Unchanged and still valid: identity, ownership, policy/admission, gate and build validation
  (nothing they exercise changed).

**Sprint 8 owner Run/Stop: PASS** (repeated after the fix, 2026-10-05; the owner reports everything works correctly). The `TasksMax=80` fix is accepted for Sprint 8. Only the Run/Stop
path was repeated, as the fix touched nothing else. The dev-lab journal for the owner's identity
agrees: 5 sessions from 06:36 to 06:38 UTC, each running 14.5–40.4 s (well past the ~5.4 s
thread burst), each ending with Stop as `Deactivated successfully`; the second and later Runs
started cleanly after the previous Stop; no `fork rejected` since the fix (the dev-lab QEMU
slice still counts only the one rejection from before it).

**Also cleaned up.** Two root TCP relays left from a Sep 29 staging validation run
(127.0.0.1:7811 → `/run/tbi-s8-build/api.sock`, 127.0.0.1:7812 → `/run/tbi-s8-runtime/api.sock`,
orphaned `sudo` parents) were terminated by PID after verifying they served only staging and
nothing used them; both ports are closed.

## Closure (2026-10-05)

- **PR:** #2 `sprint-8` → `main`; CI run 37295624782 green on `4a4a6d9`.
- **Closure commit:** this docs-only commit on top of `4a4a6d9` (tested code `36b56e4`: final
  checks at `4a4a6d9`, identical code: typecheck, lint, 593 unit tests, QEMU task-limit test on
  dev-lab 2/2). `main` fast-forwards from `a2ad7c6` (Sprint 7) to it; tag `sprint-8-complete`.
- **dev-lab:** not redeployed. Its release (`c31d62e`) differs from the closure commit only in
  documentation, tests and the QEMU unit template, whose installed unit already matches it.

**Carried forward (not done in Sprint 8):**
- **Phase 5, capacity and observability:**
  - the measurements of §H of the architecture (queue wait vs arrival rate, session slowdown vs
    concurrent sessions and builds, stall-timeout margin under load, memory headroom with N
    sessions plus a compile, sandbox start overhead) on the 1-vCPU baseline **and** a temporary
    4-vCPU class host (owner decision Q1); the cross-user compile cost (P5);
  - CPU weighting validated under load (the QEMU unit's `CPUWeight=200` is in place, unmeasured);
  - metrics, events and the operator script;
  - the final `preview` plan values and global admission caps (today's values are provisional);
  - per-cgroup swap/PSI under mixed load.
- **Phase 6, validation:** the adversarial suite and the multi-user endurance run. (Deployment to
  dev-lab, also listed under Phase 6, is done.)

**Production: deferred**, because the Phase 5 capacity work was not performed on the larger
temporary host, the current admission and capacity limits are provisional, and the current
dev-lab host has one vCPU.

**Staging:** the `tbi-s8-*` staging instance remains installed (idle). Removing it
(`deploy/dev-lab/s8/install.sh staging --uninstall`) is a separate cleanup to be proposed first.

