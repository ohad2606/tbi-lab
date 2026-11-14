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
`TBI_S13_SEC_DEPLOYED`); none defaults to a shared instance. The staging/DEV-Lab operator scripts
`deploy/dev-lab/s8/install.sh` and `switch-runtime.sh` refuse (exit 64) unless
`TBI_ALLOW_SERVICE_MUTATION` names the instance.

`scripts/tests/mutation-gate.test.mjs` (in the default unit suite and CI) fails if a runtime test or
e2e spec contains a mutating `systemctl` call or an `install … /etc/…` without importing the gate.

## Classification

Classes: **read-only** (no deployed instance touched), **session-creating** (own sessions/builds on
a deployed instance, cleaned up by the test; uses the per-user rate), **session-terminating**
(ends sessions it does not own, or kills units), **service-restarting**, **config-mutating**.

### runtime/tests — deployed instance

| Test | Class | What (file:line) | Gate |
|---|---|---|---|
| `s8-policy.runtime.test.ts` | config-mutating, service-restarting | installs `/etc/tbi-s8/policy.json` (:50) and restarts build + Session Host (:51), restarts build (:179), stops / starts the Session Host (:231, :240, :247), restarts it (:260); every restart ends live sessions | mutation gate (:25) |
| `s28-assist.runtime.test.ts` | config-mutating, service-restarting | installs `/etc/tbi-s8/assist.json` (:55), restarts the assist service (:56) and the build service (:107); reads the instance identity key as root (:93) | mutation gate (:25) |
| `s8-containment.runtime.test.ts` | service-restarting, session-terminating | kills its own session's QEMU unit (:364), restarts the build service (:409) and the **Session Host** (:448), which ends every live session on the instance (`host_shutdown`) | instance must be named + mutation gate (:42) |
| `s8-deployed-policy.runtime.test.ts` | session-creating; one case service-restarting | stale-health case stops / starts the Session Host (:281, :290); the cleanup start (:144) | `TBI_S8_INSTANCE`; stop case + cleanup behind the mutation gate (:28) |
| `s13-deployed-security.runtime.test.ts` | session-creating, unit-killing (own) | kills its own session's QEMU unit (:284) | `TBI_S13_SEC_DEPLOYED` + mutation gate (:37) |
| `c5-deployed.runtime.test.ts` | session-creating; fault stage unit-killing (own) | `TBI_C5_FAULTS=1` kills a session's QEMU unit (:553) | `TBI_C5_DEPLOYED`; faults behind the mutation gate (:56) |
| `s11-deployed.runtime.test.ts` | session-creating | own sessions, DELETE own (:208, :498) | `TBI_S8_INSTANCE` |
| `alpha-deployed-recovery.runtime.test.ts` | session-creating | own sessions end by lease / lifetime; DELETE own (:170, :175) | `TBI_S8_INSTANCE` (and ≥ 3 live sessions per user) |
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
| `deploy/dev-lab/publish.sh`, `publish-runtime.sh`, `rollback-runtime.sh`, `s8/rollback-dev-lab.sh`, `setup-build.sh` | DEV-Lab operator procedures (restart / install by design) | manual operator use only; not called by CI, timers or the test suites |
| `scripts/*` | read-only (brand assets, checks) | – |

## Unattended execution

- CI (`.github/workflows/ci.yml`) runs on GitHub-hosted runners (`ubuntu-latest`): typecheck,
  lint, the default unit suite and the local e2e suite. It never runs `vitest.runtime.config.ts`,
  has no deployed instance and no sudo to one, and no `TBI_*_REAL` variable is set.
- DEV has no crontab (user or root) and no TBI timer (`systemctl list-timers`: system timers only).
- The kits under `~/tbi-*/kit` run the runtime suite without `TBI_ALLOW_SERVICE_MUTATION`: the
  mutating tests now skip there.
