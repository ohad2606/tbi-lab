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

## Deployed acceptance tests on a beta instance

Pass the repository file the instance was installed with, as for `install.sh`:
`TBI_S8_POLICY=deploy/dev-lab/s8/policy.beta.json` (unset or empty: `policy.json`). Shared logic:
`runtime/tests/s8-installed-policy.ts`.

| Test | Without the mutation gate | With the mutation gate |
|---|---|---|
| `s8-deployed-policy` | asserts the `403 capability_disabled` refusal; the upload, session and defer cases are SKIPPED with a reason (not tested); the stale-health case is skipped as before | asserts the refusal, then runs every case under a temporary policy |
| `alpha-deployed-recovery` | asserts the refusal; the recovery case is SKIPPED with a reason | asserts the refusal, then (only with at least 3 live sessions) runs under a temporary policy |
| `s8-policy` | skipped, as before | installs its validation policy (plus the installed plan names, such as `free`) |
| `s11-deployed` | no upload; reads limits from `TBI_S8_POLICY` | same |

- The temporary policy is the installed file with one change, `defaultPlan: preview`. It applies to
  **every unassigned principal** of the instance while the test runs, and the build service and
  Session Host are restarted twice (live sessions end).
- Before changing the policy, `s8-policy`, `s8-deployed-policy` and `alpha-deployed-recovery` save the
  installed bytes and restore exactly those, never a repository file. If the installed file cannot be
  read or does not validate, they fail before changing anything.
- A killed run (no `afterAll`) leaves the temporary policy installed. The log prints the path of the
  saved copy (`policy.before.json`, in the system temporary directory): install it again
  (`install -m 0400`, as root) and restart both services, before any further run.
- `install.sh` without `TBI_S8_POLICY` installs `policy.json`: pass the variable on every reinstall.

## Known follow-ups

- **Not run on any instance:** none of the adapted deployed tests has run on staging or another
  installed instance (they skip without one). Only the helper is unit-tested
  (`runtime/policy/tests/s8-installed-policy.test.ts`).
- Not checked: these tests and `capacity-acceptance.sh` on an instance with sim metering enabled
  (its Free live-session cap and queue may change what they observe).
- The app shows no dedicated message for `capability_disabled` yet (frontend follow-up).
