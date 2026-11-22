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
  by the abuse limits (section 6); it cannot choose words or links.
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

The mailer refuses to start when either directory is missing, a symlink, or accessible by others. It refuses
queue files that are not regular files (`O_NOFOLLOW`, fstat), are group-writable or other-accessible, larger
than the cap, or (with `TBI_MAILER_QUEUE_UID`) not owned by the admin user. `readSecretFile` keeps its rule
(no other-access; the credential copy is 0400).

## 4. systemd sandbox (`deploy/signup/tbi-mailer.service.in`, DRAFT)

Own user `tbi-mailer`, no supplementary groups; `ProtectSystem=strict` with `ReadWritePaths` = the two
directories only; `InaccessiblePaths` for the admin tree, the sign-up store, `/etc/tbi-signup`, the artifact
store, runtime and build state; `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `PrivateIPC`,
`ProtectProc=invisible`, `ProcSubset=pid`, kernel/cgroup/clock/hostname protection; `NoNewPrivileges`, empty
capability sets, `RestrictNamespaces`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter=@system-service
~@privileged @resources`, `MemoryMax=128M`, `TasksMax=16`, start-rate limit. Network: `IPAddressDeny=any`,
`IPAddressAllow=` the local DNS stub plus `@MAIL_EGRESS_ALLOW@`. `TBI_MAILER=0` in the unit: inert until
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
  An unreadable ledger fails closed: the entry stays, nothing is sent.

## 6. Quiet hours and abuse limits

Nothing is sent during quiet hours (`quietHours.ts`, Asia/Jerusalem, default 23:00-08:00, DST-correct): entries
wait untouched and go out from 08:00. Limits on provider attempts: 10 per run (one run a minute), 20 per hour,
100 per day (`TBI_MAILER_MAX_PER_HOUR`, `_PER_DAY`); excess waits. The queue listing is capped at 500 (oldest
first). Only the `signup-approval` template exists. The counters are per process (a restart resets them; the
systemd start-rate limit bounds restarts); a persisted counter is a follow-up if the review wants it.

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
complaint webhooks, persisted rate counters, a dead-letter UI.
