#!/usr/bin/env bash
# One-time (idempotent) setup of the Sprint 7 build service on the dev-lab host. Run as a sudoer:
#
#   deploy/dev-lab/setup-build.sh
#
# - system user `tbi-build` (no login, no home) in group `tbi-artifacts`;
# - the Session Host user (`ubuntu`) joins `tbi-artifacts` to read the shared store;
# - /var/lib/tbi-lab/artifacts: the content-addressed store (setgid dir, files 0444), seeded with
#   the R1-provisioned reference images so existing examples and tests keep running;
# - installs tbi-build.service and points the Session Host at the shared store (TBI_ARTIFACTS).
# The bundle itself is installed by publish.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
runtime_home=/home/ubuntu/tbi-r1-clean/rt
store=/var/lib/tbi-lab/artifacts

getent group tbi-artifacts >/dev/null || sudo groupadd --system tbi-artifacts
id tbi-build >/dev/null 2>&1 ||
  sudo useradd --system --gid tbi-artifacts --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin tbi-build
id -nG ubuntu | grep -qw tbi-artifacts || sudo usermod -aG tbi-artifacts ubuntu

sudo install -d -o root -g root -m 0755 /var/lib/tbi-lab
sudo install -d -o tbi-build -g tbi-artifacts -m 2750 "$store"
# Reference images (content-addressed names only; the name links are not copied).
for f in "$runtime_home"/artifacts/*.bin; do
  name="$(basename "$f")"
  [[ "$name" =~ ^[0-9a-f]{64}\.bin$ ]] || continue
  [[ -f "$store/$name" ]] && continue
  sudo install -o tbi-build -g tbi-artifacts -m 0444 "$f" "$store/$name"
done
sudo install -d -m 0755 /srv/tbi-lab/build-service

sudo install -m 0644 "$here/tbi-build.service" /etc/systemd/system/tbi-build.service
sudo install -m 0644 "$here/tbi-session-host.service" /etc/systemd/system/tbi-session-host.service
sudo systemctl daemon-reload
sudo systemctl enable tbi-build.service
echo "setup done; publish.sh installs the bundle and (re)starts the services"
