# BETA-G1 s8: browser sign-up route on the intake (design note and threat model)

Status: design plus a tested, **off-by-default** code slice. Nothing is deployed, enabled or proxied. The sign-up
page itself (HE/RTL default + EN) is the next slice. Builds on `docs/alpha/SIGNUP-AUTOMATION-DESIGN.md` (TBI-022;
read its threat model first) and `docs/plans/BETA-G1-AUTO-APPROVE.md`. Private details are placeholders:
`<SITE_ORIGIN>` is the public origin of the sign-up page, `<INTAKE>` the intake behind the trusted proxy.

Owner directive 2026-11-23: the public-beta sign-up must be our own web page, with the same fields as today's form
(incl. consent and "how did you hear about us"), feeding the intake directly; the signed Apps Script path stays as
the interim route.

## 1. Why a second route

`POST /signup` is authenticated by an HMAC over the body with a shared secret. A browser cannot hold that secret
(anything shipped to the page is public), so the page cannot use that route. The web route replaces "knows the
secret" with a set of weaker, layered checks that together make bulk abuse expensive and bounded, and keeps the
create-only, owner-decides design unchanged. **`POST /signup` is untouched** (same checks, same answers, same
stored record; tested).

## 2. Routes (exist only with `TBI_SIGNUP_WEB=1`; otherwise both paths are 404)

| Route | Answer |
|---|---|
| `GET /signup/form-token` | 200 `{token, ttl}` (`ttl` in seconds, 1800); 403 `forbidden` (foreign `Origin`); 429 `rate_limited` + `retry-after`; 405 |
| `POST /signup/web` | 200 `{ok:true, status:"received"}` (new **and** already known address); 400 `too_fast` / `invalid`; 401 `unauthorized` / `expired`; 403 `forbidden`; 413 `body_too_large`; 415 `unsupported_media_type`; 429 `rate_limited` + `retry-after`; 503 `unavailable`; 405 |
| `OPTIONS` on both | CORS preflight: 204 for an allow-listed `Origin` and the route's own method only, else 403 |

Body of `POST /signup/web` (JSON, nothing else allowed):
`{"name","email","role","lang":"he"|"en","consent":true,"heardFrom"?,"token","website":""}`.
`website` is the honeypot (must be present and empty). Every answer is a small JSON body with a machine code;
nothing from the request is echoed; `cache-control: no-store`.

### Token

`w1.<issued-at ms>.<nonce: 16 random bytes, base64url>.<mac>` with
`mac = HMAC-SHA256(webKey, "tbi-signup-web-token-v1\n<issued-at>\n<nonce>")` and
`webKey = HMAC-SHA256(secret, "tbi-signup-web-key-v1")`.

- **Stateless:** nothing is stored at issue time; the token carries its issue time and MAC.
- **Domain-separated (two layers):** the MAC key is derived from the secret, never the secret itself (which is the
  `/signup` signing key), and the MAC input has a fixed prefix that no `/signup` signature input (`v1\n...`) has. A
  token is therefore never a valid `/signup` signature and vice versa (tested both ways). Same secret file, so no
  new secret to install or rotate; rotating the HMAC secret invalidates all open tokens (pages fetch a new one).
- **Lifetime:** valid from 3 s (`WEB_MIN_FILL_MS`, below that `too_fast` = automated) to 30 min
  (`WEB_TOKEN_TTL_MS`, after that `expired`: the page fetches a new token and retries). An issue time more than 5 s
  in the future is a bad token.
- **Single use:** at submit time, after the MAC, the limits and the field validation, the nonce is taken in a
  `NonceCache` (the existing class, a **separate instance** from the signed route's, window = token TTL, so a used
  nonce is remembered for 2 x TTL, longer than the token can live). A second use is 401 `unauthorized`. A forged
  token never consumes anything. `too_fast` and `invalid` do **not** consume the token, so the page can fix a typo
  or wait and resend with the same token.

### Order of checks in `POST /signup/web`

1. method (405), 2. `Origin` allow-list, or the `Referer`'s origin only when `Origin` is absent (403),
3. strict `Content-Type: application/json` (optionally `; charset=utf-8`) (415), 4. body cap 4 KiB, by header and
by stream (413), 5. **per-source limit** (before any crypto) (429), 6. JSON object (400 `invalid`), 7. token: MAC,
age, minimum fill time (401 / 400 `too_fast`), 8. **global limit** (only requests carrying a token this intake
issued can spend it) (429), 9. honeypot empty (400 `invalid`), 10. field validation, the same `validateSignup` as
`/signup` plus the optional `heardFrom` (400 `invalid`), 11. consume the token (401 on replay), 12. the **same
downstream path** as `/signup`: atomic dedupe, store `pending`, Telegram alert (name and role only) or deferral in
quiet hours. The auto-approve sweep (admin service) then sees the record like any other pending request.

### Limits (`intake-server.ts`; reuse `SlidingWindowLimiter` from `limits.ts`, separate instances per route)

| Limit | Value | Why |
|---|---|---|
| token issue, per source | 20 / 10 min | a few page loads and refetches per person |
| post, per source | 10 / 10 min | a few retries (typo, `too_fast`, expired) per person |
| post, global (web only) | 200 / h | spent only with a valid token; a real person never auto-retries a 429, so generous; separate from the signed route's 200 / h, so a web flood cannot block the Apps Script path |

Here the source key **is** a person's address (the trusted proxy's last hop of `TBI_SIGNUP_SOURCE_HEADER`), unlike
the signed route where it is Google's shared pool. The store cap (5 000) stays the final bound for both routes.

### Content type: JSON, not form-urlencoded

Chosen: `application/json` only. A cross-site page can send `application/x-www-form-urlencoded`, `multipart` or
`text/plain` as a "simple" request without a CORS preflight (classic CSRF), and a plain HTML `<form>` can do it
with no script at all. A JSON content type forces a preflight for any cross-origin page, which only allow-listed
origins pass. The page therefore needs JavaScript to submit (the page slice must state that, and show a clear
message when scripting is off; we do not offer a no-JS fallback in this slice). Form-urlencoded would be simpler for
a no-JS page but would remove this layer; not chosen.

### Origin and CORS

- `TBI_SIGNUP_WEB_ORIGINS` is **required** when `TBI_SIGNUP_WEB=1`: comma-separated exact origins
  `https://host[:port]` (lower-case, no path, no wildcard, no `:443`). No default. Missing or malformed with the flag
  on = the intake refuses to start (fail closed). `TBI_SIGNUP_WEB` other than `1`, `0` or unset = refusal to start.
- POST: `Origin` decides when present (exact match; `null` never matches); only without `Origin` does the
  `Referer`'s origin count; neither = 403. (Chromium always sends `Origin` on a POST.)
- GET token: a same-origin request has no `Origin` header and is answered (without CORS headers); a cross-origin
  one must be listed.
- CORS headers only for a listed origin: `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`; never
  `Allow-Credentials` (the page sends no cookies); preflight allows only the route's method and `content-type`.

**Deploy options (owner's later RED step, not done here):** (a) **same-origin via proxy (recommended):** the site's
web server proxies `<SITE_ORIGIN>/signup/form-token` and `/signup/web` to `<INTAKE>`; no CORS needed, the page
posts to its own origin, the origin list is just `<SITE_ORIGIN>`; or (b) cross-origin: the page calls the intake's
public host directly and the CORS headers above apply. Either way the proxy must: set the client-address header
from the real peer (overwrite, never append the client's), pass `Origin`/`Referer` through unchanged, apply its
own size and rate limit, not log bodies, and route **only** these two paths plus `/signup` to the intake.

## 3. `heardFrom` ("how did you hear about us")

The stored record had no such field. Added as an **optional** short text (`HEARD_FROM_MAX` 80 characters), cleaned
like name and role (NFC, control / format / bidi characters removed, whitespace collapsed); an empty or blank
answer means "not answered" (no key stored). Accepted **only on the web route**: the signed route's allow-list is
unchanged (a `heardFrom` key there is still 400), so its records are byte-for-byte the same keys as before.

Schema-version care: the change is additive, so records stay `v: 1`; the key is absent on every older record and
on every `/signup` record; readers that do not know it ignore it (the store spreads the record). It is not in the
Telegram alert (minimisation) and not in any log. It is returned to the owner in the admin API's record (owner
only). Showing it in the admin UI is not in this slice. Retention: the same as the rest of the request.

A short text (not an enum) because the existing form's answer options are not in this repository and choosing a
taxonomy is a product decision; the page slice may send fixed, language-neutral option ids (they fit the same
field), and the server can be narrowed to an enum then (owner question O3).

## 4. Privacy: no enumeration

A known address and a new one get the **same status and body** (200 `received`). Internally a duplicate is still
handled exactly as on `/signup`: the atomic `<sha256(email)>.mark` marker finds the live (non-rejected) request,
nothing is stored or alerted, and the log line is the class `signup: duplicate ignored`; a rejected address may
apply again. The web route does **not wait for the Telegram alert** (it runs after the answer, bounded by the
notifier's 10 s timeout; `close()` waits for it), so a new address does not answer measurably slower than a known
one by a network round trip (tested). Residual: a small local-disk timing difference (a new record is fsync'd)
and the store-full case (see 6).

## 5. Threat model (additions for the web route)

| Abuse case | Control | Residual |
|---|---|---|
| Bot flood of POSTs without a token | per-source limit before any crypto; generic 401; global budget untouched | proxy limits bound CPU; many sources each under the limit still cost a JSON parse + one HMAC each |
| Token farming (bots fetch tokens, then post) | tokens are free but each is single use, needs >= 3 s, expires in 30 min; per-source issue and post limits; the **global** post budget bounds what all farmed tokens together can do per hour; store cap | a distributed farm can spend the web global budget (200 / h) and so delay real web sign-ups (DoS of the web route only; the signed route has its own budget); tokens are not bound to the source address (decision below) |
| Headless browser (runs JS, waits 3 s, leaves honeypot empty) | per-source limits, dedupe, owner decides (or the auto-approve daily cap) | not stopped by this slice; a CAPTCHA / proof-of-work / email verification would be the next layer (owner question O1) |
| CSRF / cross-site POST from another page | strict JSON content type (forces preflight), `Origin`/`Referer` allow-list, CORS only for listed origins, no credentials, no cookies used at all | a non-browser client can forge `Origin`; that is the "bot" case above, not CSRF |
| Replay of a captured token | single use via the nonce cache | the cache is in memory: after an intake restart a token used in the last 30 min can be used once more; the effect is one more pending request, or nothing for the same address (dedupe) |
| **Email-bombing a victim** (submitting someone else's address) | the intake never sends mail; one request per live address (dedupe); approval mail only on the owner's Approve; **with auto-approve on**, the sweep approves automatically and the victim gets exactly one approval mail per request, bounded by the daily cap; a rejected or purged address can be submitted again | with auto-approve on, a stranger's address can receive one unsolicited approval mail and get an account it never asked for. Whether auto-approve must require something extra (owner question O1) |
| Account enumeration | same answer for new and known addresses; alert not awaited | small disk timing; store-full 503 only for new addresses |
| Injection (log, mail, Telegram) | same cleaning and validation as `/signup`; logs carry class codes only (`signup: web refused (<code>)`), never an address, name, token or origin value | none known |
| Honeypot false positive (autofill / assistive tech filling the hidden field) | explicit 400 `invalid`, never a silent drop: the page can tell the person to try again | the page slice must hide the field from people and assistive technology correctly (off-screen, `aria-hidden`, `tabindex=-1`, `autocomplete=off`) |
| Large or slow bodies | 4 KiB cap (header and stream), the existing server timeouts | none new |
| Misconfiguration exposes the route | off by default; flag plus explicit origins required; anything else refuses to start | the proxy must not route other paths (deploy review) |

Decision taken in this slice (reversible): tokens are **not bound to the client address**, because some real
clients change their egress address between page load and submit (carrier NAT, IPv6 privacy addresses), and a
false refusal of a real person is worse here than the gain (the per-source post limit still applies to whoever
posts). Binding would be one extra field in the MAC input.

## 6. Residual risks (accepted in this slice, to review before enabling)

- No human-verification layer beyond timing and honeypot (see O1).
- Store full (5 000 records): a new address gets 503 while a known one still gets 200, so at the cap the answer
  reveals existence. The cap is an emergency state that the monitoring slice alerts on.
- Nonce cache in memory (restart reopens one more use per recent token).
- A distributed token farm can exhaust the web route's global budget for up to an hour at a time.
- Approval is manual unless auto-approve is on; with it on, see the email-bombing row.

## 7. Configuration (intake process; nothing changes unless set)

| Setting | Meaning |
|---|---|
| `TBI_SIGNUP_WEB` | unset, empty or `0`: off (both paths 404). Exactly `1`: on. Anything else: refusal to start. |
| `TBI_SIGNUP_WEB_ORIGINS` | required with `TBI_SIGNUP_WEB=1`; exact `https://host[:port]` list, comma-separated; no default. |

Start-up logs one line `web route on (<n> origin(s))` (no origin values). Everything else (secret file, source
header, store, quiet hours) is the existing intake configuration.

## 8. Tests (`runtime/admin/tests/signup-web-intake.test.ts`, vitest, fakes only)

Token round trip and every refusal (missing, malformed, forged, other key, future, expired, too fast), domain
separation both ways; origin parsing and matching; `heardFrom` validation (refused on `/signup`, optional and
cleaned on the web route); `submitWeb` with an injected clock: same downstream path and alert, replay, too fast
without consuming, expiry, missing / forged token, honeypot filled or absent, bad fields and JSON (token not
consumed), per-source limit before the token and global after it, duplicate answers equal to new ones, the alert
is not awaited, logs carry class codes only, no web deps = 404. Over real loopback HTTP through `startIntake`:
flag off = 404 on every method, the full token -> wait -> post flow with CORS headers, same-origin GET,
foreign / missing `Origin` and `Referer`, preflight, strict content type, 4 KiB cap, 405, replay, expiry /
too fast / honeypot codes, per-source 429 with `retry-after`, duplicate answers identical, and `/signup` unchanged
with the web route on (same 202 body, `heardFrom` still refused, a token is not a signature, identical record keys).

## 9. Owner questions (not decided here)

- **O1:** when auto-approve is on, must a web sign-up first prove control of the address (email verification
  link) before it counts, or an extra human check (CAPTCHA / proof of work)? Without it, a stranger's address can
  receive one unsolicited approval mail and get an account (bounded by the daily cap and dedupe). Email
  verification is not implemented in this slice.
- **O2:** deploy shape: same-origin via the site's proxy (recommended) or cross-origin CORS to the intake host?
- **O3:** keep "how did you hear about us" as short free text, or a fixed list of options (then the server accepts
  only those ids)?
- **O4:** are the web limits right for launch day (10 posts / 10 min per address, 200 / h in total)?

## 10. Not in this slice

The sign-up page (next slice, HE + EN texts via translation keys, WCAG 2.2 AA), the admin UI showing `heardFrom`,
proxy configuration, deploy and enabling, email verification, any change to the Apps Script forwarder.
