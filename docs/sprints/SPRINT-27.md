# Sprint 27 — AI Engineering Foundation & Circuit Debugger (DEV)

Branch `sprint-27` (from `002029d`, the Sprint 26 head; the P1 language-switch fix merged in
`67e30cc`, schema v7). Target: DEV only (tbi-lab-srv). Runtime unchanged: Runtime v5
`39f2229a66d45e43`. Principle: **AI proposes. The engineering engine validates. The user approves.**
In this sprint the AI side is a deterministic **mock**; no external AI service is connected and no
credential exists anywhere.

## Architecture and boundaries

```
 browser (DEV-Lab build only)                               [no server-side AI component]
 ┌───────────────────────────────────────────────────────────────────────────────────────┐
 │ project document ─┐                                                                   │
 │ engine checks ────┼─► buildEngineeringContext ─► diagnose ─► Findings (the truth)     │
 │ build/run status ─┘     (bounded, versioned)       │                                  │
 │                                                    └─► AssistGateway ─► MockProvider  │
 │                                                          ▲  validateResponse ◄─┘      │
 │ AssistPanel: findings (simulator) │ explanation (mock, labelled) │ evidence links     │
 │ actions.ts: dryRun only — never applies, AI origin always rejected (ai_write_disabled) │
 └───────────────────────────────────────────────────────────────────────────────────────┘
   Session Host, build service, QEMU, host files: not reachable from any of this.
```

- `packages/assist` (`@tbi-lab/assist`): pure TypeScript, no I/O, no network, no DOM. Imports the
  domain and engine types only.
- `app/src/assist`: the panel, its host and the button; loaded on the first open. Compiled into
  DEV-Lab builds only (each use site tests `import.meta.env.VITE_TBI_ENV === 'dev'` literally so
  the bundler removes it elsewhere). `deploy/release/check-dist.mjs` (`checkAssist`) refuses a
  non-DEV build that carries any assist module, chunk or the button, and a DEV-Lab build without
  them. Verified on real builds: production clean; DEV-Lab complete; the DEV build refused as
  production (11 errors).
- The simulator is unchanged: no provider-specific code in the engine, builder or runtime.

## Engineering Context API — `tbi-lab.engineering-context` v1

`buildEngineeringContext(doc, inputs)` returns a JSON object built only from canonical project
data and results the engine already computed:

| Part | Content |
|---|---|
| `format`, `version`, `product` | the context format, project schema version and engine version |
| `circuit.components`, `circuit.nets` | id, validated type id and version, parameters in SI with units and provenance; nets with their terminals |
| `checks`, `solver` | the engine's electrical diagnostics (codes, components, numbers) and the solve state |
| `ratings` | rating checks with limit, value and source |
| `program`, `build` | language/profile/files (names only); build status and diagnostics (file, line, message ≤ 240 chars, at most 20) |
| `failure`, `observed` | the simulation failure as the app holds it; observed pin levels |
| `capabilities` | the runtime's announced capabilities (`null` when unknown, never assumed) and facility status |
| `assumptions` | the documented modelling assumptions in force (ids) |
| `excerpts` | at most 8 code excerpts (±2 lines), comment-masked, secret-redacted, `untrusted: true` |
| `unknowns` | conditions the simulator cannot characterise, named |
| `truncated` | what the limits dropped (never silently) |

Provenance on every value: `specified` (user parameter), `datasheet`, `calculated` (engine),
`observed` (runtime), `assumed` (documented engineering assumption), `unknown`. No value is
invented: a quantity the engine did not compute is `unknown`, never estimated. Limits
(`CONTEXT_LIMITS`): 48 KiB serialized; 120 components, 200 nets, 60 checks, 60 ratings; details are
dropped first (recorded in `truncated`), then the context is refused. Not included: project name,
user-authored net names, identities, serial output, screenshots; string literals and comments are
masked, credential-like tokens redacted.

## Deterministic Circuit Debugger — `diagnose(ctx)`

51 stable ids in `DIAGNOSTICS` (families: connection, supply, gpio, current, rating, logic, i2c,
pwm, capability, build, runtime, solver, analysis). Every finding carries: id, severity, certainty
(`verified` / `limited` / `unknown`), affected components/pins, explanation key and parameters,
evidence references (context paths), suggested action where justified, limitations. Covered by
the brief: floating inputs (`gpio.input_floating`, `logic.input_floating`), undriven/incorrectly
driven connections (`gpio.contention`, `gpio.short`, `connection.*`), current limits
(`current.led_overcurrent`, `current.part_overcurrent`, `gpio.drive_current`), ratings
(`rating.*`), unsupported I²C (`i2c.clock_exceeded`, `i2c.read_unsupported`), runtime capabilities
(`capability.*`), build and code errors (`build.*`). A finding exists only when the engine,
builder or runtime produced the underlying result.

## Provider adapter and the mock

- Contract `tbi-lab.assist.explain/1`: input = the findings and the evidence they cite (not the
  raw project); output = per finding a plain-language explanation that cites finding ids.
- `validateResponse` rejects: unknown or missing finding ids, numbers not present in the cited
  evidence (quantity and unit must match), links, markup, HTML, claims about findings not given.
- `AssistGateway`: timeout 20 s, cancellation, at most 2 retries with backoff, 6 requests / min,
  1 concurrent; token and estimated cost accounting (characters / 4 when a provider gives no
  counts); typed errors (`unavailable`, `rate_limited`, `busy`, `timeout`, `cancelled`, `invalid_response`, `provider_error`).
- `MockProvider` (`live: false`, model `template-mock-1`): templated text from the findings. The
  panel says it is an experimental template, not a live AI model.

## Future structured actions — dry run only

`tbi-lab.assist.actions/1`: `add_component`, `connect`, `disconnect`, `set_value`, `write_file`,
`select_library`, `request_validation`. `parseEnvelope` + `dryRun` validate each action against the
catalog, the project schema, path and library rules and the electrical rules on a copy of the
document and report per action `ok` or a rejection. There is no apply function. Any AI-origin
envelope is rejected as `ai_write_disabled`.

## Evaluation bench

60 cases (`packages/assist/eval/cases.ts`): valid circuits, invalid circuits, missing connections,
floating inputs, unsupported hardware, rating violations, Arduino and MicroPython build failures,
ambiguous conditions, correct-refusal cases; plus 15 adversarial provider replies.

| Measure | Threshold (proposed) | Measured |
|---|---|---|
| Diagnostic correctness | ≥ 0.95 | 1.0 |
| Critical cases correct (15) | 1.0 — no aggregate may hide one | 15 / 15 |
| Evidence traceability | 1.0 | 1.0 |
| False claims | 0 | 0 |
| Adversarial replies refused | 1.0 | 15 / 15 |
| Correct refusals | 1.0 | 1.0 |
| Explanation usefulness (rubric) | ≥ 0.8 | 0.848 |
| Local latency p95 | < 50 ms | 2.35 ms |
| Context size (max) | ≤ 48 KiB | 31.3 KB |
| Prompt tokens (estimate, chars/4) | — | mean 1,376, max 12,838 |

Usefulness is a fixed rubric over the mock's templated text; it measures the deterministic part,
not a language model.

## Sprint 26 reliability carryover

**L1 (MicroPython relative-import alias).** Reproduced: `from .hw import I2C as Bus` (and
`from hw import I2C as Bus`) left `Bus(..., freq=400000)` unchecked. Fixed (`5997d52`): `I2C`
imported from a project module under any name is analysed call by call like `machine.I2C`; an
uncalled reference is refused. MicroPython analyzer version 4 → 5 (part of the profile hash:
earlier builds are re-analysed).

**The eight known runtime failures — classified, not changed:**

| Tests | Root cause (verified) | Class |
|---|---|---|
| r2-acceptance ×3; r2-failures isolation, failure injection, resource measurements, client disconnect | The R1/R2 gate circuit (`runtime/tests/r2-support.ts` `gateProject`) holds VEXT (PSU1) at 0 V while GPIO2 drives HIGH through R2 + R3 (20 kΩ): the supply would have to sink ≈ 165 µA. Since Sprint 22 a bench supply never sinks (`psu_sinking`); the session ends `failed / electrical_error` at 0.89 s, and every test waiting for a later point times out. | Test workload conflicts with a correct physics rule. Not an engine defect. |
| s19b-x1 | `logic_supply_current_uncharacterized`: SN74LVC1G08 I_CC is specified only with inputs at V_CC or GND (owner decisions S22-F3: within 1 mV; S22-Q1: no bound off the test voltages). Input A, driven by the ESP32, can sit 50.5 mV from the rail at the worst corner, and PSU1's limit check depends on I_CC. The shipped example `esp32-logic-and` is refused the same way. | Correct refusal under the owner's rules. Not an engine defect. |

Neither was "fixed": the remedy changes a release-gate circuit or an owner rule. Proposals in the
report (owner decisions).

**Pre-existing finding (P1 gates):** the build service deletes every core seed at start-up
(`runtime/builder/main.ts`, `pruneCoreSeeds(coreSeeds, new Set(), true)`, since S18F), so each
restart queues a cold curated prewarm that fills the shared queue; `s8-policy` submits right after
its restart and gets `builder_busy`. Not changed in this sprint (owner decision).

## Estimated future AI operating cost (assumptions; not authorised, nothing connected)

Per analysis: input ≈ 1,400 tokens (measured mean, chars/4 estimate; worst case 12,838), output
300–500 tokens of explanation, plus model reasoning tokens (billed as output; 0–600 assumed at low
effort). Anthropic first-party list prices (per million tokens, 2026-10): Haiku 5.5 $0.10 in /
$0.50 out; Sonnet 5.5 $2 / $10; Opus 5.5 $4 / $20. The fixed contract text is below the minimum
cacheable prefix, so no caching saving is assumed. Add ~10 % for retries and rejected replies.

| Model | Per analysis (400 out, 0–600 reasoning) | 1,000 / month | 50,000 / month |
|---|---|---|---|
| Haiku 5.5 | $0.0003 – $0.0007 | $0.4 – $0.7 | $19 – $35 |
| Sonnet 5.5 | $0.007 – $0.014 | $7 – $14 | $375 – $705 |
| Opus 5.5 | $0.014 – $0.028 | $15 – $28 | $750 – $1,410 |

A worst-case context (12.8 k input) multiplies the input part by ~9. The gateway's 6 / min per
user and bounded retries cap abuse; a per-user monthly quota would be needed before any live use.
Exact prices must be re-checked at activation.
