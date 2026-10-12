# Determinism pin drift from H2 — found, bisected, re-pinned (2026-10-12)

**Found by** the R4 probe's continuity check (A-12), which ran the Runtime v2 pinned suites on the
`sprint-13` branch. The Sprint 13 CI so far was unit + typecheck + lint + e2e. The pinned
**runtime** suites had not been run on the branch. That was a gap; the rest of this record closes it.

## Symptom

On `sprint-13` (f245838) with the **release** Runtime v2 QEMU (`b5b34b49cb7e4049`):

- all 7 Sprint 12 determinism pins differed;
- the R1 `motion` pin differed.

Each scenario still reproduced one fingerprint over 3 and over 10 runs, so the runs are deterministic: the pinned values themselves had moved.

## Cause

| Step | Result |
|---|---|
| Control: same branch, release QEMU vs the R4 scratch QEMU | identical fingerprints, so the runtime is not the cause |
| `sprint-12` worktree (68a96ca) | pin reproduced |
| Bisect (isolated worktree with its own workspace links) | 138541f and 9e33428 reproduce the pin; **a23ffcd** (H1/H2 slice 1) and every later commit differ |
| Event-stream diff, 9e33428 vs f245838 (dht22 60 °C; R1 motion) | the **only** difference is an added field `outsideModelRange: false` on a supply-limited part (DHT22 U1; PIR U2) |
| All 7 S12 scenarios at f245838 with that one field removed | **7/7 equal the Sprint 12 pins** |

The field is H2's unreliable-result indicator (Component Failure Framework). In these circuits
every part is inside its model range, so the value is `false`. No voltage, current, timestamp,
serial byte or GPIO event changed.

## Re-pin (mechanism 3: additive outcome field)

Each new pin comes from 10 converging runs on the release Runtime v2.

| Scenario | Sprint 12 pin | Sprint 13 pin |
|---|---|---|
| hcsr04-0.1m | a6174faf18931c61 | 3dd25c5ae652c283 |
| hcsr04-1m | f5c51475cc5dac18 | 4d076533f2a86241 |
| hcsr04-4m | ce7868f0e5352722 | 0307e9f722c52aa2 |
| dht22--10C-30RH | b87741773a4f3c7a | 34cb128f5dbc7182 |
| dht22-21.5C-55.2RH | 414a2379065bc425 | 58966db12b113310 |
| dht22-60C-95RH | 10af087aa4803ee2 | 9c0249a9cfec605a |
| lcd1602-hello | 03d6e5f264ed9506 | 8b541851155780da |
| R1 motion | 5fdb6a1ad50a412a | 261f54efe0dd9a9c |
| R1 night | 5596d749c3ce4f8c | unchanged (no supply-limited part) |

These suites were unaffected; they pass unchanged on the branch:

| Suite | Tests passed |
|---|---|
| R-MCU-1 gate | 7/7 |
| r2-acceptance | 5/5 |
| s12-pace | 1/1 |
| s12-r2-timing | 9/9 |
| failures | 15/15 |
| s12-bridge | 11/11 |
| r2-failures (after `npm run host:build`, its precondition) | 11/11 |

## Consequences

- **Deployed environments are not affected.** dev-lab and staging run `ba0f4a6`, which has no H2.
- **When Sprint 13 is released, these pins are the ones that apply**, and the staging Gate B suites use them.
- **Process fix.** From now on, the Sprint 13 CI record lists the pinned runtime suites next to unit and e2e.
