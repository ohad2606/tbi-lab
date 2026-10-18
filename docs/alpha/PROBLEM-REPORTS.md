# In-app problem reports (Sprint 14)

**Status: built, OFF by default.** Nothing changes on a deployment until BOTH switches are set:
the app build flag `VITE_PROBLEM_REPORTS=1` (shows the menu item) and the Session Host's
`TBI_REPORTS_DIR` (stores reports). Either one alone is harmless: without the flag nobody sees the
action; without the directory the endpoint answers 503 and the dialog says "Reports cannot be
received right now" while keeping the tester's text.

The older external feedback form (`FEEDBACK-FORM.md`, `VITE_FEEDBACK_URL`) is separate and
unchanged.

## What the tester sees

Editor → application menu (☰) → **Report a problem…** (Hebrew: **דיווח על בעיה…**), the item just
above Sign out. The menu was chosen over a top-bar button: the top bar is width-constrained
(Run/Build/history must fit, `uxp1-toolbar-fit.spec.ts`), and the menu already holds the other
app-level actions (feedback form, capabilities, sign out). It is fully keyboard reachable
(focus the menu button, ArrowDown, End, ArrowUp, Enter).

The dialog asks for:

- **What happened?** free text, up to 1000 characters, with a visible counter (`123 / 1000`); the
  text box is `dir="auto"` (the tester's own words, any language and direction, never translated);
- **Area**: Simulation / Build / Editor / Something else (required);
- **This stops me from continuing** (optional checkbox).

Keyboard: the text box has focus on open, Tab and Shift+Tab stay inside the dialog, Escape closes
it (except while a report is being sent), and focus returns to the menu button. The draft is kept
when the dialog is closed without sending. "Sending…" is announced in a status region; the
confirmation with the report id appears **only after the server answered 201**, i.e. after the
report is on disk. On any failure the text and choices stay and the error (role `alert`) says what
to do: try again later (503), wait N minutes (429), sign in again (401), or retry (no answer).

### Disclosure text shown in the dialog

English:

> **What is sent**
> Your description, the area and whether it blocks you; the app version and interface language;
> the status of the current simulation, if any; your browser name, version and operating system.
> The report is linked to the account you signed in with.
> Your project, circuit, code and screenshots are not sent. Please do not include personal
> information.
> Reports are deleted after at most 90 days.

Hebrew:

> **מה נשלח**
> התיאור שלכם, התחום והאם הבעיה חוסמת אתכם; גרסת האפליקציה ושפת הממשק; מצב הסימולציה הנוכחית,
> אם יש; שם הדפדפן, הגרסה שלו ומערכת ההפעלה. הדיווח מקושר לחשבון שאיתו נכנסתם.
> הפרויקט, המעגל, הקוד וצילומי מסך אינם נשלחים. נא לא לכלול מידע אישי.
> הדיווחים נמחקים לאחר 90 יום לכל היותר.

If the retention is changed (`TBI_REPORTS_RETENTION_DAYS`), change `report.disclosure.retention`
in both message bundles in the same release.

## What is collected, and why

One JSON file per report (`<id>.json`):

| Field | Source | Why |
|---|---|---|
| `id` | host: 60 random bits, Crockford base32, `7K3M-9QX2-WDAB` | shown to the tester to quote when following up; unguessable |
| `receivedAt` | host clock | ordering, retention |
| `principal` | **the gate only** (opaque HMAC of the Google subject; no email) | group a tester's reports; honour a deletion request; abuse limits |
| `category`, `blocking`, `description` | the tester | the report itself; description NFC-normalized, control characters removed (tab and newline kept), otherwise exactly as written |
| `locale`, `view` | app, validated (`en`/`he`…, `home`/`editor`) | which language and screen the problem was seen in |
| `app` `{version, commit}` | app build identity, validated format | which frontend build (informational, client-stated) |
| `release` `{version, commit}` | the Session Host's own stamped build identity (`/health`'s `runtime`) | authoritative backend version; `null` on an unstamped build |
| `browser` `{family, major, os}` | host, derived from `User-Agent` | e.g. `Chrome 141 / Linux`; the User-Agent string itself is never stored or logged |
| `session` | host, from the session's **authoritative** status, only if the session id the app sent is the reporter's OWN session still known to the host | `state`, terminal `reason`, runtime `outcome`, `ageS`, `endedAgoS`, `simS` (simulated seconds); `null` otherwise |
| `appSim` `{status, code?}` | app, validated enums/codes | what the app showed (kept apart from `session`, labelled client-reported) |

The host keeps an ended session's status for `TBI_HOST_RETAIN_ENDED_MS` (60 s by default), so a
report sent minutes after a failure has `session: null`; `appSim` still records the failure code
the app showed.

**Never collected:** project, circuit, component ids, firmware/source code, serial output,
screenshots, file names, email addresses, IP addresses, the full User-Agent, cookies or tokens.
A request naming any field other than those above (e.g. `principal`, `who`, `owner`, `session`,
`release`) is refused with 400; identity headers a client sends are removed by the gate.

## Endpoint contract

`POST /runtime/reports` (Caddy `handle_path /runtime/*` → Session Host `POST /reports`, behind
oauth2-proxy: **no Caddy change**). Body `application/json`, at most 8 KiB.

```json
{ "description": "…", "category": "simulation|build|editor|other", "blocking": false,
  "locale": "en", "view": "editor",
  "app": { "version": "0.14.0", "commit": "<40 hex>" },        // optional
  "sessionId": "<32 hex>",                                      // optional
  "sim": { "status": "stopped|starting|running|stopping|failed", "code": "runtime_crashed" } }  // optional
```

| Answer | When |
|---|---|
| `201 {"id":"7K3M-9QX2-WDAB"}` | durably stored (identical whether or not a session was associated) |
| `400 {"error":…}` | malformed JSON, unknown field, invalid value, empty or > 1000 code points |
| `401` | no gate identity |
| `413` / `415` | body over 8 KiB / not JSON |
| `429 {"error":"rate_limited","retryAfterS":N}` + `Retry-After` | 5 per 10 min or 20 per day per tester; 200 per hour for everyone |
| `503 {"error":"reports_disabled"}` | `TBI_REPORTS_DIR` unset |
| `503 {"error":"storage_pressure"}` | store full (`TBI_REPORTS_MAX`) or any write/fsync error; nothing is left on disk |

Rate windows are in memory (a host restart resets them; the store's count limit still bounds the
disk). The per-request anti-hammering limit of the policy applies before all of this.

## Storage and permissions

- Directory `TBI_REPORTS_DIR` (absolute). The host creates it `0700` (and removes group/other access
  if it finds any); files are created `0600`, owned by the Session Host user (`tbi-runtime`).
- Write path: `.<id>.tmp` opened `O_CREAT|O_EXCL` → write → `fsync` → `rename` to `<id>.json` →
  `fsync` the directory → only then 201. Any failure removes the temporary/final file and answers
  503, so a 503 never leaves a report behind and a retry never duplicates one.
- Bounded: at most `TBI_REPORTS_MAX` (default 2000) files of at most ~10 KiB each. The cap is
  soft: concurrent submissions can exceed it by a report or two, never more.
- Proposed location: `/var/lib/tbi-runtime/state/reports` — inside the host's existing
  `StateDirectory` (`tbi-runtime/state`, already writable under `ProtectSystem=strict`), so the
  unit needs only the environment line (already in `deploy/dev-lab/s8/tbi-session-host.service.in`,
  commented out).

## Retention and deletion

- Housekeeping in the Session Host deletes reports whose `receivedAt` is older than
  `TBI_REPORTS_RETENTION_DAYS` (default 90) at start and every 6 hours, plus temporary files of
  interrupted writes older than an hour.
- Operator CLI, runs as root on the directory alone (no Session Host, no Telegram, no network):

```sh
sudo node scripts/problem-reports.mjs list                     # id, time, area, blocking, who (10 chars), version, session state, length
sudo node scripts/problem-reports.mjs show 7K3M-9QX2-WDAB      # the full JSON, description included
sudo node scripts/problem-reports.mjs delete 7K3M-9QX2-WDAB
sudo node scripts/problem-reports.mjs delete-principal p_…     # every report of one tester
sudo node scripts/problem-reports.mjs purge-older 30           # by receivedAt
# --dir DIR, else $TBI_REPORTS_DIR, else /var/lib/tbi-runtime/state/reports
```

  `list` never prints descriptions. A tester's principal for `delete-principal` is the `principal`
  field of any of their reports (or derived from their Google subject with the identity key).

## Notification line (for the owner's ops alerter)

After a report is durably stored the host writes ONE line to stderr (journald, unit
`tbi-session-host`):

```json
{"event":"problem_report","v":1,"id":"7K3M-9QX2-WDAB","category":"simulation","blocking":true,"release":"0.14.0","app":"0.14.0","at":"2026-10-15T20:31:07.412Z"}
```

`release`/`app` are `null` when unknown. The line carries **no description, no principal, no email**:
it is meant to be forwarded to a third-party messenger (Telegram) by the alerter, outside this
repository; the owner then reads the report with `show <id>`. The usual admission line
(`{"event":"admission","service":"runtime","action":"report","outcome":"admitted","who":"p_xxxxxxxx"}`)
is logged beside it for abuse analysis and is not meant to be forwarded. The Session Host holds no
messaging token; a broken alerter or journald can never turn an accepted report into an error
(the emission is contained; tested). A storage failure logs
`problem report storage error: <errno code>`.

## Deployment (later, through the normal release gate)

1. Session Host bundle from this branch (no new dependency). Enable with a unit drop-in, e.g.
   `/etc/systemd/system/tbi-session-host.service.d/reports.conf`:
   `[Service]` / `Environment=TBI_REPORTS_DIR=/var/lib/tbi-runtime/state/reports`
   (optional `TBI_REPORTS_RETENTION_DAYS`, `TBI_REPORTS_MAX`), `daemon-reload`, restart in a quiet
   window (a restart ends live sessions).
2. Frontend: the release package built with the `rc4-reports` profile
   (`deploy/release/build-package.sh deploy/release/rc4-reports.release.json <ref> …`, RC4
   packaging gate: the switch is pinned in the profile, never inherited from the shell), and check
   the menu item appears.
3. Verify: send a report from the app; `list` shows it; `stat` shows `0700`/`0600` owned by
   `tbi-runtime`; journald shows one `problem_report` line.
4. Point the ops alerter at `event == "problem_report"` lines.

**Rollback:** rebuild the frontend without the flag (the item disappears) and/or remove the drop-in
and restart the host (503, nothing written). Stored reports stay until deleted with the CLI.
Housekeeping runs only while the host has `TBI_REPORTS_DIR`: after removing the drop-in (or rolling
back to RC3) nothing purges the directory any more, so the testers' 90-day promise
(`report.disclosure.retention`) is kept only by the operator. Either delete the directory once its
reports have been read, or run `problem-reports.mjs purge-older 90` daily (e.g. a root cron entry)
until it is empty. The same applies if `TBI_REPORTS_RETENTION_DAYS` is raised: the tester text
says 90 days and must be changed with it.

## Tests

- `runtime/host/tests/reports.test.ts`: 401, feature off (503), durable 0600/0700 storage,
  notification line content, failing log writer still 201, forged body fields and spoofed headers,
  cross-user session association (identical answers), 413/415/400, description cap and cleaning,
  per-user/daily/global rate limits (429 + Retry-After, no file), unwritable directory and fsync
  failures (503, nothing left), full store, retention purge, CLI operations, UA parsing, env
  configuration.
- `app/tests/problem-report.test.ts`: validation, counter, request content, answer mapping,
  dialog transitions.
- `app/e2e/s14-report-problem.spec.ts` (EN and HE): hidden without the flag, keyboard open, focus
  trap, Escape and focus return, counter and validation, confirmation only after the server
  stored the report, error keeps the text and retry works, RTL layout.

## Not built (by design)

No statuses, comments, replies, admin UI, attachments, screenshots or email. Reports are read with
the CLI.
