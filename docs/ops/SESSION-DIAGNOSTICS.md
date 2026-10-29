# Session termination diagnostics (`session_end`, v1)

Sprint 14. Implementation: `runtime/host/diagnostics.ts`, called from `HostSession.fail()` /
`end()` in `runtime/host/session.ts`. Tests: `runtime/host/tests/diagnostics.test.ts`.

The Session Host writes **exactly one** JSON line when a session becomes terminal (`ended` or
`failed`), to its stderr, i.e. the journal of the `tbi-session-host` unit. It follows the
`admission` event precedent (`runtime/policy/refusal.ts`). Clients see nothing new: the event
stream and `/status` are unchanged.

```bash
journalctl -u tbi-session-host --since -1h -o cat | grep '^{"event":"session_end"'
```

Example (a stalled runtime):

```json
{"event":"session_end","v":1,"ref":"3f9a2c1e","who":"p_Ab3dE5gH","state":"failed","reason":"stalled","category":"stall","severity":"warning","from":"running","ran":true,"lifeMs":12034,"runMs":11950,"simMs":30,"outcome":"stalled","exitCode":null,"signal":"SIGKILL"}
```

## 1. Schema (v1)

| Field | Always | Meaning |
|---|---|---|
| `event` | yes | `"session_end"` |
| `v` | yes | schema version, `1`. Bumped whenever a field's meaning changes; new optional fields may be added without a bump, so consumers must ignore unknown fields. |
| `ref` | yes | first 8 hex characters of the session id. Correlates with the existing `session <id>: …` error lines (prefix match). Not a capability: the session token is never logged. |
| `who` | yes | first 10 characters of the opaque principal (`p_` + 8), as in `admission` events. Not reversible; no email or provider id. |
| `state` | yes | `ended` or `failed` (the state machine's terminal state). |
| `reason` | yes | the existing terminal reason code (`EndReason` / `FailReason`, `runtime/host/protocol.ts`), exactly what the client receives. `unknown` only if a value did not match `[a-z][a-z0-9_]{0,39}`. |
| `category` | yes | stable category, §2. A reason not in the table (a future one) is `unknown`. |
| `severity` | yes | `info`, `warning` or `error`, §2. `unknown` reasons are `warning`. |
| `from` | yes | the non-terminal state the session left for its terminal one: `creating`, `ready`, `running` or `stopping`. A running session that **ends** always passes through `stopping` (lifecycle rule), so ended sessions that ran show `stopping`; `failed` sessions that ran show `running` or `stopping` (failure after a stop was requested). |
| `ran` | yes | whether `run` ever started a runtime process. |
| `lifeMs` | yes | wall time from creation to terminal (integer ms, clamped to 0 … 2³¹−1). |
| `runMs` | if `ran` | wall time from `run` to terminal (integer ms, same clamp). |
| `simMs` | yes | simulation time reached (integer ms, floor). 0 when nothing ran. |
| `outcome` | if the runtime returned | the harness's classified end (`Outcome`, `runtime/harness/session.ts`): `completed`, `terminated`, `timeout`, `stalled`, `crashed`, `start_failed`, `start_timeout`, `protocol_error_runtime`, `protocol_error_host`, `peer_lost`, `host_error`, `guest_exit`. Absent when no runtime ran, and for `internal` from an exception in the host's run loop. |
| `exitCode` | with `outcome` | the runtime's exit status, or `null` (killed by a signal / never started). |
| `signal` | with `outcome` | the signal that ended the runtime (`SIG[A-Z0-9]+`), or `null`. **Not by itself evidence of a crash**: see §3. |
| `code` | `electrical_error` only | the engine's error code when it is a short `[a-z_]{1,40}` token (e.g. `psu_parallel`, `no_ground`, `unsupported_component`). Nothing else from the detail is copied. |

**Never logged:** tokens or token hashes, the full session id, cookies, request bodies, circuit
content or component ids, firmware or source, artifact hashes, paths, error messages, emails,
the terminal `detail` (except the electrical `code`). Every string is a closed set or checked
against a token pattern; every number is clamped.

**Bounded:** one line per session; at most `SESSION_END_MAX_LINE` = 512 characters (with
every field at its bound a line is under 380; a longer one would be replaced by a minimal
`{"event":"session_end","v":1,"truncated":true}`). Volume is therefore bounded by the session rate, which is
itself bounded by admission (`session-create` rate and quotas).

**Never affects a session:** the line is built and written after the terminal transition, its
state event and the release of its files; any exception (including from the sink) is
swallowed. A throwing sink is tested to leave state, events and cleanup identical.

## 2. Reason → category → severity

| Reason | State | Category | Severity | Evidence (what the code proves) |
|---|---|---|---|---|
| `stopped` | ended | `user_stop` | info | Only `HostSession.stop()` (HTTP `POST /stop`) leads here: from `ready`, or the runtime quit cleanly (`completed`) after the host sent `Q` because a stop was requested. The app calls `POST /stop` only from the user's Stop (`controller.stop()`). This is also the only "normal termination": a V1 session has no natural end of its own. |
| `terminated` | ended | `client_release` | info | Only HTTP `DELETE /sessions/:id` (`SessionHost.terminate` default). The app sends it when (a) the user stopped while the session was still being created, (b) `POST /stop` failed or the runtime did not reach `ended` within 10 s of a user Stop, (c) the page is closed (`pagehide`, keepalive), (d) the app itself failed the run (transport/command failure, `failAndRelease`). The host cannot tell these apart, so the category says only "the client released it", not "the user stopped". |
| `lease_expired` | ended | `disconnect` | info | Housekeeping: no attached event stream and no authenticated request for `leaseMs`. |
| `lifetime_exceeded` | ended | `timeout` | info | Harness `timeout`: the session's enforced lifetime (host, plan, client limit) expired; the harness killed the runtime (`signal: SIGKILL` is the host's own kill). |
| `host_shutdown` | ended | `host_shutdown` | info | `SessionHost.shutdown()` (service stop/restart). |
| `account_disabled` | ended | `client_release` | info | Sprint 23B: the access view no longer authorizes the session's account (`SessionHost.revokeUnauthorized`); see `docs/alpha/ADMIN-AND-FEEDBACK.md`. |
| `unsupported_feature` | failed | `user_content` | info | Firmware features from the build ticket, a capability the runtime does not announce, or a peripheral routed to a circuit pad. The user's firmware, not a host fault. |
| `invalid_attachment` | failed | `user_content` | info | A pad the board/simulator does not support, or the engine's `invalid_attachment`. |
| `electrical_error` | failed | `user_content` | info | The engine found no valid operating point, or the circuit has parts the runtime does not simulate / an I2C address conflict. `code` is attached. |
| `mirror_failed` | failed | `user_content` | info | The engine refused a live control value from the user's edit. (Should be rare since Sprint 11 validates at submit; see open question 2.) |
| `artifact_unknown` | failed | `artifact_integrity` | warning | No `<sha256>.bin` in the store although a valid run ticket named it (e.g. swept by retention). |
| `artifact_hash_mismatch` | failed | `artifact_integrity` | error | The stored file, or the session's private copy, does not hash to its name: corruption. |
| `artifact_missing` | failed | `artifact_integrity` | error | The artifact exists but could not be read. |
| `start_failed` | failed | `startup` | error | Harness `start_failed`: the runtime exited before the bridge handshake, or could not be launched (launcher threw; the message goes only to the existing `console.error` line). |
| `start_timeout` | failed | `startup` | error | Harness `start_timeout`: no handshake within `startupTimeoutMs`; the harness killed it. |
| `stalled` | failed | `stall` | warning | Harness `stalled`: < 1 ms of simulation progress in `stallTimeoutMs` after the handshake while the host owed nothing; **the harness killed it** (`SIGKILL` is the host's). Known cause: firmware the mask ROM rejects (virtual time freezes) — so one stall is not proven to be a host fault; a burst is. |
| `runtime_crashed` | failed | `crash` | error | Harness `crashed`: the runtime ended by a signal **the session did not send** (`killedBySession` false). In deployment this includes signals from the runtime unit's sandbox, not only QEMU bugs: the cgroup OOM killer at `MemoryMax=384M` (SIGKILL), a refused fork at `TasksMax` (observed SIGTRAP, 2026-10-05), seccomp (SIGSYS), `RuntimeMaxSec` (SIGTERM). `signal` tells them apart only partially; the unit's journal has the rest. |
| `runtime_protocol_error` | failed | `protocol` | error | QEMU's bridge rejected the host's reply (exit status 3). |
| `host_protocol_error` | failed | `protocol` | error | The host rejected a frame from QEMU (malformed, time going backwards); the harness killed it. |
| `bridge_lost` | failed | `protocol` | error | QEMU lost the bridge connection (exit status 4). |
| `guest_reset` | failed | `runtime_exit` | warning | Harness `guest_exit`: the runtime exited **on its own** after the handshake, with a status other than 3/4, without a quit request. The harness names the typical cause (the firmware requested a reset), but an exit status does not prove it; hence a neutral category. `exitCode` is included. |
| `storage_limit` | failed | `resource_exhaustion` | warning | The session directory exceeded `maxSessionStorageBytes` (at creation, or housekeeping while running; then `outcome: terminated` is the host's own termination). |
| `internal` | failed | `internal` | error | A host-side fault. Distinguish by `outcome`: absent = an exception escaped the host's run loop (message in the `session <id>: internal:` line); `host_error` = a bridge handler threw (harness killed it); `terminated` = the runtime did not exit within `quitGraceMs` after a quit request and **the harness killed it** (`SIGKILL` is the host's). |
| *(anything else)* | either | `unknown` | warning | Fallback for a reason added later without a table row; never thrown. |

Severity rule: `info` = expected outcome of the user's or operator's action, or of the user's
own project; `warning` = abnormal for one session but not proven to be a host fault, or a
host-enforced limit; `error` = a host, runtime or store fault.

## 3. SIGKILL and other signals

`signal` reports how the runtime process ended, not who decided it. The harness kills the
runtime itself (SIGKILL, or SIGTERM then SIGKILL after `killGraceMs`) for: termination requests
(`terminated`, `lease_expired`, `host_shutdown`, `storage_limit` while running), the lifetime
(`timeout`), stalls, start timeouts, host protocol errors, handler errors, and an expired quit
grace. Only `outcome: crashed` (reason `runtime_crashed`) records that the signal was **not**
sent by the session. So a `SIGKILL` in a systemd/journal line for `tbi-qemu@…` is not evidence
that a session was stuck: the `session_end` line's `category` is.

The harness result does not carry a separate "killed by host" flag; the table above derives it
from the outcome (each of those outcomes is set only on the paths that call `kill`). No harness
change was made.

## 4. Retention and access

- Destination: stderr of the Session Host process, collected by journald for the
  `tbi-session-host` unit (dev-lab/alpha; `tbi-s8-session-host` on staging). No new file, socket
  or service.
- Readable by root and members of `adm` / `systemd-journal`, like every other line of that unit.
- Retention: the host's journald configuration (unchanged by this work).
- Volume: one line (≤ 512 B) per session, bounded by session admission.

## 5. PROPOSAL (not applied): alerter classification

The current alerter infers "probably stuck" from systemd SIGKILL lines of `tbi-qemu@…`. That
heuristic counts the host's own kills (stop, lease, lifetime, shutdown, stall) as incidents.
Proposed, for PM/ops decision — nothing in `tbi-alertd` was changed:

| Class | Categories | Proposed rule |
|---|---|---|
| Alert immediately | `artifact_integrity` with severity `error`, `internal`, `protocol` | Each one is a host/runtime/store defect; page on the first. |
| Alert on rate | `crash`, `startup` | Page if ≥ 2 in 15 min (or ≥ 1 if `signal` is `SIGKILL` with `outcome: crashed`, which in deployment most likely means the unit's memory limit). |
| Warning (digest / rate) | `stall`, `runtime_exit`, `resource_exhaustion`, `artifact_unknown`, `unknown` | Daily digest; alert if ≥ 3 in 15 min across users (a single user's firmware can explain one; many users cannot). `unknown` also means the alerter's table is out of date. |
| Informational | `user_stop`, `client_release`, `disconnect`, `timeout`, `host_shutdown`, `user_content` | Counts only (usage, how sessions end). `host_shutdown` outside a deploy window is worth a look. A spike of `disconnect` may indicate gate/proxy trouble. |

The alerter should key on `event`, `v`, `category` and `severity`, ignore unknown fields, and
treat an unknown `v` as "schema changed: review".
