# Assist evaluation results

- `mock-baseline.json` — the deterministic template provider over every case (EN, HE), produced
  by `TBI_ASSIST_BASELINE_OUT=<this dir>/mock-baseline.json npx vitest run app/tests/assist-harness.test.ts`.
  It shows that the pipeline and the measures work. **It is not a model result** and says nothing
  about the quality of any language model.
- `models/` — real-model reports (`kind: "model"`), written by `runtime/assist/eval-model.ts`.
  **Empty: no real model has been run.** The runner refuses unless the AI provider service's
  configuration carries all five owner approvals, a credential, and a per-run cost limit under
  the approved monthly cap (Sprint 28).

Mock and model results are never merged or compared in one figure.
