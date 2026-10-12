#!/usr/bin/env bash
# H6 restore rehearsal on STAGING (tbi-s8): back up, damage, restore from the backup, verify.
set -uo pipefail
N=tbi-s8; T=$(date -u +%Y%m%dT%H%M%SZ); B=/var/backups/tbi-lab/h6-rehearsal-$T
units=(tbi-s8-build.service tbi-s8-build-job@.service tbi-s8-session-host.service tbi-s8-qemu@.service)
h() { sudo sha256sum "$@" | awk '{print substr($1,1,16), $2}'; }
health() { sudo curl -s -m 5 --unix-socket /run/$N-runtime/api.sock http://x/health; echo; }
echo "== 1. backup $B"
sudo install -d -m 0700 $B
for u in "${units[@]}"; do sudo cp -p /etc/systemd/system/$u $B/; done
sudo cp -p /etc/polkit-1/rules.d/50-$N.rules $B/
sudo cp -a /etc/$N $B/etc
sudo sh -c "cd $B && find . -type f -exec sha256sum {} +" | awk '{print substr($1,1,16), $2}' | sort -k2 | tee /tmp/h6-before.txt
health
echo "== 2. damage"
sudo rm -f /etc/$N/runtime.json
sudo install -m 0400 /home/ubuntu/projects/tbi-lab-s13/deploy/dev-lab/s8/policy.alpha.json /etc/$N/policy.json
sudo sed -i '/runtime.json/d;/TBI_RUNTIME_JSON/d' /etc/systemd/system/tbi-s8-build.service
sudo systemctl daemon-reload; sudo systemctl restart tbi-s8-build tbi-s8-session-host; sleep 3
echo "build after damage: $(systemctl is-active tbi-s8-build)"; sudo test -f /etc/$N/runtime.json && echo "runtime.json present" || echo "runtime.json MISSING"
sudo cmp -s $B/etc/policy.json /etc/$N/policy.json && echo "policy unchanged" || echo "policy DIFFERS"
sudo cmp -s $B/tbi-s8-build.service /etc/systemd/system/tbi-s8-build.service && echo "unit unchanged" || echo "unit DIFFERS"
echo "== 3. restore from $B"
t0=$(date +%s%N)
for u in "${units[@]}"; do sudo cp -p $B/$u /etc/systemd/system/$u; done
sudo cp -p $B/50-$N.rules /etc/polkit-1/rules.d/
sudo cp -a $B/etc/. /etc/$N/
sudo systemctl daemon-reload; sudo systemctl restart tbi-s8-build tbi-s8-session-host
for _ in $(seq 1 40); do sudo curl -sf --unix-socket /run/$N-runtime/api.sock http://x/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "restored in $(( ($(date +%s%N)-t0)/1000000 )) ms"
echo "== 4. verify"
health; systemctl is-active tbi-s8-build tbi-s8-session-host
for u in "${units[@]}"; do sudo cmp -s $B/$u /etc/systemd/system/$u && echo "ok $u" || echo "DIFF $u"; done
for f in identity.key ticket.key policy.json runtime.json; do sudo cmp -s $B/etc/$f /etc/$N/$f && echo "ok $f" || echo "DIFF $f"; done
sudo cmp -s /home/ubuntu/projects/tbi-lab-s13/deploy/dev-lab/s8/policy.json /etc/$N/policy.json && echo "policy = repository policy.json"
echo "backup: $B"
