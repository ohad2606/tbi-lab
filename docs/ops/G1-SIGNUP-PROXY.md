# G1 sign-up site proxy (Caddy template)

Gate G1 (BACKLOG row 8, K4/K5/K8). Repo files only; **nothing is deployed** by this change.
Intake side: `docs/plans/BETA-G1-WEB-INTAKE.md`.

- Template: `site/deploy/Caddyfile.signup.template`
- Renderer: `site/deploy/caddy.mjs` (`renderCaddyfile(values, { variant, proxy })`)
- CSP: `site/csp.mjs` (`SITE_CSP`, also sent by `site/serve.mjs`)
- Tests: `site/tests/signup-proxy.test.mjs` (real Caddy, loopback only; part of `npm test`)

## What the config does

| Area | Behaviour |
| --- | --- |
| Routing | Only `GET/POST /signup/form-token` and `/signup/web` (query allowed) go to the intake. The match uses the **raw** request URI (`expression {http.request.uri}.matches(...)`), because in Caddy 2.6 `path` ignores case and `path`/`path_regexp` match a cleaned, decoded path (`/SIGNUP/WEB`, `/signup%2Fweb`, `/signup/%77eb`, `/signup//web`, `/x/../signup/web` would all match). The signed `/signup` route is **not** routed. Everything else is `file_server` or 404. |
| Host | The site block matches only `SITE_HOST`. If no site matches the Host, Caddy 2.6 sends an empty 200 and routes nothing (Caddy's default; we add no catch-all because the live config may hold other sites). |
| Client address | All identity headers are removed first (`request_header -X-Tbi-*`, `-X-Forwarded-*`, `-Forwarded`, `-X-Real-Ip`, `-True-Client-Ip`, `-CF-Connecting-Ip`, `-Cookie`, `-SOURCE_HEADER`). Then `header_up SOURCE_HEADER {remote_host}` sets the TCP peer. Caddy's own `X-Forwarded-For/Proto/Host` are removed with `header_up -...`. The delete is not a wildcard inside `header_up`, because there deletes run after sets and would remove the address we set. The test checks the header arrives as `127.0.0.1`. `SOURCE_HEADER` must equal the intake's `TBI_SIGNUP_SOURCE_HEADER` (for example `X-Tbi-Client-Ip`). |
| Passed unchanged | `Origin`, `Referer`, `Content-Type` (the intake checks them). |
| Size and time | `request_body max_size 8KB` on the two proxied paths only (Caddy answers 413). The intake's 4 KiB cap is the one that counts: a chunked body streams up to 8 KB and is then aborted. Server limits: `read_header`/`read_body` 10 s, `write` 30 s, `idle` 60 s, `max_header_size` 16 KB. Proxy: `dial_timeout` 3 s, `response_header_timeout` 10 s, `lb_try_duration 0s` (no retries, including POST). |
| Headers (all responses, also errors) | CSP = `SITE_CSP` (with `frame-ancestors 'none'`), `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, a minimal `Permissions-Policy`, `Server` removed. HSTS (`max-age=31536000`, no `preload`) only in the `tls` variant. |
| Errors | `handle_errors` answers `"<code> <standard text>"`, e.g. `502 Bad Gateway` when the intake is down. It never shows the upstream address. The static site keeps working. |
| Logging | No `log` directive, so no access logs. If logging is ever added, do not log `Origin`, `Referer`, client addresses or bodies. |
| No-JS | A plain HTML form POST (`application/x-www-form-urlencoded`) gets **415** from the intake. The page needs its script. |

### Not in this template (OPEN, owner decisions)

- **Proxy-level rate limit: OPEN.** Caddy core has no rate limiter. The primary control is the intake's
  limiters (per source, per /64, global; see the plan). Options, each RED (owner approval):
  (a) a third-party Caddy module built with xcaddy (a new binary on the host); (b) nftables connection or rate
  limits on 443 (host firewall); (c) a CDN in front (a third party; also needs (d)).
- **(d) CDN or load balancer in front:** `{remote_host}` would be the CDN's address. That needs
  `trusted_proxies` plus taking the client address from the CDN header, and an owner review. It is not in this
  template, and the template must not be used behind one as it is.

## Kill switch (two layers)

1. **Proxy rollback config:** the same template rendered with `proxy: false` (static only). Both paths then get 404
   from Caddy and the intake gets nothing. A test covers this.
2. **Intake:** `TBI_SIGNUP_WEB=0` (or unset). Both paths get 404 from the intake.

## Tests

`npx vitest run site/tests/signup-proxy.test.mjs`. The Caddy part is skipped when `caddy` is not on the PATH (CI has
none today). With `TBI_REQUIRE_CADDY=1`, a missing caddy or a version below 2.6 fails the run. This variable is
**not** wired into a release gate yet. To wire it in, run the test with `TBI_REQUIRE_CADDY=1` on the
packaging/deploy host before any live step. The harness uses `admin off`, `auto_https off`, a temp HOME/XDG,
`127.0.0.1` with a free port, and a fake intake on a unix socket in a 0700 temp dir. One end-to-end token-then-post
goes to the real intake.

## Deploy runbook (every live step is RED: owner approval, interactive, never at night)

There is no apply script, on purpose. Values: `SITE_HOST` (public host), `SITE_ROOT` (built site directory),
`INTAKE_UPSTREAM` (loopback `127.0.0.1:<port>` of the intake), `SOURCE_HEADER` (equals
`TBI_SIGNUP_SOURCE_HEADER`). These values are not stored in this public repo.

1. Render both configs locally (offline, GREEN): `node -e` with `renderCaddyfile(values)` and
   `renderCaddyfile(values, { proxy: false })`, written to two files outside the repo. The renderer refuses
   placeholders it did not replace, and values with whitespace, braces, quotes or newlines.
2. `caddy validate --adapter caddyfile --config <rendered>` for both files (GREEN).
3. **RED:** diff the rendered site block against the live config, and have the owner review the diff. If the live
   Caddyfile holds other sites, merge the site block and snippet by hand. Do not overwrite other sites.
4. **RED:** copy the current live config to a dated backup next to it, and keep it.
5. **RED:** install the new config and `caddy reload` (needs the live admin endpoint). Never restart other services.
6. **RED:** smoke checks from outside: `curl -sI https://<SITE_HOST>/he/` gives 200 with the CSP, nosniff and HSTS
   headers. `curl -s https://<SITE_HOST>/signup/form-token -H 'Origin: https://<SITE_HOST>'` gives 200 JSON
   (with `TBI_SIGNUP_WEB=1`) or 404 (off). `/signup`, `/signup/web/` and `/SIGNUP/WEB` give 404.
7. **RED (rollback):** reload the rollback config, or the backup from step 4. Smoke checks: `/he/` gives 200, and
   both intake paths give 404.
