# Owner administration, access enforcement and extended feedback (Sprint 23B)

**Status: built, OFF by default.** Nothing changes on a deployment until it is switched on: the
app needs build flags, the services need environment variables, and the root administration
helper (operator tooling, outside this repository) must be installed first. With every switch
unset, the Session Host and the build service behave exactly as in RC4.

Based on the RC4 line (protocol `tbi-lab.session/2`, Runtime v2). No RC5 or Runtime v3 code.

## Switches

| Switch | Where | Effect |
|---|---|---|
| `VITE_PROBLEM_REPORTS=1` | app build | the Feedback button (status bar) and the menu item; the extended form |
| `VITE_ADMIN_UI=1` | app build | the Administration entry, shown only after the server confirms the owner |
| `TBI_REPORTS_DIR` | Session Host | report storage (unchanged from Sprint 14, `PROBLEM-REPORTS.md`) |
| `TBI_ACCESS_VIEW` | Session Host and build service | access enforcement from the authorization view |
| `TBI_ADMIN_DIR` | Session Host | owner administration API and identity observations (needs `TBI_ACCESS_VIEW`) |

Release profiles (`deploy/release/`):

- `rc4.release.json`, `rc4-reports.release.json`: **unchanged** RC4 profiles. They build the RC4
  commit. On this tree they fail closed (`unpinned setting VITE_ADMIN_UI`), by design: a profile
  pins every setting its source reads.
- `rc4-s23.release.json` (`"release": "rc4-s23"`): feedback and administration ON, with the host switches
  `TBI_REPORTS_DIR`, `TBI_ACCESS_VIEW=/var/lib/tbi-admin/view/access.json` and
  `TBI_ADMIN_DIR=/var/lib/tbi-admin`. The validator refuses `VITE_ADMIN_UI=1` without
  `TBI_ADMIN_DIR`, and `TBI_ADMIN_DIR` without `TBI_ACCESS_VIEW`.
  G2 on a packaging host: `TBI_PROFILES=rc4-s23 deploy/release/verify-on-packaging-host.sh …`.

Units: `deploy/dev-lab/s8/tbi-session-host.service.in` and `tbi-build.service.in` carry the
Sprint 23B lines commented out; `install.sh` uncomments them with `TBI_S23_ADMIN=1`, and refuses,
before any change, unless the groups `tbi-admin-view` and `tbi-admin-spool` and the helper's
directories exist (the helper's installer creates them; this script never does).

| Unit | Added when enabled |
|---|---|
| Session Host | `SupplementaryGroups=tbi-admin-view tbi-admin-spool`, `TBI_ACCESS_VIEW`, `TBI_ADMIN_DIR`, `ReadOnlyPaths=-/var/lib/tbi-admin/view -/var/lib/tbi-admin/results`, `ReadWritePaths=-/var/lib/tbi-admin/spool -/var/lib/tbi-admin/observations` |
| build service | `SupplementaryGroups=tbi-admin-view`, `TBI_ACCESS_VIEW`, `ReadOnlyPaths=-/var/lib/tbi-admin/view` |

`SupplementaryGroups=` is a list setting: the extra line extends the unit's existing groups; the
service users keep their primary groups. Group roles: `tbi-admin-view` (both services) reads
`view/` (`root:tbi-admin-view 0750`) and `view/access.json` (`0640`); `tbi-admin-spool` (Session
Host only) writes `spool/` and `observations/` (`0730`), reads `results/` (`0750`) and
`view/accounts.json` (`root:tbi-admin-spool 0640`). The services never gain write access to the
gate's allowlist or the tester registry.

## Trust model and access control policy

- Identity comes only from the authenticating gate. The Session Host and the build service listen
  on unix sockets that only the internal reverse proxy can reach; that proxy strips every client
  `X-Tbi-*` header.
- **Principal**: `p_` + base64url(HMAC-SHA256(identity key, `<issuer>|<subject>`))[0..26), from
  `X-Forwarded-User` (unchanged, Sprint 8).
- **Email tag**: `e_` + base64url(HMAC-SHA256(identity key, `email|` + lower(trim(address))))[0..26),
  from `X-Forwarded-Email`. Only tags are compared; the address itself is never logged, stored or
  returned by the services. A header that is not exactly one plain address counts as none.
- **Rule** (when `TBI_ACCESS_VIEW` is set), for every request except the health checks:
  **deny wins**: a principal in `revoked.principals`, or an email tag in `revoked.emailTags`, is
  refused even if the other identifier is authorized; otherwise the principal must be in
  `authorized.principals` or the email tag in `authorized.emailTags`. Refusal:
  `403 {"error":"account_disabled"}`. No identity at all: `401`. A missing, unreadable or invalid
  view: `503 {"error":"access_view_unavailable"}` (fail closed). The view is re-read on every
  change of its file (a directory watch, so an atomic rename is seen) and at least every 10 s
  (default 5 s).
- **Revocation of live work**: on every successful re-read, the Session Host ends each live
  session whose creator is no longer authorized by the same rule (deny wins; principal, and the
  email tag recorded when the session was created) with end reason `account_disabled`, and closes its event streams.
  Other accounts' sessions are never touched. One journal line with the count only:
  `{"event":"access_revoked","sessions":N}`. The app tells the tester the session was stopped
  because access ended. A view that becomes unreadable refuses new requests but does not end
  sessions (a transient fault must not end everyone's work; sessions still end by lease or
  lifetime).
- **Owner**: the view's `owner.principal`; only while that is `null` (the owner's Google id not
  yet recorded), the owner's email tag. Decided on every admin call, from the view only, never
  from a client field, query, header or cookie. Admin calls: `401` without identity, `403
  {"error":"forbidden"}` for any other account (testers, pending, revoked, unknown).
- **CSRF** on every mutation (POST, DELETE): `Content-Type: application/json`, and either an
  `Origin` whose host is the request's `Host`, or (no `Origin`) `Sec-Fetch-Site: same-origin`. A
  cross-site `Sec-Fetch-Site` is refused whatever the `Origin` says. Refusal: `403
  {"error":"csrf"}`. The gate's cookie is `SameSite=Lax` in addition.
- **Limits**: per caller, 120 admin requests and 20 mutations per minute (`429` + `Retry-After`),
  1 KiB bodies (`413`), strict validation (only known fields; target and id formats; an address
  in the registry's character set, at most 254 characters, normalized to lower case).

### Hardening from the security review (Sprint 23B)

- **H1, backend socket groups.** Each backend socket has its own group, shared only with the
  internal reverse proxy: `tbi-sock-runtime` (Session Host, `/run/tbi-runtime/api.sock`) and
  `tbi-sock-build` (build service, `/run/tbi-build/api.sock`), mode 0660 (`TBI_SOCKET_GID`).
  Neither service is in `tbi-gate` any more; that group is only Caddy's internal origin (caddy and
  oauth2-proxy). Without this, a compromised build service could connect to the Session Host's
  socket and replay the owner's gate headers (it sees them on `/build/*` requests) against
  `/admin`. The build service's admission check now reads a separate health-only socket
  (`TBI_HOST_HEALTH_LISTEN=unix:/run/tbi-runtime/health.sock`, group `tbi-artifacts`, answering
  `GET /health` only). `install.sh` creates both groups and adds caddy to them; **caddy must be
  restarted** (not reloaded) to pick up the new groups. **Alpha's own install path must make the
  same group, unit and health-socket change.**
- **L3, build work.** On every reload of the access view, the build service cancels the queued and
  running builds of accounts the view no longer authorizes (same rule, deny wins; the email tag is
  recorded per build). They end `failed` with `account_disabled` and do not count toward the build
  cool-down. Builds of curated system sources (shared, curated images only) are left to finish.
  One journal line with the count only: `{"event":"builds_revoked","builds":N}`.
- **I2.** Addresses (the gate's header and the owner's input) must be ASCII, checked before
  lower-casing: Unicode case folding turns e.g. U+212A KELVIN SIGN into `k`.
- **I3.** Bidi embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069) are removed
  from feedback descriptions and component names.
- **I5.** The policy's per-caller request backstop applies to `/admin` calls too, before the
  owner check.

### What the gate itself does on revocation (oauth2-proxy v7.15.4)

oauth2-proxy re-validates the session's address against `authenticated_emails_file` on **every**
request: an address no longer in the file gets its cookie cleared and a 403, so a disabled tester
loses access at the gate without waiting for the 8-hour cookie to expire. Caveats: the file
watcher reloads the list when the file is removed or replaced (an atomic rename is seen); a file
that fails to parse keeps the previous list in force. This is being verified empirically on DEV
(work package D). The services' own enforcement above does not depend on it, and it also covers
what the gate cannot: event streams already open and simulations already running.

### Gate header verification (oauth2-proxy v7.15.4)

The rule relies on oauth2-proxy replacing any client value of `X-Forwarded-User` and
`X-Forwarded-Email` with the session's own. Verified in the v7.15.4 source, with the legacy
(flat) configuration this deployment uses, `pass_user_headers` and `skip_auth_strip_headers` at
their defaults and `set_xauthrequest = false`:

- `pkg/apis/options/legacy_options.go` L42–46 (`NewLegacyOptions`): defaults
  `PassBasicAuth: true`, `PassUserHeaders: true`, `SkipAuthStripHeaders: true`; L217 and L226,
  the flag defaults; L89, `ToOptions` turns the legacy headers into `InjectRequestHeaders`.
- L244–247 (`getRequestHeaders`): with `PassBasicAuth || PassUserHeaders`, the user headers are
  injected; L258–260: every injected request header gets
  `PreserveRequestValue = !SkipAuthStripHeaders`, i.e. `false`.
- L340–362 (`getPassUserHeaders`, `prefer_email_to_user` false): `X-Forwarded-User` from claim
  `user` and `X-Forwarded-Email` from claim `email`.
- `pkg/middleware/headers.go` L15–26, L28–43, L54–66: `NewRequestHeaderInjector` chains
  `stripHeaders` (every header with `PreserveRequestValue` false is deleted from the request,
  name-normalized, L133–140) before the injector; L79–89, the injector adds the session's values.
- `pkg/header/injector.go` L107–116: an empty claim adds nothing (the header is then absent:
  stripped, never the client's).
- `pkg/apis/sessions/session_state.go` L154–157: the claims come from the session state.
- `oauthproxy.go` L442–454 (`buildHeadersChain`) and L1041–1054 (`Proxy`): every authenticated
  request passes through that chain before the upstream. `set_xauthrequest` only adds response
  headers (`legacy_options.go` L268).

So, as configured, a client cannot set either header. `X-Forwarded-Email` is therefore used as
specified. A deployment that sets `skip_auth_strip_headers = false`, or that enables
`prefer_email_to_user`, must not enable `TBI_ACCESS_VIEW`.

## Files (generic layout `/var/lib/tbi-admin`)

```
/var/lib/tbi-admin/                                root:root 0755
  spool/<id>.json          Session Host -> helper   root:tbi-admin-spool 0730   requests
  results/<id>.json        helper -> Session Host   root:tbi-admin-spool 0750   results
  view/access.json         helper -> both services  root:tbi-admin-view  0640   authorization view
  view/accounts.json       helper -> Session Host   root:tbi-admin-spool 0640   the owner's masked list
  observations/<id>.json   Session Host -> helper   root:tbi-admin-spool 0730   gate identities
```

Ids: 26 Crockford base32 characters (48-bit milliseconds, then 80 random bits). Every file the
Session Host writes is created as `<id>.tmp` with `O_CREAT|O_EXCL` and mode `0600`, written,
fsynced, then renamed to `<id>.json` (the directory is not readable by the host, so it is not
fsynced). A failure leaves nothing; an existing `.tmp` of the same name is never touched.

**Request** (one line, less than 4 KiB):

```json
{"v":1,"id":"01JBX…","at":"2026-10-29T10:00:00.000Z","actor":"p_…","action":"add","email":"new@example.invalid"}
{"v":1,"id":"01JBX…","at":"…","actor":"p_…","action":"disable","target":"t_…"}
```

`add` carries `email` only; `disable` and `reactivate` carry `target` only. `actor` is the gate's
principal (a mutation without one is `401`); the helper checks it against the owner itself.

**Result**: `{"v":1,"id","ok","code","target","masked","backup","at"}` with `code` one of
`done forbidden invalid cap_reached exists unknown_target last_owner conflict error`. Fields are
re-validated; a masked value that is not `xx***@domain` is replaced by `***`. When the view has
no owner principal yet, a `forbidden` result is returned with `ownerIdentityPending: true` and
the owner reads "Owner identity not yet recorded on the server; ask the operator to run the
identity sync".

**Access view** `view/access.json`:

```json
{"v":1,"generated":"…","seq":1,
 "owner":{"principal":"p_…|null","emailTag":"e_…"},
 "authorized":{"principals":["p_…"],"emailTags":["e_…"]},
 "revoked":{"principals":["p_…"],"emailTags":["e_…"]}}
```

**Accounts view** `view/accounts.json`: `{"v":1,"generated","cap","authorizedTesters","owner",
"accounts":[{"target","masked","class","status","dateAdded","googleIdRecorded","lastSignIn",
"statusUpdated"}],"warnings":[{"target","kind","first","last","count"}]}`. Re-validated field
by field; anything unusable is `503`, never a partial list.

**Observation**: `{"v":1,"at":"…","sub":"<digits>","email":"<lower>"}`, at most once per principal
per hour, only when the gate passed both headers and the subject is decimal. Best effort: written
detached from the request, at most 4 in flight, every failure dropped silently.

## Admin API

Same origin, under the existing `/runtime/` route (the proxy's prefix strip and header rules
apply; no proxy change). `GET` unless stated.

| Route | Answer |
|---|---|
| `/runtime/admin/me` | `200 {"owner":true}` (the UI shows the entry only then) |
| `/runtime/admin/accounts` | the masked accounts view (cap, authorized testers, owner, accounts, warnings) |
| `/runtime/admin/sessions` | `{"live":N,"max":M}`: live sessions and the host's effective ceiling |
| `POST /runtime/admin/accounts` `{"email"}` | spools `add`, waits up to 15 s: `200`/`409` result, or `202 {"id","pending":true,"result":"requests/<id>"}` |
| `POST /runtime/admin/accounts/disable` `{"target"}` | the same for `disable` |
| `POST /runtime/admin/accounts/reactivate` `{"target"}` | the same for `reactivate` |
| `/runtime/admin/requests/<id>` | `200` result, `202` still pending, `404` unknown |
| `/runtime/admin/reports` | `{"reports":[metadata…]}`, newest first; never the text or component name |
| `/runtime/admin/reports/<id>` | the stored report in full |
| `DELETE /runtime/admin/reports/<id>` | `{"deleted":1}` or `404` |
| `DELETE /runtime/admin/reports?principal=p_…` | `{"deleted":N}`: every report of one tester |

The report operations are those of the operator CLI (`scripts/problem-reports.mjs`), implemented in
`ReportStore` (in process, never through a shell). A full address is never returned: the one the
owner types to add a tester stays in the owner's dialog, masked unless the owner presses "Show".

## Feedback (extends Sprint 14 Report a Problem)

Same endpoint, store, limits, status codes and 90-day retention as `PROBLEM-REPORTS.md`. New
optional request fields:

| Field | Values |
|---|---|
| `kind` | `bug` (default: an RC4 request), `component`, `feature`, `general` |
| `component` | the requested component's name, `kind: component` only, at most 80 code points, one line |
| `context` | optional technical context: `runtime` (version token), `device` (`desktop`, `tablet`, `other`), `projectId` (`prj_…`) |

For every kind but `bug`, `category` must be `other`. The tester can leave the context out
(checkbox, on by default); it never contains project contents, names, code or logs. Stored
reports keep `v: 1` and add `kind`, `component` and `context`.

**Journal line v2** (the alerter accepts v1 and v2):

```json
{"event":"problem_report","v":2,"id":"7K3M-9QX2-WDAB","category":"other","kind":"component","component":true,"blocking":false,"release":"0.14.0","app":"0.14.0","at":"…"}
```

`component` says whether a name was given; never the name, the text or an identity.

## The app

- **Feedback** button at the inline end of the bottom status bar (every screen; never over the
  circuit), and the existing menu item. The form: kind selector (radio group), the message with
  its counter, the component name for a component request, area and "blocking" for a bug report,
  the context checkbox, the disclosure, then the confirmation with the report id, shown only after
  the server stored it. Keyboard and screen-reader friendly (labels, `aria-invalid`, status and
  alert regions, focus trap, Escape). EN and HE (RTL); the tester's words are `dir="auto"`.
- **Administration** (owner only, `VITE_ADMIN_UI=1`): the testers (masked identity, role, status,
  date added, Google account recorded, last sign-in or "Not measured"), capacity (testers N/20,
  the owner not counted; live simulations vs the ceiling), the helper's warnings, adding a tester,
  disabling and reactivating with a confirmation that says what happens (no new sign-in, current
  requests refused, running simulations stopped; the record and reports kept), and the feedback
  list and detail with confirmed deletion. Nothing about testers is in the bundle.

## Tests

- `runtime/identity/tests/access.test.ts`: email tags, header validation, strict view parsing,
  the owner rule, reload on change and on the timer, fail closed.
- `runtime/host/tests/admin.test.ts`: no identity / tester / pending / revoked / unknown / forged
  headers (client `X-Forwarded-*` and `X-Tbi-*`) / owner; direct API access; CSRF; rate limit;
  malformed and injection input; spool format, mode and atomicity; result timeout; view reload;
  revocation ending only that account's sessions and streams; fail closed; observation dedupe;
  feedback kinds, the v2 line, limits and ownership; reports owner-only.
- `runtime/builder/tests/access.test.ts`: the build service's enforcement and build revocation
  (deny wins, both directions).
- `runtime/identity/tests/socket-groups.test.ts`: the socket's configured group and mode 0660.
- `app/tests/admin.test.ts`, `app/tests/problem-report.test.ts`: the client logic.
- `app/e2e/s23-feedback.spec.ts`, `app/e2e/s23-admin.spec.ts`: EN and HE, desktop (1400×860) and
  tablet (1024×768), against the real admin API with a fake helper.
