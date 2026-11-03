# Sprint 28 — AI Provider Readiness, Reliability Closure & Controlled Evaluation (DEV)

Branch `sprint-28` (from `32f56e8`, the Sprint 27 head; deployed code `d9dc155`). Target: DEV only
(tbi-lab-srv). Runtime unchanged: Runtime v5 `39f2229a66d45e43`. No paid AI call was made; no
credential exists; no AI write action; Alpha, RC5 and production untouched.

## 1. Baseline and execution safety

Verified at start: DEV-Lab and staging served `d9dc155` (services and frontend links, `/health`
commits), all services active, `sprint-27` = `origin/sprint-27` = `32f56e8`. Sprint 27 artifacts
(`~/tbi-s27/kit`, backup `devlab-backup-20261102T125633Z`) are kept.

**Host-wide pipeline lock** (`deploy/ops/pipeline-lock.mjs`, 7 tests). One owner at a time for
heavy tests, staging installs and batches, DEV-Lab deploys and rollbacks. The lease
(`/run/lock/tbi-pipeline.json`) records the owner — a Claude Code session (its session id, its PID
and the PID's kernel start time, so a reused PID never looks alive) or a named person — and the
purpose. A live holder refuses everyone else (exit 75, holder named); a lease whose holder is gone
is taken over with a history record (`~/tbi-pipeline/history.log`); an unreadable lease fails
closed. Every Sprint 28 kit script (`~/tbi-s28/kit`: package, gates, staging install, browser runs,
DEV-Lab deploy, acceptance, rollback) starts with `pipeline-lock.mjs check` and refuses without the
lease. `whose <pid>` attributes a process to its session through its ancestors; nothing is stopped
on a process name alone, and the tool never signals a process. The other session on this host was
told (cross-session message) and stayed idle.

## 2. Runtime reliability

| Item | Root cause (verified) | Change |
|---|---|---|
| s8-policy (7) | `runtime/builder/main.ts` removed every core seed at start (`pruneCoreSeeds(seeds, new Set(), true)`, since S18F; meant only for interrupted harvests). Each restart: no seed → prewarm queued a cold curated rebuild (staging journal: `coreSeed: cold`, 50–107 s) that held the shared queue right after start; the test restarts and submits at once → `builder_busy`. The S27 run's 7/7 was a different cause: the relay's random port hit 5060/5061, refused by fetch ("bad port"; fixed in `d9dc155`). | Start-up prune keeps the current configuration's complete seed (the key a new job uses) and removes `.tmp-*`, other configurations and markerless directories (`pruneCoreSeedsAtStart`, test). After a restart on staging: no cold build. s8-policy 7/7 on staging. |
| R2 ×6 (+ client disconnect, flaky in S27) | The gate workload held VEXT at 0 V while GPIO2 drove HIGH through 10 k + 10 k: the bench supply had to sink ≈ 165 µA (`psu_sinking`, a correct rule since S22) and GPIO5 sat at 1.65 V inside V_IL..V_IH (S25). | Workload redesigned, rules unchanged: GPIO2 → 1 MΩ → GPIO5 ← 1 kΩ ← VEXT, GPIO5 → 10 kΩ → GND, VEXT 0.5 V ↔ 3.3 V. Engine-checked at every state (`runtime/host/tests/r2-gate-v2.test.ts`): GPIO5 0.454/0.457 V or 2.997/3.000 V, the supply always sources 43 µA–0.30 mA; the old workload is the control (`psu_sinking`). The R1 reference loop has the same circuit as an opt-in variant; its default workload and pins are unchanged. |
| s19b-x1 | Expectation from S19B, before owner rules S22-F3/Q1: SN74LVC1G08 I_CC is bounded only with inputs within 1 mV of a rail; input A is never there (≈ 50 mV, pull-down / GPIO18 LOW ≤ 0.33 V). No ESP32-driven X1 can meet the rule. | The test asserts the named refusal at creation (`logic_supply_current_uncharacterized`, U2/PSU1, pad 18), identical on two runs — as the staging browser spec already does. The rule is not weakened. |

Arduino and MicroPython behaviour is unchanged (builder suites, s26-multifile, mpy-cross, the
real-toolchain and real-QEMU suites).

## 3. MicroPython security L7

Probed beyond the review's case: eight programs reached refused machine facilities with nothing
refused — computed `getattr(machine, 'I'+'2C')`, `m = machine`, `[machine]`, `f(machine)`,
`sys.modules['mach'+'ine']`, `vars(machine)[...]`, `globals()[...]` after `import *`, and a project
module re-exporting `machine`. New refusal **`dynamic_access`** (fail closed, EN/HE text):

- the machine module used other than as `<alias>.<name>` (or `getattr` with a written name);
- a run-time name lookup anywhere: `getattr`/`setattr`/`delattr`/`hasattr` with a name not written
  as a string, `vars()`, `globals()`, `locals()`, `__dict__`, `__getattribute__`, `exec`, `eval`,
  `compile`, `sys.modules`;
- the machine module bound in one project file (or managed library module) and imported by another
  (`from hw import mc`, `from hw import *`, `hw.mc`) is checked like `machine` itself.

Static code is unchanged (tests: `machine.Pin`, written `getattr` names, the word "machine" in text,
multi-line imports, `re.compile`). 19 adversarial + 8 preservation tests. Analyzer 5 → 6 (earlier
builds re-analysed; seen on staging: six MicroPython prewarm rebuilds of ~0.5 s).

## 4. AI provider service — server side, provider-neutral, INACTIVE

```
 browser (DEV-Lab build)          gate (Caddy internal origin)        tbi-assist (own user/group)
 ┌──────────────────────┐        ┌──────────────────────────┐        ┌───────────────────────────┐
 │ Circuit Debugger     │  /assist/v1/* (same origin, login)  │  unix   │ status / preview / explain│
 │  findings (truth)    │──────▶ │ strips X-Tbi-*, sets the │──────▶ │ principal from the gate   │
 │  pilot section       │        │ subject header           │ socket │ pilot list, consent check │
 │  (no key, no         │        └──────────────────────────┘ 0660   │ context re-checked,       │
 │   provider call)     │                                     group  │ findings RECOMPUTED       │
 └──────────────────────┘                                     tbi-   │ gateway + strict validator│
                                                              assist │ caps, ledger, audit       │
   Session Host, build service, QEMU, artifact store: NOT reachable └───────────┬───────────────┘
   (private /run, masked state dirs, not in the gate group)                     │ provider adapter
                                                                                ▼ (none today:
                                                         IPAddressDeny=any, AF_UNIX only)
```

- **Inactive by default.** `/etc/tbi/assist.json` (root, installed only when absent; never replaced
  by a reinstall): DEV-Lab `provider: none`. The service answers explain only when all five owner
  conditions are recorded and match the provider: provider+model approved, data terms reviewed, a
  hard monthly spending cap, security review passed, owner activation — plus prices and a
  credential. A malformed file or unknown key keeps it disabled; `/v1/status` names every reason.
- **No network.** The unit has `RestrictAddressFamilies=AF_UNIX` and `IPAddressDeny=any`, and
  references no provider key. Activation is a separate owner-approved drop-in
  (`LoadCredential=provider-key:…`, egress to the provider only).
- **Isolation.** Own system user and group (`tbi-assist`); NOT in the gate group; a private
  read-only `/run` with only its own runtime directory (the build and runtime sockets do not exist
  in its namespace, also after those services restart — found and fixed during staging testing);
  artifact store, build state, `/srv/tbi-lab` and `/home` masked; `ProtectSystem=strict`,
  `NoNewPrivileges`, no capabilities, 256 MiB. systemd exposure 1.1 (build service 1.3).
- **Authorization.** Identity only from the gate (opaque principal); explain and preview only for
  principals on the pilot list (≤ 10, no emails); others get 403.
- **Consent.** Explain requires `{ consent: { version, accepted: true } }` of the current version
  (428 otherwise). The UI asks for it only after showing the exact payload.
- **Request boundary.** Exactly the documented keys; the context's format, version, parts, sizes
  (48 KiB, counts, ≤ 320-char strings, depth) are checked; excerpts and build messages are masked
  and redacted again; the FINDINGS are recomputed on the server by `diagnose()` (a client cannot
  choose what the model explains). `/v1/preview` returns exactly what would be sent, never sends.
- **Ceilings.** Per user 3/min and 30/day; service-wide concurrency 1; timeout 20 s; 1 retry;
  ≤ 1,200 output tokens; monthly token ceiling; monthly spending cap checked with the request's
  worst case BEFORE any call; a failed live attempt is charged its worst case (a refused or cut-off
  reply may be billed), so the cap cannot leak.
- **Responses.** The provider is asked for JSON matching the contract's schema (structured output);
  the S27 validator then checks every statement (unknown findings, numbers not in the cited
  evidence, unknown identifiers, impersonation, links, markup). Refusals and cut-off replies are
  typed errors, never parsed.
- **Logs and retention.** Audit log (`/var/lib/tbi-assist/audit-YYYY-MM-DD.jsonl`, 0600): time,
  a short principal reference, action, outcome, tokens, charged USD, latency, context bytes —
  never context, prompt, reply, email or key. Ledger per day. Retention: audit 30 days, ledger
  90 days (configurable), pruned hourly.
- **Adapter.** First candidate: Anthropic Messages API via the official SDK (`@anthropic-ai/sdk`
  1.3.0, pinned, bundled into the service only; SDK retries off). Tested only against a local fake
  API. `check-dist` refuses any frontend build carrying a provider endpoint, SDK or key header.

### Exact data that would leave TBI Lab (per approved request)

`renderPrompt({contract, locale, findings, context})`: the fixed system instructions; the locale;
the findings recomputed by the server; the sanitised Engineering Context — component types,
validated parameters with units and provenance, net connectivity (ids only), electrical checks,
solver state, ratings, observed pin levels, build status with ≤ 20 messages (≤ 240 chars, quoted
text emptied), ≤ 8 code excerpts of ±2 lines (comments and string literals masked, credential-like
lines redacted), runtime capabilities, modelling assumptions, named unknowns, what was truncated.
Never: identity (principal, email, name), project name, user net names, comments, string
contents, serial output, screenshots, whole files. Size: mean ≈ 1,400 tokens, max 12,860 (73
cases). The user sees this payload verbatim before consenting.

## 5. Model evaluation readiness

`packages/assist/eval/harness.ts` runs every case through any provider via the product's gateway
and validator. Results are labelled `mock-baseline` or `model` and never mixed (enforced).
Measures: explained / rejected (by issue) / **fabricated claims** (numbers, identifiers,
impersonation, unknown findings, foreign citations), coverage, correct declines, subject named,
**all-clear on refusal cases**, latency p50/p95, tokens, cost; human-rating fields reserved for the
owner. Diagnostic correctness stays the deterministic bench's.

Cases: 60 (S27) + 13 (S28: low-current no-false-alarm, supply off, not running, pad drive limit
(critical), L7 refusal, sinking supply, injection in a string literal / `#define` secret /
docstring / quoted compiler text, a defined read with a pull-down (critical), two unsupported
facilities, an underscore feature id) = 73.

**Mock baseline** (not a model result): 73 cases × EN/HE, rejected 0, fabricated 0, coverage 1,
subject named 0.97, all-clear on refusals 0, p95 3 ms, input tokens mean 1,376 / max 12,860,
output mean 150 (estimates). Deterministic bench: correctness 1.0, critical 17/17, traceability 1,
false claims 0. The harness's own tests use SIMULATED live providers (local functions) to prove it
catches invented numbers, reassurance on refusal cases and empty coverage, and that a
well-behaved model can meet the bar.

Proposed pilot thresholds (to confirm before a model run): fabricated claims 0; all-clear on
refusal 0; rejected ≤ 5 %; coverage ≥ 0.9; subject named ≥ 0.8; p95 ≤ 15 s; mean cost ≤ $0.01.
A baseline never meets them. **No real model has been tested**; `runtime/assist/eval-model.ts`
refuses unless the configuration is fully approved, a credential exists and a per-run cost limit
under the approved cap is given, and stops at that limit.

Found by the new cases (S27 defect, fixed): the mock named an unsupported feature by its internal
id (`drive_strength`, `cpu_frequency`, `i2c_*`, `dynamic_access`); the validator rightly refused it
as impersonation, so those findings lost their explanation. The localized feature name is used.

## 6. Owner-only pilot UI

In the Circuit Debugger (DEV-Lab builds only), through `gateFetch` like every request: shows the
pilot's state and, if off, every missing approval (EN/HE); for a pilot user of an active service,
nothing is sent until the user opens the exact payload preview (LTR, bounded) and ticks consent of
the current version; one request per click; the reply is shown with the server's findings and a
labelled explanation; a new analysis resets preview and consent; no write action exists. On
DEV-Lab it shows "Off — no provider configured".

## 7. Cost assumptions (no call made)

Per analysis: input ≈ 1,400 tokens (measured, chars/4; Haiku 5.5's tokenizer counts ≈ 30 % more:
≈ 1,820), output 300–500, reasoning 0–600 at low effort, +10 % for retries/rejections. List
prices per MTok: Haiku 5.5 $0.10/$0.50; Sonnet 5.5 $2/$10; Opus 5.5 $4/$20 (to re-check at
activation).

| Model | Per analysis | Owner pilot (300/month) | 1,000/month |
|---|---|---|---|
| Haiku 5.5 | $0.0004 – $0.0007 | $0.11 – $0.21 | $0.4 – $0.7 |
| Sonnet 5.5 | $0.007 – $0.014 | $2.1 – $4.2 | $7 – $14 |
| Opus 5.5 | $0.014 – $0.028 | $4.2 – $8.4 | $15 – $28 |

A one-off evaluation run (73 cases × 2 locales = 146 calls): Haiku ≈ $0.10, Sonnet ≈ $2,
Opus ≈ $4. Suggested first cap: $5/month for the owner pilot.

## Gates and deployment

(filled in below after the gates)
