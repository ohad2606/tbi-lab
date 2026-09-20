# Gate D — Local-First Persistence

Feasibility experiment. **Not product code.**

## Question

Can a project be stored locally and restored reliably without depending on a server?

## Verdict: PASS

Evidence is a real browser, real IndexedDB, a real page reload, and a real browser restart.

## What is deliberately NOT here

No cloud synchronisation, no CRDT, no realtime collaboration, no authentication, no backend,
and no production repository abstraction. The sync-ready metadata fields are *designed* and
proven to round trip; **nothing acts on them**.

## State shape

| Field | Purpose |
|-------|---------|
| `projectId` | primary key |
| `schemaVersion` | migration hook for later |
| `localRevision` | bumped on every local write |
| `cloudRevision` | last revision known in the cloud — always `null` in Sprint 0 |
| `baseRevision` | revision the cloud copy derived from — always `null` in Sprint 0 |
| `updatedAt` | ISO-8601 UTC, asserted to round trip exactly |
| `deviceId` | stable per browser profile; proven stable across a browser restart |
| `name` | project name |
| `components[]` | id, type, value, nested `position` |
| `connections[]` | id, `from`/`to` endpoints, `net` |
| `psu` | `setpointV`, `currentLimitA`, `enabled` |

## Architecture

`local write -> user continues immediately -> (future) background sync`. `Autosave` debounces
and coalesces bursts; `queue()` returns synchronously so editing is never blocked by
persistence. Two IndexedDB object stores: `projects` (keyed by `projectId`) and `meta`
(holds `deviceId`).

## Acceptance evidence — `browser/persistence.spec.ts` (real Chromium)

**Test 1: create, autosave, reload, restore exactly**

1. create a minimal project (`localRevision` 1)
2. edit every part of the shape — 4 components, 4 connections, PSU to 3.3 V / 0.25 A / enabled
3. rename (`localRevision` 3), autosave flushes
4. assert the burst produced **fewer physical writes than edits** (debouncing is real)
5. **reload the page**
6. re-open the database and load: `expect(restored).toEqual(edited)` — a deep equality over
   the whole state, so a partial round trip cannot pass
7. assert every required field is present and `updatedAt` is exactly ISO-8601

Observed: `rev 3, 4 components, 4 connections, PSU 3.3 V / 0.25 A`.

**Test 2: close and reopen the browser**

A page reload keeps the same browser process, so it is the weaker claim. This test uses
`chromium.launchPersistentContext` against a temporary profile directory, writes the project,
**closes the browser entirely**, relaunches against the same profile, and asserts:

- the project is restored deeply equal, and
- `deviceId` is **the same value** — proving it is genuinely persisted rather than
  regenerated per session.

Observed: `restored rev 2 with stable deviceId 8eba27ed-...`.

## Supplemental fast tests — `tests/state.test.ts` (9 tests, `fake-indexeddb`)

Explicitly **not** the acceptance evidence: `fake-indexeddb` is in-memory and cannot prove
survival across a reload. They pin down semantics cheaply: revision bookkeeping, immutability
of prior state, store round trip, `deviceId` generated exactly once, and autosave coalescing
ten edits into one physical write.

## Defect found during bring-up

`setTimeout` stored as a plain field and later called as `this.schedule(...)` throws
`TypeError: Illegal invocation` in browsers — it loses its global receiver. The Node tests
would never have caught it. This is a small concrete instance of why Gate D's acceptance
evidence has to be a real browser.

## Running

```
npx vitest run experiments/gate-d-persistence   # supplemental fast tests
npm run test:browser                            # acceptance proof in Chromium
```
