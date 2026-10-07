#!/usr/bin/env bash
# Roll the dev-lab Session Host back to the services release a runtime-only publish replaced
# (publish-runtime.sh MANIFEST.json `replaces`), or to an explicit release directory. Only
# tbi-session-host.service restarts; the frontend and every other service are untouched.
#
#   deploy/dev-lab/rollback-runtime.sh                       # to `replaces` of the current release
#   deploy/dev-lab/rollback-runtime.sh /srv/tbi-lab/services/<sha>
set -euo pipefail
root=/srv/tbi-lab/services
target="${1:-$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).replaces)' "$(readlink -f "$root/current")/MANIFEST.json")}"
sudo test -f "$target/session-host.mjs" && sudo test -f "$target/build-service.mjs"
sudo ln -sfn "$target" "$root/current.tmp"
sudo mv -T "$root/current.tmp" "$root/current"
sudo systemctl restart tbi-session-host.service
for _ in $(seq 1 40); do
  sudo curl -sf --unix-socket /run/tbi-runtime/api.sock http://localhost/health >/dev/null 2>&1 && break
  sleep 0.5
done
echo "health: $(sudo curl -sf --unix-socket /run/tbi-runtime/api.sock http://localhost/health)"
echo "rolled back: $root/current -> $(readlink -f "$root/current")"
