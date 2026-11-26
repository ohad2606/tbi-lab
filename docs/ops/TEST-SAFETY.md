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
