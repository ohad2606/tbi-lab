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
| Routing | Only the exact paths `/signup/form-token` and `/signup/web` (query allowed) go to the intake. Every method on them is proxied: the intake answers 405 to methods it does not accept, and `OPTIONS` must pass for the CORS preflight. The match uses the **raw** request URI (`expression {http.request.uri}.matches(...)`), because in Caddy 2.6 `path` ignores case and `path`/`path_regexp` match a cleaned, decoded path (`/SIGNUP/WEB`, `/signup%2Fweb`, `/signup/%77eb`, `/signup//web`, `/x/../signup/web` would all match). The signed `/signup` route is **not** routed. Everything else is `file_server` or 404. |
| Host | The site block matches only `SITE_HOST`. If no site matches the Host, Caddy 2.6 sends an empty 200 and routes nothing (Caddy's default; we add no catch-all because the live config may hold other sites). |
| Client address | All identity headers are removed first (`request_header -X-Tbi-*`, `-X-Forwarded-*`, `-Forwarded`, `-X-Real-Ip`, `-True-Client-Ip`, `-CF-Connecting-Ip`, `-Cookie`, `-SOURCE_HEADER`). Then `header_up SOURCE_HEADER {remote_host}` sets the TCP peer. Caddy's own `X-Forwarded-For/Proto/Host` are removed with `header_up -...`. The delete is not a wildcard inside `header_up`, because there deletes run after sets and would remove the address we set. The test checks the header arrives as `127.0.0.1`. `SOURCE_HEADER` must equal the intake's `TBI_SIGNUP_SOURCE_HEADER` (for example `X-Tbi-Client-Ip`). |
| Passed unchanged | `Origin`, `Referer`, `Content-Type` (the intake checks them). |
| Size and time | `request_body max_size 8KB` on the two proxied paths only (Caddy answers 413). The intake's 4 KiB cap is the one that counts: a chunked body streams up to 8 KB and is then aborted. Server limits: `read_header`/`read_body` 10 s, `write` 30 s, `idle` 60 s, `max_header_size` 16 KB. Proxy: `dial_timeout` 3 s, `response_header_timeout` 10 s, `lb_try_duration 0s` (no retries, including POST). |
| Headers (responses from the site block, also its errors) | CSP = `SITE_CSP` (with `frame-ancestors 'none'`), `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, a minimal `Permissions-Policy`, `Server` removed. HSTS (`max-age=31536000`, no `preload`) only in the `tls` variant. Not covered: Caddy's own 400/431 sent before any handler runs, and the empty 200 for an unmatched Host. |
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

`npx vitest run site/tests/signup-proxy.test.mjs`. The Caddy part is skipped when `caddy` is not on the PATH. With
`TBI_REQUIRE_CADDY=1`, a missing caddy or a version below 2.6 fails the run. CI (`ci.yml`, unit job) installs a
checksum-pinned Caddy 2.6.2 and sets this variable. It is **not** wired into a release gate yet, and CI does not
check the Caddy on the deploy host (see step 1). The harness uses `admin off`, `auto_https off`, a temp HOME/XDG,
`127.0.0.1` with a free port, and a fake intake on a unix socket in a 0700 temp dir. One end-to-end token-then-post
goes to the real intake.

## Deploy runbook (every live step is RED: owner approval, interactive, never at night)

There is no apply script, on purpose. Values: `SITE_HOST` (public host: one DNS name, no port or wildcard),
`SITE_ROOT` (built site directory: absolute path, not `/`, letters, digits and `._+-` only), `INTAKE_UPSTREAM`
(the intake on loopback, `127.0.0.1:<port>`, `[::1]:<port>` or `localhost:<port>`, or
`unix//<absolute path>.sock`), `SOURCE_HEADER` (starts with `X-Tbi-`, equals `TBI_SIGNUP_SOURCE_HEADER`). The
renderer refuses anything else, and placeholders it did not replace. These values are not stored in this public
repo.

### Warning: the template is a whole config, with a global block

The rendered file starts with a global `servers` block (`read_header`/`read_body` 10 s, `write` 30 s, `idle` 60 s,
`max_header_size` 16 KB). It applies to **every site** in a Caddy config, and a config may have only **one** global
options block, which must come first.

- **Never paste the file as it is into a live multi-site Caddyfile, and never install the rendered file over a
  multi-site one.** The same holds for the rollback render, which has the same global block.
- For a multi-site host the owner decides one of: (a) merge the options into the existing global block (host-wide
  effect: these timeouts and the header limit can cut other sites' long downloads, streams and uploads); (b) scope
  them per listener (`servers <listener address> { ... }` inside the one global block; this still affects every site
  on that listener); (c) drop them (the sign-up site then has no such limits).
- The tests cover the standalone render only. A merged config must pass `caddy validate` and is not covered by them.

### Steps

1. **RED** (runs on the server; required before any other RED step): on the deploy host, with its Caddy version,
   this passes (loopback only):

   ```sh
   TBI_REQUIRE_CADDY=1 npx vitest run site/tests/signup-proxy.test.mjs
   ```

2. Render both configs (offline, GREEN) from the repo root into a new temp directory. Replace the example values:

   ```sh
   out=$(mktemp -d)
   SITE_HOST=signup.example.test SITE_ROOT=/srv/example-site \
   INTAKE_UPSTREAM=127.0.0.1:7411 SOURCE_HEADER=X-Tbi-Client-Ip OUT="$out" \
   node --input-type=module -e '
   import { writeFileSync } from "node:fs";
   import { PLACEHOLDERS, renderCaddyfile } from "./site/deploy/caddy.mjs";
   const v = Object.fromEntries(PLACEHOLDERS.map((k) => [k, process.env[k]]));
   writeFileSync(`${process.env.OUT}/tls.Caddyfile`, renderCaddyfile(v));
   writeFileSync(`${process.env.OUT}/rollback.Caddyfile`, renderCaddyfile(v, { proxy: false }));
   '
   echo "$out"
   ```

3. Validate both files (GREEN), in the same shell. The command exits non-zero if either file fails; then stop:

   ```sh
   (for f in tls rollback; do caddy validate --adapter caddyfile --config "$out/$f.Caddyfile" || exit 1; done)
   ```

4. **RED:** diff against the live config, and have the owner review the diff. The review must list every
   global-option change explicitly (added, changed or dropped), with its effect on other sites. If the live
   Caddyfile holds other sites, merge the site block and snippet by hand and apply the owner's global-block
   decision (see the warning). Do not overwrite other sites.
5. **RED** (as the owner of the config directory, often root): copy the current live config to a dated backup next
   to it, with `cp -p` (keeps owner, mode and time), and keep it. Note the backup's full path.

   ```sh
   live=/path/to/live/Caddyfile # replace
   cp -p -- "$live" "$live.bak-$(date +%Y%m%d-%H%M%S)" && ls -l -- "$live".bak-*
   ```

6. **RED** (as the owner of the config directory): stage the reviewed config (the rendered file only if the host
   serves no other site, otherwise the merged one) as a new file next to the live one, with the live file's owner and
   mode (the Caddy user must be able to read it; the move in step 7 carries both to the live file). Do not touch the
   live file yet: a restart must never find an unvalidated config. The first copy gives the staged file the live
   file's owner and mode (`cp -p`); the second replaces only its content. The two `stat` lines must show the same
   owner, group and mode; if not, stop and set them (`chown`, `chmod`) before going on.

   ```sh
   live=/path/to/live/Caddyfile # replace
   staged="$live.staged"
   reviewed=/path/to/reviewed/Caddyfile # replace
   test -f "$reviewed" && cp -p -- "$live" "$staged" && cp -- "$reviewed" "$staged" && stat -c '%U:%G %a %n' -- "$live" "$staged"
   ```

7. **RED:** validate the staged file; only if validation passes, move it over the live file and reload (the reload
   needs the live admin endpoint). Run `caddy validate` and `caddy reload` as the Caddy service's user and with its
   environment (see the unit's `User=` and `Environment`/`EnvironmentFile`), not under plain `sudo`: validating as
   another user can create root-owned log or storage files that break the reload, and a different environment can
   validate a different config. Run the move as the user that owns the config directory (often root). Each block holds
   one command and works in a fresh shell. Run the next block only after the previous one exited 0 (`echo $?`);
   otherwise stop. If the reload fails, restore the backup as in step 9. Never restart other services.

   7a. As the Caddy service's user, with the service's environment:

   ```sh
   live=/path/to/live/Caddyfile # replace
   staged="$live.staged"
   caddy validate --adapter caddyfile --config "$staged"
   ```

   7b. As the owner of the config directory, only after 7a exited 0:

   ```sh
   live=/path/to/live/Caddyfile # replace
   staged="$live.staged"
   mv -- "$staged" "$live"
   ```

   7c. As the Caddy service's user, with the service's environment, only after 7b exited 0:

   ```sh
   live=/path/to/live/Caddyfile # replace
   caddy reload --adapter caddyfile --config "$live"
   ```

8. **RED:** smoke checks from outside: `curl -sI https://<SITE_HOST>/he/` gives 200 with the CSP, nosniff and HSTS
   headers. `curl -s https://<SITE_HOST>/signup/form-token -H 'Origin: https://<SITE_HOST>'` gives 200 JSON
   (with `TBI_SIGNUP_WEB=1`) or 404 (off). `/signup`, `/signup/web/` and `/SIGNUP/WEB` give 404.
9. **RED (rollback):** as the owner of the config directory, copy the backup from step 5, or the rollback config,
   to the staged path. Copy with `cp -p`; never move the backup, so it is still there afterwards. The staged file must
   have the live file's owner and mode: check the two `stat` lines before you validate or move, and if they differ,
   stop and set them (`chown`, `chmod`). On a multi-site host, never install the rollback render as it is: merge its
   site block as in step 4.

   From the backup:

   ```sh
   live=/path/to/live/Caddyfile # replace
   staged="$live.staged"
   backup=/path/to/the/step-5/backup # replace
   test -f "$backup" && cp -p -- "$backup" "$staged" && stat -c '%U:%G %a %n' -- "$live" "$staged"
   ```

   Or from the rollback config (single-site render, or the merged file): use the block of step 6 with
   `reviewed` set to it.

   Then run 7a, 7b and 7c, each only after the previous one exited 0. Smoke checks: `/he/` gives 200, and both intake
   paths give 404.
