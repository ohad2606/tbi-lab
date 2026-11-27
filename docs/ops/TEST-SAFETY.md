# Test safety: tests and scripts that touch a deployed instance

Background: on 2026-11-13 full runs of the runtime suite on DEV restarted the shared staging
instance (tbi-s8) and rewrote its configuration, because the tests that do so enabled themselves
whenever the instance was installed and passwordless sudo worked (incident write-up kept with the
RC evidence, `STAGING-INCIDENTS.md`). This page classifies every such test and script and states
the gate that now stops them by default.

## The gate

`runtime/tests/mutation-gate.ts`: a test that restarts or stops a service, installs configuration
under `/etc/<instance>`, or kills QEMU / session units with systemctl runs only when

1. `TBI_ALLOW_SERVICE_MUTATION` names the instance (`tbi-s8`, `tbi`; comma-separated), and
2. the caller holds the host-wide pipeline lock (`deploy/ops/pipeline-lock.mjs check`).
   `TBI_PIPELINE_LOCK_DIR` must be unset: it moves the lock's files, so with it set (to any value)
   the lock counts as not held.

Otherwise it is skipped and prints the reason. Tests that only create sessions on a deployed
instance need the instance named explicitly (`TBI_S8_INSTANCE`, `TBI_C5_DEPLOYED`,
`TBI_S13_SEC_DEPLOYED`, `TBI_S8_INSTANCE` also for s8-policy and s28-assist); none defaults to a
shared instance. Every deploy script that restarts a service, installs into `/etc` or `/srv` or
re-points a served release refuses (exit 64) unless `TBI_ALLOW_SERVICE_MUTATION` names the
instance it changes (`tbi` = DEV-Lab and this host's routes, `tbi-s8` = staging):
`deploy/ops/require-mutation.sh`, or the inline check in `s8/install.sh` and `switch-runtime.sh`.

`scripts/tests/mutation-gate.test.mjs` (in the default unit suite and CI) fails if any runtime test,
e2e spec or deploy script contains a mutation entry point without its gate, and proves on
deliberately un-gated fixtures that it would.

## Coverage of the guard

| Entry point | Detected in | Gate required |
|---|---|---|
| `sudo systemctl restart/stop/start/kill/reload` | runtime tests, e2e specs | import of `mutation-gate` |
| `sudo install … /etc/…` or `/srv/…` | runtime tests, e2e specs | import of `mutation-gate` |
| writing a file under `/etc` or `/srv` (`writeFileSync`, `tee`) — policy, assist, runtime JSON | runtime tests, e2e specs | import of `mutation-gate` |
| `sudo pkill` / `sudo kill` (service or QEMU processes); own-relay cleanup `pkill -TERM -P <relay>` exempt | runtime tests, e2e specs | import of `mutation-gate` |
| `systemctl restart/stop/start/kill/reload/enable/disable` | deploy and scripts `*.sh` | `TBI_ALLOW_SERVICE_MUTATION` check |
| `sudo install/cp/rm/ln/mv` into `/etc`, `/srv` (also via `$root`, `$page`, `$BUNDLES`) | deploy and scripts `*.sh` | `TBI_ALLOW_SERVICE_MUTATION` check |
| `tee` into `/etc` or `/srv` | deploy and scripts `*.sh` | `TBI_ALLOW_SERVICE_MUTATION` check |

Files currently carrying an entry point (all gated): the seven runtime tests and the e2e spec in
the classification above; deploy/dev-lab/{publish, publish-frontend, publish-runtime,
retire-preview, rollback-runtime, setup-build}.sh, s8/{install, switch-runtime, rollback-dev-lab,
publish-release-artifacts}.sh, s9-preview/{install-route, publish}.sh, s10-preview/{install-route,
publish}.sh.

## Classification

Classes: **read-only** (no deployed instance touched), **session-creating** (own sessions/builds on
a deployed instance, cleaned up by the test; uses the per-user rate), **session-terminating**
(ends sessions it does not own, or kills units), **service-restarting**, **config-mutating**.

### runtime/tests — deployed instance

| Test | Class | What (file:line) | Gate |
|---|---|---|---|
| `s8-policy.runtime.test.ts` | config-mutating, service-restarting | installs temporary policies in `/etc/tbi-s8/policy.json` (via `s8-installed-policy.ts`), restores the saved bytes afterwards; restarts build + Session Host, stops / starts the Session Host; every restart ends live sessions | mutation gate |
| `s28-assist.runtime.test.ts` | config-mutating, service-restarting | installs `/etc/tbi-s8/assist.json` (:55), restarts the assist service (:56) and the build service (:107); reads the instance identity key as root (:93) | mutation gate (:25) |
| `s8-containment.runtime.test.ts` | service-restarting, session-terminating | kills its own session's QEMU unit (:364), restarts the build service (:409) and the **Session Host** (:448), which ends every live session on the instance (`host_shutdown`) | instance must be named + mutation gate (:42) |
| `s8-deployed-policy.runtime.test.ts` | session-creating; with the gate also config-mutating, service-restarting | stale-health case stops / starts the Session Host; if the installed default plan refuses prebuilt uploads, a temporary policy (restored; restarts build + Session Host) | `TBI_S8_INSTANCE`; stop case, cleanup start and temporary policy behind the mutation gate |
| `s13-deployed-security.runtime.test.ts` | session-creating, unit-killing (own) | kills its own session's QEMU unit (:284) | `TBI_S13_SEC_DEPLOYED` + mutation gate (:37) |
| `c5-deployed.runtime.test.ts` | session-creating; fault stage unit-killing (own) | `TBI_C5_FAULTS=1` kills a session's QEMU unit (:553) | `TBI_C5_DEPLOYED`; faults behind the mutation gate (:56) |
| `s11-deployed.runtime.test.ts` | session-creating | own sessions, DELETE own (:208, :498) | `TBI_S8_INSTANCE` |
| `alpha-deployed-recovery.runtime.test.ts` | session-creating; with the gate also config-mutating, service-restarting | own sessions end by lease / lifetime; DELETE own; temporary policy as above (only with at least 3 live sessions) | `TBI_S8_INSTANCE` (and ≥ 3 live sessions); temporary policy behind the mutation gate |
| `g2-deployed.runtime.test.ts` | session-creating (load: up to 30 identities, builds, 6 live, queue); creates / removes its own pause file | staging only: drills and clean-up below | `TBI_G2_DEPLOYED=tbi-s8` + mutation gate + preview list; a failed condition, CI or an unclean baseline is a refusal (test fails) |
| `s8-qemu-tasks.runtime.test.ts` | session-creating | own sessions, DELETE own (:201) | `TBI_S8_INSTANCE` (no longer defaults to tbi-s8) |

All other runtime tests use an in-process Session Host / build service with their own temporary
stores and their own QEMU child processes (`r2-failures`, `failures`, `c5-capacity`, … kill or
terminate only those): **read-only** for every deployed instance.

### app/e2e

| Spec | Class | Gate |
|---|---|---|
| `s18-r4b-real.spec.ts` recovery cases | session-terminating (kills **every** QEMU unit of the instance, `--kill-whom=all <instance>-qemu@*`, :275, :291), service-restarting (Session Host, :310) | `TBI_S18_UNIT` + mutation gate (:263) |
| every other `*-real.spec.ts` | session-creating through the relays (own sessions; staging rate 20 starts / 10 min per user) | its `TBI_*_REAL` variable |
| all other specs | read-only (local fake Session Host / build service; `__test/end-all` acts on the fake only) | – |

### scripts/ and deploy/

| Script | Class | Gate |
|---|---|---|
| `deploy/dev-lab/s8/install.sh` | config-mutating, service-restarting (both instances) | `TBI_ALLOW_SERVICE_MUTATION=<instance>` |
| `deploy/dev-lab/s8/switch-runtime.sh` | config-mutating (`runtime.json`), service-restarting | `TBI_ALLOW_SERVICE_MUTATION=<instance>` |
| `deploy/dev-lab/publish.sh`, `publish-frontend.sh`, `publish-runtime.sh`, `rollback-runtime.sh`, `s8/rollback-dev-lab.sh`, `setup-build.sh`, `retire-preview.sh`, `s9-preview/*`, `s10-preview/*` | DEV-Lab operator procedures (restart / install / re-point by design) | `TBI_ALLOW_SERVICE_MUTATION=tbi`; manual operator use only |
| `deploy/dev-lab/s8/publish-release-artifacts.sh` | writes the release-artifact store under `/srv` | `TBI_ALLOW_SERVICE_MUTATION=tbi-s8` (or `tbi`) |
| `scripts/*` | read-only (brand assets, checks) | – |

### The staging load harness (`g2-deployed`)

It configures nothing: no drop-in, `/etc` or `/srv` write, policy change or service restart. It
reads the host's unit environment, sim plans config, health, resource figures, journals and the sim
journal (`sudo -n`, read-only, with timeouts). Its writes are its own builds, sessions, queue tickets
and the Free pause file. It samples every 5 s and aborts on low memory, very high load, a service
whose working set (cgroup `memory.stat`) is near its memory limit, an OOM kill, a failing sampler, a
lost pipeline lock (or 3 lock checks in a row without an answer) or the manual stop file
`$TBI_RUNTIME_HOME/g2-stop`. A whole sample has a 15 s deadline. Sustained load above 2 x CPUs, more
than 10 % failed samples or more than 30 s between good samples fail the run without stopping it.
One clean-up (success, failure, timeout, SIGINT/SIGTERM/SIGHUP) removes only what the run created and
counts the rest. The root relays exit when the harness's stdin pipe to them closes. A killed process
(SIGKILL, power loss) cannot clean up: sessions then end by their lease,
waiters vanish, but the pause file may remain and must be checked by the operator. Reports hold
numbers and fixed codes only. Thresholds: `runtime/tests/g2-load.ts`.

## Unattended execution

- CI (`.github/workflows/ci.yml`) runs on GitHub-hosted runners (`ubuntu-latest`): typecheck,
  lint, the default unit suite and the local e2e suite. It never runs `vitest.runtime.config.ts`,
  has no deployed instance and no sudo to one, and no `TBI_*_REAL` variable is set.
- DEV has no crontab (user or root) and no TBI timer (`systemctl list-timers`: system timers only).
- The kits under `~/tbi-*/kit` run the runtime suite without `TBI_ALLOW_SERVICE_MUTATION`: the
  mutating tests now skip there.

## Release gate (runtime vitest + *-real specs)

A default run of the runtime suite and of the `*-real.spec.ts` specs skips whatever its
environment does not provide, and still exits 0. A release is therefore judged only by

```
npm run release:runtime-gate -- --out <directory outside the repository>
```

It needs a clean tree and the pipeline lock (checked before the build: `no_lock`), builds the
Session Host, runs `vitest.runtime.config.ts` and the `*-real` specs of `playwright.app.config.ts`
with JSON reporters, and writes `runtime-gate-<commit>.json` (verdict, counts, excluded tests,
failures; no error text). It fails on any skipped, todo, failed, retried or expected-to-fail test,
a file with no tests or absent from the report, a file in which no test passed (unless every test
of it is excluded), an expected failure declared in a tracked `runtime/**/*.ts` source (`it.fails`,
`it['fails']`, `fails: true`: vitest reports it as passed, so it is found in the text; a name built
at run time or destructured is not found), a non-zero runner exit, a
missing report, or a tree that changed during the run. The only exclusions are the entries of
`scripts/release/runtime-gate.manifest.json` (one file, a test-title prefix, a reason); an entry
that excludes nothing, or also matches a test that ran, fails the gate. `--from-reports <dir>`
evaluates existing reports for diagnosis and never yields PASS.

### What the operator provides

The gate sets none of this itself, except `CI=1` and the report path for Playwright.

| Need | Setting |
|---|---|
| Host-wide pipeline lock, held for the whole run | `deploy/ops/pipeline-lock.mjs acquire` |
| Permission to restart / reconfigure the instance under test (owner / PM decision; ends live sessions) | `TBI_ALLOW_SERVICE_MUTATION=tbi-s8` |
| Provisioned runtime and emulator | `TBI_RUNTIME_HOME`, `TBI_QEMU` |
| Real services behind the preview, on loopback (the fake services' ports are refused) | `TBI_RUNTIME_PROXY`, `TBI_BUILD_PROXY`, `TBI_FEEDBACK_RUNTIME_PROXY` (Session Host in reports mode, `rc6-golden-real`) |
| Real browser specs | `TBI_S6_REAL`, `TBI_S11_REAL`, `TBI_S12_REAL`, `TBI_S15_REAL`, `TBI_S18_REAL`, `TBI_S19B_REAL`, `TBI_S20L_REAL`, `TBI_MPY_REAL`, `TBI_RC6_REAL`, `TBI_W2_REAL` (each `=1`) |
| QEMU kill / restart cases of `s18-r4b-real` | `TBI_S18_UNIT=tbi-s8` plus the mutation opt-in |
| Deployed runtime tests | `TBI_S8_INSTANCE`, `TBI_C5_DEPLOYED`, `TBI_S13_SEC_DEPLOYED` (`tbi-s8`), passwordless sudo |
| C-5 fault drills (opt-in required, else the gate refuses to start; coverage below) | `TBI_C5_FAULTS=1`, and the `TBI_C5_DEPLOYED` instance named in `TBI_ALLOW_SERVICE_MUTATION` |
| Measurements | `TBI_C5=1`, `TBI_MPY_BENCH=1` |
| Gate tests | `oauth2-proxy` and `caddy` installed (`TBI_OAUTH2_PROXY` for another binary) |

Leave unset (the gate refuses to run when any of these is set, even empty, because it shortens,
narrows or redirects a test): `TBI_C5_N`, `TBI_C5_PACE`, `TBI_C5_SECONDS`, `TBI_C5_WORKLOAD`,
`TBI_G2_DEPLOYED`, `TBI_GATE_RUNS`, `TBI_GATE_UNPINNED`, `TBI_MPY_BENCH_N`, `TBI_R1_DET_RUNS`,
`TBI_S11_EXPECT`, `TBI_S12_DET_RUNS`, `TBI_S12_DET_UNPINNED`, `TBI_S12_EXPECT`,
`TBI_S8_QEMU_CYCLES`. It also refuses `TBI_C5_BUILDS` (`lease_knob`): `c5-capacity` leases its
sessions for the measured time plus 120 s and then waits up to 600 s more for those builds, so the
lease can expire before the run ends. So the gate's C-5 runs use the test defaults (1 session, 120 s); larger soaks
are separate runs.

With that default, `c5-deployed` runs only the stop / re-create drill: its QEMU-unit crash drill
needs `TBI_C5_N` of at least 2 and is **not covered** by the gate (each evidence file says so in
`notGated`). With `TBI_C5_FAULTS=1`, `c5-deployed` and `c5-capacity` fail if a drill that ran did
not recover and clean up; a drill that did not run is not judged,
except the deployed stop drill, which must run.

Evidence replaces the values of `TBI_*` (4 characters or more) and, whatever their length, of
`TBI_*_INSTANCE`, `TBI_ALLOW_SERVICE_MUTATION`, `TBI_C5_DEPLOYED`, `TBI_S13_SEC_DEPLOYED` and
`TBI_S18_UNIT` in test titles.

The gate runs against staging only. Each of `TBI_ALLOW_SERVICE_MUTATION`, `TBI_C5_DEPLOYED`,
`TBI_S8_INSTANCE`, `TBI_S13_SEC_DEPLOYED` and `TBI_S18_UNIT` must be unset, empty or exactly
`tbi-s8` (the opt-in: a comma-separated list in which every entry is exactly `tbi-s8`, without
spaces or empty entries). The value is compared as written (anchored, case-sensitive, not trimmed),
so another name or case, a wildcard, a path or a systemd unit name is refused
(`instance_not_allowed`); a value or list entry that is the live DEV-Lab name `tbi` is refused as
`live_instance`. A further test instance needs a change of the rule in the gate script.

`TBI_HOST_RUNTIME_UNIT`, `TBI_BUILD_JOB_UNIT` (unit prefixes of the services) and
`TBI_HOST_SESSION_ROOT` (the Session Host's session directory) must be unset or empty
(`unit_setting`). `TBI_PIPELINE_LOCK_DIR` must be unset, even empty (`lock_redirect`).

The operator must also leave these unset. The gate does **not** check them: `TBI_HOST_STATE`,
`TBI_ARTIFACTS`, every `TBI_HOST_SIM_*` variable and `TBI_ACCESS_VIEW`. They point a process the
suites start at another instance's state or artifacts, or change how it admits users.

`TBI_RUNTIME_PROXY`, `TBI_BUILD_PROXY`, `TBI_FEEDBACK_RUNTIME_PROXY` and, when set,
`TBI_ADMIN_PROXY` must be written as `http(s)://<host>:<port>` with host `127.0.0.1`, `localhost`
or `[::1]` and a port from 1 to 65535 (`proxy_not_loopback`). An unset or empty `TBI_ADMIN_PROXY`
is accepted, but unset it falls back to the default of `app/vite.config.ts`,
`http://127.0.0.1:7410`: set it if whatever listens there is not part of the instance under test. The gate **does not check which instance listens on those
ports**: a local relay to a live instance would pass. The operator verifies the relays.
Starting private services for the browser specs: [PRIVATE-STACK.md](PRIVATE-STACK.md) (not
rehearsed).

### Excluded (listed in every evidence file)

- `g2-deployed`, its harness test and the other G2 cases the gate manifest names: staging-only load
  harness, run separately (planned 3.12); no evidence yet. Its paying `queue_full` drill runs only
  with `TBI_G2_EXTRA_PAYING_USERS` (existing identities the operator maps to `preview` in the staging
  policy copy). Without enough of them the report can still say `PASSED` with
  `queueFullAtMaxLength: "not_run"`, so read that field. After the run the operator removes those
  mappings: the harness neither creates nor restores them. Mapping and
  unmapping change the installed staging policy: both need the pipeline lock,
  `TBI_ALLOW_SERVICE_MUTATION=tbi-s8` and a service restart (which ends live sessions). Unmap after a
  failed or aborted run too, and compare the installed policy with the bytes saved before the change;
  a leftover mapping keeps the `preview` entitlement.
- The older-host compatibility cases of `s11-deployed`, `s11-real` and `s12-real`.

### Known not excluded (the gate fails on them until decided)

- `alpha-deployed-recovery`: the case that needs three concurrent sessions is skipped where the
  policy admits fewer (`maxLive` 1 on a 1-vCPU host), so **the gate cannot PASS on a 1-vCPU host**.
- `alpha-deployed-recovery` and `s8-deployed-policy`: the "prebuilt refusal" cases run only when the
  installed default plan refuses prebuilt uploads, so they are skipped under a policy that allows
  them.
