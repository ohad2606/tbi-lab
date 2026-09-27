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
