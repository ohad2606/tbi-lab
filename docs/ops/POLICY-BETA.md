# Public-beta policy: Advanced prebuilt binaries off for Free (FW-FREE)

`deploy/dev-lab/s8/policy.beta.json` is `policy.alpha.json` plus one plan:

- `free` (the new `defaultPlan`): every limit identical to `preview`; only
  `capabilities.allowPrebuiltBinary` is `false`.
- `preview` and `system` are unchanged; `global` is unchanged; `assignments` is empty.
  A principal assigned `preview` keeps the Advanced prebuilt upload.

`policy.alpha.json` and `policy.json` are not changed. The test
`runtime/policy/tests/policy-beta.test.ts` checks the file (fail closed), the field-by-field
equality of `free` and `preview`, and the refusals.

## Behaviour for a Free principal

- `POST /v1/artifacts` answers `403 {"error":"capability_disabled"}` before the body is read:
  nothing is stored, no upload-rate event is recorded. The only log line is the existing admission
  event.
- `POST /v1/artifacts/:sha/lease` of an image the principal holds only as a prebuilt upload (made
  earlier under `preview`) answers `403 {"error":"capability_disabled"}`. Built firmware (own or
  shared) and R1 reference images lease as before. Nothing is deleted: a principal moved back to
  `preview` can lease its upload again.
- A run ticket issued before the switch stays valid until it expires (the lease duration).

There is no environment toggle or bypass: the plan comes from the installed policy file only.

## Deploy and rollback

- Deploy: install with `TBI_S8_POLICY=<repo>/deploy/dev-lab/s8/policy.beta.json` (install.sh
  copies it to the instance's `policy.json`).
- Rollback: install again with `TBI_S8_POLICY=<repo>/deploy/dev-lab/s8/policy.alpha.json`.

Deploying is a separate, owner-approved step; it is not part of this change.

## Known follow-ups

- The deployed acceptance tests `runtime/tests/s8-deployed-policy.runtime.test.ts` and
  `runtime/tests/alpha-deployed-recovery.runtime.test.ts` upload an Advanced image as an
  unassigned user, so they assume the default plan allows prebuilt
  binaries. Run them against an instance installed with `policy.alpha.json`, or adapt them,
  before an instance runs `policy.beta.json`.
- The app shows no dedicated message for `capability_disabled` yet (frontend follow-up).
