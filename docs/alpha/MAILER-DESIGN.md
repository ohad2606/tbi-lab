# Mailer service (ARC-MAILER, owner directive D-ARC-2, Alpha Stage B): design note

Status: design plus a tested, **inert** first slice (`runtime/mailer/`, unit draft
`deploy/signup/tbi-mailer.service.in`). Nothing is wired into the admin service, built, packaged or installed.

## 1. Why

The admin service (`tbi-admin.service.in`) runs with `PrivateNetwork=yes`, `IPAddressDeny=any` and
`AF_UNIX` only, so it cannot reach the mail provider (Resend). The owner decided (D-ARC-2) to keep it that way and
add a separate minimal **mailer** process: the only one with mail egress and the only reader of the provider key
(`/etc/tbi-signup/resend.key`). The admin service only writes a queue entry; the mailer sends.

## 2. Queue entry (`runtime/mailer/queue.ts`)

One file per mail: `<key>.json`, `key = signup-approval-<request id>-g<generation>` (the request id is the
store's random id; `g1` is the first send, an explicit owner resend after a dead letter is `g2`, ... `g9`).
Content, schema v1, **exactly** these fields (anything extra is refused):

`{"v":1,"template":"signup-approval","id":"<id>","gen":1,"to":{"email","name","lang":"he"|"en"},"createdAt":<ms>}`

- **No secrets, no text, no sender, no URL** in the queue: the mailer renders the owner-approved template
  (`approvalEmail` in `runtime/admin/signup/email.ts`, HE + EN both owner-approved) with its own configured lab
  URL and sender. A compromised writer can at most cause an approved mail to an address of its choice, bounded
  by the abuse limits (section 6). The one writer value that reaches the body is the greeting name: only the
  first token of `to.name`, and only when it is a plain first name (`greetingName`: NFKC-normalized first, then a
  Unicode letter followed by letters and marks, joined by single hyphens/maqaf or apostrophes/geresh, at most 40
  characters, not starting with `www`, so a fullwidth `ｗｗｗ` is refused too; the normalized form is shown); anything
  with `:` `/` `@` `.`, digits or other symbols (a URL, a domain, an address) gets the generic greeting
  ("שלום," / "Hi,"). So the writer cannot put a link or an address into the text; it can choose one
  letters-only word in the greeting, nothing else. The same rule applies to the admin's direct sender.
- Values must already be canonical (address = `normalizeAddEmail`, name = `cleanText`); a value a sanitiser
  would change is refused, never repaired. Max 4096 bytes, UTF-8 (fatal decoding).
- **Atomic, never overwritten:** the writer creates `.tmp-<random>` exclusively (0640, fchmod), fsyncs, then
  `link()`s it to the final name (EEXIST = `already_queued`, the first entry is untouched) and removes the
  temporary name. The mailer ignores `.tmp-*` (removes ones older than 1 h) and skips a file whose link count
  is not 1 (writer mid-enqueue, or a planted hard link).
- Both sides validate with the same `parseQueueItem`; the writer validates the JSON round trip it writes.

## 3. Ownership and permissions

| Path | Mode, owner | Admin service | Mailer |
|---|---|---|---|
| `/var/lib/tbi-mail/queue` | 3730 `tbi-mailer:tbi-mailq` (setgid + sticky) | create files (group `wx`), cannot list; can remove only its own files (sticky) | lists, reads, removes (directory owner) |
| `/var/lib/tbi-mail/status` | 2750 `tbi-mailer:tbi-mailq` | read ledgers (later slice: show sent / failed) | writes ledgers 0640 (tmp + fsync + rename) |
| provider key | root 0400, via `LoadCredential` | none | `%d/resend.key` (its private credential copy) |

Queue files are 0640 `<admin uid>:tbi-mailq` (group inherited from the setgid directory); the mailer reads
them through its supplementary group `tbi-mailq` (`SupplementaryGroups=tbi-mailq` in its unit).

The mailer refuses to start when either directory is missing, a symlink, or accessible by others. It refuses
queue files that are not regular files (`O_NOFOLLOW`, fstat), are group-writable or other-accessible, larger
than the cap, or (with `TBI_MAILER_QUEUE_UID`) not owned by the admin user. An entry it cannot open or read
(EACCES, EMFILE, EIO ...) is an operator/host problem, not a content fault: it is kept, gets no ledger, and is
tried again next run (one log line per run with the errno classes). Once the running mailer has seen it
unreadable on every run for 24 h **and** its file mtime is older than 24 h, it is dead-lettered (ledger `dead`,
`stuck_unreadable`; the file is removed): it can never be sent without being read, so removing it cannot cause a
duplicate. Seen-stuck, not mtime alone: a valid old entry (the mailer was off for days, entries up to 7 days are
still sent) hit by a transient error (EMFILE, EIO) must not be lost on first sight. The seen-stuck time is in
memory only: a restart, or one successful read, starts the 24 h again (a later dead-letter, never an earlier
one). A directory with a key name is removed when empty, otherwise left alone for ever (never a recursive
delete of writer-controlled content; no ledger; one log line per run with the removed/kept counts).
`readSecretFile` keeps its rule (no other-access; the credential copy is 0400).

**Stuck entries never starve real mail.** Unreadable entries, non-empty directories and entries with an
unreadable ledger are skipped without using the listing cap: the 500-entry cap counts handled entries only (sent,
retried, dead, rejected, dropped; stuck dead-letters excluded), and at most 5000 names (`QUEUE_SCAN_MAX`) are
examined per run to bound the work. At 50 or more stuck entries in one run the mailer logs one `WARNING` line
(counts only).

## 4. systemd sandbox (`deploy/signup/tbi-mailer.service.in`, DRAFT)

Own user `tbi-mailer`, one supplementary group `tbi-mailq` (read the queue files); `ProtectSystem=strict` with `ReadWritePaths` = the two
directories only; `InaccessiblePaths` for the admin tree, the sign-up store, `/etc/tbi-signup`, the artifact
store, runtime and build state, `/run/@N@-admin`, `/run/@N@-runtime`, `/var/log/tbi-admin`; `ProtectHome`,
`PrivateTmp`, `PrivateDevices`, `PrivateIPC`, `RemoveIPC`, `KeyringMode=private`,
`ProtectProc=invisible`, `ProcSubset=pid`, kernel/cgroup/clock/hostname protection; `NoNewPrivileges`, empty
capability sets, `RestrictNamespaces`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter=@system-service
~@privileged @resources`, `MemoryMax=128M`, `TasksMax=16`, start-rate limit. Network: `IPAddressDeny=any`,
`IPAddressAllow=` the local DNS stub plus `@MAIL_EGRESS_ALLOW@`, `SocketBindDeny=any` (client only). `TBI_MAILER=0` in the unit: inert until
the deploy step sets it.

**Limitation (open question):** `IPAddressAllow` takes addresses, not host names, and the provider's API sits
behind changing addresses. Options: (a) ops maintains the provider's published ranges in the unit; (b) an
egress proxy with a host-name allowlist; (c) accept egress to any HTTPS address for this one user, relying on
TLS host verification. The draft assumes (a).

## 5. Failure handling and no duplicate send (`runtime/mailer/mailer.ts`)

Per entry the mailer keeps a ledger `status/<key>.json` (`sending | retry | sent | dead`, attempts, first/last
attempt, next attempt, error class; **no personal data**).

- The attempt (`sending`) is persisted **before** the provider call; if that write fails, nothing is sent.
- A `sent` or `dead` ledger turns a re-queued entry with the same key into a no-op (removed, logged `dropped`).
- Every attempt sends the provider idempotency key = the queue key. A crash mid-send leaves `sending`; the
  next run retries with the same key, which the provider de-duplicates. Retries are allowed only within **23 h**
  of the first attempt (provider window 24 h); after that the entry is dead (`window_expired`) instead of risking
  a second mail.
- Retried: network/timeout, 408, 429, 5xx, key problems the operator can fix (missing/unreadable/malformed key,
  401, 403). Backoff 1, 2, 4 ... min, cap 2 h, at most 10 attempts. Everything else (400, 404, 409, 413, 422 ...)
  is dead at once. An entry never attempted and older than 7 days is dead (`stale`).
- **Dead letter = the ledger** (status `dead` + reason), the queue file is removed. No second copy of personal
  data is kept: the pending sign-up record (with its retention) remains the only copy; the owner's explicit
  resend enqueues the next generation.
- Malformed entries are removed and, when the name is a valid key, recorded as `dead` with `rejected_<reason>`.
  An unreadable ledger (bad JSON or schema, not a regular file, a symlink, larger than 4096 bytes, any read
  error) fails closed: the entry stays, nothing is sent (one log line per run with the count). Once the
  running mailer has seen it unreadable for 24 h (as above, so a transiently unreadable `sent` ledger is not
  overwritten on first sight) and the ledger's mtime is older than 24 h, any attempt it may record is outside
  the 23 h retry window, so the entry could never be retried safely: it is dead-lettered
  (`stuck_ledger`; the unreadable ledger is replaced by a `dead` one, so a re-queue is a no-op) and the queue
  file is removed. The unreadable ledger may have been a `sent` one nobody could read, so `dead` here means
  "outcome unknown", not "never delivered": the mail is never re-sent. The queue file is removed only after
  the `dead` ledger write succeeded; if that write fails, the entry stays and one `WARNING` (no key, no
  address) is logged per failure, then the next run retries.
- **Ledger retention (not implemented, documented):** ledgers are never deleted. Deleting old `sent` ledgers
  would be safe against the provider window (23 h retries, 24 h de-duplication) but not against the queue-key
  no-op: nothing in this design guarantees that a key is never enqueued again after N days (an admin-side retry of
  an old approval would re-use `<template>-<id>-g<gen>`), and without the ledger such an entry would be sent a
  second time. Retention needs a PM/owner decision (e.g. tie it to the sign-up record retention, after which the
  request id cannot be enqueued). Until then the status directory grows by one small file per mail; the mailer
  refuses to start (`status_dir_over_cap`) when it holds more than 100000 names rather than silently skipping
  ledgers. A restart loop is the expected failure mode: the unit has `Restart=on-failure`, `RestartSec=10`, so
  the service would exit 1 and restart every ~10 s (until `StartLimitBurst` stops it). The unit therefore sets
  `RestartPreventExitStatus=78`: a refusal to start that restarting cannot fix (here the over-cap status
  directory) exits 78 and stays down for the operator to act on; the log line names the class code only.

## 6. Quiet hours and abuse limits

Nothing is sent during quiet hours (`quietHours.ts`, Asia/Jerusalem, default 23:00-08:00, DST-correct): entries
wait untouched and go out from 08:00. Limits on provider attempts: 10 per run (one run a minute), 20 per hour,
100 per day (`TBI_MAILER_MAX_PER_HOUR`, `_PER_DAY`); excess waits. At most 500 entries are handled
per run (oldest first; stuck entries excluded, section 3). Only the `signup-approval` template exists. At start
(`init`, idempotent: the counters start from zero) the hour/day counters are rebuilt from the ledgers so a restart
does not reset the caps. The rebuild **over-counts, never under-counts**: a ledger whose first attempt is inside
the last 24 h counts all its attempts (the first at `firstAttemptAt`, the others approximated at `lastAttemptAt`,
which can only make the hour cap stricter); one whose first attempt is older counts `attempts - 1` at
`lastAttemptAt` when that is inside the window. Each ledger counts at most the day cap and only the newest
day-cap timestamps are kept. Ledgers whose mtime is older than 24 h are not parsed (every attempt rewrites the
ledger, so its mtime is not older than its last attempt); the status directory listing is bounded (above). The
counters are in memory afterwards, so later runs do not re-read the ledgers.

## 7. Logging

Lines carry the key (random request id) and class codes only: `sent <key> (attempt n)`, `retry <key> (http_503,
...)`, `dead <key> (http_422)`, `rejected <key> (bad_name)`. Never an address, a name, the text, the key, the
provider URL or a path; an invalid file name is not logged at all. Errors from `fetch` are mapped to `network`
(their message can carry the URL/headers). Tests assert this on every path.

## 8. How the admin side enqueues (next slice, not done)

`SignupApprover` (`service.ts`) today calls `EmailSender.sendApproval` and treats success as `email_sent`. The
wiring slice adds a queue-backed sender: `enqueueMail(queueDir, {template, id, gen, to, createdAt})`, the
record becomes `email_queued` (not `email_sent`), and the admin reads `status/<key>.json` to move it to
`email_sent` / `email_failed` (Resend = next generation). The admin unit then needs `SupplementaryGroups=tbi-mailq`
and `ReadWritePaths=` the queue, `ReadOnlyPaths=` the status directory; it keeps `PrivateNetwork=yes`. That unit
change is a separate reviewed decision. The admin's own quiet-hours queueing becomes redundant (the mailer
enforces it); keep one place.

## 9. Rollout (Stage B)

1. This slice: code + tests + draft unit, inert. 2. Wiring slice (admin side, status read-back), ops review,
QA. 3. Package `mailer-service.mjs` (`runtime/mailer/main.ts`). 4. Staging: users, groups, directories, unit
with `TBI_MAILER=0`, then `=1` with a test key and a test recipient, only with owner approval. 5. Alpha in the
Stage B window, owner-approved; rollback = `TBI_MAILER=0` / stop the unit (entries simply wait; nothing is lost).

## 10. Not in scope

Provider account or key creation, sending real mail, any Alpha or staging change, changes to
`tbi-admin.service.in`, Stage A, HTML mail, attachments, other templates (Reject mail, owner alerts), bounce or
complaint webhooks, an exact persisted attempt counter, a dead-letter UI.
