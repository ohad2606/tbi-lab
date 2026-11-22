# TBI-018 sim minutes and fair queue: Session Host integration (slice 3c)

Status: adapter built and tested; the Session Host is **not wired**. Metering stays off by default
(`metering.enabled=false`); nothing is activated. All plan numbers are config defaults (DRAFT).

## What exists after slice 3c

- `runtime/plans/simminutes.ts` `SimMeter`: per-principal sim minutes, journal-backed, fail closed.
- `runtime/plans/queue.ts` `FairQueue`: memory-only waiting list (plan rank, fewer minutes today, FIFO).
- `runtime/plans/simhost.ts` `SimHostAdapter`: the one object the host will call. Flag off: every call
  answers `{ metered: false }` and does nothing.
- `runtime/host/config.ts` `HostConfig.simPlans` + a guard in the `SessionHost` constructor: absent or
  disabled = unchanged host; an enabled adapter makes the constructor throw. Metering can therefore never
  look enabled while the host does not enforce it.

## Adapter contract (host side)

| Host moment | Call | Host action on the answer |
|---|---|---|
| `POST /sessions` (and every poll of a queued client, same `ticket`) | `admit({ ticket, sessionId, principal, plan, slots: { capacity, running } })` | `start`: create the session as today, arm a stop timer at `remainingMs`. `queued`: answer with `position` / `limit.sim.queue`, the client polls. `refused`: answer the `LimitError` (code + params), create nothing. |
| heartbeat: an attached stream or request renews the lease, plus the stop timer | `heartbeat(sessionId)` | `continue`: re-arm the stop timer at `remainingMs`. `stop`: end the run with the error (`minutes_out*`, `sim_daily`, `lease_lost`, `system_unavailable`). |
| session terminal (any reason) | `ended(sessionId, closeReasonOf(reason))` | Log `billedMs`; an error is logged, the run is over anyway. |
| housekeeping timer | `housekeeping()` | Tell the dropped waiters (`queue_timeout`, `queue_vanished`). |
| client cancels while queued / polls | `cancel(ticket)` / `touch(ticket)` | none |

Rules the adapter enforces (owner decisions 2026-11-22):

- Billing stops at the heartbeat that detected 0 left; the overshoot is at most one heartbeat interval
  (or the lease after a crash: billing never runs past `lastBeat + leaseMs`).
- The plan is fixed at session open: the run bills against the plan it was admitted with.
- Free slot cap counts plan `free` only. Legacy users rank with Advanced and are not under the Free cap.
- Every start goes through the queue, so a newcomer never jumps a waiting entry and a direct start obeys
  the Free re-queue cooldown.
- A user without minutes is refused before queueing.
- Running count = max(host count, sessions the adapter admitted that the host has not reported ended).
- Any store problem refuses (admit) or stops (heartbeat) with `system_unavailable`; nothing starts unmetered.
- Ticket operations check ownership: `admit` drops a queued entry on a refusal only when it belongs to
  `req.principal`; `cancel(ticket, principal)` and `touch(ticket, principal)` act only on the caller's own
  entry. Tickets must still be server-generated and unguessable (never a client-chosen identity).
- `admit` takes its own entry in one atomic queue step (`dequeue(slots, ticket)`, one clock reading), so
  another waiter is never removed on its behalf; if its own entry timed out at that moment it is refused
  with that drop's error (`queue_timeout` / `queue_vanished`).
- `housekeeping()` stops tracking runs whose meter session is closed or whose lease ran out (the host
  missed `ended`), so slot and Free-cap counts are not inflated; their Free cooldown starts at the prune.
  A later `ended` is a duplicate close (same bill, no second cooldown).

Limits of this slice (known, accepted for now):

- The Free cooldown, the waiting list and live-run tracking are memory-only: a host restart loses them
  (waiting clients must re-request; a Free user may start again without waiting out the cooldown). Billing
  itself is journaled and survives a restart.
- Host time must not go backwards. After a clock step back to before a run's open, its close is refused
  (`system_unavailable`: the close event would end before it was written) until time passes the open
  again; the housekeeping sweep then closes it at `lastBeat + leaseMs`. A step back to between the open
  and the last beat ends the bill at the earlier time (under-bills, never over-bills).

## Integration points still to change (next slice, needs PM go)

1. `SessionHost.create` is synchronous; the adapter is async. The admission must move into the async
   `POST /sessions` handler in `runtime/host/http.ts` (before `host.create`), or `create` becomes async.
   The session id must be known before `admit` (generate it first, then hand it to `HostSession`).
2. With metering on, the `runtime_capacity` refusal (`host.ts`, policy branch) and the plain
   `session limit` 429 are replaced by the queue answer. The app client (`app/src/runtime/client.ts`)
   must handle `queued` + polling in the same release (design note risk 5).
3. Plan resolution: map the host policy plan to a plans `PlanId` (`preview` -> `legacy`). Not decided
   in code yet.
4. Heartbeat source: `HostSession.lastActivity` / attached streams, plus a per-session stop timer at
   `remainingMs`; `ended` from the terminal transition (`session.ts` `end` / `fail`).
5. Boot: an opt-in env (like `TBI_PLANS_CONFIG` for assist) with its own sim journal, owned by the host
   process only. `sim.leaseMs` must equal the host `leaseMs`.
6. i18n texts for `limit.sim.*` already exist server-side (`runtime/plans/messages.ts`); app texts
   belong to the UI slice.

Out of scope: UI, payments, activation, staging.
