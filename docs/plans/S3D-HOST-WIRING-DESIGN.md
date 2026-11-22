# TBI-018 slice s3d: Session Host wiring of sim metering and the fair queue (DESIGN)

Status: DESIGN ONLY (design go D-1420-2, 2026-11-22). No code changes in this slice. Metering stays
**off by default** after every slice below; switching it on in any deployment is a separate owner
approval. All plan numbers stay config defaults (DRAFT) in `runtime/plans/config.ts`; none is repeated
here.

Read with `docs/runtime/TBI-018-sim-host-integration.md` (s3c contract). Where that note and this design
differ, this design wins; the differences are:

- Admission runs in a new async host method (`admitCreate`), not in the HTTP handler.
- The heartbeat comes from a host timer (section 5), not from `lastActivity` or open streams.
- The principal is now required in `ended`, `cancel` and `touch` (the host always passes the session owner).

Decision labels: D-1420-2 is the PM go for this design; D-day0812-1 is the rule that a cap is billed at the
heartbeat that saw 0 minutes left (overshoot at most one beat interval).

An enabled adapter requires `config.policy` on the host: without a policy the host takes the plain
non-policy 429 `session limit` branch of `SessionHost.create`, which has no plan. Boot refuses an enabled
adapter without a policy.

## 1. What exists today (code read at `origin/co/main` e3f50d4)

| Piece | Where | State |
|---|---|---|
| Sim meter | `runtime/plans/simminutes.ts` `SimMeter.open/heartbeat/close/sweep/compact` | journal-backed, fail closed, throttled beat journal (`beatPersistMs`, default `leaseMs/3`) |
| Fair queue | `runtime/plans/queue.ts` `FairQueue` | memory only; one waiting entry per principal; cooldown memory only |
| Adapter | `runtime/plans/simhost.ts` `SimHostAdapter.admit/heartbeat/ended/housekeeping/cancel/touch` | one serial mutex; `{ metered: false }` for every call when `metering.enabled=false` |
| Answer mapping | `runtime/host/simAdmission.ts` `simAdmissionResponse`, `simRefusal` | exhaustive over `HostAdmit.decision` and `LimitCode`; not called by any route yet |
| Host hook | `runtime/host/config.ts` `HostConfig.simPlans` (type `Pick<SimHostAdapter,'enabled'>`); `runtime/host/host.ts` `SessionHost.constructor` throws for an enabled adapter | flag-off hook only |
| Host boot | `runtime/host/main.ts` | never constructs an adapter (no env var exists) |
| Session create | `runtime/host/host.ts` `SessionHost.create` (sync) -> `runtime/host/http.ts` `handle` (`POST /sessions`, 201) | legacy refusals via `runtime/policy/refusal.ts` `Refusal` / `sendRefusal` |
| Session id | `runtime/host/session.ts` `HostSession.id = randomBytes(16).toString('hex')` | generated inside the constructor; cannot be known before `create` |
| Terminal hook | `HostSession.fail` / `HostSession.end` -> `diagnoseEnd`; every terminal state is also an event in `HostSession.log` (`EventLog.subscribe`) | no plans hook |
| Lease | `SessionHost.housekeeping`: `streams === 0 && performance.now() - lastActivity > leaseMs` -> `terminate('lease_expired')`; `SessionHost.get` and `http.ts` `stream` refresh `lastActivity` | monotonic clock |
| App client | `app/src/runtime/client.ts` `RuntimeClient.create`: any status other than 201 throws; `runtime_capacity` / `memory_pressure` / `storage_pressure` -> `busy`, otherwise `statusCode(status)` | no 202, no polling |
| Assist wiring (reference) | `runtime/plans/boot.ts` `bootPlans` (`TBI_PLANS_CONFIG`), `runtime/assist/main.ts` exits non-zero on `PlansBootError`, `runtime/assist/service.ts` `limitResponse` body `{ error, limit: { code, messageKey, params }, message }` | live pattern to mirror |

## 2. Target flow of `POST /sessions` with an enabled adapter

The admission moves out of the synchronous `SessionHost.create` into an async host method
(`SessionHost.admitCreate`, name proposed) awaited by `http.ts` `handle`. With no adapter or a disabled
one the method calls today's `create` unchanged (byte-identical answers, tested).

Order (each step answers before the next runs; nothing is metered before step 7):

1. `closing` -> 503 `host shutting down` (unchanged).
2. `validateCreate` -> 400; `verifyTicket` (run ticket, principal, sha256) -> 403 `ticket invalid`
   (unchanged; re-checked on EVERY poll, so a run ticket that expires while waiting ends the wait with
   403 and the queue entry is cancelled).
3. Policy `session_quota` (own live sessions >= `plan.runtime.maxSessions`) -> legacy 429
   `session_quota` (kept: the host's own limit; `sim_concurrent` in the meter stays as the backstop for
   races and for meter sessions still open after a restart).
4. `checkResources` -> legacy 503 `storage_pressure` / `memory_pressure` (a starved host does not
   queue).
5. Queue ticket resolution (section 4): known ticket of this principal = poll; anything else = a new
   admission with a fresh server ticket.
6. Creation rate `rates.take(principal, 'session-create', ...)`: taken ONCE per new admission (step 5
   "new"), never on a poll. Deviation from today's "rate last" rule: a meter refusal after the rate was
   taken consumes one creation unit (decision O-6).
7. `adapter.admit({ ticket, sessionId, principal, plan, slots })` with
   - `sessionId`: generated by the host (`randomBytes(16).toString('hex')`, same format as today) BEFORE
     the call and handed to `HostSession` (new optional constructor argument; default unchanged);
   - `plan`: `planResolver(principal)` (section 6);
   - `slots`: `{ capacity: min(policy.maxLiveSessions, config.maxSessions), running: live.length }`
     (same numbers as today's `runtime_capacity` check, which is replaced by the queue when metered).
     `anyPaidUser` is not passed (host cannot know; only `freeCapMode: fixed` is supported in s3d; an
     enabled config with `liftUntilFirstPaid` refuses to boot).
8. `simAdmissionResponse(a)` and the answer table in section 3.

Adapter failure rule (ops review M1): `runtime/host/main.ts` has no `unhandledRejection` handler, so a
rejected adapter promise would crash the host. EVERY adapter call (`admit`, `heartbeat`, `ended`,
`housekeeping`, `cancel`, `touch`) goes through one host wrapper that catches throws and rejections:
- `admit` throws -> 503 `system_unavailable`, nothing starts, nothing is queued;
- `heartbeat` throws -> the run is stopped with `sim_unavailable` (section 5);
- `ended` / `housekeeping` / `cancel` throws -> one log line (no principal, no ticket), swallowed.
Test with an adapter whose every method throws and one whose every method rejects.
9. On `start`: lifetime clamp as today, `new HostSession(..., { id: sessionId })`, register, `prepare()`.
   If the constructor or `prepare()` throws, `adapter.ended(sessionId, 'ended', principal)` is awaited
   before answering 500 (bills the few ms the run existed; never a silent leak of a slot).
   If the HTTP client is gone before the answer is written (`res` closed while awaiting admit), the new
   session is terminated at once (`terminated`), so a lost request does not bill a whole lease.

## 3. Admission result -> HTTP answer

Body shape for every metered refusal mirrors assist (`runtime/assist/service.ts` `limitResponse`):
`{ error: <public LimitCode>, limit: { code, messageKey, params } }` from `simAdmission.ts`
`PublicLimit`. No server-rendered text on the host (the app renders the key; decision O-8). The internal
`cause` is logged only (`admissionEvent`-style one line, short principal ref, no other data).

| `simAdmissionResponse` | Queue-capable client (`Tbi-Queue: 1`) | Legacy client (no header) |
|---|---|---|
| `start` | 201 `{ sessionId, token, status, sim: { plan, remainingMs } }` (`sim` is additive) | 201, same body (extra field ignored by `RuntimeClient.create`) |
| `queued` | 202 `{ queued: { ticket, position, pollAfterS }, limit: <limit.sim.queue, n> }` + `Retry-After` | 503 `runtime_capacity` + `Retry-After` (today's code; app shows `busy`); the legacy request never creates or changes a queue entry (see below) |
| refused `minutes_out`, `minutes_out_free`, `sim_daily`, `sim_concurrent`, `sim_cooldown`, `queue_full`, `queue_timeout` (also `queue_vanished` shown as `queue_timeout`) | 429 + limit body; `sim_cooldown` also `Retry-After: n` | same 429 body; old app maps unknown 429 to `busy` (wrong reason, but no start; rollout gate R-2) |
| refused `system_unavailable`, malformed, enabled-but-`unmetered` | 503 `limit.system.unavailable` | same 503; old app shows `shutting_down` |
| refused `invalid_principal` / `invalid_request` / `invalid_state` / `lease_lost` | 403 / 400 / 409 / 409 with `limit.system.unavailable` (status from `simRefusal`) | same |

Legacy requests must not touch the queue (ops review M3): a request without `Tbi-Queue: 1` first peeks
whether its principal already has a waiting entry (a read-only adapter/registry check). If it has, the answer
is 503 `runtime_capacity` at once and the entry is left alone (a stale tab must not cancel or replace the
waiting tab's place). If it has none, `admit` is called and a `queued` result is cancelled in the same
serial step (never visible to other callers), then 503 `runtime_capacity`. The peek needs a small
read-only plans-layer method (name proposed: `hasWaiting(principal)`).

`unmetered` while the adapter reports `enabled` is a contradiction and fails closed to 503 (the
current `simAdmissionResponse` returns `{ kind: 'unmetered' }`; the host must not treat it as "start
unmetered"). Legacy refusal codes (`session_quota`, `rate_limited`, `storage_pressure`,
`memory_pressure`, `runtime_capacity` for legacy clients) keep their exact status, body and
`Retry-After` from `runtime/policy/refusal.ts`.

## 4. Client queue protocol

Opt-in by request header, so an old browser tab never receives a 202 it would treat as an error
(`RuntimeClient.create` throws for any non-201).

- Headers: `Tbi-Queue: 1` (the client understands 202) and, on a poll, `Tbi-Queue-Ticket: <ticket>`.
  NOT `X-Tbi-*`: the reverse proxy strips every `X-Tbi-*` request header (identity spoofing guard,
  `deploy/dev-lab/Caddyfile` `header_up -X-Tbi-*`). Never in the URL (tickets are capabilities, same
  rule as session tokens, D-S8-5).
- Poll = the same `POST /sessions` with the same body (the strict `validateCreate` body has no room for
  a ticket and stays unchanged; no body is stored server-side while waiting). Interval = `pollAfterS`
  (host config, default 15 s; boot refuses a value >= `queue.vanishMs`). Every poll is the waiter's
  sign of life (the adapter's `admit` already ticks with the caller as alive).
- Cancel: `DELETE /sessions/queue` with `Tbi-Queue-Ticket` -> `adapter.cancel(ticket, principal)` ->
  always 204 (a foreign or unknown ticket is indistinguishable). Routed before `host.get` (whose 32-hex
  id check would 404 it). The app sends it on Stop, on leaving the editor and on `pagehide`
  (best-effort; the vanish timeout covers the rest).
- Ticket registry (host memory, per process; ops review M2): `ticket -> { principal, state }` with states
  `waiting`, `started { sessionId }` (kept for `retainEndedMs`), `dropped { publicLimit }` (kept for
  `queue.maxWaitMs`). Tickets: `randomBytes(16)` base64url, server-generated only.
  - Entries are created only after the creation-rate step (section 2 step 6) succeeded and only for a
    `queued` or `start` result; a refused admission or a rate refusal creates none.
  - At most one `waiting` ticket per principal: a new one replaces the old (old becomes `dropped` with reason `replaced`; a poll with such a ticket gets 409 `queue_replaced` and never re-enqueues; new key `queue_replaced` is added to the s3d-5 message list).
  - TTL per entry: `queue.maxWaitMs + queue.vanishMs`; a global cap on entries with oldest-first eviction
    (cap is a host config value; an evicted ticket behaves as unknown). Tests: a flood of ticketless
    requests from many principals and from one principal never grows the registry past the cap.
  - Never log a ticket value (m9); tickets carry no identity and `Tbi-*` headers carry none either (m12).
  - Re-sending a `started` ticket works only inside the `retainEndedMs` window and only for the same
    principal (O-5).
  - poll with a `waiting` ticket of this principal -> `admit` with that ticket;
  - poll with a `dropped` ticket -> its error (`queue_timeout`), the entry is NOT recreated (otherwise
    the max wait would restart on every poll);
  - poll with a `started` ticket whose session is not terminal -> the same 201 again, with the same
    `sessionId` and token (idempotent answer for a lost response; decision O-5);
  - unknown ticket, foreign ticket, or no ticket -> a new admission with a fresh ticket (after a host
    restart every ticket is unknown: the waiter re-joins at the back; documented limit).
  - `dropped` entries returned by `admit` and `housekeeping` update the registry; nothing is pushed to
    the client (it learns on its next poll).
- Client gone (m2): the host checks `req.aborted` / `res.writableEnded` (and `res.destroyed`) after the
  awaited admit; a gone client's new session is terminated and its queue entry cancelled.
- `pagehide` cancel is best-effort (m10); the vanish timeout is the real guarantee.
- Request rate backstop (`requests.take(..., plan.requests)` in `handle`) counts polls like any request;
  a 15 s poll is far below it.

### Message keys needed (list only; texts by tbi-docs, HE and EN, in `app/src/i18n/messages.en.ts` / `messages.he.ts`)

Server keys that already exist in `runtime/plans/messages.ts` and are only rendered by the app:
`limit.sim.queue` (`{n}`), `limit.sim.queue_timeout`, `limit.sim.queue_full`, `limit.sim.cooldown`
(`{n}`), `limit.sim.concurrent`, `limit.sim.minutes_out` (`{date}`), `limit.sim.minutes_out_free`
(`{date}`), `limit.sim.daily`, `limit.system.unavailable`.

App keys to add (proposed names, following `assist.limit.*` and `sim.error.runtime.*`):

- `sim.limit.queue` / `sim.limit.queue_timeout` / `sim.limit.queue_full` / `sim.limit.cooldown` /
  `sim.limit.concurrent` / `sim.limit.minutes_out` / `sim.limit.minutes_out_free` / `sim.limit.daily` /
  `sim.limit.system_unavailable` (app copies of the server keys above);
- `sim.limit.minutes_out.nodate`, `sim.limit.minutes_out_free.nodate` (fallback when `{date}` is
  missing, as `assist.limit.ai.credits_out.nodate`);
- `sim.queue.cancel` (button), `sim.queue.waiting_label` (accessible name of the status region);
- `sim.error.runtime.sim_minutes` and `sim.error.runtime.sim_unavailable` (a running session stopped by
  the meter, section 5);
- `sim.limit.remaining` (`{minutes}`, minutes left shown after a start; optional, only if the usage
  display is in scope).

Not in s3d: `limit.sim.session_ending`, `limit.sim.session_ended`, `limit.sim.idle_ended`,
`limit.sim.free_peak` (planned in the requirements, no server code emits them yet).

Accessibility (app slice): queue position in one `role="status"` region (polite, no focus move),
announced on change only, not on every poll; one action (Cancel) as a normal button; numbers in Hebrew
text in `dir="ltr"` spans. a11y-reviewer sign-off required; no compliance claim.

## 5. Heartbeat, stop, end, settle

- Source: a host timer, not the client. Every `simBeatMs` (default `floor(leaseMs / 3)`, must be
  `< leaseMs`) the host calls `adapter.heartbeat(s.id, s.owner)` for each metered, non-terminal session
  whose HOST lease is alive (`s.streams > 0 || performance.now() - s.lastActivity <= leaseMs`, the
  condition `SessionHost.housekeeping` already uses). A session without a client gets no beat and is
  ended by the host lease as today; the meter then bills at most `lastBeat + leaseMs`. The principal
  passed is the session owner (sessions are owner-bound in `SessionHost.get`); there is no foreign caller
  on this path, so `decision: 'refused'` can only mean a host bug: logged, the run is NOT stopped (the
  adapter contract), metering for it continues to be decided by the lease. Bounded fail-open exposure
  (m1): while a beat is refused the run is unmetered beyond the last journaled beat, at most until its
  host lease ends (one `leaseMs`); the refusal count is logged.
- Timer: one per session, next beat at `min(simBeatMs, remainingMs)` (`remainingMs === null`: plan has
  no sim limit, beat every `simBeatMs`). The beat that sees 0 closes the meter session with `cap` (billed
  up to that beat, D-day0812-1) and answers `stop`.
- `stop` -> the host ends the run with a NEW end reason (protocol `EndReason`, decision O-3):
  `sim_minutes` for `minutes_out`, `minutes_out_free`, `sim_daily` (state event `detail` = the
  `PublicLimit`), `sim_unavailable` for `system_unavailable`, `lease_lost`, `invalid_state`. Old apps map
  an unknown end reason to `session_lost` (`app/src/runtime/controller.ts` `onEvent`), so they degrade,
  not break. A beat answer for a session that is already terminal is ignored.
- Resolver safety (m13): a `planResolver` throw or a principal with an unmapped plan answers 503
  `system_unavailable`; it is never treated as unmetered.
- Fail closed on a meter problem mid-run: `system_unavailable` stops every metered run at its next beat
  and refuses new admissions until the meter is reopened (decision O-4: explicit failure over unbilled
  runs). The owner also decides whether principals on unlimited (`legacy`) plans stop on a journal fault
  too (proposed: yes, same rule; the alternative is to let them run unbilled).
- End/settle: the host subscribes to `HostSession.log`; the first terminal `state` event calls
  `adapter.ended(id, closeReasonOf(reason), s.owner)` (`lease_expired` -> `lease`, `host_shutdown` ->
  `host`, everything else `ended`; same billing formula). `ok:false` is logged (one line, no principal);
  the run is over anyway and the meter sweep closes it at `lastBeat + leaseMs` at the latest. `ended` is
  idempotent (duplicate close), so a second terminal path cannot bill twice.
- Housekeeping: `adapter.housekeeping()` every `simHousekeepingMs` (default 5 s) from the host timer,
  never two at once (in-flight guard; the host timer runs every 250 ms and is synchronous). Its
  `dropped` go to the ticket registry; `pruned > 0` is logged as a count.
- Shutdown: `SessionHost.shutdown` already terminates every session with `host_shutdown`; it must also
  await the pending `ended` calls before `main.ts` `stop` exits the process. The wait is bounded (m3) to
  a value below the unit's `TimeoutStopSec`; on timeout it logs and exits (the meter sweep and boot
  recovery close what is left).
- Clocks: the meter uses the injected wall clock (`Clock`, `Date.now` in production), the host lease
  uses `performance.now()`. The beat interval (`leaseMs/3`) is the margin between them; a wall-clock
  step is the documented s3c limit (under-bills, never over-bills; m6: a forward step ends leases early,
  a backward step stalls billing until the clock catches up, bounded by the lease).

## 6. Plan resolution (host side)

The host has no entitlement source today: `PlansEngine.grant` (`runtime/plans/reserve.ts`) lives in the
assist process journal and no production code calls it. For s3d the host uses an injected
`planResolver(principal): PlanId` built from a mapping of host policy plan names
(`runtime/policy/policy.ts` `Policy.planName`, built-ins `preview`, `system`) to plans `PlanId`
(proposed: `preview -> legacy`, `system -> legacy`). Boot refuses a policy plan name without a mapping.
Real Free/Advanced/Pro resolution from entitlements is a later slice (decision O-1). The plan is fixed
at `start` for the whole run (adapter rule).

## 7. Crash / restart recovery

- Journal: `${TBI_HOST_SIM_PLANS_STATE}/sim-journal.log` (`JournalStore`, fsync per append), written by
  the host process only; never the assist journal. Boot takes an EXCLUSIVE lock on the state directory
  (ops review M4; a second host process refuses to start; `bootPlans` has none today) and refuses a
  directory not owned by the host user or with a mode other than 0700 (`mkdirSync` mode does not fix an
  existing directory). The synchronous fsync per append is a latency cost on the beat path: measure in
  staging before enabling (m4).
- Boot order (before `listen`): parse config -> `SimHostAdapter.open` (replays, then sweeps expired
  leases) -> NEW recovery step: close every meter session still open with reason `host`. This is safe
  because the host is the only writer and at boot no previous runtime survives (`main.ts`
  `stopTemplateInstances` for the systemd unit; direct children end with their bridge). Billing keeps
  `min(now, lastBeat + leaseMs)`: after a crash at most one lease past the last JOURNALED beat (s3c), and
  the principal is not blocked by `sim_concurrent` for a lease after a quick restart. Needs a small
  plans-layer method (`SimMeter.closeAllOpen('host')`, through the adapter).
- A torn tail or corrupt journal (`JournalStore.load` problem, `SimMeter.storeProblem`): the host
  REFUSES TO START (exit non-zero, one log line), like `bootPlans` for an unusable state. Recovery is an
  explicit operator action (a torn-tail repair tool built on `Store.recoverTornTail`; corruption in the
  middle is never repaired). The tool copies the journal first (timestamped copy, never overwritten) and
  is never run automatically: no production code calls `recoverTornTail` / `PlansEngine.recover` at boot
  today and the host must not add that. Decision O-7 (alternative: start and refuse every metered admission).
- Operator path on journal failure (M6): the fast path is rollback (unset `TBI_HOST_SIM_PLANS_CONFIG`,
  restart; section 10). The boot refusal uses a dedicated exit code and the systemd unit must not
  hot-loop on it (restart policy excludes that code, e.g. `RestartPreventExitStatus`). The repair tool
  must exist and be tested BEFORE metering is enabled anywhere (acceptance of s3d-6).
- Lost on restart (memory only, accepted in s3c): waiting list (clients re-join, section 4), ticket
  registry, Free cooldown. Optional: seed Free cooldowns from the journal (`closedAt` of the last Free
  session + `queue.freeCooldownMs`), decision O-9.
- Compaction: `SimMeter.compact()` is not called anywhere yet. Proposed: at boot after recovery when
  the journal exceeds a configured event count, never while sessions are open. It replaces the journal
  atomically and keeps no old copy itself, so the host first writes a timestamped `.pre-compact` copy
  that is never deleted automatically (M5). Journal retention (how long copies and old events are kept)
  is an owner decision (m11).

## 8. Races and idempotency

| Case | Behaviour |
|---|---|
| Double click / two tabs, same principal, both new | host `session_quota` check sees neither (both await admit); the adapter mutex serialises; queue holds one entry per principal; the second start is refused `sim_concurrent` by `SimMeter.open` |
| Two tabs both waiting | the newer ticket takes over the principal's single entry (`FairQueue.enqueueFresh`), keeping its place, and the older ticket is `dropped` in the registry; the older tab's next poll answers 409 `queue_replaced` (dropped reason `replaced`: it is waiting in another tab; no new admission, the entry is NOT taken back, so two tabs never swap it); at most one start, a second concurrent create is `sim_concurrent` / `session_quota` |
| Start answer lost, client polls again | `started` ticket -> same 201 (O-5); without it the orphan session ends by lease (bills at most one lease) |
| Client gone while admit is pending | session terminated before answering (section 2 step 9) |
| `ended` and a beat race | beat after `ended` answers `stop invalid_state` for a terminal session: ignored |
| `housekeeping` prunes a run the host still has | only when the meter lease ran out; the next beat answers `lease_lost` -> the run stops (`sim_unavailable`) |
| Poll after max wait | `dropped` ticket -> `queue_timeout`, entry not recreated |
| Foreign ticket in a header | treated as no ticket (new admission); nothing about the owner revealed |
| Run ticket expires while waiting | 403 on the poll, entry cancelled; the app re-obtains a run ticket through today's path |
| HostSession creation throws after `start` | `ended` awaited, 500; slot and meter session released |
| Host shutdown with waiters | waiters get 503 `host shutting down` on their next poll |
| Legacy request while its principal waits | 503 `runtime_capacity`, the waiting entry is untouched (section 3) |

## 9. Config flags (all new; unset = today's host)

| Flag | Meaning | Boot check (refuse to start on failure) |
|---|---|---|
| `TBI_HOST_SIM_PLANS_CONFIG` | path of a plans config (same strict `parseConfig`); unset: no adapter | must parse; `metering.enabled` must be true; `sim.leaseMs` must equal the host `leaseMs` (`TBI_HOST_LEASE_MS`); `queue.freeCapMode` must be `fixed`; the host must have `config.policy`; `sim.maxConcurrentPerPrincipal` must be 1 while any plan has minute caps (the host `session_quota` and the meter must agree; m5) |
| `TBI_HOST_SIM_PLANS_STATE` | journal directory | required when the config is set (no default under another service's state); exclusive lock, owner and mode 0700 (section 7) |
| `TBI_HOST_SIM_PLAN_MAP` | `preview=legacy,system=legacy` style map | every policy plan name mapped to a `PlanId` |
| `TBI_HOST_SIM_BEAT_MS` | beat interval, default `floor(leaseMs/3)` | `1 <= v < leaseMs` |
| `TBI_HOST_SIM_HOUSEKEEPING_MS` | adapter housekeeping, default 5000 | `>= housekeepingMs` |
| `TBI_HOST_SIM_POLL_S` | `pollAfterS` / `Retry-After` for 202, default 15 | `v * 1000 < queue.vanishMs` |

Separate variable names from assist's `TBI_PLANS_CONFIG` on purpose: a shared environment file must not
switch on both services at once. Until slice s3d-6 lands, `main.ts` refuses to start when
`TBI_HOST_SIM_PLANS_CONFIG` is set (the guard moves from the constructor to boot in s3d-3, so tests can
construct a wired host while no deployment can).

## 10. Rollout and rollback

- R-1 Every slice merges flag-off: no env var set = identical host (asserted by the flag-off tests in
  `runtime/host/tests/sim-plans-hook.test.ts`, extended to the HTTP layer). Identity includes (m7):
  `DELETE /sessions/queue` stays 404 and `Tbi-Queue*` headers are ignored.
- R-1b `/health` (m8) carries only coarse counts (`waiting`, `metered`) or, if finer, only behind
  authentication; never principals or tickets.
- R-2 The app with queue + limit handling (s3d-5) is deployed BEFORE metering is enabled anywhere; the
  legacy-client mapping only covers stale tabs.
- R-3 Enabling = owner approval: first staging (`tbi-s8`) with the pipeline lock, then Alpha in a
  maintenance window (setting the env needs a host restart, which ends live sessions). Initial map: every
  tester `legacy` (no monthly sim meter), so the visible change is the queue instead of "busy", the
  per-principal concurrency and the plan lifetime that already exists.
- Rollback: unset `TBI_HOST_SIM_PLANS_CONFIG`, restart the host (ends live sessions; maintenance
  window). The journal is kept, never deleted or edited; the app keeps working against a legacy host
  (it never receives 202). No data migration in either direction.

## 11. Test plan

Unit (vitest, `runtime/plans/tests`, `runtime/host/tests`, FakeClock, MemoryStore, no QEMU):

- boot: every refusal of section 9 (bad file, `enabled:false`, lease mismatch, unmapped plan, bad
  intervals, unusable or torn journal) exits with a message that carries no file content or principal;
- plan map parse; `closeAllOpen('host')` bills `min(now, lastBeat+lease)` and is idempotent;
- answer table of section 3, row by row, for both client kinds (extends `sim-admission.test.ts`);
- ticket registry state machine (waiting / started / dropped / unknown / foreign).

Host integration (`fakeHost` from `runtime/host/tests/support.ts`, fake runtime, real `createHttpServer`):

- flag-off: answers identical to a host without the hook, for create, refusals and capacity;
- capacity full -> 202 + position; slot freed -> poll starts; max wait (FakeClock) -> `queue_timeout`
  and no re-entry; vanished waiter dropped; cancel 204 for own, foreign and unknown tickets;
- legacy client: 503 `runtime_capacity`, nothing left in the queue;
- minutes used up during a run: stop at the beat that saw 0, end reason `sim_minutes`, billed = run
  time up to that beat; `remainingMs` timer fires without client traffic;
- lease expiry without client: billed at most `lastBeat + leaseMs`;
- every terminal path (`stop`, `DELETE`, `failNow`, lifetime, `account_disabled`, `host_shutdown`)
  calls `ended` once (journal has one `sim_close`);
- journal append failure mid-run: running sessions stop with `sim_unavailable`, new admissions 503,
  nothing starts;
- restart: reopen on the same journal closes open sessions with `host`; a queued ticket is unknown and
  re-joins;
- adapter failure (M1): an adapter whose methods throw or reject never crashes the host; admit -> 503,
  heartbeat -> stop `sim_unavailable`, ended / housekeeping -> logged and swallowed;
- registry (M2): ticketless flood, one waiting ticket per principal, TTL and global-cap eviction;
- legacy request with a waiting principal leaves the entry untouched (M3);
- second host process on the same state dir refuses to start; wrong dir owner/mode refuses (M4);
- compaction leaves a `.pre-compact` copy; repair tool copies first and is never called at boot (M5);
- resolver throw / unmapped plan -> 503 (m13);
- privacy: the journal and the log lines contain no address, token or ticket.

Runtime/QEMU: one smoke run with metering enabled on staging only, at enabling time, under the lock
(not part of s3d CI).

## 12. Slices (each at most one night; every one flag-off by default)

1. **s3d-1 boot and config (plans + host main).** `bootSimPlans(env, hostLeaseMs)` and the plan-map
   parser; `main.ts` reads the flags and refuses to start when they are set (still not wired).
   Acceptance: all section 9 boot checks unit-tested; no flag = `main.ts` path unchanged; typecheck,
   lint, plans + host unit suites green.
2. **s3d-2 host plumbing, no metering.** `HostSession` optional pre-generated id; async
   `SessionHost.admitCreate` that calls today's `create` when no enabled adapter; `http.ts` awaits it.
   Acceptance: existing host tests unchanged and green; new test: identical answers with/without a
   disabled adapter over HTTP.
3. **s3d-3a queue plumbing.** Ticket registry (M2 rules), `DELETE /sessions/queue`, `Tbi-Queue*` header
   parsing, `hasWaiting` peek. Acceptance: registry and cancel tests green; flag-off tests green.
   **s3d-3b admission over HTTP.** Steps 5-9 of section 2, the adapter wrapper (M1), answer table,
   legacy-client mapping; the enabled-adapter guard moves from the constructor to boot. Acceptance:
   section 11 admission cases green; flag-off tests green; ops review (public endpoint). Between 3b and
   s3d-4 a failed `HostSession` start still calls `ended` (step 9), but ended-on-every-terminal-path
   arrives only in s3d-4: running without it is acceptable only flag-off (nothing enabled until s3d-6).
4. **s3d-4 run lifecycle.** Beat timer, `remainingMs` stop, new end reasons, `ended` on every terminal
   path, adapter housekeeping, shutdown awaits `ended`. Acceptance: section 11 lifecycle, failure and
   billing cases green; exactly one `sim_close` per session.
5. **s3d-5 app client.** `RuntimeClient` sends `Tbi-Queue: 1`, handles 202 polling / cancel / limit
   bodies, new end reasons; HE + EN keys of section 4; `role="status"` UI. Acceptance: unit + e2e against
   a stub host; a11y-reviewer no blocker; tbi-docs texts reviewed. Harmless against today's host.
6. **s3d-6 recovery and readiness.** `closeAllOpen('host')` at boot, torn-journal refusal, compaction
   at boot, optional cooldown seed (O-9), counts only in `/health` capacity (`waiting`, `metered`),
   removal of the boot refusal (metering still needs the env, i.e. the owner), state-dir lock and mode
   check, `.pre-compact` copy, the torn-tail repair tool. Acceptance: restart and journal-problem tests
   green; repair tool exists and is tested; unit does not hot-loop on the refusal exit code; staging
   enabling checklist written (not executed).

## 13. Open owner / PM decisions

- O-1 Plan source for the host: policy-name map now (`preview`/`system` -> `legacy`), entitlements
  later? Which plan do principals without an assignment get once metering is on?
- O-2 When does billing start: at admission (proposed; the slot is held from `POST /sessions`, the
  app runs right after create) or at `POST /sessions/:id/run`?
- O-3 Protocol change: new end reasons `sim_minutes`, `sim_unavailable` (additive; old apps show
  "session lost").
- O-4 A meter/journal failure stops every running metered session (proposed, fail closed) instead of
  letting them run unbilled.
- O-5 Re-send the same session token for a repeated poll of a started ticket (proposed) or never
  (orphan run bills up to one lease).
- O-6 Creation rate taken once per admission, before the meter (a meter refusal consumes one unit).
- O-7 Torn or corrupt sim journal: refuse to start the host (proposed) or start with all Runs refused?
- O-8 Host returns keys only (proposed) or also server-rendered HE/EN text like assist?
- O-9 Seed Free cooldowns from the journal after a restart, or accept the s3c limit?
- O-10 Is enabling on staging (`tbi-s8`) part of the separate enabling approval (proposed) or a normal
  YELLOW staging test?
- O-11 `liftUntilFirstPaid` needs a host-side "any paid user" source; until then boot refuses it. OK?
