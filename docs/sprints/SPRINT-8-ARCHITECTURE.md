# Sprint 8 — Public Hardening & Capacity: architecture record

**Status:** APPROVED by the PM (2026-09-29), including the owner decisions Q1–Q6 and the two
mandatory security outcomes (§C.0). This is a planning record only, with nothing implemented yet.
Phase 0 (spikes, the test-hygiene fix and the clean baseline) runs first, and the PM checkpoints
it before Phase 1.

**Base:** `sprint-7-complete^{}` = `main` = `a2ad7c6` (dev-lab serves `a2ad7c6`).

## A. Objective

Sprint 8 is complete when the S7 build → artifact → run workflow can safely serve **mutually
untrusted authenticated users on one host**. That means:

- **Stable identity.** Every backend action is attributed to a stable, pseudonymous principal.
- **Private data stays private.** No user can read, run, lease or observe another user's private
  artifacts, sessions or build output.
- **Untrusted code is contained.** Compiled code and uploaded firmware run inside sandboxes that
  expose nothing of the host but what they need.
- **Configurable limits.** Every per-user and global resource is bounded by configurable policy
  that refuses cleanly (never host-wide degradation).
- **Measured capacity.** Capacity is measured and modelled rather than assumed.
- **Observable operation.** Operation is observable without logging source, binaries, secrets or
  unnecessary personal data.
- **Proven by tests.** All of the above is shown by adversarial and multi-user tests plus a
  multi-user endurance run, with R1/R2/S7 behaviour unchanged.

Production launch, public sign-up and commercial plans are **not** part of it.

## B. Threat model

### Assets

| Asset | Why it matters |
|---|---|
| Host integrity (root, admin user `ubuntu`, SSH keys, GitHub credentials, OAuth secrets) | Full compromise |
| Other users' private data: sketch-derived artifacts, build records and diagnostics (which can quote source), sessions, serial output | Confidentiality between users |
| Service availability: CPU, RAM, swap, disk, process slots, build queue, session slots | One user must not starve the rest |
| Determinism and correctness of builds and runs (the "physics must be real" rule) | Product truth |
| Identity mapping and future billing attribution | Accountability |

### Actors

1. **An authenticated, malicious user.** Authentication does **not** imply trust. The user controls:
   - sketch source, meaning arbitrary C++ fed to gcc and to arduino-cli's preprocessing;
   - Advanced `.bin` bytes, meaning arbitrary firmware executed by QEMU;
   - every API field;
   - request timing and volume;
   - many parallel browser sessions.
2. **An accidental abuser.** Infinite loops, huge sources, tight Build/Run loops, many tabs.
3. **An unauthenticated internet client.** Only the OAuth gate is reachable.
4. **A compromised build or QEMU process.** It is treated as hostile after compromise, and
   containment must hold.
5. **Out of scope:** a local shell user or root on the host (a host compromise), Google itself,
   and the physical/cloud provider.

### Trust boundaries (today)

```
internet ─TLS─> Caddy :443 ─> oauth2-proxy :4180 (Google, allowlist) ─> Caddy 127.0.0.1:8080
   ├─ static app
   ├─ /build/*   ─> build service 127.0.0.1:7420 (user tbi-build) ─> arduino-cli/gcc children
   └─ /runtime/* ─> Session Host 127.0.0.1:7400 (user **ubuntu**) ─> QEMU children
shared: /var/lib/tbi-lab/artifacts (tbi-build:tbi-artifacts 2750; host reads via group)
```

### Attack surfaces and current exposure (discovery, verified on the dev host)

| # | Surface | Finding | Severity for public use |
|---|---|---|---|
| T1 | **Compiler file access.** | Verified with the pinned compiler: standard C/C++ and assembler directives can read any file the compiling process can read, and its contents can end up in diagnostics or in the image. The compiler runs as `tbi-build`, which **can read the whole shared store** (every user's images and manifests). A malicious sketch could therefore reach another user's artifacts. | **Critical** |
| T2 | **QEMU runs untrusted firmware as `ubuntu`.** | The Session Host unit has `User=ubuntu`, `ProtectHome=read-only` (so `~/.ssh` and `~/.config/gh` are readable), no `MemoryMax` or CPU quota, `TasksMax` 4107, network allowed, and no `SystemCallFilter`. A QEMU device-model escape by malicious Advanced firmware would give code execution with read access to the admin's credentials. | **Critical** |
| T3 | **Artifact authorization is possession of a sha.** | The Session Host runs any `sha256` present in the store. `POST /v1/artifacts/:sha/lease` needs only the sha. A leaked or observed sha (UI, logs, a screenshot) runs someone else's private image. There are 2^256 shas, so guessing is infeasible; **leakage** is the risk. | High |
| T4 | **Global build cache is a cross-user oracle.** | `lookup`/cache hits are keyed only by the source content key. A user can learn whether *someone* built an exact source (fast answer vs a 30 s compile), and a cache hit returns that build's record, including its warnings. | Medium (privacy) |
| T5 | **Browser-sent run features.** | The host enforces `internalPull`/`gpioInterrupt` from the **client's** `firmwareFeatures`. A client can omit them and run unmodelled behaviour. This is correctness (the physics rule), not host security. | Medium |
| T6 | **Global-only limits.** | Builds: 1 active and 3 queued for everyone. Sessions: `maxSessions` 4 host-wide. There is no per-user fairness, so one user can hold the whole queue or every session slot. There is no rate limiting anywhere. | High (availability) |
| T7 | **Identity never reaches the backends.** | oauth2-proxy authenticates, but neither service knows who is calling. Ownership, quotas and audit are impossible today. | Blocker for T3/T6 fixes |
| T8 | **Session temporary storage in RAM.** | The Session Host's `tmpParent` is `/tmp`, which is `PrivateTmp` on the host's 2 GB **tmpfs**. Each session's 4 MiB flash copy (up to 16 MiB of session storage) consumes RAM or swap. | Medium (capacity) |
| T9 | **Session capability tokens in URLs.** | EventSource uses `?token=` in the query string. It is same-origin behind the gate, and Caddy/oauth2-proxy request logs may record the URL. | Low–medium |
| T10 | **Malformed input.** | Protocol validation is strict already (unknown fields, names, NUL bytes, sizes, 4 MiB image header checks). The fuzz surface stays in scope for tests. | Low (already handled) |

### Explicit assumptions

- One host, as today (aarch64, 1 vCPU, 3.9 GB RAM, 8 GB swap file, 96 GB ext4, Ubuntu 26.04,
  kernel 7.0, cgroup v2, systemd 259, LSMs: landlock, yama, apparmor; unprivileged user namespaces
  restricted by AppArmor).
- Google OIDC via oauth2-proxy remains the identity provider for S8. The allowlist stays: S8 is
  hardening, not opening sign-up.
- A host compromise (root or `ubuntu`) is out of scope; the goal is that user code cannot reach
  it.
- Projects remain local-first in the browser: the server holds **no project data**, only build
  artifacts, their records and ephemeral sessions.

## C.0 Owner decisions and mandatory outcomes (2026-09-29)

**Q1 — Capacity host.**
- Phase 5 measures on the current 1-vCPU preview host (the baseline) **and** on a temporary
  multi-vCPU host. A 4-vCPU class host is the initial comparison point, with enough RAM that swap
  pressure does not dominate.
- This is a measurement environment, not a commitment to a provider or instance size.
- It is provisioned only in Phase 5.

**Q2 — Advanced `.bin`.**
- Availability becomes the policy capability **`allowPrebuiltBinary`**, not a commercial tier.
- The `preview` and `system` policies may enable it.
- Any future public policy defaults to **disabled** until runtime containment and adversarial
  validation have passed.
- When enabled, it uses exactly the same ownership, authorization, quota and containment path as
  built firmware. There is no weaker path.

**Q3 — Cache sharing.**
- Private build-cache hits are per user only; a user's private source never produces a visible
  cache hit for another user.
- Curated/system examples may use explicitly shared cache records.
- Physical blob deduplication is kept, and it stays separate from authorization and from cache
  visibility.

**Q4 — Retention.**
- Retention is policy-configurable.
- The preview default is **30 days of inactivity** for ordinary build records and grants, and
  quota or LRU pressure may evict earlier.
- System/reference artifacts are exempt.
- The data model stores facts (`lastUsedAt`, `createdAt`, origin), never an expiry. The period
  lives only in policy, so changing it needs no migration.

**Q5 — Development and testing off the preview host.**
- The preview host is treated as an increasingly production-like environment, not a workstation.
- Phase 0 fixes the leaked test stores, moves heavy test temporary data off the RAM-backed `/tmp`
  where appropriate, and defines a clean-host measurement procedure.
- Heavy harness and build experiments use a separate environment where practical.

**Q6 — Identity provider.**
- Google via oauth2-proxy remains the identity source for all of Sprint 8, and the allowlist
  stays.
- Ownership uses an opaque principal derived from the provider's stable account identifier, never
  the email.
- The backend contract is provider-neutral: no Google-specific semantics appear in the artifact
  or session model.

**Mandatory outcome 1 — Build sandbox (D-S8-6).** Whatever the mechanism, untrusted build
processes must be **unable to read**:
- the shared artifact store (except explicitly provided inputs and outputs);
- `/home` or any login user's data;
- SSH, GitHub or auth credentials;
- another build's workspace;
- another user's source or artifacts;
- host-sensitive files the pinned toolchain does not need.

They must also have no network, bounded CPU, memory, process and filesystem use, and
deterministic cleanup after success, failure, timeout and crash. The simplest mechanism that can
**demonstrate** these properties is chosen; being already available is not a reason.

**Mandatory outcome 2 — Runtime/QEMU containment (D-S8-7) is a public-exposure blocker (T2).** At
the end of the containment phase:
- QEMU does not run as `ubuntu` or any login or development user;
- firmware has no access to home directories or host credentials;
- there are explicit CPU, memory and process limits;
- network access is denied unless a future modelled feature requires it;
- the session filesystem holds only the minimum files;
- sessions cannot reach each other's files;
- cleanup is deterministic.

No untrusted firmware is exposed publicly before this gate passes.

**Five separate concepts** (never conflated):

| # | Concept | What it is | Where it lives |
|---|---|---|---|
| 1 | **Artifact identity** | SHA-256 of the exact image bytes, computed by the server | the name of the blob |
| 2 | **Physical blob storage / deduplication** | one write-once file per identity, shared internally | `/var/lib/tbi-lab/artifacts/<sha>.bin` |
| 3 | **Grant / authorization** | which principal may use which identity (or `global`), with origin and record | grants table (D-S8-10) |
| 4 | **Build-cache visibility** | which source keys resolve to a build for a principal: their own grants, plus explicitly shared system records | grants table (source key per grant) |
| 5 | **Retention policy** | when an unused grant and blob may be dropped: an inactivity period, quota and LRU, system exemption | policy (D-S8-8); the data holds only timestamps |

## C. Architecture decisions

### D-S8-1 — Backend identity contract: an opaque principal asserted only by the gate

- **Problem.** The backends have no identity (T7). Quotas, ownership, audit and future billing
  need a stable subject.
- **Chosen.**
  - The gate asserts one header, `X-TBI-Principal`, to the backends. Its value is an opaque
    principal id: `p_` + base32(HMAC-SHA256(gateKey, issuer + "|" + subject)), where the subject
    is the OIDC `sub` (stable). The email is never used: it can change, and it is personal data.
  - Caddy's internal origin **strips any client-supplied `X-TBI-*` and `X-Forwarded-User/Email`**
    and sets the principal from oauth2-proxy's verified user header.
  - The backends accept requests only from the gate:
    - they listen on **unix sockets** readable only by the `caddy` group, instead of TCP loopback,
      so other local processes cannot forge the header;
    - the TCP loopback listener is kept only for tests.
  - Principals are **pseudonymous everywhere in the backends**. A separate, access-restricted
    mapping from principal to email is written only for operator support and is not read by any
    service.
  - The principal is provider-neutral: the HMAC input names the issuer, so a later account layer
    can add or replace providers and link several identities to one principal without touching
    ownership data.
  - A future account/payment layer attaches by owning this mapping: *account → principal(s) →
    plan*.
- **Rejected alternatives.**
  - Email as the id: mutable and personal data.
  - Signed JWT per request: more moving parts for a single-host gate.
  - mTLS between the proxies: disproportionate complexity.
  - A per-user id inside the artifact hash: identity must not change content identity (§F).
- **Rationale.** This is the smallest change that gives the backends a trustworthy, stable,
  non-personal subject, with one place to swap the IdP later.
- **Compatibility.** The app changes nothing: identity comes from the gate cookie. Tests inject
  the header through the test gate. Phase 0 verifies which oauth2-proxy header carries `sub` for
  the Google provider (open question P1).

### D-S8-2 — Artifact identity ≠ storage ≠ access

- **Problem.** Possession of a sha is authorization (T3), and the cache is global (T4).
- **Chosen.** Three separate layers:
  1. **Identity.** Unchanged: `sha256` of the exact image bytes, computed by the server.
  2. **Storage.** Unchanged: one content-addressed blob per sha. Deduplication of **bytes**
     stays internal.
  3. **Access.** New: a **grant** table `(principal, sha, origin: build|prebuilt, sourceKey?,
     record, createdAt, lastUsedAt)`.
- **Access rules.**
  - Every read (lookup, cache hit, status, lease, run) requires a grant for the calling principal.
  - A missing grant and a missing blob give the **same 404**, so there is no existence oracle.
  - Build records (diagnostics, warnings, features, sizes) move from the shared manifest into the
    per-principal grant, so one user never receives another's record.
- **Global artifacts.** R1 reference images and curated example builds carry a `global` grant
  that every principal may use.
- **Rejected alternatives.**
  - Hashing a user id into the identity: this destroys reproducibility and deduplication.
  - A separate store per user: duplicates 4 MiB blobs and complicates the LRU.
  - Keeping sha-as-capability with longer secrets: a sha is not a secret, since it is shown and
    shared.
- **Compatibility.**
  - Existing S7 manifests migrate: their records become grants of a synthetic `legacy` principal
    that is not usable by anyone.
  - Users simply rebuild. The project source is never lost, and "Build required" is the existing
    UX for a missing build.
  - The artifact files are untouched.

### D-S8-3 — Cache and deduplication policy across users

- **Problem.** A global cache saves compiles but is a privacy oracle (T4).
- **Chosen.**
  - A cache hit or lookup is answered only from the caller's **own** grants.
  - A different user's identical source is **compiled**. If the resulting bytes are identical, the
    blob is stored once and a new grant is added.
  - **Curated global sources** (starter and example sketches, shipped with the app) are
    prebuilt/global and never compiled per user.
- **Owner decision (Q3).** Approved as written. Shared records exist only for curated/system
  sources, and they are explicitly marked `shared`.
- **Rejected alternatives.**
  - Global hits with an added grant: leaks "someone built this", including timing.
  - Hits on the same bytes with a fresh record: still a timing oracle.
- **Rationale.** Most real duplicates are the curated sketches, which the global set covers;
  private sources are, by nature, rarely identical.
- **Capacity impact.** It is measured in Phase 5. If needed, a PM-approved opt-in "shared source"
  could be added later.

### D-S8-4 — Run tickets: lease authorization bound to principal and sha, verified by the host

- **Problem.**
  - The host must refuse runs of artifacts the caller may not use (T3).
  - Leases must not cross users.
  - Features must come from the server (T5).
- **Chosen.**
  - `POST /v1/artifacts/:sha/lease` requires a grant.
  - It returns a **run ticket**: a MAC'd, short-lived token (HMAC key shared only by the build
    service and the Session Host, file mode 0400) binding:
    - the principal and the sha;
    - the **server-side feature record** (from the build manifest; absent for prebuilt);
    - the expiry (the lease period).
  - `POST /sessions` requires the ticket and the same `X-TBI-Principal`. The host verifies the
    MAC, principal, sha and expiry, then runs the unchanged R2 path:
    **lookup → re-hash → private copy → QEMU**.
  - The host **ignores browser-sent `firmwareFeatures`** and uses the ticket's.
- **Rejected alternatives.**
  - The host querying the build service's grant DB: couples the services and their availability.
  - A shared database: not needed for one host.
  - Keeping client features: violates the physics rule for untrusted clients.
- **Compatibility.** R2 protocol `tbi-lab.session/1` gains one required field on create and becomes
  `tbi-lab.session/2`. The only client is the app, which changes in the same release.

### D-S8-5 — Session ownership

- **Chosen.**
  - Each session records its owner principal.
  - Every session route requires **both** the capability token (kept) **and** a matching
    principal. A mismatch gives the same 404 as an unknown session.
  - Per-principal session limits (§E).
  - SSE moves the token from the query string to a short-lived, single-use **stream ticket**
    obtained by an authenticated POST, so no long-lived secret sits in URLs or logs (T9).
  - Cleanup:
    - the existing lease reaping is unchanged (released about 2 s after the stream closes, 30 s
      without contact);
    - a principal's sessions are also ended when their quota policy is revoked.
  - Logout does not notify the backend (oauth2-proxy), so lease expiry remains the mechanism.
- **Rejected.** Cookie-only auth for sessions: it loses the per-session capability that R2 proved
  and tests.

### D-S8-6 — Per-job build sandbox

- **Problem.** The compiler must see only what a build needs (T1). Today it runs with the
  service's full view, including the shared store.
- **Chosen.**
  - **Split build from publish.** The build service never gives a compile job access to the
    store. The job's output image is published by the service after the job ends.
  - **One sandbox per compile job, with:**
    - its own unprivileged uid;
    - a private mount namespace containing only the read-only toolchain, the job directory and a
      minimal `/dev`;
    - no network;
    - a syscall allow-list (`@system-service`-style);
    - no new privileges;
    - its own cgroup for memory, CPU, tasks and a hard kill.
  - **Preferred mechanism: transient systemd units per job.** A narrowly scoped polkit rule lets
    `tbi-build` start or stop only units named `tbi-job-*`, and each unit uses `DynamicUser`,
    `TemporaryFileSystem=/`, `BindReadOnlyPaths`, `PrivateNetwork`, `SystemCallFilter` and
    `MemoryMax`. It needs no new software (systemd 259 is present), and it gives per-job
    accounting and a clean cgroup kill.
  - **Fallback: bubblewrap** (packaged, with Ubuntu's `bwrap-userns-restrict` AppArmor profile)
    plus the service-level cgroup.
  - A Phase 0 spike chooses between them against measured criteria:
    - isolation verified by tests;
    - start overhead (a few % of a 30 s compile at most);
    - operational simplicity.
- **Rejected alternatives.**
  - Docker/Podman: not installed; a daemon and images to maintain for no isolation gain over
    namespaces plus a uid on this host.
  - gVisor or microVMs (Firecracker): strongest, but no nested virtualisation on this 1-vCPU
    aarch64 VM, and disproportionate operational cost now. Revisit if multi-host.
  - Source filtering of `#include`/`asm`: bypassable. Isolation must come from what the process
    can see, not from parsing C++.
- **Mandatory outcome 1 (§C.0).** The mechanism is chosen by the Phase 0 spike on demonstrated
  isolation, not on availability. If filesystem isolation cannot be *proven* with transient units,
  they are not chosen.
- **Compatibility.**
  - Artifacts must stay **bit-identical**: the reproducibility gate (§8 of S7) is re-run inside
    the sandbox.
  - The toolchain pins are unchanged.
  - Future profiles (MicroPython, other boards) reuse the same job-sandbox interface: the provider
    declares its read-only inputs, and the sandbox is profile-agnostic.

### D-S8-7 — Runtime containment: dedicated user and per-session sandbox for QEMU

- **Problem.** QEMU executes untrusted firmware as the admin user, with no resource limits (T2),
  and session files live in RAM (T8).
- **Chosen.**
  - The Session Host runs as a **dedicated system user `tbi-runtime`** with no access to any home
    directory. The provisioned runtime (QEMU, ROMs) moves to a root-owned read-only location
    (for example `/opt/tbi-runtime/<runtimeId>`).
  - Unit hardening:
    - loopback/unix-socket only, with `IPAddressDeny=any`;
    - `MemoryMax`, `TasksMax` and CPU weight;
    - a `SystemCallFilter`;
    - capabilities dropped.
  - **Each QEMU runs in its own sandbox**, using the same mechanism as D-S8-6: its own uid and
    mount view (the runtime read-only, plus only its private session directory), no network, and
    per-session memory, CPU and task limits.
  - Session directories move from tmpfs to a **disk-backed** state directory, still wiped on
    release.
  - R2's lookup → re-hash → private copy → QEMU flow is unchanged. Only where the copy lives and
    who runs QEMU change.
- **Public-exposure blocker (§C.0, mandatory outcome 2).** No untrusted firmware, built or
  Advanced, is exposed publicly before this passes.
- **Rejected.** Keeping `ubuntu` with more `Protect*` settings: any escape still lands in the
  admin's account.
- **Compatibility.**
  - The R1 runtimeId and QEMU patches are unchanged.
  - The heavy R1/R2 suites must pass unchanged, including determinism hashes.
  - Deployment docs change (setup script, unit files).

### D-S8-8 — Policy engine: named plans, per-principal limits, global admission

- **Problem.** There are no per-user or rate limits (T6). Future tiers must be configurable,
  not hard-coded.
- **Chosen.**
  - One small shared module, `runtime/policy`, is used by both services.
  - A `policy.json` defines **named plans** (S8 ships only `preview` and `system`) with limits per
    principal:
    - concurrent and queued builds;
    - build submissions per window;
    - failed-build budget;
    - artifact bytes and count;
    - prebuilt uploads per window;
    - concurrent sessions;
    - session creations per window.
  - Global limits sit beside the plans: workers, queue depth, sessions, and disk/memory
    watermarks.
  - Principals map to plans. The default is `preview`, and the future account layer owns the
    mapping.
  - **Capabilities.** Plans also carry capabilities such as **`allowPrebuiltBinary`** (Q2). It is
    checked at upload and at lease, and it grants access to the same path as built firmware,
    never a separate one.
  - **Retention (Q4).** Plans carry the retention rules: an inactivity period (preview: 30 days),
    an eviction order under quota or LRU pressure, and the system exemption. A daily sweep
    applies them to the stored timestamps.
  - Mechanisms:
    - concurrency counters;
    - token buckets for rates;
    - stored usage for footprint quotas;
    - a per-principal "cool-down" after repeated failures.
  - State is in-memory for rates and concurrency and persisted for usage (D-S8-10), behind an
    interface a shared store can implement later.
- **Rejected alternatives.**
  - Hard-coded constants: blocks plans.
  - Limits only at Caddy/IP: wrong subject; NAT'd classrooms share IPs.
  - An external rate-limit service: not needed on one host.

### D-S8-9 — Build capacity architecture: queue/worker seam, measure before scaling

- **Problem.**
  - One vCPU. A fresh compile takes about 26.5 CPU-seconds and 30–36 s wall time at an 80 %
    quota, with a cgroup peak of about 0.7–0.83 GB.
  - A running QEMU session uses about 0.8–1 vCPU for real-time speed; two sessions each run at
    about half speed (R2 §14).
- **Chosen.**
  - Keep **one compile worker** on this host.
  - Introduce an explicit **queue → worker** interface: a job spec in, and a result plus an image
    stream out. The worker no longer shares memory with the queue. A remote worker (a second
    host) can then be added later without replacing the service.
  - Compiles run at **lower CPU weight than live sessions**, so builds yield to real-time runs.
  - Global admission caps are derived from measured per-vCPU budgets (Phase 5), not guessed.
- **Rejected.** Raising local compile concurrency on 1 vCPU: it only lengthens every build and
  starves sessions (to be confirmed by measurement, §H). A distributed build farm now: not
  justified by evidence.

### D-S8-10 — Ownership and usage state: embedded SQLite

- **Chosen.**
  - Grants, usage and principal-to-plan assignments are kept in one **`node:sqlite`** database
    owned by the build service. It is built into Node 24 (verified present, v24.21.0), needs no
    new dependency, and gives transactional updates.
  - The Session Host does not read it; it trusts tickets (D-S8-4).
- **Rejected.**
  - JSON files per principal: no atomic multi-row updates.
  - External Postgres/Redis: new services, which the cost discipline rules against.
- **Risk.** The API's stability level in Node 24 is checked in Phase 0. The fallback is
  append-only JSON logs plus an in-memory index.

### D-S8-11 — Observability: bounded metrics and structured events, pseudonymous

- **Chosen.**
  - Each service exposes Prometheus-text counters and gauges on a **local-only** endpoint (not
    routed by Caddy).
  - Structured JSON events go to journald, with only low-cardinality labels.
  - Principals are logged pseudonymously.
  - No source, binaries, tokens, tickets or emails are logged.
  - A tiny operator script summarises both services.
  - No new monitoring service in S8; hosting one is a later product/cost decision.

### D-S8-12 — Failure model: admission control first, then graceful refusal

- **Chosen.** Every expensive action passes admission checks in a fixed order:
  1. principal policy;
  2. global capacity;
  3. resource watermarks (free disk; memory pressure from PSI and available memory).

  Each refusal gives a stable machine code and HTTP status (§K), and the UI shows it in the
  user's language. Running work is never killed to admit new work. Internal failures clean up
  through cgroup kill plus directory removal (already proven in S7/R2) and are counted.

### D-S8-13 — Test-environment hygiene and a clean preview host (discovery finding, Q5)

- **Problem.** The S7 e2e fake build service creates a temporary store per test and never removes
  it: 85 leaked stores (253 MB) on the dev host's tmpfs `/tmp`, contributing to swap (§I).
- **Chosen.**
  - A test-only fix in Phase 0: remove stores on reset and at exit, including after failures and
    interruptions.
  - A check that tests leave no `tbi-fake-*` directories behind.
  - Heavy test temporary data kept off the RAM-backed `/tmp` where appropriate.
  - A documented clean-host measurement procedure.
  - Heavy experiments on a separate environment where practical (Q5).

## D. Identity and ownership propagation

| Step | Carries | Enforced by |
|---|---|---|
| Browser → gate | Google session cookie (`__Host-`, 8 h) | oauth2-proxy, allowlist |
| Gate → Caddy internal → backends | `X-TBI-Principal` (set by the gate, client value stripped); unix socket | Caddy config; socket permissions |
| Build submit | principal → job owner; policy check | build service |
| Artifact | blob by sha (shared); **grant** (principal, sha, record) | build service DB |
| Lookup / cache hit / status | own grants only; unknown = 404 | build service |
| Lease | grant → **run ticket** (principal, sha, features, expiry, MAC) | build service |
| Session create | ticket + same principal → session.owner | Session Host (MAC check, then R2 path) |
| Session routes / SSE | token + owner principal; SSE by single-use stream ticket | Session Host |
| Advanced `.bin` | upload → blob + grant (origin prebuilt), per-principal quota | build service |
| Audit / metrics | pseudonymous principal | both |

## E. Quota and rate-limit model (mechanism only)

The dimensions are listed below. Values are set by named plans in configuration; S8 ships a
`preview` plan with conservative, measured values and **no commercial tiers**.

| Dimension | Mechanism | Refusal |
|---|---|---|
| Concurrent builds per principal | counter | 429 `build_concurrency` + Retry-After |
| Queued builds per principal | counter | 429 `build_queue_quota` |
| Build submissions per window | token bucket | 429 `rate_limited` + Retry-After |
| Failed builds per window (compile errors are normal; infrastructure-type failures and timeouts weigh more) | weighted bucket → cool-down | 429 `cooldown` |
| Stored artifact bytes and count per principal | usage (DB); the principal's own LRU first | 403 `storage_quota` only if eviction of their own artifacts cannot make room |
| Prebuilt uploads per window, and bytes | bucket + usage | 429 / 403 |
| Prebuilt capability (`allowPrebuiltBinary`) | policy capability | 403 `capability_disabled` |
| Active sessions per principal | counter | 429 `session_concurrency` |
| Session creations per window | bucket | 429 `rate_limited` |
| API request rate per principal (all routes) | bucket, generous | 429 |
| Unauthenticated edge | IP-based at the gate only (login flood) | gate |
| Global: workers, queue, sessions, disk, memory | admission | 503 `capacity` / `storage_pressure` / `memory_pressure` + Retry-After |

Layering:
- **Principal-based limits live in the services** (only they know the principal and the cost).
- **IP-based limits are used only before authentication.**
- Global admission sits last.

## F. Artifact authorization model

- **Identity.** sha256 of the bytes, unchanged.
- **Storage.** A shared content-addressed blob, write-once, as in S7.
- **Access.** Grants per principal, plus `global` grants for system artifacts.
- **Eviction.**
  - LRU runs per blob across all grants. A blob is removable only when no active lease or ticket
    references it.
  - A principal's footprint quota counts the blobs they hold grants on. Deduplicated bytes count
    for each holder, so costs cannot be shifted between users.
  - Evicting a blob drops its grants. Users see the existing "Build required" and rebuild,
    exactly as the S7 endurance run proved.
- **Uniform 404.** Every existence query (lookup, lease, status) answers 404 for "not yours" and
  "not present" alike.
- **Advanced `.bin`.** The same model with origin `prebuilt`, available only when the
  principal's policy has `allowPrebuiltBinary` (Q2). It is never analysed (unchanged), and its
  ticket carries no features.
- **Retention.** The grants store `createdAt`/`lastUsedAt`. The policy's inactivity period
  (preview: 30 days) and quota/LRU rules decide removal, and system/global grants are exempt (Q4).

## G. Build sandbox model

Per D-S8-6: a sandbox per job, whose view is the read-only toolchain plus a read-write job
directory. It has no network, a separate uid, a syscall allow-list, per-job cgroup limits (memory,
CPU, tasks, hard timeout), a clean environment, and cleanup by cgroup kill plus directory removal.

The S7 service-level limits remain as an outer bound.

The job never sees:
- the artifact store;
- other jobs;
- `/etc` beyond what the toolchain needs (to be established in Phase 0);
- home directories;
- service code.

## H. Capacity model

Measured on the current host (S7 evidence):

| Quantity | Value |
|---|---|
| Fresh ESP32 compile | 26.5 CPU-s; 30–36 s wall at an 80 % quota; peak 0.7–0.83 GB cgroup |
| Cached build / lookup | about 70 ms / about 300 ms |
| QEMU session | about 77 % CPU median (0.8–1 vCPU for real time), about 64 MB RSS (peak about 150 MB), 4 MiB storage |
| Two sessions on 1 vCPU | each at about half speed (R2 §14) |

Calculated for one worker on 1 vCPU with no sessions: at most about 110–130 fresh compiles per
hour.

Implications:
- **Sessions, not builds, are the binding constraint.** Real-time ESP32 simulation needs about
  one vCPU per concurrent session. This host supports about **1 real-time session**, or 2 at half
  speed. The current `maxSessions` of 4 overcommits the CPU and relies on the host's stall timeout
  as a safety net.
- A compile during a session slows that session; D-S8-9's CPU weighting protects the session.

Measurements needed in Phase 5 before choosing final values:
- queue wait versus arrival rate;
- session slowdown versus concurrent sessions and builds;
- the stall-timeout false-positive threshold under load;
- memory headroom with N sessions plus one compile;
- sandbox start overhead.

When more hosts are needed:
- when the measured p95 queue wait exceeds the provisional target at the expected load; or
- when concurrent-session demand exceeds the vCPUs.

The queue/worker seam (D-S8-9) and ticket-based host authorization (D-S8-4) let build workers and
session hosts be added independently.

## I. Swap and memory investigation (started in discovery)

Evidence on 2026-09-29, on the idle host:

| Item | Value |
|---|---|
| Swap used | 1.37 GB (of 8 GB), swappiness 10 |
| **cgroup swap by service** | `tbi-build` 1 MB, `tbi-session-host` 0 MB, caddy 2 MB, oauth2-proxy 1 MB |
| `user.slice` (interactive development work) | 1.28 GB of swap |
| tmpfs `/tmp` | 1.1 GB used (2 GB tmpfs): 85 leaked test stores (253 MB), an old R1 firmware build tree (249 MB), a compile cache (165 MB), and session scratch |
| Resident `Shmem` | only 9 MB, so the tmpfs content is almost entirely swapped out |
| Process `VmSwap` total | about 0.25 GB |

Interpretation, to be confirmed, not yet a conclusion:
- The swap seen in S7 is dominated by development and test pages (stale tmpfs files, IDE server,
  harness and browser), all charged to the user slice. The **product services hold about 4 MB**.
- The endurance growth matches cold pages pushed out during compile peaks (0.7–0.8 GB) and the
  harness's own growth (256 → 514 MB), then stabilising.
- There is no evidence of a product leak.

Plan (Phase 0 / Phase 5):
1. Record `memory.swap.current` and `memory.current` for each service cgroup, plus PSI, in the
   endurance sampler, with a clean `/tmp` (after D-S8-13).
2. Re-run a shorter mixed load and check that product-cgroup swap stays near zero and that swap
   is reclaimed as expected.
3. Measure responsiveness (PSI `memory some/full`, latency p95) at N sessions plus a compile.
4. Decide on disk-backed session storage (D-S8-7) and on whether the dev/test workload must be
   kept off the preview host.

## J. Observability plan

**Metrics, bounded:**
- builds queued and active;
- build duration histogram;
- outcomes: success, compile_error, timeout, storage_limit, internal, sandbox_failure;
- cache hits versus misses (own grants);
- store bytes and blobs, evictions, lease issued/refused;
- ticket verification failures by reason;
- quota and rate-limit rejects by dimension;
- sessions active, created and failed by reason;
- QEMU cleanup failures;
- stall terminations;
- disk free, memory available, swap, PSI;
- worker health.

**Events:** JSON with a pseudonymous principal, action, outcome, code and duration.

**Never logged:** source, diagnostics text, binaries, tokens, tickets, emails.

**Retention:** journald defaults; metrics are scraped locally.

The operator gets a `tbi-status` summary script. No dashboard service in S8.

## K. Failure and recovery model

| Condition | Behaviour | User-visible |
|---|---|---|
| Build capacity full (global queue) | refuse before queuing | 503 `capacity`, Retry-After; the Build button explains and re-enables |
| Principal over quota or rate | refuse | 429/403 with code; localized message |
| Artifact store at cap | evict the LRU among unleased blobs; if nothing is evictable, refuse the new build | 503 `storage_pressure` |
| Disk below low watermark | refuse builds, uploads and new sessions; running work continues | 503 `storage_pressure` |
| Memory pressure (PSI or available memory below watermark) | refuse new sessions and builds; never kill running ones | 503 `memory_pressure` |
| Worker or sandbox dies mid-build | job `failed(internal)`; cgroup kill; job directory removed; counted | "Build failed (service)" and retry allowed |
| QEMU cannot start | existing R2 `failed(startup)` path; directory removed | existing message |
| Artifact disappears or fails its hash | existing R2 `artifact_missing` / `artifact_hash_mismatch`; the grant is dropped | "Build required" |
| Ticket expired or invalid | 403 `ticket_invalid`; the app re-leases once | transparent, or "Build required" |
| Service restart | sessions end (ephemeral, as today); the queue is lost and clients see a transport error and can re-submit | existing messages |

## L. Test plan

**Routine (CI, no toolchain or QEMU):**
- identity header stripping and forging refused;
- grant rules (own/global/none → 404);
- cross-principal lookup, lease, status and ticket denial;
- ticket MAC, expiry and principal binding;
- server-side features;
- session owner checks (token plus principal) and the SSE stream ticket;
- every quota and rate dimension, including window reset and Retry-After;
- global admission and watermarks (injected);
- policy file validation;
- the legacy S7 manifest migration.

**Browser e2e (fakes):**
- two principals in two contexts: B cannot run A's build, and A's lookup is not visible to B;
- quota refusals are shown and localized (en/he);
- S7 flows unchanged.

**Heavy:**
- **Sandbox boundary tests.** Sketches that try to include or embed files outside the job view
  must fail to compile or produce no host data. Network is unreachable. Memory and task
  exhaustion is contained in the job cgroup.
- The reproducibility gate inside the sandbox (bit-identical to S7 shas).
- Timeout and crash cleanup (no processes, no directories).
- QEMU as `tbi-runtime`: runs the R1 and R2 suites unchanged, with the same determinism hashes.
- Per-session limits enforced.

**Adversarial suite:**
- API fuzzing of both services;
- queue saturation by one principal while another still gets service;
- upload abuse;
- session-creation flooding;
- disk-pressure and memory-pressure injection;
- Advanced `.bin` ownership.

**Multi-user endurance:** the S7 harness extended to N principals, with per-cgroup memory/swap and
PSI sampling. The duration is the PM's.

**Regression:** all R1/R2/S7 routine and heavy suites; the S7 projects and package formats import
and build unchanged.

## M. Gates

**Required safety gates (pass/fail, no numbers to tune):**
- zero cross-principal access in every adversarial test;
- the compile and QEMU sandboxes expose no path outside their allowed view (tested);
- no network from jobs or QEMU;
- per-job and per-session limits kill only the offender;
- no product service runs as a login user;
- no secrets or source in logs (grep audit);
- reproducibility bit-identical;
- R1/R2/S7 suites green.

**Provisional operational targets (validated or revised in Phase 5):**
- the sandbox adds ≤ 10 % to a fresh compile;
- a principal at their limit does not change another principal's cache-hit latency (about 70 ms)
  or session start materially;
- product-cgroup swap stays near zero under the endurance load.

**Measurements that choose final values:** queue-wait curve, session slowdown curve, memory
headroom, and the stall-timeout margin. These set the `preview` plan and the global caps.

## N. Phases

0. **Spikes and hygiene.**
   - Choose the sandbox mechanism (systemd transient units vs bubblewrap) with evidence.
   - Verify oauth2-proxy's subject header.
   - Confirm `node:sqlite` stability.
   - Fix the test tmp leak.
   - Capacity and swap baseline with per-cgroup metrics.

   **Report and PM checkpoint.**
1. **Identity and gate.** Principal contract, header stripping, unix sockets, test gate.
2. **Ownership.** Grants DB, per-principal lookup and cache, run tickets, host verification,
   server-side features, session owner, SSE stream tickets, legacy migration.
3. **Containment.**
   - Per-job build sandbox; build/publish split.
   - The `tbi-runtime` user and per-QEMU sandbox; disk-backed session directories.
   - Re-run reproducibility and R1/R2 heavy suites.
4. **Policy and admission.** Policy engine, quotas, rate limits, watermarks, refusal codes and
   localized UI messages.
5. **Capacity and observability.**
   - Measurements (§H) on the 1-vCPU baseline **and** a temporary 4-vCPU class host (Q1).
   - CPU weighting.
   - Metrics, events and the operator script.
   - The final `preview` plan values.
6. **Validation.**
   - The adversarial suite.
   - The multi-user endurance run.
   - Deployment to dev-lab.
   - Owner smoke.
   - CI and closure.

Containment (3) follows ownership (2) because the store/publish split depends on the grant model.
It is still before quotas because it is the highest-severity risk.

## O. Non-goals

The following are not part of Sprint 8:
- production deployment;
- public sign-up;
- accounts, billing, or Free/Basic/Pro values;
- MicroPython;
- ESP-IDF;
- new boards;
- libraries;
- new peripherals;
- the potentiometer (V1.1, PM-6);
- server-side project storage or sync;
- multi-host deployment;
- a monitoring stack;
- a UI redesign (only refusal messages are added);
- changing the build toolchain or the R1 runtime.

## P. Risks and open questions

| # | Question / risk | Recommendation before coding |
|---|---|---|
| P1 | Which oauth2-proxy header carries Google's stable `sub`, and in what form | Phase 0 spike on dev-lab, with an allowlisted account and a local test gate |
| P2 | Transient units need a polkit rule for `tbi-build`/`tbi-runtime`; Ubuntu 26.04 restricts unprivileged user namespaces (bubblewrap needs its AppArmor profile) | Phase 0 spike implementing both minimally; pick by the isolation tests and overhead |
| P3 | Moving the R1 runtime out of `/home/ubuntu` must not change QEMU behaviour | Re-run the R1/R2 heavy suites and determinism hashes after the move (Phase 3) |
| P4 | Maturity of `node:sqlite` in Node 24 | Phase 0 check; the JSON fallback is designed |
| P5 | Cross-user compile cost (D-S8-3) | Measure in Phase 5; opt-in sharing later if the PM wants |
| P6 | The 1-vCPU host cannot demonstrate multi-user *capacity* beyond about 1 real-time session | **Resolved (Q1):** also measure on a temporary 4-vCPU class host in Phase 5 |
| P7 | The dev/test workload on the preview host distorts memory and swap | **Resolved (Q5):** clean-host procedure in Phase 0; heavy experiments moved off the host where practical |

## Implementation notes (Phases 1–3, recorded at the Phase 3 checkpoint)

Where the implementation made a concrete choice that the approved text left open or described
differently:

- **D-S8-1: where the principal is derived.**
  - oauth2-proxy asserts `X-Forwarded-User`, the provider's stable subject, overwriting any client
    value.
  - Each backend derives the opaque principal itself with the shared HMAC key, instead of Caddy
    computing an `X-TBI-Principal` header (Caddy cannot compute an HMAC).
  - Caddy strips every `X-Tbi-*` header, and all hops are unix sockets.
  - Same guarantees; one fewer component that must hold the key.
- **D-S8-5: no separate stream ticket.** The client already reads the event stream with `fetch` and
  an `Authorization` header, so the host simply stopped accepting `?token=` in URLs. Same outcome:
  no secret in URLs or logs.
- **D-S8-6/7: sandbox users.**
  - Fixed system users `tbi-buildjob` and `tbi-qemu` instead of `DynamicUser`, so the service can
    share exactly one directory with a job through a group.
  - Isolation between concurrent jobs or sessions comes from the per-unit mount view, which binds
    only that job's or session's directory, and from a private PID namespace.
- **D-S8-7: QEMU bridge (owner decision 1).** A unix-domain socket (`syncpath=`), not an inherited
  descriptor, because systemd, not the host, starts the sandboxed QEMU. TCP was removed.
