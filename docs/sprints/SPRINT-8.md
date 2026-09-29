# Sprint 8 — Public Hardening & Capacity

**Status:** PHASE 0 COMPLETE and approved (2026-09-29); Phases 1–3 in progress. No product code has changed and nothing is
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
