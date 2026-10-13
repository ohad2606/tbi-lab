# Persistence and recovery audit (overnight, 2026-10-13)

**Method.** A read-only review of `app/src/persistence`, `app/src/state/app.ts` and `packages/domain` (package, migrate, validate, route repair). Every finding below was confirmed by a test that **failed before the fix**.

**Status:** fixed and tested locally; **not deployed**.

## Verified sound (existing tests)

| Area | Behaviour |
|---|---|
| Atomicity | Document and index are written in one IndexedDB transaction; programs are part of the document. Rename, duplicate, import and delete are each one atomic operation |
| Import strictness | Size, version (newer refused), integrity hash, exact key sets, prototype keys, duplicate ids, dangling references and netlist mismatches are all refused. An id collision becomes a copy, even under a race |
| Round trip | Program text (whitespace, CRLF, Unicode) and canonical `{value, unit}` quantities round-trip exactly (`package.test.ts`, `programs-v3.test.ts`, A5) |
| Newer schema | Read-only; never written back |
| Unload | Flush on `visibilitychange`, `pagehide` and `beforeunload`, with a prompt when unsaved |

## Findings and outcomes

| ID | Finding (verified) | Fix | Test |
|---|---|---|---|
| **H2** | One autosave slot for all projects: after project A's write failed, the first change to project B replaced A's unsaved document, and B's successful write cleared the error. A's edits were lost silently | Pending documents are kept **per project**; "saved" only when nothing is pending (`12860d1`) | `autosave.test.ts`: 3 cross-project cases |
| **H1** | Two tabs on one project: unconditional `put`, so the last writer silently discarded the other tab's work, and a tab could **resurrect** a project deleted in another tab | A save succeeds only over the exact stored version the tab opened or last wrote, checked inside the same transaction. Otherwise nothing is written, a conflict notice appears (EN/HE) with Reload, and **Export keeps this tab's version** (`7490778`) | `s13-multitab.test.ts`: store-level, overwrite, delete, single-tab |
| **M2** | A failed delete also discarded the open project's pending edits | They are queued again on failure (`074a936`) | `library.test.ts` |
| **H3** | Open-time route repair (e.g. OS-05) rewrote and saved stored routes silently and permanently (no notice, no undo; connections never touched) | A recorded edit with an info notice; one Undo restores the stored routes (`75f38b6`) | `s13-open-repair.test.ts` |
| H4 | Migrating an old schema (v2→v3, pre-Sprint 7) overwrites the original without a copy | **Documented** (residual): alpha testers start fresh, and only pre-Sprint 7 projects are affected. Recommend: before the alpha, the owner exports any old dev-lab projects | — |
| M1 | Flush on `pagehide` is asynchronous; a torn-down page (mobile, or a hard close without the prompt) can lose up to the 300 ms debounce plus any write in flight | **Documented** (desktop-only product; graceful restart is covered by e2e A7) | — |
| M3 | A newer-schema project can be deleted but not exported as a rescue copy | **Documented** (low) | — |

**Regression caught by the final CI, fixed.** The H1 fix (`7490778`) moved the write into the version check's IndexedDB callback. There, a `QuotaExceededError` escaped as an uncaught exception, and the save failed as a generic abort: the user saw "Could not save" instead of "storage is full". The e2e `sprint5` A12 caught it in the full run on `d5c03a6`. Fixed in `c3b148b`: the failing write's own error is kept. The unit test fails before the fix (`AbortError`) and passes after.

**No canonical project format change and no migration** were needed. All fixes are in the app's
persistence layer and are additive.
