# BETA-G2: free-plan limits for the public beta (slices 1 and 2)

Status: implemented and unit-tested (slice 2: ops-review minors of slice 1); **off by default** and not enabled anywhere. Enabling (setting
`TBI_HOST_SIM_PLANS_CONFIG` on any host) stays a separate owner approval
(`docs/plans/S3D-STAGING-ENABLE-CHECKLIST.md`). Billing, credits, AI quotas, plan-assignment UI and any
app UI are out of scope (frozen). Read with `docs/plans/S3D-HOST-WIRING-DESIGN.md` (the TBI-018 wiring).

## 1. Goal -> what already existed -> what this slice adds

| Goal | Already in co/main (TBI-018 s3b..s3d-6) | Added here |
|---|---|---|
| (a) session time cap for Free users | Host policy plan `runtime.maxLifetimeMs` (`runtime/policy/policy.ts`), applied on the metered path too (`SessionHost.admitMetered`, lifetime clamp; a stricter client value wins, a longer one never does). The sim `PlanId` comes from the policy plan name through `TBI_HOST_SIM_PLAN_MAP`, so a policy plan mapped to `free` carries the Free cap. The run ends with the existing end reason `lifetime_exceeded`; the app already warns before it (`sim.runtime.expiring`). | No code. Tests that prove it on the metered HTTP path (`runtime/host/tests/g2-free-limits.test.ts`). |
| (b) Free holds at most 4 of 6 slots | `queue.freeSlotCap` (default 4, `freeCapMode: fixed`, boot refuses anything else) in `FairQueue.dequeue`; the capacity is `min(policy.global.runtime.maxLiveSessions, host maxSessions)`. Only plan `free` counts; `legacy` / `advanced` / `pro` use the other slots. | Test with capacity 6: 4 Free start, the 5th Free queues, legacy and pro start in the 2 reserved slots. |
| (c) queue when the Free share is full | `FairQueue` (rank, then fewer minutes today, then FIFO), 202 + polling (`Tbi-Queue: 1`), max wait, vanish, `queue_full`. | Covered by the test above. |
| (d) kill switch for new Free sessions | none | `free-admission.paused` file in the sim state directory, checked on every admission and at housekeeping. No restart. |
| (e) machine-readable "try again later" reason | `LimitCode` + `MESSAGE_KEY` + HE/EN server texts (`runtime/plans/messages.ts`), public body `{ error, limit: { code, messageKey, params } }`, app mapping `app/src/runtime/limits.ts` | New code `free_paused` -> `limit.sim.free_paused` (server HE/EN) and `sim.limit.free_paused` (app HE/EN), HTTP 429. |

## 2. Kill switch (d)

- Switch on: create `${TBI_HOST_SIM_PLANS_STATE}/free-admission.paused` (any entry type; content ignored),
  as the host user (the directory is 0700 and owned by the host user, checked at boot). Switch off:
  remove it. Effective on the next admission or housekeeping pass (default 5 s); no restart.
- While on: a new Free `POST /sessions` (join, poll or legacy client) answers 429
  `{ error: 'free_paused', limit: { code: 'free_paused', messageKey: 'limit.sim.free_paused', params: {} } }`
  with `Retry-After: 30` (a constant; the host cannot know when the pause ends); nothing is opened, queued
  or billed. A new Free join / legacy request is refused before the creation rate, so it costs no
  creation token (slice 2). This is no bypass: that path never calls the adapter and never starts
  anything; a pause that starts after the check is still refused by the adapter (the token is then
  taken, as before). Every request still passes the per-request anti-hammering rate. Waiting Free
  entries are removed (any admission that reaches the adapter and every housekeeping pass); their ticket
  answers `free_paused` on the next poll. Non-free plans are not affected and are never blocked behind a
  paused Free waiter.
- A ticket dropped by the pause keeps answering `free_paused` (429, `Retry-After: 30`) also after the
  pause ends: the host's ticket registry remembers why a ticket was dropped until it expires; it is never
  re-queued. The client starts a new wait with a new join (tested over HTTP).
- Operator lines (stderr, slice 2): `{"event":"sim_free_pause","paused":true|false}` once per transition
  (the initial off state is not logged) and `{"event":"sim_free_pause_error","code":"EACCES"}` once per
  distinct error code per process (an errno name or `unknown`; never the path or error text), so an
  accidental pause (permissions, a broken state directory) can be told from an intended one.
- `/health` on the health-only socket: with metering enabled, `capacity` carries the boolean
  `freePaused` next to `waiting` / `metered` (a throwing probe reads `true`). Flag-off the body is
  byte-identical (asserted in `runtime/host/tests/s3d6-health-boot.test.ts`). The API socket's `/health`
  has no `capacity` and is unchanged.
- Running Free runs are **not** stopped (they end by their lifetime cap, lease or minutes). Stopping
  running runs is a separate decision (open question Q3).
- Fail closed: any error other than "does not exist" when checking the path (EACCES, ENOTDIR, ...) counts
  as paused; a probe that throws or answers anything but `false` counts as paused. The path is checked
  with `lstat`: a symlink there (dangling or live) is paused, its target is never followed.
- Only with an enabled adapter (metering on). Without `TBI_HOST_SIM_PLANS_CONFIG` there is no Free plan
  on the host and the file is never read.
- Old apps: 429 with an unknown code maps to "busy" (try again later); the current app shows its own
  `sim.limit.free_paused` text.

## 3. Flags and defaults

No new environment variable. Everything is behind the existing opt-in `TBI_HOST_SIM_PLANS_CONFIG`
(unset = today's host, byte-identical answers; asserted by the existing flag-off tests). Inside it:
`metering.enabled` (default false), `queue.freeSlotCap` (default 4), host policy plan lifetimes (operator
policy file), the plan map, and the pause file (absent = off).

## 4. Failure modes

| Failure | Behaviour |
|---|---|
| pause path cannot be checked | paused (Free refused `free_paused`), paid unaffected; one `sim_free_pause_error` line per error code |
| meter / journal problem | existing rule: admissions 503 `system_unavailable`, running metered runs stop `sim_unavailable` |
| policy plan not mapped | boot refuses; at run time 503 `system_unavailable` (never unmetered; since slice 2 checked before the creation rate, so it costs no token) |
| host restart | waiting list, tickets and Free cooldowns are lost (known s3c limit); the pause file survives |

## 5. Not done (later slices)

- No Free policy plan or number is set anywhere: the Free lifetime value, the capacity (6) and who is
  Free are operator/owner config (`TBI_POLICY_FILE` + `TBI_HOST_SIM_PLAN_MAP`). Nothing enabled.
- App UI for the new message (rendering exists through `simLimitText`; no new screen) and an a11y review.
- Real Free/paid resolution from entitlements (O-1): today only the policy-name map.
- tbi-docs review of the HE/EN draft wording (marked NEEDS DOCS REVIEW).

## 6. Open owner questions

- Q1 The Free session lifetime value (the default policy lifetime is 30 min for every plan).
- Q2 Which principals are Free when this is enabled (default policy plan `free`, testers assigned
  `preview` -> `legacy`?), and the host capacity (6 needs `maxLiveSessions` and `maxSessions` of 6).
- Q3 Should the kill switch also stop running Free runs, or only new admissions (built: only new)?
- Q4 Should the pause also be reachable from the admin app later (today: a file on the host only)?
