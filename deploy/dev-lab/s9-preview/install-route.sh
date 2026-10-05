#!/usr/bin/env bash
# Add the Sprint 9 preview route to the dev-lab gate (once): install s9-preview.caddy as
# /etc/caddy/tbi-s9-preview.caddy and import it inside the internal origin of
# /etc/caddy/Caddyfile, right after its `root` line. Additive only: every existing dev-lab route
# stays as it is. The Caddyfile is backed up first; if the result does not validate, the backup
# is restored and Caddy is not reloaded. Reload is graceful (no restart).
#
#   deploy/dev-lab/s9-preview/install-route.sh            install (idempotent)
#   deploy/dev-lab/s9-preview/install-route.sh --remove   remove the route (files are kept)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
caddyfile=/etc/caddy/Caddyfile
snippet=/etc/caddy/tbi-s9-preview.caddy
line="	import $snippet"
anchor='	root \* /srv/tbi-lab/dev-lab/current'

backup="$caddyfile.pre-s9-preview.$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp -a "$caddyfile" "$backup"
echo "backup: $backup"

if [ "${1:-}" = "--remove" ]; then
  sudo sed -i "\\|^$line\$|d" "$caddyfile"
else
  grep -q "^$anchor\$" "$caddyfile" || { echo "anchor not found in $caddyfile" >&2; exit 1; }
  sudo install -m 0644 -o root -g root "$here/s9-preview.caddy" "$snippet"
  grep -qxF "$line" "$caddyfile" || sudo sed -i "\\|^$anchor\$|a\\
\\
	# Sprint 9 preview (deploy/dev-lab/s9-preview): /s9-preview/, same gate, own web root.\\
$line" "$caddyfile"
fi

if ! sudo caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1; then
  sudo cp -a "$backup" "$caddyfile"
  echo "the new Caddyfile does not validate; restored $backup, Caddy not reloaded" >&2
  exit 1
fi
sudo systemctl reload caddy
echo "Caddy reloaded"
