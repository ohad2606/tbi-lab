# dev-lab.tbi-tech.net: private development preview

A private preview of the closed TBI Lab Product Alpha. Only explicitly allowed Google
accounts can reach it. It is a static production build: no R2 Session Host, no QEMU and no dev
server are exposed.

```
browser --HTTPS--> Caddy :443 (Let's Encrypt; :80 redirects to HTTPS)
                     └─> oauth2-proxy 127.0.0.1:4180 (Google OIDC, exact-email allowlist)
                           └─> Caddy 127.0.0.1:8080 (static build, SPA fallback)
```

**Identity provider.** The PM decided on 2026-09-25 to use Google OAuth directly. This
replaces the original Auth0 email/password plan.

## Files

| Repository file            | Installed at                                                  | Contains                                                                   |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Caddyfile`                | `/etc/caddy/Caddyfile`                                        | TLS, redirect, proxy, internal static origin                               |
| `oauth2-proxy.cfg`         | `/etc/oauth2-proxy/oauth2-proxy.cfg`                          | non-secret gate settings                                                   |
| `oauth2-proxy.service`     | `/etc/systemd/system/oauth2-proxy.service`                    | hardened systemd unit                                                      |
| `oauth2-proxy.env.example` | `/etc/oauth2-proxy/oauth2-proxy.env` (root, 0600)             | **real values only on the server**                                         |
| —                          | `/etc/oauth2-proxy/allowed-emails` (0640, group oauth2-proxy) | **allowed addresses, one per line; never committed**                       |
| `publish.sh`               | —                                                             | builds an exact git ref and publishes it to `/srv/tbi-lab/dev-lab/current` |

## Google Cloud Console (OAuth client)

- Application type: Web application.
- Authorized redirect URI: `https://dev-lab.tbi-tech.net/oauth2/callback` (exactly).
- Authorized JavaScript origin: `https://dev-lab.tbi-tech.net`.
- OAuth consent screen: keep it in **Testing**, with only the allowed address as a test user.
  This is a second gate in front of the server-side allowlist.

## Install (Ubuntu, aarch64)

1. `sudo apt-get install caddy iptables-persistent`
2. Install oauth2-proxy from the official release, after checking the release's published
   sha256:
   `oauth2-proxy-v<version>.linux-arm64.tar.gz` → `/usr/local/bin/oauth2-proxy`.
3. `sudo useradd --system --no-create-home --shell /usr/sbin/nologin oauth2-proxy`
4. Put the files in place as listed above. Write the env file and the allowlist directly on the
   server, never through git.
5. `deploy/dev-lab/publish.sh <ref>`, then
   `sudo systemctl enable --now oauth2-proxy` and `sudo systemctl reload caddy`.
6. Firewall: accept TCP 80 and 443 in iptables and persist them with `netfilter-persistent
save`. Also add the matching ingress rules in the Oracle Cloud security list for the subnet.
   Nothing else is opened.

## Behaviour

- Every path, including `/assets/*`, requires the session cookie. Without it, HTML requests are
  redirected to Google, and any other request gets 401/403 or the redirect. Only `/oauth2/*`
  answers unauthenticated.
- Any other Google account authenticates with Google but is refused by oauth2-proxy with 403.
- Sign-out: `https://dev-lab.tbi-tech.net/oauth2/sign_out` clears the session cookie.
  - The app shows a secondary **Sign out** link (Hebrew: יציאה), a plain navigation to it:
    beside the language selector on the Projects screen, and in the editor's menu. `publish.sh` builds with `VITE_SIGN_OUT_URL=/oauth2/sign_out`; builds
    without that variable (local, CI) show no sign-out control.
  - The next visit goes back to Google with the account chooser (`prompt=select_account`).
  - Google's own browser session is not ended; that is a limitation of Google as an identity
    provider.
- Caching and routing on the internal origin (`http://:8080`, bound to loopback; it matches
  any `Host`, because oauth2-proxy passes `Host: dev-lab.tbi-tech.net` upstream):
  - `/assets/*` is served as files only, with `Cache-Control: private, max-age=31536000,
immutable`. A missing asset is a **404**, never `index.html`, so an outdated asset
    reference fails visibly instead of loading HTML as a script.
  - Every other path is the HTML entry point: an existing file or the single-page-app fallback
    to `index.html`, always with `Cache-Control: no-store`. After sign-out, the app cannot load
    from the browser cache; every page load passes through the gate again.
- Rollback: `sudo ln -sfn /srv/tbi-lab/dev-lab/<old-sha> /srv/tbi-lab/dev-lab/current`.

## Build service (Sprint 7)

- `tbi-build.service` (one-time setup: `setup-build.sh`) compiles Arduino sketches for the Classic
  ESP32 with the pinned toolchain. It listens on 127.0.0.1:7420 only; the browser reaches it
  same-origin at `/build/*` through Caddy's internal origin, i.e. behind the same Google login
  and allowlist. Unauthenticated `/build/...` redirects to Google like every other path.
- Isolation (controlled preview, not public multi-tenant hardening, which is Sprint 8):
  - own system user `tbi-build`; no home directory is visible; the provisioned toolchain and
    Node are bind-mounted read-only;
  - no network except loopback (`IPAddressDeny=any`), so neither the service nor a compile can
    download anything;
  - it writes only its job directories (`/var/lib/tbi-build/jobs`, one private directory per
    build, removed afterwards and swept at start) and the shared artifact store;
  - `MemoryMax=1536M`, `CPUQuota=80%`, `TasksMax=128`; one compile at a time, 3 queued, a 240 s
    hard timeout, 512 MiB of temporary files per build, 256 KiB of retained compiler output.
- Artifacts: `/var/lib/tbi-lab/artifacts/<sha256>.bin` (+ `.json` manifests), content-addressed
  and write-once, 256 MiB LRU (the R1 reference images are never evicted; an artifact leased for
  a starting session is never evicted). The Session Host reads the same directory
  (`TBI_ARTIFACTS`) and still re-hashes and privately copies every image before QEMU starts.
- The toolchain is verified against the pinned file hashes
  (`runtime/builder/profiles/esp32-arduino-3.3.12.json`) at every start; a mismatch stops the
  service.
- `publish.sh` builds and installs the build service bundle of the same ref and restarts it.

## Sprint 8 layout (identity, ownership, containment, policy)

```
browser --HTTPS--> Caddy :443 --> oauth2-proxy 127.0.0.1:4180 (Google OIDC, allowlist; asserts
  X-Forwarded-User = Google subject) --> Caddy internal origin unix:/run/tbi-gate/internal.sock
  (0770 caddy:tbi-gate) --> /build: unix:/run/tbi-build/api.sock, /runtime: unix:/run/tbi-runtime/api.sock
```

- No backend TCP port is open (7400, 7420 and 8080 are gone). The sockets are group `tbi-gate`.
- Services: `tbi-build` (user `tbi-build`), `tbi-session-host` (user `tbi-runtime`); each build step
  runs as `tbi-build-job@…` (user `tbi-buildjob`), each session's QEMU as `tbi-qemu@…` (user
  `tbi-qemu`). All are system accounts without login or home.
- Keys and policy: `/etc/tbi/{identity,ticket}.key`, `/etc/tbi/policy.json` (root 0400, systemd
  credentials). State: `/var/lib/tbi-build/state` (grants, rate windows),
  `/var/lib/tbi-runtime/{state,sessions}`.
- Deploy: `deploy/dev-lab/publish.sh <ref>` (app and service bundles, `/srv/tbi-lab/services/<sha>`),
  then `TBI_S8_RUNTIME=<runtime prefix> deploy/dev-lab/s8/install.sh dev-lab`, then install
  `Caddyfile` and `oauth2-proxy.cfg` and **restart** (not reload) caddy and oauth2-proxy, which
  picks up the `tbi-gate` group and Caddy's `UMask=0007` drop-in (`s8/caddy-gate.conf`).
- Rollback to Sprint 7: `deploy/dev-lab/s8/rollback-dev-lab.sh /var/backups/tbi-lab/pre-s8-<date>`.
